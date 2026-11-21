// ux-daw automation (boom-bap B5, synthwave and house S1): the API works out, per track and for the master, lists
// of [beat, value] points (volume in dB, low-pass and high-pass in Hz, pan, reverb wet in dB) and sends them with
// the song; this file only writes them as automation lanes of one region each. Shapes and curves are worked out
// on the server, which sends them as short straight ramps. Our lanes carry the region label "ux·sections"; lanes
// the user drew are never touched.
import {Interpolation, PPQN} from "@opendaw/lib-dsp"
import {UUID} from "@opendaw/lib-std"
import {AudioUnitBoxAdapter, InterpolationFieldAdapter, TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {AudioUnitBox, ValueEventBox, ValueEventCollectionBox, ValueRegionBox} from "@opendaw/studio-boxes"
import {Project} from "@opendaw/studio-core"

/** What the API sends per track: [beat from the song start, value], held to the next point; a third element 1
 * ramps straight to the next point instead (the pump, synthwave and house S3; every curve, S1). */
export type AutoPoint = [number, number] | [number, number, 1]
export type TrackAutomation = {
    volume?: Array<AutoPoint>, lowpass?: Array<AutoPoint>, highpass?: Array<AutoPoint>, pan?: Array<AutoPoint>, reverb?: Array<AutoPoint>
}
/** The master's lanes (S1): its volume and the master low-pass. */
export type MasterAutomation = { volume?: Array<AutoPoint>, lowpass?: Array<AutoPoint> }

/** Device fields a lane may point at; null where the chain has no such device. */
export type LaneFields = { lowpass: any | null, highpass?: any | null, reverbWet?: any | null }

const LABEL = "ux·sections"

const ours = (adapter: TrackBoxAdapter) => {
    const regions = adapter.regions.collection.asArray()
    return regions.length > 0 && regions.every(r => String((r.box as any).label?.getValue?.() ?? "") === LABEL)
}

/** Removes our automation lanes from a unit (before its chain is rebuilt, or when the song has none). */
export function clearAutomation(project: Project, unit: AudioUnitBox) {
    const tracks = project.boxAdapters.adapterFor(unit, AudioUnitBoxAdapter).tracks
    for (const t of [...tracks.values()]) if (t.type === TrackType.Value && ours(t)) tracks.delete(t)
}

/** A string that changes whenever the lanes would change. */
export const automationSignature = (a: TrackAutomation | MasterAutomation | undefined | null) => a ? JSON.stringify(a) : ""

/** Any adapter: a device inserted in this transaction has no parameter adapters until its own adapter exists. */
const anyAdapter = ((_: unknown) => true) as any

/**
 * Writes the lanes of a track (or, given the master's unit, of the master). Call after the chain is built:
 * `fields` names the section filter's cutoffs and the reverb's wet level (the master passes its low-pass).
 */
export function writeAutomation(project: Project, unit: AudioUnitBox, a: TrackAutomation | MasterAutomation | undefined | null,
                                fields: LaneFields, songBars: number) {
    clearAutomation(project, unit)
    if (!a) return
    const t = a as TrackAutomation
    const unitAdapter = project.boxAdapters.adapterFor(unit, AudioUnitBoxAdapter)
    const lanes: Array<[any, Array<AutoPoint>]> = []
    if (t.volume?.length) lanes.push([unit.volume, t.volume])
    if (t.pan?.length) lanes.push([unit.panning, t.pan])
    const devices: Array<[any, Array<AutoPoint> | undefined]> = [[fields.lowpass, t.lowpass], [fields.highpass, t.highpass], [fields.reverbWet, t.reverb]]
    for (const [field, points] of devices) {
        if (!points?.length || !field) continue
        project.boxAdapters.adapterFor(field.box, anyAdapter)
        lanes.push([field, points])
    }
    const duration = songBars * PPQN.Bar
    for (const [field, points] of lanes) {
        const parameter = project.parameterFieldAdapters.opt(field.address)
        if (parameter.isEmpty()) {
            console.warn("[ux-daw] no parameter to automate", field.address.toString())
            continue
        }
        const mapping = parameter.unwrap().valueMapping
        // A lane the user drew on this parameter stays; ours are gone (cleared above).
        if (unitAdapter.tracks.controls(field).nonEmpty()) continue
        const trackBox = unitAdapter.tracks.create(TrackType.Value, field)
        const events = ValueEventCollectionBox.create(project.boxGraph, UUID.generate())
        ValueRegionBox.create(project.boxGraph, UUID.generate(), box => {
            box.position.setValue(0)
            box.label.setValue(LABEL)
            box.mute.setValue(false)
            box.duration.setValue(duration)
            box.loopDuration.setValue(duration)
            box.events.refer(events.owners)
            box.regions.refer(trackBox.regions)
        })
        for (const [beat, value, ramp] of points) {
            ValueEventBox.create(project.boxGraph, UUID.generate(), box => {
                box.position.setValue(Math.round(beat * PPQN.Quarter))
                box.value.setValue(mapping.x(mapping.clamp(value)))
                box.events.refer(events.events)
                InterpolationFieldAdapter.write(box.interpolation, ramp === 1 ? Interpolation.Linear : Interpolation.None)
            })
        }
    }
}
