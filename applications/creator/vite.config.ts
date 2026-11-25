import { defineConfig, mergeConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import engineConfig from '../../vite.config'
import { appKitAlias, crossOriginIsolationPlugin, nagaAssetsPlugin } from '../app-kit/vite.preset'
import { floorSetsPlugin } from './vite.floors'
import { buildVersionDefines } from '../editor/buildVersion'

const ENGINE_ROOT = path.resolve(__dirname, '../..')

// Cleo Creator compiles the engine from SOURCE through the shared engine config (the `cleo` alias and
// the shader plugin, which also turns the creator's own .wgsl compute kernels into modules), exactly as
// the editor does. Everything below is Creator-specific.
//
// Two ways to be served, and so two builds:
//   - EMBEDDED (the default): UNDER the editor's origin, at /creator/. The editor's dev server proxies it, its
//     build lands in the editor's dist/creator, and the desktop shell serves both over app://editor. One origin is
//     what lets the two share the Creator library (app-kit creatorLibrary: IndexedDB + a BroadcastChannel), so an
//     asset saved here shows up live in the editor.
//   - WEB (`--mode web`, npm run build:web): its own site at its root (creator.cleoengine.com), built into dist/.
//     The library is the editor's still: the Creator reaches it through a hidden frame of the editor's origin
//     (creatorLibrary/frame.ts), named by VITE_CLEO_EDITOR_ORIGIN. release.yml deploys this one.
// `--mode standalone` builds a self-contained dist/ under /creator/.
export default defineConfig(({ mode }) => mergeConfig(engineConfig, {
  base: mode === 'web' ? '/' : '/creator/',
  // The product version, as the editor reads it (src/version.ts): Help ▸ About shows it.
  define: buildVersionDefines(),
  resolve: { alias: appKitAlias },
  // The same isolation as the editor, whose origin this is served on (see crossOriginIsolation).
  // The stage floors' PBR sets (build/terrain_textures): served in dev, copied into the build.
  // naga (GLSL -> WGSL) for the World's water material on WebGPU, under /creator/naga/.
  plugins: [
    crossOriginIsolationPlugin(), react(),
    floorSetsPlugin(path.join(ENGINE_ROOT, 'build', 'terrain_textures'), mode === 'web' ? '/' : '/creator/'),
    nagaAssetsPlugin(mode === 'web' ? '/' : '/creator/'),
  ],
  server: {
    // The editor owns 8080; a fixed second port so both can run side by side.
    port: 8081,
    strictPort: true,
    // Opened through the editor (http://localhost:8080/creator/) the page's origin is the editor's, but its
    // HMR socket still goes straight to this server.
    cors: true,
    fs: { allow: [ENGINE_ROOT] },
  },
  // The FX live preview's CPU solver is an ES-module worker (fx/liveSim.ts passes { type: 'module' });
  // this keeps dev and build agreed on that. It imports no shaders, so no plugins are repeated here.
  worker: { format: 'es' },
  build: {
    outDir: mode === 'standalone' || mode === 'web' ? 'dist' : '../editor/dist/creator',
    emptyOutDir: true,
    chunkSizeWarningLimit: 8_000,
  },
}))
