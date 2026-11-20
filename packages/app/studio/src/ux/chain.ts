// ux-daw sound chain: turns the song's effects, master and feel into openDAW devices (lo-fi stage, WP1 and WP3).
// - Track: [Crusher + Revamp: crush] -> [Compressor] -> [UX Channel script: highpass, lowpass, saturation, wobble, chorus, duck] -> [Delay] -> [Dattorro Reverb]
// - Master: Compressor (glue) -> [Crusher + Revamp: grit] -> UX Tape script (mono lows, wow/flutter, saturation, dust, roll-off) -> Maximizer -> trim
// - Song: key on the key track, swing as a Zeitgeist on every instrument pointing at the project groove.
// Our devices carry the label prefix "ux·" and are rebuilt only when their settings change.
// The scripts are Werkstatt devices: our own DSP code with the settings baked in as constants (no knobs),
// loaded by the project's script loader like any Werkstatt (offline renders included).
import {UUID} from "@opendaw/lib-std"
import {IndexedBox} from "@opendaw/lib-box"
import {
    AudioUnitBox,
    CompressorDeviceBox,
    CrusherDeviceBox,
    DattorroReverbDeviceBox,
    DelayDeviceBox,
    GrooveShuffleBox,
    MaximizerDeviceBox,
    RevampDeviceBox,
    StereoToolDeviceBox,
    WerkstattDeviceBox,
    WerkstattSidechainBox,
    ZeitgeistDeviceBox
} from "@opendaw/studio-boxes"
import {EffectFactories, Project} from "@opendaw/studio-core"

export type Fx = { type: string, amount: number, shape?: string, source?: string }
/** level_db: gain before the finish, set by the API's loudness matching (the studio only applies it). */
export type Master = { limiter: boolean, target_lufs: number, tape?: number, dust?: number, grit?: number, level_db?: number }

const TAG = "ux·"
const SCRIPT_UPDATE_BASE = 1

/** Loudness calibration: Maximizer threshold that lands a full lo-fi section on -14 LUFS (measured live). */
export const LIMITER_AT_MINUS_14 = -6

const amountOf = (effects: ReadonlyArray<Fx>, type: string) => effects.find(e => e.type === type)?.amount ?? 0
/** The sidechain duck: a duck with a shape or a source is the pump, which the API sends as volume automation. */
const sidechainDuck = (effects: ReadonlyArray<Fx>) => {
    const d = effects.find(e => e.type === "duck")
    return d && !d.shape && !d.source ? d.amount : 0
}
const r3 = (x: number) => Math.round(x * 1000) / 1000
const hash = (s: string) => {
    let h = 2166136261
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
    return (h >>> 0) % 100_000_000
}

/** Deletes our devices in a chain (and nothing the user added), then re-indexes the rest. */
const clearOurs = (field: AudioUnitBox["audioEffects"] | AudioUnitBox["midiEffects"], prefix: string = TAG) => {
    const boxes = IndexedBox.collectIndexedBoxes(field as any) as ReadonlyArray<any>
    for (const b of boxes) if (String(b.label?.getValue?.() ?? "").startsWith(prefix)) b.delete()
    ;(IndexedBox.collectIndexedBoxes(field as any) as ReadonlyArray<any>).forEach((b, i) => b.index.setValue(i))
}

const insert = <B>(project: Project, field: any, factory: any, label: string): B => {
    const box = project.api.insertEffect(field, factory) as any
    box.label.setValue(TAG + label)
    return box as B
}

const werkstatt = (project: Project, field: any, label: string, code: string): WerkstattDeviceBox => {
    const box = insert<WerkstattDeviceBox>(project, field, EffectFactories.AudioNamed.Werkstatt, label)
    box.code.setValue(`// @werkstatt js 1 ${SCRIPT_UPDATE_BASE + hash(code)}\n${code}`)
    return box
}

// ---------- old-sampler colour (track crush, master grit): stock Crusher, then the stock EQ as the output filter ----------

/** Crusher's crush for a sample-and-hold rate of nyquist * 0.3^amount (its rate is exponential, 20 Hz to nyquist, at 48 kHz). */
const CRUSH_PER_AMOUNT = -Math.log(0.3) / Math.log(24000 / 20)

