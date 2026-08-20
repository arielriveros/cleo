const HtmlWebpackPlugin = require("html-webpack-plugin");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const MonacoWebpackPlugin = require("monaco-editor-webpack-plugin");
const path = require("path");
const webpack = require("webpack");

const isDevelopment = process.env.NODE_ENV !== "production";

module.exports = {
  mode: isDevelopment ? "development" : "production",
  entry: "./src/index.tsx",
  devServer: {
    hot: true,
    port: 8080,
    static: ['./public']
  },
  target: "web",
  output: {
    filename: "bundle.[contenthash].js",
    path: path.resolve(__dirname, "dist"),
    clean: true,
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: "./src/index.html",
    }),
    new CopyWebpackPlugin({
      patterns: [
        {
          from: "public",
          to: ".",
          noErrorOnMissing: true,
        },
      ],
    }),
    isDevelopment && new webpack.HotModuleReplacementPlugin(),
    // Only the script editor (MonacoCodeEditor.tsx, lazy-loaded) ever imports monaco-editor, so this
    // plugin's worker bundles are only fetched once that component actually mounts. Emitted under
    // monaco/ so monacoSetup.ts's getWorkerUrl (the only place that path is hard-coded) matches it.
    new MonacoWebpackPlugin({
      languages: ["typescript", "javascript"],
      filename: "monaco/[name].worker.js",
    }),
  ],
  resolve: {
    modules: [__dirname, "src", "node_modules"],
    extensions: ["*", ".js", ".jsx", ".tsx", ".ts"],
  },
  module: {
    rules: [
      {
        test: /\.ts$|tsx/,
        // \.ts$ also matches *.d.ts (it too ends in ".ts") -- those must never reach babel-loader as
        // source, regardless of where they live, or it tries to parse pure type syntax as executable JS.
        // They're handled below instead, as asset/source text for Monaco.
        exclude: [/node_modules/, /\.d\.ts$/],
        loader: require.resolve("babel-loader"),
      },
      {
        test: /\.css$/,
        // Bare CSS imports are side effects. Without this, webpack drops stylesheets imported from
        // packages that declare "sideEffects": false (e.g. @svar-ui/react-filemanager's all.css).
        sideEffects: true,
        use: [
          "style-loader",
          {
            loader: "css-loader",
            options: { importLoaders: 1 }
          },
          "postcss-loader"
        ],
      },
      {
        test: /\.png|svg|jpg|gif$/,
        use: ["file-loader"]
      },
      // Monaco's own CSS references codicon.ttf via @font-face url(...).
      {
        test: /\.ttf$/,
        type: "asset/resource",
      },
      // Raw-loaded so cleoTypes.ts can addExtraLib the engine's actual declaration tree (dist/**/*.d.ts)
      // into the Monaco TS worker verbatim — IntelliSense can never drift from the shipped API this way.
      {
        test: /\.d\.ts$/,
        type: "asset/source",
      },
    ],
  },
};