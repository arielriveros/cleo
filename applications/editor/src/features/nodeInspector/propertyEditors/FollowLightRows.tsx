import { useEffect, useState } from 'react'
import { LightNode, type Node } from 'cleo'
import { PropertyRow, Select, Slider } from '@cleo/app-kit/ui'

/** Anything with the two follow fields: a Sprite, or a ParticleSystemNode. */
interface Follower {
  followLight: string | null
  followAmount: number
}

/**
 * The point and spot lights a node can follow, by name: under its parent and up to two more ancestors, a
 * few levels deep — the same search `findFollowedLight` resolves the name with.
 */
function nearbyLightNames(node: Node): string[] {
  const names = new Set<string>()
  const walk = (n: Node, depth: number) => {
    for (const c of n.children) {
      if (c instanceof LightNode && c.type !== 'directional') names.add(c.name)
      if (depth > 1) walk(c, depth - 1)
    }
  }
  let scope = node.parent
  for (let level = 0; scope && level < 3; level++, scope = scope.parent) walk(scope, 3)
  return [...names].sort((a, b) => a.localeCompare(b))
}

/**
 * Follow Light: burn on a light's beat. The node's brightness (and, for particles, the spawn rate) follows
 * the chosen light's flicker, so a flame, its embers and its light swell together.
 */
export default function FollowLightRows(props: { node: Node, target: Follower, onChange: () => void }) {
  const [light, setLight] = useState<string | null>(props.target.followLight)
  const [amount, setAmount] = useState(props.target.followAmount)
  useEffect(() => { setLight(props.target.followLight); setAmount(props.target.followAmount) }, [props.node])

  const names = nearbyLightNames(props.node)
  if (light && !names.includes(light)) names.unshift(light)

  return <>
    <PropertyRow label='Follow Light'
      hint="Burn on a nearby light's beat: brightness (and a particle system's spawn rate) follows that light's flicker, so a flame, its embers and its light swell together. Lights are found by name under this node's parent and a couple of levels above.">
      <Select value={light ?? ''} onChange={(e) => {
        const v = e.target.value || null
        props.target.followLight = v; setLight(v); props.onChange()
      }}>
        <option value=''>(none)</option>
        {names.map(n => <option key={n} value={n}>{n}</option>)}
      </Select>
    </PropertyRow>
    {light && <PropertyRow label='Follow Amount' hint="How much of the light's flicker it takes: 0 none, 1 all of it.">
      <Slider min={0} max={1} step={0.05} value={amount} readout onChange={(v) => {
        props.target.followAmount = v; setAmount(v); props.onChange()
      }} />
    </PropertyRow>}
  </>
}