const sampler = (project: Project, field: any, amount: number, label: string) => {
    const a = Math.max(0, Math.min(1, amount))
    const c = insert<CrusherDeviceBox>(project, field, EffectFactories.AudioNamed.Crusher, label)
    c.crush.setValue(CRUSH_PER_AMOUNT * a)          // 0.5 -> about 13 kHz, 1 -> about 7 kHz
    c.bits.setValue(Math.round(16 - 8 * a))         // 0.5 -> 12 bits, 1 -> 8 bits
    c.boost.setValue(0)
    c.mix.setValue(1)
    const eq = insert<RevampDeviceBox>(project, field, EffectFactories.AudioNamed.Revamp, label + " filter")
    for (const band of [eq.highPass, eq.lowShelf, eq.lowBell, eq.midBell, eq.highBell, eq.highShelf] as any[]) band.enabled.setValue(false)
    eq.lowPass.enabled.setValue(true)
    eq.lowPass.frequency.setValue(Math.round(20000 * Math.pow(0.3, 1.3 * a))) // 0.5 -> 9.1 kHz, 1 -> 4.2 kHz
    eq.lowPass.order.setValue(0)
    eq.lowPass.q.setValue(Math.SQRT1_2)
}

// ---------- track chain ----------

/** duckSource: the drums unit for the duck sidechain; trim: the patch level match in dB (WP4);
 * sectionFilter: a low-pass at the end of the chain whose cutoff the per-section automation moves (B5). */
export type TrackChainContext = { duckSource: AudioUnitBox | null, trim?: number, sectionFilter?: boolean }

/** A string that changes whenever the built chain would change. */
export const trackSignature = (effects: ReadonlyArray<Fx>, ctx: TrackChainContext) =>
    JSON.stringify([...effects].sort((a, b) => a.type.localeCompare(b.type)).map(e => [e.type, r3(e.amount)]))
    + (sidechainDuck(effects) > 0 && ctx.duckSource ? UUID.toString(ctx.duckSource.address.uuid) : "")
    + (ctx.trim ? `|trim${r3(ctx.trim)}` : "")
    + (ctx.sectionFilter ? "|sections" : "")

export function buildTrackChain(project: Project, unit: AudioUnitBox, effects: ReadonlyArray<Fx>, ctx: TrackChainContext) {
    const field = unit.audioEffects
    clearOurs(field)
    // Patch level match first, so the compressor and the scripts see the patch at its matched level.
    // StereoTool gain stops at +12 dB; a larger trim takes two.
    let trim = ctx.trim ?? 0
    while (Math.abs(trim) > 0.05) {
        const step = Math.max(-24, Math.min(12, trim))
        insert<StereoToolDeviceBox>(project, field, EffectFactories.AudioNamed.StereoTool, "patch level").volume.setValue(step)
        trim -= step
    }
    const crush = amountOf(effects, "crush")
    if (crush > 0) sampler(project, field, crush, "crush")
    const comp = amountOf(effects, "compressor")
    if (comp > 0) {
        const c = insert<CompressorDeviceBox>(project, field, EffectFactories.AudioNamed.Compressor, "compressor")
        c.threshold.setValue(-12 - 18 * comp)
        c.ratio.setValue(1.5 + 4 * comp)
        c.attack.setValue(5)
        c.release.setValue(100)
        c.knee.setValue(6)
        c.automakeup.setValue(true)
    }
    const ch = {
        hp: amountOf(effects, "highpass"),
        lp: amountOf(effects, "lowpass"),
        sat: amountOf(effects, "saturation"),
        wobble: amountOf(effects, "wobble"),
        chorus: amountOf(effects, "chorus"),
        duck: ctx.duckSource && ctx.duckSource !== unit ? sidechainDuck(effects) : 0
    }
    if (ch.hp + ch.lp + ch.sat + ch.wobble + ch.chorus + ch.duck > 0) {
        const w = werkstatt(project, field, "channel", channelScript(ch))
        if (ch.duck > 0 && ctx.duckSource) {
            WerkstattSidechainBox.create(project.boxGraph, UUID.generate(), (b: WerkstattSidechainBox) => {
                b.owner.refer(w.sideChains)
                b.label.setValue("Key")
                b.index.setValue(0)
                b.source.refer(ctx.duckSource! as any)
            })
        }
    }
    const delay = amountOf(effects, "delay")
    if (delay > 0) {
        const d = insert<DelayDeviceBox>(project, field, EffectFactories.AudioNamed.Delay, "delay")
        d.delayMusical.setValue(13) // 3/16, a dotted eighth
        d.feedback.setValue(0.2 + 0.4 * delay)
        d.wet.setValue(-26 + 16 * delay)
        d.dry.setValue(0)
    }
    const reverb = amountOf(effects, "reverb")
    if (reverb > 0) {
        const v = insert<DattorroReverbDeviceBox>(project, field, EffectFactories.AudioNamed.DattorroReverb, "reverb")
        v.preDelay.setValue(18)
        v.decay.setValue(0.45 + 0.4 * reverb)
        v.damping.setValue(0.35)
        v.bandwidth.setValue(0.55)
        v.wet.setValue(-20 + 18 * reverb)
        v.dry.setValue(0)
    }
    if (ctx.sectionFilter) {
        // Last, so a filtered section sounds as if from the next room, reverb and all. Open (20 kHz) until automated.
        const eq = insert<RevampDeviceBox>(project, field, EffectFactories.AudioNamed.Revamp, SECTION_FILTER)
        for (const band of [eq.highPass, eq.lowShelf, eq.lowBell, eq.midBell, eq.highBell, eq.highShelf] as any[]) band.enabled.setValue(false)
        eq.lowPass.enabled.setValue(true)
        eq.lowPass.frequency.setValue(20000)
        eq.lowPass.order.setValue(1)
        eq.lowPass.q.setValue(Math.SQRT1_2)
    }
}

