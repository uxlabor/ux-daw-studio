// ux-daw instrument adapter. The API sends what each sound is made of as plain data with every song
// (oscillators, a filter, an envelope; the kit pads the song plays; files by signed link). This module
// turns that data into openDAW device settings. It holds no patches, kits, trims or files of its own,
// and chooses nothing: the API picks each hit's pad (layer and alternation) and sends pad notes, which
// the bridge plays as sent. All of that lives on the server (rules R2 and R3). Together with chain.ts it is the only place that
// knows openDAW device names (R4).
import {Progress, UUID} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {Project} from "@opendaw/studio-core"
import {SoundfontFileBox} from "@opendaw/studio-boxes"
import {InstrumentFactories} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService"

export type Wave = "sine" | "triangle" | "saw" | "square"
export type AssetRef = { id: string, name: string, url: string }
export type SynthInstrument = {
    kind: "synth", trim_db: number
    osc: Array<{ wave: Wave, level_db: number, octave: number, cents: number }>
    filter: { cutoff_hz: number, resonance: number, slope: 1 | 2 | 3 | 4, envelope: number, keytrack: number }
    envelope: { attack: number, decay: number, sustain: number, release: number }
    mono: boolean, glide: number
    unison: { voices: 1 | 3 | 5, detune_cents: number, spread: number }
    lfo?: { wave: Wave, rate_hz: number, pitch: number, cutoff: number, level: number }
}
export type SampledInstrument = { kind: "sampled", trim_db: number, file: AssetRef }
export type Pad = {
    note: number, role: string, gm: number
    pan: number, seconds: number, choke: boolean, file: AssetRef
    /** A slice of the file (chops): fractions of its length, pitch in cents, gated by the note, level in dB. */
    start?: number, end?: number, pitch_ct?: number, gated?: boolean, volume_db?: number
}
/** Only the pads the song plays; the API resolves every kit note to one of them (pad_notes). */
export type KitInstrument = { kind: "kit", pads: Pad[] }
export type BasicInstrument = { kind: "basic" }
/** A stock synth set field by field from the server's recipe (stock synths brief Y1), or a few as layers. */
export type StockEngine = "fm" | "modal" | "acid" | "subtractive"
export type StockLayer = { engine: "fm" | "modal" | "subtractive", set: Record<string, number>, gain_db: number, pan: number }
export type StockInstrument = {
    kind: "stock", trim_db: number, engine: StockEngine | "layers"
    set: Record<string, number>, layers?: StockLayer[]
}
export type Instrument = SynthInstrument | SampledInstrument | KitInstrument | BasicInstrument | StockInstrument

/** The API's engine words to openDAW's stock instruments (R4: only the adapter knows device names). */
export const STOCK_DEVICE = {
    fm: "Tubular", modal: "Korpus", acid: "Cubed", subtractive: "Vaporisateur", layers: "InstrumentComposite"
} as const

/** Writes each setting the server sent, by its field path ("operators.2.outputLevel"). Chooses nothing. */
export function applyFields(box: any, set: Record<string, number>) {
    for (const [path, value] of Object.entries(set)) {
        let field = box
        for (const part of path.split(".")) {
            field = field === undefined ? undefined : /^\d+$/.test(part) ? field.fields?.()[Number(part)] : field[part]
        }
        if (field !== undefined && typeof field.setValue === "function") field.setValue(value)
        else console.warn(`ux-daw: this studio has no setting ${path}; the sound may differ`)
    }
}

/** Sets a stock instrument from its recipe; layers become cells of the composite, one part and one strip. */
export function applyStock(api: any, box: any, s: StockInstrument) {
    applyFields(box, s.set)
    for (const layer of s.layers ?? []) {
        const made = api.createCompositeLayer(box, (InstrumentFactories.Named as any)[STOCK_DEVICE[layer.engine]])
        if (!made.isSuccess()) {
            console.warn(`ux-daw: a layer could not be added (${made.failureReason()})`)
            continue
        }
        const {cellBox, instrumentBox} = made.result()
        cellBox.gain.setValue(layer.gain_db)
        cellBox.pan.setValue(layer.pan)
        applyFields(instrumentBox, layer.set)
    }
}

