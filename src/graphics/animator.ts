import { mat4, quat, vec3 } from 'gl-matrix';
import { AnimatedModel, Animation, AnimationSampler, AnimationChannel, Skin } from './animatedModel';
import { Node, ModelNode } from '../core/scene/node';
import { InputManager } from '../input/inputManager';

/**
 * Minimal structural view of a physics body used to drive ragdoll bones.
 * Matches cannon-es Body (position/quaternion) without importing the physics layer.
 */
export interface RagdollBodyRef {
    position: { x: number; y: number; z: number };
    quaternion: { x: number; y: number; z: number; w: number };
}

/**
 * Animation mapping interface for trigger-based animation playback
 */
export interface AnimationMapping {
    animationName: string;
    trigger: string;
    triggerType: 'key' | 'direction' | 'speed' | 'custom';
    keyCode?: string;
    direction?: [number, number, number]; // 3D vector (x, y, z) ranging from 0 to 1
    directionThreshold?: number; // Dot product threshold for direction matching (default: 0.8)
    speedThreshold?: number; // For 'speed' trigger type
    customCondition?: string;
}

/**
 * Represents a single keyframe for position data
 */
interface KeyPosition {
    position: vec3;
    timeStamp: number;
}

/**
 * Represents a single keyframe for rotation data
 */
interface KeyRotation {
    orientation: quat;
    timeStamp: number;
}

/**
 * Represents a single keyframe for scale data
 */
interface KeyScale {
    scale: vec3;
    timeStamp: number;
}

/**
 * Bone class handles interpolation of keyframes for a single bone
 */
class Bone {
    private _name: string;
    private _id: number;
    private _localTransform: mat4;
    
    private _positions: KeyPosition[] = [];
    private _rotations: KeyRotation[] = [];
    private _scales: KeyScale[] = [];
    
    constructor(name: string, id: number) {
        this._name = name;
        this._id = id;
        this._localTransform = mat4.create();
    }
    
    /**
     * Add position channel data
     */
    public addPositionChannel(sampler: AnimationSampler): void {
        this._positions = [];
        for (let i = 0; i < sampler.input.length; i++) {
            const position = vec3.fromValues(
                sampler.output[i * 3],
                sampler.output[i * 3 + 1],
                sampler.output[i * 3 + 2]
            );
            this._positions.push({
                position,
                timeStamp: sampler.input[i]
            });
        }
    }
    
    /**
     * Add rotation channel data
     */
    public addRotationChannel(sampler: AnimationSampler): void {
        this._rotations = [];
        for (let i = 0; i < sampler.input.length; i++) {
            const orientation = quat.fromValues(
                sampler.output[i * 4],
                sampler.output[i * 4 + 1],
                sampler.output[i * 4 + 2],
                sampler.output[i * 4 + 3]
            );
            quat.normalize(orientation, orientation);
            this._rotations.push({
                orientation,
                timeStamp: sampler.input[i]
            });
        }
    }
    
    /**
     * Add scale channel data
     */
    public addScaleChannel(sampler: AnimationSampler): void {
        this._scales = [];
        for (let i = 0; i < sampler.input.length; i++) {
            const scale = vec3.fromValues(
                sampler.output[i * 3],
                sampler.output[i * 3 + 1],
                sampler.output[i * 3 + 2]
            );
            this._scales.push({
                scale,
                timeStamp: sampler.input[i]
            });
        }
    }
    
    /**
     * Update the bone's local transform based on animation time
     */
    public update(animationTime: number): void {
        const translation = this._interpolatePosition(animationTime);
        const rotation = this._interpolateRotation(animationTime);
        const scale = this._interpolateScale(animationTime);
        
        // Combine transformations: T * R * S
        mat4.fromRotationTranslationScale(this._localTransform, rotation, translation, scale);
    }
    
    /**
     * Get the current index for position keyframes
     */
    private _getPositionIndex(animationTime: number): number {
        for (let i = 0; i < this._positions.length - 1; i++) {
            if (animationTime < this._positions[i + 1].timeStamp) {
                return i;
            }
        }
        return this._positions.length - 2;
    }
    
    /**
     * Get the current index for rotation keyframes
     */
    private _getRotationIndex(animationTime: number): number {
        for (let i = 0; i < this._rotations.length - 1; i++) {
            if (animationTime < this._rotations[i + 1].timeStamp) {
                return i;
            }
        }
        return this._rotations.length - 2;
    }
    
