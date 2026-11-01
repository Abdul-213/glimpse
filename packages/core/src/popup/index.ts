// Snip popup logic (snip-popup.md §3, §4, §6, §13.3): placement, the view-state reducer
// and what goes on the clipboard. Pure; the app's window controller drives it.

export * from "./clipboard.ts";
// Cloud-in-use pill copy and footer wrap (GLIM-80).
export * from "./egress.ts";
// Live (live-popup.md §5): block diffing (GLIM-58). placeLivePopup, stripLayout, staleLabel and
// announcementText join it with GLIM-79/81.
export * from "./live-diff.ts";
export * from "./placement.ts";
export * from "./snip-state.ts";
