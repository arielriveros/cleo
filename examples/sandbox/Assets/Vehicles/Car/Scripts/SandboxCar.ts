import { ColliderNode, Input } from 'cleo'
import type { ActionName, CameraRigNode, ControllerNode, LayerName, LightNode, Node, PointLight, Spotlight, VehicleNode } from 'cleo'
import { attribute, child } from 'cleo/decorators'

/** What the car asks of the character who drives it (SandboxPlayer). */
interface Driver extends Node {
    readonly inVehicle: boolean
    readonly seated: boolean
    boardVehicle(seat: Node, enterPoint: Node): boolean
    leaveVehicle(): boolean
    cameraRig(): CameraRigNode | null
}

/** What the car asks of its camera rig (SandboxCarCamera). */
interface CarCamera extends Node {
    takeOver(rig: CameraRigNode): void
    handBack(): void
    release(): void
}

/**
 * The Sandbox car: getting in, driving, getting out. Attach to the car's root, its chassis **Collider**:
 *
 *   Car                 THIS script; the chassis (a dynamic Collider)
 *   ├─ Car Body         the car's body and its windows
 *   ├─ Lights           Headlight L/R (spot), Tail Light L/R (red), Reverse Light L/R (white): switched by THIS
 *   ├─ Vehicle          the vehicle simulation (Car preset), Parked unless someone drives
 *   │  └─ Wheels        the four Wheel nodes, each turning its wheel's mesh
 *   ├─ Seat             where the driver sits: Enter Point (where getting in starts), Exit Point (where getting out ends)
 *   ├─ Door Zone        a box by the driver's door: Interact there gets in
 *   ├─ Camera Target    what the car's camera rig follows
 *   ├─ Car Camera Rig   SandboxCarCamera, its camera off until someone drives
 *   └─ Car Controller   a player Controller that possesses the Vehicle while it is driven
 *
 * Interact by the door: the character in the Door Zone gets in (it lets go of its own Controller, and this car's
 * Controller takes the Vehicle; the car's camera takes over the view). Parked until the driver is seated. Interact
 * again: the car brakes to a stop if it is moving, then the driver gets out (if the Exit Point is clear) and
 * takes its own Controller back; the view goes back to its camera.
 *
 * The car decides when; the character decides how (its animator's triggers, its root motion). It plays nothing.
 *
 * The lamps: each light under Lights gives what it is set to when on. With someone in the car the headlights are on
 * and the tail lights glow at `tailShare` of theirs, full while the car brakes (its `braking`: the brake pedal,
 * Parked, or S held against the way it rolls); the reverse lights are on in reverse. An empty car's are all off.
 */
export default class SandboxCarNode extends ColliderNode {
    /** The action that gets in and out. */
    @attribute('Driving')
    public interactAction: ActionName = 'Interact'

    /** The collision layer of the characters that may drive it (who the Door Zone looks for). */
    @attribute('Driving')
    public driverLayer: LayerName = 'Character'

    /** Slower than this (m/s), the driver may get out; faster, Interact brakes the car first. */
    @attribute('Driving', { min: 0, max: 5, step: 0.05 })
    private exitSpeed: number = 0.3

    @child('Vehicle')
    private _vehicle: VehicleNode = null
    @child('Seat')
    private _seat: Node = null
    @child('Seat/Enter Point')
    private _enterPoint: Node = null
    @child('Seat/Exit Point')
    private _exitPoint: Node = null
    @child('Door Zone')
    private _doorZone: Node = null
    @child('Car Controller')
    private _controller: ControllerNode = null
    @child('Car Camera Rig')
    private _camera: CarCamera = null
    @child('Lights')
    private _lightsNode: Node = null

    /** The tail lights' glow while the car is not braking, as a share of their braking brightness. */
    @attribute('Lights', { min: 0, max: 1, step: 0.01 })
    public tailShare: number = 0.2
    /** Braking harder than this (0 .. 1) lights the brake lights. */
    @attribute('Lights', { min: 0, max: 1, step: 0.01 })
    public brakeThreshold: number = 0.05
    /** Seconds a lamp takes to come on or go off. */
    @attribute('Lights', { min: 0, max: 1, step: 0.01 })
    public lampSeconds: number = 0.06

    /** Each lamp, the lumens it was set to (what it gives when on), and its kind (by its name). */
    private _lamps: { light: LightNode; lumens: number; kind: 'head' | 'tail' | 'reverse' }[] | null = null

    /** Parked (empty), entering (the driver getting in), driving, stopping (braking to let the driver out), exiting. */
    private _state: 'parked' | 'entering' | 'driving' | 'stopping' | 'exiting' = 'parked'
    private _driver: Driver | null = null

