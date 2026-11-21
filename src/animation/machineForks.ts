import type { AnimationFork, AnimationState, AnimationStateGroup, AnimationTransition } from './animator';

/**
 * Forks in a state machine, read without running it: what a name resolves to, which forks Any State reaches, and the
 * paths a transition can take through them. The Animator's own evaluation (animator.ts `_tryTransition`) tests the
 * gates as it walks; these are for the questions asked about a machine at rest — `triggerInfo`, how long a
 * triggered state lasts, the ping-pong report — and for the editor.
 *
 * Every function here returns exactly what the code before forks did for a machine without any.
 */

/** The parts of a machine (or of one layer) a transition's names resolve against. */
export interface MachineView {
    states: AnimationState[];
    transitions: AnimationTransition[];
    groups?: AnimationStateGroup[];
    forks?: AnimationFork[];
}

/** The most legs one path through forks may have: a cycle of forks ends there instead of hanging. */
export const FORK_DEPTH = 8;

/** Whether the view has any forks at all: everything else here short-cuts on it. */
export const hasForks = (m: MachineView): boolean => !!m.forks?.length;

/** What a transition's `to` enters: a state by its name, a group by its entry (its first member when unset), else the name. */
export function resolveIn(m: MachineView, name: string): string {
    if (m.states.some(s => s.name === name)) return name;
    const group = m.groups?.find(g => g.name === name);
    if (!group) return name;
    return group.entry && group.states.includes(group.entry) ? group.entry : (group.states[0] ?? name);
}

/** Whether `name` is a fork of this view. A state or a group of the same name wins, as everywhere names resolve. */
export function isForkIn(m: MachineView, name: string): boolean {
    if (!m.forks?.length || !m.forks.some(f => f.name === name)) return false;
    return !m.states.some(s => s.name === name) && !m.groups?.some(g => g.name === name);
}

/** Every fork a transition from Any State reaches, directly or through other forks (and group entries). */
export function forksFromAnywhere(m: MachineView): Set<string> {
    const reached = new Set<string>();
    if (!hasForks(m)) return reached;
    const queue: string[] = [];
    const visit = (to: string) => {
        const end = resolveIn(m, to);
        if (isForkIn(m, end) && !reached.has(end)) { reached.add(end); queue.push(end); }
    };
    for (const t of m.transitions) if (t.from === '*') visit(t.to);
    while (queue.length) {
        const fork = queue.shift()!;
        for (const t of m.transitions) if (t.from === fork) visit(t.to);
    }
    return reached;
}

/**
 * Where `name` ends up, read statically: a state (or a group's entry state); a fork follows its FIRST way out, which
 * is the one taken when nothing else decides. Null when that leads nowhere (a fork with no way out, a cycle).
 */
export function staticEnd(m: MachineView, name: string): string | null {
    let at = resolveIn(m, name);
    const seen: string[] = [];
    while (isForkIn(m, at)) {
        if (seen.includes(at) || seen.length >= FORK_DEPTH) return null;
        seen.push(at);
        const out = m.transitions.find(t => t.from === at);
        if (!out) return null;
        at = resolveIn(m, out.to);
    }
    return m.states.some(s => s.name === at) ? at : null;
}

/** One way a transition can go: the legs taken, and the `to` of the last (unresolved, as written). */
export interface MachinePath {
    legs: AnimationTransition[];
    to: string;
}

/**
 * Every way out of `from` (a state, a group, `'*'`), in the order they are tried: each transition from it, and for one
 * into a fork, each of the fork's ways out in turn (through chained forks too). A transition that does not go into a
 * fork is one path of one leg whose `to` is left as written, which is exactly what a walk over `transitions` saw
 * before forks existed.
 */
export function pathsFrom(m: MachineView, from: string): MachinePath[] {
    const out: MachinePath[] = [];
    const forks = hasForks(m);
    const expand = (legs: AnimationTransition[], seen: string[]) => {
        const last = legs[legs.length - 1];
        const end = forks ? resolveIn(m, last.to) : last.to;
        if (!forks || !isForkIn(m, end)) { out.push({ legs, to: last.to }); return; }
        if (seen.includes(end) || legs.length >= FORK_DEPTH) return;
        for (const t of m.transitions) if (t.from === end) expand([...legs, t], [...seen, end]);
    };
    for (const t of m.transitions) if (t.from === from) expand([t], []);
    return out;
}
