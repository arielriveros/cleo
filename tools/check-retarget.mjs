// End-to-end check of the REAL import path on real files: assimp -> GLTFLoader (which runs
// collapseFbxPivots) -> buildBoneMapping -> retargetAnimation, then score the result against the target
// character's bind pose. Complements tools/dump-rig.mjs, which re-implements the maths independently;
// this one runs the shipped code in dist.
//
//   node tools/check-retarget.mjs <character.fbx> <animation.fbx>
//
// The acceptance criterion is the one that kept failing by eye: a clip that holds the SOURCE's rest pose
// must leave every target bone at the TARGET's rest. Mixamo's "T-Pose" is such a clip, and so is the
// rest-pose clip embedded in a character download.
import { createRequire } from 'module';
import { readFileSync, existsSync } from 'fs';
import { basename } from 'path';

const require = createRequire(import.meta.url);
const { mat4, quat, vec3 } = require('gl-matrix');
const cleo = require('../dist/cleo.js');
const { GLTFLoader, convertToGltf2FromFiles, buildBoneMapping, retargetAnimation } = cleo;

const asFiles = (p) => [new File([readFileSync(p)], basename(p))];
const deg = (q) => (2 * Math.acos(Math.min(1, Math.abs(q[3]))) * 180) / Math.PI;

async function load(path) {
    const converted = await convertToGltf2FromFiles(asFiles(path));
    const parsed = await new GLTFLoader().loadAnimationsFromFiles(converted);
    return parsed; // { animations, skin }
}

/** local rotation a bone holds under `clip` at `time`; falls back to the skin's rest. */
function localAt(skin, clip, node, time) {
    const m = mat4.clone(skin.nodeTransforms?.get(node) ?? mat4.create());
    const t = mat4.getTranslation(vec3.create(), m);
    const s = mat4.getScaling(vec3.create(), m);
    const r = quat.normalize(quat.create(), mat4.getRotation(quat.create(), m));
    for (const ch of clip?.channels ?? []) {
        if (ch.targetNodeIndex !== node) continue;
        const smp = clip.samplers[ch.samplerIndex];
        const size = ch.targetPath === 'rotation' ? 4 : 3;
        let i = 0;
        while (i < smp.input.length - 1 && smp.input[i + 1] <= time) i++;
        const v = [];
        for (let k = 0; k < size; k++) v.push(smp.output[i * size + k]);
        if (ch.targetPath === 'rotation') quat.normalize(r, quat.fromValues(v[0], v[1], v[2], v[3]));
        else if (ch.targetPath === 'translation') vec3.set(t, v[0], v[1], v[2]);
        else if (ch.targetPath === 'scale') vec3.set(s, v[0], v[1], v[2]);
    }
    return { m: mat4.fromRotationTranslationScale(mat4.create(), r, t, s), r, t };
}

/** A synthetic clip that holds the source skin at its own rest, on exactly the bones `like` touches. */
function restPoseClip(skin, like) {
    const nodes = [...new Set(like.channels.map((c) => c.targetNodeIndex))];
    const samplers = [], channels = [];
    for (const node of nodes) {
        const rest = skin.nodeTransforms?.get(node) ?? mat4.create();
        const r = quat.normalize(quat.create(), mat4.getRotation(quat.create(), rest));
        const t = mat4.getTranslation(vec3.create(), rest);
        samplers.push({ input: [0, 1], output: [...r, ...r], interpolation: 'LINEAR' });
        channels.push({ samplerIndex: samplers.length - 1, targetNodeIndex: node, targetPath: 'rotation' });
        samplers.push({ input: [0, 1], output: [...t, ...t], interpolation: 'LINEAR' });
        channels.push({ samplerIndex: samplers.length - 1, targetNodeIndex: node, targetPath: 'translation' });
    }
    return { name: 'source rest pose', samplers, channels };
}

