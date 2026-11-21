const { execFileSync } = require("child_process");
const { readFileSync } = require("fs");
const { join } = require("path");

// A release heading, as tools/changelog.mjs writes it: `## v1.1.2.4 — 2026-09-01` (em dash, ISO date).
const RELEASE_HEADING = /^## v(\S+) — (\d{4}-\d{2}-\d{2})\s*$/;
const UNRELEASED_HEADING = /^## Unreleased\s*$/;

/**
 * CHANGELOG.md cut into its `## ` sections, in file order: `{ kind, version?, date?, title, markdown }`,
 * `markdown` being the body up to the next `## ` heading, trimmed. The file's own header (`# Changelog`
 * and its intro) is not a section.
 */
function parseChangelog(text) {
  const sections = [];
  let current = null;
  for (const line of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    if (line.startsWith("## ")) {
      if (current) sections.push(current);
      const release = RELEASE_HEADING.exec(line);
      current = release
        ? { kind: "release", version: release[1], date: release[2], title: `v${release[1]} — ${release[2]}`, lines: [] }
        : UNRELEASED_HEADING.test(line)
          ? { kind: "unreleased", title: "Unreleased", lines: [] }
          : { kind: "other", title: line.slice(3).trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) sections.push(current);
  return sections.map(({ lines, ...s }) => ({ ...s, markdown: lines.join("\n").trim() }));
}

/**
 * The changelog a build shows in Help ▸ About, as `{ title, markdown }` sections. A release build (`tagged`) shows
 * its own version's section, or the newest release when the file has none for it. Any other build shows what is
 * Unreleased (when there is any) and then the newest release, since that is what it is running on top of.
 */
function changelogSections(text, version, tagged) {
  const all = parseChangelog(text);
  const releases = all.filter((s) => s.kind === "release");
  const own = releases.find((s) => s.version === version);
  const pick = (s) => ({ title: s.title, markdown: s.markdown });
  if (tagged) {
    const s = own ?? releases[0];
    return s ? [pick(s)] : [];
  }
  const unreleased = all.find((s) => s.kind === "unreleased" && s.markdown);
  return [unreleased, releases[0]].filter(Boolean).map(pick);
}

/** One release's notes (the body of `## v<version> — …`), or null when the file has no such section. */
function changelogSection(text, version) {
  const s = parseChangelog(text).find((x) => x.kind === "release" && x.version === version);
  return s ? s.markdown : null;
}

function readChangelog() {
  try {
    return readFileSync(join(__dirname, "../../CHANGELOG.md"), "utf8");
  } catch {
    return "";
  }
}

function buildVersionDefines() {
  const version = "1." + require("../../package.json").version;

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
    __APP_CHANGELOG__: JSON.stringify(changelogSections(readChangelog(), version, tagged)),
  };
}

module.exports = { buildVersionDefines, parseChangelog, changelogSections, changelogSection };
