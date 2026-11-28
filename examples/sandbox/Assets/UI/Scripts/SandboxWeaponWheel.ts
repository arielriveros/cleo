import { Game, MathUtils, UIPanelNode } from 'cleo'
import type { UINode, UITextNode } from 'cleo'
import { attribute } from 'cleo/decorators'

/** What a slot shows: the weapon's name, and what it has left ('' for none). */
export interface WheelSlot {
    name: string
    ammo: string
}

/** The slots round the wheel, clockwise from the top: none, the pistol, the rifle, the shotgun (the weapon numbers). */
const SLOT_NAMES = ['Slot Unarmed', 'Slot Pistol', 'Slot Rifle', 'Slot Shotgun']

const IDLE_TINT: [number, number, number, number] = [0.04, 0.05, 0.06, 0.62]
const LIT_TINT: [number, number, number, number] = [0.96, 0.66, 0.2, 0.9]
const IDLE_BORDER: [number, number, number, number] = [1, 1, 1, 0.14]
const LIT_BORDER: [number, number, number, number] = [1, 0.86, 0.55, 1]
const IDLE_TEXT: [number, number, number, number] = [0.86, 0.88, 0.9, 1]
const LIT_TEXT: [number, number, number, number] = [0.06, 0.05, 0.04, 1]

/**
 * The Sandbox's weapon wheel: four slots round a hub, the weapon numbers clockwise from the top (none, the pistol,
 * the rifle, the shotgun). Attach to the **Weapon Wheel** panel of the player's HUD; SandboxPlayer opens it while
 * Equip is held and takes out what it points at when Equip is let go.
 *
 *   Weapon Wheel    THIS script: a square panel in the middle of the screen
 *   ├─ Wheel Ring   the disc behind the slots
 *   ├─ Wheel Pointer   a dot on the ring, toward where the mouse or the stick points
 *   ├─ Wheel Hub    the middle: Wheel Name and Wheel Ammo, of the slot pointed at
 *   └─ Slot Unarmed, Slot Pistol, Slot Rifle, Slot Shotgun   each with its Label and Ammo (and the weapons their
 *                                                             Icon: the weapon's side, white, tinted with the slot)
 *
 * The mouse steers it as a cursor that stays inside the ring (`mouseRange` pixels to the rim); a stick points
 * straight at a slot. A slot lights up once the pointer is past `deadZone` of the way to the rim, and stays lit when
 * the pointer comes back: letting go takes out the last one lit (the weapon in the hands, until it moves). Open, it
 * slows the game to `slowMotion` (the camera, the input and the wheel run on in real time), easing in and out over
 * `fadeSeconds` as the wheel fades.
 */
export default class SandboxWeaponWheelNode extends UIPanelNode {
    /** The game's speed while the wheel is open (1: it does not slow). */
    @attribute('Wheel', { min: 0.05, max: 1, step: 0.05 })
    public slowMotion: number = 0.3

    /** Seconds it takes to fade in, and out (real time). */
    @attribute('Wheel', { min: 0.01, max: 1, step: 0.01 })
    private fadeSeconds: number = 0.12

    /** Pixels of mouse movement from the middle to the rim. */
    @attribute('Wheel', { min: 20, max: 600, step: 10 })
    private mouseRange: number = 140

    /** How far out the pointer must be (a share of the rim) to light a slot. */
    @attribute('Wheel', { min: 0.05, max: 0.9, step: 0.05 })
    private deadZone: number = 0.35

    /** The Look action's stick scale (its binding's `scale` processor): a stick pushed all the way reads this. */
    @attribute('Wheel', { min: 1, max: 20, step: 0.5 })
    private stickRange: number = 8

    /** Where the pointer dot rides round the hub, units from the middle. */
    @attribute('Wheel', { min: 0, max: 400, step: 5 })
    private pointerRadius: number = 98

    /** Open: what SandboxPlayer asked for. The slot lit: what letting go takes out. */
    public isOpen: boolean = false
    public highlighted: number = 0

    private _wheelCursor: number[] = [0, 0]
    /** 0 closed, 1 open (even in real time; eased as drawn). */
    private _wheelShown: number = 0
    /** Each slot's light, 0..1, easing toward the one lit. */
    private _wheelLight: number[] = [0, 0, 0, 0]
    private _wheelInfo: WheelSlot[] = []
    private _wheelEquipped: number = 0
    /** Whether the wheel has the game's speed (and so must give it back). */
    private _wheelSlowed: boolean = false
    private _wheelParts: {
        slots: (UINode | null)[], labels: (UITextNode | null)[], ammo: (UITextNode | null)[], icons: (UINode | null)[],
        pointer: UINode | null, name: UITextNode | null, count: UITextNode | null,
    } | null = null

    onStart() {
        this._wheelResolve()
        this.visible = false
        this.opacity = 0
    }

    onDespawn() {
        this._wheelGiveTime()
    }

    /** Open on `current` (lit to start with), the slots showing `info` (one per weapon number). */
    public openWheel(current: number, info: WheelSlot[]) {
        this.isOpen = true
        this.highlighted = current
        this._wheelEquipped = current
        this._wheelInfo = info
        this._wheelCursor[0] = 0; this._wheelCursor[1] = 0
        this._wheelText()
    }

