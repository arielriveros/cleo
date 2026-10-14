import { describe, it, expect, vi } from 'vitest';
import { Node } from '../src/core/scene/nodes/node';
import { Scene } from '../src/core/scene/scene';
import { playDetached, playSound, soundOf } from '../examples/scripts/SoulsAudio';

// Hollow Keep's sounds are owned: a cue lives in a `Sounds` group of the template that plays it, and a
// script finds it by walking up to the nearest owner. These pin that lookup.

/** A stand-in SoundNode: a plain node with play/stop spies. */
function cue(name: string): Node & { play: any; stop: any } {
    const n = new Node(name) as any;
    n.play = vi.fn();
    n.stop = vi.fn();
    return n;
}

function owner(name: string, cues: string[]): Node {
    const root = new Node(name);
    const sounds = new Node('Sounds');
    for (const c of cues) sounds.addChild(cue(c));
    root.addChild(sounds);
    return root;
}

describe('SoulsAudio', () => {
    it('plays the cue of the nearest owner up the tree', () => {
        const player = owner('Player', ['Swing', 'Menu Tick']);
        const menu = new Node('BonfireMenu');
        player.addChild(menu);
        playSound(menu, 'Menu Tick');
        expect((soundOf(menu, 'Menu Tick') as any).play).toHaveBeenCalledTimes(1);
        expect(soundOf(player, 'Swing')?.name).toBe('Swing');
    });

    it('stops at the first owner, even when the cue is missing there', () => {
        const player = owner('Player', ['Hit']);
        const weapon = owner('Sword', ['Swing']);
        player.addChild(weapon);
        expect(soundOf(weapon, 'Hit')).toBeNull();
        expect(() => playSound(weapon, 'Hit')).not.toThrow();
        expect(soundOf(new Node('loose'), 'Hit')).toBeNull();
    });

    it('moves a detached cue to the scene root, plays it, and survives its owner', () => {
        const scene = new Scene();
        const bolt = owner('Magic Bolt', ['Bolt Impact']);
        scene.addNode(bolt);
        const sound = soundOf(bolt, 'Bolt Impact') as any;
        playDetached(bolt, 'Bolt Impact', 2);
        expect(sound.parent).toBe(scene.root);
        expect(sound.play).toHaveBeenCalledTimes(1);
        bolt.remove();
        expect(scene.getNodeById(sound.id)).toBeTruthy();
    });
});
