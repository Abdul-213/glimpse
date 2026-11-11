// Inline HTML for the small counter window. Kept as a string so the spike needs
// no view bundle; the main process pushes state with executeJavascript.
export const WINDOW_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Glimpse hotkey spike</title>
<style>
  :root { color-scheme: light dark; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
  body { margin: 12px; }
  h1 { font-size: 14px; margin: 0 0 8px; }
  .counts { display: flex; gap: 12px; margin-bottom: 8px; }
  .count { flex: 1; border: 1px solid #8884; border-radius: 6px; padding: 8px; }
  .count b { font-size: 28px; display: block; font-variant-numeric: tabular-nums; }
  .ok { color: #1a7f37; } .bad { color: #cf222e; }
  pre { font: 11px/1.35 ui-monospace, Menlo, Consolas, monospace; white-space: pre-wrap;
        border: 1px solid #8884; border-radius: 6px; padding: 6px; margin: 6px 0; max-height: 9em; overflow: auto; }
  small { opacity: .75; }
</style></head>
<body>
  <h1>Glimpse hotkey spike <small id="backend"></small></h1>
  <div class="counts">
    <div class="count"><span id="snipLabel">Snip</span><b id="snip">0</b><small id="snipStatus"></small></div>
    <div class="count"><span id="liveLabel">Live toggle</span><b id="live">0</b><small id="liveStatus"></small></div>
  </div>
  <div><small>Live state (toggle): <span id="pinned">unpinned</span></small></div>
  <div><small>Hotkey log (newest first)</small></div>
  <pre id="log">(no presses yet)</pre>
  <div><small>Key events this window received while focused (if a hotkey press shows here, the keystroke was NOT consumed)</small></div>
  <pre id="keys">(focus this window and press keys)</pre>
  <div><small>Diagnostics</small></div>
  <pre id="diag"></pre>
<script>
  const keys = [];
  function fmtKey(e) {
    const m = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta"].filter(Boolean);
    return new Date().toISOString().slice(11, 23) + " " + e.type + " " + [...m, e.code].join("+") + " key=" + JSON.stringify(e.key);
  }
  for (const t of ["keydown", "keyup"]) {
    window.addEventListener(t, (e) => {
      keys.unshift(fmtKey(e));
      keys.length = Math.min(keys.length, 40);
      document.getElementById("keys").textContent = keys.join("\\n");
    });
  }
  window.__glim = (s) => {
    document.getElementById("backend").textContent = "backend: " + s.backend;
    for (const a of ["snip", "live"]) {
      document.getElementById(a).textContent = s.counts[a];
      document.getElementById(a + "Label").textContent = s.labels[a];
      const st = document.getElementById(a + "Status");
      st.textContent = s.status[a].ok ? "registered" : "NOT registered";
      st.className = s.status[a].ok ? "ok" : "bad";
      st.title = s.status[a].detail;
    }
    document.getElementById("pinned").textContent = s.livePinned ? "PINNED" : "unpinned";
    document.getElementById("log").textContent = s.log.length ? s.log.join("\\n") : "(no presses yet)";
    document.getElementById("diag").textContent = s.diag.join("\\n");
  };
</script>
</body></html>`;
