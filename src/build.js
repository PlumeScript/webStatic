// Construction du bundle : module data.js virtuel (wasm base64 + fichiers du
// moteur + libs) + esbuild IIFE (pas d'ESM, pas d'externals).

import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

// --- Patch build-time de wasmoon (glue emscripten) -------------------------
// pushValue() convertit string JS → Lua via `lua_pushstring` (C string
// NUL-terminée) : tout contenu binaire (polices, images) lu via les bridges
// serait tronqué au premier octet nul. Patch : si la string contient un NUL,
// encoder UTF-8, copier dans la mémoire wasm, `lua_pushlstring` (avec longeur),
// libérer. Chemin sans NUL inchangé (pushValue d'origine).
const WASMOON_STRING_NEEDLE = [
	"                case 'string':",
	"                    this.lua.lua_pushstring(this.address, target);",
	"                    break;",
].join("\n");
const WASMOON_STRING_PATCH = [
	"                case 'string':",
	"                    if (target.indexOf('\\0') === -1) {",
	"                        this.lua.lua_pushstring(this.address, target);",
	"                    } else {",
	"                        const __bytes = new TextEncoder().encode(target);",
	"                        const __mod = this.lua.module;",
	"                        const __ptr = __mod._malloc(__bytes.length);",
	"                        __mod.HEAPU8.set(__bytes, __ptr);",
	"                        __mod.ccall('lua_pushlstring', null, ['number', 'number', 'number'], [this.address, __ptr, __bytes.length]);",
	"                        __mod._free(__ptr);",
	"                    }",
	"                    break;",
].join("\n");

const wasmoonNulPatch = {
	name: "wasmoon-nul-string-patch",
	setup(build) {
		build.onLoad({ filter: /wasmoon[\/\\]dist[\/\\]index\.js$/ }, (args) => {
			let code = fs.readFileSync(args.path, "utf8");
			if (!code.includes(WASMOON_STRING_NEEDLE)) {
				throw new Error("wasmoon patch: pushValue string case not found (wasmoon a changé ?)");
			}
			code = code.replace(WASMOON_STRING_NEEDLE, WASMOON_STRING_PATCH);
			return { contents: code, loader: "js" };
		});
	},
};

export function readWasmBase64() {
	const wasmPath = require.resolve("wasmoon/dist/glue.wasm");
	return fs.readFileSync(wasmPath).toString("base64");
}

export async function buildBundle({ outPath, plumeHash, wasmBase64, engineFiles, libs, binaryPaths = [] }) {
	const mainJs = path.join(ROOT, "src", "bundle", "main.js");

	// data.js généré au build : les données arrivent dans le bundle par ici.
	const dataSource =
		`export const wasmBase64 = ${JSON.stringify(wasmBase64)};\n` +
		`export const engineFiles = ${JSON.stringify(engineFiles)};\n` +
		`export const libs = ${JSON.stringify(libs)};\n` +
		`export const binaryPaths = ${JSON.stringify(binaryPaths)};\n`;

	const dataPlugin = {
		name: "plume-web-static-data",
		setup(build) {
			build.onResolve({ filter: /^\.\/data\.js$/ }, (args) => {
				if (path.resolve(args.importer) === path.resolve(mainJs)) {
					return { path: "data.js", namespace: "pwstatic" };
				}
				return null;
			});
			build.onLoad({ filter: /.*/, namespace: "pwstatic" }, () => ({
				contents: dataSource,
				loader: "js",
			}));
		},
	};

	const date = new Date().toISOString();
	const bannerJs =
		`/* plumeWebStatic — plume engine ${plumeHash} — generated ${date} */\n` +
		`// Contexte node (ESM, sans require) : la glue emscripten a besoin d'un\n` +
		`// global location pour éviter require("url") — le navigateur est\n` +
		// inchangé (document y est défini).
		`// eslint-disable-next-line no-undef\n` +
		`if (typeof document === "undefined" && typeof location === "undefined" && typeof process !== "undefined" && process.versions && process.versions.node) {\n` +
		`\tglobalThis.location = { href: process.platform === "win32" ? "file:///C:/" : "file:///" };\n` +
		`}\n`;

	await esbuild.build({
		entryPoints: [mainJs],
		bundle: true,
		format: "iife",
		// "node" : les builtins node (url, module) de la glue emscripten
		// restent externes — ils ne sont jamais appelés en navigateur
		// (branche gardée par des typeof), et fonctionnent nativement en node.
		platform: "node",
		outfile: outPath,
		plugins: [dataPlugin, wasmoonNulPatch],
		banner: { js: bannerJs },
		logLevel: "silent",
	});
}
