// Popup webview: paints the veil and mock content, and reports the first frame
// after each show so Bun can time show -> visible.

import { Electroview } from "electrobun/view";
import type { PopupLook, PopupRPC } from "../shared/rpc";

const root = document.documentElement;
const caption = document.getElementById("caption")!;
const copy = document.getElementById("copy")!;

const CONTENT = [
	[
		["Save your progress before closing the game.", "ゲームを閉じる前に進行状況を保存してください。"],
		["Continue · Load · Settings", "つづきから · ロード · 設定"],
	],
	[
		["The shop is closed today. Please come back tomorrow.", "本日は閉店しました。また明日お越しください。"],
		["Received 300 gold.", "300ゴールドを手に入れた。"],
	],
];

const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const rtQuery = matchMedia("(prefers-reduced-transparency: reduce)");
// `prefers-reduced-transparency` is unknown to engines that don't support it:
// matchMedia then reports media "not all".
const rtSupported = rtQuery.media !== "not all";

function media() {
	return { prefersDark: darkQuery.matches, prefersReducedTransparency: rtSupported ? rtQuery.matches : null };
}

function applyLook(l: PopupLook): void {
	root.dataset.os = l.os;
	root.dataset.theme = l.dark ? "dark" : "light";
	root.dataset.veil = l.veil;
	root.style.setProperty("--radius-popup", `${l.radius}px`);
	root.style.setProperty("--veil-alpha", String(l.veilAlpha));
	const set = CONTENT[l.contentSeq % CONTENT.length]!;
	set.forEach(([t, s], i) => {
		document.getElementById(`t${i + 1}`)!.textContent = t!;
		document.getElementById(`s${i + 1}`)!.textContent = s!;
	});
	caption.textContent = `Japanese → English · ${l.caption}`;
}

const rpc = Electroview.defineRPC<PopupRPC>({
	maxRequestTime: 10_000,
	handlers: {
		requests: {},
		messages: {
			look: (l) => applyLook(l),
			shown: ({ seq }) => {
				// Two rAFs: the first runs before the next paint, the second after it.
				requestAnimationFrame(() =>
					requestAnimationFrame(() => rpc.send.frame({ seq, visibility: document.visibilityState })),
				);
			},
		},
	},
});
new Electroview({ rpc });

const send = () => rpc.send.media(media());
darkQuery.addEventListener("change", send);
if (rtSupported) rtQuery.addEventListener("change", send);

copy.addEventListener("click", () => {
	rpc.send.clicked({ what: "copy" });
	copy.textContent = "Copied";
	setTimeout(() => (copy.textContent = "Copy"), 1200);
});

void (async () => {
	const l = await rpc.request.hello({ dpr: devicePixelRatio, ...media() });
	applyLook(l);
})();
