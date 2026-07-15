const HtmlWebpackPlugin = require("html-webpack-plugin");
const path = require("path");

// Builds the standalone game player (engine + runtime) into editor/public/player/.
// Output: index.html (CSS inlined) + game.js. These are the static, game-independent files
// every published game reuses; only game.json changes per game. They land in public/ so the
// editor dev server and production build both serve them (used by the browser ZIP publish path),
// and so publishing can fetch them from same-origin.
//
// Do not import monaco-editor (or anything under features/nodeInspector/scriptEditor/Monaco*) from
// anything reachable from src/player/index.tsx. The script editor's IntelliSense is an editor-only
// tool, not part of a published game, and this config has no MonacoWebpackPlugin/worker/asset rules
// for it — a published build must stay lean.
module.exports = {
  mode: "production",
  entry: "./src/player/index.tsx",
  target: "web",
  output: {
    filename: "game.js",
    path: path.resolve(__dirname, "public/player"),
    publicPath: "",
    clean: true,
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: "./src/player/index.html",
      filename: "index.html",
      inject: "body",
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
        exclude: /node_modules/,
        loader: require.resolve("babel-loader"),
      },
      {
        test: /\.png|svg|jpg|gif$/,
        use: ["file-loader"],
      },
    ],
  },
};
