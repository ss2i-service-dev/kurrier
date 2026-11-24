// Apercu des classeurs (xls, xlsx, ods) dans la visionneuse, meme tableau que le CSV.
// Samuel le 18/11/2026 : « et tant qu'a faire le csv, faut aussi faire le xls ».
// Ce test est lance par Dockerfile.web avant le build : rouge = pas d'image.
// Lancement (depuis la racine) :
//   node_modules/.bin/tsx apps/web/test/sheet-preview.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";
import { attachmentUrls } from "../lib/attachment-links";
import { canPreviewSheet, parseWorkbook, SHEET_PREVIEW_MAX_BYTES } from "../lib/sheet-preview";
import { buildTable, MAX_TABLE_ROWS } from "../lib/text-preview";

const ID = "111575e0-724f-4e04-b148-892453ebcbd5";
const web = join(__dirname, "..");
const source = (path: string) => readFileSync(join(web, path), "utf8");

let failures = 0;
const test = async (label: string, fn: () => void | Promise<void>) => {
	try {
		await fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.log(`ECHEC ${label}\n      ${err?.message ?? err}`);
	}
};

const workbook = (bookType: XLSX.BookType, sheets: Record<string, unknown[][]>, hidden: string[] = []) => {
	const wb = XLSX.utils.book_new();
	for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
	wb.Workbook = { Sheets: Object.keys(sheets).map((name) => ({ name, Hidden: hidden.includes(name) ? 1 : 0 })) };
	return new Uint8Array(XLSX.write(wb, { type: "array", bookType }));
};

const main = async () => {
	await test("classeurs reconnus par extension, jamais le CSV ni le texte", () => {
		for (const name of ["a.xls", "A.XLSX", "a.xlsm", "a.xlsb", "a.ods"]) {
			assert.equal(canPreviewSheet({ filenameOriginal: name, contentType: "application/octet-stream", sizeBytes: 10 }), true, name);
		}
		assert.equal(canPreviewSheet({ filenameOriginal: "a.csv", contentType: "application/vnd.ms-excel", sizeBytes: 10 }), false);
		assert.equal(canPreviewSheet({ filenameOriginal: "a.docx", sizeBytes: 10 }), false);
		assert.equal(canPreviewSheet({ filenameOriginal: "a.xlsx", sizeBytes: SHEET_PREVIEW_MAX_BYTES + 1 }), false);
	});

	await test("lien d'apercu porte par la page, octets servis par la route content", () => {
		const urls = attachmentUrls({ id: ID, filenameOriginal: "ventes.xlsx", sizeBytes: 100 });
		assert.equal(urls.sheetUrl, `/api/attachments/${ID}?mode=content`);
		assert.equal(urls.textUrl, undefined);
		assert.equal(attachmentUrls({ id: ID, filenameOriginal: "a.csv", sizeBytes: 100 }).sheetUrl, undefined);
		const route = source("app/api/attachments/[id]/route.ts");
		assert.match(route, /canPreviewSheet\(attachment\)/);
	});

	// xlsb : Hugo le 24/11/2026, 20 classeurs binaires recus.
	for (const bookType of ["xlsx", "xls", "xlsb", "ods"] as const) {
		await test(`lecture ${bookType} : une feuille par onglet, cellules en texte`, async () => {
			const bytes = workbook(bookType, {
				Ventes: [["Libelle", "Quantite"], ["Chambre", 12], ["Petit dejeuner", 3.5]],
				Notes: [["a"], ["b"]],
			});
			const { sheets } = await parseWorkbook(bytes);
			assert.deepEqual(sheets.map((s) => s.name), ["Ventes", "Notes"]);
			assert.deepEqual(sheets[0].rows[0], ["Libelle", "Quantite"]);
			assert.equal(sheets[0].rows[1][0], "Chambre");
			assert.equal(sheets[0].rows[1][1], "12");
			assert.equal(sheets[0].totalRows, 3);
			assert.equal(sheets[1].rows.length, 2);
		});
	}

	await test("feuilles masquees ignorees, lignes plafonnees avec le total reel", async () => {
		const many = [["n"], ...Array.from({ length: MAX_TABLE_ROWS + 500 }, (_, i) => [i])];
		const { sheets } = await parseWorkbook(workbook("xlsx", { Visible: many, Cachee: [["x"]] }, ["Cachee"]));
		assert.deepEqual(sheets.map((s) => s.name), ["Visible"]);
		assert.ok(sheets[0].rows.length <= MAX_TABLE_ROWS + 1, `lignes lues : ${sheets[0].rows.length}`);
		assert.equal(sheets[0].totalRows, MAX_TABLE_ROWS + 501);
	});

	await test("fichier illisible : erreur, pas de tableau vide", async () => {
		await assert.rejects(parseWorkbook(new TextEncoder().encode("ceci n'est pas un classeur \u0000\u0001")));
	});

	await test("tableau commun : colonnes numeriques a droite, libelles longs sur plusieurs lignes", () => {
		const t = buildTable([["Libelle", "Qte"], ["x".repeat(60), "12"], ["court", "1 234,50 EUR"]], 3);
		assert.deepEqual(t.header, ["Libelle", "Qte"]);
		assert.deepEqual(t.numeric, [false, true]);
		assert.deepEqual(t.long, [true, false]);
		assert.equal(t.totalRows, 2);
		assert.equal(t.columns, 2);
	});

	await test("composants : tableau partage, feuilles en onglets, plus de largeur plafonnee", () => {
		const sheet = source("components/k/sheet-preview.tsx");
		assert.match(sheet, /import\("xlsx"\)|parseWorkbook/);
		assert.doesNotMatch(sheet, /dangerouslySetInnerHTML|sheet_to_html/);
		assert.match(sheet, /role="tablist"/);
		for (const f of ["text-preview", "zip-preview", "sheet-preview"]) {
			assert.doesNotMatch(source(`components/k/${f}.tsx`), /max-w-\[(900|1000|1100|1400)px\]/, f);
		}
		assert.doesNotMatch(source("components/k/attachments.tsx"), /max-w-\[1000px\]/);
		assert.doesNotMatch(source("components/k/pptx-preview.tsx"), /max-w-\[1100px\]/);
	});

	if (failures > 0) {
		console.error(`${failures} test(s) en echec`);
		process.exit(1);
	}
};
main();
