// Play it in (O7): plain music theory for the studio's letter keys and MIDI keyboard. Public by design (R2):
// a key's scale, snapping a pitch into it and a letter-key layout are textbook facts, not product logic.

const ROOTS: Record<string, number> = {
    C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11
}
const MAJOR = [0, 2, 4, 5, 7, 9, 11]
const MINOR = [0, 2, 3, 5, 7, 8, 10] // natural minor

export type Scale = { root: number, steps: ReadonlyArray<number>, name: string }

/** "A minor" → root 9 and the natural minor steps. An unknown key falls back to C major. */
export function parseKey(key: string | undefined): Scale {
    const [r, mode] = (key ?? "").trim().split(/\s+/)
    const root = ROOTS[r ?? ""]
    if (root === undefined) return {root: 0, steps: MAJOR, name: "C major"}
    return {root, steps: mode === "minor" ? MINOR : MAJOR, name: `${r} ${mode === "minor" ? "minor" : "major"}`}
}

export const inScale = (s: Scale, pitch: number): boolean => s.steps.includes(((pitch - s.root) % 12 + 12) % 12)

/** The nearest scale tone at or below the pitch: in a seven-note scale every outside note sits between two
 *  scale tones, so "down" is the one predictable rule (a black key in C major plays the white key left of it). */
export function snap(s: Scale, pitch: number): number {
    let p = pitch
    while (!inScale(s, p) && p > 0) p--
    return Math.max(0, Math.min(127, p))
}

/** The pitch of scale degree `degree` (0 = the root) counted from the root in `octave` (C4 = octave 4 = 60). */
export function degreePitch(s: Scale, octave: number, degree: number): number {
    const n = s.steps.length
    const o = Math.floor(degree / n)
    const step = s.steps[((degree % n) + n) % n]
    return 12 * (octave + 1) + s.root + 12 * o + step
}

// Letter keys, by physical key (KeyboardEvent.code), so the layout is the same on any keyboard language.
/** Locked to the key: the home row plays the scale upwards, the row above continues an octave higher. */
const LOCKED_ROWS: ReadonlyArray<[string, number]> = [
    ...["KeyA", "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK", "KeyL", "Semicolon", "Quote"].map((c, i) => [c, i] as [string, number]),
    ...["KeyQ", "KeyW", "KeyE", "KeyR", "KeyT", "KeyY", "KeyU", "KeyI", "KeyO", "KeyP"].map((c, i) => [c, i + 7] as [string, number])
]
/** Unlocked: a piano, the home row white keys from C and the row above the black keys. */
const CHROMATIC: ReadonlyArray<[string, number]> = [
    ["KeyA", 0], ["KeyW", 1], ["KeyS", 2], ["KeyE", 3], ["KeyD", 4], ["KeyF", 5], ["KeyT", 6], ["KeyG", 7], ["KeyY", 8],
    ["KeyH", 9], ["KeyU", 10], ["KeyJ", 11], ["KeyK", 12], ["KeyO", 13], ["KeyL", 14], ["KeyP", 15], ["Semicolon", 16], ["Quote", 17]
]
/** Drums: one General MIDI drum per key on the home row (the song stores drums as GM notes). */
export const DRUM_KEYS: ReadonlyArray<[string, number, string]> = [
    ["KeyA", 36, "kick"], ["KeyS", 38, "snare"], ["KeyD", 42, "hat"], ["KeyF", 46, "open hat"], ["KeyG", 39, "clap"],
    ["KeyH", 37, "rim"], ["KeyJ", 45, "low tom"], ["KeyK", 47, "mid tom"], ["KeyL", 50, "high tom"], ["Semicolon", 49, "crash"],
    ["Quote", 51, "ride"]
]
const LOCKED_MAP = new Map(LOCKED_ROWS)
const CHROMATIC_MAP = new Map(CHROMATIC)
const DRUM_MAP = new Map(DRUM_KEYS.map(([c, p]) => [c, p]))

export type KeyMode = "locked" | "chromatic" | "drums"

/** The pitch a letter key plays, or null when the key plays nothing in this mode. */
export function letterPitch(code: string, mode: KeyMode, s: Scale, octave: number): number | null {
    if (mode === "drums") return DRUM_MAP.get(code) ?? null
    if (mode === "locked") {
        const d = LOCKED_MAP.get(code)
        return d === undefined ? null : clampPitch(degreePitch(s, octave, d))
    }
    const k = CHROMATIC_MAP.get(code)
    return k === undefined ? null : clampPitch(12 * (octave + 1) + k)
}

const clampPitch = (p: number): number | null => p >= 0 && p <= 127 ? p : null

/** A MIDI key: snapped into the scale when locked; drums and unlocked play as pressed. */
export function midiPitch(pitch: number, mode: KeyMode, s: Scale): number {
    return mode === "locked" ? snap(s, pitch) : pitch
}

/** Rounds a take's note to the grid (`grid` in pulses; 0 = as played). Lengths never fall under one grid step,
 *  or under 1/64 beat when unquantised (the song's shortest note). */
export function quantise(start: number, end: number, grid: number, quarter: number): { start: number, duration: number } {
    const min = Math.ceil(quarter / 64)
    if (grid <= 0) return {start: Math.max(0, Math.round(start)), duration: Math.max(min, Math.round(end - start))}
    const s = Math.max(0, Math.round(start / grid) * grid)
    return {start: s, duration: Math.max(grid, Math.round((end - start) / grid) * grid)}
}

export const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
export const noteName = (p: number): string => `${NOTE_NAMES[p % 12]}${Math.floor(p / 12) - 1}`
