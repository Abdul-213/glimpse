// Inline HTML for the two windows (no views bundle needed).
//   CONTROL_HTML: a normal, NOT excluded Glimpse window. Its big green panel is
//                 the "control" marker: it must appear in Glimpse's captures,
//                 which proves the capture saw our windows at all.
//   POPUP_HTML:   the always-on-top popup that must be excluded. Solid magenta
//                 so the app can count it in captured pixels.
// Buttons talk to Bun with window.__electrobunSendToHost (Electrobun preload);
// Bun pushes state back with executeJavascript.
import { CONTROL_RGB, POPUP_RGB } from "../shared/analysis";

const rgb = (c: readonly number[]) => `rgb(${c.join(",")})`;

export const POPUP_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Glimpse popup (should be excluded)</title>
<style>
  html, body { margin: 0; height: 100%; }
  body { background: ${rgb(POPUP_RGB)}; color: #000; font: 600 15px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
         display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center;
         -webkit-user-select: none; user-select: none; cursor: default; }
  small { font-weight: 400; font-size: 12px; }
</style></head>
<body>
  <div>GLIMPSE POPUP</div>
  <div>must NOT appear in Glimpse's captures</div>
  <small id="state">exclusion: (starting)</small>
<script>
  window.__glimPopup = (s) => { document.getElementById("state").textContent = s; };
</script>
</body></html>`;

export const CONTROL_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Glimpse capture-exclusion spike</title>
<style>
  :root { color-scheme: light dark; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
  body { margin: 0; }
  #control { background: ${rgb(CONTROL_RGB)}; color: #000; height: 250px; display: flex; align-items: flex-end;
             justify-content: center; padding-bottom: 6px; box-sizing: border-box; font-weight: 600; }
  main { padding: 10px 12px; }
  .row { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0; }
  button { font: inherit; padding: 4px 10px; }
  pre { font: 11px/1.35 ui-monospace, Menlo, Consolas, monospace; white-space: pre-wrap; border: 1px solid #8884;
        border-radius: 6px; padding: 6px; margin: 6px 0; max-height: 16em; overflow: auto; }
  .PASS { color: #1a7f37; } .FAIL { color: #cf222e; } .INCONCLUSIVE, .OBSERVED { color: #9a6700; }
  small { opacity: .75; }
</style></head>
<body>
  <div id="control">CONTROL PANEL (green, not excluded): must appear in captures. The magenta popup sits over it.</div>
  <main>
    <div><b>State:</b> <span id="state">(starting)</span></div>
    <div class="row" id="toggles"></div>
    <div class="row" id="captures"></div>
    <div class="row">
      <button data-a="capture-all">Run all captures</button>
      <button data-a="capture-all-delay">Run all in 5 s</button>
      <button data-a="popup-move">Move popup to next display</button>
      <button data-a="popup-reset">Popup back over green panel</button>
      <button data-a="open-folder">Open captures folder</button>
    </div>
    <div><small>Results (newest first). PNGs are saved to <span id="dir"></span></small></div>
    <pre id="results">(no captures yet)</pre>
    <div><small>Diagnostics</small></div>
    <pre id="diag"></pre>
  </main>
<script>
  const send = (action, arg) => window.__electrobunSendToHost && window.__electrobunSendToHost({ action, arg });
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-a]");
    if (b) send(b.dataset.a, b.dataset.arg);
  });
  const btn = (a, label, arg) => '<button data-a="' + a + '"' + (arg !== undefined ? ' data-arg="' + arg + '"' : "") + ">" + label + "</button>";
  window.__glim = (s) => {
    document.getElementById("state").textContent = s.state;
    document.getElementById("dir").textContent = s.dir;
    document.getElementById("toggles").innerHTML = s.toggles.map((t) => btn(t.action, t.label, t.arg)).join("");
    document.getElementById("captures").innerHTML = s.methods.map((m) => btn("capture", "Capture: " + m.label, m.id)).join("");
    document.getElementById("results").innerHTML = s.results.length
      ? s.results.map((r) => '<span class="' + r.result + '">' + r.result + "</span> " + r.text.replace(/&/g, "&amp;").replace(/</g, "&lt;")).join("\\n")
      : "(no captures yet)";
    document.getElementById("diag").textContent = s.diag.join("\\n");
  };
  send("ready");
</script>
</body></html>`;
