/**
 * Conditions: a parameter comparison, an AND/OR tree of them, and the latching that makes a threshold
 * stop chattering.
 *
 * Lifted out of `animator.ts`, where it grew up driving animation transitions, because it is not about
 * animation at all — it reads a table of named values and answers yes or no. The behavior state machine
 * needs exactly the same thing, and `animator.ts` pulls in the whole graphics stack, so a second copy
 * was the only alternative. Two copies of a hysteresis latch is two chances to get the band wrong.
 *
 * A LEAF: this module imports nothing, not even gl-matrix. Everything stateful is carried by the caller
 * in a {@link ConditionContext}, the same shape `resolveFrame` and `stepLocomotion` use — so the whole
 * file is a pure function of its arguments and can be tested by writing numbers into a Map.
 *
 * The one subtle rule, and the reason latches are exposed separately from evaluation:
 * {@link updateLatch} must run for EVERY condition in a machine once per frame, not only for the ones
 * about to be evaluated. A `>`/`<` pair usually sits on two different states, and a band that only
 * advanced while its own state was current would leave both halves latched on and satisfiable at the
 * same value — which reads as a machine that ping-pongs for no visible reason.
 */

/** Comparison operator, interpreted per parameter type. */
export const CONDITION_OPS = ['gt', 'lt', 'eq', 'neq', 'true', 'false', 'trigger'] as const;
export type ConditionOp = typeof CONDITION_OPS[number];

export interface Condition {
    param: string;
    op: ConditionOp;
    /** Threshold for the numeric operators ('gt' | 'lt' | 'eq' | 'neq'). */
    value?: number;
    /**
     * Full width of a latching band CENTRED on `value`, for 'gt' and 'lt' only: `> value` engages at
     * `value + h/2` and releases at `value - h/2`. Centring is what pushes a `>`/`<` pair's two engage
     * points apart; widening only the release would leave both halves satisfiable at the same value.
     */
    hysteresis?: number;
}

/** An AND/OR gate over conditions and nested gates. */
export interface ConditionGroup {
    op: 'and' | 'or';
    children: ConditionNode[];
}

export type ConditionNode = Condition | ConditionGroup;

/** A group carries `children`, a leaf carries `param`. `op` cannot discriminate them — both have one. */
export function isConditionGroup(node: ConditionNode): node is ConditionGroup {
    return 'children' in node;
}

/**
 * Everything evaluation reads and writes. `values` is the parameter table the caller refreshes each
 * frame; `latches` is the hysteresis state, keyed by {@link latchKey}.
 *
 * Carried by the caller rather than held here so two machines cannot share a latch, and so a test can
 * drive the evaluator by writing a Map.
 */
export interface ConditionContext {
    values: Map<string, number | boolean>;
    latches: Map<string, boolean>;
}

export function createConditionContext(): ConditionContext {
    return { values: new Map(), latches: new Map() };
}

/** Identity of a condition's band: the terms it asks about, so two identical conditions share one latch. */
export function latchKey(c: Condition): string {
    return `${c.param}|${c.op}|${c.value ?? 0}|${c.hysteresis ?? 0}`;
}

/**
 * Advance one hysteresis band. Idempotent within a frame — engaging is the stricter test, so running it
 * again after the per-frame refresh cannot flip a latch that just engaged.
 *
 * A no-op for any condition without a positive `hysteresis`, and for any operator but 'gt'/'lt'.
 */
export function updateLatch(ctx: ConditionContext, c: Condition): void {
    if (c.op !== 'gt' && c.op !== 'lt') return;
    const h = typeof c.hysteresis === 'number' && c.hysteresis > 0 ? c.hysteresis : 0;
    if (h === 0) return;
    const v = ctx.values.get(c.param);
    if (typeof v !== 'number') return;

    const greater = c.op === 'gt';
    const threshold = c.value ?? 0;
    const half = h / 2;
    const engage = greater ? threshold + half : threshold - half;
    const release = greater ? threshold - half : threshold + half;

    const key = latchKey(c);
    const met = ctx.latches.get(key) === true
        ? (greater ? v > release : v < release)
        : (greater ? v > engage : v < engage);
    ctx.latches.set(key, met);
}

/**
 * Visit every condition LEAF of a gate, whichever shape it is stored in.
 *
 * Both arms exist because the animation machine still carries a legacy flat, implicitly-ANDed
 * `conditions[]` alongside the newer `condition` tree. `root` wins whenever it is present.
 */
export function forEachCondition(
    root: ConditionNode | undefined,
    flat: readonly Condition[] | undefined,
    visit: (c: Condition) => void,
): void {
    if (root) {
        const walk = (node: ConditionNode) => {
            if (isConditionGroup(node)) node.children.forEach(walk);
            else visit(node);
        };
        walk(root);
        return;
    }
    flat?.forEach(visit);
}

