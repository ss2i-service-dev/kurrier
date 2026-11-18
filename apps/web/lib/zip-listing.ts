// ss2i : liste des fichiers d'un zip recu, affichee dans la visionneuse (Samuel le 18/11/2026 :
// « les zip il faut un apercu de la liste des fichiers qu'ils contiennent »). Rien n'est
// decompresse : le serveur lit par plages S3 la fin du fichier (fin de repertoire central)
// puis le repertoire central, quelle que soit la taille du zip.
// Fonctions pures, testees par apps/web/test/zip-listing.ts.

// Fin de repertoire central (22 octets) + commentaire de 65 535 octets au plus.
export const ZIP_TAIL_BYTES = 22 + 65535;
// Repertoire central plus grand : liste refusee (des centaines de milliers de fichiers).
export const ZIP_DIRECTORY_MAX_BYTES = 32 * 1024 * 1024;
export const ZIP_LIST_MAX_ENTRIES = 20000;

export type ZipEntry = {
	path: string;
	size: number;
	compressedSize: number;
	modified: string | null;
	dir: boolean;
	encrypted: boolean;
};

export type ZipDirectory = { offset: number; size: number; count: number };

export function canListZip(a: { filenameOriginal?: string | null; contentType?: string | null }) {
	const type = (a.contentType || "").split(";")[0].trim().toLowerCase();
	return (
		/\.zip$/i.test(a.filenameOriginal || "") ||
		type === "application/zip" ||
		type === "application/x-zip-compressed" ||
		type === "application/x-zip"
	);
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b: Uint8Array, o: number) => u32(b, o) + u32(b, o + 4) * 2 ** 32;

// Repere le repertoire central a partir des derniers octets du fichier (tail) et de sa taille.
export function locateCentralDirectory(tail: Uint8Array, fileSize: number): ZipDirectory | null {
	const base = fileSize - tail.length;
	for (let i = tail.length - 22; i >= 0; i--) {
		if (u32(tail, i) !== 0x06054b50) continue;
		let count = u16(tail, i + 10);
		let size = u32(tail, i + 12);
		let offset = u32(tail, i + 16);
		// ZIP64 : le localisateur precede la fin de repertoire et pointe l'enregistrement 64 bits.
		if ((offset === 0xffffffff || size === 0xffffffff || count === 0xffff) && i >= 20 && u32(tail, i - 20) === 0x07064b50) {
			const rec = u64(tail, i - 12) - base;
			if (rec < 0 || rec + 56 > tail.length || u32(tail, rec) !== 0x06064b50) return null;
			count = u64(tail, rec + 32);
			size = u64(tail, rec + 40);
			offset = u64(tail, rec + 48);
		}
		if (offset + size > fileSize) continue;
		return { offset, size, count };
	}
	return null;
}

// CP437 (noms sans le drapeau UTF-8, zips de l'Explorateur Windows), octets 0x80 a 0xFF.
const CP437_HIGH =
	"ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

function decodeName(bytes: Uint8Array, utf8: boolean) {
	if (utf8) return new TextDecoder("utf-8").decode(bytes);
	try {
		// Beaucoup d'outils ecrivent de l'UTF-8 sans poser le drapeau.
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		let s = "";
		for (const c of bytes) s += c < 0x80 ? String.fromCharCode(c) : CP437_HIGH[c - 0x80];
		return s;
	}
}

function dosDate(time: number, date: number) {
	if (!date) return null;
	const y = 1980 + (date >> 9);
	const mo = (date >> 5) & 15;
	const d = date & 31;
	const h = time >> 11;
	const mi = (time >> 5) & 63;
	const s = (time & 31) * 2;
	if (mo < 1 || mo > 12 || d < 1) return null;
	const p = (n: number) => String(n).padStart(2, "0");
	// Heure locale de la machine qui a cree le zip : sans fuseau.
	return `${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:${p(s)}`;
}

export function parseCentralDirectory(dir: Uint8Array, maxEntries = ZIP_LIST_MAX_ENTRIES) {
	const entries: ZipEntry[] = [];
	let o = 0;
	let total = 0;
	while (o + 46 <= dir.length && u32(dir, o) === 0x02014b50) {
		const flags = u16(dir, o + 8);
		let compressedSize = u32(dir, o + 20);
		let size = u32(dir, o + 24);
		const nameLen = u16(dir, o + 28);
		const extraLen = u16(dir, o + 30);
		const commentLen = u16(dir, o + 32);
		const externalAttr = u32(dir, o + 38);
		const name = decodeName(dir.subarray(o + 46, o + 46 + nameLen), (flags & 0x800) !== 0);
		// ZIP64 : tailles reelles dans le champ extra 0x0001, dans l'ordre taille puis compressee.
		let e = o + 46 + nameLen;
		const extraEnd = e + extraLen;
		while (e + 4 <= extraEnd) {
			const id = u16(dir, e);
			const len = u16(dir, e + 2);
			if (id === 0x0001) {
				let p = e + 4;
				if (size === 0xffffffff) {
					size = u64(dir, p);
					p += 8;
				}
				if (compressedSize === 0xffffffff) compressedSize = u64(dir, p);
			}
			e += 4 + len;
		}
		total++;
		if (entries.length < maxEntries) {
			entries.push({
				path: name,
				size,
				compressedSize,
				modified: dosDate(u16(dir, o + 12), u16(dir, o + 14)),
				dir: name.endsWith("/") || (externalAttr & 0x10) !== 0,
				encrypted: (flags & 1) !== 0,
			});
		}
		o = extraEnd + commentLen;
	}
	return { entries, total, truncated: total > entries.length };
}
