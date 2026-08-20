// Convert FBX files with the REAL assimp WASM the editor uses, then print the skeleton facts the
// retarget depends on. Written because two rounds of fixing the "legs 180 / shoulders 45" bug reasoned
// from an ASSUMPTION about what assimp writes into a glTF node's TRS, and nobody had ever checked.
//
//   node tools/dump-rig.mjs <character.fbx> <animation.fbx>
//
// The question it exists to answer: for an animation-only FBX (no skin), is the node's authored TRS the
// BIND pose, or the clip's frame 0? animationRetarget.ts:369 asserts the latter and disables the rest
// delta because of it. If it is actually the bind, that guard is the bug.
import { createRequire } from 'module';
import { readFileSync, existsSync } from 'fs';
import { basename } from 'path';

const require = createRequire(import.meta.url);
const { mat4, quat, vec3 } = require('gl-matrix');
const assimpjs = require('../src/graphics/utils/assimpjs.js');

const PIVOT = '$AssimpFbx$';
const isPivot = (n) => !!n && n.includes(PIVOT);

// ---------------------------------------------------------------- assimp

async function toGltf(path) {
    const ajs = await assimpjs();
    const list = new ajs.FileList();
    list.AddFile(basename(path), new Uint8Array(readFileSync(path)));
    const res = ajs.ConvertFileList(list, 'gltf2');
    if (!res.IsSuccess() || res.FileCount() === 0) throw new Error(`assimp failed on ${path}`);
    const files = new Map();
    for (let i = 0; i < res.FileCount(); i++) {
        const f = res.GetFile(i);
        const p = (typeof f.GetPath === 'function' ? f.GetPath() : '') || `out_${i}.gltf`;
        files.set(p.split(/[\\/]/).pop(), f.GetContent().slice());
    }
    let json = null;
    for (const [name, bytes] of files) if (name.endsWith('.gltf')) json = JSON.parse(new TextDecoder().decode(bytes));
    if (!json) throw new Error(`no .gltf in assimp output for ${path}`);
    return { json, files };
}

// ---------------------------------------------------------------- accessors

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const CTOR = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };

function readAccessor(gltf, files, index) {
    const acc = gltf.accessors[index];
    const n = COMPONENTS[acc.type];
    const out = new Float32Array(acc.count * n);
    if (acc.bufferView === undefined) return out;
    const view = gltf.bufferViews[acc.bufferView];
    const buf = gltf.buffers[view.buffer];
    let bytes;
    if (buf.uri && buf.uri.startsWith('data:')) {
        bytes = Buffer.from(buf.uri.slice(buf.uri.indexOf(',') + 1), 'base64');
    } else if (buf.uri) {
        const key = decodeURIComponent(buf.uri).split(/[\\/]/).pop();
        bytes = files.get(key);
        if (!bytes) throw new Error(`missing buffer file ${key}`);
    } else throw new Error('GLB buffers not handled');
    const Ctor = CTOR[acc.componentType];
    const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const src = new Ctor(bytes.buffer, bytes.byteOffset + base, acc.count * n);
    for (let i = 0; i < out.length; i++) out[i] = src[i];
    return out;
}

// ---------------------------------------------------------------- graph

function buildGraph(gltf) {
    const parents = new Map(), names = new Map(), rest = new Map(), children = new Map();
    (gltf.nodes ?? []).forEach((node, i) => {
        if (node.name) names.set(i, node.name);
        for (const c of node.children ?? []) { parents.set(c, i); children.set(i, [...(children.get(i) ?? []), c]); }
        const m = mat4.create();
        if (node.matrix) for (let k = 0; k < 16; k++) m[k] = node.matrix[k];
        else mat4.fromRotationTranslationScale(m, node.rotation ?? [0, 0, 0, 1], node.translation ?? [0, 0, 0], node.scale ?? [1, 1, 1]);
        rest.set(i, m);
    });
    return { parents, names, rest, children };
}

