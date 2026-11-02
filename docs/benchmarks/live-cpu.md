# Live mode CPU and battery budget (GLIM-66)

Live runs for as long as a region is pinned, often for a whole game session or film, and often
on battery (PRODUCT.md hard constraint "Local model cost"). This page sets what it may cost,
shows what it does cost, and describes how it backs off when it costs too much.

## The budget

| State | Budget | How it is kept |
|---|---|---|
| **Idle**: region pinned, nothing on it changes | No pixel work at all; 2 grabs per second | GLIM-48 idle back-off: after 2 s without a new frame from the backend the loop drops to 2 fps, and frames the backend reports as unchanged cost no diff |
| **Moving background, text unchanged**: video playing under a subtitle that stays | Under 2 % of one core for a 1280x720 region | Text focus (GLIM-114) plus quiet back-off: after 2 s with nothing to read, capture drops to 2 fps until something changes, so a change is still seen within 0.5 s |
| **Active**: text changes and is read | **25 % of one core, averaged over 30 s** (35 % before GLIM-134) | `LiveBudget` (`packages/core/src/pipeline/live-budget.ts`) measures process CPU, which includes the OCR and translation Workers, and steps the back-off levels below |

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

**Why 25 % of one core.** OCR dominates. Live reads run on their own ORT sessions with 2
intra-op threads and spinning off (GLIM-134, below), which costs about 0.45 s of CPU per read
on a subtitle strip on the dev VM. A new subtitle every 3 s, the busiest normal case, therefore
uses about 15 % of one core. Dialogue boxes and chat panes that change every 5–10 s use 5–10 %.
The budget is set so that these cases are read in full with ~1.6x headroom. It trips for
content that changes every second or two (a fast chat, rapid captions, a ticker), and there it
trades freshness for CPU. On an 8-core laptop, 25 % of one core is about 3 % of the machine.
Before GLIM-134 Live read with Snip's settings (up to 4 spinning threads, ~1 s of CPU per
read), and the budget was 35 %.

## OCR thread settings (GLIM-134)

ORT fixes the intra-op thread pool per session, so PaddleOCR keeps two sets of sessions in its
Worker: Snip's (made at init) and Live's (made on the first Live read, ~0.1–0.3 s once). The
pipeline tells the provider which one a read is for (`OcrOptions.purpose`).

| Profile | ORT threads | Spinning | Why |
|---|---|---|---|
| Snip (`threads`, `spinning`) | min(4, half the cores) | on | someone is waiting: lowest latency |
| Live (`liveThreads`, `liveSpinning`) | min(2, Snip's) | off | repeats for hours: about half the CPU per read |

`bun packages/providers/bench/ocr/cpu.ts` runs the GLIM-64 corpus (22 cases, rec cache off) in
each configuration, interleaved. Dev VM (8-vCPU AMD EPYC, shared and loaded, ±30 %):

| ORT threads | Spinning | CPU per run (mean) | Wall per run p50 | Wall per run mean |
|---|---|---|---|---|
| 1 | on | 999 ms | 718 ms | 919 ms |
| 1 | off | 989 ms | 746 ms | 924 ms |
| 2 | on | 1376 ms | 483 ms | 627 ms |
| **2** | **off (Live)** | **1200 ms** | **603 ms** | **694 ms** |
| **4** | **on (Snip)** | **2265 ms** | **381 ms** | **485 ms** |
| 4 | off | 1570 ms | 545 ms | 669 ms |

Spinning off saves a third of the CPU at 4 threads, but on this loaded VM it costs ~40 % of
wall time (sleeping threads wake late when other jobs hold the cores), so Snip keeps spinning
and its latency is unchanged. Live takes 2 threads without spinning: 47 % less CPU per read
than Snip's settings for ~0.2 s more per read, which Live hides (it reads a region that has
already been still for 300 ms). 1 thread would save a little more CPU but costs another 0.1 s.
The OCR accuracy is the same for every setting (`bun run bench:ocr`; same model, same graph).

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
| GLIM-58 static scene, PaddleOCR, Live profile (real time) | 12 s | 45 | 3 | 0.97 ms | 3.43 ms | 8.0 s | 13.3 % | level 0 |
| GLIM-114 subtitles over moving video, PaddleOCR, Live profile (real time) | 12 s | 52 | 4 | 3.76 ms | 10.12 ms | 9.2 s | 15.4 % | level 0 |
| GLIM-58 static scene, PaddleOCR, Snip profile (real time) | 12 s | 45 | 3 | 0.62 ms | 3.36 ms | 21.9 s | 36.5 % | level 0 |
| GLIM-114 subtitles over moving video, PaddleOCR, Snip profile (real time) | 12 s | 51 | 4 | 6.44 ms | 3.45 ms | 23.1 s | 38.5 % | level 0 |


What the numbers say:

- **Change detection** costs nothing on unchanged frames, about 2 ms per grab on a subtitle
  strip and 8–9 ms on a 1280x720 region (also at 2x, because sampling is per logical pixel).
  Text focus costs the same as a whole-region diff. A whole 1080p screen at 4 fps is about 7 %
  of a core while it moves. Quiet back-off halves that once the text holds still.
- **OCR** is the cost. Without it (scripted OCR), Live over the scenarios uses about 2 % of a
  core. With real PaddleOCR on the Live profile the same 12 s use 13–15 % of a core (3 reads in
  the static scene, 4 in the subtitle video); with Snip's settings, which Live used before
  GLIM-134, 37–39 % (the GLIM-66 run of the same rows measured 19–46 %). The Live-profile rows
  include making its sessions on the first read.
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
- Apple Silicon and laptop-class x86 OCR CPU per run, which decides whether 25 % is roomy or
  tight. If OCR is much cheaper there, the budget can come down. Run
  `bun packages/providers/bench/ocr/cpu.ts` (thread/spinning table) and
  `bun app/scripts/live-cpu.ts --paddle` (both profiles) on the laptop; if spinning off costs
  little wall time there, Snip could drop spinning too (GLIM-134).