    /**
     * Get the current index for scale keyframes
     */
    private _getScaleIndex(animationTime: number): number {
        for (let i = 0; i < this._scales.length - 1; i++) {
            if (animationTime < this._scales[i + 1].timeStamp) {
                return i;
            }
        }
        return this._scales.length - 2;
    }
    
    /**
     * Calculate interpolation factor (0-1) between two keyframes
     */
    private _getScaleFactor(lastTimeStamp: number, nextTimeStamp: number, animationTime: number): number {
        const midWayLength = animationTime - lastTimeStamp;
        const framesDiff = nextTimeStamp - lastTimeStamp;
        return midWayLength / framesDiff;
    }
    
    /**
     * Interpolate position at given animation time
     */
    private _interpolatePosition(animationTime: number): vec3 {
        if (this._positions.length === 0) {
            return vec3.fromValues(0, 0, 0);
        }
        
        if (this._positions.length === 1) {
            return this._positions[0].position;
        }
        
        const p0Index = this._getPositionIndex(animationTime);
        const p1Index = p0Index + 1;
        const scaleFactor = this._getScaleFactor(
            this._positions[p0Index].timeStamp,
            this._positions[p1Index].timeStamp,
            animationTime
        );
        
        const finalPosition = vec3.create();
        vec3.lerp(finalPosition, this._positions[p0Index].position, this._positions[p1Index].position, scaleFactor);
        return finalPosition;
    }
    
    /**
     * Interpolate rotation at given animation time using spherical interpolation (slerp)
     */
    private _interpolateRotation(animationTime: number): quat {
        if (this._rotations.length === 0) {
            return quat.create();
        }
        
        if (this._rotations.length === 1) {
            const rotation = quat.create();
            quat.normalize(rotation, this._rotations[0].orientation);
            return rotation;
        }
        
        const p0Index = this._getRotationIndex(animationTime);
        const p1Index = p0Index + 1;
        const scaleFactor = this._getScaleFactor(
            this._rotations[p0Index].timeStamp,
            this._rotations[p1Index].timeStamp,
            animationTime
        );
        
        const finalRotation = quat.create();
        quat.slerp(finalRotation, this._rotations[p0Index].orientation, this._rotations[p1Index].orientation, scaleFactor);
        quat.normalize(finalRotation, finalRotation);
        return finalRotation;
    }
    
    /**
     * Interpolate scale at given animation time
     */
    private _interpolateScale(animationTime: number): vec3 {
        if (this._scales.length === 0) {
            return vec3.fromValues(1, 1, 1);
        }
        
        if (this._scales.length === 1) {
            return this._scales[0].scale;
        }
        
        const p0Index = this._getScaleIndex(animationTime);
        const p1Index = p0Index + 1;
        const scaleFactor = this._getScaleFactor(
            this._scales[p0Index].timeStamp,
            this._scales[p1Index].timeStamp,
            animationTime
        );
        
        const finalScale = vec3.create();
        vec3.lerp(finalScale, this._scales[p0Index].scale, this._scales[p1Index].scale, scaleFactor);
        return finalScale;
    }
    
    public get localTransform(): mat4 { return this._localTransform; }
    public get name(): string { return this._name; }
    public get id(): number { return this._id; }
}

/**
 * Animator class manages skeletal animation playback
 * Based on the LearnOpenGL skeletal animation approach
 */
export class Animator {
    private _currentAnimation: Animation | null = null;
    private _animatedModel: AnimatedModel | null = null;
    private _currentTime: number = 0;
    private _deltaTime: number = 0;
    private _finalBoneMatrices: mat4[] = [];
    private _bones: Map<string, Bone> = new Map();
    private _skin: Skin | null = null;
    private _playing: boolean = false;
    private _loop: boolean = true;
    private _speed: number = 1.0;
    private _nodeIndexToJointIndex: Map<number, number> = new Map();
    private _animationMappings: AnimationMapping[] = [];
    private _node: Node | null = null;
    private _lastPosition: vec3 = vec3.create();
    private _currentSpeed: number = 0;
    
    // Animation blending properties
    private _previousAnimation: Animation | null = null;
    private _previousBones: Map<string, Bone> = new Map();
    private _previousTime: number = 0;
    private _blendTime: number = 0.3; // Default blend time in seconds
    private _currentBlendTime: number = 0;
    private _isBlending: boolean = false;

