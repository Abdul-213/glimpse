// GLIM-18 spike CLI. Same code paths as the Electrobun app, without a window.
//
//   bun src/cli.ts <command>            (run through the `bun` you installed)
//   dist/glimpse-keychain-cli <command> (after `bun run compile`: a standalone,
//                                        ad-hoc-signed binary that changes every build)
//
// Commands:
//   info            runtime identity (which executable the OS sees)
//   roundtrip       write -> read -> update -> read -> delete -> read
//   write-marker    store a random marker under account "spike-marker"
//   read-marker     read it back and print its fingerprint
//   delete-marker
//   size-probe      raw size limits of the OS store (bypasses the wrapper cap)
//   migrate         service-rename migration probe
//   set <account>   read a value from stdin and store it (never from argv)
//   check <account> present / absent, masked
//   delete <account>
import { readMarker, deleteMarker, formatSteps, migrationProbe, runRoundTrip, sizeProbe, writeMarker, type Step } from "./shared/roundtrip";
import { ApiKeyStore, SERVICE, SecretStoreError, bunSecretsBackend, mask } from "./shared/secret-store";

declare const GLIM_BUILD_ID: string | undefined;
const buildId = typeof GLIM_BUILD_ID === "string" ? GLIM_BUILD_ID : "source (not compiled)";

const store = new ApiKeyStore();
const [cmd = "roundtrip", arg] = process.argv.slice(2);

function info(): string {
	return [
		`platform=${process.platform} arch=${process.arch} bun=${Bun.version} (${Bun.revision.slice(0, 9)})`,
		`execPath=${process.execPath}`,
		`pid=${process.pid} build=${buildId}`,
		`service=${SERVICE} backend=${store.backend.name}`,
	].join("\n");
}

function print(title: string, steps: Step[]): boolean {
	console.log(`== ${title}\n${formatSteps(steps)}`);
	return steps.every((s) => s.ok);
}

async function readStdin(): Promise<string> {
	const text = await Bun.stdin.text();
	return text.replace(/\r?\n$/, "");
}

let ok = true;
try {
	console.log(info());
	switch (cmd) {
		case "info":
			break;
		case "roundtrip":
			ok = print("round trip", await runRoundTrip(store));
			break;
		case "write-marker":
			ok = print("write marker", await writeMarker(store));
			break;
		case "read-marker":
			ok = print("read marker", await readMarker(store));
			break;
		case "delete-marker":
			ok = print("delete marker", await deleteMarker(store));
			break;
		case "size-probe":
			print("size probe (FAIL rows are expected above the platform limit)", await sizeProbe(bunSecretsBackend, SERVICE));
			break;
		case "migrate":
			ok = print("migration", await migrationProbe(store));
			break;
		case "set": {
			if (!arg) throw new Error("usage: set <account>   (value on stdin)");
			const v = await readStdin();
			await store.set(arg, v);
			console.log(`stored ${arg}: ${mask(v)}`);
			break;
		}
		case "check":
			if (!arg) throw new Error("usage: check <account>");
			console.log(`${arg}: ${mask(await store.get(arg))}`);
			break;
		case "delete":
			if (!arg) throw new Error("usage: delete <account>");
			console.log(`${arg}: deleted=${await store.delete(arg)}`);
			break;
		default:
			throw new Error(`unknown command ${cmd}`);
	}
} catch (err) {
	ok = false;
	if (err instanceof SecretStoreError) {
		console.error(`ERROR ${err.message}\nUI would say: ${err.userMessage}`);
	} else {
		console.error(`ERROR ${(err as Error)?.message ?? String(err)}`);
	}
}
process.exit(ok ? 0 : 1);
