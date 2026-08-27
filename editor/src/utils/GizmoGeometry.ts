import { Geometry } from "cleo";

export class GizmoGeometry {
    /**
     * Torus (ring) in the plane perpendicular to `axis` — the rotation-gizmo handle for that axis.
     * `radius` is the major radius (matches the arrow length); `tube` is the tube thickness, kept thin
     * enough to read as a ring but thick enough to give a pickable bounding box.
     */
    private static torus(axis: 'x' | 'y' | 'z', radius: number, tube: number, majorSeg = 32, minorSeg = 6): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const indices: number[] = [];

        for (let i = 0; i <= majorSeg; i++) {
            const u = (i / majorSeg) * Math.PI * 2;
            const cu = Math.cos(u), su = Math.sin(u);
            for (let j = 0; j <= minorSeg; j++) {
                const v = (j / minorSeg) * Math.PI * 2;
                const cv = Math.cos(v), sv = Math.sin(v);
                const rr = radius + tube * cv;
                let p: [number, number, number];
                let n: [number, number, number];
                if (axis === 'z') { p = [rr * cu, rr * su, tube * sv]; n = [cv * cu, cv * su, sv]; }
                else if (axis === 'y') { p = [rr * cu, tube * sv, rr * su]; n = [cv * cu, sv, cv * su]; }
                else { p = [tube * sv, rr * cu, rr * su]; n = [sv, cv * cu, cv * su]; }
                positions.push(p);
                normals.push(n);
                uvs.push([i / majorSeg, j / minorSeg]);
            }
        }

