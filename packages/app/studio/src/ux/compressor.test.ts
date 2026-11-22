// Our compressor script replaces openDAW's stock Compressor (CTAGDRC), ux-enterprise ADR-0099.
// The same tests as the shell's (apps/daw/shell/test/compressor.test.ts): they run the script text itself, as the
// Werkstatt device would, on synthetic signals.
import {describe, expect, test} from "vitest"
import {readdirSync, readFileSync} from "node:fs"
import {fileURLToPath} from "node:url"
import {AUTO_MAKEUP_MS, type CompressorSettings, compressorScript, GLUE, partCompressor} from "./compressor"

const SR = 48000
const BLOCK = 128

type Proc = { process: (io: { src: Float32Array[]; out: Float32Array[] }, block: { s0: number; s1: number; flags: number }) => void; reset: () => void }

const make = (s: CompressorSettings): Proc => {
    const P = new Function("sampleRate", `${compressorScript(s)}\nreturn Processor`)(SR)
    return new P()
}

/** Runs the script over a stereo signal in 128-sample blocks, as the engine does. */
const run = (p: Proc, l: Float32Array, r: Float32Array = l) => {
    const oL = new Float32Array(l.length)
    const oR = new Float32Array(l.length)
    for (let s0 = 0; s0 < l.length; s0 += BLOCK) p.process({ src: [l, r], out: [oL, oR] }, { s0, s1: Math.min(l.length, s0 + BLOCK), flags: 0 })
    return [oL, oR] as const
}

const dc = (db: number, n: number) => new Float32Array(n).fill(10 ** (db / 20))
const gainDb = (out: Float32Array, inp: Float32Array, i: number) => 20 * Math.log10(out[i]! / inp[i]!)

const BASE: CompressorSettings = { threshold: -20, ratio: 4, knee: 6, attack: 1, release: 1, makeup: 0, autoMakeup: false }

/** The steady gain change for a constant input level (one second, long past every time constant). */
const steady = (s: CompressorSettings, inDb: number) => {
    const x = dc(inDb, SR)
    const [o] = run(make(s), x)
    return gainDb(o, x, SR - 1)
}

describe("static curve", () => {
    test("no reduction below the knee", () => {
        for (const db of [-60, -40, -30, -23.01]) expect(steady(BASE, db)).toBeCloseTo(0, 6)
    })

    test("above the knee the output rises 1 dB per ratio dB", () => {
        // 4:1, threshold -20: 10 dB over -> 7.5 dB reduction; 20 dB over -> 15 dB.
        expect(steady(BASE, -10)).toBeCloseTo(-7.5, 3)
        expect(steady(BASE, 0)).toBeCloseTo(-15, 3)
        expect(steady({ ...BASE, ratio: 2 }, -10)).toBeCloseTo(-5, 3)
    })

    test("the soft knee is quadratic and meets both lines", () => {
        const slope = 1 / 4 - 1
        // At the threshold: 0.5 * slope * (knee/2)^2 / knee.
        expect(steady(BASE, -20)).toBeCloseTo((0.5 * slope * 9) / 6, 3)
        // The knee's top edge equals the ratio line there.
        expect(steady(BASE, -17)).toBeCloseTo(slope * 3, 3)
        // Inside the knee: the quadratic, between none and the full slope.
        expect(steady(BASE, -18.5)).toBeCloseTo((0.5 * slope * 4.5 ** 2) / 6, 3)
        expect(steady(BASE, -22)).toBeCloseTo((0.5 * slope * 1) / 6, 3)
    })

    test("makeup gain is added after the reduction", () => {
        expect(steady({ ...BASE, makeup: 3 }, -40)).toBeCloseTo(3, 3)
        expect(steady({ ...BASE, makeup: 3 }, -10)).toBeCloseTo(-4.5, 3)
    })

    test("auto makeup gives back the average reduction", () => {
        const x = dc(-10, 4 * SR)
        const [o] = run(make({ ...BASE, autoMakeup: true }), x)
        expect(gainDb(o, x, 4 * SR - 1)).toBeCloseTo(0, 2)
        expect(AUTO_MAKEUP_MS).toBeGreaterThan(50)
    })
})

