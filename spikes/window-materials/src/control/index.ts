// Control window: toggles for the popup and a live readout of timings and state.

import { Electroview } from "electrobun/view";
import type { ControlRPC, ControlStatus } from "../shared/rpc";

const $ = (id: string) => document.getElementById(id)!;

function fill(select: HTMLSelectElement, values: string[]): void {
	if (select.options.length === values.length && [...select.options].every((o, i) => o.value === values[i])) return;
	select.replaceChildren(...values.map((v) => new Option(v, v)));
}

function fmt(v: unknown): string {
	return v === null || v === undefined ? "–" : JSON.stringify(v);
}

function render(s: ControlStatus): void {
	$("osDetail").textContent = s.osDetail;
	const sel = (k: string) => document.querySelector<HTMLSelectElement>(`select[data-setting="${k}"]`)!;
	fill(sel("material"), s.materials);
	fill(sel("showMode"), s.showModes);
	fill(sel("corner"), s.cornerOptions);
	for (const [k, v] of Object.entries(s.settings)) {
		const el = document.querySelector<HTMLSelectElement>(`select[data-setting="${k}"]`);
		if (el && el.value !== v) el.value = v;
	}
	for (const el of document.querySelectorAll<HTMLElement>(".win-only")) el.hidden = s.os !== "windows";
	$("lastShow").textContent = fmt(s.lastShow);
	$("latency").textContent = fmt(s.latency);
	const focus = $("focus");
	focus.textContent = fmt(s.focus);
	const verdict = String((s.focus as { verdict?: string } | null)?.verdict ?? "");
	focus.className = verdict.startsWith("PASS") ? "pass" : verdict.startsWith("FAIL") ? "fail" : "";
	$("surface").textContent = `${s.surface.nativeMaterial ? "native material" : "no material"} · veil ${s.surface.veil} · ${s.surface.reason} · popup ${s.popupVisible ? "visible" : "hidden"}`;
	$("osState").textContent = `reduce transparency ${s.osReduceTransparency ? "ON" : "off"} · system ${s.systemDark ? "dark" : "light"}`;
	$("logPath").textContent = s.logPath;
	$("log").textContent = s.log.join("\n");
}

const rpc = Electroview.defineRPC<ControlRPC>({
	maxRequestTime: 120_000,
	handlers: { requests: {}, messages: { status: (s) => render(s) } },
});
new Electroview({ rpc });

async function act(name: string, value?: string): Promise<void> {
	try {
		render(await rpc.request.action({ name, value }));
	} catch (err) {
		$("log").textContent = `action ${name} failed: ${String(err)}\n${$("log").textContent}`;
	}
}

for (const b of document.querySelectorAll<HTMLButtonElement>("button[data-action]")) {
	b.addEventListener("click", () => void act(b.dataset.action!, b.dataset.value));
}
for (const s of document.querySelectorAll<HTMLSelectElement>("select[data-setting]")) {
	s.addEventListener("change", () => void act(s.dataset.setting!, s.value));
}

void act("status");
