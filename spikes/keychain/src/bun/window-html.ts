// Inline HTML for the results window. The main process pushes state with
// executeJavascript; actions live in the tray / menu-bar menu.
export const WINDOW_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Glimpse keychain spike</title>
<style>
  :root { color-scheme: light dark; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
  body { margin: 12px; }
  h1 { font-size: 14px; margin: 0 0 8px; }
  pre { font: 11px/1.35 ui-monospace, Menlo, Consolas, monospace; white-space: pre-wrap;
        border: 1px solid #8884; border-radius: 6px; padding: 6px; margin: 6px 0; }
  .pass { border-color: #1a7f3788; } .fail { border-color: #cf222e; background: #cf222e14; }
  small { opacity: .75; }
</style></head>
<body>
  <h1>Glimpse keychain spike</h1>
  <small>Actions are in the tray / menu-bar menu ("Keychain"). Newest result first.</small>
  <pre id="identity"></pre>
  <div id="history"></div>
<script>
  window.__glim = (s) => {
    document.getElementById("identity").textContent = s.identity;
    const h = document.getElementById("history");
    h.textContent = "";
    for (const block of s.history) {
      const pre = document.createElement("pre");
      pre.textContent = block;
      pre.className = /FAIL|CRASH/.test(block.split("\\n")[0]) ? "fail" : "pass";
      h.appendChild(pre);
    }
  };
</script>
</body></html>`;
