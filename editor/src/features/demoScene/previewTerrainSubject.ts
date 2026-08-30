import { Scene, Terrain, TerrainMaterial, LandscapeNode } from 'cleo';
import { PREVIEW_TERRAIN_SIZE, REFERENCE_LANDSCAPE } from './previewFraming';

/**
 * The subject of a terrain-material preview: a real patch of terrain carrying the material as layer 0.
 *
 * It used to be a sphere borrowing the helper terrain's composite `Material`, and that stopped working
 * the moment terrain relief became geometry — a sphere has no terrain vertices to displace. Adding a
 * real `LandscapeNode` fixes three things at once, and the other two are less obvious than the first.
 * It puts the terrain into `scene.landscapes`, which is the list the renderer iterates for
 * `syncPackedLayers` — and that is what RETRIES the normal+height pack while the images decode (a
 * borrowed material resolved its pack exactly once, synchronously, and got whatever had loaded by then),
 * and what keeps `TexturePacker.sweep` from collecting the pack out from under a preview that never
 * refreshes its `lastFrame`.
 *
 * SCALED TO THE LANDSCAPE IT WILL BE USED ON, which is the part that was wrong and the reason relief
 * looked convincing here and vanished on the ground. The patch is 8 m; a landscape is 200. Tiling the
 * material the same NUMBER of times on both made one repeat 0.4 m wide here and 10 m wide there, so the
 * same 5 cm of authored depth read as pronounced relief in this window and as a half-percent grade on
 * the terrain — a factor of twenty-five, in the one picture an author uses to judge the number.
 *
 * So the REPEAT is matched instead of the tile count: one repeat covers the same metres here as on the
 * landscape, which is what makes the depth slider mean the same thing in both places. A second match on
 * metres-per-VERTEX used to matter too, back when a layer's height map was split between the terrain's
 * vertices and the march and the preview had to resolve the same cut; relief is entirely marched now,
 * so the vertex grid only has to be fine enough to be a surface.
 */
export function buildTerrainPreviewSubject(scene: Scene, tm: TerrainMaterial,
                                           reference?: Terrain | null): LandscapeNode {
    // The real landscape when there is one, and the documented defaults when there is not. A material
    // being authored before any terrain exists still has to be judged against something.
    const size = reference ? reference.size : REFERENCE_LANDSCAPE.size;
    const spacing = reference
        ? reference.size / Math.max(1, reference.resolution - 1)
        : REFERENCE_LANDSCAPE.size / (REFERENCE_LANDSCAPE.resolution - 1);

    // Enough vertices to span the patch at the landscape's own spacing. Clamped at both ends: too few
    // and the patch is not a surface, too many and a preview costs more than the terrain it previews.
    const quads = Math.max(8, Math.min(128, Math.round(PREVIEW_TERRAIN_SIZE / spacing)));
    const terrain = new Terrain({
        size: PREVIEW_TERRAIN_SIZE, resolution: quads + 1, chunkQuads: quads,
    });

    // The tiling that puts one repeat at the same number of METRES it would cover on the landscape.
    // Not the material's own number, which is a count across a terrain of a different size, and not 1,
    // which an earlier preview pinned and which hid every tiling-dependent bug there is.
    //
    // `auto` stays off: the height/slope mask depends on where the layer sits in a real landscape, and a
    // preview that masked itself out would look broken rather than informative.
    terrain.setLayer(0, tm, { auto: false, tiling: tm.tiling * PREVIEW_TERRAIN_SIZE / Math.max(size, 1e-6) });
    const node = new LandscapeNode('preview', terrain);
    scene.addNode(node);
    return node;
}
