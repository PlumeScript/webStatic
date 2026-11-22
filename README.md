# plumeWebStatic

CLI Node : lit `<monprojet>/config.json` et génère **un seul fichier**
`<monprojet>/<src>.js` (par défaut `plumeWebStatic.js`), 100 % autonome
(IIFE, esbuild, aucun external). Une page HTML du projet le charge en
`<script src="plumeWebStatic.js">` et exécute des scripts **Plume dans le
navigateur — sans serveur, sans réseau : la page fonctionne ouverte en
double-cliquant (`file://`)**.

Le bundle embarque :

- **wasmoon** (Lua 5.4 on wasm) + son wasm en base64 — instancié par
  `new LuaFactory("data:application/wasm;base64," + …)` (TOUJOURS surcharger
  le 1er argument, sinon wasmoon téléchargera le wasm depuis unpkg) ;
- le **moteur Plume** (les fichiers `.lua` git-tracked de `plume-data/` du
  repo Plume, montés sous `plume-data/…` via `factory.mountFile`) ;
- les **dépendances** du projet, embarquées sous `libs/<dep>/…` dans une VFS
  (Map JS) lue par les bridges ; les **fichiers binaires** (polices, images)
  y sont stockés en base64 (+33 % de taille) et décodés côté Lua
  (`b64decode` pur dans le wrapper `io.open`) — le pont string JS↔Lua étant
  NUL-terminé, un patch build-time est appliqué à la glue wasmoon
  (`lua_pushlstring` quand la string contient un NUL) ;
- les **bridges** (futf8 / lfs / io.open sur la VFS, patch `PLUME_PATH`) et
  l'API publique `globalThis.plume` (= `window.plume`).

## Installation

```sh
npm install
```

(dépendances de build : `wasmoon` 1.16.0 + `esbuild` — elles ne sont pas
nécessaires à l'exécution du fichier généré, seulement à sa génération.)

## Usage

```sh
plumeWebStatic monprojet        # depuis le parent, ou chemin absolu
node bin/plumeWebStatic.js monprojet
```

Re-runnable : écrase le fichier existant. L'en-tête du fichier généré porte le
hash court du repo Plume (`git rev-parse --short HEAD`) + la date de génération.

### `monprojet/config.json`

```json
{
	"dependencies": ["cqfd", "pages"],
	"src": "plumeWebStatic",
	"exclude": { "pages": ["repro/", "doc/", "lib/mathjax/"] }
}
```

- `dependencies` : noms Plume (comme dans `use pages`).
- `src` : stem du fichier généré (`monprojet/plumeWebStatic.js`).
- `exclude` (optionnel) : par dépendance, liste de sous-chemins relatifs à la
  racine de la dépendance (`/` final = dossier) à ne pas copier.

### Résolution des dépendances

Même règle que Plume (`plume.getFilenameFromPath`) : basedirs = répertoires de
l'env **`PLUME_PATH`** (séparée par `;`, **lue au moment de la commande**),
puis le **cwd** ; pour chaque basedir : `<base><dep>.plume` puis
`<base><dep>/init.plume` (et variantes `.🪶`) ; le premier fichier existant
gagne. Si c'est `init.plume` qui gagne, la dépendance est le **dossier** ;
sinon c'est un **fichier** (embarqué sous `libs/<dep>.plume`).

Seuls les fichiers **git-tracked** du repo résolu sont embarqués
(`git ls-files` — le gitignore de la dépendance est respecté), puis `exclude`
est appliqué.

> Les dépendances **transitives** ne sont pas résolues automatiquement :
> il faut les lister aussi. Ex. `pages` importe `html` et `css` — un
> projet qui utilise `pages` doit les déclarer :
> `"dependencies": ["cqfd", "pages", "html", "css"]`.

### Env

- `PLUME_REPO` : chemin du repo Plume (défaut `F:\Dropbox\proj\code\dev\plume\plume`).
- `PLUME_PATH` : lue au moment de la commande (ex. `F:\Dropbox\proj\code\dev\plume`).

## Exemple HTML

```html
<script src="plumeWebStatic.js"></script>
<script>
	let plumeScript = "use pages\n@Document\nblablabla\nend"
	plume.ready.then(() => plume.execute(plumeScript).then(html => {
		document.querySelector('#my-element').innerHTML = html
	}))
</script>
```

API :

- `plume.ready` : Promise — résout après init wasm + montage + bridges
  (rejette avec une erreur lisible si problème d'init).
- `plume.execute(source, name?)` : Promise qui résout **toujours** à une
  string — le HTML produit en cas de succès, ou la box d'erreur du moteur
  (plain, sans couleur) en cas d'erreur Plume. Ne rejette pas sur erreur Plume.

Voir `example/` : `config.json` (cqfd + pages + html + css, avec les excludes)
+ `index.html` (à double-cliquer après avoir généré le bundle).

## Limites

- **`file://` OK** (pas de serveur, pas de fetch, pas de DOM).
- Les pages générées par `pages` chargent **MathJax depuis le CDN jsdelivr**
  → internet requis pour rendre les formules (le reste du document fonctionne
  hors-ligne).
- Le bundle est **version-locké** (hash du repo Plume dans l'en-tête) :
  **relancer la commande** quand le moteur Plume évolue.
- **`exclude` pour alléger le bundle** : `pages` embarque ~106 Mo de fichiers
  git-tracked dont ~80 Mo d'artefacts générés `repro/`, ~19 Mo de MathJax
  local non utilisé, ~2,7 Mo de `doc/` et 2,7 Mo de `test.html` — les
  exclusions typiques sont `["repro/", "doc/", "lib/mathjax/"]` ; le bundle
  d'exemple fait alors ~11,2 Mo (wasm/wasmoon ~0,7 Mo + moteur ~1,4 Mo +
  `cqfd` ~3,4 Mo + `pages` net ~5,7 Mo dont 13 TTF + logo en base64 ~2,6 Mo).
  On peut pousser plus loin (ex. ajouter `"test.html"` aux excludes de
  `pages`).
- **Fichiers binaires** (polices, images) : stockés en base64 dans le bundle
  (+33 % de taille : ~2,6 Mo pour les polices de `pages` + logo) — mais ils
  passent intégralement : les `@font-face` data-URI de `pages` (FiraCode +
  Lora) sont pleins et les polices se rendent (décodage côté Lua, voir plus
  haut).

## Tests

```sh
npm test        # node --test test/e2e.test.js
```

E2E : fixture repo git de dépendance temporaire (fichiers trackés, dont un
binaire avec NUL, junk 1 Mo non tracké, dossier exclu), lancement du CLI,
asserts (taille, preuves gitignore/exclude), chargement du bundle en node,
`plume.ready` → `plume.execute` → HTML, round-trip binaire byte-exact via
`io.open` (base64 dans la VFS, décodé côté Lua), et le cas d'erreur (résout
avec la box d'erreur).
