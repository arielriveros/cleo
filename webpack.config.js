const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const isProduction = process.env.NODE_ENV == 'production';

const config = {
    entry: {
        'cleo': path.resolve(__dirname, 'src/cleo.ts')
    },
    output: {
        path: path.resolve(__dirname, 'dist'),
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