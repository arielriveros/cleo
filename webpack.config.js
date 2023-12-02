const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = {
    entry: './src/app.ts',
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: 'ts-loader',
                include: [ path.resolve(__dirname, 'src') ]
            }
        ]
    },
    resolve: {
        extensions: ['.ts', '.js'],
        alias: {}
    },
    output: {
        publicPath: 'auto',
        filename: 'app.js',
        path: path.resolve(__dirname, 'build')
    },
    mode: 'development',
    devtool: 'inline-source-map',
    devServer: {
        static: {
          directory: path.resolve(__dirname, 'build'),
        },
        hot: true,
        compress: true,
        port: 8080,
      },
    plugins: [
        new CopyWebpackPlugin({patterns: [
            { from: 'src/static', to: './' },
            { from: 'src/graphics/shaders', to: './shaders' }
        ]})
    ]
};