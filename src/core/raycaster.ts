import { vec3, mat4 } from "gl-matrix";
import { Node } from "./scene/nodes/node";
import { isUINodeType } from "./scene/nodes/nodeType";
import { Camera } from "./camera";
import { BVH } from "./bvh";
import { rayBoxIntersection } from "./math";

export interface Ray {
    origin: vec3;
    direction: vec3;
}

export interface RaycastHit {
    node: Node;
    distance: number;
    point: vec3;
}

export class Raycaster {
    /** Creates a ray from screen coordinates. */
    public static screenToRay(
        screenX: number, 
        screenY: number, 
        screenWidth: number, 
        screenHeight: number, 
        camera: Camera
    ): Ray {
        const x = (2.0 * screenX) / screenWidth - 1.0;
        const y = 1.0 - (2.0 * screenY) / screenHeight;
        
        const rayOrigin = vec3.create();
        const rayDirection = vec3.create();
        
        if (camera.type === 'perspective') {
            rayOrigin[0] = 0;
            rayOrigin[1] = 0;
            rayOrigin[2] = 0;
            
            const fovRad = (camera.fov * Math.PI) / 180;
            const aspect = screenWidth / screenHeight;
            const tanHalfFov = Math.tan(fovRad / 2);
            
            rayDirection[0] = x * tanHalfFov * aspect;
            rayDirection[1] = y * tanHalfFov;
            rayDirection[2] = -1.0;
            vec3.normalize(rayDirection, rayDirection);
        } else {
            // Orthographic: parallel rays offset across the view plane, not fanned out from a point. The
            // horizontal extents MUST take the same aspect scaling Camera.projectionMatrix applies —
            // left/right multiplied by `ratio`, top/bottom untouched.
            const left = camera.left * camera.ratio;
            const right = camera.right * camera.ratio;
            // Interpolated across the frustum rather than centred on 0, so an asymmetric one picks right too.
            rayOrigin[0] = left + ((x + 1) / 2) * (right - left);
            rayOrigin[1] = camera.bottom + ((y + 1) / 2) * (camera.top - camera.bottom);
            rayOrigin[2] = 0;

            rayDirection[0] = 0;
            rayDirection[1] = 0;
            rayDirection[2] = -1.0;
        }
        
        const viewMatrix = camera.viewMatrix;
        const invViewMatrix = mat4.create();
        mat4.invert(invViewMatrix, viewMatrix);
        
        const worldOrigin = vec3.create();
        const worldDirection = vec3.create();
        
        vec3.transformMat4(worldOrigin, rayOrigin, invViewMatrix);
        
        // A direction transforms by rotation only, so the translation column is stripped.
        const rotationMatrix = mat4.create();
        mat4.copy(rotationMatrix, invViewMatrix);
        rotationMatrix[12] = 0;
        rotationMatrix[13] = 0;
        rotationMatrix[14] = 0;
        
        vec3.transformMat4(worldDirection, rayDirection, rotationMatrix);
        vec3.normalize(worldDirection, worldDirection);
        
        return {
            origin: worldOrigin,
            direction: worldDirection
        };
    }
    
    /** Bounding box for any node, via the node's own getBoundingBox. */
    private static getBoundingBox(node: Node): { min: vec3, max: vec3 } {
        // A node may pick by a box other than its bounds: a DecalNode (its bounds are a projection volume
        // that encloses what it lands on) and a NavMeshNode (its bake volume spans the level), whose
        // volumes would swallow every click aimed at what is inside them. Both pick by their icon. Duck-typed
        // so this module does not import a node class (the node graph is full of cycles).
        const pickBox = (node as { pickBox?: () => { min: vec3, max: vec3 } }).pickBox;
        return pickBox ? pickBox.call(node) : node.getBoundingBox();
    }
    
    /**
     * Performs a raycast against a set of nodes. Broad phase is ray-vs-AABB per node; where a node
     * exposes a BVH (`node.getBVH()`) the hit is refined against the actual triangles. Nodes without
     * one (sprites, lights, skinned meshes) keep AABB-granularity hits.
     *
     * @param precise set to false to force AABB-only picking (skip the BVH narrow phase).
     */
    public static raycast(
        ray: Ray,
        nodes: Node[],
        maxDistance: number = Infinity,
        precise: boolean = true
    ): RaycastHit[] {
        const hits: RaycastHit[] = [];

        for (const node of nodes) {
            if (!node.visible) continue;

            // Editor helpers (gizmos excepted), terrain, tilemaps and UI are never world-ray picked:
            // terrain and tilemaps are picked analytically by their own subsystems, UI in SCREEN space
            // against its resolved rect. Their AABBs here would swallow unrelated clicks.
            if ((node.name.startsWith('__editor__') && !node.name.includes('gizmo')) ||
                node.name.startsWith('__debug__') ||
                node.name.startsWith('__terrain_chunk__') ||
                node.nodeType === 'landscape' ||
                node.nodeType === 'tilemap' ||
                isUINodeType(node.nodeType)) {
                continue;
            }

            const boundingBox = this.getBoundingBox(node);
            const distance = rayBoxIntersection(ray.origin, ray.direction, boundingBox.min, boundingBox.max);
            if (distance === null || distance <= 0 || distance >= maxDistance) continue;

            const bvh = precise ? node.getBVH() : null;
            if (bvh) {
                const preciseDistance = this.raycastBVH(ray, node, bvh);
                if (preciseDistance === null || preciseDistance >= maxDistance) continue;
                const hitPoint = vec3.create();
                vec3.scaleAndAdd(hitPoint, ray.origin, ray.direction, preciseDistance);
                hits.push({ node, distance: preciseDistance, point: hitPoint });
            } else {
                const hitPoint = vec3.create();
                vec3.scaleAndAdd(hitPoint, ray.origin, ray.direction, distance);
                hits.push({ node, distance, point: hitPoint });
            }
        }

        hits.sort((a, b) => a.distance - b.distance);
        return hits;
    }

    /**
     * Refines a hit against a node's object-space BVH. Returns the world-space distance of the nearest
     * triangle hit, or null when the ray misses the geometry.
     */
    private static raycastBVH(ray: Ray, node: Node, bvh: BVH): number | null {
        const inv = mat4.create();
        // Singular transform (e.g. zero scale) → can't invert; fall back to the AABB distance.
        if (!mat4.invert(inv, node.worldTransform)) {
            const box = node.getBoundingBox();
            return rayBoxIntersection(ray.origin, ray.direction, box.min, box.max);
        }

        // Origin transforms as a point, direction as a vector with translation stripped but scale KEPT
        // and never renormalized: that is what makes `hit.t` already a world-space distance.
        const localOrigin = vec3.transformMat4(vec3.create(), ray.origin, inv);
        const rotOnly = mat4.clone(inv);
        rotOnly[12] = 0; rotOnly[13] = 0; rotOnly[14] = 0;
        const localDir = vec3.transformMat4(vec3.create(), ray.direction, rotOnly);

        const hit = bvh.raycast(localOrigin, localDir);
        if (!hit) return null;

        return hit.t;
    }
}
