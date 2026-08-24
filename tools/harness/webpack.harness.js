// Bundle for the WebGPU device harness.
//
// Separate from the engine's own webpack config for one reason: the harness must import engine
// INTERNALS — `rhi/webgpu/webgpuDevice` is not exported from `src/cleo.ts` and should not be, since
// nothing above the RHI is allowed to know which backend it has. A second entry on the main config
// would also inherit `library: 'cleo'` and `output.clean`, either of which would make the harness a
// part of the shipped bundle by accident.
//
// It reuses the same loaders on purpose, so a `.wgsl` import here goes through exactly the loader the
// engine ships with. A harness that hand-composed its shaders would prove the driver works and nothing
// about our toolchain.
const path = require('path');

const repo = path.resolve(__dirname, '..', '..');

module.exports = {
    mode: 'development',
    // `eval` devtool wraps modules in eval() strings, which the harness page's CSP-free but
    // secure-context `app://` origin refuses. Inline source maps keep stack traces readable instead.
    devtool: 'inline-source-map',
    entry: path.resolve(__dirname, 'pages/webgpu/entry.ts'),
    output: {
        path: path.resolve(__dirname, 'pages/webgpu'),
        filename: 'bundle.js',
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                loader: 'ts-loader',
                // The harness lives outside the engine's tsconfig, and its job is to exercise the
                // device at runtime rather than to be a second type gate.
                //
                // This used to say `npm run typecheck` covers everything it imports. It did not:
                // tsconfig starts from `src/cleo.ts` and nothing shipped imports the WebGPU backend,
                // so that file was checked by nothing. It is named in tsconfig `files` now — keep it
                // there, because transpileOnly will not catch a missing import for you.
                options: { transpileOnly: true },
            },
            { test: /\.glsl|vs|fs$/, exclude: /node_modules/, loader: 'ts-shader-loader' },
            { test: /\.wgsl$/, exclude: /node_modules/, loader: path.resolve(repo, 'tools/wgslLoader.mjs') },
        ],
    },
    resolve: {
        extensions: ['.ts', '.js'],
        fallback: { fs: false, path: false, crypto: false },
    },
};
