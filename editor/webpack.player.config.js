const HtmlWebpackPlugin = require("html-webpack-plugin");
const path = require("path");

// Builds the standalone game player (engine + runtime) into editor/public/player/.
// Output: index.html (CSS inlined) + game.js. These are the static, game-independent files
// every published game reuses; only game.json changes per game. They land in public/ so the
// editor dev server and production build both serve them (used by the browser ZIP publish path),
// and so publishing can fetch them from same-origin.
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
