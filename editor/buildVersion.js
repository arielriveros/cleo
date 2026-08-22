const { execFileSync } = require("child_process");


function buildVersionDefines() {
  const version = "1." + require("../package.json").version;

  let tagged = false;
  try {
    const tag = execFileSync("git", ["describe", "--exact-match", "--tags", "HEAD"], {
      cwd: __dirname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    tagged = tag === `v${version}`;
  } catch {
    // Not a release build.
  }

  return {
    __APP_VERSION__: JSON.stringify(version),
    __BUILD_TAGGED__: JSON.stringify(tagged),
  };
}

module.exports = { buildVersionDefines };