    // Ragdoll: when active, bone matrices are driven by physics bodies instead of animation.
    // Every joint is driven by the nearest ancestor bone that owns a body, so bones without their own
    // body (e.g. pruned fingers) ride rigidly on their limb. finalBoneMatrix = inv(nodeWorld) * bodyWorld * offset;
    // the constant offset captures the bone's full start pose incl. any embedded rig scale, so bones
    // follow only the body's RIGID motion (no scale reconstruction) and scaled rigs don't blow up.
    private _ragdollActive: boolean = false;
    private _ragdollDrive: Map<number, { body: RagdollBodyRef, offset: mat4 }> | null = null;

    constructor(animatedModel: AnimatedModel, node?: Node) {
        this._animatedModel = animatedModel;
        this._node = node || null;
        
        // Initialize last position if node is provided
        if (this._node) {
            vec3.copy(this._lastPosition, this._node.position);
        }
        
        // Initialize bone matrices array with identity matrices
        for (let i = 0; i < 100; i++) {
            this._finalBoneMatrices.push(mat4.create());
        }
        
        // Store skin data
        this._skin = animatedModel.skin;
        
        // Build node index to joint index mapping
        if (this._skin) {
            for (let jointIndex = 0; jointIndex < this._skin.joints.length; jointIndex++) {
                const nodeIndex = this._skin.joints[jointIndex].nodeIndex;
                this._nodeIndexToJointIndex.set(nodeIndex, jointIndex);
            }
            console.log(`Animator initialized with ${this._skin.joints.length} joints`);
            console.log('Joint node indices:', Array.from(this._nodeIndexToJointIndex.keys()));
        }
        
        // If model has animations, set the first one as default
        if (animatedModel.animations.length > 0) {
            console.log(`Found ${animatedModel.animations.length} animations`);
            animatedModel.animations.forEach((anim, i) => {
                console.log(`  Animation ${i}: "${anim.name}" with ${anim.channels.length} channels`);
            });
            this.playAnimation(0);
        } else {
            console.warn('AnimatedModel has no animations');
        }
    }
    
    /**
     * Play animation by index
     */
    public playAnimation(animationIndex: number, loop: boolean = true, blend: boolean = true): void {
        if (!this._animatedModel || animationIndex < 0 || animationIndex >= this._animatedModel.animations.length) {
            console.warn(`Animation index ${animationIndex} out of range`);
            return;
        }
        
        const animation = this._animatedModel.animations[animationIndex];
        
        // If we're switching to a different animation and blending is enabled
        if (blend && this._currentAnimation && this._currentAnimation !== animation && this._playing) {
            // Store current animation state for blending
            this._previousAnimation = this._currentAnimation;
            this._previousBones = new Map(this._bones);
            this._previousTime = this._currentTime;
            this._isBlending = true;
            this._currentBlendTime = 0;
        } else {
            // No blending - instant switch
            this._isBlending = false;
            this._previousAnimation = null;
        }
        
        this._currentAnimation = animation;
        this._currentTime = 0;
        this._loop = loop;
        this._playing = true;
        
        // Build bone map from animation channels
        this._buildBoneMap(animation);
    }
    
    /**
     * Play animation by name
     */
    public playAnimationByName(name: string, loop: boolean = true, blend: boolean = true): void {
        if (!this._animatedModel) return;
        
        const animationIndex = this._animatedModel.animations.findIndex(anim => anim.name === name);
        if (animationIndex === -1) {
            console.warn(`Animation "${name}" not found`);
            return;
        }
        
        this.playAnimation(animationIndex, loop, blend);
    }
    
