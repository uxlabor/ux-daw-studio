// Play it in (O7): letter keys and a MIDI keyboard play one of the song's tracks live, locked to the song's key
// if the user wants, and a take is written into that track's notes. The take is an ordinary studio edit: the
// bridge reads the project back and sends it as a new version, so the AI and `look` see the notes like any other.
// Public code (R2): it only moves notes the user played; no choosing, scoring or guidance lives here.
import {PPQN} from "@opendaw/lib-dsp"
import {NoteSignal, TrackBoxAdapter} from "@opendaw/studio-adapters"
import type {AudioUnitBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import type {Project} from "@opendaw/studio-core"
import {type Instrument, isTexture, type KitInstrument} from "./instruments"
import {DRUM_KEYS, type KeyMode, letterPitch, midiPitch, noteName, parseKey, quantise, type Scale} from "./scale"

const BAR = PPQN.Bar
const Q = PPQN.Quarter
const LETTER_VELOCITY = 100

type SongView = {
    key: string
    sections: ReadonlyArray<{ id: string, name: string, bars: number }>
    tracks: ReadonlyArray<{ id: string, name: string, role: string, sound: string }>
}
/** What the play-in panel needs from the bridge: the shown song, its tracks in the project, and a way to name the edit. */
export interface PlayHost {
    project(): Project | null
    song(): SongView | null
    unitOf(trackId: string): { unit: AudioUnitBox, track: TrackBox } | undefined
    instrument(sound: string): Instrument
    /** The label of the next studio edit the bridge sends ("played in 12 notes on Keys"). */
    labelNextEdit(label: string): void
    flash(text: string): void
}

type Held = { trackId: string, unit: AudioUnitBox, sounded: number, recorded: number, velocity: number, start: number | null }
type TakeNote = { pitch: number, velocity: number, start: number, end: number }

export class PlayIn {
    readonly #host: PlayHost
    readonly #panel: HTMLDivElement
    readonly #toggle: HTMLButtonElement
    readonly #trackSelect: HTMLSelectElement
    readonly #lock: HTMLInputElement
    readonly #lockLabel: HTMLLabelElement
    readonly #octaveText: HTMLSpanElement
    readonly #grid: HTMLSelectElement
    readonly #replace: HTMLSelectElement
    readonly #record: HTMLButtonElement
    readonly #help: HTMLDivElement
    readonly #midiText: HTMLDivElement
    #open = false
    #octave = 4
    #trackId: string | null = null
    #held = new Map<string, Held>()
    #midiAsked = false
    #recording = false
    #take: TakeNote[] = []
    #takeTrack: string | null = null
    /** Last engine position and when it arrived, to place a note between the engine's position updates. */
    #pos = {ppqn: 0, at: 0}
    #watching: Project | null = null

    constructor(host: PlayHost) {
        this.#host = host
        this.#toggle = el("button", {type: "button", title: "Play the selected track with your keyboard (letter keys or MIDI)"}, "Play") as HTMLButtonElement
        Object.assign(this.#toggle.style, {
            position: "fixed", left: "12px", bottom: "12px", zIndex: "100000", padding: "6px 14px", borderRadius: "999px",
            border: "0", background: "#3a43d9", color: "#fff", font: "600 12px/1.3 system-ui,sans-serif", cursor: "pointer",
            boxShadow: "0 2px 10px rgba(0,0,0,.35)"
        })
        this.#toggle.setAttribute("aria-expanded", "false")
        this.#toggle.onclick = () => this.setOpen(!this.#open)

        this.#panel = el("div", {role: "dialog", "aria-label": "Play it in"}) as HTMLDivElement
        Object.assign(this.#panel.style, {
            position: "fixed", left: "12px", bottom: "52px", zIndex: "100000", width: "300px", padding: "12px 14px",
            borderRadius: "12px", background: "rgba(20,21,26,.96)", color: "#f1f1f4", font: "500 12px/1.45 system-ui,sans-serif",
            boxShadow: "0 4px 18px rgba(0,0,0,.45)", display: "none"
        })
        const row = (...kids: Node[]) => {
            const r = el("div") as HTMLDivElement
            Object.assign(r.style, {display: "flex", alignItems: "center", gap: "8px", margin: "6px 0"})
            r.append(...kids)
            return r
        }
        const label = (text: string, ctl: HTMLElement) => {
            const l = el("label") as HTMLLabelElement
            Object.assign(l.style, {display: "flex", alignItems: "center", gap: "6px", flex: "1"})
            l.append(text, ctl)
            return l
        }
        this.#trackSelect = styled(el("select") as HTMLSelectElement)
        this.#trackSelect.onchange = () => {
            this.#allOff()
            this.#trackId = this.#trackSelect.value || null
            this.#refresh()
        }
        this.#lock = el("input", {type: "checkbox"}) as HTMLInputElement
        this.#lock.checked = true
        this.#lock.onchange = () => {
            this.#allOff()
            this.#refresh()
        }
        this.#lockLabel = el("label") as HTMLLabelElement
        Object.assign(this.#lockLabel.style, {display: "flex", alignItems: "center", gap: "6px", flex: "1"})
        const down = smallButton("−", "Octave down (Z)", () => this.#shiftOctave(-1))
        const up = smallButton("+", "Octave up (X)", () => this.#shiftOctave(1))
        this.#octaveText = el("span") as HTMLSpanElement
        this.#grid = styled(el("select") as HTMLSelectElement)
        for (const [v, t] of [[String(Q / 4), "1/16"], [String(Q / 2), "1/8"], [String(Q), "1/4"], ["0", "as played"]]) this.#grid.append(option(v, t))
        this.#replace = styled(el("select") as HTMLSelectElement)
        this.#replace.append(option("add", "add to the notes"), option("replace", "replace the bars I play over"))
        this.#record = el("button", {type: "button"}) as HTMLButtonElement
        Object.assign(this.#record.style, {
            flex: "1", padding: "7px 10px", borderRadius: "8px", border: "0", cursor: "pointer",
            font: "600 12px/1.3 system-ui,sans-serif", color: "#fff"
        })
        this.#record.onclick = () => this.#recording ? this.#stopRecording() : this.#startRecording()
        this.#help = el("div") as HTMLDivElement
        Object.assign(this.#help.style, {color: "#a9adb8", marginTop: "6px"})
        this.#midiText = el("div") as HTMLDivElement
        Object.assign(this.#midiText.style, {color: "#a9adb8"})
        const title = el("div", {}, "Play it in") as HTMLDivElement
        Object.assign(title.style, {font: "700 13px/1.3 system-ui,sans-serif", marginBottom: "4px"})
        this.#panel.append(
            title,
            row(label("Track", this.#trackSelect)),
            row(this.#lockLabel),
            row(el("span", {}, "Octave"), down, this.#octaveText, up),
            row(label("Snap to", this.#grid)),
            row(label("Take", this.#replace)),
            row(this.#record),
            this.#help, this.#midiText)

        const mount = () => document.body.append(this.#toggle, this.#panel)
        if (document.body) mount()
        else addEventListener("DOMContentLoaded", mount)
        // Capture phase on window: runs before the studio's own shortcuts, and only takes keys while the panel is open.
        addEventListener("keydown", e => this.#onKey(e, true), true)
        addEventListener("keyup", e => this.#onKey(e, false), true)
        addEventListener("blur", () => this.#allOff())
        this.#refresh()
    }

    get isOpen(): boolean {return this.#open}

    setOpen(open: boolean) {
        this.#open = open
        this.#panel.style.display = open ? "block" : "none"
        this.#toggle.setAttribute("aria-expanded", String(open))
        this.#toggle.textContent = open ? "Close play" : "Play"
        if (!open) {
            if (this.#recording) this.#stopRecording()
            this.#allOff()
        } else {
            this.#watch()
            void this.#askMidi()
        }
        this.#refresh()
    }

    /** The bridge calls this when a song is shown or changed, and when the studio's selected track changes. */
    songChanged() {
        const song = this.#host.song()
        if (this.#trackId && !song?.tracks.some(t => t.id === this.#trackId)) this.#trackId = null
        this.#watch()
        this.#refresh()
    }

    /** The studio selected a track (its device chain is open): play that one. */
    selectUnit(unit: AudioUnitBox) {
        const song = this.#host.song()
        const t = song?.tracks.find(x => this.#host.unitOf(x.id)?.unit === unit)
        if (!t || t.id === this.#trackId || this.#held.size > 0 || this.#recording) return
        this.#trackId = t.id
        this.#refresh()
    }

    // ---------- what plays ----------

    #track() {
        const song = this.#host.song()
        if (!song) return null
        const t = song.tracks.find(x => x.id === this.#trackId)
            ?? song.tracks.find(x => x.role !== "drums") ?? song.tracks[0]
        if (!t) return null
        this.#trackId = t.id
        return t
    }

    #mode(role: string): KeyMode {return role === "drums" ? "drums" : this.#lock.checked ? "locked" : "chromatic"}

    #scale(): Scale {return parseKey(this.#host.song()?.key)}

    #shiftOctave(by: number) {
        this.#octave = Math.max(0, Math.min(8, this.#octave + by))
        this.#refresh()
    }

    #onKey(e: KeyboardEvent, down: boolean) {
        if (!this.#open || e.ctrlKey || e.metaKey || e.altKey) return
        const target = e.target as HTMLElement | null
        if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) && !this.#panel.contains(target)) return
        if (e.code === "Escape" && down) {
            this.setOpen(false)
            return
        }
        const t = this.#track()
        if (!t) return
        const mode = this.#mode(t.role)
        const octaveKey = e.code === "KeyZ" ? -1 : e.code === "KeyX" ? 1 : 0
        const pitch = octaveKey ? null : letterPitch(e.code, mode, this.#scale(), this.#octave)
        if (!octaveKey && pitch === null) return
        e.preventDefault()
        e.stopImmediatePropagation()
        if (!down) return this.#noteOff(`key:${e.code}`)
        if (e.repeat) return
        if (octaveKey) return this.#shiftOctave(octaveKey)
        this.#noteOn(`key:${e.code}`, pitch!, LETTER_VELOCITY)
    }

    #noteOn(id: string, pitch: number, velocity: number) {
        const project = this.#host.project()
        const t = this.#track()
        const m = t ? this.#host.unitOf(t.id) : undefined
        if (!project || !t || !m) return
        this.#noteOff(id)
        const inst = this.#host.instrument(t.sound)
        // A kit plays its pad for the drum (the song keeps GM notes); the bridge maps pads back when it reads the edit.
        const sounded = inst.kind === "kit" ? padFor(inst, pitch) : pitch
        if (sounded === null) return
        project.engine.noteSignal(NoteSignal.on(m.unit.address.uuid, sounded, velocity / 127))
        const rec = this.#recording && this.#takeTrack === t.id && project.engine.isPlaying.getValue()
        this.#held.set(id, {trackId: t.id, unit: m.unit, sounded, recorded: sounded, velocity, start: rec ? this.#now(project) : null})
    }

    #noteOff(id: string) {
        const h = this.#held.get(id)
        if (!h) return
        this.#held.delete(id)
        const project = this.#host.project()
        if (!project) return
        project.engine.noteSignal(NoteSignal.off(h.unit.address.uuid, h.sounded))
        if (h.start !== null && this.#recording && h.trackId === this.#takeTrack) {
            let end = this.#now(project)
            if (end <= h.start) end = this.#loopEnd(project) // the loop wrapped while the key was held
            this.#take.push({pitch: h.recorded, velocity: h.velocity, start: h.start, end})
            this.#refresh()
        }
    }

    #allOff() {for (const id of [...this.#held.keys()]) this.#noteOff(id)}

    // ---------- MIDI keyboard ----------

    async #askMidi() {
        if (this.#midiAsked) return
        this.#midiAsked = true
        const nav = navigator as Navigator & { requestMIDIAccess?: () => Promise<MIDIAccess> }
        if (!nav.requestMIDIAccess) return this.#midiStatus("This browser has no MIDI. The letter keys work.")
        try {
            const access = await nav.requestMIDIAccess()
            const attach = () => {
                const names: string[] = []
                access.inputs.forEach(input => {
                    input.removeEventListener("midimessage", this.#onMidi)
                    input.addEventListener("midimessage", this.#onMidi)
                    if (input.state === "connected") names.push(input.name ?? "MIDI keyboard")
                })
                this.#midiStatus(names.length ? `MIDI: ${names.join(", ")}` : "No MIDI keyboard found. Plug one in, or use the letter keys.")
            }
            access.onstatechange = attach
            attach()
        } catch {
            this.#midiStatus("MIDI was not allowed. The letter keys work.")
        }
    }

    readonly #onMidi = (ev: Event) => {
        const data = (ev as MIDIMessageEvent).data
        if (!this.#open || !data || data.length < 3) return
        const kind = data[0] & 0xf0
        const id = `midi:${data[1]}`
        if (kind === 0x90 && data[2] > 0) {
            const t = this.#track()
            if (!t) return
            this.#noteOn(id, midiPitch(data[1], this.#mode(t.role), this.#scale()), data[2])
        } else if (kind === 0x80 || kind === 0x90) this.#noteOff(id)
    }

    #midiStatus(text: string) {this.#midiText.textContent = text}

    // ---------- recording ----------

    #watch() {
        const project = this.#host.project()
        if (!project || project === this.#watching) return
        this.#watching = project
        project.engine.position.subscribe(v => {
            if (this.#host.project() === project) this.#pos = {ppqn: v.getValue(), at: performance.now()}
        })
        // Stopping the transport (space bar, the studio's stop button) ends the take.
        project.engine.isPlaying.subscribe(v => {
            if (!v.getValue() && this.#recording && this.#host.project() === project) this.#stopRecording()
        })
    }

    /** The engine position now: the last reported position moved on by the time since, wrapped in the loop. */
    #now(project: Project): number {
        const bpm = project.timelineBox.bpm.getValue()
        let p = this.#pos.ppqn + (performance.now() - this.#pos.at) / 60000 * bpm * Q
        const from = project.timelineBox.loopArea.from.getValue()
        const to = this.#loopEnd(project)
        if (project.timelineBox.loopArea.enabled.getValue() && to > from && p >= to) p = from + (p - from) % (to - from)
        return p
    }

    #loopEnd(project: Project): number {return project.timelineBox.loopArea.to.getValue()}

    #startRecording() {
        const project = this.#host.project()
        const t = this.#track()
        if (!project || !t) return this.#host.flash("Ask your AI for a song first, then play into it.")
        this.#watch()
        this.#recording = true
        this.#take = []
        this.#takeTrack = t.id
        this.#pos = {ppqn: project.engine.position.getValue(), at: performance.now()}
        if (!project.engine.isPlaying.getValue()) project.engine.play()
        this.#refresh()
    }

    #stopRecording() {
        const project = this.#host.project()
        this.#allOff()
        this.#recording = false
        const take = this.#take
        const trackId = this.#takeTrack
        this.#take = []
        this.#takeTrack = null
        if (project?.engine.isPlaying.getValue()) project.engine.stop()
        this.#refresh()
        if (!project || !trackId || take.length === 0) return
        const written = this.#write(project, trackId, take)
        if (written > 0) this.#host.flash(`Played in ${written} note${written === 1 ? "" : "s"}. Ctrl+Z takes them out.`)
    }

    /** Writes the take into the track's note regions in one undo step; the bridge then sends it as a version. */
    #write(project: Project, trackId: string, take: TakeNote[]): number {
        const song = this.#host.song()
        const m = this.#host.unitOf(trackId)
        const t = song?.tracks.find(x => x.id === trackId)
        if (!song || !m || !t) return 0
        const grid = Number(this.#grid.value)
        const songEnd = song.sections.reduce((n, s) => n + s.bars, 0) * BAR
        const notes = take
            .map(n => ({...n, ...quantise(n.start, n.end, grid, Q)}))
            .filter(n => n.start < songEnd)
        if (notes.length === 0) return 0
        const sectionAt = (p: number) => {
            let from = 0
            for (const s of song.sections) {
                const to = from + s.bars * BAR
                if (p >= from && p < to) return {section: s, from, to}
                from = to
            }
            return null
        }
        project.editing.modify(() => {
            const adapter = project.boxAdapters.adapterFor(m.track, TrackBoxAdapter)
            type Spot = { from: number, to: number, content: number, box: NoteRegionBox }
            const spots: Spot[] = adapter.regions.collection.asArray()
                .filter(r => r.isNoteRegion())
                .map(r => ({from: r.position, to: r.position + r.duration, content: r.position - r.loopOffset, box: r.box as NoteRegionBox}))
            if (this.#replace.value === "replace") {
                const first = Math.floor(Math.min(...notes.map(n => n.start)) / BAR) * BAR
                const last = Math.ceil(Math.max(...notes.map(n => n.start + n.duration)) / BAR) * BAR
                for (const r of adapter.regions.collection.asArray()) {
                    if (!r.isNoteRegion()) continue
                    const content = r.position - r.loopOffset
                    r.optCollection.ifSome(col => {
                        for (const ev of col.events.asArray()) {
                            const abs = content + ev.position
                            if (abs >= first && abs < last) ev.box.delete()
                        }
                    })
                }
            }
            for (const n of notes) {
                let spot = spots.find(s => n.start >= s.from && n.start < s.to)
                if (!spot) {
                    const at = sectionAt(n.start)
                    if (!at) continue
                    const box = project.api.createNoteRegion({trackBox: m.track, position: at.from, duration: at.to - at.from, name: at.section.name})
                    spot = {from: at.from, to: at.to, content: at.from, box}
                    spots.push(spot)
                }
                project.api.createNoteEvent({
                    owner: spot.box, position: Math.round(n.start - spot.content), duration: n.duration,
                    pitch: n.pitch, velocity: n.velocity / 127
                })
            }
        })
        this.#host.labelNextEdit(`played in ${notes.length} note${notes.length === 1 ? "" : "s"} on ${t.name}`)
        return notes.length
    }

    // ---------- panel ----------

    #refresh() {
        const song = this.#host.song()
        const t = this.#track()
        const tracks = song?.tracks ?? []
        const want = tracks.map(x => `${x.id}\u0000${x.name}`).join("\u0001")
        if (this.#trackSelect.dataset.list !== want) {
            this.#trackSelect.replaceChildren(...tracks.map(x => option(x.id, x.name)))
            this.#trackSelect.dataset.list = want
        }
        this.#trackSelect.value = t?.id ?? ""
        this.#trackSelect.disabled = this.#recording || tracks.length === 0
        const s = this.#scale()
        const drums = t?.role === "drums"
        this.#lockLabel.replaceChildren(this.#lock, drums ? "Drums: one drum per key" : `Lock to the song's key (${s.name})`)
        this.#lock.style.display = drums ? "none" : ""
        this.#octaveText.textContent = drums ? "–" : String(this.#octave)
        this.#record.disabled = !t
        this.#record.textContent = this.#recording
            ? `Stop and keep the take (${this.#take.length} note${this.#take.length === 1 ? "" : "s"})`
            : "Record a take"
        this.#record.style.background = this.#recording ? "#e5484d" : "#3a43d9"
        this.#record.style.opacity = t ? "1" : ".5"
        if (!t) this.#help.textContent = "Ask your AI for a song first; then pick a track here and play."
        else if (drums) this.#help.textContent = "Keys: " + DRUM_KEYS.map(([c, , n]) => `${keyCap(c)} ${n}`).join(", ")
            + ". A drum this kit does not have stays silent."
        else if (this.#lock.checked) {
            const from = letterPitch("KeyA", "locked", s, this.#octave)
            this.#help.textContent = `A S D F G H J K L play the scale up from ${from === null ? "the root" : noteName(from)}; Q W E R T… an octave higher. Z and X change octave. Every note fits the key.`
        } else this.#help.textContent = "A S D F G H J K play the white keys from C, W E T Y U the black keys. Z and X change octave."
    }
}

function el(tag: string, attrs: Record<string, string> = {}, text?: string): HTMLElement {
    const e = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
    if (text !== undefined) e.textContent = text
    return e
}

function option(value: string, text: string): HTMLOptionElement {
    const o = document.createElement("option")
    o.value = value
    o.textContent = text
    return o
}

function styled<T extends HTMLElement>(e: T): T {
    Object.assign(e.style, {
        flex: "1", minWidth: "0", padding: "4px 6px", borderRadius: "6px", border: "1px solid #3b3e48",
        background: "#24262e", color: "#f1f1f4", font: "500 12px/1.3 system-ui,sans-serif"
    })
    return e
}

function smallButton(text: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = el("button", {type: "button", title, "aria-label": title}, text) as HTMLButtonElement
    Object.assign(b.style, {
        width: "26px", height: "24px", borderRadius: "6px", border: "1px solid #3b3e48", background: "#24262e",
        color: "#f1f1f4", cursor: "pointer", font: "600 13px/1 system-ui,sans-serif"
    })
    b.onclick = onClick
    return b
}

/** The kit's pad for a GM drum: the device holds only the pads the song plays (the API picks layers and
 *  alternation for the song's notes), so a live hit takes the first pad for that drum, or none. */
const padFor = (kit: KitInstrument, gm: number): number | null =>
    isTexture(kit) ? kit.pads[0].note : kit.pads.find(p => p.gm === gm)?.note ?? null

const keyCap = (code: string): string => code === "Semicolon" ? ";" : code === "Quote" ? "'" : code.replace(/^Key/, "")
