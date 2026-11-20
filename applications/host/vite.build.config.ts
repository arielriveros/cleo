import { defineConfig, mergeConfig } from 'vite';
import { builtinModules } from 'node:module';
import base from './vite.config';

// The published host: cleo-host and cleo-allocator built into single Node files (dist/), the engine, the player's
// loader and everything else of ours inside them. npm packages stay outside — chiefly the WebTransport addon,
// which is native — and are installed beside them from package.json (docs/design/netsync.md §7.2).
const external = [
    '@fails-components/webtransport', '@fails-components/webtransport-transport-http3-quiche', '@peculiar/x509',
    'reflect-metadata', 'ws',
];

export default mergeConfig(base, defineConfig({
    build: {
        ssr: true,
        target: 'node22',
        outDir: 'dist',
        emptyOutDir: true,
        sourcemap: true,
        minify: false,
        rollupOptions: {
            input: { 'cleo-host': 'src/main.ts', 'cleo-allocator': 'src/allocator/main.ts' },
            external: (id) => external.some((e) => id === e || id.startsWith(`${e}/`)) || builtinModules.includes(id) || id.startsWith('node:'),
            output: { format: 'es', entryFileNames: '[name].mjs', chunkFileNames: 'chunks/[name]-[hash].mjs' },
        },
    },
    ssr: { noExternal: true, target: 'node' },
}));
