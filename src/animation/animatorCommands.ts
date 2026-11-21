// Commands TO animators, on the event system's `animator` channel. A script does not reach for its character's
// animator and call it: it sends a command DOWN from its own node (`@animTrigger`, `@animAction`, `@animParam`, or
// `this.dispatchDown('animator:SetTrigger', 'Jump')`), and every animator under that node — a skeletal Animator on
// a model, an AnimatedSpriteNode — does what it says.
//
//   animator:SetTrigger     (name)                  raise a trigger
//   animator:ResetTrigger   (name)                  lower one still raised
//   animator:SetParam       (name, value)           a number or boolean parameter
//   animator:OverrideParam  (name, value | null)    pin a parameter over its linked value (null lets go)
//   animator:PlayAction     (clip, options?)        a one-shot in a slot (a sprite: play the clip); returns the handle
//   animator:StopAction     (slot?, blendOut?)      stop it
//   animator:ForceState     (state, blend?)         jump the machine to a state; returns whether it could
//   animator:FireEvent      (name)                  run the machine's Event Actions bound to `name`
//   animator:Resume         ()                      a sprite back on its state machine after a clip it was told to play
//
// The channel is not `animation`, which carries what animators SEND (clip markers, StateEnter, TriggerEnded…), so a
// clip marker can never be read as a command. Animators listen as SYSTEM listeners: they are found by a dispatch, but
// do not count as scripts listening, so `hasScriptListeners()` stays false in a scene where only animators listen.
import { addTargetListener } from '../core/events/hub';

/** The channel commands to animators travel on. */
export const ANIMATOR_CHANNEL = 'animator';

/** What a command can be applied to: whichever of these the animator has (an Animator, a sprite, a test's stub). */
export interface AnimatorCommandTarget {
    setTrigger?(name: string): void;
    resetTrigger?(name: string): void;
    setFloat?(name: string, value: number): void;
    setBool?(name: string, value: boolean): void;
    setParamOverride?(name: string, value: number | boolean | null): void;
    playAction?(clip: string, options?: Record<string, unknown>): unknown;
    stopAction?(slot?: string, blendOut?: number): void;
    forceState?(state: string, blend?: number): boolean;
    fireEvent?(name: string): void;
    // A sprite's names for the same things.
    fireTrigger?(name: string): void;
    setParam?(name: string, value: number | boolean): void;
    play?(clip: string, restart?: boolean): void;
    resumeMachine?(): void;
}

/**
 * Have `target` obey the animator commands sent to `node` (or down past it). Returns the function that stops it.
 * The Animator does this for its model node, and AnimatedSpriteNode for itself.
 */
export function bindAnimatorCommands(node: object, target: AnimatorCommandTarget): () => void {
    const on = (command: string, fn: (...args: any[]) => unknown) =>
        addTargetListener(node, `${ANIMATOR_CHANNEL}:${command}`, fn, { system: true });
    const offs = [
        on('SetTrigger', (name: string) => {
            if (typeof name !== 'string' || !name) return;
            if (target.setTrigger) target.setTrigger(name);
            else target.fireTrigger?.(name);
        }),
        on('ResetTrigger', (name: string) => {
            if (typeof name !== 'string' || !name) return;
            if (target.resetTrigger) target.resetTrigger(name);
            else target.setParam?.(name, false);
        }),
        on('SetParam', (name: string, value: number | boolean) => {
            if (typeof name !== 'string' || !name) return;
            if (target.setParam) target.setParam(name, value);
            else if (typeof value === 'boolean') target.setBool?.(name, value);
            else target.setFloat?.(name, Number(value));
        }),
        on('OverrideParam', (name: string, value: number | boolean | null | undefined) => {
            if (typeof name === 'string' && name) target.setParamOverride?.(name, value ?? null);
        }),
        on('PlayAction', (clip: string, options?: Record<string, unknown>) => {
            if (typeof clip !== 'string' || !clip) return undefined;
            if (target.playAction) return target.playAction(clip, options ?? {});
            target.play?.(clip, !!options?.restart);
            return undefined;
        }),
        on('StopAction', (slot?: string, blendOut?: number) => { target.stopAction?.(slot, blendOut); }),
        on('ForceState', (state: string, blend?: number) => target.forceState?.(state, blend)),
        on('FireEvent', (name: string) => { if (typeof name === 'string' && name) target.fireEvent?.(name); }),
        on('Resume', () => { target.resumeMachine?.(); }),
    ];
    return () => { for (const off of offs) off(); };
}