/** Whether one condition holds right now. Advances its own band first, so it is safe to call alone. */
export function conditionMet(ctx: ConditionContext, c: Condition): boolean {
    const v = ctx.values.get(c.param);
    switch (c.op) {
        case 'trigger': return v === true;
        case 'true': return v === true;
        case 'false': return v === false;
        case 'gt': return typeof v === 'number' && thresholdMet(ctx, c, v, true);
        case 'lt': return typeof v === 'number' && thresholdMet(ctx, c, v, false);
        case 'eq': return typeof v === 'number' && v === (c.value ?? 0);
        case 'neq': return typeof v === 'number' && v !== (c.value ?? 0);
        default: return false;
    }
}

function thresholdMet(ctx: ConditionContext, c: Condition, v: number, greater: boolean): boolean {
    const threshold = c.value ?? 0;
    if (!(typeof c.hysteresis === 'number' && c.hysteresis > 0)) {
        return greater ? v > threshold : v < threshold;
    }
    // Idempotent, so calling it here as well as in the per-frame refresh is safe.
    updateLatch(ctx, c);
    return ctx.latches.get(latchKey(c)) === true;
}

/** Whether a node of the tree holds — a leaf, or the AND/OR of its children. */
export function conditionNodeMet(ctx: ConditionContext, node: ConditionNode): boolean {
    if (!isConditionGroup(node)) return conditionMet(ctx, node);
    // An EMPTY group is no constraint, for OR as much as AND: a half-authored group must not block the
    // transition forever, and an empty condition list means "always fires".
    if (node.children.length === 0) return true;
    return node.op === 'or'
        ? node.children.some(c => conditionNodeMet(ctx, c))
        : node.children.every(c => conditionNodeMet(ctx, c));
}

/** A whole gate: the compound tree when present, else the legacy flat (implicitly ANDed) list. */
export function gateMet(
    ctx: ConditionContext,
    root: ConditionNode | undefined,
    flat: readonly Condition[] | undefined,
): boolean {
    if (root) return conditionNodeMet(ctx, root);
    return (flat ?? []).every(c => conditionMet(ctx, c));
}

/**
 * Lower every trigger parameter named anywhere in a gate.
 *
 * EVERY leaf, including ones under an OR branch that did not contribute to the result: a trigger left
 * raised would fire some unrelated transition on the next frame, which presents as a machine that skips
 * a state at random.
 */
export function consumeTriggers(
    ctx: ConditionContext,
    root: ConditionNode | undefined,
    flat: readonly Condition[] | undefined,
): void {
    forEachCondition(root, flat, c => { if (c.op === 'trigger') ctx.values.set(c.param, false); });
}

// ---------------------------------------------------------------------------------------------------
// Tolerant reader
// ---------------------------------------------------------------------------------------------------

function num(v: unknown, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Read a condition leaf out of untrusted JSON, or null if it names no parameter. An unknown operator
 * falls back to 'true' rather than dropping the leaf: a condition that never holds silently disables the
 * transition it guards, while one that always holds is at least visible in the editor.
 */
export function parseCondition(raw: unknown): Condition | null {
    if (!raw || typeof raw !== 'object') return null;
    const c = raw as Record<string, unknown>;
    const param = typeof c.param === 'string' ? c.param.trim() : '';
    if (!param) return null;

    const op = typeof c.op === 'string' && (CONDITION_OPS as readonly string[]).includes(c.op)
        ? c.op as ConditionOp : 'true';
    const out: Condition = { param, op };
    if (op === 'gt' || op === 'lt' || op === 'eq' || op === 'neq') out.value = num(c.value, 0);
    // Only ever written when positive, so a round trip through the reader is byte-identical.
    const hysteresis = num(c.hysteresis, 0);
    if ((op === 'gt' || op === 'lt') && hysteresis > 0) out.hysteresis = hysteresis;
    return out;
}

/**
 * Read a whole gate. Unreadable leaves are dropped while their siblings keep their order; a group whose
 * children all drop stays as an empty group, which reads as "no constraint" rather than as a transition
 * that can never fire.
 */
export function parseConditionNode(raw: unknown): ConditionNode | null {
    if (!raw || typeof raw !== 'object') return null;
    const node = raw as Record<string, unknown>;
    if (!Array.isArray(node.children)) return parseCondition(raw);

    const children: ConditionNode[] = [];
    for (const entry of node.children) {
        const child = parseConditionNode(entry);
        if (child) children.push(child);
    }
    return { op: node.op === 'or' ? 'or' : 'and', children };
}