    /**
     * Build bone map from animation channels
     */
    private _buildBoneMap(animation: Animation): void {
        this._bones.clear();
        
        // Group channels by target node
        for (const channel of animation.channels) {
            const nodeIndex = channel.targetNodeIndex;
            const boneName = `bone_${nodeIndex}`;
            
            // Get or create bone
            let bone = this._bones.get(boneName);
            if (!bone) {
                bone = new Bone(boneName, nodeIndex);
                this._bones.set(boneName, bone);
            }
            
            // Add channel data based on target path
            const sampler = animation.samplers[channel.samplerIndex];
            if (channel.targetPath === 'translation') {
                bone.addPositionChannel(sampler);
            } else if (channel.targetPath === 'rotation') {
                bone.addRotationChannel(sampler);
            } else if (channel.targetPath === 'scale') {
                bone.addScaleChannel(sampler);
            }
        }
        
        console.log(`Built bone map with ${this._bones.size} bones for animation "${animation.name}"`);
        console.log(`Skin has ${this._skin?.joints.length || 0} joints`);
        console.log('Animation target node indices:', Array.from(this._bones.values()).map(b => b.id));
        
        // Log which joints have animation
        if (this._skin) {
            let animatedCount = 0;
            for (let i = 0; i < this._skin.joints.length; i++) {
                const nodeIndex = this._skin.joints[i].nodeIndex;
                const boneName = `bone_${nodeIndex}`;
                if (this._bones.has(boneName)) {
                    animatedCount++;
                }
            }
            console.log(`${animatedCount} out of ${this._skin.joints.length} joints have animation data`);
            
            // If no joints have animation data, this animation is likely invalid or targets the wrong nodes
            if (animatedCount === 0) {
                console.warn(`⚠️ Animation "${animation.name}" has no channels targeting the skin joints. This animation may not work correctly.`);
                console.warn(`Animation channels target nodes:`, animation.channels.map(c => c.targetNodeIndex));
                console.warn(`Skin joint nodes:`, this._skin.joints.map(j => j.nodeIndex));
            }
        }
    }
    
    /**
     * Update animation state
     */
    public update(deltaTime: number): void {
        // Ragdoll takes over: drive bones from physics bodies, skip all animation.
        if (this._ragdollActive) {
            this._updateRagdollMatrices();
            return;
        }

        // Calculate speed if node is available
        if (this._node && deltaTime > 0) {
            const currentPosition = this._node.position;
            const distance = vec3.distance(currentPosition, this._lastPosition);
            this._currentSpeed = distance / deltaTime;
            vec3.copy(this._lastPosition, currentPosition);
        }
        
        if (!this._playing || !this._currentAnimation || !this._skin) {
            return;
        }
        
        this._deltaTime = deltaTime * this._speed;
        
        // Update blend time if blending
        if (this._isBlending) {
            this._currentBlendTime += this._deltaTime;
            if (this._currentBlendTime >= this._blendTime) {
                // Blend complete
                this._isBlending = false;
                this._previousAnimation = null;
                this._previousBones.clear();
            }
        }
        
        // Get animation duration (assuming it's the max timestamp in samplers)
        const duration = this._getAnimationDuration();
        
        // Update current time
        this._currentTime += this._deltaTime;
        
        // Handle looping or stopping
        if (this._currentTime >= duration) {
            if (this._loop) {
                this._currentTime = this._currentTime % duration;
            } else {
                this._currentTime = duration;
                this._playing = false;
            }
        }
        
        // Update all bones with current animation time
        for (const bone of this._bones.values()) {
            bone.update(this._currentTime);
        }
        
        // If blending, also update previous animation bones
        if (this._isBlending && this._previousAnimation) {
            const previousDuration = this._getPreviousAnimationDuration();
            let previousTime = this._previousTime + this._deltaTime;
            
            // Handle looping for previous animation
            if (previousTime >= previousDuration) {
                previousTime = previousTime % previousDuration;
            }
            
            for (const bone of this._previousBones.values()) {
                bone.update(previousTime);
            }
        }
        
        // Build local transforms map for all joints
        const localTransforms = new Map<number, mat4>();
        for (let jointIndex = 0; jointIndex < this._skin.joints.length; jointIndex++) {
            const joint = this._skin.joints[jointIndex];
            const nodeIndex = joint.nodeIndex;
            const boneName = `bone_${nodeIndex}`;
            const bone = this._bones.get(boneName);
            
            if (bone) {
                if (this._isBlending && this._previousBones.has(boneName)) {
                    // Blend between previous and current animation
                    const previousBone = this._previousBones.get(boneName)!;
                    const blendFactor = Math.min(this._currentBlendTime / this._blendTime, 1.0);
                    const blendedTransform = this._blendTransforms(previousBone.localTransform, bone.localTransform, blendFactor);
                    localTransforms.set(nodeIndex, blendedTransform);
                } else {
                    // Use animated transform
                    localTransforms.set(nodeIndex, bone.localTransform);
                }
            } else {
                // Use initial node transform from GLTF, or identity if not available
                const initialTransform = this._skin.nodeTransforms?.get(nodeIndex);
                localTransforms.set(nodeIndex, initialTransform ? initialTransform : mat4.create());
            }
        }
        
        // Calculate global transforms by accumulating through parent hierarchy
        const globalTransforms = new Map<number, mat4>();
        
        const calculateGlobalTransform = (nodeIndex: number): mat4 => {
            // Check if already calculated
            if (globalTransforms.has(nodeIndex)) {
                return globalTransforms.get(nodeIndex)!;
            }
            
            // Get local transform
            const localTransform = localTransforms.get(nodeIndex);
            if (!localTransform) {
                // If not in local transforms map, try to get from initial node transforms
                const initialTransform = this._skin!.nodeTransforms?.get(nodeIndex);
                if (initialTransform) {
                    globalTransforms.set(nodeIndex, initialTransform);
                    return initialTransform;
                }
                // Fallback to identity
                const identity = mat4.create();
                globalTransforms.set(nodeIndex, identity);
                return identity;
            }
            
            // Find parent
            const joint = this._skin!.joints.find(j => j.nodeIndex === nodeIndex);
            const parentIndex = joint?.parentIndex;
            
            let globalTransform = mat4.create();
            
            if (parentIndex !== undefined) {
                // Has parent - multiply parent's global transform by local transform
                const parentGlobal = calculateGlobalTransform(parentIndex);
                mat4.multiply(globalTransform, parentGlobal, localTransform);
            } else {
                // No parent - local transform IS the global transform
                mat4.copy(globalTransform, localTransform);
            }
            
            globalTransforms.set(nodeIndex, globalTransform);
            return globalTransform;
        };
        
        // Calculate final bone matrices: finalMatrix = globalTransform × inverseBindMatrix
        for (let jointIndex = 0; jointIndex < this._skin.joints.length; jointIndex++) {
            const joint = this._skin.joints[jointIndex];
            const nodeIndex = joint.nodeIndex;
            
            const globalTransform = calculateGlobalTransform(nodeIndex);
            mat4.multiply(this._finalBoneMatrices[jointIndex], globalTransform, joint.inverseBindMatrix);
        }
    }
    
