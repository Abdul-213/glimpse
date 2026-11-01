// Inline HTML for the spike window (no view bundle needed). The page sends
// commands with window.__electrobunSendToHost({...}); the main process pushes
// log lines and state back with executeJavascript -> window.__glim(...).
export const WINDOW_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Glimpse capture spike</title>
<style>
  :root { color-scheme: light dark; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
  body { margin: 12px; }
  h1 { font-size: 14px; margin: 0 0 8px; }
  fieldset { border: 1px solid #8884; border-radius: 6px; margin: 0 0 8px; padding: 6px 8px; }
  legend { font-size: 12px; opacity: .8; }
  label { margin-right: 10px; white-space: nowrap; }
  input[type=text] { width: 15em; font: 12px ui-monospace, Menlo, Consolas, monospace; }
  input[type=number] { width: 4.5em; }
  button { margin: 2px 4px 2px 0; }
  pre { font: 11px/1.35 ui-monospace, Menlo, Consolas, monospace; white-space: pre-wrap;
        border: 1px solid #8884; border-radius: 6px; padding: 6px; margin: 6px 0; height: 300px; overflow: auto; }
  #perm { font-weight: 600; }
  .ok { color: #1a7f37; } .bad { color: #cf222e; } .warn { color: #9a6700; }
  small { opacity: .75; }
</style></head>
<body>
  <h1>Glimpse capture spike <small id="where"></small></h1>

  <fieldset id="permbox"><legend>macOS Screen Recording permission</legend>
    <div>State: <span id="perm">?</span> <small id="permdetail"></small></div>
    <button data-cmd="perm">Check (preflight)</button>
    <button data-cmd="perm-probe">Check + probe ScreenCaptureKit</button>
    <button data-cmd="perm-request">Request (CGRequestScreenCaptureAccess)</button>
    <button data-cmd="perm-forget">Forget "asked before" flag</button>
    <button data-cmd="open-settings">Open System Settings pane</button>
    <button data-cmd="relaunch">Quit &amp; reopen</button>
  </fieldset>

  <fieldset><legend>Region capture</legend>
    <div>
      <label>Backend <select id="backend"></select></label>
      <label>Rect x,y,w,h <input id="rect" type="text" value=""></label>
      <small id="units"></small>
    </div>
    <div>
      <button data-preset="small">Preset: small 400x120</button>
      <button data-preset="large">Preset: large 1920x1080</button>
      <button data-preset="largePx">Preset: 1920x1080 output px</button>
      <button data-preset="span">Preset: span two displays</button>
    </div>
    <div>
      <label><input id="cursor" type="checkbox"> include cursor</label>
      <label class="win"><input id="border" type="checkbox" checked> WGC border required</label>
      <label>n <input id="n" type="number" value="50"></label>
      <label>fps <input id="fps" type="number" value="4"></label>
      <label>seconds <input id="seconds" type="number" value="30"></label>
    </div>
    <div>
      <button data-cmd="capture">Capture once (save PNG)</button>
      <button data-cmd="bench">Latency bench (n)</button>
      <button data-cmd="loop">Fixed-rate loop</button>
      <button data-cmd="suite">Run full suite (all backends)</button>
      <button data-cmd="reset">Reset sessions</button>
      <button data-cmd="displays">Displays</button>
      <button class="win" data-cmd="wgc-borderless">Request WGC borderless access</button>
      <button data-cmd="open-out">Open results folder</button>
    </div>
  </fieldset>
  <div><small>Log (also written to <span id="logpath"></span>)</small></div>
  <pre id="log"></pre>
<script>
  const $ = (id) => document.getElementById(id);
  let presets = {};
  const send = (cmd, extra) => {
    const msg = Object.assign({
      cmd, backend: $("backend").value, rect: $("rect").value,
      cursor: $("cursor").checked, border: $("border").checked,
      n: Number($("n").value), fps: Number($("fps").value), seconds: Number($("seconds").value),
    }, extra || {});
    if (window.__electrobunSendToHost) window.__electrobunSendToHost(msg);
    else append("ERROR: __electrobunSendToHost missing (Electrobun preload not injected)");
  };
  document.querySelectorAll("button[data-cmd]").forEach((b) => b.addEventListener("click", () => send(b.dataset.cmd)));
  document.querySelectorAll("button[data-preset]").forEach((b) => b.addEventListener("click", () => {
    const r = presets[b.dataset.preset];
    if (r) $("rect").value = [r.x, r.y, r.width, r.height].join(",");
    else append("preset " + b.dataset.preset + " not available on this setup");
  }));
  function append(line) {
    const el = $("log");
    el.textContent += line + "\\n";
    el.scrollTop = el.scrollHeight;
  }
  window.__glim = (m) => {
    if (m.lines) m.lines.forEach(append);
    if (m.state) {
      const s = m.state;
      $("where").textContent = s.where;
      $("logpath").textContent = s.logPath;
      $("units").textContent = s.units;
      $("permbox").style.display = s.platform === "darwin" ? "" : "none";
      document.querySelectorAll(".win").forEach((e) => e.style.display = s.platform === "win32" ? "" : "none");
      if (s.backends && $("backend").options.length !== s.backends.length) {
        $("backend").innerHTML = s.backends.map((b) => "<option>" + b + "</option>").join("");
      }
      if (s.presets) { presets = s.presets; if (!$("rect").value && presets.small) { const r = presets.small; $("rect").value = [r.x, r.y, r.width, r.height].join(","); } }
      if (s.perm) {
        $("perm").textContent = s.perm.state;
        $("perm").className = s.perm.state === "granted" ? "ok" : (s.perm.state === "not-determined" ? "warn" : "bad");
        $("permdetail").textContent = s.perm.explanation;
      }
    }
  };
  window.addEventListener("load", () => send("hello"));
</script>
</body></html>`;