        const stride = minorSeg + 1;
        for (let i = 0; i < majorSeg; i++) {
            for (let j = 0; j < minorSeg; j++) {
                const a = i * stride + j;
                const b = (i + 1) * stride + j;
                const c = (i + 1) * stride + (j + 1);
                const d = i * stride + (j + 1);
                indices.push(a, b, d);
                indices.push(b, c, d);
            }
        }
        return new Geometry(positions, normals, uvs, [], [], indices);
    }

    /** Rotation ring in the YZ plane (rotates about the X axis). */
    public static RingX(radius: number = 1, tube: number = 0.04): Geometry { return this.torus('x', radius, tube); }
    /** Rotation ring in the XZ plane (rotates about the Y axis). */
    public static RingY(radius: number = 1, tube: number = 0.04): Geometry { return this.torus('y', radius, tube); }
    /** Rotation ring in the XY plane (rotates about the Z axis). */
    public static RingZ(radius: number = 1, tube: number = 0.04): Geometry { return this.torus('z', radius, tube); }

    /** Geometry for a 3D arrow pointing along the X axis. */
    public static ArrowX(length: number = 1, headSize: number = 0.2): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const indices: number[] = [];

        const shaftLength = length - headSize;
        const shaftRadius = 0.05;
        const headRadius = 0.15;
        const segments = 8;

        for (let i = 0; i <= segments; i++) {
            const theta = (i / segments) * 2 * Math.PI;
            const sinTheta = Math.sin(theta);
            const cosTheta = Math.cos(theta);

            for (let j = 0; j <= 1; j++) {
                const sign = j === 0 ? 0 : 1; // Switch between start and end
                const x = sign * shaftLength;
                const y = cosTheta * shaftRadius;
                const z = sinTheta * shaftRadius;

                const u = i / segments;
                const v = sign; // Map start to 0 and end to 1

                const normal: [number, number, number] = [0, cosTheta, sinTheta];

                positions.push([x, y, z]);
                normals.push(normal);
                uvs.push([u, v]);
            }
        }

        const headStart = shaftLength;
        const headEnd = length;
        
        positions.push([headStart, 0, 0]);
        normals.push([1, 0, 0]);
        uvs.push([0.5, 0.8]);

        for (let i = 0; i <= segments; i++) {
            const angle = (i / segments) * Math.PI * 2;
            const y = Math.cos(angle) * headRadius;
            const z = Math.sin(angle) * headRadius;

            positions.push([headStart, y, z]);
            normals.push([1, 0, 0]);
            uvs.push([0.5 + Math.cos(angle) * 0.2, 0.8 + Math.sin(angle) * 0.2]);
        }

        positions.push([headEnd, 0, 0]);
        normals.push([1, 0, 0]);
        uvs.push([0.5, 1]);

        for (let i = 0; i < segments; i++) {
            for (let j = 0; j < 1; j++) {
                const k1 = i * 2 + j;
                const k2 = k1 + 2;

                indices.push(k1);
                indices.push(k1 + 1);
                indices.push(k2);

                indices.push(k2);
                indices.push(k1 + 1);
                indices.push(k2 + 1);
            }
        }

        const coneBaseStart = (segments + 1) * 2;
        const coneBaseCenter = coneBaseStart;
        
        for (let i = 0; i < segments; i++) {
            const base = coneBaseStart + 1 + i;
            const next = coneBaseStart + 1 + ((i + 1) % (segments + 1));
            
            indices.push(coneBaseCenter, base, next);
        }

        const coneTip = positions.length - 1;
        for (let i = 0; i < segments; i++) {
            const base = coneBaseStart + 1 + i;
            const next = coneBaseStart + 1 + ((i + 1) % (segments + 1));
            
            indices.push(base, coneTip, next);
        }

        return new Geometry(positions, normals, uvs, [], [], indices);
    }

    /** Geometry for a 3D arrow pointing along the Y axis. */
    public static ArrowY(length: number = 1, headSize: number = 0.2): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const indices: number[] = [];

        const shaftLength = length - headSize;
        const shaftRadius = 0.05;
        const headRadius = 0.15;
        const segments = 8;

        for (let i = 0; i <= segments; i++) {
            const theta = (i / segments) * 2 * Math.PI;
            const sinTheta = Math.sin(theta);
            const cosTheta = Math.cos(theta);

            for (let j = 0; j <= 1; j++) {
                const sign = j === 0 ? 0 : 1; // Switch between start and end
                const x = cosTheta * shaftRadius;
                const y = sign * shaftLength;
                const z = sinTheta * shaftRadius;

                const u = i / segments;
                const v = sign; // Map start to 0 and end to 1

                const normal: [number, number, number] = [cosTheta, 0, sinTheta];

                positions.push([x, y, z]);
                normals.push(normal);
                uvs.push([u, v]);
            }
        }

        const headStart = shaftLength;
        const headEnd = length;
        
        positions.push([0, headStart, 0]);
        normals.push([0, 1, 0]);
        uvs.push([0.5, 0.8]);

        for (let i = 0; i <= segments; i++) {
            const angle = (i / segments) * Math.PI * 2;
            const x = Math.cos(angle) * headRadius;
            const y = headStart;
            const z = Math.sin(angle) * headRadius;

            positions.push([x, y, z]);
            normals.push([0, 1, 0]);
            uvs.push([0.5 + Math.cos(angle) * 0.2, 0.8 + Math.sin(angle) * 0.2]);
        }

        positions.push([0, headEnd, 0]);
        normals.push([0, 1, 0]);
        uvs.push([0.5, 1]);

        for (let i = 0; i < segments; i++) {
            for (let j = 0; j < 1; j++) {
                const k1 = i * 2 + j;
                const k2 = k1 + 2;

                indices.push(k1);
                indices.push(k1 + 1);
                indices.push(k2);

                indices.push(k2);
                indices.push(k1 + 1);
                indices.push(k2 + 1);
            }
        }

        const coneBaseStart = (segments + 1) * 2;
        const coneBaseCenter = coneBaseStart;
        
        for (let i = 0; i < segments; i++) {
            const base = coneBaseStart + 1 + i;
            const next = coneBaseStart + 1 + ((i + 1) % (segments + 1));
            
            indices.push(coneBaseCenter, base, next);
        }

        const coneTip = positions.length - 1;
        for (let i = 0; i < segments; i++) {
            const base = coneBaseStart + 1 + i;
            const next = coneBaseStart + 1 + ((i + 1) % (segments + 1));
            
            indices.push(base, coneTip, next);
        }

        return new Geometry(positions, normals, uvs, [], [], indices);
    }

    /** Geometry for a 3D arrow pointing along the Z axis. */
    public static ArrowZ(length: number = 1, headSize: number = 0.2): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const indices: number[] = [];

        const shaftLength = length - headSize;
        const shaftRadius = 0.05;
        const headRadius = 0.15;
        const segments = 8;

        for (let i = 0; i <= segments; i++) {
            const theta = (i / segments) * 2 * Math.PI;
            const sinTheta = Math.sin(theta);
            const cosTheta = Math.cos(theta);

            for (let j = 0; j <= 1; j++) {
                const sign = j === 0 ? 0 : 1; // Switch between start and end
                const x = cosTheta * shaftRadius;
                const y = sinTheta * shaftRadius;
                const z = sign * shaftLength;

                const u = i / segments;
                const v = sign; // Map start to 0 and end to 1

                const normal: [number, number, number] = [cosTheta, sinTheta, 0];

                positions.push([x, y, z]);
                normals.push(normal);
                uvs.push([u, v]);
            }
        }

        const headStart = shaftLength;
        const headEnd = length;
        
        positions.push([0, 0, headStart]);
        normals.push([0, 0, 1]);
        uvs.push([0.5, 0.8]);

        for (let i = 0; i <= segments; i++) {
            const angle = (i / segments) * Math.PI * 2;
            const x = Math.cos(angle) * headRadius;
            const y = Math.sin(angle) * headRadius;
            const z = headStart;

            positions.push([x, y, z]);
            normals.push([0, 0, 1]);
            uvs.push([0.5 + Math.cos(angle) * 0.2, 0.8 + Math.sin(angle) * 0.2]);
        }

        positions.push([0, 0, headEnd]);
        normals.push([0, 0, 1]);
        uvs.push([0.5, 1]);

        for (let i = 0; i < segments; i++) {
            for (let j = 0; j < 1; j++) {
                const k1 = i * 2 + j;
                const k2 = k1 + 2;

                indices.push(k1);
                indices.push(k1 + 1);
                indices.push(k2);

                indices.push(k2);
                indices.push(k1 + 1);
                indices.push(k2 + 1);
            }
        }

        const coneBaseStart = (segments + 1) * 2;
        const coneBaseCenter = coneBaseStart;
        
        for (let i = 0; i < segments; i++) {
            const base = coneBaseStart + 1 + i;
            const next = coneBaseStart + 1 + ((i + 1) % (segments + 1));
            
            indices.push(coneBaseCenter, base, next);
        }

        const coneTip = positions.length - 1;
        for (let i = 0; i < segments; i++) {
            const base = coneBaseStart + 1 + i;
            const next = coneBaseStart + 1 + ((i + 1) % (segments + 1));
            
            indices.push(base, coneTip, next);
        }

        return new Geometry(positions, normals, uvs, [], [], indices);
    }

}
