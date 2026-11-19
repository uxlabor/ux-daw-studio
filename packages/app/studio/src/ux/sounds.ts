// ux-daw sound ids -> openDAW instruments. Keep the ids in sync with the API's src/sounds.ts.
// Drums are a Playfield whose samples are synthesized here in the browser (our own sounds, no
// third-party samples), served through the sample provider by fixed UUIDs.
import {AudioData} from "@opendaw/lib-dsp"
import {UUID} from "@opendaw/lib-std"
import {InstrumentFactories} from "@opendaw/studio-adapters"
import KITS from "./kits.json"

export type SoundDef = { factory: keyof typeof InstrumentFactories.Named, drums?: boolean, kit?: KitId, texture?: TextureId }

export const SOUNDS: Record<string, SoundDef> = {
    "kit/body": {factory: "Playfield", drums: true},
    "kit/dusty": {factory: "Playfield", kit: "dusty"},
    "kit/soft": {factory: "Playfield", kit: "soft"},
    "kit/boombap": {factory: "Playfield", kit: "boombap"},
    "texture/vinyl": {factory: "Playfield", texture: "vinyl"},
    "texture/rain": {factory: "Playfield", texture: "rain"},
    "texture/room": {factory: "Playfield", texture: "room"},
    "bass/sub": {factory: "Vaporisateur"},
    "bass/saw": {factory: "Vaporisateur"},
    "bass/acid": {factory: "Cubed"},
    "keys/epiano": {factory: "Tubular"},
    "keys/bell": {factory: "Tubular"},
    "pad/warm": {factory: "Vaporisateur"},
    "lead/square": {factory: "Vaporisateur"},
    "pluck/soft": {factory: "Korpus"},
    "keys/cz": {factory: "Neon"}
}

type DrumName = "kick" | "rim" | "snare" | "clap" | "hat" | "tom" | "openhat"

/** General MIDI note -> drum, with a fixed UUID per synthesized sample. */
export const DRUMS: ReadonlyArray<{ note: number, name: DrumName, uuid: string, seconds: number }> = [
    {note: 36, name: "kick", uuid: "0d4a0000-0000-4000-8000-000000000036", seconds: 0.6},
    {note: 37, name: "rim", uuid: "0d4a0000-0000-4000-8000-000000000037", seconds: 0.15},
    {note: 38, name: "snare", uuid: "0d4a0000-0000-4000-8000-000000000038", seconds: 0.35},
    {note: 39, name: "clap", uuid: "0d4a0000-0000-4000-8000-000000000039", seconds: 0.4},
    {note: 42, name: "hat", uuid: "0d4a0000-0000-4000-8000-000000000042", seconds: 0.08},
    {note: 45, name: "tom", uuid: "0d4a0000-0000-4000-8000-000000000045", seconds: 0.45},
    {note: 46, name: "openhat", uuid: "0d4a0000-0000-4000-8000-000000000046", seconds: 0.45}
]

const SR = 48000

const noise = (seed: number) => {
    let s = seed >>> 0
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0
        return s / 2147483648 - 1
    }
}

/** One-pole high-pass, for hats. */
const highpass = (x: Float32Array, cutoff: number) => {
    const rc = 1 / (2 * Math.PI * cutoff)
    const a = rc / (rc + 1 / SR)
    let py = 0, px = 0
    for (let i = 0; i < x.length; i++) {
        const y = a * (py + x[i] - px)
        px = x[i]
        py = y
        x[i] = y
    }
}