/** The pivots between `node` and its nearest non-pivot ancestor, top-down. Mirrors fbxPivots.chainOf. */
function chainOf(g, node) {
    const chain = [];
    let p = g.parents.get(node);
    while (p !== undefined && isPivot(g.names.get(p)) && (g.children.get(p) ?? []).length === 1) {
        chain.unshift(p);
        p = g.parents.get(p);
    }
    return { chain, parent: p };
}

/** Channels per node for one clip: { t, r, s } samplers as decoded arrays. */
function clipChannels(gltf, files, clip) {
    const per = new Map();
    for (const ch of clip.channels ?? []) {
        const node = ch.target?.node;
        if (node === undefined) continue;
        const s = clip.samplers[ch.sampler];
        const entry = per.get(node) ?? {};
        entry[ch.target.path] = { input: readAccessor(gltf, files, s.input), output: readAccessor(gltf, files, s.output) };
        per.set(node, entry);
    }
    return per;
}

/** A node's local TRS at `time` — its channel value if animated, else its authored rest. */
function localAt(g, per, node, time) {
    const ch = per?.get(node);
    const m = mat4.create();
    if (!ch) return mat4.copy(m, g.rest.get(node) ?? mat4.create());
    const restM = g.rest.get(node) ?? mat4.create();
    const t = ch.translation ? sample(ch.translation, time, 3) : mat4.getTranslation(vec3.create(), restM);
    const s = ch.scale ? sample(ch.scale, time, 3) : mat4.getScaling(vec3.create(), restM);
    const r = ch.rotation ? quat.normalize(quat.create(), sample(ch.rotation, time, 4)) : mat4.getRotation(quat.create(), restM);
    return mat4.fromRotationTranslationScale(m, r, t, s);
}

function sample(s, time, size) {
    const keys = s.input;
    let i = 0;
    while (i < keys.length - 1 && keys[i + 1] <= time) i++;
    const out = new Float32Array(size);
    for (let k = 0; k < size; k++) out[k] = s.output[i * size + k];
    return out;
}

/** The bone's local transform with its pivot chain folded in — what collapseFbxPivots produces. */
function foldedLocal(g, per, node, time) {
    const { chain } = chainOf(g, node);
    const m = mat4.create();
    for (const p of chain) mat4.multiply(m, m, localAt(g, per, p, time));
    mat4.multiply(m, m, localAt(g, per, node, time));
    return m;
}

// ---------------------------------------------------------------- bind poses

/** Same rule as src/graphics/boneNames.ts normalizeBoneName: drop namespace, lowercase, strip separators. */
function normName(name) {
    let s = name;
    const ns = Math.max(s.lastIndexOf(':'), s.lastIndexOf('|'));
    if (ns >= 0) s = s.slice(ns + 1);
    return s.trim().toLowerCase().replace(/[\s._-]+/g, '');
}

/** node -> local bind rotation derived from the skin's inverse bind matrices (the TRUE bind). */
function bindLocals(gltf, files, g) {
    const out = new Map();
    const skin = gltf.skins?.[0];
    if (!skin || skin.inverseBindMatrices === undefined) return out;
    const ibmData = readAccessor(gltf, files, skin.inverseBindMatrices);
    const ibmOf = new Map();
    skin.joints.forEach((node, j) => ibmOf.set(node, ibmData.slice(j * 16, j * 16 + 16)));

    /** nearest ancestor that is itself a joint (pivots and wrappers skipped) */
    const ancestorJoint = (node) => {
        let p = g.parents.get(node);
        while (p !== undefined && !ibmOf.has(p)) p = g.parents.get(p);
        return p;
    };
    for (const node of skin.joints) {
        const world = mat4.invert(mat4.create(), ibmOf.get(node));
        if (!world) continue;
        const pj = ancestorJoint(node);
        const local = pj !== undefined ? mat4.multiply(mat4.create(), ibmOf.get(pj), world) : world;
        out.set(node, quat.normalize(quat.create(), mat4.getRotation(quat.create(), local)));
    }
    return out;
}

