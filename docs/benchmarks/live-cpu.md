# Live mode CPU and battery budget (GLIM-66)

Live runs for as long as a region is pinned, often for a whole game session or film, and often
on battery (PRODUCT.md hard constraint "Local model cost"). This page sets what it may cost,
shows what it does cost, and describes how it backs off when it costs too much.

## The budget

| State | Budget | How it is kept |
|---|---|---|
| **Idle**: region pinned, nothing on it changes | No pixel work at all; 2 grabs per second | GLIM-48 idle back-off: after 2 s without a new frame from the backend the loop drops to 2 fps, and frames the backend reports as unchanged cost no diff |
| **Moving background, text unchanged**: video playing under a subtitle that stays | Under 2 % of one core for a 1280x720 region | Text focus (GLIM-114) plus quiet back-off: after 2 s with nothing to read, capture drops to 2 fps until something changes, so a change is still seen within 0.5 s |
| **Active**: text changes and is read | **35 % of one core, averaged over 30 s** | `LiveBudget` (`packages/core/src/pipeline/live-budget.ts`) measures process CPU, which includes the OCR and translation Workers, and steps the back-off levels below |

Back-off levels. The runner moves up one level when the 30 s average is over budget. It moves
down one level after 60 s under half the budget.

| Level | Frame rate | Minimum gap between OCR runs | Effect |
|---|---|---|---|
| 0 | the user's (2–4 fps) | none | every settled change is read at once |
| 1 | at most 3 fps | 1 s | content that changes faster than once a second is read at most once a second |
| 2 | 2 fps | 2 s | |
| 3 | 2 fps | 3 s | a line that stays up for 3 s is still read |

A held-back change is never dropped: it is compared again when the gap ends, and the latest
frame wins. The level changes are logged (`live: cpu budget`), and so is the level when the
session ends (`budgetLevel`).

**Why 35 % of one core.** OCR dominates: on the dev VM one PaddleOCR run on a subtitle strip
costs about 1 s of CPU, because 4 ORT threads spin. A new subtitle every 3 s, the busiest
normal case, therefore uses about 33 % of one core. Dialogue boxes and chat panes that change
every 5–10 s use 10–20 %. The budget is set so that these cases are read in full. It trips
for content that changes every second or two (a fast chat, rapid captions, a ticker), and
there it trades freshness for CPU. On an 8-core laptop, 35 % of one core is about 4 % of the
machine. The cost per OCR run is the lever that would let the budget go lower (GLIM-134). With
2 ORT threads, or with spinning off, the CPU per run halves at similar latency.

## Measurements

`bun app/scripts/live-cpu.ts [--paddle]` produced the tables below on the dev VM (8-vCPU
AMD EPYC, shared with other jobs, so treat the numbers as ±30 %). "CPU per minute" is process
CPU (all threads) minus the file backend's PNG decoding, which real capture doesn't do. The
real-OCR rows run in real time for 12 s, which is shorter than the 30 s budget window, so the
budget never acts in them.

### Change detection per grab (main-process CPU)

| Region (device px) | Unchanged frame | Changed (whole region) | Text focus | Focus at 4 fps |
|---|---|---|---|---|
| 400x100 (a dialogue line) | 0.01 ms | 1.35 ms | 0.37 ms | 0.1 % of a core |
| 800x240 (a subtitle strip) | 0.00 ms | 2.12 ms | 1.87 ms | 0.7 % of a core |
| 1280x720 (a video at 1x) | 0.00 ms | 8.08 ms | 8.64 ms | 3.5 % of a core |
| 2560x1440 (the same at 2x, sampled per logical px) | 0.00 ms | 9.14 ms | 8.62 ms | 3.4 % of a core |
| 1920x1080 (a whole 1x screen) | 0.00 ms | 16.63 ms | 18.34 ms | 7.3 % of a core |

### Harness scenarios (800x90 subtitle strip, 4 fps)

| Scenario | Length | Grabs | OCR runs | Change detection per grab | Capture (file backend) per grab | CPU per minute of Live | Share of a core | Budget |
|---|---|---|---|---|---|---|---|---|
| GLIM-58 static scene, scripted OCR (virtual time) | 12 s | 46 | 3 | 0.93 ms | 1.96 ms | 1.2 s | 2.0 % | level 0 |
| GLIM-114 subtitles over moving video, scripted OCR (virtual time) | 12 s | 53 | 4 | 1.02 ms | 1.51 ms | 1.1 s | 1.9 % | level 0 |
| GLIM-58 static scene, PaddleOCR (real time) | 12 s | 46 | 3 | 0.73 ms | 2.56 ms | 11.6 s | 19.4 % | level 0 |
| GLIM-114 subtitles over moving video, PaddleOCR (real time) | 12 s | 52 | 4 | 1.20 ms | 1.98 ms | 27.6 s | 46.0 % | level 0 |


What the numbers say:

- **Change detection** costs nothing on unchanged frames, about 2 ms per grab on a subtitle
  strip and 8–9 ms on a 1280x720 region (also at 2x, because sampling is per logical pixel).
  Text focus costs the same as a whole-region diff. A whole 1080p screen at 4 fps is about 7 %
  of a core while it moves. Quiet back-off halves that once the text holds still.
- **OCR** is the cost. Without it (scripted OCR), Live over the scenarios uses about 2 % of a
  core. With real PaddleOCR the same 12 s use 20–46 % of a core, depending on how many lines
  appear: 3 reads in the static scene, 4 in the subtitle video.
- The unit tests drive a runner with OCR that costs 600 ms per run on content that changes
  every second (60 % of a core). It steps up to level 2 and reads every 2 s instead of every
  1 s. Content that changes every 5 s stays at level 0 and every change is read
  (`packages/core/test/live-budget.test.ts`).

## Not measured here (GLIM-87, real hardware)

- Native capture cost per grab: DXGI duplication on Windows, ScreenCaptureKit on macOS,
  including the GPU-to-CPU copy. The file backend's numbers say nothing about it.
- Idle and active CPU on a real Windows PC and a real Mac, in Task Manager / Activity Monitor
  (Glimpse process plus its helpers). Run for 5 minutes each:
  1. A pinned static region (idle).
  2. A playing video under a static subtitle.
  3. A YouTube video with burned-in subtitles.
  4. A chat pane that updates every second.

  Record the `live: cpu budget` and `live: stopped` log lines too.
- Battery drain per hour on a laptop (Windows battery report, macOS `pmset -g log` or Energy
  Impact) for the subtitle video case, with Live on and off.
- Apple Silicon and laptop-class x86 OCR CPU per run, which decides whether 35 % is roomy or
  tight. If OCR is much cheaper there, the budget can come down.
