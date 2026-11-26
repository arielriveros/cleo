import { defaultReactionSet, parseReactionSet, type ReactionSet } from 'cleo'
import type { PoseAsset } from '../../../utils/poseAssets'
import { runtimeReactionSets, type RigReactions } from '../../../utils/reactionSets'

/**
 * The set the bench runs: the rig's set `index` as it is being edited (poses resolved, as it will be embedded),
 * else the built-in default the skeleton reacts with when it has none.
 */
export function benchReactionSet(reactions: RigReactions | undefined | null, poseAssets: PoseAsset[], index: number): ReactionSet {
  const sets = runtimeReactionSets(reactions, poseAssets)?.sets ?? []
  const raw = sets[index] ?? sets[0]
  return raw ? parseReactionSet(raw, index) : defaultReactionSet()
}