// ---------------------------------------------------------------- reporting

const degOf = (q) => {
    const w = Math.min(1, Math.max(-1, Math.abs(q[3])));
    return (2 * Math.acos(w) * 180) / Math.PI;
};
const fmt = (n) => (Math.abs(n) < 1e-4 ? '0' : n.toFixed(3));
const eulerOf = (q) => {
    const m = mat4.fromQuat(mat4.create(), q);
    const sy = Math.hypot(m[0], m[1]);
    const x = Math.atan2(m[6], m[10]), y = Math.atan2(-m[2], sy), z = Math.atan2(m[1], m[0]);
    return [x, y, z].map((r) => ((r * 180) / Math.PI).toFixed(1)).join(', ');
};

function describe(label, path, { json, files }) {
    const g = buildGraph(json);
    const pivots = [...g.names].filter(([, n]) => isPivot(n));
    const bones = [...g.names.keys()].filter((i) => !isPivot(g.names.get(i)));
    console.log(`\n${'='.repeat(78)}\n${label}: ${basename(path)}\n${'='.repeat(78)}`);
    console.log(`nodes: ${json.nodes?.length ?? 0}   named: ${g.names.size}   pivot nodes: ${pivots.length}   real bones: ${bones.length}`);
    console.log(`skins: ${json.skins?.length ?? 0}   animations: ${json.animations?.length ?? 0}   meshes: ${json.meshes?.length ?? 0}`);

    if (json.skins?.length) {
        const skin = json.skins[0];
        const ibm = skin.inverseBindMatrices !== undefined ? readAccessor(json, files, skin.inverseBindMatrices) : null;
        let nonIdentity = 0;
        if (ibm) for (let j = 0; j < skin.joints.length; j++) {
            const m = ibm.slice(j * 16, j * 16 + 16);
            let id = true;
            for (let k = 0; k < 16; k++) if (Math.abs(m[k] - (k % 5 === 0 ? 1 : 0)) > 1e-6) { id = false; break; }
            if (!id) nonIdentity++;
        }
        console.log(`skin joints: ${skin.joints.length}   inverseBindMatrices: ${ibm ? `present, ${nonIdentity} non-identity` : 'ABSENT'}`);
    } else {
        console.log(`skin joints: none  ->  gltfLoader synthesizes joints with IDENTITY inverse bind matrices`);
    }

    for (const a of json.animations ?? []) console.log(`clip: "${a.name}"  channels=${a.channels.length}`);

    // The decisive comparison: authored rest vs the clip's value at t=0, per bone, folded the same way.
    const clip = json.animations?.[0];
    if (clip) {
        const per = clipChannels(json, files, clip);
        const animated = bones.filter((b) => {
            const { chain } = chainOf(g, b);
            return per.has(b) || chain.some((p) => per.has(p));
        });
        console.log(`\n-- authored rest vs clip frame 0 (folded), ${animated.length} animated bones --`);
        let differing = 0, maxDeg = 0, worst = '';
        for (const b of animated) {
            const r0 = mat4.getRotation(quat.create(), foldedLocal(g, null, b, 0));
            const f0 = mat4.getRotation(quat.create(), foldedLocal(g, per, b, 0));
            const d = degOf(quat.multiply(quat.create(), quat.invert(quat.create(), r0), f0));
            if (d > 0.5) differing++;
            if (d > maxDeg) { maxDeg = d; worst = g.names.get(b); }
        }
        console.log(`bones whose frame 0 differs from the authored rest by >0.5deg: ${differing} / ${animated.length}`);
        console.log(`largest difference: ${fmt(maxDeg)}deg on ${worst || '(none)'}`);
        console.log(differing === 0
            ? `VERDICT: authored TRS == clip frame 0. The node transforms ARE a usable rest for this file.`
            : `VERDICT: authored TRS differs from frame 0 on ${differing} bones - inspect before trusting it as a rest.`);
    }

    const per = clip ? clipChannels(json, files, clip) : null;

    // Which of the two candidate "rests" matches the skin's real bind? Decides what nodeTransforms means.
    const binds = bindLocals(json, files, g);
    if (binds.size) {
        let restVsBind = 0, f0VsBind = 0, n = 0;
        for (const [node, b] of binds) {
            if (isPivot(g.names.get(node))) continue;
            n++;
            const r = mat4.getRotation(quat.create(), foldedLocal(g, null, node, 0));
            if (degOf(quat.multiply(quat.create(), quat.invert(quat.create(), b), r)) > 0.5) restVsBind++;
            if (per) {
                const f = mat4.getRotation(quat.create(), foldedLocal(g, per, node, 0));
                if (degOf(quat.multiply(quat.create(), quat.invert(quat.create(), b), f)) > 0.5) f0VsBind++;
            }
        }
        console.log(`
against the skin's REAL local bind (from inverse bind matrices), over ${n} joints:`);
        console.log(`  authored folded rest differs on ${restVsBind}`);
        console.log(`  clip frame 0 differs on        ${f0VsBind}`);
    }
    return { g, json, files, per };
}

