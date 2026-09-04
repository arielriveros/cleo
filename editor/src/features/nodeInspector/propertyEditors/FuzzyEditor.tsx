import { useState } from 'react'
import { DEFUZZIFICATIONS, FUZZY_SET_SHAPES, ControllerNode, parseFuzzyModel } from 'cleo'
import type {
  Defuzzification, FuzzyModel, FuzzyRuleDefinition, FuzzySetDefinition, FuzzySetShape,
  FuzzyTermNode, FuzzyVariableDefinition,
} from 'cleo'
import {
  Button, ButtonWithConfirm, NumberInput, Select, TextInput, cn, hintClass, labelClass,
  sectionTitleClass,
} from '../../../components/ui'
import { hintAffordance } from '../../../components/ui/Field'
import {
  flattenAndTerm, renameFuzzySet, renameFuzzyVariable, termUsesVariable,
} from '../../../utils/aiGraphEdits'

/**
 * Fuzzy variables and the rules over them.
 *
 * The thing this editor mostly exists to make visible is the INPUT CONVENTION: a variable is fed by
 * NAME from the vocabulary that already exists — a sense, then a motion builtin on the pawn, then a
 * numeric blackboard entry. There is no mapping to author, which is a real simplification and a total
 * mystery unless something says so. So variables that match a known name are marked as inputs, and
 * ones that do not are flagged rather than silently reading the bottom of their range forever.
 *
 * Rules are edited as a flat "A is x AND B is y" antecedent. The engine's term tree supports nesting
 * and the VERY / FAIRLY hedges, and a saved model that uses them round-trips untouched — but building
 * a tree editor for a shape most rules never need would cost more than it returns, and the flat form
 * is what a rule table looks like in every textbook.
 */

const FUZZY_HINT = 'Turns several gradients into one number. A threshold says a guard at 9.9 metres and one at 10.1 are in different worlds; a rule set says they are nearly the same. Read through a Fuzzy parameter source in the Behaviour or Goals sections.'
const INPUT_HINT = 'Variables are fed BY NAME: a variable called distanceToTarget is filled from that sense, one called planarSpeed from the pawn’s measured motion. Nothing to wire up — but a name that matches nothing is never fed, and its rules see the bottom of its range.'
const SET_HINT = 'left and right are where membership falls to zero; mid is where it peaks. The shoulders stay at 1 beyond their midpoint, which is what makes the ends of a range behave rather than falling off.'
const RULE_HINT = 'IF every listed term holds, THEN the output variable takes the named set, to the degree the weakest term held. A rule naming a variable or set that does not exist is dropped when the model is read.'
const DEFUZ_HINT = 'How the fired rules collapse to one number. maxav averages each output set’s peak weighted by how strongly it fired — cheap, and jumpier. centroid integrates the whole surface — smoother, and roughly twenty times the work.'

/** Names a variable can carry and be fed automatically. Mirrors the engine's resolution order. */
const KNOWN_INPUTS = [
  'distanceToTarget', 'angleToTarget', 'timeSinceSeen', 'lastKnownDistance', 'pathRemaining',
  'stateTime', 'neighborCount',
  'planarSpeed', 'currentSpeed', 'verticalSpeed', 'stillTime', 'movingTime', 'airTime',
  'groundedTime', 'groundDistance', 'slopeAngle', 'turnRate',
]

interface Props {
  node: ControllerNode
  onChange: () => void
}

