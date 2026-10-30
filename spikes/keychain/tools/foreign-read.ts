// Threat-model check: read Glimpse's marker from a DIFFERENT process (your own
// `bun`, outside the app bundle). Prints only the fingerprint.
//   bun tools/foreign-read.ts [account]   (default: spike-marker)
// macOS: if this succeeds with no prompt, the item's ACL trusts "any Oven-signed
//        bun", not "Glimpse". Windows: expected to succeed silently (no per-app ACL).
const account = process.argv[2] ?? "spike-marker";
console.log(`execPath=${process.execPath} pid=${process.pid}`);
try {
	const v = await Bun.secrets.get({ service: "dev.glimpse.app", name: account });
	console.log(v === null ? `${account}: NOT FOUND` : `${account}: fp=${new Bun.CryptoHasher("sha256").update(v).digest("hex").slice(0, 12)}`);
} catch (err) {
	const e = err as { code?: string; message?: string };
	console.log(`ERROR ${e.code}: ${e.message}`);
}
