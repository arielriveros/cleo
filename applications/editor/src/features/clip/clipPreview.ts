import { AnimatedModel, type Animation, type Skin } from 'cleo'
import { resolveAnimationAsset } from '../../utils/animationResolve'
import type { AnimationAsset } from '../../utils/animationAssets'
import type { AnimationTarget } from '../animation/skeleton'

// Showing a clip asset on the Clip Player's preview character.
//
// Two things make this less obvious than "set the clips and play":
//
//  1. The `Animator` transcodes a clip into private `Bone` objects when `playAnimation` binds it, so
//     replacing `model.animations` is invisible to playback until the clip is re-bound. Every change
//     therefore has to end in `playAnimationByName` + `seek`, not just a swap.
//  2. `resolveAnimationAsset` caches per `(asset, model)` pair. Passing no cache key bypasses it, so the
//     preview always resolves the record it was handed — the one the library holds right now.

/**
 * Put an asset's clips onto the preview character, keeping the playhead where it was.
 *
 * Returns the name of the clip left bound, which is `want` when the asset still has it — a sync can
 * rename or remove the clip on screen, and silently leaving the character in whatever pose it held is
 * worse than falling back to the first clip.
 */
export function applyPreviewClips(
    target: AnimationTarget, asset: AnimationAsset, want: string | null,
    opts: { time?: number; loop?: boolean } = {},
): string | null {
    const model = target.model
    if (!(model instanceof AnimatedModel) || !model.hasSkin) return null

    const resolved = resolveAnimationAsset(asset, model.skin as Skin, undefined, undefined) as Animation[]

    // Drop what this asset previously contributed, by id — never everything: the character may legitimately
    // carry clips from other `.anim` assets linked to the same rig, and clearing those would empty its
    // state machine.
    for (const existing of model.animations.filter((a: Animation) => a.assetId === asset.id)) {
        model.removeAnimation(existing.name)
    }
    for (const clip of resolved) model.addAnimation({ ...clip })

    const name = resolved.some(c => c.name === want) ? want : resolved[0]?.name ?? null
    if (name) {
        // `blend: false` — a cross-fade from the pre-edit pose would make every keystroke look like a
        // transition rather than a change to the clip under the playhead.
        target.animator.playAnimationByName(name, opts.loop ?? true, false)
        target.animator.pause()
        target.animator.seek(Math.min(opts.time ?? 0, target.animator.duration))
    } else {
        target.animator.showBindPose()
    }
    return name
}
