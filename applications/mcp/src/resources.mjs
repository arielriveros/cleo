// @ts-check
// Engine knowledge as MCP resources, served straight from the checkout so they never drift from the code:
// the docs (docs/**/*.md) and the example game scripts (examples/scripts). No editor needed. A Claude Code
// session inside the repo can read these files directly; the resources are for clients that cannot
// (Claude Desktop), and for discovery.

import fs from 'node:fs';
import path from 'node:path';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';

/** @param {string} dir @param {(name: string) => boolean} keep @returns {string[]} paths relative to dir, '/'-separated */
function walk(dir, keep) {
    /** @type {string[]} */
    const out = [];
    const visit = (/** @type {string} */ rel) => {
        let entries;
        try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const child = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) { if (e.name !== 'media' && e.name !== 'node_modules') visit(child); }
            else if (keep(e.name)) out.push(child);
        }
    };
    visit('');
    return out.sort();
}

/** First Markdown heading, for the resource title. @param {string} file */
function titleOf(file) {
    try {
        const head = fs.readFileSync(file, 'utf8').slice(0, 2000);
        return head.match(/^#\s+(.+)$/m)?.[1]?.trim();
    } catch { return undefined; }
}

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {string} engineRoot
 */
export function registerResources(server, engineRoot) {
    const docsDir = path.join(engineRoot, 'docs');
    const examplesDir = path.join(engineRoot, 'examples', 'scripts');

    /**
     * @param {string} name @param {string} base the resource URI prefix @param {string} dir
     * @param {(n: string) => boolean} keep @param {string} mimeOf @param {string} description
     */
    const folder = (name, base, dir, keep, mimeOf, description) => {
        const inside = (/** @type {string} */ rel) => {
            const file = path.resolve(dir, rel);
            return file.startsWith(path.resolve(dir) + path.sep) ? file : null;
        };
        server.registerResource(name, new ResourceTemplate(`${base}{+path}`, {
            list: async () => ({
                resources: walk(dir, keep).map(rel => ({
                    uri: `${base}${rel}`,
                    name: rel,
                    title: rel.endsWith('.md') ? titleOf(path.join(dir, rel)) : undefined,
                    mimeType: rel.endsWith('.md') ? 'text/markdown' : mimeOf,
                })),
            }),
        }), { title: name, description }, async (uri, vars) => {
            const rel = decodeURIComponent(String(vars.path ?? ''));
            const file = inside(rel);
            if (!file || !keep(path.basename(file)) || !fs.existsSync(file)) throw new Error(`No such resource: ${uri.href}`);
            return { contents: [{ uri: uri.href, mimeType: rel.endsWith('.md') ? 'text/markdown' : mimeOf, text: fs.readFileSync(file, 'utf8') }] };
        });
    };

    folder('docs', 'cleo://docs/', docsDir, n => n.endsWith('.md'), 'text/markdown',
        'Cleo documentation: scripting guide (scripting/), node types and file formats (reference/), editor manual (editor/).');
    folder('example-scripts', 'cleo://examples/scripts/', examplesDir, n => n.endsWith('.ts') || n.endsWith('.md'), 'text/x-typescript',
        'Working game scripts from the example projects: third-person controller and camera, combat, pickups, UI, AI.');
}
