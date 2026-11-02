import "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { createSignal, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { BlockList } from "../src/components/BlockList.tsx";
import { HotkeyRecorder } from "../src/components/HotkeyRecorder.tsx";
import { IconButton } from "../src/components/IconButton.tsx";
import { LanguageMultiSelect } from "../src/components/LanguageMultiSelect.tsx";
import { type PackRowItem, PackRows } from "../src/components/PackRow.tsx";
import { PopupShell } from "../src/components/PopupShell.tsx";
import { ProgressBar } from "../src/components/ProgressBar.tsx";
import { SkippedLine } from "../src/components/SkippedLine.tsx";
import { Switch } from "../src/components/Switch.tsx";
import { TextBlock } from "../src/components/TextBlock.tsx";
import { Toolbar } from "../src/components/Toolbar.tsx";
import type { Hotkey } from "../src/hotkey.ts";

let dispose: (() => void) | undefined;
afterEach(() => {
	dispose?.();
	dispose = undefined;
	document.body.innerHTML = "";
});

function mount(ui: () => JSX.Element): HTMLElement {
	const root = document.createElement("div");
	document.body.append(root);
	dispose = render(ui, root);
	return root;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const keydown = (el: Element, init: KeyboardEventInit) =>
	el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));

describe("TextBlock", () => {
	test("skeleton → pending → done keeps lang and dir on every text node", () => {
		const [state, setState] = createSignal<"skeleton" | "pending" | "done">("skeleton");
		const root = mount(() => (
			<TextBlock
				state={state()}
				source="保存に失敗しました"
				sourceLang="ja"
				translation="Save failed"
				targetLang="en"
				skeletonWidth={45}
			/>
		));
		const block = root.querySelector("[data-block]");
		expect(block?.getAttribute("aria-busy")).toBe("true");
		const bar = root.querySelector(".glim-skeleton");
		expect(bar?.getAttribute("aria-hidden")).toBe("true");
		expect((bar as HTMLElement).style.width).toBe("45%");

		setState("pending");
		const pending = root.querySelector(".glim-source");
		expect(pending?.textContent).toBe("保存に失敗しました");
		expect(pending?.getAttribute("lang")).toBe("ja");
		expect(pending?.getAttribute("dir")).toBe("auto");

		setState("done");
		const tr = root.querySelector(".glim-translation");
		expect(tr?.textContent).toBe("Save failed");
		expect(tr?.getAttribute("lang")).toBe("en");
		expect(tr?.classList.contains("glim-fade-in")).toBe(true);
		expect(block?.getAttribute("aria-busy")).toBeNull();
	});

	test("a cache hit (done on first render) doesn't fade", () => {
		const root = mount(() => <TextBlock state="done" translation="Hello" targetLang="en" />);
		expect(root.querySelector(".glim-translation")?.classList.contains("glim-fade-in")).toBe(false);
	});

	test("language tag is an isolated span; original view shows OCR text as content", () => {
		const [view, setView] = createSignal<"translation" | "original">("translation");
		const root = mount(() => (
			<TextBlock
				state="done"
				view={view()}
				source="مرحبا بالعالم"
				sourceLang="ar"
				translation="Hello world"
				targetLang="en"
				tag="Arabic"
				tagLang="en"
				showSource
			/>
		));
		const tag = root.querySelector(".glim-tag");
		expect(tag?.textContent).toBe("Arabic");
		expect(tag?.getAttribute("dir")).toBe("auto");
		expect(root.querySelectorAll(".glim-source")).toHaveLength(1);

		setView("original");
		const content = root.querySelector(".glim-translation");
		expect(content?.textContent).toBe("مرحبا بالعالم");
		expect(content?.getAttribute("lang")).toBe("ar");
		expect(root.querySelector(".glim-tag")).toBeNull();
	});

	test("Live change: a new change id remounts the tint (restarting the settle) and sets the description", () => {
		const [change, setChange] = createSignal<number | null>(null);
		const root = mount(() => (
			<TextBlock state="done" variant="live" translation="Bring the lantern." targetLang="en" changeId={change()} />
		));
		const block = root.querySelector("[data-block]");
		expect(block?.getAttribute("data-variant")).toBe("live");
		expect(root.querySelector(".glim-change-tint")).toBeNull();

		setChange(1);
		const first = root.querySelector(".glim-change-tint");
		expect(first).not.toBeNull();
		expect(root.querySelector(".glim-change-mark")).not.toBeNull();
		expect(block?.getAttribute("aria-description")).toBe("Changed");

		setChange(2);
		const second = root.querySelector(".glim-change-tint");
		expect(second).not.toBeNull();
		expect(second).not.toBe(first);

		setChange(null);
		expect(root.querySelector(".glim-change-mark")).toBeNull();
		expect(block?.getAttribute("aria-description")).toBeNull();
	});

	test("failed block keeps its source and offers Retry", () => {
		let retried = 0;
		const root = mount(() => <TextBlock state="failed" source="Guardar" sourceLang="es" onRetry={() => retried++} />);
		expect(root.querySelector(".glim-source")?.textContent).toBe("Guardar");
		expect(root.textContent).toContain("Not translated");
		(root.querySelector(".glim-text-btn") as HTMLButtonElement).click();
		expect(retried).toBe(1);
	});
});

