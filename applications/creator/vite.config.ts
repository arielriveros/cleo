import { defineConfig, mergeConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import engineConfig from '../../vite.config'
import { appKitAlias } from '../app-kit/vite.preset'

const ENGINE_ROOT = path.resolve(__dirname, '../..')

// Cleo Creator compiles the engine from SOURCE through the shared engine config (the `cleo` alias and
// the shader plugin, which also turns the creator's own .wgsl compute kernels into modules), exactly as
// the editor does. Everything below is Creator-specific.
export default mergeConfig(engineConfig, defineConfig({
  base: '/',
  resolve: { alias: appKitAlias },
  plugins: [react()],
  server: {
    // The editor owns 8080; a fixed second port so both can run side by side.
    port: 8081,
    strictPort: true,
    fs: { allow: [ENGINE_ROOT] },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 8_000,
  },
}))