    /**
     * Blend between two transformation matrices
     */
    private _blendTransforms(from: mat4, to: mat4, factor: number): mat4 {
        // Decompose both matrices into translation, rotation, and scale
        const fromTranslation = vec3.create();
        const fromRotation = quat.create();
        const fromScale = vec3.create();
        mat4.getTranslation(fromTranslation, from);
        mat4.getRotation(fromRotation, from);
        mat4.getScaling(fromScale, from);
        
        const toTranslation = vec3.create();
        const toRotation = quat.create();
        const toScale = vec3.create();
        mat4.getTranslation(toTranslation, to);
        mat4.getRotation(toRotation, to);
        mat4.getScaling(toScale, to);
        
        // Interpolate each component
        const blendedTranslation = vec3.create();
        const blendedRotation = quat.create();
        const blendedScale = vec3.create();
        
        vec3.lerp(blendedTranslation, fromTranslation, toTranslation, factor);
        quat.slerp(blendedRotation, fromRotation, toRotation, factor);
        vec3.lerp(blendedScale, fromScale, toScale, factor);
        
        // Reconstruct the matrix
        const result = mat4.create();
        mat4.fromRotationTranslationScale(result, blendedRotation, blendedTranslation, blendedScale);
        return result;
    }
    
    /**
     * Get previous animation duration from samplers
     */
    private _getPreviousAnimationDuration(): number {
        if (!this._previousAnimation) return 0;
        
        let maxTime = 0;
        for (const sampler of this._previousAnimation.samplers) {
            if (sampler.input.length > 0) {
                const lastTime = sampler.input[sampler.input.length - 1];
                maxTime = Math.max(maxTime, lastTime);
            }
        }
        return maxTime;
    }
    
    /**
     * Get animation duration from samplers
     */
    private _getAnimationDuration(): number {
        if (!this._currentAnimation) return 0;
        
        let maxTime = 0;
        for (const sampler of this._currentAnimation.samplers) {
            if (sampler.input.length > 0) {
                const lastTime = sampler.input[sampler.input.length - 1];
                maxTime = Math.max(maxTime, lastTime);
            }
        }
        return maxTime;
    }
    
