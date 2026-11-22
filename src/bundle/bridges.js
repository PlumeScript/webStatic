// Bridges wasmoon ↔ Plume (code de référence validé 21/11).
//
// Contraintes wasmoon respectées (vérifiées, à ne pas casser) :
// - un callback JS ne renvoie QUE des primitives (string/number/boolean) —
//   jamais d'objet/tableau, jamais null (sentinelles __MISS__/__ABSENT__/__EOF__) ;
// - futf8.read : contenu normalisé LF (contrat moteur) ;
// - lfs.dir : dossier absent → itérateur vide, ne PAS throw ;
//   lfs.attributes : absent → nil ;
// - io.open : :read("*a") une seule fois (ensuite nil), :write, :close ;
// - NE JAMAIS interpoler le source plume dans une string Lua :
//   passer par lua.global.set("__src", source).
//
// Fichiers binaires (polices, images) : embarqués en base64 ASCII dans la VFS
// (le pont string JS↔Lua est UTF-8 NUL-terminé — un binaire brut y serait
// tronqué, cf. patch lua_pushlstring dans build.js). Le décodage se fait
// côté Lua : vfsIsBinary(p) dit quels paths sont binaires, b64decode()
// décode dans le wrapper io.open à la lecture.

export class VFS {
	constructor() { this.files = new Map(); }
	add(p, c) { this.files.set(p, c.replace(/\r\n/g, "\n")); }
	write(p, c) { this.files.set(p, c.replace(/\r\n/g, "\n")); }
	exists(p) { return this.files.has(p); }
	read(p) { return this.files.has(p) ? this.files.get(p) : null; }
	isDir(p) { const pre = p + "/"; for (const k of this.files.keys()) if (k.startsWith(pre)) return true; return false; }
	list(p) {
		const pre = p ? p.replace(/\/$/, "") + "/" : "";
		const set = new Set();
		for (const k of this.files.keys()) if (k.startsWith(pre)) {
			const rest = k.slice(pre.length), i = rest.indexOf("/");
			set.add(i === -1 ? rest : rest.slice(0, i));
		}
		return [...set];
	}
}

