// CLI plumeWebStatic <monprojet> — lit monprojet/config.json et génère
// monprojet/<src>.js : un IIFE autonome (wasmoon + wasm embarqué + moteur
// Plume + dépendances) qui exécute des scripts Plume dans le navigateur
// (file://), sans serveur ni réseau.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { basedirs, resolveDep } from "./resolve.js";
import { collectEngineFiles, collectDep } from "./collect.js";
import { buildBundle, readWasmBase64 } from "./build.js";

const DEFAULT_PLUME_REPO = "F:/Dropbox/proj/code/dev/plume/plume";

function plumeRepoHash(repo) {
	const r = spawnSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], { encoding: "utf8" });
	if (r.status !== 0) throw new Error(`cannot read git HEAD of Plume repo ${repo}`);
	return r.stdout.trim();
}

function fail(msg) {
	console.error("plumeWebStatic: " + msg);
	process.exit(1);
}

export async function main(argv) {
	const projectArg = argv[0];
	if (!projectArg) fail("usage: plumeWebStatic <monprojet>");

	const project = path.resolve(process.cwd(), projectArg);
	const configPath = path.join(project, "config.json");
	if (!fs.existsSync(configPath)) fail(`no config.json found in ${project}`);

	let config;
	try {
		config = JSON.parse(fs.readFileSync(configPath, "utf8"));
	} catch (e) {
		fail(`invalid config.json: ${e.message}`);
	}
	if (!Array.isArray(config.dependencies) || config.dependencies.length === 0) {
		fail(`config.json: "dependencies" must be a non-empty array of Plume names`);
	}
	if (typeof config.src !== "string" || !config.src) {
		fail(`config.json: "src" must be a non-empty string (stem of the generated file)`);
	}
	const exclude = config.exclude ?? {};
	for (const dep of config.dependencies) {
		if (exclude[dep] !== undefined && !Array.isArray(exclude[dep])) {
			fail(`config.json: "exclude." + dep must be an array of sub-paths`);
		}
	}

	const plumeRepo = process.env.PLUME_REPO ?? DEFAULT_PLUME_REPO;
	if (!fs.existsSync(path.join(plumeRepo, "plume-data"))) {
		fail(`Plume repo not found at ${plumeRepo} (no plume-data/ — check env PLUME_REPO)`);
	}

	// 1. Résolution des dépendances (règle Plume : PLUME_PATH puis cwd).
	const dirs = basedirs();
	const libs = {};
	const binaryPaths = [];
	for (const dep of config.dependencies) {
		const resolved = resolveDep(dep, dirs);
		if (resolved.kind === null) {
			fail(
				`dependency "${dep}" not found.\nTried:\n` +
				resolved.tried.map((p) => "  " + p).join("\n")
			);
		}
		const r = collectDep(dep, resolved, exclude[dep] ?? []);
		if (Object.keys(r.files).length === 0) {
			fail(`dependency "${dep}" resolved to ${resolved.entry} but no git-tracked file to embed`);
		}
		Object.assign(libs, r.files);
		binaryPaths.push(...r.binary);
	}

	// 2. Moteur Plume (fichiers .lua git-tracked de plume-data/).
	const engineFiles = collectEngineFiles(plumeRepo);
	if (Object.keys(engineFiles).length === 0) {
		fail(`no .lua file found under plume-data/ of ${plumeRepo}`);
	}

	// 3. wasm embarqué + bundle IIFE.
	const wasmBase64 = readWasmBase64();
	const plumeHash = plumeRepoHash(plumeRepo);
	const outPath = path.join(project, config.src + ".js");

	const t0 = Date.now();
	await buildBundle({ outPath, plumeHash, wasmBase64, engineFiles, libs, binaryPaths });

	const size = fs.statSync(outPath).size;
	console.log(
		`plumeWebStatic: wrote ${outPath} (${(size / 1048576).toFixed(2)} MB, ` +
		`engine ${plumeHash}, ${Object.keys(engineFiles).length} engine files, ` +
		`${Object.keys(libs).length} dependency files (${binaryPaths.length} binary), ` +
		`${((Date.now() - t0) / 1000).toFixed(1)} s)`
	);
}
