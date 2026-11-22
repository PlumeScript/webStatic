// Résolution des dépendances Plume — reproduit à l'identique la règle de
// `plume.getFilenameFromPath` (plume-data/engine/utils.lua du repo Plume)
// dans le contexte du CLI :
//   basedirs = répertoires de l'env PLUME_PATH (séparée par « ; »),
//              lus au moment de la commande, puis le cwd.
// Pour chaque basedir, dans l'ordre :
//   <base><dep>.plume, <base><dep>/init.plume, <base><dep>.🪶, <base><dep>/init.🪶
// (ordre des boucles du code Lua : extension en dehors, template dedans).
// Le premier fichier existant gagne. Si c'est init.<ext> qui gagne, la
// dépendance est le dossier ; sinon c'est un fichier.

import fs from "node:fs";

export function normalizePath(p) {
	let s = String(p).replace(/\\/g, "/");
	let drive = "";
	const m = s.match(/^([A-Za-z]):/);
	if (m) { drive = m[1] + ":"; s = s.slice(2); }
	const abs = !!drive || s.startsWith("/");
	const out = [];
	for (const seg of s.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") { out.pop(); continue; }
		out.push(seg);
	}
	let res = out.join("/");
	if (drive) res = drive + "/" + res;
	else if (abs) res = "/" + res;
	return res;
}

export function formatDir(p) {
	// Comme en Lua : chemin normalisé AVEC slash final (les templates sont
	// concaténés directement : %base%%path%).
	const n = normalizePath(p);
	return n.endsWith("/") ? n : n + "/";
}

export function basedirs(cwd = process.cwd()) {
	const dirs = [];
	const pp = process.env.PLUME_PATH ?? "";
	for (const raw of pp.split(";")) {
		const d = raw.trim();
		if (d) dirs.push(formatDir(d));
	}
	dirs.push(formatDir(cwd));
	return dirs;
}

const EXTS = ["plume", "\u{1FAB6}"]; // .plume, .🪶

// Renvoie { kind: "dir"|"file", root, entry, tried } ou null (avec tried).
export function resolveDep(name, dirs = basedirs()) {
	const path = normalizePath(name);
	const candidates = [];
	for (const base of dirs) {
		for (const ext of EXTS) {
			candidates.push({ file: normalizePath(base + path + "." + ext), dir: null });
			candidates.push({ file: normalizePath(base + path + "/init." + ext), dir: normalizePath(base + path) });
		}
	}
	const tried = [];
	for (const c of candidates) {
		let isFile = false;
		try { isFile = fs.statSync(c.file).isFile(); } catch {}
		if (isFile) {
			return c.dir
				? { kind: "dir", root: c.dir, entry: c.file, tried }
				: { kind: "file", root: null, entry: c.file, tried };
		}
		tried.push(c.file);
	}
	return { kind: null, root: null, entry: null, tried };
}
