import {describe, expect, it} from "vitest"
import {degreePitch, inScale, letterPitch, midiPitch, parseKey, quantise, snap} from "./scale"

describe("play it in: scale lock", () => {
    it("reads the song's keys, and falls back to C major", () => {
        expect(parseKey("A minor")).toMatchObject({root: 9, name: "A minor"})
        expect(parseKey("Eb major")).toMatchObject({root: 3, name: "Eb major"})
        expect(parseKey("F# minor")).toMatchObject({root: 6, name: "F# minor"})
        expect(parseKey("nonsense")).toMatchObject({root: 0, name: "C major"})
        expect(parseKey(undefined).name).toBe("C major")
    })

    it("snaps an outside note down to the scale tone below", () => {
        const am = parseKey("A minor")
        expect(snap(am, 61)).toBe(60) // C# → C
        expect(snap(am, 68)).toBe(67) // G# → G
        expect(snap(am, 69)).toBe(69) // A stays
        const c = parseKey("C major")
        for (let p = 0; p < 128; p++) expect(inScale(c, snap(c, p))).toBe(true)
        expect(snap(parseKey("C# major"), 0)).toBe(0) // never below the range
    })

    it("plays every letter key inside the key when locked", () => {
        for (const key of ["C major", "A minor", "Eb major", "G# minor", "B minor"]) {
            const s = parseKey(key)
            for (const code of ["KeyA", "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK", "KeyL", "Semicolon", "Quote", "KeyQ", "KeyP"]) {
                const p = letterPitch(code, "locked", s, 4)
                expect(p).not.toBeNull()
                expect(inScale(s, p!)).toBe(true)
            }
        }
    })

    it("lays the home row out as the scale from the root, the top row an octave up", () => {
        const am = parseKey("A minor")
        expect(["KeyA", "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK"].map(c => letterPitch(c, "locked", am, 3)))
            .toEqual([57, 59, 60, 62, 64, 65, 67, 69])
        expect(letterPitch("KeyQ", "locked", am, 3)).toBe(69)
        expect(degreePitch(parseKey("C major"), 4, 0)).toBe(60)
        expect(degreePitch(parseKey("C major"), 4, -1)).toBe(59)
    })

    it("is a piano when unlocked, and a drum per key for drums", () => {
        const s = parseKey("A minor")
        expect(letterPitch("KeyA", "chromatic", s, 4)).toBe(60)
        expect(letterPitch("KeyW", "chromatic", s, 4)).toBe(61)
        expect(letterPitch("KeyK", "chromatic", s, 4)).toBe(72)
        expect(letterPitch("KeyA", "drums", s, 4)).toBe(36)
        expect(letterPitch("KeyS", "drums", s, 4)).toBe(38)
        expect(letterPitch("KeyW", "drums", s, 4)).toBeNull()
        expect(letterPitch("KeyZ", "locked", s, 4)).toBeNull() // octave keys play nothing
        expect(letterPitch("KeyA", "locked", s, 10)).toBeNull() // off the top of MIDI
    })

    it("snaps MIDI keys only when locked", () => {
        const s = parseKey("C major")
        expect(midiPitch(61, "locked", s)).toBe(60)
        expect(midiPitch(61, "chromatic", s)).toBe(61)
        expect(midiPitch(37, "drums", s)).toBe(37)
    })
})

describe("play it in: quantising a take", () => {
    const Q = 960
    it("rounds starts to the grid and keeps at least one step", () => {
        expect(quantise(250, 300, 240, Q)).toEqual({start: 240, duration: 240})
        expect(quantise(1190, 1700, 240, Q)).toEqual({start: 1200, duration: 480})
        expect(quantise(-30, 100, 240, Q)).toEqual({start: 0, duration: 240})
    })
    it("keeps the played timing with no grid, never shorter than the song's shortest note", () => {
        expect(quantise(1001.4, 1003, 0, Q)).toEqual({start: 1001, duration: 15})
        expect(quantise(1000, 1500.6, 0, Q)).toEqual({start: 1000, duration: 501})
        expect(15 / Q).toBeGreaterThanOrEqual(1 / 64)
    })
})