const SECTION_FILTER = "section filter"

/** The cutoff field of a track's section low-pass, or null when its chain has none. */
export function sectionFilterFrequency(unit: AudioUnitBox): any | null {
    const box = (IndexedBox.collectIndexedBoxes(unit.audioEffects as any) as ReadonlyArray<any>)
        .find(b => b instanceof RevampDeviceBox && b.label.getValue() === TAG + SECTION_FILTER) as RevampDeviceBox | undefined
    return box ? box.lowPass.frequency : null
}

type Channel = { hp: number, lp: number, sat: number, wobble: number, chorus: number, duck: number }

/** Biquad (RBJ) as script source, shared by both scripts. */
const BIQUAD = `class Biquad {
    constructor(type, f, q) {
        const w = 2 * Math.PI * Math.min(f, sampleRate * 0.45) / sampleRate, c = Math.cos(w), a = Math.sin(w) / (2 * q)
        const n = 1 / (1 + a)
        if (type === "lp") {this.b0 = (1 - c) / 2 * n; this.b1 = (1 - c) * n; this.b2 = this.b0}
        else {this.b0 = (1 + c) / 2 * n; this.b1 = -(1 + c) * n; this.b2 = this.b0}
        this.a1 = -2 * c * n; this.a2 = (1 - a) * n; this.z1 = 0; this.z2 = 0
    }
    run(x) {const y = this.b0 * x + this.z1; this.z1 = this.b1 * x - this.a1 * y + this.z2; this.z2 = this.b2 * x - this.a2 * y; return y}
    reset() {this.z1 = 0; this.z2 = 0}
}`

/** Reads a ring buffer `d` samples back, linear interpolation. */
const TAP = `function tap(buf, w, d) {
    const p = w - d, i = Math.floor(p), f = p - i, m = buf.length - 1
    return buf[i & m] * (1 - f) + buf[(i + 1) & m] * f
}`

