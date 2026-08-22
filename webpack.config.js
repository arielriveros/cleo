const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const isProduction = process.env.NODE_ENV == 'production';

const config = {
    entry: {
        'cleo': path.resolve(__dirname, 'src/cleo.ts')
    },
    output: {
        path: path.resolve(__dirname, 'dist'),
        clean: true,
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

module.exports = () => {
    if (isProduction) { config.mode = 'production'; } 
    else { config.mode = 'development'; }
    return config;
};