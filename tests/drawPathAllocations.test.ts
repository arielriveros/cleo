import { describe, it, expect } from 'vitest';
import { methodBody, expectAbsent, rendererSource } from './helpers/rendererSource';

/**
 * The per-draw paths keep what they build per draw to nothing that a constant or a reused object can
 * replace (the CPU side of draw submission is the largest bucket in a frame). Read from the source, as
 * the other renderer-shape tests are: a regression here is a fresh allocation per draw, which no
 * functional test would notice.
 */
describe('the model draw paths', () => {
    it('hand the submesh loop a callback bound once, not a closure per draw', () => {
        expect(methodBody('_drawGeometryNode')).toContain('this._modelDraw.drawSubmeshes(node, this._bindMaterial, pass)');
        expect(methodBody('renderModel')).toContain('this._modelDraw.drawSubmeshes(node, this._bindMaterial, pass)');
        expectAbsent(methodBody('_drawGeometryNode'), 'drawSubmeshes(node, (mat)', 'drawSubmeshes(node, this._bindMaterial');
        expectAbsent(methodBody('renderModel'), 'drawSubmeshes(node, mat =>', 'drawSubmeshes(node, this._bindMaterial');
    });

    it('sort the opaque queue by a static comparator over pooled records', () => {
        const body = methodBody('geometryPass');
        expect(body).toContain('list.sort(GeometryPass._bySortKey)');
        expectAbsent(body, 'sortKey.get(a)', 'list.sort(GeometryPass._bySortKey)');
    });

    it('key instanced groups by number, not by a string built per node', () => {
        const body = methodBody('geometryPass');
        expect(body).toContain('* INSTANCE_KEY_SPAN +');
        expectAbsent(body, '}|${this._modelDraw.objectId(mat)}', '* INSTANCE_KEY_SPAN +');
    });

    it('pass shared depth states, never a literal per draw', () => {
        const source = rendererSource();
        expectAbsent(source, "depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' }",
                     'depthStencil: DEPTH_WRITE');
        expectAbsent(source, 'depthWriteEnabled: this.forwardDepthWrite', 'this.forwardDepthWrite ? DEPTH_WRITE : DEPTH_TEST');
    });
});