function synth(name: DrumName, n: number): Float32Array {
    const out = new Float32Array(n)
    const rnd = noise(name.length * 7919)
    let phase = 0
    for (let i = 0; i < n; i++) {
        const t = i / SR
        switch (name) {
            case "kick": {
                const f = 45 + 110 * Math.exp(-t * 28)
                phase += 2 * Math.PI * f / SR
                out[i] = Math.sin(phase) * Math.exp(-t * 6.5) + 0.25 * Math.exp(-t * 300) * rnd()
                break
            }
            case "snare": {
                phase += 2 * Math.PI * 190 / SR
                out[i] = 0.45 * Math.sin(phase) * Math.exp(-t * 22) + 0.6 * rnd() * Math.exp(-t * 14)
                break
            }
            case "clap": {
                const bursts = [0, 0.011, 0.022, 0.034]
                let env = 0
                for (const b of bursts) if (t >= b) env = Math.max(env, Math.exp(-(t - b) * (b === 0.034 ? 12 : 120)))
                out[i] = 0.7 * rnd() * env
                break
            }
            case "rim": {
                phase += 2 * Math.PI * 1700 / SR
                out[i] = 0.6 * Math.sin(phase) * Math.exp(-t * 60) + 0.3 * rnd() * Math.exp(-t * 200)
                break
            }
            case "tom": {
                const f = 95 + 60 * Math.exp(-t * 18)
                phase += 2 * Math.PI * f / SR
                out[i] = 0.8 * Math.sin(phase) * Math.exp(-t * 8)
                break
            }
            case "hat":
                out[i] = 0.5 * rnd() * Math.exp(-t * 55)
                break
            case "openhat":
                out[i] = 0.45 * rnd() * Math.exp(-t * 7)
                break
        }
    }
    if (name === "hat" || name === "openhat" || name === "snare" || name === "clap") highpass(out, name === "snare" ? 400 : name === "clap" ? 900 : 6000)
    // Short fade-out against clicks.
    const fade = Math.min(n, 480)
    for (let i = 0; i < fade; i++) out[n - 1 - i] *= i / fade
    return out
}

/** The synthesized sample for one of our drum UUIDs, or null when the UUID is not ours. */
export function drumSample(uuid: UUID.Bytes): AudioData | null {
    const id = UUID.toString(uuid)
    const drum = DRUMS.find(d => d.uuid === id)
    if (!drum) return null
    const n = Math.round(drum.seconds * SR)
    const mono = synth(drum.name, n)
    const data = AudioData.create(SR, n, 2)
    data.frames[0].set(mono)
    data.frames[1].set(mono)
    return data
}

export const drumName = (uuid: UUID.Bytes): string => DRUMS.find(d => d.uuid === UUID.toString(uuid))?.name ?? "drum"

// ---------- sampled kits and textures (lo-fi stage WP2; credits in public/ux/samples/CREDITS.md) ----------

export type KitId = "dusty" | "soft" | "boombap"
export type TextureId = "vinyl" | "rain" | "room"
type Pad = { role: string, gm: number, file: string, layer: [number, number], rr: number, seconds?: number }

/** Internal pad notes start here, above the General MIDI drum range the song uses. */
const PAD_BASE = 100
const kitPads = (kit: KitId): ReadonlyArray<Pad> => (KITS.kits as any)[kit].pads as Pad[]
export const TEXTURE_PAD_NOTE = 60

/** A stable UUID per sample file (ours), so the sample provider can find it. */
const fileUuid = (file: string): string => {
    let h1 = 0x811c9dc5, h2 = 0x01000193
    for (let i = 0; i < file.length; i++) {
        h1 = Math.imul(h1 ^ file.charCodeAt(i), 16777619) >>> 0
        h2 = Math.imul(h2 ^ file.charCodeAt(i), 2246822519) >>> 0
    }
    const hex = (n: number) => n.toString(16).padStart(8, "0")
    const a = hex(h1), b = hex(h2)
    return `0d4a0001-${a.slice(0, 4)}-4${a.slice(5, 8)}-8${b.slice(1, 4)}-${b}${a.slice(0, 4)}`
}

const FILES = new Map<string, string>() // uuid -> file
for (const kit of Object.keys(KITS.kits) as KitId[]) for (const p of kitPads(kit)) FILES.set(fileUuid(p.file), p.file)
for (const t of Object.values(KITS.textures) as Array<{ file: string }>) FILES.set(fileUuid(t.file), t.file)

export type Attachment = Array<{ note: number, uuid: UUID.Bytes, name: string, durationInSeconds: number, exclude: boolean }>

const baseName = (file: string) => file.split("/")[1].replace(".wav", "")

