// ux-daw basic sound ids -> openDAW instruments.
// Drums are a Playfield whose samples are synthesized here in the browser (our own sounds, no
// third-party samples), served through the sample provider by fixed UUIDs.
import {AudioData} from "@opendaw/lib-dsp"
import {UUID} from "@opendaw/lib-std"
import {InstrumentFactories} from "@opendaw/studio-adapters"

/** Sounds with no private data: stock devices at their defaults, and our synthesized kit. Patches, sampled
 * kits and textures come from the API as instrument data (./instruments). */
export type SoundDef = { factory: keyof typeof InstrumentFactories.Named, drums?: boolean }

export const SOUNDS: Record<string, SoundDef> = {
    "kit/body": {factory: "Playfield", drums: true},
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
