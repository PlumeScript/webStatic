// Collecte des fichiers : uniquement les fichiers git-tracked (git ls-files,
// ce qui respecte le gitignore du repo), application des excludes, lecture.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { normalizePath } from "./resolve.js";

export function gitTracked(repoDir) {
	const r = spawnSync("git", ["-C", repoDir, "ls-files", "-z"], {
		encoding: "utf8",
		maxBuffer: 1024 * 1024 * 512,
	});
	if (r.error) throw new Error(`git ls-files failed in ${repoDir}: ${r.error.message}`);
	if (r.status !== 0) throw new Error(`git ls-files failed in ${repoDir}: ${(r.stderr || "").trim()}`);
	return r.stdout.split("\0").filter(Boolean).map((f) => normalizePath(f));
}

// Excludes : sous-chemins relatifs à la racine de la dépendance.
// « dir/ » (slash final) = tout le dossier ; sans slash = le fichier exact.
export function isExcluded(relPath, excludes) {
	for (const raw of excludes ?? []) {
		const isDir = String(raw).endsWith("/") || String(raw).endsWith("\\");
		const e = normalizePath(raw);
		if (isDir) {
			if (relPath.startsWith(e + "/")) return true;
		} else if (relPath === e) {
			return true;
		}
	}
	return false;
}

// Lecture d'un fichier pour l'embedding :
// - contenu avec octet nul = BINAIRE (police, image, …) → base64 ASCII
//   (le pont string JS↔Lua est UTF-8 + NUL-terminé : le binaire ne peut pas
//   passer en string brute ; le decode se fait côté Lua, voir bridges.js) ;
// - sinon texte UTF-8 (sources .plume/.lua, …).
// Renvoie { content, binary }.
export function readFile(p) {
	const buf = fs.readFileSync(p);
	if (buf.includes(0)) return { content: buf.toString("base64"), binary: true };
	return { content: buf.toString("utf8"), binary: false };
}

// Fichiers .lua git-tracked du moteur (plume-data/ du repo Plume).
// Les clés = chemins de montage (plume-data/...).
export function collectEngineFiles(plumeRepo) {
	const files = gitTracked(plumeRepo).filter(
		(f) => f.startsWith("plume-data/") && f.endsWith(".lua")
	);
	const out = {};
	for (const f of files) out[f] = fs.readFileSync(path.join(plumeRepo, f), "utf8");
	return out;
}

// Fichiers d'une dépendance résolue, embarqués sous libs/<dep>/...
// (ou libs/<dep>.plume pour une dépendance fichier).
// Renvoie { files, binary } : files = { vfsPath: content }, binary = [vfsPath].
export function collectDep(name, resolved, excludes) {
	const files = {};
	const binary = [];
	if (resolved.kind === "file") {
		const key = `libs/${name}.plume`;
		files[key] = readFile(resolved.entry).content;
		return { files, binary };
	}
	for (const f of gitTracked(resolved.root)) {
		if (isExcluded(f, excludes)) continue;
		const key = resolved.kind === "dir" ? `libs/${name}/${f}` : f;
		const r = readFile(path.join(resolved.root, f));
		files[key] = r.content;
		if (r.binary) binary.push(key);
	}
	return { files, binary };
}