export function channelScript(c: Channel): string {
    const hpHz = Math.round(20 * Math.pow(100, c.hp))            // 0.5 -> 200 Hz, 1 -> 2 kHz
    const lpHz = Math.round(20000 * Math.pow(0.015, c.lp))       // 0.3 -> 5.7 kHz, 0.5 -> 2.4 kHz, 1 -> 300 Hz
    return `// @label UX Channel
${c.duck > 0 ? "// @sidechain Key\n" : ""}${BIQUAD}
${TAP}
class Processor {
    constructor() {
        this.hp = ${c.hp > 0} ? [new Biquad("hp", ${hpHz}, 0.707), new Biquad("hp", ${hpHz}, 0.707)] : null
        this.lp = ${c.lp > 0} ? [new Biquad("lp", ${lpHz}, 0.6), new Biquad("lp", ${lpHz}, 0.6)] : null
        this.drive = 1 + 5 * ${r3(c.sat)}
        this.sat = ${c.sat > 0}
        this.wob = ${r3(c.wobble)} * 0.0025 * sampleRate
        this.cho = ${r3(c.chorus)}
        this.duck = Math.min(0.9, ${r3(c.duck)} * 1.2)
        this.bufL = new Float32Array(8192); this.bufR = new Float32Array(8192); this.w = 0
        this.ph = 0; this.phC = 0; this.drift = 0; this.driftT = 0; this.seed = 12345
        this.k1 = 0; this.k2 = 0; this.env = 0; this.peak = 0; this.g = 1
        this.kA = Math.exp(-2 * Math.PI * 120 / sampleRate)
        this.atk = 1 - Math.exp(-1 / (0.003 * sampleRate)); this.rel = 1 - Math.exp(-1 / (0.15 * sampleRate))
        this.pDec = Math.exp(-Math.LN2 / (3 * sampleRate)); this.gS = 1 - Math.exp(-1 / (0.002 * sampleRate))
    }
    rnd() {this.seed = (this.seed * 1664525 + 1013904223) >>> 0; return this.seed / 4294967296}
    reset() {
        this.bufL.fill(0); this.bufR.fill(0); this.env = 0; this.g = 1
        if (this.hp) for (const f of this.hp) f.reset()
        if (this.lp) for (const f of this.lp) f.reset()
    }
    process(io, block) {
        const [iL, iR] = io.src, [oL, oR] = io.out
        const key = this.duck > 0 && this.sidechains ? this.sidechains.Key : null
        const wobInc = 2 * Math.PI * 0.45 / sampleRate, choInc = 2 * Math.PI * 0.7 / sampleRate
        for (let i = block.s0; i < block.s1; i++) {
            let l = iL[i], r = iR[i]
            if (this.hp) {l = this.hp[0].run(l); r = this.hp[1].run(r)}
            if (this.lp) {l = this.lp[0].run(l); r = this.lp[1].run(r)}
            if (this.sat) {l = Math.tanh(this.drive * l) / this.drive; r = Math.tanh(this.drive * r) / this.drive}
            if (this.wob > 0 || this.cho > 0) {
                const w = this.w
                this.bufL[w & 8191] = l; this.bufR[w & 8191] = r; this.w = w + 1
                let d0 = 0
                if (this.wob > 0) {
                    this.ph += wobInc
                    if (--this.driftT <= 0) {this.driftT = sampleRate >> 2; this.driftTo = this.rnd() * 2 - 1}
                    this.drift += ((this.driftTo || 0) - this.drift) * 0.00002
                    d0 = 0.006 * sampleRate + this.wob * (Math.sin(this.ph) * 0.8 + this.drift * 0.6)
                    l = tap(this.bufL, w, d0); r = tap(this.bufR, w, d0)
                }
                if (this.cho > 0) {
                    this.phC += choInc
                    // Stereo chorus: different delays left and right, modulated in opposite phase, so even a
                    // mono source comes out wide (side about the wet level under the mid).
                    const depth = (0.0015 + 0.004 * this.cho) * sampleRate
                    const wl = tap(this.bufL, w, d0 + 0.009 * sampleRate + depth * Math.sin(this.phC))
                    const wr = tap(this.bufR, w, d0 + 0.0165 * sampleRate - depth * Math.sin(this.phC))
                    const m = Math.min(0.5, 0.15 + 0.6 * this.cho)
                    l = l * (1 - m) + wl * m
                    r = r * (1 - m) + wr * m
                }
            }
            if (key) {
                const k = (key[0][i] + key[1][i]) * 0.5
                this.k1 = this.k1 * this.kA + (1 - this.kA) * k
                this.k2 = this.k2 * this.kA + (1 - this.kA) * this.k1
                const x = Math.abs(this.k2)
                this.env += (x - this.env) * (x > this.env ? this.atk : this.rel)
                this.peak = Math.max(this.env, this.peak * this.pDec)
                const ratio = this.peak > 1e-4 ? this.env / this.peak : 0
                const target = 1 - this.duck * Math.min(1, Math.max(0, (ratio - 0.15) / 0.5))
                this.g += (target - this.g) * this.gS
                l *= this.g; r *= this.g
            }
            oL[i] = l; oR[i] = r
        }
    }
}
`
}

// ---------- master ----------

export const masterSignature = (m: Master) =>
    JSON.stringify([m.limiter, m.target_lufs, r3(m.tape ?? 0), r3(m.dust ?? 0), r3(m.level_db ?? 0), LIMITER_AT_MINUS_14])
    + (m.grit ? `|grit${r3(m.grit)}` : "")

