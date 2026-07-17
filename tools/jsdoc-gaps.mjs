// Walk the emitted .d.ts tree (the true public surface — anything private is already stripped) and
// report members with no leading JSDoc. Using the .d.ts rather than src means we measure exactly what
// Monaco shows a script author on hover, which is the whole reason removeComments is off.
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = 'd:/Users/ariel/Projects/VGameDev/Cleo/Engine/dist';
const SKIP = (p) => p.includes('node_modules');

function walk(dir, out = []) {
    for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (p.endsWith('.d.ts') && !SKIP(p)) out.push(p);
    }
    return out;
}

const rows = [];
for (const file of walk(ROOT)) {
    const text = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2020, true);

    const hasDoc = (node) => (ts.getJSDocCommentsAndTags(node) || []).length > 0;
    const rel = file.replace(ROOT, 'dist').replace(/\\/g, '/');

    const visit = (node, owner) => {
        if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
            const name = node.name?.text ?? '(anon)';
            if (!hasDoc(node)) rows.push({ file: rel, kind: 'class', name, member: '' });
            node.members.forEach((m) => {
                const mn = m.name && ts.isIdentifier(m.name) ? m.name.text : null;
                if (!mn) return;
                // protected/private members surface in the .d.ts but are not API any script author
                // can call. Only count what is genuinely reachable, or the number is meaningless.
                const mods = ts.getModifiers?.(m) ?? [];
                const hidden = mods.some((x) =>
                    x.kind === ts.SyntaxKind.ProtectedKeyword || x.kind === ts.SyntaxKind.PrivateKeyword);
                if (hidden || mn.startsWith('_')) return;
                if (ts.isPropertySignature(m) || ts.isPropertyDeclaration(m) ||
                    ts.isMethodSignature(m) || ts.isMethodDeclaration(m) ||
                    ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) {
                    if (!hasDoc(m)) rows.push({ file: rel, kind: 'member', name, member: mn });
                }
            });
        } else if (ts.isFunctionDeclaration(node) && node.name) {
            if (!hasDoc(node)) rows.push({ file: rel, kind: 'function', name: node.name.text, member: '' });
        } else if (ts.isTypeAliasDeclaration(node)) {
            if (!hasDoc(node)) rows.push({ file: rel, kind: 'type', name: node.name.text, member: '' });
        }
        ts.forEachChild(node, (c) => visit(c, owner));
    };
    ts.forEachChild(sf, (n) => visit(n));
}

const byFile = {};
for (const r of rows) (byFile[r.file] ??= []).push(r);

console.log(`UNDOCUMENTED PUBLIC MEMBERS: ${rows.length}\n`);
for (const [f, rs] of Object.entries(byFile).sort((a, b) => b[1].length - a[1].length))
    console.log(String(rs.length).padStart(4), f);
