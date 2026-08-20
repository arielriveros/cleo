import { vec3, mat4 } from "gl-matrix";
import { Node } from "./scene/nodes/node";
import { isUINodeType } from "./scene/nodes/nodeType";
import { Camera } from "./camera";
import { BVH } from "./bvh";

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
    /**
     * Creates a ray from screen coordinates
     */
    public static screenToRay(
        screenX: number, 
        screenY: number, 
        screenWidth: number, 
        screenHeight: number, 
        camera: Camera
    ): Ray {
        // Convert screen coordinates to normalized device coordinates
        const x = (2.0 * screenX) / screenWidth - 1.0;
        const y = 1.0 - (2.0 * screenY) / screenHeight;
        
        // Create ray in camera space
        const rayOrigin = vec3.create();
        const rayDirection = vec3.create();
        
        if (camera.type === 'perspective') {
            // For perspective camera - ray starts at camera position
            rayOrigin[0] = 0;
            rayOrigin[1] = 0;
            rayOrigin[2] = 0;
            
            // Calculate ray direction using the camera's field of view
            const fovRad = (camera.fov * Math.PI) / 180;
            const aspect = screenWidth / screenHeight;
            const tanHalfFov = Math.tan(fovRad / 2);
            
            rayDirection[0] = x * tanHalfFov * aspect;
            rayDirection[1] = y * tanHalfFov;
            rayDirection[2] = -1.0;
            vec3.normalize(rayDirection, rayDirection);
        } else {
            // Orthographic: parallel rays offset across the view plane, not fanned out from a point.
            //
            // The horizontal extents MUST go through the same aspect scaling the projection applies —
            // Camera.projectionMatrix multiplies left/right by `ratio` and leaves top/bottom alone. Without
            // it the picked X came out short by exactly the aspect factor: correct on the vertical
            // centre-line and drifting further out toward each edge, which is what made tile painting in a
            // 2D scene land away from the cursor.
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
        
        // Transform ray to world space
        const viewMatrix = camera.viewMatrix;
        const invViewMatrix = mat4.create();
        mat4.invert(invViewMatrix, viewMatrix);
        
        const worldOrigin = vec3.create();
        const worldDirection = vec3.create();
        
        // Transform ray origin to world space
        vec3.transformMat4(worldOrigin, rayOrigin, invViewMatrix);
        
        // Transform ray direction to world space
        // For direction vectors, we only apply rotation (no translation)
        const rotationMatrix = mat4.create();
        mat4.copy(rotationMatrix, invViewMatrix);
        // Remove translation part
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
    
    /**
     * Performs ray-sphere intersection test
     */
    private static raySphereIntersection(
        ray: Ray, 
        center: vec3, 
        radius: number
    ): number | null {
        const oc = vec3.create();
        vec3.subtract(oc, ray.origin, center);
        
        const a = vec3.dot(ray.direction, ray.direction);
        const b = 2.0 * vec3.dot(oc, ray.direction);
        const c = vec3.dot(oc, oc) - radius * radius;
        
        const discriminant = b * b - 4 * a * c;
        
        if (discriminant < 0) {
            return null;
        }
        
        const t1 = (-b - Math.sqrt(discriminant)) / (2 * a);
        const t2 = (-b + Math.sqrt(discriminant)) / (2 * a);
        
        if (t1 > 0) return t1;
        if (t2 > 0) return t2;
        return null;
    }
    
    /**
     * Performs ray-box intersection test (AABB)
     */
    private static rayBoxIntersection(
        ray: Ray, 
        min: vec3, 
        max: vec3
    ): number | null {
        let tMin = -Infinity;
        let tMax = Infinity;
        
        for (let i = 0; i < 3; i++) {
            if (Math.abs(ray.direction[i]) < 1e-8) {
                // Ray is parallel to the plane
                if (ray.origin[i] < min[i] || ray.origin[i] > max[i]) {
                    return null;
                }
            } else {
                const t1 = (min[i] - ray.origin[i]) / ray.direction[i];
                const t2 = (max[i] - ray.origin[i]) / ray.direction[i];
                
                const tNear = Math.min(t1, t2);
                const tFar = Math.max(t1, t2);
                
                tMin = Math.max(tMin, tNear);
                tMax = Math.min(tMax, tFar);
                
                if (tMin > tMax) {
                    return null;
                }
            }
        }
        
        if (tMax < 0) {
            return null;
        }
        
        return tMin > 0 ? tMin : tMax;
    }
    
    /**
     * Calculates bounding box for any node using the node's getBoundingBox method
     */
    private static getBoundingBox(node: Node): { min: vec3, max: vec3 } {
        return node.getBoundingBox();
    }
    
    /**
     * Performs a raycast against a set of nodes.
     *
     * Broad phase: ray-vs-AABB per node (`node.getBoundingBox()`). Narrow phase: when a node exposes
     * a Bounding Volume Hierarchy (`node.getBVH()`, e.g. static meshes) the ray is refined against
     * the actual triangles, so clicks inside a loose bounding box but off the geometry miss. Nodes
     * without a BVH (sprites, lights, skinned meshes) keep AABB-granularity hits.
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

            // Skip editor/debug helper nodes (but keep gizmos raycastable), terrain, tilemaps and UI.
            // Terrain and tilemaps are picked analytically by their own subsystems rather than by
            // ray/AABB — and a tilemap's box spans everything it has ever painted, so without this skip
            // it would swallow every click in a 2D scene.
            //
            // UI nodes are skipped because they are picked in SCREEN space, against their resolved rect,
            // by the UI layer. They are not merely irrelevant to a world ray: `Node.getBoundingBox`
            // falls back to a unit cube at the node's world position, so an entire HUD would otherwise
            // be a stack of 1x1x1 boxes sitting at the origin — exactly where new nodes are created,
            // swallowing clicks meant for whatever is actually there.
            if ((node.name.startsWith('__editor__') && !node.name.includes('gizmo')) ||
                node.name.startsWith('__debug__') ||
                node.name.startsWith('__terrain_chunk__') ||
                node.nodeType === 'landscape' ||
                node.nodeType === 'tilemap' ||
                isUINodeType(node.nodeType)) {
                continue;
            }

            const boundingBox = this.getBoundingBox(node);
            const distance = this.rayBoxIntersection(ray, boundingBox.min, boundingBox.max);
            if (distance === null || distance <= 0 || distance >= maxDistance) continue;

            // Narrow phase against the node's BVH, if it has one.
            const bvh = precise ? node.getBVH() : null;
            if (bvh) {
                const preciseDistance = this.raycastBVH(ray, node, bvh);
                // BVH miss → the AABB hit was a false positive; reject the node.
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

        // Sort by distance (closest first)
        hits.sort((a, b) => a.distance - b.distance);
        return hits;
    }

    /**
     * Refines a hit against a node's object-space BVH. Transforms the world-space ray into the
     * node's local space via the inverse world transform and returns the world-space distance of
     * the nearest triangle hit, or null when the ray misses the geometry.
     */
    private static raycastBVH(ray: Ray, node: Node, bvh: BVH): number | null {
        const inv = mat4.create();
        // Singular transform (e.g. zero scale) → can't invert; fall back to the AABB distance.
        if (!mat4.invert(inv, node.worldTransform)) {
            const box = node.getBoundingBox();
            return this.rayBoxIntersection(ray, box.min, box.max);
        }

        // Origin transforms as a point; direction as a vector (strip translation, keep scale so the
        // returned t stays consistent with the normalized world ray — see note below).
        const localOrigin = vec3.transformMat4(vec3.create(), ray.origin, inv);
        const rotOnly = mat4.clone(inv);
        rotOnly[12] = 0; rotOnly[13] = 0; rotOnly[14] = 0;
        const localDir = vec3.transformMat4(vec3.create(), ray.direction, rotOnly);

        const hit = bvh.raycast(localOrigin, localDir);
        if (!hit) return null;

        // localDir was NOT renormalized, so `hit.t` is already the distance along the normalized
        // world-space ray direction (worldRot * localDir == ray.direction). It maps directly to a
        // world-space distance.
        return hit.t;
    }
}