    /**
     * Get final bone matrices for rendering
     */
    public getFinalBoneMatrices(): mat4[] {
        return this._finalBoneMatrices;
    }
    
    /**
     * Get final bone matrices as flat array for shader uniform
     */
    public getFinalBoneMatricesFlat(): number[] {
        const flat: number[] = [];
        for (const matrix of this._finalBoneMatrices) {
            for (let i = 0; i < 16; i++) {
                flat.push(matrix[i]);
            }
        }
        return flat;
    }
    
    // Control methods
    public play(): void { this._playing = true; }
    public pause(): void { this._playing = false; }
    public stop(): void { 
        this._playing = false;
        this._currentTime = 0;
    }
    public reset(): void { this._currentTime = 0; }

    // ---- Ragdoll drive mode ----

    /** True while bones are driven by physics bodies instead of animation. */
    public get ragdollActive(): boolean { return this._ragdollActive; }

    /**
     * Hand the skeleton over to physics: bone matrices are computed from the given
     * per-joint bodies (keyed by GLTF node index) every frame instead of from animation.
     */
    public enableRagdoll(bodies: Map<number, RagdollBodyRef>): void {
        this._ragdollActive = true;
        this._playing = false;
        this._ragdollDrive = new Map();
        if (!this._skin || !this._node) return;

        // Walk up the skeleton to the nearest ancestor (inclusive) that owns a body.
        const parentOf = new Map<number, number | undefined>();
        for (const j of this._skin.joints) parentOf.set(j.nodeIndex, j.parentIndex);
        const drivingIndex = (nodeIndex: number): number | null => {
            let n: number | undefined = nodeIndex;
            while (n !== undefined) {
                if (bodies.has(n)) return n;
                n = parentOf.get(n);
            }
            return null;
        };

        // Snapshot each bone's fixed offset from its driving body at hand-off:
        //   offset = inverse(bodyWorld0) * nodeWorld0 * finalBoneMatrix0
        // bodyWorld0 is built rigidly (pos+quat) from the body's spawn pose, so all scale lives in
        // finalBoneMatrix0 and is carried through unchanged. At t=0 this reproduces the exact pose.
        const nodeWorld0 = this._node.worldTransform;
        const bodyWorld0 = mat4.create();
        const bodyInv0 = mat4.create();
        for (let jointIndex = 0; jointIndex < this._skin.joints.length; jointIndex++) {
            const joint = this._skin.joints[jointIndex];
            const bi = drivingIndex(joint.nodeIndex);
            if (bi === null) continue; // no bodied ancestor: keep this bone's last matrix
            const body = bodies.get(bi)!;
            const q = body.quaternion, p = body.position;
            mat4.fromRotationTranslation(bodyWorld0, [q.x, q.y, q.z, q.w], [p.x, p.y, p.z]);
            mat4.invert(bodyInv0, bodyWorld0);
            const offset = mat4.create();
            mat4.multiply(offset, nodeWorld0, this._finalBoneMatrices[jointIndex]); // nodeWorld0 * FBM0
            mat4.multiply(offset, bodyInv0, offset);                                // inverse(bodyWorld0) * ...
            this._ragdollDrive.set(joint.nodeIndex, { body, offset });
        }
    }

    /** Return control of the skeleton to the animation system. */
    public disableRagdoll(): void {
        this._ragdollActive = false;
        this._ragdollDrive = null;
    }

    /**
     * Compute final bone matrices from ragdoll bodies. Each body carries a bone's
     * world transform; convert it to model space via the owning node's inverse world
     * transform, then apply the inverse bind matrix (matching the animation path).
     * Runs after the physics step, so bodies hold this frame's settled pose.
     */
    private _updateRagdollMatrices(): void {
        if (!this._skin || !this._ragdollDrive || !this._node) return;

        const nodeInv = mat4.create();
        mat4.invert(nodeInv, this._node.worldTransform);

        const bodyWorld = mat4.create();
        const tmp = mat4.create();

        for (let jointIndex = 0; jointIndex < this._skin.joints.length; jointIndex++) {
            const joint = this._skin.joints[jointIndex];
            const drive = this._ragdollDrive.get(joint.nodeIndex);
            if (!drive) continue; // no bodied ancestor: keep its last matrix

            // finalBoneMatrix = inverse(nodeWorld) * bodyWorld * offset  (bodyWorld built rigidly)
            const q = drive.body.quaternion, p = drive.body.position;
            mat4.fromRotationTranslation(bodyWorld, [q.x, q.y, q.z, q.w], [p.x, p.y, p.z]);
            mat4.multiply(tmp, nodeInv, bodyWorld);
            mat4.multiply(this._finalBoneMatrices[jointIndex], tmp, drive.offset);
        }
    }

