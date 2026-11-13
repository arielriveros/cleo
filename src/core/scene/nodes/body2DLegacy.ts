import { Logger } from "../../logger";

// Loading a 2D body saved with the built-in platformer controller, from before the platformer moved to the
// game's scripts (player contract 34). Its tuning is mapped in CharacterBody2DNode.parse; what this adds is
// the DRIVER it no longer carries: a body that read the player's input itself gets a "Player Controller"
// child possessing it, reading the same actions, so an old 2D game still runs and jumps when loaded. Its
// dash, double jump and wall jump are the game's to script now, and are dropped with a note.
//
// A pure JSON transform, so parseNodeJson can call it before the class parse with no import cycle.

let _noted = false;

/** The body's JSON, with a Player Controller child added when it was a player-driven platformer body. */
export function migrateLegacyBody2DJson(json: any): any {
    const d = json?.characterBody2D;
    if (!d || typeof d !== 'object' || !d.settings || typeof d.settings !== 'object') return json;
    const abilities = d.abilities ?? {};
    if (!_noted && (abilities.doubleJump || abilities.dash || abilities.wallJump)) {
        _noted = true;
        Logger.info(`'${json.name}': the 2D platformer's dash, double jump and wall jump are no longer built in; ` +
            `write them in the body's script (onMove2D). Its running and jumping carry over.`, 'Scene');
    }
    if (d.controller === 'none' || d.playerInput === false) return json;
    const children: any[] = Array.isArray(json.children) ? json.children : [];
    if (children.some(c => c?.type === 'controller')) return json;
    const controller = {
        type: 'controller',
        name: 'Player Controller',
        id: `${json.id}:player-controller`,
        position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        children: [],
        possessedId: json.id,
        controlSource: 'player',
        moveAction: typeof d.moveAction === 'string' ? d.moveAction : 'Move',
        jumpAction: typeof d.jumpAction === 'string' ? d.jumpAction : 'Jump',
        lookAction: '', sprintAction: '', crouchAction: '',
        aimSource: 'world',
        driveAimTarget: false,
    };
    return { ...json, children: [...children, controller] };
}
