import { BlockList, LocalIndicator, languageName, PopupShell, TextBlock } from "@glimpse/ui";
import { For, type JSX } from "solid-js";
import type { GalleryParams } from "./params.ts";
import { BIDI_CASES, LENGTH_CASES, SCRIPT_SAMPLES } from "./script-samples.ts";

function Heading(props: { title: string; note: string }): JSX.Element {
	return (
		<div class="mb-3 flex flex-col gap-0.5">
			<h2 class="m-0 text-heading">{props.title}</h2>
			<p class="m-0 max-w-[70ch] text-body text-text-secondary">{props.note}</p>
		</div>
	);
}

/**
 * GLIM-51: every script group in the translation and source sizes the popups use, with
 * the font each OS is expected to pick, then the bidi and length cases. A person checks
 * this on a real Mac and Windows PC: no tofu, no clipped marks, correct alignment.
 */
export function ScriptsPage(props: { params: GalleryParams }): JSX.Element {
	const os = () => props.params.os;
	return (
		<>
			<section class="mb-10">
				<Heading
					title="Scripts"
					note="Each row is a real TextBlock with the language's lang tag, so the per-script stack, size step and leading from tokens.css apply. The last column names the font this OS should pick; empty boxes mean a missing font."
				/>
				<table class="w-full max-w-[72rem] border-collapse text-start">
					<thead>
						<tr class="text-label text-text-secondary">
							<th class="w-44 py-1 pe-4 text-start font-medium">Language · script</th>
							<th class="py-1 pe-4 text-start font-medium">Translation size</th>
							<th class="py-1 pe-4 text-start font-medium">Source size</th>
							<th class="w-56 py-1 text-start font-medium">
								Expected font ({os() === "macos" ? "macOS 14+" : "Windows 10/11"})
							</th>
						</tr>
					</thead>
					<tbody>
						<For each={SCRIPT_SAMPLES}>
							{(s) => (
								<tr class="border-t border-divider align-top">
									<td class="py-2 pe-4">
										<div class="text-body">{languageName(s.lang)}</div>
										<div class="text-label text-text-secondary">
											{s.lang} · {s.script}
										</div>
									</td>
									<td class="py-1 pe-4">
										<p class="glim-text glim-translation m-0" lang={s.lang} dir="auto">
											{s.text}
										</p>
									</td>
									<td class="py-1 pe-4">
										<p class="glim-text glim-source m-0" lang={s.lang} dir="auto">
											{s.text}
										</p>
									</td>
									<td class="py-2 text-label text-text-secondary">
										<div>{os() === "macos" ? s.macos : s.windows}</div>
										{s.check ? <div class="mt-0.5 text-text-secondary">Check: {s.check}</div> : null}
									</td>
								</tr>
							)}
						</For>
					</tbody>
				</table>
			</section>

			<section class="mb-10">
				<Heading
					title="Mixed direction"
					note={'Blocks use dir="auto" and unicode-bidi: plaintext. Each case says what correct looks like.'}
				/>
				<div class="flex flex-wrap gap-6">
					<For each={BIDI_CASES}>
						{(c) => (
							<figure class="m-0 flex w-[22.5rem] flex-col gap-2">
								<PopupShell kind="snip" aria-label={c.label}>
									<BlockList aria-label={c.label}>
										<TextBlock state="done" translation={c.text} targetLang={c.lang} />
									</BlockList>
								</PopupShell>
								<figcaption class="text-label text-text-secondary">
									<span class="text-text-primary">{c.label}.</span> {c.expect}
								</figcaption>
							</figure>
						)}
					</For>
				</div>
			</section>

			<section class="mb-10">
				<Heading
					title="Mixed scripts and lengths in one popup"
					note="Each block keeps its own leading, so the CJK and Thai lines don't change the Latin ones. Long words and URLs wrap instead of overflowing; nothing is clamped."
				/>
				<div class="flex flex-wrap items-start gap-6">
					<PopupShell kind="snip" aria-label="Mixed scripts" style={{ width: "30rem" }}>
						<BlockList aria-label="Mixed scripts">
							<TextBlock
								state="done"
								showSource
								source="吾輩は猫である。"
								sourceLang="ja"
								translation="I am a cat."
								targetLang="en"
								tag="Japanese"
								tagLang="en"
							/>
							<TextBlock
								state="done"
								showSource
								source="สวัสดีชาวโลก"
								sourceLang="th"
								translation="Hello, world"
								targetLang="en"
								tag="Thai"
								tagLang="en"
							/>
							<TextBlock
								state="done"
								showSource
								source="नमस्ते दुनिया"
								sourceLang="hi"
								translation="Hello, world"
								targetLang="en"
								tag="Hindi"
								tagLang="en"
							/>
							<TextBlock state="done" kind="neutral" source={LENGTH_CASES.short} />
							<TextBlock state="done" translation={LENGTH_CASES.compound} targetLang="de" />
							<TextBlock state="done" translation={LENGTH_CASES.url} targetLang="en" />
						</BlockList>
						<div class="mt-2 flex h-6 items-center ps-2">
							<LocalIndicator />
						</div>
					</PopupShell>
					<PopupShell kind="snip" aria-label="Long paragraph" style={{ width: "17.5rem" }}>
						<BlockList aria-label="Long paragraph">
							<TextBlock state="done" translation={LENGTH_CASES.paragraph} targetLang="en" />
						</BlockList>
					</PopupShell>
					<PopupShell kind="snip" dir="rtl" lang="ar" aria-label="نص طويل" style={{ width: "22.5rem" }}>
						<BlockList aria-label="نص طويل">
							<TextBlock
								state="done"
								translation="الكتل الطويلة تلتف عند عرض النافذة ولا تُقطع أبدًا. هذه الفقرة طويلة بما يكفي لتلتف عدة مرات، فيمكن الحكم على ارتفاع السطر والمسافة بين الكتل."
								targetLang="ar"
							/>
							<TextBlock state="done" translation="اردو ایک خوبصورت زبان ہے۔" targetLang="ur" />
						</BlockList>
					</PopupShell>
				</div>
			</section>
		</>
	);
}