function compare(a, b) {
    const idx = (side) => {
        const m = new Map();
        for (const [i, n] of side.g.names) if (!isPivot(n)) { const k = normName(n); if (!m.has(k)) m.set(k, i); }
        return m;
    };
    const tByNorm = idx(a);
    const tBind = bindLocals(a.json, a.files, a.g);
    const sBind = bindLocals(b.json, b.files, b.g);

    console.log(`
${'='.repeat(94)}
PER-BONE CORRECTION, three ways (normalized name matching)
${'='.repeat(94)}`);
    console.log('  ibm    = targetLocalBind(IBM)  * inverse(sourceLocalBind(IBM))    <- what boneCorrection computes today');
    console.log('  rest   = targetFoldedRest      * inverse(sourceFoldedRest)        <- what the authored node TRS would give');
    console.log('  s:bind = does the SOURCE clip frame 0 equal the SOURCE local bind? (0 = yes, a T-pose-relative clip)');

    const rows = [];
    for (const [i, n] of b.g.names) {
        if (isPivot(n)) continue;
        const t = tByNorm.get(normName(n));
        if (t === undefined) continue;
        const bs = sBind.get(i), bt = tBind.get(t);
        const ibmDeg = bs && bt ? degOf(quat.multiply(quat.create(), bt, quat.invert(quat.create(), bs))) : NaN;

        const rs = mat4.getRotation(quat.create(), foldedLocal(b.g, null, i, 0));
        const rt = mat4.getRotation(quat.create(), foldedLocal(a.g, null, t, 0));
        const restDeg = degOf(quat.multiply(quat.create(), rt, quat.invert(quat.create(), rs)));

        const f0 = mat4.getRotation(quat.create(), foldedLocal(b.g, b.per, i, 0));
        const sBindDeg = bs ? degOf(quat.multiply(quat.create(), quat.invert(quat.create(), bs), f0)) : NaN;

        rows.push({ name: n, ibmDeg, restDeg, sBindDeg });
    }
    rows.sort((x, y) => (y.ibmDeg || 0) - (x.ibmDeg || 0));
    console.log(`
matched bones: ${rows.length}`);
    console.log(`
  ${'bone'.padEnd(30)} ${'ibm'.padStart(8)} ${'rest'.padStart(8)} ${'s:bind'.padStart(8)}`);
    for (const r of rows.slice(0, 28))
        console.log(`  ${r.name.padEnd(30)} ${fmt2(r.ibmDeg)} ${fmt2(r.restDeg)} ${fmt2(r.sBindDeg)}`);

    const big = (k) => rows.filter((r) => r[k] > 5).length;
    console.log(`
bones with correction >5deg   ibm: ${big('ibmDeg')} / ${rows.length}    rest: ${big('restDeg')} / ${rows.length}`);
    console.log(`bones whose source frame 0 differs from the source bind by >5deg: ${big('sBindDeg')} / ${rows.length}`);
}