describe("BlockList and SkippedLine", () => {
	test("one Tab stop; arrows move through blocks and the skipped line without wrapping", async () => {
		const root = mount(() => (
			<BlockList aria-label="Translated text">
				<TextBlock state="done" translation="One" targetLang="en" />
				<TextBlock state="done" translation="Two" targetLang="en" />
				<SkippedLine count={2} languages={["Korean"]} />
			</BlockList>
		));
		await tick();
		const items = [...root.querySelectorAll<HTMLElement>("[data-block], [data-roving]")];
		expect(items.map((el) => el.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);

		const list = root.querySelector("ul") as HTMLElement;
		list.focus();
		keydown(list, { key: "ArrowDown" });
		expect(document.activeElement).toBe(items[0] ?? null);
		keydown(items[0] as HTMLElement, { key: "ArrowDown" });
		keydown(items[1] as HTMLElement, { key: "ArrowDown" });
		expect(document.activeElement).toBe(items[2] ?? null);
		keydown(items[2] as HTMLElement, { key: "ArrowDown" });
		expect(document.activeElement).toBe(items[2] ?? null);
		expect(items.map((el) => el.getAttribute("tabindex"))).toEqual(["-1", "-1", "0"]);
		keydown(items[2] as HTMLElement, { key: "Home" });
		expect(document.activeElement).toBe(items[0] ?? null);
	});

	test("skipped line expands its blocks and reports the change", () => {
		const changes: boolean[] = [];
		const root = mount(() => (
			<SkippedLine count={3} languages={["Japanese", "Korean"]} onExpandedChange={(v) => changes.push(v)}>
				<TextBlock state="done" kind="neutral" source="안녕" sourceLang="ko" />
			</SkippedLine>
		));
		const button = root.querySelector("button") as HTMLButtonElement;
		expect(button.textContent).toBe("3 blocks skipped · Japanese, Korean");
		expect(button.getAttribute("aria-expanded")).toBe("false");
		expect(root.textContent).not.toContain("안녕");
		button.click();
		expect(button.getAttribute("aria-expanded")).toBe("true");
		expect(button.getAttribute("aria-controls")).toBe(root.querySelector("ul")?.id ?? "missing");
		expect(root.textContent).toContain("안녕");
		expect(changes).toEqual([true]);
	});
});

describe("Toolbar", () => {
	test("arrows rove between icon buttons and wrap", async () => {
		const root = mount(() => (
			<Toolbar label="Live controls">
				<IconButton icon="pause" label="Pause" shortcut="Ctrl+Shift+P" />
				<IconButton icon="select-area" label="Pick a new area" />
				<IconButton icon="stop" label="Stop Live" pressed={false} />
			</Toolbar>
		));
		await tick();
		const buttons = [...root.querySelectorAll("button")];
		expect(buttons.map((b) => b.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
		expect(buttons[0]?.getAttribute("aria-label")).toBe("Pause");
		expect(buttons[0]?.getAttribute("aria-keyshortcuts")).toBe("Ctrl+Shift+P");
		expect(buttons[2]?.getAttribute("aria-pressed")).toBe("false");
		(buttons[0] as HTMLButtonElement).focus();
		keydown(buttons[0] as HTMLButtonElement, { key: "ArrowLeft" });
		expect(document.activeElement).toBe(buttons[2] ?? null);
		keydown(buttons[2] as HTMLButtonElement, { key: "ArrowRight" });
		expect(document.activeElement).toBe(buttons[0] ?? null);
	});
});

describe("HotkeyRecorder", () => {
	test("records a combo, blocks bare keys, Esc cancels, Backspace clears", () => {
		const [value, setValue] = createSignal<Hotkey | null>({
			ctrl: false,
			alt: true,
			shift: true,
			meta: false,
			key: "S",
		});
		const root = mount(() => <HotkeyRecorder label="Snip" platform="windows" value={value()} onChange={setValue} />);
		const field = root.querySelector("button") as HTMLButtonElement;
		expect(field.getAttribute("aria-label")).toBe("Snip: Alt Shift S");
		expect([...root.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["Alt", "Shift", "S"]);

		field.click();
		expect(field.hasAttribute("data-recording")).toBe(true);
		expect(field.textContent).toBe("Type a shortcut");

		keydown(field, { code: "ControlLeft", ctrlKey: true });
		expect([...root.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["Ctrl"]);

		keydown(field, { code: "KeyK" });
		expect(root.querySelector(".glim-inline-message")?.getAttribute("data-tone")).toBe("danger");
		expect(field.hasAttribute("data-recording")).toBe(true);

		keydown(field, { code: "KeyY", altKey: true, shiftKey: true });
		expect(value()).toEqual({ ctrl: false, alt: true, shift: true, meta: false, key: "Y" });
		expect(field.hasAttribute("data-recording")).toBe(false);
		expect(root.querySelector(".glim-inline-message")).toBeNull();

		field.click();
		keydown(field, { code: "Escape" });
		expect(value()?.key).toBe("Y");
		expect(field.hasAttribute("data-recording")).toBe(false);

		field.click();
		keydown(field, { code: "Backspace" });
		expect(value()).toBeNull();
		expect(field.textContent).toBe("Not set");
	});

	test("a warned combo is kept with its warning; an app-reported conflict shows as danger", () => {
		const [value, setValue] = createSignal<Hotkey | null>(null);
		const [error, setError] = createSignal<string | undefined>();
		const root = mount(() => (
			<HotkeyRecorder label="Live" platform="windows" value={value()} onChange={setValue} error={error()} />
		));
		const field = root.querySelector("button") as HTMLButtonElement;
		field.click();
		keydown(field, { code: "KeyW", altKey: true, shiftKey: true });
		expect(value()?.key).toBe("W");
		expect(root.querySelector(".glim-inline-message")?.getAttribute("data-tone")).toBe("warning");
		setError("Another app already uses this shortcut.");
		const msg = root.querySelector(".glim-inline-message");
		expect(msg?.getAttribute("data-tone")).toBe("danger");
		expect(field.getAttribute("aria-describedby")).toBe(msg?.id ?? "missing");
	});
});

describe("PopupShell", () => {
	test("keeps caller styles alongside its transform-origin; Snip is a modal dialog", () => {
		const root = mount(() => (
			<PopupShell kind="snip" facing="inline-start" dir="rtl" aria-label="Translation" style={{ width: "22.5rem" }} />
		));
		const el = root.firstElementChild as HTMLElement;
		expect(el.style.width).toBe("22.5rem");
		expect(el.style.transformOrigin).toBe("right center");
		expect(el.getAttribute("role")).toBe("dialog");
		expect(el.getAttribute("aria-modal")).toBe("true");
		expect(el.getAttribute("dir")).toBe("rtl");
	});
});

describe("Switch and ProgressBar", () => {
	test("switch is a labelled role=switch that toggles", () => {
		const seen: boolean[] = [];
		const root = mount(() => (
			<Switch
				label="Copy translation after Snip"
				description="Puts the result on the clipboard."
				onChange={(v) => seen.push(v)}
			/>
		));
		const input = root.querySelector("input") as HTMLInputElement;
		expect(input.getAttribute("role")).toBe("switch");
		const labelledBy = input.getAttribute("aria-labelledby") ?? "";
		expect(document.getElementById(labelledBy.split(" ")[0] ?? "")?.textContent).toBe("Copy translation after Snip");
		input.click();
		expect(seen).toEqual([true]);
		expect(root.querySelector(".glim-switch-control")?.hasAttribute("data-checked")).toBe(true);
	});

	test("progress bar has real values, and no bar before the size is known", () => {
		const [total, setTotal] = createSignal(0);
		const root = mount(() => (
			<ProgressBar label="Downloading Japanese" done={412_000_000} total={total()} etaSeconds={170} />
		));
		expect(root.querySelector("[role=progressbar]")).toBeNull();
		expect(root.textContent).toBe("Preparing download");
		setTotal(1_200_000_000);
		const bar = root.querySelector("[role=progressbar]");
		expect(bar?.getAttribute("aria-valuenow")).toBe("412000000");
		expect(bar?.getAttribute("aria-valuetext")).toBe("412 MB of 1.2 GB · about 3 min left");
		expect((root.querySelector(".glim-progress-fill") as HTMLElement).style.width).toBe("34.333333333333336%");
	});
});

describe("LanguageMultiSelect (GLIM-68)", () => {
	const groups = [
		{
			key: "Latn",
			label: "Latin",
			options: [
				{ code: "fr", name: "French", nativeName: "français" },
				{ code: "es", name: "Spanish", nativeName: "español" },
			],
		},
		{
			key: "other",
			label: "Other scripts",
			options: [{ code: "ja", name: "Japanese", nativeName: "日本語", note: "Pack not downloaded" }],
		},
	];

	function setup(initial: string[] = []) {
		const [value, setValue] = createSignal<string[]>(initial);
		const root = mount(() => <LanguageMultiSelect groups={groups} value={value()} onChange={setValue} />);
		const input = root.querySelector("input") as HTMLInputElement;
		return { root, input, value };
	}

	test("groups by script with a listbox, options carry selection state", () => {
		const { root } = setup(["ja"]);
		const list = root.querySelector('[role="listbox"]');
		expect(list?.getAttribute("aria-multiselectable")).toBe("true");
		expect(root.querySelectorAll('[role="group"]')).toHaveLength(2);
		const ja = [...root.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes("Japanese"));
		expect(ja?.getAttribute("aria-selected")).toBe("true");
		expect(ja?.textContent).toContain("Pack not downloaded");
		expect(root.querySelector(".glim-chip")?.textContent).toContain("Japanese");
	});

	test("search matches own names without accents; Enter toggles the highlighted one", async () => {
		const { root, input, value } = setup();
		input.value = "espanol";
		input.dispatchEvent(new InputEvent("input", { bubbles: true }));
		await tick();
		const options = root.querySelectorAll('[role="option"]');
		expect(options).toHaveLength(1);
		expect(input.getAttribute("aria-activedescendant")).toBe(options[0]?.id ?? "");
		keydown(input, { key: "Enter" });
		expect(value()).toEqual(["es"]);
	});

	test("arrows move, Space toggles with an empty search, Backspace removes the last chip", () => {
		const { input, value } = setup(["fr"]);
		keydown(input, { key: "ArrowDown" });
		keydown(input, { key: "ArrowDown" });
		keydown(input, { key: " " });
		expect(value()).toEqual(["fr", "es"]);
		keydown(input, { key: "Backspace" });
		expect(value()).toEqual(["fr"]);
	});

	test("chips have a labelled remove button", () => {
		const { root, value } = setup(["fr", "ja"]);
		const remove = root.querySelector('button[aria-label="Remove French"]') as HTMLButtonElement;
		remove.click();
		expect(value()).toEqual(["ja"]);
	});
});

describe("PackRows (GLIM-138 confirm step)", () => {
	const pack: PackRowItem = { lang: "el", state: "missing", bytes: 31_000_000, received: null, total: null };
	const model: PackRowItem = {
		lang: "sw",
		state: "missing",
		bytes: 618_000_000,
		received: null,
		total: null,
		kind: "long-tail-model",
	};
	function rows(downloads: string[]) {
		return mount(() => (
			<PackRows
				rows={[pack, model]}
				text={(r) => `${r.lang} text`}
				downloadLabel={(r) => `Download ${r.bytes}`}
				offlineText="offline"
				failedText="failed"
				progressLabel={(r) => `Downloading ${r.lang}`}
				progressText={(d, t) => `${d}/${t}`}
				needsConfirm={(r) => r.bytes > 200_000_000}
				confirmText={(r) => `Really download ${r.lang}?`}
				cancelLabel="Not now"
				onDownload={(r) => downloads.push(r.lang)}
			/>
		));
	}
	const rowOf = (root: HTMLElement, kind: string) => root.querySelector(`[data-pack-kind="${kind}"]`) as HTMLElement;

	test("a small download starts at once", () => {
		const downloads: string[] = [];
		const root = rows(downloads);
		(rowOf(root, "language-pack").querySelector("button") as HTMLButtonElement).click();
		expect(downloads).toEqual(["el"]);
	});

	test("a large one asks first; Download confirms, focus lands on it", async () => {
		const downloads: string[] = [];
		const root = rows(downloads);
		(rowOf(root, "long-tail-model").querySelector("[data-pack-download]") as HTMLButtonElement).click();
		expect(downloads).toEqual([]);
		const row = rowOf(root, "long-tail-model");
		expect(row.textContent).toContain("Really download sw?");
		await tick();
		const confirm = row.querySelector("[data-pack-confirm]") as HTMLButtonElement;
		expect(document.activeElement).toBe(confirm);
		expect(document.getElementById(confirm.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
			"Really download sw?",
		);
		confirm.click();
		expect(downloads).toEqual(["sw"]);
		expect(rowOf(root, "long-tail-model").textContent).toContain("sw text");
	});

	test("Not now goes back to the row and its Download button", async () => {
		const downloads: string[] = [];
		const root = rows(downloads);
		(rowOf(root, "long-tail-model").querySelector("[data-pack-download]") as HTMLButtonElement).click();
		const buttons = rowOf(root, "long-tail-model").querySelectorAll("button");
		(buttons[1] as HTMLButtonElement).click();
		await tick();
		expect(downloads).toEqual([]);
		const row = rowOf(root, "long-tail-model");
		expect(row.textContent).toContain("sw text");
		expect(document.activeElement).toBe(row.querySelector("[data-pack-download]"));
	});
});
