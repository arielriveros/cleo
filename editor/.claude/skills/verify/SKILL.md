---
name: verify
description: Build, run and drive the Cleo editor in a headless browser to observe a change end-to-end. Use when verifying editor/ changes at their real surface (the GUI), not via tests.
---

# Verifying an editor change

The editor's surface is **pixels in a browser**. Drive it with Playwright and screenshot; there is no
CLI or API to hit.

## Handle

```bash
cd editor && npx webpack serve --port 8098 > /tmp/cleo-dev.log 2>&1   # background it
until grep -qa "compiled successfully" /tmp/cleo-dev.log; do sleep 3; done
```

First compile is **~40-90s** (the bundle pulls in `../dist/cleo.js`, monaco workers and the player).
`curl localhost:8098` returning 200 only means the server is up — wait for the *compile* line.

Playwright is **not** a dependency. Install it in a scratch dir, never in `editor/`:

```bash
cd <scratchpad> && npm init -y && npm install playwright && npx playwright install chromium
```

Launch needs software GL — the editor will not boot without a WebGL2 context:

```js
chromium.launch({ headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
```

Then `await page.waitForTimeout(12000)` after `goto` — `setupInitialScene` preloads textures and parses
the scene behind a LoadingScreen, and nothing is interactable until `isSceneReady`.

## Gotchas that cost real time

- **Two `console.error`s about `Error creating texture: 1286` are normal** under swiftshader. Ignore.
- **Editing source while driving corrupts the dev server.** Many rapid HMR rebuilds eventually produce a
  bogus `Module parse failed` in an untouched dependency (seen in `cannon-es`). Restart the server —
  it is not your change.
- **Each non-persistent context starts with an empty IndexedDB**, so the project resets to one "Main"
  scene every run. That is a *feature* for isolation; for reload/persistence checks use
  `chromium.launchPersistentContext('./profile', ...)`.
- **`node script.mjs` stdout can get lost** when backgrounded. Write results with `fs.writeFileSync`
  to a file and `cat` it.

## Selectors that work

The UI is Tailwind-generated, so class selectors are brittle. These held up:

| Thing | Selector |
|---|---|
| Document tabs | `div.group.flex.items-center.gap-1` (title in `span.truncate`) |
| Unsaved dot | `span[title="Unsaved changes"]` inside a tab |
| Close tab ✕ | `button[title="Close tab"]` inside a tab |
| Save (active tab) | `button[title*="Ctrl+S"]` |
| Save All | `button[title="Save every asset with unsaved changes"]` |
| Scene tree rows | `.scene-item` (`.first()` is the root row) |
| Material name field | `div:has(> label:text-is("Material name")) > input` |

**Do not** use bare `page.locator('input[type=text]').first()` — it grabs the **Logger filter box** in the
bottom dock and your "rename" silently goes nowhere. Anchor inputs to their `<label>`.
`getByText('Material')` matches **"Terrain Material"** too — always pass `{ exact: true }`.

## Driving

- Create assets: click the **Assets** dock tab → `button:has-text("Add")` → `getByText('<Kind>', {exact:true})`.
- Add a node: **select a tree row first**. `AddNew.onAdd` opens with `if (!selectedNodeObj) return`, and
  returning to the scene tab emits `SELECT_NODE null` — so the Add buttons silently no-op with nothing
  selected. On a fresh load the root is auto-selected, which masks this.

## Tracing a false-dirty

`SCENE_CHANGED` is global and names no scene, so `mark()` in `EngineContext` can only blame the *active*
tab. When something dirties a tab unexpectedly, drop a temporary trace in `mark()` and read the stack —
it names the culprit immediately:

```js
if (!dirtyTabsRef.current[activeTabIdRef.current]) console.warn('DIRTY-TRACE', new Error().stack);
```

Editor chrome that lives in the scene (gizmo nodes, `__editor__` helper icons, preview-scene
construction) emits `SCENE_CHANGED` exactly like a user edit and must be wrapped in `withoutDirty(...)`
or run while `dirtyArmedRef` is false. `SCENE_CHANGED` is also used as a plain **re-render nudge** in
places that change nothing (e.g. `DockLayout`'s panel-visibility sync) — those need `withoutDirty` too.

Watch the effect ordering: React runs a **child's** effects before its parent's, so a child cleanup that
touches the scene on tab switch (`PositionGizmo`'s effect keys on `editorScene`) fires while
`activeTabIdRef` still points at the **outgoing** tab — which is what gets blamed.

## Reading the viewport's actual colours

To prove a material really reached the renderer, sample pixels — `npm install pngjs`, then
`page.screenshot({ clip })` over the viewport centre and pick the most-saturated pixel.

**Select the root row first.** The transform gizmo's pure red/green/blue arrows sit exactly over the
origin and are the most saturated thing on screen, so they, not your object, are what you measure.
`show = !!selectedNodeId && !isRootNode` — selecting the root hides them.

Always confirm the sampler is discriminating (set the material red, assert RED) before trusting a
green/pass. And to prove a *fix* is the cause, disable it, re-run, and watch the bug come back.