const WAVE: Record<Wave, number> = {sine: 0, triangle: 1, saw: 2, square: 3}

/** Sets a two-oscillator synth (openDAW's Vaporisateur) from the neutral settings. */
export function applySynth(box: any, s: SynthInstrument) {
    s.osc.forEach((o, i) => {
        const f = box.oscillators.fields()[i]
        f.waveform.setValue(WAVE[o.wave])
        f.volume.setValue(o.level_db)
        f.octave.setValue(o.octave)
        f.tune.setValue(o.cents)
    })
    box.cutoff.setValue(s.filter.cutoff_hz)
    box.resonance.setValue(s.filter.resonance)
    box.filterOrder.setValue(s.filter.slope)
    box.filterEnvelope.setValue(s.filter.envelope)
    box.filterKeyboard.setValue(s.filter.keytrack)
    box.attack.setValue(s.envelope.attack)
    box.decay.setValue(s.envelope.decay)
    box.sustain.setValue(s.envelope.sustain)
    box.release.setValue(s.envelope.release)
    box.voicingMode.setValue(s.mono ? 0 : 1)
    if (s.mono) box.glideTime.setValue(s.glide)
    box.unisonCount.setValue(s.unison.voices)
    if (s.unison.voices > 1) {
        box.unisonDetune.setValue(s.unison.detune_cents)
        box.unisonStereo.setValue(s.unison.spread)
    }
    if (s.lfo) {
        box.lfo.waveform.setValue(WAVE[s.lfo.wave])
        box.lfo.rate.setValue(s.lfo.rate_hz)
        box.lfo.targetTune.setValue(s.lfo.pitch)
        box.lfo.targetCutoff.setValue(s.lfo.cutoff)
        box.lfo.targetVolume.setValue(s.lfo.level)
    }
}

/** The SoundFont file box for a sampled instrument (shared when two sounds use one file). */
export function soundfontBox(project: Project, file: AssetRef): SoundfontFileBox {
    const uuid = UUID.parse(file.id)
    const existing = project.boxGraph.findBox(uuid)
    if (existing.nonEmpty()) return existing.unwrap() as SoundfontFileBox
    return SoundfontFileBox.create(project.boxGraph, uuid, box => box.fileName.setValue(`${file.name}.sf2`))
}

export type Attachment = Array<{ note: number, uuid: UUID.Bytes, name: string, durationInSeconds: number, exclude: boolean }>

export const kitAttachment = (kit: KitInstrument): Attachment => kit.pads.map(p => ({
    note: p.note, uuid: UUID.parse(p.file.id), name: p.file.name, durationInSeconds: p.seconds, exclude: p.choke
}))

export const isTexture = (kit: KitInstrument) => kit.pads.length === 1 && kit.pads[0].role === "texture"

/** Which pads a kit device holds: when the song starts playing another pad, the device is made again. */
export const kitSignature = (kit: KitInstrument): string => kit.pads.map(p => `${p.note}:${p.file.id}`).join(",")

/** A pad note back to the song note it stands for (studio edits read back). */
export const kitGmOf = (kit: KitInstrument, note: number): number | null => kit.pads.find(p => p.note === note)?.gm ?? null

export const padPan = (kit: KitInstrument, note: number): number | undefined => kit.pads.find(p => p.note === note)?.pan

/** Applies a pad's slice settings, as the server sent them, to the sampler pad on that note. */
export function applyPadSlice(kit: KitInstrument, box: any) {
    const p = kit.pads.find(x => x.note === box.index.getValue())
    if (!p) return
    if (p.start !== undefined) box.sampleStart.setValue(p.start)
    if (p.end !== undefined) box.sampleEnd.setValue(p.end)
    if (p.pitch_ct !== undefined) box.pitch.setValue(p.pitch_ct)
    if (p.gated) box.gate.setValue(1) // Playfield gate mode 1 = On: the note's length stops the slice
    if (p.volume_db !== undefined) box.volume.setValue(p.volume_db)
}

// ---------- files: our samples and SoundFonts reach openDAW's loaders through its own provider hook ----------