export default function FuzzyEditor({ node, onChange }: Props) {
  const [version, setVersion] = useState(0)
  const model = node.fuzzy

  const apply = (next: FuzzyModel) => {
    node.fuzzy = parseFuzzyModel(next)
    setVersion(v => v + 1)
    onChange()
  }
  void version

  const variableNames = model.variables.map(v => v.name)
  const outputs = new Set(model.rules.map(r => r.variable))

  const uniqueName = (base: string, taken: string[]) => {
    if (!taken.includes(base)) return base
    for (let i = 2; ; i++) if (!taken.includes(`${base} ${i}`)) return `${base} ${i}`
  }

  const patchVariable = (name: string, patch: Partial<FuzzyVariableDefinition>) =>
    apply({ ...model, variables: model.variables.map(v => (v.name === name ? { ...v, ...patch } : v)) })

  const patchSet = (variable: string, index: number, patch: Partial<FuzzySetDefinition>) =>
    patchVariable(variable, {
      sets: model.variables.find(v => v.name === variable)!.sets
        .map((s, i) => (i === index ? { ...s, ...patch } : s)),
    })

  const patchRule = (index: number, patch: Partial<FuzzyRuleDefinition>) =>
    apply({ ...model, rules: model.rules.map((r, i) => (i === index ? { ...r, ...patch } : r)) })

  const setsOf = (variable: string) => model.variables.find(v => v.name === variable)?.sets ?? []

  const header = (label: string, hint?: string) => (
    <div className={cn(sectionTitleClass, 'mt-3 mb-1', hintAffordance(hint))} title={hint}>{label}</div>
  )

  if (model.variables.length === 0) {
    return (
      <div className='mt-2'>
        <p className={hintClass}>{FUZZY_HINT}</p>
        <Button size='sm' className='mt-1'
          onClick={() => apply({
            variables: [
              {
                name: 'distanceToTarget',
                sets: [
                  { name: 'near', shape: 'leftShoulder', left: 0, mid: 3, right: 20 },
                  { name: 'far', shape: 'rightShoulder', left: 3, mid: 20, right: 40 },
                ],
              },
              {
                name: 'commitment',
                sets: [
                  { name: 'low', shape: 'leftShoulder', left: 0, mid: 10, right: 50 },
                  { name: 'high', shape: 'rightShoulder', left: 50, mid: 90, right: 100 },
                ],
              },
            ],
            rules: [
              { antecedent: { op: 'is', variable: 'distanceToTarget', set: 'near' }, variable: 'commitment', set: 'high' },
              { antecedent: { op: 'is', variable: 'distanceToTarget', set: 'far' }, variable: 'commitment', set: 'low' },
            ],
            defuzzification: 'maxav',
          })}>
          Add a fuzzy model
        </Button>
      </div>
    )
  }

  return (
    <div>
      <p className={hintClass}>{INPUT_HINT}</p>

      {header('Variables', SET_HINT)}
      <div className='flex flex-col gap-1'>
        {model.variables.map(v => {
          const isOutput = outputs.has(v.name)
          const isKnownInput = KNOWN_INPUTS.includes(v.name)
          return (
            <div key={v.name} className='rounded border border-border bg-control/30 p-1.5 flex flex-col gap-1'>
              <div className='flex items-center gap-1'>
                <TextInput className='flex-1 min-w-0' value={v.name}
                  onChange={(raw) => {
                    const trimmed = raw.trim()
                    if (!trimmed || trimmed === v.name) return
                    const unique = uniqueName(trimmed, variableNames.filter(n => n !== v.name))
                    // Rules address variables by name on BOTH sides, so a rename has to rewrite the
                    // antecedent terms and the consequent or the tolerant reader drops the rule.
                    apply(renameFuzzyVariable(model, v.name, unique))
                  }} />
                <span className='text-[10px] uppercase text-muted px-1'>
                  {isOutput ? 'output' : isKnownInput ? 'input' : 'unfed'}
                </span>
                <ButtonWithConfirm
                  onClick={() => apply({
                    ...model,
                    variables: model.variables.filter(x => x.name !== v.name),
                    rules: model.rules.filter(r => r.variable !== v.name && !termUsesVariable(r.antecedent, v.name)),
                  })}>
                  ✕
                </ButtonWithConfirm>
              </div>

              {!isOutput && !isKnownInput && (
                <p className={hintClass}>
                  Nothing feeds this name, so its rules always see the bottom of its range. Rename it to
                  a sense or a motion builtin, or write it from a script with setBlackboard.
                </p>
              )}

              {v.sets.map((s, i) => (
                <div key={i} className='flex items-center gap-1'>
                  <TextInput className='w-[76px]' value={s.name}
                    onChange={(raw) => {
                      const trimmed = raw.trim()
                      if (!trimmed || trimmed === s.name) return
                      const unique = uniqueName(trimmed, v.sets.filter((_, x) => x !== i).map(x => x.name))
                      apply(renameFuzzySet(model, v.name, s.name, unique))
                    }} />
                  <Select className='w-[104px]' value={s.shape}
                    onChange={(e) => patchSet(v.name, i, { shape: e.target.value as FuzzySetShape })}>
                    {FUZZY_SET_SHAPES.map(shape => <option key={shape} value={shape}>{shape}</option>)}
                  </Select>
                  <NumberInput className='w-[52px]' value={s.left}
                    onChange={(left) => patchSet(v.name, i, { left })} />
                  <NumberInput className='w-[52px]' value={s.mid}
                    onChange={(mid) => patchSet(v.name, i, { mid })} />
                  <NumberInput className='w-[52px]' value={s.right}
                    onChange={(right) => patchSet(v.name, i, { right })} />
                  <ButtonWithConfirm
                    onClick={() => patchVariable(v.name, { sets: v.sets.filter((_, x) => x !== i) })}>
                    ✕
                  </ButtonWithConfirm>
                </div>
              ))}
              <Button size='sm' variant='ghost'
                onClick={() => patchVariable(v.name, {
                  sets: [...v.sets, {
                    name: uniqueName('set', v.sets.map(s => s.name)),
                    shape: 'triangular', left: 0, mid: 5, right: 10,
                  }],
                })}>
                + Set
              </Button>
            </div>
          )
        })}
        <Button size='sm' variant='ghost'
          onClick={() => apply({
            ...model,
            variables: [...model.variables, {
              name: uniqueName('variable', variableNames),
              sets: [{ name: 'low', shape: 'leftShoulder', left: 0, mid: 5, right: 10 }],
            }],
          })}>
          + Variable
        </Button>
      </div>

      {header('Rules', RULE_HINT)}
      <div className='flex flex-col gap-1'>
        {model.rules.map((r, i) => (
          <RuleRow key={i} rule={r} variables={model.variables} setsOf={setsOf}
            onChange={(patch) => patchRule(i, patch)}
            onRemove={() => apply({ ...model, rules: model.rules.filter((_, x) => x !== i) })} />
        ))}
        <Button size='sm' variant='ghost' disabled={model.variables.length === 0}
          onClick={() => {
            const first = model.variables[0]
            const output = model.variables[model.variables.length - 1]
            apply({
              ...model,
              rules: [...model.rules, {
                antecedent: { op: 'is', variable: first.name, set: first.sets[0]?.name ?? '' },
                variable: output.name,
                set: output.sets[0]?.name ?? '',
              }],
            })
          }}>
          + Rule
        </Button>
      </div>

      {header('Output', DEFUZ_HINT)}
      <div className='flex items-center justify-between'>
        <span className={labelClass}>Defuzzification</span>
        <Select className='w-[132px]' value={model.defuzzification}
          onChange={(e) => apply({ ...model, defuzzification: e.target.value as Defuzzification })}>
          {DEFUZZIFICATIONS.map(d => <option key={d} value={d}>{d}</option>)}
        </Select>
      </div>
    </div>
  )
}