    /** Close; returns the slot lit (the weapon to take out). */
    public closeWheel(): number {
        this.isOpen = false
        return this.highlighted
    }

    /**
     * Point the wheel: `x`, `y` this frame's Look vector, `stick` whether a stick drove it (a stick points, the mouse
     * moves a cursor). +x right, +y down the screen for both: Look is the camera's, where +y pitches down (its stick
     * binding scales the up-positive stick by a negative `stickRange`).
     */
    public steer(x: number, y: number, stick: boolean) {
        const c = this._wheelCursor
        if (stick) {
            c[0] = x / this.stickRange
            c[1] = -y / this.stickRange
        } else {
            c[0] += x / this.mouseRange
            c[1] -= y / this.mouseRange
        }
        const len = Math.hypot(c[0], c[1])
        if (len > 1) { c[0] /= len; c[1] /= len }
        if (len >= this.deadZone) {
            // Clockwise from the top: 0 up, 1 right, 2 down, 3 left.
            const angle = Math.atan2(c[0], c[1])
            const k = ((Math.round(angle / (Math.PI / 2)) % 4) + 4) % 4
            if (k !== this.highlighted) { this.highlighted = k; this._wheelText() }
        }
    }

    onUpdate(delta: number) {
        // Real time: the wheel slows the game it runs over.
        const real = Game.unscaledDelta > 0 ? Game.unscaledDelta : delta
        const step = real / Math.max(0.01, this.fadeSeconds)
        const was = this._wheelShown
        this._wheelShown = this.isOpen ? Math.min(1, was + step) : Math.max(0, was - step)
        const shown = this._wheelShown
        if (shown <= 0) {
            if (this.visible) this.visible = false
            this._wheelGiveTime()
            return
        }
        if (!this.visible) this.visible = true
        const e = MathUtils.smoothstep(0, 1, shown)
        this.opacity = e
        const s = 0.88 + 0.12 * e
        this.scale2d = [s, s]
        if (this.slowMotion < 1) {
            Game.timeScale = 1 + (this.slowMotion - 1) * e
            this._wheelSlowed = true
        }
        this._wheelDraw(real)
    }

    /** The game's speed back, if the wheel had it. */
    private _wheelGiveTime() {
        if (!this._wheelSlowed) return
        this._wheelSlowed = false
        Game.timeScale = 1
    }

    private _wheelResolve() {
        const find = (parent: any, name: string): any => parent?.getChildByName(name)[0] ?? null
        const slots = SLOT_NAMES.map(n => find(this, n))
        const hub = find(this, 'Wheel Hub')
        this._wheelParts = {
            slots,
            labels: slots.map(s => find(s, 'Label')),
            ammo: slots.map(s => find(s, 'Ammo')),
            icons: slots.map(s => find(s, 'Icon')),
            pointer: find(this, 'Wheel Pointer'),
            name: find(hub, 'Wheel Name'),
            count: find(hub, 'Wheel Ammo'),
        }
    }

    /** The slots' names and counts, and the hub's: the slot lit. */
    private _wheelText() {
        const parts = this._wheelParts
        if (!parts) return
        for (let k = 0; k < 4; k++) {
            const info = this._wheelInfo[k]
            const label = parts.labels[k], ammo = parts.ammo[k]
            if (label && info) label.text = info.name
            if (ammo && info) ammo.text = info.ammo
        }
        const lit = this._wheelInfo[this.highlighted]
        if (parts.name) parts.name.text = lit?.name ?? ''
        if (parts.count) parts.count.text = this.highlighted === this._wheelEquipped ? 'In hand' : (lit?.ammo ?? '')
    }

    /** Each frame it shows: the slots lit or not (eased), the pointer where the cursor points. */
    private _wheelDraw(real: number) {
        const parts = this._wheelParts
        if (!parts) return
        const mix = (a: number[], b: number[], t: number): [number, number, number, number] =>
            [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]
        for (let k = 0; k < 4; k++) {
            const goal = k === this.highlighted ? 1 : 0
            this._wheelLight[k] = MathUtils.damp(this._wheelLight[k], goal, 18, real)
            const t = this._wheelLight[k]
            const slot = parts.slots[k]
            if (slot) {
                slot.tint = mix(IDLE_TINT, LIT_TINT, t)
                slot.borderColor = mix(IDLE_BORDER, LIT_BORDER, t)
                const s = 1 + 0.1 * t
                slot.scale2d = [s, s]
            }
            const text = mix(IDLE_TEXT, LIT_TEXT, t)
            if (parts.labels[k]) parts.labels[k]!.tint = text
            if (parts.ammo[k]) parts.ammo[k]!.tint = [text[0], text[1], text[2], 0.75]
            if (parts.icons[k]) parts.icons[k]!.tint = [text[0], text[1], text[2], 0.92]
        }
        const pointer = parts.pointer
        if (pointer) {
            const c = this._wheelCursor
            const len = Math.hypot(c[0], c[1])
            pointer.opacity = Math.min(1, len / Math.max(0.01, this.deadZone))
            const r = this.pointerRadius
            // Screen units run down: the cursor's +y is up.
            const x = len > 1e-4 ? c[0] / len * r : 0, y = len > 1e-4 ? -c[1] / len * r : 0
            pointer.offsetMin = [x - 9, y - 9]
            pointer.offsetMax = [x + 9, y + 9]
        }
    }
}