    /**
     * Set animation mappings for trigger-based playback
     */
    public setAnimationMappings(mappings: AnimationMapping[]): void {
        this._animationMappings = mappings;
    }
    
    /**
     * Get current animation mappings
     */
    public getAnimationMappings(): AnimationMapping[] {
        return this._animationMappings;
    }
    
    /**
     * Set the node reference for checking triggers
     */
    public setNode(node: Node): void {
        this._node = node;
    }
    
    /**
     * Check triggers and play appropriate animations
     * Should be called every frame before update
     */
    public checkTriggers(): void {
        // While ragdolling, ignore animation triggers (and don't fall back to T-pose).
        if (this._ragdollActive) return;
        if (!this._animatedModel) return;
        
        // If no mappings, set T-pose by stopping animation
        if (this._animationMappings.length === 0) {
            if (this._playing) {
                this._setTPose();
            }
            return;
        }
        
        const input = InputManager.instance;
        let triggerFound = false;
        let targetAnimation: string | null = null;
        
        // Check all mappings in order (priority: first match wins)
        for (const mapping of this._animationMappings) {
            let shouldTrigger = false;
            
            switch (mapping.triggerType) {
                case 'key':
                    if (mapping.keyCode && input.isKeyPressed(mapping.keyCode)) {
                        shouldTrigger = true;
                    }
                    break;
                    
                case 'direction':
                    if (this._node && mapping.direction) {
                        shouldTrigger = this._checkDirectionTrigger(mapping.direction, mapping.directionThreshold);
                    }
                    break;
                    
                case 'speed':
                    if (mapping.speedThreshold !== undefined) {
                        shouldTrigger = this._checkSpeedTrigger(mapping.speedThreshold);
                    }
                    break;
                    
                case 'custom':
                    if (mapping.customCondition) {
                        shouldTrigger = this._evaluateCustomCondition(mapping.customCondition);
                    }
                    break;
            }
            
            if (shouldTrigger) {
                triggerFound = true;
                targetAnimation = mapping.animationName;
                // First matching trigger wins - stop checking others
                break;
            }
        }
        
        if (triggerFound && targetAnimation) {
            // Play the animation if not already playing it
            if (!this._currentAnimation || this._currentAnimation.name !== targetAnimation || !this._playing) {
                this.playAnimationByName(targetAnimation, true);
            }
        } else {
            // No trigger active - set T-pose if currently playing
            if (this._playing) {
                this._setTPose();
            }
        }
    }
    
    /**
     * Set T-pose by resetting bone matrices to bind pose using initial node transforms
     */
    private _setTPose(): void {
        if (!this._skin) return;
        
        // Stop any playing animation
        this._playing = false;
        
        // Calculate bind pose transforms for all joints
        const globalTransforms = new Map<number, mat4>();
        
        const calculateBindPoseTransform = (nodeIndex: number): mat4 => {
            // Check if already calculated
            if (globalTransforms.has(nodeIndex)) {
                return globalTransforms.get(nodeIndex)!;
            }
            
            // Get initial local transform from GLTF data
            const localTransform = this._skin!.nodeTransforms?.get(nodeIndex);
            if (!localTransform) {
                // Fallback to identity if no transform data
                const identity = mat4.create();
                globalTransforms.set(nodeIndex, identity);
                return identity;
            }
            
            // Find parent
            const joint = this._skin!.joints.find(j => j.nodeIndex === nodeIndex);
            const parentIndex = joint?.parentIndex;
            
            let globalTransform = mat4.create();
            
            if (parentIndex !== undefined) {
                // Has parent - multiply parent's global transform by local transform
                const parentGlobal = calculateBindPoseTransform(parentIndex);
                mat4.multiply(globalTransform, parentGlobal, localTransform);
            } else {
                // No parent - local transform IS the global transform
                mat4.copy(globalTransform, localTransform);
            }
            
            globalTransforms.set(nodeIndex, globalTransform);
            return globalTransform;
        };
        
        // Calculate final bone matrices for bind pose
        for (let jointIndex = 0; jointIndex < this._skin.joints.length; jointIndex++) {
            const joint = this._skin.joints[jointIndex];
            const nodeIndex = joint.nodeIndex;
            
            const globalTransform = calculateBindPoseTransform(nodeIndex);
            mat4.multiply(this._finalBoneMatrices[jointIndex], globalTransform, joint.inverseBindMatrix);
        }
    }
    