/** How far every target bone sits from the target's own rest under `clip`. */
function deviationFromRest(skin, clip) {
    const nodes = [...new Set(clip.channels.map((c) => c.targetNodeIndex))];
    const rows = [];
    for (const node of nodes) {
        const rest = skin.nodeTransforms?.get(node);
        if (!rest) continue;
        const rr = quat.normalize(quat.create(), mat4.getRotation(quat.create(), rest));
        const got = localAt(skin, clip, node, 0).r;
        rows.push({ node, name: skin.nodeNames?.get(node) ?? String(node), d: deg(quat.multiply(quat.create(), quat.invert(quat.create(), rr), got)) });
    }
    rows.sort((a, b) => b.d - a.d);
    return rows;
}

const [charPath, animPath] = process.argv.slice(2);
for (const p of [charPath, animPath]) if (!p || !existsSync(p)) { console.error('usage: node tools/check-retarget.mjs <character.fbx> <animation.fbx>'); process.exit(1); }

const target = await load(charPath);
const source = await load(animPath);
console.log(`target: ${target.skin.joints.length} joints, ${target.animations.length} clips`);
console.log(`source: ${source.skin.joints.length} joints, ${source.animations.length} clips`);

// --- 1. The character's OWN embedded clip must leave it at its own rest (it is a rest-pose clip).
{
    const rows = deviationFromRest(target.skin, target.animations[0]);
    const over = rows.filter((r) => r.d > 20);
    console.log(`\n1. character's own clip vs its own rest: mean ${(rows.reduce((s, r) => s + r.d, 0) / rows.length).toFixed(1)}deg, ${over.length}/${rows.length} bones over 20deg`);
    for (const r of rows.slice(0, 6)) console.log(`     ${r.name.padEnd(34)} ${r.d.toFixed(1)}deg`);
}

// --- 2. Retargeting a clip that holds the SOURCE's rest must land every target bone on the TARGET's rest.
{
    const rest = restPoseClip(source.skin, source.animations[0]);
    const mapping = buildBoneMapping([rest], source.skin, target.skin);
    const out = retargetAnimation(rest, source.skin, target.skin, mapping);
    const rows = deviationFromRest(target.skin, out);
    const mean = rows.reduce((s, r) => s + r.d, 0) / rows.length;
    const over = rows.filter((r) => r.d > 20);
    console.log(`\n2. source-rest clip retargeted onto the character  (sameRig=${mapping.sameRig}, canRetarget=${mapping.canRetarget}, mode=${mapping.matchMode})`);
    console.log(`   mapped ${mapping.entries.filter((e) => e.targetNode !== null).length}/${mapping.entries.length} bones`);
    console.log(`   deviation from target rest: mean ${mean.toFixed(1)}deg, ${over.length}/${rows.length} bones over 20deg`);
    for (const r of rows.slice(0, 8)) console.log(`     ${r.name.padEnd(34)} ${r.d.toFixed(1)}deg`);
    console.log(mean < 5 && over.length === 0
        ? `   PASS - a rest-pose clip is a no-op on the target.`
        : `   FAIL - a rest-pose clip still moves the target.`);
}

// --- 3. The real walk: report the bones that end up furthest from rest at t=0 (a sanity read, not a pass/fail).
{
    const clip = source.animations[0];
    const mapping = buildBoneMapping([clip], source.skin, target.skin);
    const out = retargetAnimation(clip, source.skin, target.skin, mapping);
    const rows = deviationFromRest(target.skin, out);
    const dropped = mapping.entries.filter((e) => e.targetNode === null);
    console.log(`\n3. the walk clip retargeted: ${out.channels.length} channels out of ${clip.channels.length}, ${dropped.length} source bones unmapped`);
    console.log(`   frame 0 deviation from rest: mean ${(rows.reduce((s, r) => s + r.d, 0) / rows.length).toFixed(1)}deg`);
    for (const r of rows.slice(0, 8)) console.log(`     ${r.name.padEnd(34)} ${r.d.toFixed(1)}deg`);
    const paths = {};
    for (const c of out.channels) paths[c.targetPath] = (paths[c.targetPath] ?? 0) + 1;
    console.log(`   channels by path: ${JSON.stringify(paths)}`);
}
