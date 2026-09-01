const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const isProduction = process.env.NODE_ENV == 'production';

const config = {
    entry: {
        'cleo': path.resolve(__dirname, 'src/cleo.ts')
    },
    output: {
        path: path.resolve(__dirname, 'dist'),
        // Wipes everything in `dist` that this compilation did not emit — EXCEPT the .d.ts tree, which
        // webpack does not produce and must not delete.
        //
        // `build`/`build:dev` run `build:types` (tsc --emitDeclarationOnly) afterwards rather than
        // leaving declarations to ts-loader, which only emits for the modules webpack happens to
        // traverse: what survived that was a PARTIAL tree, 72 files where the source has 121. The editor
        // reads this tree for its script editor, so the missing half surfaced there as a wall of "Can't
        // resolve './core/base64.d.ts'" — pointing at the consumer rather than at the build.
        //
        // A full build may sweep them, because `build:types` runs immediately afterwards and rewrites the
        // tree -- which is also what clears declarations orphaned by a renamed or deleted source file.
        // `npm run watch` may NOT: it never runs build:types, so a bare sweep deleted all 126 on every
        // incremental rebuild and never put them back. One engine edit during `editor:dev` then pulled
        // the tree out from under the editor's dev server, which holds every one of those files in its
        // module graph as a raw import: "ENOENT: no such file or directory, open dist/version.d.ts",
        // and only a dev-server restart cleared it.
        clean: true, // narrowed to `{ keep: /\.d\.ts$/ }` under --watch; see the export at the bottom
        library: 'cleo',
        libraryTarget: 'umd',
        globalObject: 'this'
    },
    module: {
        rules: [
            {
                test: /\.(ts)$/,
                exclude: /node_modules/,
                loader: 'ts-loader'
            },
            {
                test: /\.glsl|vs|fs$/,
                exclude: /node_modules/,
                loader: 'ts-shader-loader'
              },
            {
                // WGSL is the engine's shader source; the loader translates it to GLSL ES 300 for the
                // WebGL2 backend at build time. See tools/wgslTranslate.mjs and WEBGPU_ROADMAP.md M3.
                test: /\.wgsl$/,
                exclude: /node_modules/,
                loader: path.resolve(__dirname, 'tools/wgslLoader.mjs')
              }
        ]
    },
    
    plugins: [
        new CopyWebpackPlugin({patterns: [ { from: 'package.json', to: './' } ]}),
    ],
    resolve: {
        extensions: ['.ts', '.js'],
        alias: {},
        fallback: {
            "fs": false,
            "path": false,
            "crypto": false
          } 
    },
    devtool: 'source-map'
};

module.exports = (_env, argv) => {
    if (isProduction) { config.mode = 'production'; } 
    else { config.mode = 'development'; }

    // Under --watch nothing re-emits the declarations, so the sweep has to spare them. See output.clean.
    if (argv && argv.watch) config.output.clean = { keep: /\.d\.ts$/ };

    return config;
};