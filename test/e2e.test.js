// Test e2e de plumeWebStatic :
// 1. fixture repo git de dépendance temporaire (init.plume + fichiers trackés,
//    junk 1 Mo non tracké, dossier repro/ tracké) ;
// 2. projet exemple avec config.json + exclude ;
// 3. lancer le CLI → asserts (existence, taille, preuves gitignore/exclude) ;
// 4. charger le bundle en node → plume.ready → plume.execute → HTML ;
// 5. cas d'erreur : plume.execute résout avec la box d'erreur (pas de throw).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const CLI = path.join(ROOT, "bin", "plumeWebStatic.js");

const MARK_JUNK = "MARKER_JUNK_UNTRACKED";
const MARK_EXCLUDED = "MARKER_EXCLUDED_REPRO";
const MARK_EXTRA = "MARKER_EXTRA_TRACKED";

// Fichier binaire tracké (façon police TTF) : magic + NUL + bytes élevés.
// Sert à la preuve de round-trip byte-exact via io.open (base64 dans la VFS).
const FONT_BYTES = Buffer.from([
	0x00, 0x01, 0x00, 0x00, 0x00, 0xff, 0x80, 0xc0,
	0x01, 0x7f, 0x81, 0x00, 0xab, 0xcd, 0xef, 0x00,
]);

function git(repo, ...args) {
	const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} in ${repo}: ${r.stderr}`);
	return r.stdout;
}

function makeFixture() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pwstatic-"));
	const dep = path.join(tmp, "deptest");
	fs.mkdirSync(path.join(dep, "repro"), { recursive: true });
	fs.writeFileSync(path.join(dep, "init.plume"),
		[
			"// deptest: dépendance de test",
			"hi: macro()",
			"\thello from dep",
			"end",
			"Document: macro(body)",
			"\t<html><body>$body</body></html>",
			"end",
			"",
		].join("\n"));
	fs.writeFileSync(path.join(dep, "extra.plume"), `// ${MARK_EXTRA}\n`);
	fs.writeFileSync(path.join(dep, "font.bin"), FONT_BYTES);
	fs.writeFileSync(path.join(dep, "repro", "note.plume"), `// ${MARK_EXCLUDED}\n`);
	// junk 1 Mo NON tracké (jamais ajouté à git)
	const junk = Buffer.alloc(1024 * 1024);
	junk.fill((MARK_JUNK + "\n").repeat(64));
	fs.writeFileSync(path.join(dep, "junk.bin"), junk);
	git(dep, "init", "-b", "main");
	git(dep, "config", "user.email", "test@test");
	git(dep, "config", "user.name", "test");
	git(dep, "add", "init.plume", "extra.plume", "font.bin", "repro/note.plume");
	git(dep, "commit", "-m", "fixture");

	const proj = path.join(tmp, "proj");
	fs.mkdirSync(proj);
	fs.writeFileSync(path.join(proj, "config.json"), JSON.stringify({
		dependencies: ["deptest"],
		src: "plumeWebStatic",
		exclude: { deptest: ["repro/"] },
	}, null, "\t"));
	return { tmp, dep, proj };
}

function runCli(cwd, project) {
	const r = spawnSync(process.execPath, [CLI, project], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, PLUME_PATH: "" },
	});
	if (r.status !== 0) throw new Error(`CLI failed:\n${r.stdout}\n${r.stderr}`);
	return r.stdout;
}

test("plumeWebStatic e2e", async () => {
	const { tmp, proj } = makeFixture();
	try {
		// 3. Lancer le CLI (cwd = tmp : la dépendance se résout depuis le cwd).
		const out = runCli(tmp, "proj");

		const outPath = path.join(proj, "plumeWebStatic.js");
		assert.ok(fs.existsSync(outPath), "fichier généré absent");
		const size = fs.statSync(outPath).size;
		assert.ok(size > 1_500_000, `taille trop petite: ${size}`);
		assert.ok(size < 20_000_000, `taille anormalement grande: ${size}`);

		const content = fs.readFileSync(outPath, "utf8");
		assert.ok(!content.includes(MARK_JUNK), "fichier non tracké présent (gitignore non respecté)");
		assert.ok(!content.includes(MARK_EXCLUDED), "dossier exclu présent (exclude non appliqué)");
		assert.ok(content.includes(MARK_EXTRA), "fichier tracké absent");
		assert.ok(content.includes(FONT_BYTES.toString("base64")), "fichier binaire absent de la VFS (base64)");
		assert.ok(/plume engine [0-9a-f]{7}/.test(content), "hash du repo Plume absent de l'en-tête");
		console.log("cli:", out.trim());

		// 4. Charger le bundle en node (IIFE → globalThis.plume).
		const req = createRequire(import.meta.url);
		req(outPath);
		const plume = globalThis.plume;
		assert.ok(plume, "globalThis.plume absent");
		assert.ok(plume.ready instanceof Promise, "plume.ready n'est pas une Promise");
		await plume.ready; // init wasm + montage + bridges

		const html = await plume.execute("use deptest\n@Document\nhello\nend");
		assert.equal(typeof html, "string");
		assert.ok(html.includes("hello"), `HTML ne contient pas "hello": ${html.slice(0, 200)}`);

		// La dépendance est bien lue via les bridges (VFS).
		const html2 = await plume.execute("use deptest\n@Document\n$hi()\nend");
		assert.ok(html2.includes("hello from dep"), "la macro de la dépendance n'est pas lue depuis la VFS");

		// 5. Binaire : round-trip byte-exact (le binaire passe en base64 dans
		//    la VFS et est décodé côté Lua par le wrapper io.open).
		const hexDoc = [
			"use deptest",
			"@Document",
			"let x = @lua.eval",
			"	raw[",
			"		local f = io.open('libs/deptest/font.bin', 'rb')",
			"		local d = f and f:read('*a') or nil",
			"		if f then f:close() end",
			"		local out = {}",
			"		if d then for i = 1, #d do out[#out+1] = string.format('%02x', d:byte(i)) end end",
			"		return table.concat(out)",
			"	]end",
			"end",
			"<h1>hex:$x</h1>",
			"end",
		].join("\n");
		const html3 = await plume.execute(hexDoc);
		const m = html3.match(/<h1>hex:([0-9a-f]*)<\/h1>/);
		assert.ok(m, `dump hex absent: ${html3.slice(0, 300)}`);
		assert.equal(m[1], FONT_BYTES.toString("hex"), "round-trip binaire non byte-exact");

		// 6. Cas d'erreur : résout (pas de throw) avec la box d'erreur.
		const err = await plume.execute("boucle");
		assert.equal(typeof err, "string");
		assert.ok(err.length > 0, "l'erreur plume doit résolver à une string non vide");
		assert.ok(!err.includes("hello"), "l'erreur ne doit pas contenir le HTML");
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
