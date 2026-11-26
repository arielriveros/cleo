// Every example project opens and plays: its main scene loaded the way a published game loads it, on the headless
// engine (cleo/testing openProject), and stepped for a few seconds without a single error logged. Run by each
// example's tests/boots.test.ts.

import { describe, it, expect, vi } from 'vitest'
import { Logger } from 'cleo'
import { openProject } from 'cleo/testing'
import { dataReady } from '../testKit'

export function bootSpecs({ seconds = 3, scenes = [] as string[] } = {}): void {
  describe.skipIf(!dataReady())('the project, played', () => {
    for (const scene of [undefined, ...scenes]) {
      it(`plays ${scene ? `"${scene}"` : 'its main scene'} for ${seconds} s with no error`, async () => {
        const errors: string[] = []
        const spy = vi.spyOn(Logger, 'error').mockImplementation((message: unknown) => { errors.push(String(message)) })
        const game = await openProject({ scene })
        try {
          game.step(seconds)
          expect(game.scene.root.children.length).toBeGreaterThan(0)
        } finally {
          game.dispose()
          spy.mockRestore()
        }
        expect(errors).toEqual([])
      }, 300_000) // a whole project built and played here: the Valley's is hundreds of MB, minutes beside a full run
    }
  })
}