    /**
     * Check if movement direction matches the target direction vector in local space
     * Uses dot product to determine if the input direction is similar enough to the target
     * The input direction is transformed to the node's local space
     */
    private _checkDirectionTrigger(targetDirection: [number, number, number], threshold: number = 0.8): boolean {
        if (!this._node || !(this._node instanceof ModelNode)) return false;
        
        const modelNode = this._node as ModelNode;
        
        // Get the movement direction from the ModelNode
        const worldInputDir = vec3.clone(modelNode.movementDirection);
        
        // Check if there's any input
        const inputLength = vec3.length(worldInputDir);
        if (inputLength === 0) {
            // No input - check if target direction is zero (idle state)
            const targetLength = Math.sqrt(
                targetDirection[0] * targetDirection[0] + 
                targetDirection[1] * targetDirection[1] + 
                targetDirection[2] * targetDirection[2]
            );
            return targetLength === 0;
        }
        
        // Normalize world input direction
        vec3.normalize(worldInputDir, worldInputDir);
        
        // Get the node's rotation to convert world space to local space
        // Extract rotation from world transform and invert it
        const nodeWorldTransform = this._node.worldTransform;
        
        // Extract rotation quaternion from the world transform matrix
        const worldRotation = quat.create();
        mat4.getRotation(worldRotation, nodeWorldTransform);
        
        // Invert the rotation to go from world space to local space
        const inverseRotation = quat.create();
        quat.invert(inverseRotation, worldRotation);
        
        // Transform world input direction to local space using only rotation
        const localInputDir = vec3.create();
        vec3.transformQuat(localInputDir, worldInputDir, inverseRotation);
        
        // Normalize to be safe (should already be normalized, but just in case)
        vec3.normalize(localInputDir, localInputDir);
        
        // Create target direction vector and normalize
        const targetDir = vec3.fromValues(targetDirection[0], targetDirection[1], targetDirection[2]);
        const targetLength = vec3.length(targetDir);
        if (targetLength === 0) {
            // Target is idle (zero vector), but we have input
            return false;
        }
        vec3.normalize(targetDir, targetDir);
        
        // Calculate dot product to measure similarity in local space
        const dotProduct = vec3.dot(localInputDir, targetDir);
        
        // Check if dot product exceeds threshold
        return dotProduct >= threshold;
    }
    
    /**
     * Check if speed is above threshold
     */
    private _checkSpeedTrigger(threshold: number): boolean {
        return this._currentSpeed >= threshold;
    }
    
    /**
     * Evaluate custom condition (basic implementation)
     * For security, only allow safe property access
     */
    private _evaluateCustomCondition(condition: string): boolean {
        if (!this._node) return false;
        
        try {
            // Create a safe evaluation context
            const context = {
                node: this._node,
                position: this._node.position,
                rotation: this._node.rotation,
                scale: this._node.scale,
                // Add any other safe properties here
            };
            
            // Use Function constructor for evaluation (safer than eval)
            const fn = new Function('context', `with(context) { return ${condition}; }`);
            return Boolean(fn(context));
        } catch (error) {
            console.warn(`Failed to evaluate animation condition: ${condition}`, error);
            return false;
        }
    }
    
    // Getters and setters
    public get isPlaying(): boolean { return this._playing; }
    public get currentTime(): number { return this._currentTime; }
    public get loop(): boolean { return this._loop; }
    public set loop(value: boolean) { this._loop = value; }
    public get speed(): number { return this._speed; }
    public set speed(value: number) { this._speed = Math.max(0, value); }
    public get currentAnimation(): Animation | null { return this._currentAnimation; }
    public get currentSpeed(): number { return this._currentSpeed; }
    public get blendTime(): number { return this._blendTime; }
    public set blendTime(value: number) { this._blendTime = Math.max(0, value); }
    public get isBlending(): boolean { return this._isBlending; }
}
