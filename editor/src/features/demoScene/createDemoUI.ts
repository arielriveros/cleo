import { UIState, cryptoRandomId } from '../../utils/UIModel'

// Default HUD + Game Over overlay demonstrating UI scripting + custom node variables.
// The HUD reads the 'playable' node's HealthPoints via getData and renders hearts.
// Press H (in play mode) to take damage; at 0 health the Game Over screen appears.
export function createDemoUI(): UIState {
  const hud: any = {
    id: cryptoRandomId(),
    type: 'text',
    name: 'HealthHUD',
    style: {
      position: 'absolute', left: '50%', top: 16, transform: 'translateX(-50%)',
      color: '#ffffff', fontSize: 26, fontWeight: 'bold', textAlign: 'center',
      textShadow: '0 2px 4px rgba(0,0,0,0.8)',
    },
    content: 'Health Left: ❤❤❤',
    script: [
      'function onStart(el, ctx) {',
      "  // Demo: press H to take damage",
      "  ctx.input.registerKeyPress('KeyH', function () {",
      "    const p = ctx.findNode('playable');",
      '    if (!p) return;',
      '    const hp = ctx.getData(p).HealthPoints;',
      "    if (hp > 0) ctx.setData(p, 'HealthPoints', hp - 1);",
      '  });',
      '}',
      'function onUpdate(el, ctx) {',
      "  const p = ctx.findNode('playable');",
      '  const hp = p ? ctx.getData(p).HealthPoints : 0;',
      "  ctx.ui.setText(el, 'Health Left: ' + '❤'.repeat(Math.max(0, hp)));",
      "  const over = ctx.ui.get('GameOver');",
      '  if (over) ctx.ui.setVisible(over, hp <= 0);',
      '}',
    ].join('\n'),
  }

  const gameOverTitle: any = {
    id: cryptoRandomId(), type: 'text', name: 'GameOverTitle',
    style: { position: 'relative', color: '#ffffff', fontSize: 64, fontWeight: 'bold', marginBottom: 24, textAlign: 'center' },
    content: 'Game Over',
  }

  const continueBtn: any = {
    id: cryptoRandomId(), type: 'button', name: 'ContinueButton',
    style: { position: 'relative', padding: 12, fontSize: 20, backgroundColor: '#2c2cff', color: '#fff', borderRadius: 8, border: 'none' },
    label: 'Continue',
    script: 'function onClick(el, ctx) { ctx.game.reset(); }',
  }

  const exitBtn: any = {
    id: cryptoRandomId(), type: 'button', name: 'ExitButton',
    style: { position: 'relative', padding: 12, fontSize: 20, backgroundColor: '#555', color: '#fff', borderRadius: 8, border: 'none' },
    label: 'Exit',
    script: 'function onClick(el, ctx) { ctx.game.exit(); }',
  }

  const buttonsRow: any = {
    id: cryptoRandomId(), type: 'container', name: 'GameOverButtons',
    style: { position: 'relative', display: 'flex', gap: 16, justifyContent: 'center' },
    children: [continueBtn, exitBtn],
  }

  const gameOver: any = {
    id: cryptoRandomId(), type: 'container', name: 'GameOver',
    visible: false, // hidden until health reaches 0 (runtime-only flag)
    style: {
      position: 'absolute', left: 0, top: 0, right: 0, bottom: 0,
      display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
      backgroundColor: 'rgba(0,0,0,0.75)', zIndex: 100, pointerEvents: 'auto', // modal: block the game behind it
    },
    children: [gameOverTitle, buttonsRow],
  }

  return { version: 1, elements: [hud, gameOver] }
}
