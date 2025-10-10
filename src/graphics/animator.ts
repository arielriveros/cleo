import { mat4, quat, vec3 } from 'gl-matrix';
import { AnimatedModel, Animation, AnimationSampler, AnimationChannel, Skin } from './animatedModel';
import { Node } from '../core/scene/node';

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
    
    constructor(animatedModel: AnimatedModel) {
        this._animatedModel = animatedModel;
        
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
    public playAnimation(animationIndex: number, loop: boolean = true): void {
        if (!this._animatedModel || animationIndex < 0 || animationIndex >= this._animatedModel.animations.length) {
            console.warn(`Animation index ${animationIndex} out of range`);
            return;
        }
        
        const animation = this._animatedModel.animations[animationIndex];
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
    public playAnimationByName(name: string, loop: boolean = true): void {
        if (!this._animatedModel) return;
        
        const animationIndex = this._animatedModel.animations.findIndex(anim => anim.name === name);
        if (animationIndex === -1) {
            console.warn(`Animation "${name}" not found`);
            return;
        }
        
        this.playAnimation(animationIndex, loop);
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
        }
    }
    
    /**
     * Update animation state
     */
    public update(deltaTime: number): void {
        if (!this._playing || !this._currentAnimation || !this._skin) {
            return;
        }
        
        this._deltaTime = deltaTime * this._speed;
        
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
        
        // Build local transforms map for all joints
        const localTransforms = new Map<number, mat4>();
        for (let jointIndex = 0; jointIndex < this._skin.joints.length; jointIndex++) {
            const joint = this._skin.joints[jointIndex];
            const nodeIndex = joint.nodeIndex;
            const boneName = `bone_${nodeIndex}`;
            const bone = this._bones.get(boneName);
            
            if (bone) {
                // Use animated transform
                localTransforms.set(nodeIndex, bone.localTransform);
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
    
    // Getters and setters
    public get isPlaying(): boolean { return this._playing; }
    public get currentTime(): number { return this._currentTime; }
    public get loop(): boolean { return this._loop; }
    public set loop(value: boolean) { this._loop = value; }
    public get speed(): number { return this._speed; }
    public set speed(value: number) { this._speed = Math.max(0, value); }
    public get currentAnimation(): Animation | null { return this._currentAnimation; }
}
