import { Game, Input, InputSystem, Node, SequenceNode, UIButtonNode, UIRootNode } from 'cleo'

/**
 * The Valley — the start menu. Attach to the `Start Menu` node, a screen-space UI Root that is shown when
 * Play starts:
 *
 *   Backdrop
 *     Card
 *       Title        "The Valley"                              uiText
 *       Cinematic    plays the `Valley Tour` sequence          uiButton
 *       Free         flies the free camera (the Fly Camera)    uiButton
 *       Hint         the controls line                         uiText
 *
 * Up/Down (or the mouse) picks, Enter / Space / A confirms. Pause (P, Escape or Start) comes back here from
 * either mode: from the cinematic it stops the tour, which puts back everything the tour changed (the
 * camera, the sun). The tour coming to its end returns here too.
 *
 * The valley's day is the `Day Cycle` sequence (it plays by itself from the start, looping): under the menu
 * and through Free mode. The tour keys the sun itself, so the day is paused while it plays, and picks up again
 * where it was once the tour has put the sun back.
 *
 * It listens in a LATE UPDATE (`scene.addLateUpdate`), which runs every frame whatever the game is doing,
 * so the menu answers while the tour has the camera.
 *
 * Rendered to a movie from the editor (the Sequencer's Render), nobody is there to press a button:
 * `Game.movieRender` names what is filmed, and the menu goes straight into the tour, or out of the way.
 */
export default class ValleyStartMenuNode extends UIRootNode {
  /** The Sequence node the Cinematic button plays. */
  public tourName: string = 'Valley Tour'
  /** The Sequence node that runs the valley's day (paused while the tour has the sun). */
  public dayName: string = 'Day Cycle'
  /** Real seconds after the menu opens during which a confirm is ignored (the press that opened it). */
  public openGuard: number = 0.25
  public isOpen: boolean = false
  /** 'menu', 'cinematic' or 'free'. */
  public mode: string = 'menu'

  private _tour: SequenceNode = null
  private _day: SequenceNode = null
  private _buttons: UIButtonNode[] = []
  private _selected: number = 0
  private _navLast: number = 0
  private _clock: number = 0
  private _openedAt: number = 0
  private _stopListening: (() => void) | null = null
  private _stopFinished: (() => void) | null = null

  onStart() {
    this._tour = this.findNode(this.tourName) as SequenceNode
    this._day = this.findNode(this.dayName) as SequenceNode
    const cinematic = this._find('Cinematic') as UIButtonNode
    const free = this._find('Free') as UIButtonNode
    this._buttons = [cinematic, free].filter(b => !!b)
    if (cinematic) cinematic.onPress = () => this.playCinematic()
    if (free) free.onPress = () => this.playFree()
    this._stopFinished = this._tour?.onFinished(reason => { if (reason === 'finished') this._tourEnded() }) ?? null
    this._stopListening = this.scene?.addLateUpdate((_delta, unscaled) => this._listen(unscaled)) ?? null
    this.open()
    const movie = Game.movieRender
    if (movie && this._tour && movie.sequenceNodeId === this._tour.id) this.playCinematic()
    else if (movie) this._close('movie')
  }

  onDespawn() {
    this._stopListening?.()
    this._stopFinished?.()
    this._stopListening = this._stopFinished = null
  }

  /** Show the menu: no gameplay input, a free mouse. */
  public open(): void {
    this.isOpen = true
    this.mode = 'menu'
    this.visible = true
    this._openedAt = this._clock
    Input.disableMap('Gameplay')
    Input.releaseMouse()
    InputSystem.instance.pointerLockOnClick = false
    this._refresh()
  }

  /** Play the tour from the start. */
  public playCinematic(): void {
    if (!this._tour) return
    this._close('cinematic')
    this._day?.pause()
    this._tour.play()
  }

  /** The tour is over (or left): its sun goes back to the day's, and the day goes on. */
  private _stopTour(): void {
    this._tour?.stop()
    if (this._day?.isPaused) this._day.resume()
  }

  /** Fly the free camera. */
  public playFree(): void {
    this._close('free')
    Input.enableMap('Gameplay')
    InputSystem.instance.pointerLockOnClick = true
  }

  private _close(mode: string): void {
    this.isOpen = false
    this.mode = mode
    this.visible = false
    Game.resume()
  }

  /** The tour ran to its end: put the valley back as it was and offer the choice again. */
  private _tourEnded(): void {
    this._stopTour()
    this.open()
  }

  private _listen(unscaled: number): void {
    this._clock += unscaled
    if (!this.isOpen) {
      if (!Input.started('Pause')) return
      if (this.mode === 'cinematic') this._stopTour()
      this.open()
      return
    }
    if (this._clock - this._openedAt < this.openGuard) return
    const nav = Input.vector('Navigate')
    const dy = Math.abs(nav[1]) > 0.5 ? Math.sign(nav[1]) : 0
    if (dy !== 0 && dy !== this._navLast && this._buttons.length > 0) {
      // Navigate Y is positive UP; the buttons run top to bottom.
      this._selected = (this._selected - dy + this._buttons.length) % this._buttons.length
      this._refresh()
    }
    this._navLast = dy
    if (Input.started('Submit')) this._buttons[this._selected]?.press()
  }

  /** The selected button lit, the other dim. */
  private _refresh(): void {
    this._buttons.forEach((b, i) => {
      b.tint = i === this._selected ? [0.36, 0.3, 0.2, 1] : [0.16, 0.14, 0.12, 1]
    })
  }

  private _find(name: string, under: Node = this): Node {
    for (const child of under.children) {
      if (child.name === name) return child
      const deeper = this._find(name, child)
      if (deeper) return deeper
    }
    return null
  }
}