const assets = new Map<string, AssetRef>() // uuid -> signed link
const sampleCache = new Map<string, Promise<AudioData>>()
const sf2Cache = new Map<string, Promise<ArrayBuffer>>()

/** Remembers the files a song's instruments name, so the providers can find them by UUID. */
export function registerAssets(instruments: Record<string, Instrument>) {
    for (const inst of Object.values(instruments)) {
        if (inst.kind === "sampled") assets.set(inst.file.id, inst.file)
        if (inst.kind === "kit") for (const p of inst.pads) assets.set(p.file.id, p.file)
    }
}

const fetchBytes = (a: AssetRef) => fetch(a.url).then(r => {
    if (!r.ok) throw new Error(`${a.name}: HTTP ${r.status}`)
    return r.arrayBuffer()
})

/**
 * Puts our files in front of openDAW's sample and SoundFont providers: the bridge wraps `fetch` on the live
 * provider objects the studio hands it, so our UUIDs are answered first and everything else goes on to
 * openDAW's own path unchanged. (openDAW's catalogue CDN refuses this origin and its index fetch retries
 * forever, so a fall-through peer after it is never reached.)
 */
export function attachProviders(service: StudioService) {
    const sample = (uuid: UUID.Bytes): Promise<unknown> | null => {
        const id = UUID.toString(uuid)
        const a = assets.get(id)
        if (!a) return null
        let p = sampleCache.get(id)
        if (!p) sampleCache.set(id, p = fetchBytes(a).then(decodeWav))
        return p.then(data => [data, meta(a.name, data)])
    }
    const soundfont = (uuid: UUID.Bytes): Promise<unknown> | null => {
        const id = UUID.toString(uuid)
        const a = assets.get(id)
        if (!a) return null
        let p = sf2Cache.get(id)
        if (!p) sf2Cache.set(id, p = fetchBytes(a))
        return p.then(data => [data, {name: a.name, size: data.byteLength, url: "", license: "see the studio's credits", origin: "openDAW"}])
    }
    oursFirst(service.chainedSampleProvider, sample)
    oursFirst(service.chainedSoundfontProvider, soundfont)
}

function oursFirst(provider: any, ours: (uuid: UUID.Bytes) => Promise<unknown> | null) {
    const theirs = provider.fetch.bind(provider)
    provider.fetch = (uuid: UUID.Bytes, progress: Progress.Handler) => ours(uuid) ?? theirs(uuid, progress)
}

const meta = (name: string, d: AudioData) =>
    ({name, bpm: 120, duration: d.numberOfFrames / d.sampleRate, sample_rate: d.sampleRate, origin: "openDAW"})

/** Our files are WAV, mono or stereo: 16-bit PCM, or 32-bit float (kit/body, rendered once on the server). */
function decodeWav(buf: ArrayBuffer): AudioData {
    const v = new DataView(buf)
    let pos = 12, channels = 1, rate = 44100, float = false, data = -1, len = 0
    while (pos + 8 <= v.byteLength) {
        const id = String.fromCharCode(v.getUint8(pos), v.getUint8(pos + 1), v.getUint8(pos + 2), v.getUint8(pos + 3))
        const size = v.getUint32(pos + 4, true)
        if (id === "fmt ") {
            float = v.getUint16(pos + 8, true) === 3
            channels = v.getUint16(pos + 10, true)
            rate = v.getUint32(pos + 12, true)
        } else if (id === "data") {
            data = pos + 8
            len = size
            break
        }
        pos += 8 + size + (size & 1)
    }
    if (data < 0) throw new Error("not a WAV file")
    const width = float ? 4 : 2
    const at = (o: number) => float ? v.getFloat32(o, true) : v.getInt16(o, true) / 32768
    const frames = Math.floor(len / (width * channels))
    const out = AudioData.create(rate, frames, 2)
    for (let i = 0; i < frames; i++) {
        const l = at(data + i * width * channels)
        const r = channels > 1 ? at(data + i * width * channels + width) : l
        out.frames[0][i] = l
        out.frames[1][i] = r
    }
    return out
}
