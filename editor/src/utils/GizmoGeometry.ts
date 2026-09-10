import { Geometry } from "cleo";

/**
 * Geometry for the transform gizmo's handles.
 *
 * Every shape is built along **+Y** and the caller orients it with a single quaternion
 * (`quat.rotationTo([0,1,0], axis)`), which is why there is one arrow here rather than the three
 * near-identical hand-written copies this file used to hold — and why the ring can simply delegate to
 * the engine's own `Geometry.Torus`, which already lies in the XZ plane with a +Y normal.
 */
export class GizmoGeometry {
    /**
     * Concatenate parts, each shifted along Y. The engine's primitives are all centred on the origin, so
     * this is what lets a shaft and a head be assembled into one arrow without a per-part scene node.
     */
    private static join(parts: { geometry: Geometry; offsetY: number }[]): Geometry {
        let vertexCount = 0;
        let indexCount = 0;
        for (const part of parts) {
            vertexCount += part.geometry.positions.length / 3;
            indexCount += part.geometry.indices.length;
        }

        const positions = new Float32Array(vertexCount * 3);
        const normals = new Float32Array(vertexCount * 3);
        const uvs = new Float32Array(vertexCount * 2);
        const indices = new Uint32Array(indexCount);

        let vertex = 0;
        let index = 0;
        for (const { geometry, offsetY } of parts) {
            const count = geometry.positions.length / 3;
            for (let i = 0; i < count; i++) {
                positions[(vertex + i) * 3] = geometry.positions[i * 3];
                positions[(vertex + i) * 3 + 1] = geometry.positions[i * 3 + 1] + offsetY;
                positions[(vertex + i) * 3 + 2] = geometry.positions[i * 3 + 2];
            }
            normals.set(geometry.normals, vertex * 3);
            uvs.set(geometry.uvs, vertex * 2);
            for (let i = 0; i < geometry.indices.length; i++) indices[index + i] = geometry.indices[i] + vertex;

            vertex += count;
            index += geometry.indices.length;
        }

        // Tangents are meaningless for an unlit handle and cost a full pass over the buffer, so skip them.
        return new Geometry(positions, normals, uvs, [], [], indices, false);
    }

    /**
     * Arrow along +Y with its tail at the origin: the move handle.
     *
     * @param length     Tip distance from the origin.
     * @param thickness  Cross-section gain. Only the radii scale: the tip has to stay on the end of the
     *                   segment `gizmoPick` tests, so a hover shape may get fatter but never longer.
     * @param headLength Length of the cone, measured back from the tip.
     */
    public static Arrow(length = 1, thickness = 1, headLength = 0.25, shaftRadius = 0.016, headRadius = 0.055): Geometry {
        const shaft = Math.max(length - headLength, 1e-4);
        // The head grows at less than half the shaft's rate, or a thickened arrow ends in a blob.
        const headGain = 1 + (thickness - 1) * 0.4;
        return this.join([
            { geometry: Geometry.Cylinder(12, shaftRadius * thickness, shaft), offsetY: shaft / 2 },
            { geometry: Geometry.Cone(16, headRadius * headGain, headLength), offsetY: length - headLength / 2 },
        ]);
    }

    /**
     * Shaft along +Y capped with a cube: the scale handle. Same proportions as {@link Arrow}, so the two
     * modes read as the same gizmo with a different grip.
     */
    public static ScaleArm(length = 1, thickness = 1, boxSize = 0.09, shaftRadius = 0.016): Geometry {
        const box = boxSize * (1 + (thickness - 1) * 0.4);
        // Measured off the RESTING box, so the shaft's length — and therefore where the cap sits — does
        // not move when the handle thickens under the cursor.
        const shaft = Math.max(length - boxSize, 1e-4);
        return this.join([
            { geometry: Geometry.Cylinder(12, shaftRadius * thickness, shaft), offsetY: shaft / 2 },
            { geometry: Geometry.Cube(box, box, box), offsetY: length - boxSize / 2 },
        ]);
    }

