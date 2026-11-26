import type { PoseAsset } from './poseAssets';
import { resolvedPoseFor } from './poseAssets';

// A rig's reaction sets (how its skeleton reacts when hit, pushed, falling: the engine's
// physics/reactive/reactionSet.ts), as the editor holds them and as the runtime reads them. Authored on the rig
// in the Reactions tab and embedded into the skin of every model on it (`syncRigSockets`), like the ragdoll
// profile; a behaviour's pose slots name pose ASSETS here, and carry the resolved bones there.
// Typed loosely, like the ragdoll profile: this module stays engine-free.

/** A pose slot as stored on the rig: a link to a pose asset (resolved when embedded). */
export type RigReactionPoseSlot = { poseRef?: { assetId: string; poseId: string }; pose?: unknown }

/** A rig's reaction sets (ReactionSets in the engine). */
export type RigReactions = { version: 1; defaultSet?: string; sets: any[] }

/**
 * The runtime shape of a rig's sets, as embedded in a skin: every pose slot's link resolved into its bones
 * (`pose`), the link itself kept (so the editor can still show which pose it was). Null for none.
 */
export function runtimeReactionSets(reactions: RigReactions | undefined | null, poseAssets: PoseAsset[]): RigReactions | null {
    if (!reactions || !Array.isArray(reactions.sets) || reactions.sets.length === 0) return null
    const sets = reactions.sets.map(set => {
        const behaviours: Record<string, any> = {}
        for (const [id, b] of Object.entries((set?.behaviours ?? {}) as Record<string, any>)) {
            if (!b || typeof b !== 'object') continue
            const poses: Record<string, RigReactionPoseSlot> = {}
            for (const [slot, s] of Object.entries((b.poses ?? {}) as Record<string, RigReactionPoseSlot>)) {
                if (!s?.poseRef) continue
                const pose = resolvedPoseFor(poseAssets, s.poseRef)
                poses[slot] = pose ? { poseRef: { ...s.poseRef }, pose } : { poseRef: { ...s.poseRef } }
            }
            behaviours[id] = { ...b, ...(Object.keys(poses).length ? { poses } : { poses: undefined }) }
            if (!behaviours[id].poses) delete behaviours[id].poses
        }
        return JSON.parse(JSON.stringify({ ...set, behaviours }))
    })
    return { version: 1, ...(reactions.defaultSet ? { defaultSet: reactions.defaultSet } : {}), sets }
}

/** Whether a rig's sets reach for any of these poses (a pose edit must re-embed them). */
export function reactionsUsePose(reactions: RigReactions | undefined | null, poseIds: ReadonlySet<string>): boolean {
    for (const set of reactions?.sets ?? []) {
        for (const b of Object.values((set?.behaviours ?? {}) as Record<string, any>)) {
            for (const s of Object.values((b?.poses ?? {}) as Record<string, RigReactionPoseSlot>)) if (s?.poseRef && poseIds.has(s.poseRef.poseId)) return true
        }
    }
    return false
}