export async function installBridges(lua, vfs, binary = new Set()) {
	lua.global.set("vfsExists", (p) => (vfs.exists(p) ? "1" : "__MISS__"));
	lua.global.set("vfsIsBinary", (p) => (binary.has(p) ? 1 : 0));
	lua.global.set("vfsRead", (p) => { const r = vfs.read(p); return r === null ? "__MISS__" : r; });
	lua.global.set("vfsList", (p) => "\n" + vfs.list(p).join("\n"));
	lua.global.set("vfsStat", (p) => (vfs.exists(p) || vfs.isDir(p))
		? (vfs.isDir(p) ? "directory" : "file") + "|" + (vfs.read(p)?.length ?? 0)
		: "__ABSENT__");
	lua.global.set("vfsCurrentdir", () => "");
	const handles = new Map(); let next = 1;
	lua.global.set("ioOpen", (p, mode) => {
		if (!/^[wa]/.test(mode || "r")) {
			if (!vfs.exists(p)) return -1;
			handles.set(next, { p, data: vfs.read(p), consumed: false }); return next++;
		}
		handles.set(next, { p, buf: "" }); return next++;
	});
	lua.global.set("ioRead", (id) => {
		const h = handles.get(id);
		if (!h || h.consumed) return "__EOF__";
		h.consumed = true; return h.data;
	});
	lua.global.set("ioWrite", (id, s) => { const h = handles.get(id); if (h) h.buf += String(s); });
	lua.global.set("ioClose", (id) => {
		const h = handles.get(id);
		if (h && h.buf !== undefined) vfs.write(h.p, h.buf);
		handles.delete(id);
	});
	await lua.doString(`
-- package.loaded["lfs"] AVANT le require du moteur : engine/std/path.lua
-- fait pcall(require, "lfs") au chargement et mémorise l'issue (lfsLoaded).
package.loaded["lfs"] = {
	currentdir = vfsCurrentdir,
	dir = function (p)
		local entries = {}
		for name in vfsList(p):gmatch("[^\\n]+") do table.insert(entries, name) end
		local i = 0
		return function () i = i + 1 return entries[i] end
	end,
	attributes = function (p)
		local raw = vfsStat(p)
		if raw == "__ABSENT__" then return nil end
		local mode, size = raw:match("^(.-)|(%d+)$")
		return { mode = mode, size = tonumber(size) }
	end,
	mkdir = function () return true end,
	rmdir = function () return true end,
}
plume = require "plume-data/engine/init"
plume.config = { color = "never", errorStyle = "plain" }
-- La chaîne de compat wasmoon (plume-data/compat/wasmoon/lfs.lua) réassigne
-- le global lfs au chargement : on ré-applique les overrides APRÈS le require.
lfs = package.loaded["lfs"]
-- compat bit.bor attend 3 args (a | b | c) ; les deps l'appellent à 2 args
-- (ex. pages/utils/base64) : variadique pour les deux.
bit.bor = function (...)
	local a, b, c = ...
	if c == nil then return a | b end
	return a | b | c
end
package.loaded["bit"] = bit -- require("bit") des blocs lua.eval (ex. pages/utils/base64)
-- Decodage base64 (Lua 5.4, opérateurs bit) : les fichiers binaires de la
-- VFS sont embarqués en base64, décodés ici à la lecture par le wrapper
-- io.open. Le padding "=" (Node en met toujours, longueur multiple de 4)
-- est compté et exclu avant la boucle.
local B64I = {}
do
	local chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	for i = 1, #chars do B64I[chars:sub(i, i)] = i - 1 end
end
function b64decode(s)
	local out = {}
	local n = #s
	local pad = 0
	if s:sub(n, n) == "=" then
		pad = 1
		if s:sub(n - 1, n - 1) == "=" then pad = 2 end
		n = n - pad
	end
	local i = 1
	while i + 3 <= n do
		local a, b, c, d = B64I[s:sub(i, i)], B64I[s:sub(i + 1, i + 1)], B64I[s:sub(i + 2, i + 2)], B64I[s:sub(i + 3, i + 3)]
		out[#out + 1] = string.char(a << 2 | b >> 4, (b & 15) << 4 | c >> 2, (c & 3) << 6 | d)
		i = i + 4
	end
	local rem = n - i + 1
	if rem == 2 then
		local a, b = B64I[s:sub(i, i)], B64I[s:sub(i + 1, i + 1)]
		out[#out + 1] = string.char(a << 2 | b >> 4)
	elseif rem == 3 then
		local a, b, c = B64I[s:sub(i, i)], B64I[s:sub(i + 1, i + 1)], B64I[s:sub(i + 2, i + 2)]
		out[#out + 1] = string.char(a << 2 | b >> 4)
		out[#out + 1] = string.char((b & 15) << 4 | c >> 2)
	end
	return table.concat(out)
end
io.open = function (p, mode)
	local id = ioOpen(p, mode)
	if id < 0 then return nil end
	local h = { id = id, p = p }
	function h:read()
		local r = ioRead(self.id)
		if r == "__EOF__" then return nil end
		if vfsIsBinary(self.p) == 1 then r = b64decode(r) end
		return r
	end
	function h:write(s) ioWrite(self.id, s) end
	function h:close() ioClose(self.id) end
	return h
end
futf8 = {
	exists = function (p) return vfsExists(p) ~= "__MISS__" end,
	read   = function (p)
		local r = vfsRead(p)
		return r == "__MISS__" and nil or r
	end
}
local origGetenv = os.getenv
os.getenv = function (k)
	if k == "PLUME_PATH" then return "libs" end
	return origGetenv and origGetenv(k) or nil
end
`);
}

export async function exec(lua, source, name = "gen.plume") {
	lua.global.set("__src", source);
	lua.global.set("__name", name);
	return await lua.doString(`
local ok, success, res = pcall(plume.executeString, __src, __name, nil, nil, {errorStyle="plain", color="never"}, true)
local body = (ok and success and type(res) == "string") and res or tostring(res)
return body
`);
}
