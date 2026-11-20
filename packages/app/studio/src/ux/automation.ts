// ux-daw per-section automation (boom-bap B5): the API works out, per track, a list of [beat, value] points
// (volume in dB, the section low-pass in Hz) and sends them with the song; this file only writes them as an
// automation lane of one region, every point held to the next. Our lanes carry the region label "ux·sections";
// lanes the user drew are never touched.
import {Interpolation, PPQN} from "@opendaw/lib-dsp"
import {UUID} from "@opendaw/lib-std"
import {AudioUnitBoxAdapter, InterpolationFieldAdapter, RevampDeviceBoxAdapter, TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {AudioUnitBox, ValueEventBox, ValueEventCollectionBox, ValueRegionBox} from "@opendaw/studio-boxes"
import {Project} from "@opendaw/studio-core"

/** What the API sends per track: [beat from the song start, value]. */
export type TrackAutomation = { volume?: Array<[number, number]>, lowpass?: Array<[number, number]> }

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
export const automationSignature = (a: TrackAutomation | undefined) => a ? JSON.stringify(a) : ""

/**
 * Writes the lanes: `filter` is the section low-pass device's frequency field (null when the chain has none).
 * Call after the track chain is built.
 */
export function writeAutomation(project: Project, unit: AudioUnitBox, a: TrackAutomation | undefined, filterFrequency: any | null, songBars: number) {
    clearAutomation(project, unit)
    if (!a) return
    const unitAdapter = project.boxAdapters.adapterFor(unit, AudioUnitBoxAdapter)
    const lanes: Array<[any, Array<[number, number]>]> = []
    if (a.volume?.length) lanes.push([unit.volume, a.volume])
    if (a.lowpass?.length && filterFrequency) {
        // A device inserted in this transaction has no parameter adapters until its own adapter exists.
        project.boxAdapters.adapterFor(filterFrequency.box, RevampDeviceBoxAdapter)
        lanes.push([filterFrequency, a.lowpass])
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
        for (const [beat, value] of points) {
            ValueEventBox.create(project.boxGraph, UUID.generate(), box => {
                box.position.setValue(Math.round(beat * PPQN.Quarter))
                box.value.setValue(mapping.x(mapping.clamp(value)))
                box.events.refer(events.events)
                InterpolationFieldAdapter.write(box.interpolation, Interpolation.None)
            })
        }
    }
}