const fmt2 = (n) => (Number.isNaN(n) ? '     n/a' : n.toFixed(2).padStart(8));

/** Dump one bone's pivot chain node by node: rest vs frame 0, and who actually carries a channel. */
function dumpBind(label, side, needle) {
    const { g, json, files, per } = side;
    const binds = bindLocals(json, files, g);
    console.log(`
---- ${label}: bind vs candidates for "${needle}" ----`);
    console.log(`  ${'bone'.padEnd(30)} ${'bindLocal(IBM)'.padEnd(24)} ${'pivotRest'.padEnd(24)} ${'channel f0'.padEnd(24)} A     B`);
    for (const [i, n] of g.names) {
        if (isPivot(n) || !n.toLowerCase().includes(needle.toLowerCase())) continue;
        const b = binds.get(i);
        if (!b) { console.log(`  ${n.padEnd(30)} (not a skin joint)`); continue; }
        const { chain } = chainOf(g, i);
        const pv = quat.create();
        for (const c of chain) quat.multiply(pv, pv, mat4.getRotation(quat.create(), g.rest.get(c)));
        const f0 = mat4.getRotation(quat.create(), localAt(g, per, i, 0));
        const A = mat4.getRotation(quat.create(), foldedLocal(g, per, i, 0));
        const da = degOf(quat.multiply(quat.create(), quat.invert(quat.create(), b), A));
        const db = degOf(quat.multiply(quat.create(), quat.invert(quat.create(), b), f0));
        console.log(`  ${n.padEnd(30)} ${('(' + eulerOf(b) + ')').padEnd(24)} ${('(' + eulerOf(pv) + ')').padEnd(24)} ${('(' + eulerOf(f0) + ')').padEnd(24)} ${da.toFixed(1).padStart(5)} ${db.toFixed(1).padStart(5)}`);
    }
}

function dumpChain(label, side, needle) {
    const { g, per } = side;
    console.log(`
---- ${label}: chain for bones matching "${needle}" ----`);
    for (const [i, n] of g.names) {
        if (isPivot(n) || !n.toLowerCase().includes(needle.toLowerCase())) continue;
        const { chain, parent } = chainOf(g, i);
        console.log(`
  ${n}   (node ${i}, non-pivot parent ${parent !== undefined ? g.names.get(parent) : 'none'})`);
        for (const node of [...chain, i]) {
            const nm = g.names.get(node);
            const ch = per?.get(node);
            const rq = mat4.getRotation(quat.create(), g.rest.get(node));
            const fq = mat4.getRotation(quat.create(), localAt(g, per, node, 0));
            const d = degOf(quat.multiply(quat.create(), quat.invert(quat.create(), rq), fq));
            const has = ch ? Object.keys(ch).join('+') : '-';
            console.log(`    ${(node === i ? '[bone] ' : '[pivot]').padEnd(8)} ${nm.padEnd(46)} ch=${has.padEnd(24)} rest=(${eulerOf(rq)})  f0=(${eulerOf(fq)})  d=${d.toFixed(1)}`);
        }
    }
}

/**
 * The decisive test. Two competing readings of what an assimp FBX animation channel on a bone means:
 *   A (what the engine does): local(t) = pivotChainRest x boneChannel(t)   -- the pivots still apply
 *   B:                        local(t) = boneChannel(t)                    -- the channel is already the full local
 * Score both against the skin's real bind at t=0. Only meaningful when the clip's first frame is near bind.
 */
