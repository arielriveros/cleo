// Duskwell's world as text: what each cell is, from which the generator paints the tilemap and places
// everything else. One map for the whole world; the rooms are rectangles over it (Room 2D nodes).
//
// Row 0 is the TOP of the map; the tilemap node sits at y = ROWS, so row r spans y in [ROWS - r - 1, ROWS - r]
// and column c spans x in [c, c + 1] (one cell is one world unit at 16 pixels per unit).
//
//   #  rock            =  one-way platform        .  air
//   P  the player      B  a bat                   D  a diamond
//   T  a torch         K  a checkpoint lamp       A  the dash relic
//
// Built by carving rather than typed cell by cell: start solid, cut each room's air, then add what stands
// in it. Every marker sits in an air cell; `markers` reads them back with their world positions.

export const COLS = 84
export const ROWS = 24

/** A room of the world: its rectangle in CELLS (inclusive), and the zone it belongs to. */
export interface RoomSpec { name: string; zone: string; c0: number; r0: number; c1: number; r1: number }

export const ROOMS: RoomSpec[] = [
    // The Gate: where the player wakes. 36 wide, 20 tall.
    { name: 'The Gate', zone: 'Ruins', c0: 0, r0: 4, c1: 35, r1: 23 },
    // The Long Hall: platforms, two bats, a pit only the dash crosses.
    { name: 'The Long Hall', zone: 'Ruins', c0: 36, r0: 0, c1: 83, r1: 23 },
]

function build(): string[][] {
    const g: string[][] = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => '#'))
    const air = (c0: number, r0: number, c1: number, r1: number) => {
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) g[r][c] = '.'
    }
    const rock = (c0: number, r0: number, c1: number, r1: number) => {
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) g[r][c] = '#'
    }
    const plank = (c0: number, c1: number, r: number) => { for (let c = c0; c <= c1; c++) g[r][c] = '=' }
    const at = (c: number, r: number, ch: string) => {
        if (g[r][c] !== '.') throw new Error(`marker ${ch} at (${c}, ${r}) is not in the air`)
        g[r][c] = ch
    }

    // --- The Gate -----------------------------------------------------------------------------------
    air(1, 5, 34, 19)                 // floor top at row 20: y = 4
    rock(6, 5, 9, 7)                  // a hanging block
    rock(12, 18, 16, 19)              // a two-high step
    plank(20, 25, 15)                 // y = 9
    plank(27, 32, 11)                 // y = 13
    air(35, 16, 36, 19)               // the doorway east
    at(4, 19, 'P')
    at(3, 18, 'T'); at(11, 18, 'T'); at(19, 18, 'T'); at(31, 18, 'T')
    at(14, 16, 'D'); at(22, 13, 'D'); at(24, 13, 'D'); at(30, 9, 'D')
    at(33, 19, 'K')

    // --- The Long Hall ------------------------------------------------------------------------------
    air(37, 1, 82, 21)                // floor top at row 22: y = 2
    rock(37, 20, 38, 21)              // the step down from the doorway
    plank(42, 46, 19)                 // y = 5
    rock(50, 16, 54, 21)              // a pillar, top at y = 8
    plank(57, 61, 13)                 // y = 11
    rock(70, 10, 75, 10)              // a ledge past the pit, top at y = 14 (a thin shelf)
    plank(68, 72, 7)                  // y = 17, over the ledge
    // The pit: open to the bottom of the map. Six wide: a running jump carries under five, coyote time and
    // all, and falls short; a jump and a dash carries. Nothing overhead bridges it.
    air(62, 22, 67, 23)
    rock(77, 19, 82, 21)              // the far bank, raised: top at y = 5
    at(47, 21, 'T'); at(56, 21, 'T'); at(70, 9, 'T')
    // One diamond hangs over the pit: a running jump takes it, and then the pit takes the player.
    at(52, 14, 'D'); at(59, 11, 'D'); at(64, 17, 'D'); at(70, 5, 'D'); at(79, 17, 'D'); at(81, 17, 'D')
    at(46, 11, 'B'); at(67, 12, 'B')
    at(60, 21, 'A')
    at(40, 21, 'K')
    return g
}

export const GRID: string[][] = build()

/** Whether the cell is rock (off the map counts as rock, so the edges read as walls). */
export function isRock(c: number, r: number): boolean {
    if (c < 0 || c >= COLS || r >= ROWS) return true
    if (r < 0) return true
    return GRID[r][c] === '#'
}

/** World position of a cell's bottom-centre (where a thing stands) and centre. */
export function cellFeet(c: number, r: number): [number, number] { return [c + 0.5, ROWS - r - 1] }
export function cellCentre(c: number, r: number): [number, number] { return [c + 0.5, ROWS - r - 0.5] }

/** Every marker cell of a kind, in reading order. */
export function markers(ch: string): [number, number][] {
    const out: [number, number][] = []
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (GRID[r][c] === ch) out.push([c, r])
    return out
}

/** A room's rectangle in world units: [minX, minY, maxX, maxY]. */
export function roomBounds(room: RoomSpec): [number, number, number, number] {
    return [room.c0, ROWS - room.r1 - 1, room.c1 + 1, ROWS - room.r0]
}