/**
 * One rule as "IF a is x AND b is y THEN out is z".
 *
 * Flattens the antecedent to its `is` leaves. A model authored elsewhere with OR or a hedge is left
 * alone rather than silently rewritten: the row shows what it is and refuses to edit it, which is a
 * better answer than quietly discarding structure the engine supports.
 */
function RuleRow(
  { rule, variables, setsOf, onChange, onRemove }: {
    rule: FuzzyRuleDefinition
    variables: FuzzyVariableDefinition[]
    setsOf(variable: string): FuzzySetDefinition[]
    onChange(patch: Partial<FuzzyRuleDefinition>): void
    onRemove(): void
  },
) {
  const terms = flattenAndTerm(rule.antecedent)
  const editable = terms !== null

  const replaceTerm = (index: number, next: { variable: string; set: string }) => {
    if (!terms) return
    const updated = terms.map((t, i) => (i === index ? { op: 'is' as const, ...next } : t))
    onChange({ antecedent: updated.length === 1 ? updated[0] : { op: 'and', children: updated } })
  }

  return (
    <div className='rounded border border-border bg-control/30 p-1.5 flex flex-col gap-1'>
      {!editable && (
        <p className={hintClass}>
          This rule uses OR or a hedge, which this list cannot show. It still runs, and is left exactly
          as authored.
        </p>
      )}
      {editable && terms.map((t, i) => (
        <div key={i} className='flex items-center gap-1'>
          <span className={labelClass}>{i === 0 ? 'IF' : 'AND'}</span>
          <Select className='flex-1 min-w-0' value={t.variable}
            onChange={(e) => replaceTerm(i, {
              variable: e.target.value, set: setsOf(e.target.value)[0]?.name ?? '',
            })}>
            {variables.map(v => <option key={v.name} value={v.name}>{v.name}</option>)}
          </Select>
          <Select className='w-[96px]' value={t.set}
            onChange={(e) => replaceTerm(i, { variable: t.variable, set: e.target.value })}>
            {setsOf(t.variable).map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
          </Select>
          {terms.length > 1 && (
            <ButtonWithConfirm
              onClick={() => {
                const kept = terms.filter((_, x) => x !== i)
                onChange({ antecedent: kept.length === 1 ? kept[0] : { op: 'and', children: kept } })
              }}>
              ✕
            </ButtonWithConfirm>
          )}
        </div>
      ))}

      <div className='flex items-center gap-1'>
        <span className={labelClass}>THEN</span>
        <Select className='flex-1 min-w-0' value={rule.variable}
          onChange={(e) => onChange({ variable: e.target.value, set: setsOf(e.target.value)[0]?.name ?? '' })}>
          {variables.map(v => <option key={v.name} value={v.name}>{v.name}</option>)}
        </Select>
        <Select className='w-[96px]' value={rule.set}
          onChange={(e) => onChange({ set: e.target.value })}>
          {setsOf(rule.variable).map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
        </Select>
        <ButtonWithConfirm onClick={onRemove}>✕</ButtonWithConfirm>
      </div>

      {editable && (
        <Button size='sm' variant='ghost'
          onClick={() => {
            const first = variables[0]
            onChange({
              antecedent: {
                op: 'and',
                children: [...terms, { op: 'is', variable: first.name, set: setsOf(first.name)[0]?.name ?? '' }],
              },
            })
          }}>
          + Term
        </Button>
      )}
    </div>
  )
}

/** The `is` leaves of a plain AND chain, or null when the tree is anything richer. */
function flattenAnd(term: FuzzyTermNode): { op: 'is'; variable: string; set: string }[] | null {
  if (term.op === 'is') return [term]
  if (term.op !== 'and') return null
  const out: { op: 'is'; variable: string; set: string }[] = []
  for (const child of term.children) {
    if (child.op !== 'is') return null
    out.push(child)
  }
  return out
}
