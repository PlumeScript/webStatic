// Entrée du bundle plumeWebStatic (IIFE, esbuild au moment de la génération).
//
// Expose globalThis.plume = { ready, execute } :
//   plume.ready   : Promise — résout après init wasm + montage + bridges
//                   (rejette avec une erreur lisible si problème d'init) ;
//   plume.execute : (source, name?) => Promise<string> — résout TOUJOURS à une
//                   string : le HTML produit en cas de succès, ou la box
//                   d'erreur du moteur (plain, sans couleur) en cas d'erreur
//                   plume. Ne rejette pas sur erreur plume.
//
// Contraintes : pas de fetch, pas de réseau, pas de DOM (hors globalThis /
// performance). Fonctionne en navigateur (file://) et en node (tests).
// Le wasm est embarqué en base64 : en navigateur, `new LuaFactory` reçoit
// l'URL data: (TOUJOURS surcharger le 1er argument — par défaut wasmoon
// téléchargera le wasm depuis unpkg) ; en node, la glue emscripten lit le
// wasm via fs, donc le base64 est écrit dans un fichier temporaire (init).

import { LuaFactory } from "wasmoon";
import { wasmBase64, engineFiles, libs, binaryPaths } from "./data.js";
import { VFS, installBridges, exec } from "./bridges.js";

let lua = null;
let vfs = null;

const isBrowser = typeof window !== "undefined" && typeof window.document !== "undefined";

const ready = (async () => {
	// Navigateur : data: URL (fetch, fonctionne en file://). Node (tests) : la
	// glue emscripten lit le wasm via fs — on écrit le base64 dans un fichier
	// temporaire pour la durée de l'init.
	let wasmLocation = "data:application/wasm;base64," + wasmBase64;
	let tmpWasm = null;
	if (!isBrowser) {
		const fs = await import("node:fs");
		const os = await import("node:os");
		const path = await import("node:path");
		tmpWasm = path.join(os.tmpdir(), `pwstatic-${process.pid}-${Date.now()}.wasm`);
		fs.writeFileSync(tmpWasm, Buffer.from(wasmBase64, "base64"));
		wasmLocation = tmpWasm;
	}
	try {
		const factory = new LuaFactory(wasmLocation);
		lua = await factory.createEngine(); // l'engine EST l'objet lua (global/doString)
		for (const p of Object.keys(engineFiles)) await factory.mountFile(p, engineFiles[p]);
		vfs = new VFS();
		for (const p of Object.keys(libs)) vfs.add(p, libs[p]);
		// binaryPaths = les vfsPaths contenus en base64 (fichiers binaires :
		// polices, images) — le décodage se fait côté Lua (voir bridges.js).
		await installBridges(lua, vfs, new Set(binaryPaths));
	} finally {
		if (tmpWasm) {
			try { (await import("node:fs")).rmSync(tmpWasm); } catch {}
		}
	}
})();

globalThis.plume = {
	ready,
	execute(source, name) {
		return ready.then(() => exec(lua, String(source), name));
	},
};
