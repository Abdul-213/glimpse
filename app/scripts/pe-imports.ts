// The DLL names a Windows PE file (DLL, .node addon, EXE) imports directly (GLIM-111). Reads the
// import directory only: delay-loaded DLLs (ORT's DirectML.dll) are not listed, which is what we
// want, since those are loaded only when the feature that needs them is used. Works on PE32 and
// PE32+ (x64 and arm64) files, on any OS, so the build can check a Windows target from Linux.

/** Names as written in the import table (case preserved). Throws on a file that isn't a PE image. */
export function peImports(file: Uint8Array): string[] {
	const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
	const u16 = (at: number) => view.getUint16(at, true);
	const u32 = (at: number) => view.getUint32(at, true);
	if (file.byteLength < 0x40 || u16(0) !== 0x5a4d) throw new Error("not a PE file (no MZ header)");
	const pe = u32(0x3c);
	if (pe + 24 > file.byteLength || u32(pe) !== 0x00004550) throw new Error("not a PE file (no PE signature)");
	const sections = u16(pe + 6);
	const optSize = u16(pe + 20);
	const opt = pe + 24;
	const magic = u16(opt);
	const dataDirs = magic === 0x20b ? opt + 112 : magic === 0x10b ? opt + 96 : -1;
	if (dataDirs < 0) throw new Error(`unknown optional header magic 0x${magic.toString(16)}`);
	const importRva = u32(dataDirs + 8);
	if (importRva === 0) return [];

	const table = opt + optSize;
	const toOffset = (rva: number): number => {
		for (let i = 0; i < sections; i++) {
			const s = table + i * 40;
			const va = u32(s + 12);
			const size = Math.max(u32(s + 8), u32(s + 16));
			if (rva >= va && rva < va + size) return rva - va + u32(s + 20);
		}
		throw new Error(`RVA 0x${rva.toString(16)} is in no section`);
	};
	const cString = (at: number): string => {
		let end = at;
		while (end < file.byteLength && file[end] !== 0) end++;
		return new TextDecoder("latin1").decode(file.subarray(at, end));
	};

	const names: string[] = [];
	for (let d = toOffset(importRva); d + 20 <= file.byteLength; d += 20) {
		const nameRva = u32(d + 12);
		if (nameRva === 0 && u32(d) === 0 && u32(d + 16) === 0) break;
		names.push(cString(toOffset(nameRva)));
	}
	return names;
}