export function kitAttachment(kit: KitId): Attachment {
    return kitPads(kit).map((p, i) => ({
        note: PAD_BASE + i, uuid: UUID.parse(fileUuid(p.file)), name: baseName(p.file),
        durationInSeconds: p.seconds ?? 0.5, exclude: p.role === "hat" || p.role === "openhat"
    }))
}

export function textureAttachment(t: TextureId): Attachment {
    const tex = (KITS.textures as any)[t] as { file: string, seconds: number }
    return [{note: TEXTURE_PAD_NOTE, uuid: UUID.parse(fileUuid(tex.file)), name: t, durationInSeconds: tex.seconds, exclude: false}]
}

/** What a General MIDI drum note plays in our kits when the kit has no pad of its own for it. */
const GM_FALLBACK: Record<number, string> = {
    36: "kick", 35: "kick2", 33: "kick3", 34: "kick3", 38: "snare", 40: "snare", 37: "rim", 39: "clap", 42: "hat", 44: "hat",
    46: "openhat", 49: "openhat", 51: "hat", 70: "shaker", 82: "shaker", 69: "shaker", 63: "perc1", 62: "perc1", 64: "perc2",
    45: "perc2", 41: "perc2", 43: "perc2", 47: "perc1", 48: "perc1", 50: "perc1", 75: "rim", 76: "perc1", 77: "perc2"
}

/**
 * Maps one song drum note to a pad: velocity picks the layer, hats and shakers alternate (round robin).
 * `counter` keeps the alternation across a track. Returns null when the kit has nothing for the note.
 */
export function kitPadNote(kit: KitId, gm: number, velocity: number, counter: Map<string, number>): number | null {
    const pads = kitPads(kit)
    const own = pads.find(p => p.gm === gm)
    const role = own ? own.role : GM_FALLBACK[gm]
    if (!role) return null
    const candidates = pads.map((p, i) => ({p, i})).filter(({p}) => p.role === role && velocity >= p.layer[0] && velocity <= p.layer[1])
    if (candidates.length === 0) return null
    const rrs = [...new Set(candidates.map(c => c.p.rr))]
    const n = counter.get(role) ?? 0
    counter.set(role, n + 1)
    const rr = rrs[n % rrs.length]
    return PAD_BASE + candidates.find(c => c.p.rr === rr)!.i
}

/** Pad note back to the General MIDI note it stands for (studio edits read back). */
export function kitGmOf(kit: KitId, padNote: number): number | null {
    return kitPads(kit)[padNote - PAD_BASE]?.gm ?? null
}

const cache = new Map<string, Promise<AudioData>>()

/** One of our sampled files by UUID (fetched from this site, decoded once), or null when the UUID is not ours. */
export function uxSample(uuid: UUID.Bytes): Promise<AudioData> | null {
    const file = FILES.get(UUID.toString(uuid))
    if (!file) return null
    let p = cache.get(file)
    if (!p) {
        p = fetch(`/ux/samples/${file}`).then(r => {
            if (!r.ok) throw new Error(`sample ${file}: HTTP ${r.status}`)
            return r.arrayBuffer()
        }).then(decodeWav16)
        cache.set(file, p)
    }
    return p
}

export const uxSampleName = (uuid: UUID.Bytes): string => {
    const f = FILES.get(UUID.toString(uuid))
    return f ? baseName(f) : "sample"
}

/** Our files are 16-bit PCM WAV, mono or stereo. */
function decodeWav16(buf: ArrayBuffer): AudioData {
    const v = new DataView(buf)
    let pos = 12, channels = 1, rate = 44100, data = -1, len = 0
    while (pos + 8 <= v.byteLength) {
        const id = String.fromCharCode(v.getUint8(pos), v.getUint8(pos + 1), v.getUint8(pos + 2), v.getUint8(pos + 3))
        const size = v.getUint32(pos + 4, true)
        if (id === "fmt ") {
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
    const frames = Math.floor(len / (2 * channels))
    const out = AudioData.create(rate, frames, 2)
    for (let i = 0; i < frames; i++) {
        const l = v.getInt16(data + i * 2 * channels, true) / 32768
        const r = channels > 1 ? v.getInt16(data + i * 2 * channels + 2, true) / 32768 : l
        out.frames[0][i] = l
        out.frames[1][i] = r
    }
    return out
}
