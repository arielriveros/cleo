# AI brains

*Unreleased — this asset and its editor landed after v1.1.2.4.*

A **brain** is what an agent decides with, named and reusable. It is a `.brain` asset with its own
editor tab and three graph canvases.

An agent itself — perception, steering, flocking, possession — is the
[Controller node](ai-agents.md). Those describe the *agent*; a brain describes *what it decides
with*, which is why they are separate and why one brain can drive many agents.

## A brain is one kind or the other

A brain is **either** a behaviour state machine **or** a goal graph, chosen when you create it. The
kind decides which canvas its editor opens; it is not a mode you flip per session.

| Kind | Shape | Good for |
|---|---|---|
| **Machine** | States are goals; transitions are gated by condition trees. | Explicit, readable behaviour: patrol → chase → attack. You know exactly why it did what it did. |
| **Goals** | Goals with desirability scores, arbitrated periodically; composites made of subgoals. | Agents that weigh options — flee when hurt, loot when safe, fight when cornered. |

Both halves exist in the file regardless (the unused one is empty), so switching kind loses nothing.

Beside them sits a **fuzzy model**, which **both kinds read**. It is in the brain rather than
alongside it because a behaviour parameter can read a fuzzy output — and a machine separated from
its fuzzy model would silently read all zeros.

## Creating and linking one

Four ways in:

- **Assets ▸ + Add ▸ AI Brain (Machine)** or **AI Brain (Goals)**.
- A Controller's **Brain** slot: **+ Machine** or **+ Goals**.
- The Brain slot's **Use existing…** picker.
- Drag a `.brain` from the Assets panel onto the Brain slot.

The Brain slot also offers **Extract to asset** when a controller already has behaviour authored on
it — that lifts the existing machine or graph into a new asset named after the node and links it.

Opening a brain — double-clicking it in Assets, or the ✎ on the slot — opens its tab.

## The important thing: a brain is a copy

The controller's own `behavior`, `goals` and `fuzzy` are the **runtime source of truth** and travel
inside the serialized scene. The brain asset is an authoring convenience, and the link only records
where the copy came from.

Consequences, all of them deliberate:

| Action | Effect |
|---|---|
| **Saving a brain** | Pushes a fresh copy into every controller linked to it. |
| **Unlinking (✕)** | The agent keeps behaving exactly as it does now. Only the link goes. |
| **Deleting the asset** | Controllers keep the brain they copied. Nothing is lobotomised. |
| **Publishing** | No brain library ships at all. |
| **A missing asset** | The slot warns, and the agent still runs the copy it holds. |

Existing scenes are migrated once, automatically: any controller with behaviour authored inline and
no link gets an asset named `<node> brain` and a link to it. The editor logs how many it moved and
reminds you to save.

## The editor

The tab shows one canvas plus an inspector, and a segmented switch in the corner:

**Behaviour | Goals** ⟷ **Fuzzy**

Which of the first two you get is the asset's kind, not a choice. The brain's **name is editable in
place** in the toolbar.

The split between the two halves is consistent across all three canvases:

- **The canvas edits structure** — what exists and what connects to what.
- **The inspector edits detail** — condition trees, desirability curves, fuzzy set shapes.

The inspector lists stay complete rather than following the selection, because machine *parameters*
and fuzzy *variables* are not on the canvas at all.

## The Behaviour canvas

Nodes are **states**; each names a goal. An edge is a transition.

| | |
|---|---|
| Node subtitle | the state's goal |
| Node badge | `→targetKey` or `×speedScale` |
| Entry state | flagged |
| Edge label | a summary of the gate — `param > value`, `⏱2s` for a dwell, joined `⇄` when bidirectional, `+N` when there are more |

**Actions:** **+ State** or double-click to add one (the first is automatically the entry). Drag
handle to handle to make a transition; duplicates are refused. Right-click a state for **Set as
entry** or **Delete**. Delete removes states and **both directions** of an edge.

While the game is playing, the current state is highlighted live.

> Wildcard transitions (`from: '*'`) are **not drawn** — there is no node to draw them from. The
> hint line says how many were skipped, so they are not invisible, just not on the canvas.

A machine only evaluates the transitions leaving the state it is currently in, which is what keeps
layered machines predictable: while in `Jump`, nothing about `Idle` is even looked at.

## The Goals canvas

Nodes are **goals**. A composite (one with subgoals) is tinted and marked `▽` with a "N subgoals"
subtitle; a leaf shows its goal verb.

> **An edge means containment, not a transition.** `A → B` reads "B is a subgoal of A", and the
> number on the edge is its **execution order** — which is load-bearing, because subgoals run in
> order.

A goal with no evaluator shows a **`no eval`** warning badge: it can only ever run as a subgoal, and
can never be chosen.

**Actions:** **+ Goal** or double-click. Drag handle to handle to nest a subgoal; self-links and
duplicates are refused, and deeper cycles are broken when the graph is read. Deleting a goal also
removes every reference to it as a subgoal and its evaluator. Clicking an **edge** selects the
*parent* goal, which is where reordering happens.

There is no entry state — a goal graph arbitrates rather than starting somewhere.

The inspector holds the **desirability evaluators**: for each goal, a source, a `from` and `to`
range mapping that value to 0…1 desirability, and a `bias` multiplier. `to < from` **inverts** the
mapping, which is how "nearer is better" is expressed.

`arbitrationInterval` (default `0.5 s`) governs how often a plan may be **abandoned** partway; a
plan that finishes always re-arbitrates immediately. Setting it to 0 rarely helps — it flickers
between near-equal goals.

## The Fuzzy canvas

Fuzzy logic turns crisp numbers into graded judgements: "distance 12" becomes "somewhat close", and
rules combine those into outputs an agent acts on.

> **A rule is a node here, not an edge.** A rule is a hyper-edge — several antecedent variables
> feeding one consequent — which no pairwise link can express. Promoting it to a node keeps every
> connection a simple pair.

Variables sit in a left column (subtitle "N sets", badge showing their union range); rules sit on the
right, marked `⇒`, with a readable subtitle like `distance is close AND health is low` and a badge
naming the consequent.

Edges: one per antecedent variable (labelled with the set), plus one rule → consequent edge.

**Actions:** **+ Variable** or double-click — a new variable always gets one starter set, because a
variable with no sets is dropped when the model is read. **+ Rule** (disabled until a variable
exists) seeds both ends from the first variable's first set. Connecting variable → rule adds an
antecedent; rule → variable **replaces** the consequent; rule → rule and variable → variable are
ignored.

**Set shapes stay in the inspector**: seven shapes (`triangular`, `leftShoulder`, `rightShoulder`,
`leftSCurve`, `rightSCurve`, `normal`, `singleton`) with left / mid / right breakpoints.

### Fuzzy inputs are matched by name

An input variable is fed by whatever matches its **name**, in this order: a behaviour sense → a
motion built-in on the pawn → a numeric or boolean blackboard entry. There is no second mapping
table to keep in sync.

A variable matching none of those is never fed and its rules see the bottom of the range — so the
editor **flags variables that match no known input**. Take that warning seriously; it is the
difference between a rule that never fires and one you think is firing.

## Saving

**Ctrl+S**, or Save All. Saving pushes the brain into every linked controller and updates the tab
title if you renamed it.

Edits are not pushed on every keystroke — that would re-embed into every live scene as you type.

## See also

[AI agents](ai-agents.md) · [AI (scripting)](../scripting/ai.md) · [Animation built-ins](../reference/animation-builtins.md) · [Night Shift example](../../examples/scripts/NIGHT_SHIFT.md)