function pivotDoubleApplyTest(label, side) {
    const { g, json, files, per } = side;
    if (!per) return;
    const binds = bindLocals(json, files, g);
    if (!binds.size) { console.log(`
${label}: no inverse bind matrices, cannot score`); return; }

    const rows = [];
    for (const [node, bind] of binds) {
        const nm = g.names.get(node);
        if (isPivot(nm)) continue;
        const { chain } = chainOf(g, node);
        if (!chain.length || !per.has(node)) continue;   // only bones with BOTH a pivot chain and a channel
        const a = mat4.getRotation(quat.create(), foldedLocal(g, per, node, 0));  // pivots x channel
        const b = mat4.getRotation(quat.create(), localAt(g, per, node, 0));      // channel alone
        rows.push({
            nm,
            da: degOf(quat.multiply(quat.create(), quat.invert(quat.create(), bind), a)),
            db: degOf(quat.multiply(quat.create(), quat.invert(quat.create(), bind), b)),
            chain: chain.map((c) => g.names.get(c).split(PIVOT + '_')[1] + (per.has(c) ? '*' : '')).join('+'),
        });
    }
    const n = rows.length;
    const aBetter = rows.filter((r) => r.db > r.da + 1);
    const bBetter = rows.filter((r) => r.da > r.db + 1);
    console.log(`
${label}: ${n} bones with BOTH a pivot chain and their own channel   (* = pivot also has a channel)`);
    console.log(`  mean deviation from bind at t=0    A (pivots x channel): ${(rows.reduce((s, r) => s + r.da, 0) / n).toFixed(1)}deg    B (channel alone): ${(rows.reduce((s, r) => s + r.db, 0) / n).toFixed(1)}deg`);
    console.log(`  A closer on ${aBetter.length}, B closer on ${bBetter.length}, tie on ${n - aBetter.length - bBetter.length}`);
    const show = (title, list) => {
        if (!list.length) return;
        console.log(`  ${title}`);
        for (const r of list.slice(0, 10))
            console.log(`    ${r.nm.padEnd(32)} A=${r.da.toFixed(1).padStart(6)}  B=${r.db.toFixed(1).padStart(6)}   chain=${r.chain}`);
    };
    show(`worst for A (${aBetter.length ? 'A better here' : ''}):`, [...rows].sort((x, y) => y.da - x.da));
    show('where A is closer than B:', [...aBetter].sort((x, y) => (y.db - y.da) - (x.db - x.da)));
}

/**
 * Unambiguous test: reconstruct each joint's GLOBAL transform at t=0 by walking the whole node graph,
 * and compare it to the bind global (inverse of the inverse-bind-matrix). Local-space comparisons can be
 * absorbed by a parent; globals cannot.
 *   A: every node contributes its own localAt(t)  -- assimp's nominal semantics, and what the engine does
 *   B: a bone that HAS a channel supplies the whole chain, so its pivots are skipped
 */