    onUpdate(delta: number) {
        const vehicle = this._vehicle
        if (!vehicle) return
        const pressed = !!this.interactAction && Input.started(this.interactAction)
        switch (this._state) {
            case 'parked': {
                vehicle.parked = true
                if (pressed) this._board()
                break
            }
            case 'entering':
                vehicle.parked = true
                if (this._driver?.seated) this._state = 'driving'
                break
            case 'driving':
                vehicle.parked = false
                if (pressed) this._state = 'stopping'
                break
            case 'stopping':
                // Brakes on (Parked) until it stands still on its wheels; then out, if there is room to get out.
                vehicle.parked = true
                if (Math.abs(vehicle.speed) > this.exitSpeed || !this._onWheels()) break
                if (!this._exitClear()) { this._state = 'driving'; break }
                if (this._driver?.leaveVehicle()) { this._camera?.handBack(); this._state = 'exiting' }
                else this._state = 'driving'
                break
            case 'exiting':
                vehicle.parked = true
                if (this._driver && !this._driver.inVehicle) {
                    // Out and on its feet: its own camera and Controller have it again.
                    this._camera?.release()
                    this._controller?.release()
                    this._driver = null
                    this._state = 'parked'
                }
                break
        }
        this._updateLamps(delta)
    }

    /** The lamps toward what the car is doing: off when empty; on, braking and reversing with a driver. */
    private _updateLamps(delta: number) {
        const first = this._lamps === null
        if (first) {
            this._lamps = []
            for (const c of this._lightsNode?.children ?? []) {
                const light = c as LightNode
                if (c.nodeType !== 'light' || !light.light) continue
                const kind = c.name.startsWith('Head') ? 'head' : c.name.startsWith('Tail') ? 'tail' : c.name.startsWith('Reverse') ? 'reverse' : null
                if (kind) this._lamps.push({ light, lumens: (light.light as PointLight | Spotlight).intensity, kind })
            }
        }
        const vehicle = this._vehicle
        const occupied = this._state !== 'parked'
        const braking = occupied && !!vehicle && vehicle.braking > this.brakeThreshold
        const reversing = occupied && !!vehicle?.reversing
        // An instant switch on the first frame (the lamps as set are the lit ones), a bulb's warm-up after.
        const k = first || !(this.lampSeconds > 0) ? 1 : 1 - Math.exp(-delta / this.lampSeconds)
        for (const lamp of this._lamps!) {
            const share = lamp.kind === 'head' ? (occupied ? 1 : 0)
                : lamp.kind === 'tail' ? (braking ? 1 : occupied ? this.tailShare : 0)
                : reversing ? 1 : 0
            const light = lamp.light.light as PointLight | Spotlight
            const target = lamp.lumens * share
            light.intensity += (target - light.intensity) * k
            if (Math.abs(light.intensity - target) < lamp.lumens * 1e-3) light.intensity = target
        }
    }

    /** Whoever stands in the Door Zone and can drive gets in: the car's Controller takes the Vehicle, its camera the view. */
    private _board() {
        const driver = this._driverAtDoor()
        if (!driver || !this._seat || !this._enterPoint) return
        const rig = driver.cameraRig()
        if (!driver.boardVehicle(this._seat, this._enterPoint)) return
        this._driver = driver
        if (rig) this._camera?.takeOver(rig)
        this._controller?.possess(this._vehicle)
        this._state = 'entering'
    }

    /** A character in the Door Zone (its box) that answers boardVehicle. */
    private _driverAtDoor(): Driver | null {
        const physics = this.scene?.physics
        const zone = this._doorZone as (Node & { shapes?: { width?: number; height?: number; depth?: number }[] }) | null
        const box = zone?.shapes?.[0]
        if (!physics || !zone || !box) return null
        const half = [(box.width ?? 1) / 2, (box.height ?? 1) / 2, (box.depth ?? 1) / 2]
        const layerMask = physics.layer(this.driverLayer) || undefined
        for (const hit of physics.overlapBox(zone.worldPosition, half, zone.worldQuaternion, { layerMask, ignore: this })) {
            const character = hit.node?.character as unknown as Partial<Driver> | null | undefined
            if (character && typeof character.boardVehicle === 'function' && !character.inVehicle) return character as Driver
        }
        return null
    }

    /** Standing on its wheels (three or more on the ground): not in the air, not on its side. */
    private _onWheels(): boolean {
        const sim = this._vehicle?.vehicle
        if (!sim) return false
        let grounded = 0
        for (let i = 0; i < sim.wheelCount; i++) if (sim.wheel(i).grounded) grounded++
        return grounded >= Math.min(3, sim.wheelCount)
    }

    /** Room for the driver to stand at the Exit Point: a capsule there meets nothing solid but the car and the driver. */
    private _exitClear(): boolean {
        const physics = this.scene?.physics
        const point = this._exitPoint
        if (!physics || !point) return true
        const p = point.worldPosition
        const radius = 0.25
        const hits = physics.overlapCapsule([p[0], p[1] + radius + 0.15, p[2]], [p[0], p[1] + 1.6, p[2]], radius, {
            ignore: [this, ...(this._driver?.collider ? [this._driver.collider] : [])],
        })
        return hits.length === 0
    }
}
