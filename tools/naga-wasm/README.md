# cleo-naga-wasm

naga, compiled to WebAssembly, so the engine can translate shaders in the browser.

## Why this exists

There is no shippable naga WASM build to depend on. The only one published to npm is
`wasm-naga@0.3.2` (2022-05-24, unmaintained): its GLSL frontend rejects `precision` and `layout`, and
it has no WGSL backend at all. `naga`, `naga-wasm`, `naga-oil`, `@gfx-rs/naga` on npm are either
unrelated name squats or do not exist. So we build and vendor it.

## What it exports

| Function | Direction | Status |
|---|---|---|
| `wgsl_to_glsl(source, stage, entryPoint)` | WGSL → GLSL ES 300 (WebGL2) | **Works.** This is the path wgpu itself uses for its WebGL2 backend, and naga's most exercised combination. |
| `glsl_to_wgsl(source, stage)` | GLSL → WGSL | Works only for *Vulkan-flavoured* GLSL. It cannot read the OpenGL ES dialect this engine writes — see below. |
| `naga_version()` | — | Provenance of the vendored artifact. |

### The GLSL frontend cannot read our shaders

Measured against all 62 engine shaders and then isolated construct by construct (see
`WEBGPU_ROADMAP.md`, M3). naga's GLSL frontend is *Vulkan* GLSL:

- accepts only desktop `#version 440/450/460` — every ES profile (`300 es`, `310 es`, `320 es`) is
  rejected outright;
- does not implement `precision` qualifiers;
- requires explicit `layout(location=)` on every varying and `layout(binding=)` on every uniform;
- **has no combined sampler types at all.** `sampler2D`, `samplerCube`, `sampler2DArrayShadow` are not
  in its type table (`naga/src/front/glsl/types.rs` knows `sampler`, `samplerShadow`, `texture2D`, …).
  Only the separate Vulkan-style `texture2D` + `sampler` pair parses.

That last point is not a shim away: it would mean rewriting every sampling call in 4,595 lines of
engine GLSL *and* in user-authored custom materials.

Its GLSL **backend** emits precisely the dialect we want, combined samplers and all.

## Building

Needs a Rust toolchain with the wasm target, and a `wasm-bindgen` CLI matching the `wasm-bindgen`
version in `Cargo.lock` (currently 0.2.127 — a mismatch fails loudly at bindgen time, which is the
intended behaviour).

    rustup target add wasm32-unknown-unknown
    npm run naga:build

The GNU host toolchain (`x86_64-pc-windows-gnu`) is preferred on Windows: proc-macro crates compile for
the host, so a host linker is required, and the GNU toolchain bundles one rather than pulling in
multi-gigabyte MSVC build tools.

Output is vendored to `src/graphics/rhi/webgpu/naga/` and committed, so a normal `npm run build` never
needs Rust.

## Version pinning

Pinned to naga **29.0.4**. naga 30.0.1 (published 2026-08-22) does not compile its own `glsl-in`
feature — `Binding::apply_default_interpolation` is missing — with or without default features. Re-test
on the next 30.x before moving.

## Size

| Features | Artifact |
|---|---|
| `wgsl-in` + `glsl-out` (the working direction only) | 1.04 MB |
| all four directions | 1.42 MB |

Only the second is vendored today, because which directions we ship is still an open decision. If the
engine settles on WGSL-as-source, drop `glsl-in`/`wgsl-out` and take the 0.38 MB back.
