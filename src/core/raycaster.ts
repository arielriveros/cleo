import { vec3, mat4 } from "gl-matrix";
import { Node } from "./scene/node";
import { Camera } from "./camera";

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
            // For orthographic camera
            rayOrigin[0] = x * (camera.right - camera.left) / 2;
            rayOrigin[1] = y * (camera.top - camera.bottom) / 2;
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
     * Performs raycast against all nodes in the scene
     */
    public static raycast(
        ray: Ray, 
        nodes: Node[], 
        maxDistance: number = Infinity
    ): RaycastHit[] {
        const hits: RaycastHit[] = [];
        
        console.log('Raycasting against', nodes.length, 'nodes');
        
        for (const node of nodes) {
            if (!node.visible) {
                console.log(`Skipping invisible node: ${node.name}`);
                continue;
            }
            
            // Skip editor debug nodes, debug shape nodes, editor grid, and editor camera
            if (node.name.startsWith('__editor__') || 
                node.name.startsWith('__debug__') || 
                node.name.startsWith('__debug__shape_')) {
                console.log(`Skipping editor/debug node: ${node.name}`);
                continue;
            }
            
            console.log(`Testing node: ${node.name} (${node.nodeType})`);
            const boundingBox = this.getBoundingBox(node);
            console.log(`Bounding box for ${node.name}:`, boundingBox);
            
            const distance = this.rayBoxIntersection(ray, boundingBox.min, boundingBox.max);
            console.log(`Distance for ${node.name}:`, distance);
            
            // Debug logging for spheres
            if (node.name.toLowerCase().includes('sphere')) {
                console.log(`Testing sphere ${node.name}:`, {
                    position: node.worldPosition,
                    scale: node.worldScale,
                    boundingBox,
                    distance,
                    ray: { origin: ray.origin, direction: ray.direction }
                });
            }
            
            if (distance !== null && distance > 0 && distance < maxDistance) {
                const hitPoint = vec3.create();
                vec3.scaleAndAdd(hitPoint, ray.origin, ray.direction, distance);
                
                hits.push({
                    node,
                    distance,
                    point: hitPoint
                });
                
                if (node.name.toLowerCase().includes('sphere')) {
                    console.log(`Hit sphere ${node.name} at distance ${distance}`);
                }
            }
        }
        
        // Sort by distance (closest first)
        hits.sort((a, b) => a.distance - b.distance);
        return hits;
    }
}
