const HtmlWebpackPlugin = require("html-webpack-plugin");
const path = require("path");
const webpack = require("webpack");
const { contract } = require("./src/features/publish/playerContract.json");
const { buildVersionDefines } = require("./buildVersion");

// Stamps public/player/build.json with the contract this bundle was built against, so publishing can
// tell a fresh player from a stale one. Emitted through webpack rather than written by a side script
// because `clean: true` below wipes the output directory on every build.
//
// Nothing forces a rebuild of this bundle — it is git-ignored, and `editor:dev` used to skip it — so
// it once drifted a month behind the packer and quietly published games with flat terrain and dead
// blend spaces. build.json is what makes that state loud instead of silent. See pack.ts
// PLAYER_CONTRACT.
class EmitPlayerBuildInfo {
  apply(compiler) {
    compiler.hooks.thisCompilation.tap("EmitPlayerBuildInfo", (compilation) => {
      compilation.hooks.processAssets.tap(
        { name: "EmitPlayerBuildInfo", stage: compilation.constructor.PROCESS_ASSETS_STAGE_ADDITIONAL },
        () => {
          const info = JSON.stringify({ contract, builtAt: new Date().toISOString() }, null, 2);
          compilation.emitAsset("build.json", new webpack.sources.RawSource(info));
        }
      );
    });
  }
}

// Builds the standalone game player (engine + runtime) into editor/public/player/.
// Output: index.html (CSS inlined) + game.js. These are the static, game-independent files
// every published game reuses; only game.bin changes per game. They land in public/ so the
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
    // Nothing under src/player/ imports src/version.ts today. The define is here anyway because this is a
    // SEPARATE bundle that drifts silently (see EmitPlayerBuildInfo above) -- without it, the first shared
    // import to reach the player would be a runtime ReferenceError inside a published game, not a build error.
    new webpack.DefinePlugin(buildVersionDefines()),
    new HtmlWebpackPlugin({
      template: "./src/player/index.html",
      filename: "index.html",
      inject: "body",
    }),
    new EmitPlayerBuildInfo(),
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