function globalBindTest(label, side) {
    const { g, json, files, per } = side;
    const skin = json.skins?.[0];
    if (!skin || !per || skin.inverseBindMatrices === undefined) return;
    const ibmData = readAccessor(json, files, skin.inverseBindMatrices);
    const ibmOf = new Map();
    skin.joints.forEach((node, j) => ibmOf.set(node, ibmData.slice(j * 16, j * 16 + 16)));

    const globalOf = (node, mode) => {
        const stack = [];
        for (let c = node; c !== undefined; c = g.parents.get(c)) stack.unshift(c);
        const m = mat4.create();
        for (let k = 0; k < stack.length; k++) {
            const c = stack[k];
            if (mode === 'B' && isPivot(g.names.get(c))) {
                // skip a pivot whose bone (the next node down) carries its own channel
                const below = stack[k + 1];
                if (below !== undefined && per.has(below) && !isPivot(g.names.get(below))) continue;
            }
            mat4.multiply(m, m, localAt(g, per, c, 0));
        }
        return m;
    };

    let aSum = 0, bSum = 0, n = 0, aBetter = 0, bBetter = 0, pa = 0, pb = 0;
    const worst = [];
    for (const [node, ibm] of ibmOf) {
        const bindG = mat4.invert(mat4.create(), ibm);
        if (!bindG) continue;
        const bq = quat.normalize(quat.create(), mat4.getRotation(quat.create(), bindG));
        const da = degOf(quat.multiply(quat.create(), quat.invert(quat.create(), bq), quat.normalize(quat.create(), mat4.getRotation(quat.create(), globalOf(node, 'A')))));
        const db = degOf(quat.multiply(quat.create(), quat.invert(quat.create(), bq), quat.normalize(quat.create(), mat4.getRotation(quat.create(), globalOf(node, 'B')))));
        n++; aSum += da; bSum += db;
        const bp = mat4.getTranslation(vec3.create(), bindG);
        pa += vec3.distance(bp, mat4.getTranslation(vec3.create(), globalOf(node, 'A')));
        pb += vec3.distance(bp, mat4.getTranslation(vec3.create(), globalOf(node, 'B')));
        if (db > da + 1) aBetter++; else if (da > db + 1) bBetter++;
        worst.push({ nm: g.names.get(node), da, db });
    }
    console.log(`
${label}: ${n} joints, GLOBAL rotation vs bind global at t=0`);
    console.log(`  mean error   A (pivots always applied): ${(aSum / n).toFixed(1)}deg    B (channel supersedes its pivots): ${(bSum / n).toFixed(1)}deg`);
    console.log(`  A closer on ${aBetter}, B closer on ${bBetter}, tie on ${n - aBetter - bBetter}`);
    console.log(`  mean POSITION error   A: ${(pa / n).toFixed(2)} units    B: ${(pb / n).toFixed(2)} units`);
    worst.sort((x, y) => Math.max(y.da, y.db) - Math.max(x.da, x.db));
    for (const w of worst.slice(0, 12)) console.log(`    ${w.nm.padEnd(32)} A=${w.da.toFixed(1).padStart(6)}  B=${w.db.toFixed(1).padStart(6)}`);
}

/** How many of a clip's bone channels sit at identity rotation at t=0 (a hint at whether it is a rest pose). */
function clipShape(label, side) {
    const { g, per } = side;
    if (!per) return;
    let identity = 0, total = 0;
    for (const [node, ch] of per) {
        if (isPivot(g.names.get(node)) || !ch.rotation) continue;
        total++;
        const q = quat.normalize(quat.create(), sample(ch.rotation, 0, 4));
        if (degOf(q) < 0.5) identity++;
    }
    console.log(`${label}: ${identity}/${total} bone rotation channels are IDENTITY at t=0`);
}

// ---------------------------------------------------------------- main

const [charPath, animPath] = process.argv.slice(2);
if (!charPath || !animPath) {
    console.error('usage: node tools/dump-rig.mjs <character.fbx> <animation.fbx>');
    process.exit(1);
}
for (const p of [charPath, animPath]) if (!existsSync(p)) { console.error(`not found: ${p}`); process.exit(1); }

const target = describe('TARGET (character)', charPath, await toGltf(charPath));
const source = describe('SOURCE (animation)', animPath, await toGltf(animPath));
compare(target, source);

console.log(`
${'='.repeat(94)}
DOES AN ASSIMP BONE CHANNEL ALREADY CONTAIN ITS PIVOT CHAIN?
${'='.repeat(94)}`);
pivotDoubleApplyTest('TARGET (character)', target);
pivotDoubleApplyTest('SOURCE (animation)', source);

console.log(`
${'='.repeat(94)}
GLOBAL RECONSTRUCTION vs BIND
${'='.repeat(94)}`);
clipShape('TARGET clip', target);
clipShape('SOURCE clip', source);
globalBindTest('TARGET (character)', target);
globalBindTest('SOURCE (animation)', source);

const focus = process.argv[4];
if (focus) { dumpBind('TARGET', target, focus); dumpChain('TARGET', target, focus); }
