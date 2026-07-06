import { getData, setData, Logger, InputManager } from 'cleo'
import { UIElement } from '../../utils/UIModel'

// Runtime element = the plain UI element plus non-persisted runtime fields.
export type RuntimeElement = UIElement & {
  visible?: boolean
  _handlers?: UIHandlers
  children?: RuntimeElement[]
}

type UIHandlers = {
  onStart?: (el: RuntimeElement, ctx: UIContext) => void
  onUpdate?: (el: RuntimeElement, ctx: UIContext, delta: number, time: number) => void
  onClick?: (el: RuntimeElement, ctx: UIContext) => void
}

export type GameActions = { reset: () => void, exit: () => void, pause: () => void }

export type UIContext = {
  ui: {
    get: (nameOrId: string) => RuntimeElement | undefined
    setText: (el: RuntimeElement, text: string) => void
    setVisible: (el: RuntimeElement, visible: boolean) => void
    setStyle: (el: RuntimeElement, style: Record<string, any>) => void
    setImage: (el: RuntimeElement, src: string) => void
  }
  readonly scene: any
  getData: typeof getData
  setData: typeof setData
  findNode: (name: string) => any
  input: InputManager
  logger: (text: string) => void
  game: GameActions
}

// Compile a UI element's script into { onStart, onUpdate, onClick } handlers, mirroring the
// engine's node-script sandbox (top-level functions or module.exports).
function compileHandlers(source?: string): UIHandlers {
  if (!source || !source.trim()) return {}
  try {
    // Source runs at the function top level (not inside a block) so top-level `function`
    // declarations hoist to the function scope; module.exports handlers are also supported.
    const factory = new Function('Logger', `"use strict";
      const console = {
        log: (...a) => Logger.log(a.map(x => String(x)).join(' '), 'UI'),
        warn: (...a) => Logger.warn(a.map(x => String(x)).join(' '), 'UI'),
        error: (...a) => Logger.error(a.map(x => String(x)).join(' '), 'UI')
      };
      let exports = {}; let module = { exports };
      ${source}
      const ex = (module && typeof module.exports === 'object' && module.exports) ? module.exports : {};
      const pick = (fn, n) => (typeof fn === 'function' ? fn : (typeof ex[n] === 'function' ? ex[n] : null));
      return {
        onStart: pick(typeof onStart === 'function' ? onStart : null, 'onStart'),
        onUpdate: pick(typeof onUpdate === 'function' ? onUpdate : null, 'onUpdate'),
        onClick: pick(typeof onClick === 'function' ? onClick : null, 'onClick')
      };
    `)
    return factory(Logger) || {}
  } catch (e) {
    Logger.error('UI script compile error: ' + e, 'UI')
    return {}
  }
}

class UIRuntimeClass {
  private _tree: RuntimeElement[] = []
  private _running = false
  private _raf = 0
  private _lastTime = 0
  private _version = 0
  private _ctx: UIContext | null = null
  private _emit: (name: string) => void = () => {}
  private _getScene: () => any = () => null

  public start(elements: UIElement[], opts: { emit: (name: string) => void, getScene: () => any, game: GameActions }): void {
    this.stop()
    this._emit = opts.emit
    this._getScene = opts.getScene
    // Deep clone so runtime mutations don't touch the editor's UI state (functions are dropped, script string survives).
    this._tree = JSON.parse(JSON.stringify(elements))
    this._forEach(this._tree, el => {
      el.visible = el.visible !== false
      el._handlers = compileHandlers(el.script)
    })

    const self = this
    this._ctx = {
      ui: {
        get: (nameOrId) => self._findByNameOrId(nameOrId),
        setText: (el, text) => { if ((el as any).content !== text) { (el as any).content = text; self._version++ } },
        setVisible: (el, visible) => { if (el.visible !== visible) { el.visible = visible; self._version++ } },
        setStyle: (el, style) => { el.style = { ...(el.style || {}), ...style }; self._version++ },
        setImage: (el, src) => { if ((el as any).src !== src) { (el as any).src = src; self._version++ } },
      },
      get scene() { return self._getScene() },
      getData,
      setData,
      findNode: (name: string) => self._getScene()?.getNodesByName(name)?.[0],
      input: InputManager.instance,
      logger: (t: string) => Logger.log(t, 'UI'),
      game: opts.game,
    }

    this._forEach(this._tree, el => { try { el._handlers?.onStart?.(el, this._ctx!) } catch (e) { Logger.error('UI onStart: ' + e, 'UI') } })
    this._running = true
    this._lastTime = performance.now()
    this._emit('UI_RUNTIME_TICK')
    this._raf = requestAnimationFrame(this._loop)
  }

  public stop(): void {
    this._running = false
    if (this._raf) cancelAnimationFrame(this._raf)
    this._raf = 0
    this._tree = []
    this._emit('UI_RUNTIME_TICK')
  }

  public getTree(): RuntimeElement[] { return this._tree }
  public get running(): boolean { return this._running }

  public handleClick(id: string): void {
    const el = this._findByNameOrId(id)
    if (el && this._ctx) {
      try { el._handlers?.onClick?.(el, this._ctx) } catch (e) { Logger.error('UI onClick: ' + e, 'UI') }
      this._emit('UI_RUNTIME_TICK')
    }
  }

  private _loop = () => {
    if (!this._running) return
    const now = performance.now()
    const delta = (now - this._lastTime) / 1000
    this._lastTime = now
    const before = this._version
    this._forEach(this._tree, el => {
      try { el._handlers?.onUpdate?.(el, this._ctx!, delta, now / 1000) }
      catch (e) { Logger.error('UI onUpdate: ' + e, 'UI') }
    })
    if (this._version !== before) this._emit('UI_RUNTIME_TICK')
    this._raf = requestAnimationFrame(this._loop)
  }

  private _forEach(arr: RuntimeElement[], fn: (el: RuntimeElement) => void): void {
    for (const el of arr) {
      fn(el)
      if (el.children) this._forEach(el.children, fn)
    }
  }

  private _findByNameOrId(nameOrId: string): RuntimeElement | undefined {
    let found: RuntimeElement | undefined
    this._forEach(this._tree, el => { if (!found && (el.id === nameOrId || el.name === nameOrId)) found = el })
    return found
  }
}

export const UIRuntime = new UIRuntimeClass()
