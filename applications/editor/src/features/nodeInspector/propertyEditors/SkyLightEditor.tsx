import { useEffect, useState } from 'react'
import { SkyLightNode } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { useCleoEngine } from '../../EngineContext'
import { SkyIcon } from '../sectionIcons'
import DeclaredSections from '../../properties/DeclaredSections'

type Vec3 = [number, number, number]

/**
 * The sky light has few authored values (its declared properties, src/properties/environment.ts); everything else
 * is derived from the sky itself. The L0 read-out separates "the projection has not landed" — a failed async
 * readback leaves flat ambient alone — from "the sky is dim".
 */
export default function SkyLightEditor(props: { node: SkyLightNode }) {
  const { instance } = useCleoEngine()

  // Polled, not pushed: the projection lands on whatever frame its readback resolves on.
  const [l0, setL0] = useState<Vec3 | null>(null)
  useEffect(() => {
    const read = () => {
      const sh = instance?.renderer.skyLightSH
      setL0(sh ? [sh[0], sh[1], sh[2]] : null)
    }
    read()
    const id = window.setInterval(read, 500)
    return () => window.clearInterval(id)
  }, [instance, props.node])

  return (
    <Collapsable title='Sky Light' icon={<SkyIcon />} persistKey='skyLight'>
      <div className='w-full p-2'>
        <DeclaredSections node={props.node} />
        <div className='mt-2 text-ui text-muted'>
          {l0
            ? `Sky colour (L0): ${l0.map(c => c.toFixed(2)).join(', ')}`
            : 'Waiting for the first sky projection…'}
        </div>
      </div>
    </Collapsable>
  )
}
