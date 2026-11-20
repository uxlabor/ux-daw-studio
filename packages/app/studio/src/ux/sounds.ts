// ux-daw basic sound ids -> openDAW instruments: stock devices at their defaults, with no private data.
// Patches, sampled kits (kit/body included, rendered to files on the server since 20 Nov) and textures come
// from the API as instrument data (./instruments).
import {InstrumentFactories} from "@opendaw/studio-adapters"

export type SoundDef = { factory: keyof typeof InstrumentFactories.Named }

export const SOUNDS: Record<string, SoundDef> = {
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