    /**
     * Rotation ring in the XZ plane, i.e. turning about +Y, with a tube that swells toward its local **+X**.
     *
     * `placementFor` rolls the ring every frame so +X points at the viewer, which makes the near arc —
     * the only half `gizmoPick` will let you grab, since a hit on the far rim is rejected — visibly the
     * heavier one. A constant-tube torus (what this used to delegate to `Geometry.Torus` for) gave both
     * halves the same weight, so the rim you cannot click looked exactly as grabbable as the one you can.
     *
     * @param thickness Overall tube gain, on top of the near/far shaping below: the hover shape.
     * @param nearGain Tube multiplier at the arc facing the camera.
     * @param farGain  Tube multiplier at the arc behind the gizmo; the two are blended by cos of the
     *                 ring angle, so the thickness sweeps smoothly across the silhouette rather than
     *                 stepping at the halfway point.
     */
    public static Ring(radius = 1, thickness = 1, tube = 0.014, nearGain = 1.9, farGain = 0.7): Geometry {
        const radialSegments = 64;
        const tubularSegments = 8;

        const vertexCount = (radialSegments + 1) * (tubularSegments + 1);
        const positions = new Float32Array(vertexCount * 3);
        const normals = new Float32Array(vertexCount * 3);
        const uvs = new Float32Array(vertexCount * 2);
        const indices = new Uint32Array(radialSegments * tubularSegments * 6);

        let vertex = 0;
        for (let i = 0; i <= radialSegments; i++) {
            const u = (i / radialSegments) * 2 * Math.PI;
            const cosU = Math.cos(u), sinU = Math.sin(u);
            // u = 0 sits on local +X, so this is 1 at the near arc and 0 at the far one.
            const nearness = 0.5 + 0.5 * cosU;
            const t = tube * thickness * (farGain + (nearGain - farGain) * nearness);

            for (let j = 0; j <= tubularSegments; j++) {
                const v = (j / tubularSegments) * 2 * Math.PI;
                const cosV = Math.cos(v), sinV = Math.sin(v);

                positions[vertex * 3] = (radius + t * cosV) * cosU;
                positions[vertex * 3 + 1] = t * sinV;
                positions[vertex * 3 + 2] = (radius + t * cosV) * sinU;
                // The offset from the tube's centre circle. Exact only for a constant tube, but these
                // handles draw with the unlit Basic material, which never reads a normal.
                normals[vertex * 3] = cosV * cosU;
                normals[vertex * 3 + 1] = sinV;
                normals[vertex * 3 + 2] = cosV * sinU;
                uvs[vertex * 2] = i / radialSegments;
                uvs[vertex * 2 + 1] = j / tubularSegments;
                vertex++;
            }
        }

        let index = 0;
        for (let i = 0; i < radialSegments; i++)
            for (let j = 0; j < tubularSegments; j++) {
                const k1 = i * (tubularSegments + 1) + j;
                const k2 = k1 + tubularSegments + 1;
                indices[index++] = k1; indices[index++] = k1 + 1; indices[index++] = k2;
                indices[index++] = k1 + 1; indices[index++] = k2 + 1; indices[index++] = k2;
            }

        return new Geometry(positions, normals, uvs, [], [], indices, false);
    }

    /**
     * Square in the XZ plane (normal +Y) with one corner at the origin, extending along +X and +Z: the
     * two-axis plane handle. Cornered rather than centred so the caller places it by pushing the corner
     * out along both axes, which is also how {@link import('../features/gizmo/gizmoPick').planeQuadGeometry}
     * describes it for picking.
     */
    public static PlaneQuad(size = 0.36): Geometry {
        const positions = [0, 0, 0, size, 0, 0, size, 0, size, 0, 0, size];
        const normals = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
        const uvs = [0, 0, 1, 0, 1, 1, 0, 1];
        // Both windings, so the quad reads the same from either side — it is chrome, not shaded geometry.
        const indices = [0, 1, 2, 0, 2, 3, 0, 2, 1, 0, 3, 2];
        return new Geometry(positions, normals, uvs, [], [], indices, false);
    }

    /** Centre handle: uniform scale in scale mode, screen-space drag in move mode. */
    public static Centre(radius = 0.09): Geometry {
        return Geometry.Sphere(16, radius);
    }
}
