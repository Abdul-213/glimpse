// Snip popup logic (snip-popup.md §3, §4, §6, §13.3): placement, the view-state reducer
// and what goes on the clipboard. Pure; the app's window controller drives it.

export * from "./clipboard.ts";
// Cloud-in-use pill copy and footer wrap (GLIM-80).
export * from "./egress.ts";
// Numbered markers and the overlay's text fitting (GLIM-152).
export * from "./fit-text.ts";
// Live (live-popup.md): block diffing (GLIM-58), docking and strip rules, and the popup
// state reducer (GLIM-79).
export * from "./live-announcer.ts";
export * from "./live-diff.ts";
export * from "./live-layout.ts";
// Moving, docking and the remembered offset (GLIM-151).
export * from "./live-move.ts";
export * from "./live-state.ts";
export * from "./markers.ts";
export * from "./placement.ts";
// Detection boxes on screen under the Snip popup (GLIM-115).
export * from "./results-layer.ts";
export * from "./snip-state.ts";
