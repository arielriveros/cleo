import { defineConfig, mergeConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import engineConfig from '../../vite.config'
import { appKitAlias } from '../app-kit/vite.preset'

const ENGINE_ROOT = path.resolve(__dirname, '../..')

// Cleo Creator compiles the engine from SOURCE through the shared engine config (the `cleo` alias and
// the shader plugin, which also turns the creator's own .wgsl compute kernels into modules), exactly as
// the editor does. Everything below is Creator-specific.
// The Creator is served UNDER the editor's origin, at /creator/: the editor's dev server proxies it, its
// build lands in the editor's dist/creator, and the desktop shell serves both over app://editor. One
// origin is what lets the two share the Creator library (app-kit creatorLibrary: IndexedDB + a
// BroadcastChannel), so an asset saved here shows up live in the editor. `--mode standalone` builds a
// self-contained dist/ instead.
export default defineConfig(({ mode }) => mergeConfig(engineConfig, {
  base: '/creator/',
  resolve: { alias: appKitAlias },
  plugins: [react()],
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
    outDir: mode === 'standalone' ? 'dist' : '../editor/dist/creator',
    emptyOutDir: true,
    chunkSizeWarningLimit: 8_000,
  },
}))
