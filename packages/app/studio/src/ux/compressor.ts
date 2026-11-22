// Our compressor (night of 22 Nov, package 0): a Werkstatt script that replaces openDAW's stock Compressor, a port of
// CTAGDRC that openDAW's commercial licence excludes (ux-enterprise ADR-0099).
// The same script and settings as the shell's apps/daw/shell/src/engine/compressor.ts in ux-enterprise.
// A textbook feed-forward design (Giannoulis, Massberg and Reiss, "Digital Dynamic Range Compressor Design", JAES 2012):
// - detection: the louder of the two channels per sample (stereo-linked peak), in dB;
// - static curve: threshold, ratio and a quadratic soft knee centred on the threshold;
// - ballistics: a branched one-pole on the gain reduction in dB (attack while the reduction grows, release while it falls);
// - makeup: a fixed gain, plus optionally an automatic one that follows the average reduction (about 90 ms).
// Plain arithmetic and no openDAW import, so the tests run the very script text in vitest.

export type CompressorSettings = {
    /** dB */
    threshold: number
    ratio: number
    /** dB, the width of the soft knee */
    knee: number
    /** ms */
    attack: number
    /** ms */
    release: number
    /** dB */
    makeup: number
    /** adds back the average gain reduction, as the stock device's auto makeup did */
    autoMakeup: boolean
}

/** The master glue: the values the stock compressor had (threshold -16, ratio 2, 10 / 150 ms, knee 6, makeup 1). */
export const GLUE: CompressorSettings = {threshold: -16, ratio: 2, knee: 6, attack: 10, release: 150, makeup: 1, autoMakeup: false}

/** A part's `compressor` amount as device values (the stock mapping, unchanged); null at 0 means no device. */
export function partCompressor(amount: number): CompressorSettings | null {
    if (!(amount > 0)) return null
    return {threshold: -12 - 18 * amount, ratio: 1.5 + 4 * amount, knee: 6, attack: 5, release: 100, makeup: 0, autoMakeup: true}
}

/** The auto makeup's time constant: the stock device smoothed it per 128-sample block with 0.03, about 88 ms at 48 kHz. */
export const AUTO_MAKEUP_MS = 88

const num = (x: number) => String(Math.round(x * 1e6) / 1e6)

/** The script source, settings baked in as constants (like the channel and tape scripts). */
export function compressorScript(s: CompressorSettings): string {
    const ratio = Math.max(1, s.ratio)
    return `// @label UX Compressor
class Processor {
    constructor() {
        this.threshold = ${num(s.threshold)}
        this.slope = ${num(1 / ratio - 1)}
        this.knee = ${num(Math.max(0, s.knee))}
        this.makeup = ${num(s.makeup)}
        this.auto = ${s.autoMakeup}
        this.aA = Math.exp(-1 / (sampleRate * ${num(Math.max(0.01, s.attack) / 1000)}))
        this.aR = Math.exp(-1 / (sampleRate * ${num(Math.max(1, s.release) / 1000)}))
        this.aM = 1 - Math.exp(-1 / (sampleRate * ${num(AUTO_MAKEUP_MS / 1000)}))
        this.gr = 0; this.am = 0
    }
    reset() {this.gr = 0; this.am = 0}
    curve(db) {
        const over = db - this.threshold, h = this.knee / 2
        if (over <= -h) return 0
        if (over < h) return 0.5 * this.slope * (over + h) * (over + h) / this.knee
        return this.slope * over
    }
    process(io, block) {
        const [iL, iR] = io.src, [oL, oR] = io.out
        const toDb = 20 / Math.LN10, toGain = Math.LN10 / 20
        for (let i = block.s0; i < block.s1; i++) {
            const l = iL[i], r = iR[i]
            const peak = Math.max(Math.abs(l), Math.abs(r), 1e-6)
            const target = this.curve(Math.log(peak) * toDb)
            const a = target < this.gr ? this.aA : this.aR
            this.gr = a * this.gr + (1 - a) * target
            if (this.auto) this.am += (-this.gr - this.am) * this.aM
            const g = Math.exp((this.gr + this.makeup + this.am) * toGain)
            oL[i] = l * g; oR[i] = r * g
        }
    }
}
`
}