export function buildMaster(project: Project, m: Master) {
    const field = project.primaryAudioUnitBox.audioEffects
    clearOurs(field)
    // openDAW's default master limiter: ours replaces it.
    for (const b of IndexedBox.collectIndexedBoxes(field as any) as ReadonlyArray<any>)
        if (b instanceof MaximizerDeviceBox && b.label.getValue() === "Master Maximizer") b.delete()
    ;(IndexedBox.collectIndexedBoxes(field as any) as ReadonlyArray<any>).forEach((b, i) => b.index.setValue(i))

    if (m.level_db) insert<StereoToolDeviceBox>(project, field, EffectFactories.AudioNamed.StereoTool, "level").volume.setValue(m.level_db)
    const glue = insert<CompressorDeviceBox>(project, field, EffectFactories.AudioNamed.Compressor, "glue")
    glue.threshold.setValue(-16)
    glue.ratio.setValue(2)
    glue.attack.setValue(10)
    glue.release.setValue(150)
    glue.knee.setValue(6)
    glue.automakeup.setValue(false)
    glue.makeup.setValue(1)
    if (m.grit) sampler(project, field, m.grit, "grit")
    werkstatt(project, field, "tape", tapeScript(m.tape ?? 0, m.dust ?? 0))
    if (m.limiter) {
        const lim = insert<MaximizerDeviceBox>(project, field, EffectFactories.AudioNamed.Maximizer, "limiter")
        lim.threshold.setValue(Math.max(-24, Math.min(0, LIMITER_AT_MINUS_14 - (m.target_lufs + 14))))
        lim.lookahead.setValue(true)
    }
    // The Maximizer's ceiling is 0 dBFS: a small trim keeps peaks clear of clipping.
    const trim = insert<StereoToolDeviceBox>(project, field, EffectFactories.AudioNamed.StereoTool, "trim")
    trim.volume.setValue(-1)
}

export function tapeScript(tape: number, dust: number): string {
    const t = r3(tape), d = r3(dust)
    const rollHz = Math.round(16000 * Math.pow(0.45, t)) // 0.5 -> 10.7 kHz, 1 -> 7.2 kHz
    return `// @label UX Tape
${BIQUAD}
${TAP}
class Processor {
    constructor() {
        this.t = ${t}; this.d = ${d}
        this.side = [new Biquad("hp", 120, 0.707), new Biquad("hp", 120, 0.707)]
        this.roll = this.t > 0 ? [new Biquad("lp", ${rollHz}, 0.6), new Biquad("lp", ${rollHz}, 0.6)] : null
        this.drive = 1 + 2.5 * this.t
        this.bufL = new Float32Array(8192); this.bufR = new Float32Array(8192); this.w = 0
        this.wow = 0; this.flut = 0; this.drift = 0; this.driftTo = 0; this.driftT = 0; this.seed = 987654321
        this.hissL = 0; this.hissR = 0; this.hpL = 0; this.hpR = 0; this.cr = 0; this.crPan = 0; this.crHp = 0
        this.crDec = Math.exp(-1 / (0.0004 * sampleRate))
    }
    rnd() {this.seed = (this.seed * 1664525 + 1013904223) >>> 0; return this.seed / 4294967296}
    reset() {this.bufL.fill(0); this.bufR.fill(0); this.cr = 0}
    process(io, block) {
        const [iL, iR] = io.src, [oL, oR] = io.out
        const playing = (block.flags & 5) !== 0
        const sr = sampleRate, t = this.t, d = this.d
        const wowInc = 2 * Math.PI * 0.55 / sr, flutInc = 2 * Math.PI * 6.5 / sr
        const hissA = Math.exp(-2 * Math.PI * 5000 / sr), hpA = Math.exp(-2 * Math.PI * 400 / sr)
        for (let i = block.s0; i < block.s1; i++) {
            // Mono below 120 Hz: high-pass the side signal.
            const mid = (iL[i] + iR[i]) * 0.5
            const side = this.side[1].run(this.side[0].run((iL[i] - iR[i]) * 0.5))
            let l = mid + side, r = mid - side
            if (t > 0) {
                // Wow, flutter and a slow random drift, the same on both channels (stays mono-safe).
                const w = this.w
                this.bufL[w & 8191] = l; this.bufR[w & 8191] = r; this.w = w + 1
                this.wow += wowInc; this.flut += flutInc
                if (--this.driftT <= 0) {this.driftT = sr >> 1; this.driftTo = this.rnd() * 2 - 1}
                this.drift += (this.driftTo - this.drift) * 0.00001
                const dly = 0.008 * sr + t * sr * (0.0016 * Math.sin(this.wow) + 0.00006 * Math.sin(this.flut) + 0.0008 * this.drift)
                l = tap(this.bufL, w, dly); r = tap(this.bufR, w, dly)
                l = Math.tanh(this.drive * l) / this.drive; r = Math.tanh(this.drive * r) / this.drive
            }
            if (d > 0 && playing) {
                // Hiss: band-limited noise, different per side.
                this.hissL = this.hissL * hissA + (1 - hissA) * (this.rnd() * 2 - 1)
                this.hissR = this.hissR * hissA + (1 - hissA) * (this.rnd() * 2 - 1)
                const hl = this.hissL - this.hpL, hr = this.hissR - this.hpR
                this.hpL = this.hpL * hpA + (1 - hpA) * this.hissL; this.hpR = this.hpR * hpA + (1 - hpA) * this.hissR
                l += hl * 0.012 * d; r += hr * 0.012 * d
                // Crackle: sparse clicks, now and then a louder pop, randomly placed left to right.
                const p = this.rnd()
                if (p < d * 9 / sr) {this.cr = (this.rnd() < 0.5 ? -1 : 1) * d * (0.015 + 0.09 * Math.pow(this.rnd(), 3)); this.crPan = this.rnd()}
                else if (p > 1 - d * 0.35 / sr) {this.cr = d * (0.08 + 0.12 * this.rnd()); this.crPan = this.rnd()}
                const c = this.cr - this.crHp
                this.crHp += (this.cr - this.crHp) * 0.15
                this.cr *= this.crDec
                l += c * (1 - this.crPan); r += c * this.crPan
            }
            if (this.roll) {l = this.roll[0].run(l); r = this.roll[1].run(r)}
            oL[i] = l; oR[i] = r
        }
    }
}
`
}

