# Docs media

The screenshots and GIFs in `docs/media/` come from the bundled **Valley** example and its **Dungeon**
scene. They were captured from the editor and from Play on WebGPU, plus two from the Foliage Creator.
This folder is the tool that retakes them.

| File | What | Where it is used |
|---|---|---|
| `valley-hero.jpg` | The knight in the village, in Play | docs/README.md |
| `valley-run.gif` | Running down the village road, in Play | docs/README.md gallery |
| `dungeon-torches.jpg`, `dungeon-run.gif` | The Dungeon in Play | editor/rendering.md, gallery |
| `editor-overview.jpg` | The editor with the Valley open | editor/interface.md, gallery |
| `landscape-editor.jpg` | Landscape mode | editor/terrain.md, gallery |
| `foliage-material.jpg` | A Valley grass material's foliage sections | editor/models-and-materials.md |
| `debug-views.jpg` | Final / Albedo / Normal / Cascades, 2×2 | editor/rendering.md, gallery |
| `creator-foliage.jpg` | The Foliage Creator on the Oak preset | creator/foliage.md |
| `foliage-walkthrough.gif` | The Creator's Walk-through on a grass patch | models-and-materials.md, creator/foliage.md, gallery |

## Running it

```
npm run docs:media        # node tools/docsMedia/run.cjs
```

The script starts private editor (8090) and Creator (8091) dev servers. It never touches your own
8080/8081. It then opens Chrome with a profile of its own (`%TEMP%\cleo-docs-media-chrome`), drives the
page over the DevTools protocol, and listens on `127.0.0.1:8095`.

| Endpoint | What it does |
|---|---|
| `POST /eval` | Runs the body in the page, with `prelude.js`'s helpers in scope. Returns the result as JSON. |
| `POST /shot?out=F[&crop=x,y,w,h]` | Takes a page screenshot. |
| `POST /record?dir=D&seconds=S` | Records a screencast: JPEG frames plus `frames.json` (frame times). |
| `POST /canvas?out=F` | Reads the engine canvas at its full render size. Unreliable on WebGPU: see below. |
| `POST /reload` | Reloads the page. |
| `POST /quit` | Stops the dev servers, Chrome and the script. |

`encode.mjs` turns the captures into the final files:
- `gif <framesDir> <out.gif>` resamples a recording to a steady fps, then crops, scales and builds a two-pass palette (ffmpeg).
- `png` crops and scales.

The JPEGs were saved with Pillow at quality 88 and 1280 px wide.

## Taking the shots

1. **Install the Valley once.** It persists in the capture profile:
   ```
   curl -X POST 127.0.0.1:8095/eval -d "localStorage.setItem('cleo_renderer_backend','webgpu');
     const ex = await import('/src/utils/examples.ts'); const e = (await ex.loadExampleIndex()).find(x => x.slug === 'valley');
     setTimeout(() => ex.importExample(e, undefined, true), 0)"
   ```
   Then wait for the boot to settle: `loadState()` in prelude.js lists the boot steps, and none is pending once it has.
2. **Clean editor views.** Turn the debug overlays off through `cleo_debug_visibility_v1` in localStorage (colliders, triggers, icons, grid), then reload.
3. **Editor shots** are page screenshots:
   - `lookAt(pos, target)`, `orbit(...)` and `groundAt(x, z)` place the editor camera;
   - `press(...)` and `editorTab(...)` switch modes and tabs;
   - `openAsset(name)` opens a material or a scene;
   - `renderer().debugView` gives the channel views. Crop to the viewport, `321,100,879,548`.
4. **Gameplay shots and GIFs** follow the same steps each time:
   1. `click('Play')`, then wait about 15 s.
   2. `fullscreenViewport(true)` pins the viewport over the window, once per session.
   3. Move with `keyDown('KeyW')` / `key('Space')`.
   4. Take a `/shot` with `crop=0,60,1600,840`, or a `/record`.

   The Valley GIF holds W for 5.5 s from spawn. The Dungeon one holds W for 5 s with a roll at 2.2 s.
5. **The Dungeon:** run `openAsset('Dungeon')` in the editor, then Play it. Do not `Game.loadScene` it from a playing Valley: see below.
6. **The Creator:** navigate the page to `/creator/`, then:
   1. Pick Tree ▸ Oak and zoom with wheel events on the canvas.
   2. For the GIF, pick Grass, turn on Walk-through, and tilt the orbit with a mouse drag.
   3. `/record` 8 s.
   4. Crop `281,110,980,546`.

## Known traps

- **Electron 31** (the desktop shell's) loses the WebGPU device as soon as the Valley enters Play: D3D12 `CreateCommittedResource` runs out of memory. The editor's **WebGL2** path does not compile the cloud shader (`u_volume` redefinition). Hence Chrome on WebGPU.
- Even in Chrome, the **Valley is near the edge**. Three things lost the device or crashed the tab:
  - resizing the viewport repeatedly;
  - setting the Time of Day to night in Play (it re-bakes the sky);
  - loading the Dungeon on top of a playing Valley.

  Reload between sessions, and keep each session to one fullscreen resize. There is no night shot for that reason.
- A **page screenshot per frame** takes about 0.8 s at this size. GIFs come from `Page.startScreencast`, which runs at about 23 fps.
- Reading a **WebGPU canvas** with `toDataURL` comes back black unless it lands in the task that presented the frame. Page screenshots avoid this.
- **The editor camera:** forward is +Z, yaw = `atan2(dx, dz)`, and +pitch looks down. A camera placed without `groundAt` can end up inside a hill.
