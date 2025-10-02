import { Geometry } from "cleo";

export class GizmoGeometry {
    /**
     * Creates geometry for a 3D arrow pointing along the X axis
     */
    public static ArrowX(length: number = 1, headSize: number = 0.2): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const indices: number[] = [];

        const shaftLength = length - headSize;
        const shaftRadius = 0.05;
        const headRadius = 0.15;
        const segments = 8;

        // Create shaft cylinder - properly oriented along X axis
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

                // Normal points outward from the cylinder surface
                const normal: [number, number, number] = [0, cosTheta, sinTheta];

                positions.push([x, y, z]);
                normals.push(normal);
                uvs.push([u, v]);
            }
        }

        // Create arrow head cone
        const headStart = shaftLength;
        const headEnd = length;
        
        // Center of cone base
        positions.push([headStart, 0, 0]);
        normals.push([1, 0, 0]);
        uvs.push([0.5, 0.8]);

        // Cone base vertices
        for (let i = 0; i <= segments; i++) {
            const angle = (i / segments) * Math.PI * 2;
            const y = Math.cos(angle) * headRadius;
            const z = Math.sin(angle) * headRadius;

            positions.push([headStart, y, z]);
            normals.push([1, 0, 0]);
            uvs.push([0.5 + Math.cos(angle) * 0.2, 0.8 + Math.sin(angle) * 0.2]);
        }

        // Tip of cone
        positions.push([headEnd, 0, 0]);
        normals.push([1, 0, 0]);
        uvs.push([0.5, 1]);

        // Generate indices for shaft
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

        // Generate indices for cone base
        const coneBaseStart = (segments + 1) * 2;
        const coneBaseCenter = coneBaseStart;
        
        for (let i = 0; i < segments; i++) {
            const base = coneBaseStart + 1 + i;
            const next = coneBaseStart + 1 + ((i + 1) % (segments + 1));
            
            indices.push(coneBaseCenter, base, next);
        }

        // Generate indices for cone sides
        const coneTip = positions.length - 1;
        for (let i = 0; i < segments; i++) {
            const base = coneBaseStart + 1 + i;
            const next = coneBaseStart + 1 + ((i + 1) % (segments + 1));
            
            indices.push(base, coneTip, next);
        }

        return new Geometry(positions, normals, uvs, [], [], indices);
    }

    /**
     * Creates geometry for a 3D arrow pointing along the Y axis
     */
    public static ArrowY(length: number = 1, headSize: number = 0.2): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const indices: number[] = [];

        const shaftLength = length - headSize;
        const shaftRadius = 0.05;
        const headRadius = 0.15;
        const segments = 8;

        // Create shaft cylinder - properly oriented along Y axis
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

                // Normal points outward from the cylinder surface
                const normal: [number, number, number] = [cosTheta, 0, sinTheta];

                positions.push([x, y, z]);
                normals.push(normal);
                uvs.push([u, v]);
            }
        }

        // Create arrow head cone
        const headStart = shaftLength;
        const headEnd = length;
        
        // Center of cone base
        positions.push([0, headStart, 0]);
        normals.push([0, 1, 0]);
        uvs.push([0.5, 0.8]);

        // Cone base vertices
        for (let i = 0; i <= segments; i++) {
            const angle = (i / segments) * Math.PI * 2;
            const x = Math.cos(angle) * headRadius;
            const y = headStart;
            const z = Math.sin(angle) * headRadius;

            positions.push([x, y, z]);
            normals.push([0, 1, 0]);
            uvs.push([0.5 + Math.cos(angle) * 0.2, 0.8 + Math.sin(angle) * 0.2]);
        }

        // Tip of cone
        positions.push([0, headEnd, 0]);
        normals.push([0, 1, 0]);
        uvs.push([0.5, 1]);

        // Generate indices for shaft
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

        // Generate indices for cone base
        const coneBaseStart = (segments + 1) * 2;
        const coneBaseCenter = coneBaseStart;
        
        for (let i = 0; i < segments; i++) {
            const base = coneBaseStart + 1 + i;
            const next = coneBaseStart + 1 + ((i + 1) % (segments + 1));
            
            indices.push(coneBaseCenter, base, next);
        }

        // Generate indices for cone sides
        const coneTip = positions.length - 1;
        for (let i = 0; i < segments; i++) {
            const base = coneBaseStart + 1 + i;
            const next = coneBaseStart + 1 + ((i + 1) % (segments + 1));
            
            indices.push(base, coneTip, next);
        }

        return new Geometry(positions, normals, uvs, [], [], indices);
    }

    /**
     * Creates geometry for a 3D arrow pointing along the Z axis
     */
    public static ArrowZ(length: number = 1, headSize: number = 0.2): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const indices: number[] = [];

        const shaftLength = length - headSize;
        const shaftRadius = 0.05;
        const headRadius = 0.15;
        const segments = 8;

        // Create shaft cylinder - properly oriented along Z axis
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

                // Normal points outward from the cylinder surface
                const normal: [number, number, number] = [cosTheta, sinTheta, 0];

                positions.push([x, y, z]);
                normals.push(normal);
                uvs.push([u, v]);
            }
        }

        // Create arrow head cone
        const headStart = shaftLength;
        const headEnd = length;
        
        // Center of cone base
        positions.push([0, 0, headStart]);
        normals.push([0, 0, 1]);
        uvs.push([0.5, 0.8]);

        // Cone base vertices
        for (let i = 0; i <= segments; i++) {
            const angle = (i / segments) * Math.PI * 2;
            const x = Math.cos(angle) * headRadius;
            const y = Math.sin(angle) * headRadius;
            const z = headStart;

            positions.push([x, y, z]);
            normals.push([0, 0, 1]);
            uvs.push([0.5 + Math.cos(angle) * 0.2, 0.8 + Math.sin(angle) * 0.2]);
        }

        // Tip of cone
        positions.push([0, 0, headEnd]);
        normals.push([0, 0, 1]);
        uvs.push([0.5, 1]);

        // Generate indices for shaft
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

        // Generate indices for cone base
        const coneBaseStart = (segments + 1) * 2;
        const coneBaseCenter = coneBaseStart;
        
        for (let i = 0; i < segments; i++) {
            const base = coneBaseStart + 1 + i;
            const next = coneBaseStart + 1 + ((i + 1) % (segments + 1));
            
            indices.push(coneBaseCenter, base, next);
        }

        // Generate indices for cone sides
        const coneTip = positions.length - 1;
        for (let i = 0; i < segments; i++) {
            const base = coneBaseStart + 1 + i;
            const next = coneBaseStart + 1 + ((i + 1) % (segments + 1));
            
            indices.push(base, coneTip, next);
        }

        return new Geometry(positions, normals, uvs, [], [], indices);
    }

}
