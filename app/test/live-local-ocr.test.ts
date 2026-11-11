// GLIM-122: Live "Use on-device" with Google Cloud Vision as the OCR provider. The service
// builds the best-ranked local OCR provider as a stand-in, and the session never sends an
// image off the device (the fake fetch sees no call). Without a local OCR provider the answer
// isn't offered, and a localOnly run still never falls back to the cloud.
import { describe, expect, test } from "bun:test";
import {
	applySettingsPatch,
	defaultSettings,
	nullLogger,
	type OcrImage,
	PROVIDER_IDS,
	ProviderRegistry,
	rect,
	type Settings,
} from "@glimpse/core";
import { fakeOcrFactory, fakeTranslationFactory, MemorySecretStore, makeImage, ocrBlock } from "@glimpse/core/testing";
import { GOOGLE_SECRET_ID, type GoogleCloudContext } from "@glimpse/providers/google";
import { googleVisionFactory } from "@glimpse/providers/ocr/google-vision";
import { FakeFetch } from "@glimpse/providers/testing";
import { settingsEnvFor } from "../src/bun/services/settings-env.ts";
import { TranslationService } from "../src/bun/services/translation/translation-service.ts";

function setup(withLocal: boolean) {
	const fake = new FakeFetch().on("POST", "https://vision.googleapis.com/", {
		json: { responses: [{ fullTextAnnotation: { text: "", pages: [] } }] },
	});
	const registry = new ProviderRegistry<GoogleCloudContext>();
	registry.register(googleVisionFactory());
	if (withLocal) {
		registry.register(fakeOcrFactory({ id: "fake-local-ocr", blocks: [ocrBlock("b1", "Hola", rect(0, 0, 50, 20))] }));
	}
	registry.register(fakeTranslationFactory({ id: "fake-translation" }));
	const env = settingsEnvFor("windows", "en-US", registry);
	const settings: Settings = applySettingsPatch(
		defaultSettings(env),
		{ providers: { ocr: PROVIDER_IDS.googleVision, translation: ["fake-translation"] } },
		env,
	).settings;
	const service = new TranslationService({
		registry,
		ctx: {
			google: {
				secrets: new MemorySecretStore({ [GOOGLE_SECRET_ID]: "AIzaFAKEKEY0000000000000000000000000000" }),
				fetch: fake.fetch,
			},
		},
		settings: () => settings,
		log: nullLogger,
	});
	return { service, fake };
}

const rgba = makeImage(100, 40, (x) => (x > 20 && x < 80 ? [230, 230, 230] : [20, 20, 20]));
const image: OcrImage = { width: 100, height: 40, stride: 400, format: "rgba8", data: rgba.data };

describe("Live Use on-device with a cloud OCR provider (GLIM-122)", () => {
	test("a local OCR provider stands in: offered, and no image leaves the device", async () => {
		const { service, fake } = setup(true);
		await service.start();
		expect(service.ocr?.info.kind).toBe("cloud");
		expect(service.canReadLocally).toBe(true);
		await service.prepareLocalOcr();
		const session = service.openLive(() => {}, { localOnly: true });
		const result = await session.process(image);
		expect(result?.error).toBeNull();
		expect(result?.ocr?.id).toBe("fake-local-ocr");
		expect(result?.blocks.map((b) => b.text)).toEqual(["Hola"]);
		expect(result?.cloud).toBe(false);
		expect(fake.calls).toEqual([]);
		session.close();
		await service.dispose();
	});

	test("a normal session still uses the cloud provider (the fake fetch sees the image)", async () => {
		const { service, fake } = setup(true);
		await service.start();
		const session = service.openLive(() => {});
		await session.process(image);
		expect(fake.calls.length).toBe(1);
		session.close();
		await service.dispose();
	});

	test("no local OCR provider: not offered, and a localOnly run fails instead of sending", async () => {
		const { service, fake } = setup(false);
		await service.start();
		expect(service.canReadLocally).toBe(false);
		await service.prepareLocalOcr();
		const session = service.openLive(() => {}, { localOnly: true });
		const result = await session.process(image);
		expect(result?.error?.kind).toBe("ocrFailed");
		expect(fake.calls).toEqual([]);
		session.close();
		await service.dispose();
	});
});
