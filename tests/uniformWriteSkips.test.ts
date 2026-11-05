import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { methodBody } from './helpers/rendererSource';
import { MaterialSync, MATERIAL_VIEW_SIZE } from '../src/graphics/shaderOptimizer';

/**
 * Uniform writes that reach nothing, or re-send what the block already holds, are skipped — the writes
 * were most of the renderer's per-draw JS:
 *
 * - A landscape's material (eight vec4 arrays of surface data, ~600 floats) was re-written and re-compared
 *   for EVERY chunk — ~100 per landscape per pass, the largest uniform writer in the frame. It now goes
 *   through MaterialSync like every other material: same program, same material, same frame, same view
 *   values -> skipped.
 * - `beginModel` wrote the per-draw names (`u_model`, the UV transform, `u_dissolve`, `u_camHolePivot`,
 *   the bone palette) into programs that read the per-object table and declare none of them; a skinned
 *   draw copied its whole palette into a scratch nobody read. It now asks the program once which it has.
 */
const SRC = join(__dirname, '..', 'src', 'graphics');

describe('terrain material writes', () => {
    it('go through MaterialSync, once per landscape per frame', () => {
        const body = methodBody('applyTerrainProperties');
        expect(body).toMatch(/^\s*if \(!this\.sync\.needsWrite\(this\._shaderManager\.bound, material, this\._viewValues\(\)\)\) return;/m);
        expect(body).toMatch(/for \(const \[name, value\] of material\.properties\)/);
        expect(body).toMatch(/u_specularAA/);
    });

    it('leave no per-chunk property loop in the terrain draw', () => {
        const body = methodBody('_bindModelMaterial');
        const terrain = body.slice(body.indexOf("mat.type === 'terrain'"), body.indexOf('instanceof CustomMaterial'));
        expect(terrain).toContain('this._materials.applyTerrainProperties(mat)');
        expect(terrain).not.toMatch(/of mat\.properties/);
        // The pass-dependent writes stay outside the memo: a pass with self-shadow must not be skipped
        // because a pass without it wrote the same material first.
        expect(terrain.indexOf("'u_viewPos'")).toBeLessThan(terrain.indexOf('applyTerrainProperties'));
    });

    it('a chunk after the first skips; a second landscape, a new frame or a moved camera writes again', () => {
        const sync = new MaterialSync();
        const program = {}, landA = {}, landB = {};
        const view = new Float64Array(MATERIAL_VIEW_SIZE).fill(1);
        sync.beginFrame();
        expect(sync.needsWrite(program, landA, view)).toBe(true);
        expect(sync.needsWrite(program, landA, view)).toBe(false);
        expect(sync.needsWrite(program, landB, view)).toBe(true);
        expect(sync.needsWrite(program, landA, view)).toBe(true);
        sync.beginFrame();
        expect(sync.needsWrite(program, landA, view)).toBe(true);
        view[16] = 2;   // the eye moved (a probe face)
        expect(sync.needsWrite(program, landA, view)).toBe(true);
    });
});

describe('beginModel', () => {
    it('writes the per-draw names only into a program that declares them', () => {
        const body = methodBody('beginModel');
        expect(body).toMatch(/if \(declares\.model\) this\._shaderManager\.setUniform\('u_model'/);
        expect(body).toMatch(/if \(declares\.uv\) \{/);
        expect(body).toMatch(/setDissolve\(node\.effectiveFade, declares\.dissolve\)/);
        expect(body).toMatch(/setCameraHole\(node\.cameraDither, declares\.camHolePivot\)/);
        expect(body).toMatch(/if \(animated && declares\.bones\) this\.uploadBoneMatrices/);
    });

    it('asks hasUniform, which on WebGL2 must see block members too', () => {
        const shader = readFileSync(join(SRC, 'shader.ts'), 'utf-8');
        expect(shader).toMatch(/public hasUniform\(name: string\): boolean \{\s*return name in this\._uniforms \|\| \(this\._blocks\?\.has\(name\) \?\? false\);/);
    });

    it('still writes the per-pass names a table program reads', () => {
        const dissolve = methodBody('setDissolve');
        expect(dissolve).toMatch(/if \(legacy\) this\._shaderManager\.setUniform\('u_dissolve'/);
        expect(dissolve).toMatch(/setUniform\('u_ditherPhase', d\[1\]\);/);
        const hole = methodBody('setCameraHole');
        expect(hole).toMatch(/^\s*this\._shaderManager\.setUniform\('u_camHole', this\._camHole\);/m);
        expect(hole).toMatch(/setUniform\('u_camHolePass', q\);/);
    });
});