// ---------- key and swing ----------

const MAJOR = 0b101010110101
const MINOR = 0b010110101101
const ROOTS: Record<string, number> = {C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11}

export function applyKey(project: Project, key: string) {
    const [root, mode] = key.split(" ")
    const kt = project.timelineBox.keyTrack
    kt.root.setValue(ROOTS[root] ?? 0)
    kt.scale.setValue(mode === "minor" ? MINOR : MAJOR)
}

/** Swing 0..0.5 from the song: the project shuffle groove, and a Zeitgeist on each unit that should swing. */
/** Song swing on the shared groove; a track with its own swing (WP5) gets its own shuffle box. */
export function applySwing(project: Project, units: ReadonlyArray<{ unit: AudioUnitBox, swing?: number }>, swing: number) {
    const root = project.rootBoxAdapter.groove.box as any
    root.amount.setValue(0.5 + swing * 0.5)
    for (const {unit, swing: own} of units) {
        const field = unit.midiEffects
        const ours = (IndexedBox.collectIndexedBoxes(field as any) as ReadonlyArray<any>)
            .find(b => b instanceof ZeitgeistDeviceBox && b.label.getValue() === TAG + "swing") as ZeitgeistDeviceBox | undefined
        const amount = own ?? swing
        if (amount === 0) {
            if (ours) dropOwnGroove(ours, root)
            if (ours) clearOurs(field)
            continue
        }
        const z = ours ?? insert<ZeitgeistDeviceBox>(project, field, EffectFactories.MidiNamed.Zeitgeist, "swing")
        const target = z.groove.targetVertex.unwrapOrNull()?.box as any
        if (own === undefined) {
            if (target !== root) {
                dropOwnGroove(z, root)
                z.groove.refer(root)
            }
        } else if (target && target !== root && target instanceof GrooveShuffleBox) {
            target.amount.setValue(0.5 + own * 0.5)
        } else {
            const box = GrooveShuffleBox.create(project.boxGraph, UUID.generate(), b => {
                b.label.setValue(TAG + "track swing")
                b.amount.setValue(0.5 + own * 0.5)
                b.duration.setValue(root.duration.getValue())
            })
            z.groove.refer(box)
        }
    }
}

const dropOwnGroove = (z: ZeitgeistDeviceBox, root: any) => {
    const target = z.groove.targetVertex.unwrapOrNull()?.box as any
    if (target && target !== root && target instanceof GrooveShuffleBox) {
        z.groove.refer(root)
        target.delete()
    }
}
