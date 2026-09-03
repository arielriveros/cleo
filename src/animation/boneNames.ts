// ---------------------------------------------------------------------------
// Bone-name matching for animation retargeting: a normalizer for exporter decoration, and a humanoid
// dictionary mapping normalized names to canonical slots. Both pure, with no imports.
// ---------------------------------------------------------------------------

/**
 * Strip exporter decoration off a bone name so the same joint compares equal across tools:
 * `mixamorig:LeftForeArm` and `LeftForeArm` both become `leftforearm`. Side markers are preserved.
 */
export function normalizeBoneName(name: string): string {
    let s = name;
    // Namespace prefixes: everything up to and including the last ':' or '|'.
    const ns = Math.max(s.lastIndexOf(':'), s.lastIndexOf('|'));
    if (ns >= 0) s = s.slice(ns + 1);
    s = s.trim();
    s = s.replace(/^(def[-_]|org[-_]|mch[-_])/i, '');       // Rigify deform / original / mechanism
    s = s.replace(/^bip0*1[\s_-]*/i, '');                    // 3ds Max Biped: "Bip01 ", "Bip001_"
    s = s.replace(/^(b[_-]|bone[_-])/i, '');                 // generic "b_" / "bone_"
    s = s.toLowerCase();
    s = s.replace(/[\s._-]+/g, '');                          // separators
    return s;
}

/** The canonical humanoid slots. A `.L`/`.R` suffix is appended for sided bones by {@link humanoidSlotOf}. */
type SidedSlot =
    | 'shoulder' | 'upperArm' | 'foreArm' | 'hand'
    | 'thumb1' | 'thumb2' | 'thumb3'
    | 'index1' | 'index2' | 'index3'
    | 'middle1' | 'middle2' | 'middle3'
    | 'ring1' | 'ring2' | 'ring3'
    | 'pinky1' | 'pinky2' | 'pinky3'
    | 'upLeg' | 'leg' | 'foot' | 'toe';
type CenterSlot = 'hips' | 'spine' | 'chest' | 'neck' | 'head';

// Synonyms per slot, matched against a normalized name with the side marker removed. Lookup is
// exact-token, not substring, so `forearm` cannot be captured by `arm`.
const SIDED_SYNONYMS: Record<SidedSlot, string[]> = {
    shoulder: ['shoulder', 'clavicle', 'collar'],
    upperArm: ['upperarm', 'arm', 'uparm', 'armupper'],
    foreArm: ['forearm', 'lowerarm', 'elbow', 'armlower'],
    hand: ['hand', 'wrist'],
    thumb1: ['thumb1', 'thumb01', 'handthumb1', 'fingerthumb1'],
    thumb2: ['thumb2', 'thumb02', 'handthumb2', 'fingerthumb2'],
    thumb3: ['thumb3', 'thumb03', 'handthumb3', 'fingerthumb3'],
    index1: ['index1', 'index01', 'handindex1', 'fingerindex1'],
    index2: ['index2', 'index02', 'handindex2', 'fingerindex2'],
    index3: ['index3', 'index03', 'handindex3', 'fingerindex3'],
    middle1: ['middle1', 'middle01', 'handmiddle1', 'fingermiddle1'],
    middle2: ['middle2', 'middle02', 'handmiddle2', 'fingermiddle2'],
    middle3: ['middle3', 'middle03', 'handmiddle3', 'fingermiddle3'],
    ring1: ['ring1', 'ring01', 'handring1', 'fingerring1'],
    ring2: ['ring2', 'ring02', 'handring2', 'fingerring2'],
    ring3: ['ring3', 'ring03', 'handring3', 'fingerring3'],
    pinky1: ['pinky1', 'pinky01', 'little1', 'handpinky1', 'fingerpinky1'],
    pinky2: ['pinky2', 'pinky02', 'little2', 'handpinky2', 'fingerpinky2'],
    pinky3: ['pinky3', 'pinky03', 'little3', 'handpinky3', 'fingerpinky3'],
    upLeg: ['upleg', 'upperleg', 'thigh', 'legupper'],
    leg: ['leg', 'lowerleg', 'shin', 'calf', 'knee', 'leglower'],
    foot: ['foot', 'ankle'],
    toe: ['toe', 'toebase', 'ball'],
};

const CENTER_SYNONYMS: Record<CenterSlot, string[]> = {
    hips: ['hips', 'hip', 'pelvis', 'root', 'cog'],
    spine: ['spine', 'spine1', 'spine01', 'abdomen', 'torso'],
    chest: ['chest', 'spine2', 'spine02', 'spine3', 'upperchest', 'ribcage', 'thorax'],
    neck: ['neck', 'neck1'],
    head: ['head', 'skull'],
};

/** Side markers, longest first so `left` is tried before `l`. */
const SIDE_TOKENS: { token: string; side: 'L' | 'R' }[] = [
    { token: 'left', side: 'L' }, { token: 'right', side: 'R' },
    { token: 'l', side: 'L' }, { token: 'r', side: 'R' },
];

// Every way `norm` could be read as a sided name, in order of preference. A single-letter marker is
// ambiguous with the bone's own first letter, so all readings are returned and the caller picks.
function sideCandidates(norm: string): { core: string; side: 'L' | 'R' }[] {
    const out: { core: string; side: 'L' | 'R' }[] = [];
    for (const { token, side } of SIDE_TOKENS) {
        if (norm.length <= token.length) continue;
        // Trailing first: a suffix marker is the more common convention, and `legl` only reads correctly that way.
        if (norm.endsWith(token)) out.push({ core: norm.slice(0, -token.length), side });
        if (norm.startsWith(token)) out.push({ core: norm.slice(token.length), side });
    }
    return out;
}

// Reverse lookup: normalized synonym -> slot, built once.
const SIDED_LOOKUP = new Map<string, SidedSlot>();
for (const slot of Object.keys(SIDED_SYNONYMS) as SidedSlot[])
    for (const syn of SIDED_SYNONYMS[slot]) SIDED_LOOKUP.set(syn, slot);
const CENTER_LOOKUP = new Map<string, CenterSlot>();
for (const slot of Object.keys(CENTER_SYNONYMS) as CenterSlot[])
    for (const syn of CENTER_SYNONYMS[slot]) CENTER_LOOKUP.set(syn, slot);

/**
 * The canonical humanoid slot a bone belongs to (`'foreArm.L'`, `'hips'`, `'spine'`), or null when the
 * name is not a recognizable humanoid bone. The `spine`/`chest` split is a hint; the caller decides.
 */
export function humanoidSlotOf(name: string): string | null {
    const norm = normalizeBoneName(name);

    // Centre bones first — they carry no side, and 'l'/'r' stripping would corrupt a name like 'girl'.
    const center = CENTER_LOOKUP.get(norm);
    if (center) return center;

    // First candidate reading that names a known bone wins.
    for (const { core, side } of sideCandidates(norm)) {
        const slot = SIDED_LOOKUP.get(core);
        if (slot) return `${slot}.${side}`;
    }
    return null;
}
