import { DecalNode, markEditorOnly } from 'cleo'
import type { Node, Scene } from 'cleo'
import { brushCursorYaw, brushDecalBox, brushDecalStyle } from './brushDecal'
import type { BrushPlacement, BrushTerrain } from './brushDecal'

/** Whether `root` is among `node`'s ancestors — false for a node stranded under a root a parse swapped out. */
function isUnder(node: Node, root: Node): boolean {
    for (let n = node.parent; n; n = n.parent) if (n === root) return true
    return false
}

/**
 * The landscape brush cursor: an editor-only DecalNode projected onto the terrain under the mouse.
 *
 * It replaced a flat wireframe ring floating 5 cm above the hit point, which sank into every slope and
 * said nothing about the brush but its radius. A decal lies ON the ground whatever its shape — the
 * renderer projects it onto the depth under the box — and `receivers: 'terrain'` keeps it off rocks and
 * grass standing on that ground. Its radial pattern is the brush weight itself; see brushDecal.ts.
 *
 * EDITOR-OWNED, and every rule of that is kept here so the brush components cannot get it wrong:
 * the `__editor__` name (nothing it does marks a tab unsaved or reaches serialization); `markEditorOnly`
 * (drawn in the overlay layer as unlit chrome, past the post chain); built, shown, hidden and removed
 * only inside `withoutDirty` and only through the scene's addNode/removeNode (never `node.remove()`,
 * whose deferred sweep lands outside any bracket as a 'Delete' undo step); and `visible` written only on
 * a real change, because every write is a structural emit that re-traverses the scene and rebuilds the
 * tree — the hover path would otherwise pay that on every mousemove.
 */
export class BrushCursor {
    private decal: DecalNode | null = null
    /** Where the cursor was last shown, so a brush-settings change can restyle it without a mouse move. */
    private last: { terrain: BrushTerrain; point: [number, number, number] } | null = null

    constructor(private readonly editorScene: Scene,
                private readonly withoutDirty: <T>(fn: () => T) => T) {}

    /** The live decal, or null before the first show and after dispose. For tests and diagnostics. */
    public get node(): DecalNode | null { return this.decal }

    /** Show the cursor on `terrain` at the world-space `point`, shaped and styled for `brush`. */
    public show(terrain: BrushTerrain, point: ArrayLike<number>, brush: BrushPlacement): void {
        const decal = this.ensure()
        this.last = { terrain, point: [point[0], point[1], point[2]] }
        this.place(decal, terrain, this.last.point, brush)
        this.setShown(decal, true)
    }

    /**
     * Re-fit the VISIBLE cursor to new brush settings where it stands — a slider moved, the mouse did not.
     * A hidden cursor is left alone; the next show picks the settings up.
     */
    public restyle(brush: BrushPlacement): void {
        const decal = this.decal
        if (!decal || !decal.visible || !this.last) return
        this.place(decal, this.last.terrain, this.last.point, brush)
    }

    public hide(): void {
        if (this.decal) this.setShown(this.decal, false)
    }

    /** Remove the decal from its scene. Safe to call twice; a later show builds a fresh one. */
    public dispose(): void {
        const { editorScene, withoutDirty } = this
        const decal = this.decal
        this.decal = null
        this.last = null
        if (decal) withoutDirty(() => editorScene.removeNode(decal))
    }

    private ensure(): DecalNode {
        const { editorScene, withoutDirty } = this
        const current = this.decal
        // Only while it is still in the live tree. openScene parses INTO this same Scene object and swaps
        // its root, which strands the cursor under the old one — present, invisible, and never shown again.
        if (current && isUnder(current, editorScene.root)) return current
        return withoutDirty(() => {
            if (current) editorScene.removeNode(current) // stranded: detach it from the tree it is left in
            const decal = new DecalNode('__editor__terrainBrush', {
                pattern: 'radial',
                // Terrain only: the brush edits the heightfield, so a cursor painted over the rock or the
                // tree trunk in front of it would be showing a stroke that does not happen there.
                receivers: 'terrain',
                // Every slope and cliff under the brush is sculpted, so the cursor must land on all of
                // them — no angle fade — and it has no top or bottom to feather; the box is fitted.
                angleFade: 0,
                depthFade: 0,
            })
            markEditorOnly(decal)
            decal.visible = false
            editorScene.addNode(decal)
            this.decal = decal
            return decal
        })
    }

    private place(decal: DecalNode, terrain: BrushTerrain, point: [number, number, number], brush: BrushPlacement): void {
        const shape = brush.shape ?? 'circle'
        // The box must enclose all the ground the brush covers, or the gradient is cut off on slopes.
        const box = brushDecalBox(terrain, point, brush.radius, shape)
        decal.setPosition(box.center)
        decal.setRotation([0, shape === 'square' ? brushCursorYaw(brush.rotation ?? 0) : 0, 0])
        decal.size = [2 * brush.radius, box.height, 2 * brush.radius]
        decal.radial = brushDecalStyle(brush)
    }

    private setShown(decal: DecalNode, shown: boolean): void {
        const withoutDirty = this.withoutDirty
        if (decal.visible !== shown) withoutDirty(() => { decal.visible = shown })
    }
}