describe("time constants", () => {
    const hard: CompressorSettings = { ...BASE, knee: 0, attack: 10, release: 150 }
    test("attack: 63% of the reduction after the attack time", () => {
        const n = SR
        const x = dc(-10, n); // target -7.5 dB
        const [o] = run(make(hard), x)
        const at = Math.round(0.01 * SR) - 1
        expect(gainDb(o, x, at)).toBeCloseTo(-7.5 * (1 - Math.exp(-1)), 1)
        expect(gainDb(o, x, n - 1)).toBeCloseTo(-7.5, 3)
    })

    test("release: back to 37% of the reduction after the release time", () => {
        const n = SR
        const x = new Float32Array(2 * n)
        x.fill(10 ** (-10 / 20), 0, n)
        x.fill(10 ** (-60 / 20), n)
        const [o] = run(make(hard), x)
        expect(gainDb(o, x, n - 1)).toBeCloseTo(-7.5, 3)
        expect(gainDb(o, x, n + Math.round(0.15 * SR) - 1)).toBeCloseTo(-7.5 * Math.exp(-1), 1)
    })
})

describe("behaviour", () => {
    test("stereo-linked: the louder side sets one gain for both", () => {
        const l = dc(-6, SR)
        const r = dc(-40, SR)
        const [oL, oR] = run(make(BASE), l, r)
        expect(gainDb(oL, l, SR - 1)).toBeCloseTo(gainDb(oR, r, SR - 1), 6)
        expect(gainDb(oR, r, SR - 1)).toBeLessThan(-5)
    })

    test("deterministic: the same input gives the same output, also after reset", () => {
        const x = new Float32Array(SR)
        for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * 110 * i) / SR) * (i % 12000 < 2000 ? 0.9 : 0.1)
        const p = make(GLUE)
        const [a] = run(p, x)
        p.reset()
        const [b] = run(p, x)
        const [c] = run(make(GLUE), x)
        expect(Array.from(b)).toEqual(Array.from(a))
        expect(Array.from(c)).toEqual(Array.from(a))
    })
})

describe("settings", () => {
    test("the glue keeps the stock values", () => {
        expect(GLUE).toEqual({ threshold: -16, ratio: 2, knee: 6, attack: 10, release: 150, makeup: 1, autoMakeup: false })
    })

    test("a part's amount drives the same threshold, ratio and makeup as before", () => {
        for (const a of [0.3, 0.6, 1]) {
            const s = partCompressor(a)!
            expect(s.threshold).toBeCloseTo(-12 - 18 * a, 9)
            expect(s.ratio).toBeCloseTo(1.5 + 4 * a, 9)
            expect(s).toMatchObject({ knee: 6, attack: 5, release: 100, makeup: 0, autoMakeup: true })
        }
    })

    test("amount 0 inserts nothing", () => {
        expect(partCompressor(0)).toBeNull()
        expect(partCompressor(-0.1)).toBeNull()
        // chain.ts inserts the device only when partCompressor gives settings.
        const chain = readFileSync(fileURLToPath(new URL("./chain.ts", import.meta.url)), "utf8")
        expect(chain).toMatch(/const comp = partCompressor\(amountOf\(effects, "compressor"\)\)\s*if \(comp\) werkstatt\(project, field, "compressor"/)
        expect(chain).toMatch(/werkstatt\(project, field, "glue", compressorScript\(GLUE\)\)/)
    })
})

describe("no stock compressor", () => {
    test("openDAW's stock Compressor (CTAGDRC) is used nowhere in our code", () => {
        const dir = fileURLToPath(new URL(".", import.meta.url))
        const banned = new RegExp(["AudioNamed", "Compressor"].join("\\.") + "|" + ["Compressor", "DeviceBox"].join(""))
        const hits = readdirSync(dir).filter(name => /\.(ts|tsx|js|mjs)$/.test(name) && banned.test(readFileSync(dir + "/" + name, "utf8")))
        expect(hits).toEqual([])
    })
})
