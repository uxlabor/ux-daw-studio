// ux-daw bridge: connects this studio tab to the ux-daw API over a websocket.
// - Song JSON in: the AI-managed tracks are rebuilt to match, inside ONE editing.modify (one undo step).
// - Song JSON out: edits made here (volume, mute, pan, notes, tempo) are read back and sent as a new version.
// - Render: a bar range is rendered offline and uploaded as WAV for measurement and the in-chat player.
// Only the song schema crosses this boundary (ADR-0029). Nothing private lives in this file (ADR-0028).
import {DefaultObservableValue, isDefined, Option, UUID} from "@opendaw/lib-std"
import {Browser} from "@opendaw/lib-dom"
import {AudioData, PPQN, WavFile} from "@opendaw/lib-dsp"
import {AudioUnitBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {InstrumentFactories, TrackBoxAdapter} from "@opendaw/studio-adapters"
import {MixdownSection, OfflineEngineRenderer, Project} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {DRUMS, SOUNDS} from "./sounds"
import {BridgeBadge} from "./badge"
import {mountAbout} from "./about"
import {applyKey, applySwing, buildMaster, buildTrackChain, masterSignature, sectionFilterFrequency, trackSignature} from "./chain"
import {automationSignature, clearAutomation, type TrackAutomation, writeAutomation} from "./automation"
import {
    applyPadSlice, applySynth, attachProviders, type Instrument, isTexture, kitAttachment, kitGmOf, kitPadNote, padPan, registerAssets, soundfontBox
} from "./instruments"

type Note = [number, number, number, number]
type Song = {
    v: 0, title: string, bpm: number, key: string, time: "4/4", swing: number
    sections: Array<{ id: string, name: string, bars: number }>
    tracks: Array<{
        id: string, name: string, role: string, sound: string, swing?: number
        mix: { volume_db: number, pan: number, mute: boolean }
        effects: Array<{ type: string, amount: number }>
        clips: Array<{ section: string, notes: Note[] }>
    }>
    master: { limiter: boolean, target_lufs: number, tape?: number, dust?: number, grit?: number, level_db?: number }
}
type Managed = { unit: AudioUnitBox, track: TrackBox, sound: string, fx: string, auto: string }

const API: string = (import.meta as any).env?.VITE_UX_DAW_API ?? "https://daw-api.uxlabor.ee"
const SESSION_KEY = "ux-daw-session"
// A tab opened before a studio update asks for the old build's files, which are gone: it reloads itself.
const BUILD: string = import.meta.env.BUILD_UUID ?? ""
const SONG_KEY = "ux-daw-song"
const RELOADED_KEY = "ux-daw-reloaded-at"
const STUDIO_UPDATED = "studio_updated"
const BAR = PPQN.Bar
const Q = PPQN.Quarter

export class Bridge {
    readonly #service: StudioService
    readonly #badge = new BridgeBadge()
    #ws: WebSocket | null = null
    #session: string | null = null
    #retry = 0
    #project: Project | null = null
    #songId: string | null = null
    #version = 0
    #song: Song | null = null
    #managed = new Map<string, Managed>()
    #applying = false
    #editTimer: ReturnType<typeof setTimeout> | null = null
    #wantSong: string | null = null
    #masterSig: string | null = null
    #queue: Promise<void> = Promise.resolve()
    /** What each sound is made of, as the API sent it (patches, kits and trims are server data). */
    #instruments: Record<string, Instrument> = {}
    /** Per-section automation of the song being shown, worked out by the API (B5). */
    #automation: Record<string, TrackAutomation> = {}

    constructor(service: StudioService) {
        this.#service = service
        attachProviders(service)
    }

    #learn(instruments: Record<string, Instrument> | undefined) {
        if (!instruments) return
        registerAssets(instruments)
        this.#instruments = {...this.#instruments, ...instruments}
    }

    #instrument(sound: string): Instrument {return this.#instruments[sound] ?? {kind: "basic"}}

    async start() {
        try {localStorage.setItem("opendaw-suppress-unload-guard", "true")} catch {}
        const link = new URLSearchParams(location.hash.slice(1)).get("daw")
        if (link) {
            history.replaceState(null, "", location.pathname + location.search)
            try {
                const r = await fetch(`${API}/studio/session`, {
                    method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({link})
                })
                const body = await r.json()
                if (!r.ok) throw new Error(body?.message ?? body?.error ?? `HTTP ${r.status}`)
                sessionStorage.setItem(SESSION_KEY, body.session)
                this.#wantSong = body.song_id ?? null
            } catch (e) {
                this.#badge.set("error", `Link expired: ask your AI for a new studio link`)
                console.warn("[ux-daw] session", e)
            }
        }
        if (!this.#wantSong) this.#wantSong = sessionStorage.getItem(SONG_KEY)
        sessionStorage.removeItem(SONG_KEY)
        this.#session = sessionStorage.getItem(SESSION_KEY)
        if (!this.#session) {
            this.#badge.set("idle", "Not connected. Open the studio from your AI chat.")
            return
        }
        this.#connect()
    }

    #connect() {
        const url = new URL(API.replace(/^http/, "ws") + "/ws")
        url.searchParams.set("s", this.#session!)
        url.searchParams.set("tab", UUID.toString(UUID.generate()).slice(0, 8))
        this.#badge.set("busy", "Connecting…")
        const ws = new WebSocket(url)
        this.#ws = ws
        ws.onopen = () => {
            this.#retry = 0
            this.#badge.set("ok", "Connected to your AI")
            this.#send({t: "open", song_id: this.#wantSong ?? this.#songId})
        }
        // One message at a time: a render must not start while the song it renders is still loading.
        ws.onmessage = ev => {
            const m = JSON.parse(String(ev.data))
            this.#queue = this.#queue.then(() => this.#onMessage(m)).catch(e => {
                console.error("[ux-daw]", e)
                this.#badge.set("error", `Bridge error: ${(e as Error).message}`)
            })
        }
        ws.onclose = ev => {
            this.#ws = null
            if (ev.code === 1008 || ev.code === 4401) {
                this.#badge.set("error", "Session expired. Open the studio from your AI chat again.")
                return
            }
            const wait = Math.min(15000, 1000 * 2 ** this.#retry++)
            this.#badge.set("busy", `Reconnecting in ${Math.round(wait / 1000)} s…`)
            setTimeout(() => this.#connect(), wait)
        }
    }

    #send(msg: unknown) {if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(msg))}

    /** True when the served studio is a newer build than this tab (checked against /build-info.json). */
    async #outdated(): Promise<boolean> {
        if (!BUILD || Browser.isLocalHost()) return false
        try {
            const r = await fetch(`/build-info.json?v=${Date.now()}`, {cache: "no-store"})
            const info = await r.json()
            return typeof info?.uuid === "string" && info.uuid !== BUILD
        } catch {return false}
    }

    /** Reloads the tab onto the new build, keeping the song. At most once a minute, so a cache problem cannot loop. */
    #reloadForUpdate(songId: string | null, before?: () => Promise<unknown>): boolean {
        const last = Number(sessionStorage.getItem(RELOADED_KEY) ?? 0)
        if (Date.now() - last < 60_000) return false
        sessionStorage.setItem(RELOADED_KEY, String(Date.now()))
        const keep = songId ?? this.#songId
        if (keep) sessionStorage.setItem(SONG_KEY, keep)
        this.#badge.set("busy", "The studio was updated. Reloading…")
        void (before?.() ?? Promise.resolve()).catch(() => {}).finally(() => location.reload())
        return true
    }

    async #onMessage(m: any) {
        switch (m.t) {
            case "song":
                if (await this.#outdated() && this.#reloadForUpdate(m.song_id)) return
                this.#learn(m.instruments)
                this.#automation = m.automation ?? {}
                return this.#loadSong(m.song_id, m.version, m.song, m.reason)
            case "render":
                return this.#render(m)
            case "edited_ack":
                if (m.ok) this.#version = m.version
                else if (m.reason === "stale" && m.song) {
                    this.#badge.flash("Your AI changed the song at the same time; showing its version")
                    this.#learn(m.instruments)
                    this.#automation = m.automation ?? {}
                    await this.#loadSong(m.song_id, m.version, m.song, "ai")
                }
                return
            case "empty":
                this.#badge.set("ok", "Connected. Ask your AI to make a song.")
                return
            case "error":
                console.warn("[ux-daw] server:", m.message)
                return
        }
    }

    // ---------- song -> project ----------

    async #loadSong(songId: string, version: number, song: Song, reason: string) {
        if (songId !== this.#songId || !this.#project || !this.#project.rootBox.isAttached()) {
            const project = Project.new(this.#service)
            this.#service.projectProfileService.setProject(project, song.title || "Untitled")
            this.#project = project
            this.#managed.clear()
            this.#masterSig = null
            this.#songId = songId
            project.boxGraph.subscribeTransaction({
                onBeginTransaction: () => {},
                onEndTransaction: (rolledBack: boolean) => {if (!rolledBack && !this.#applying) this.#scheduleReadback()}
            })
            this.#apply(song, false)
        } else {
            this.#apply(song, true)
        }
        this.#version = version
        this.#song = song
        this.#badge.set("ok", reason === "ai" ? `Updated by your AI · ${song.title}` : `Connected · ${song.title}`)
        if (reason === "ai") this.#badge.flash("Your AI changed the song. Ctrl+Z undoes it.")
    }

    /** Makes the project match the song. `undoable`: one undo step (AI edits); the first load is not. */
    #apply(song: Song, undoable: boolean) {
        const project = this.#project!
        this.#applying = true
        try {
            project.editing.modify(() => this.#reconcile(project, song), undoable)
        } finally {
            this.#applying = false
        }
    }

    #reconcile(project: Project, song: Song) {
        const {api} = project
        api.setBpm(song.bpm)
        const starts = new Map<string, number>()
        let bar = 0
        for (const s of song.sections) {
            starts.set(s.id, bar)
            bar += s.bars
        }
        // Remove tracks the song no longer has, or whose sound changed.
        for (const [id, m] of [...this.#managed]) {
            const t = song.tracks.find(x => x.id === id)
            if (!t || t.sound !== m.sound || !m.unit.isAttached()) {
                if (m.unit.isAttached()) api.deleteAudioUnit(m.unit)
                this.#managed.delete(id)
            }
        }
        song.tracks.forEach((t, index) => {
            let m = this.#managed.get(t.id)
            if (!m) {
                const inst = this.#instrument(t.sound)
                const basic = SOUNDS[t.sound] ?? SOUNDS["pad/warm"]
                const factoryName = inst.kind === "synth" ? "Vaporisateur" : inst.kind === "sampled" ? "Soundfont"
                    : inst.kind === "kit" ? "Playfield" : basic.factory
                const factory = InstrumentFactories.Named[factoryName] as any
                const attachment = inst.kind === "kit" ? kitAttachment(inst)
                    : inst.kind === "sampled" ? soundfontBox(project, inst.file)
                    : basic.drums && inst.kind === "basic"
                        ? DRUMS.map(d => ({note: d.note, uuid: UUID.parse(d.uuid), name: d.name, durationInSeconds: d.seconds, exclude: d.name === "hat" || d.name === "openhat"}))
                        : undefined
                const product = api.createInstrument(factory, {name: t.name, index, ...(attachment ? {attachment} : {})} as any)
                const pads = () => [...(product.instrumentBox as any).samples.pointerHub.incoming()].map(({box}: any) => box)
                // A texture loops while its note is held (Playfield gate mode 2 = Loop).
                if (inst.kind === "kit" && isTexture(inst)) for (const box of pads()) box.gate.setValue(2)
                if (inst.kind === "kit") for (const box of pads()) {
                    const pan = padPan(inst, box.index.getValue())
                    if (pan !== undefined) box.panning.setValue(pan)
                    applyPadSlice(inst, box)
                }
                if (inst.kind === "basic" && inst.pan && basic.drums) for (const box of pads()) {
                    const pan = inst.pan[String(box.index.getValue())]
                    if (pan !== undefined) box.panning.setValue(pan)
                }
                if (inst.kind === "synth") applySynth(product.instrumentBox, inst)
                m = {unit: product.audioUnitBox, track: product.trackBox, sound: t.sound, fx: "", auto: ""}
                this.#managed.set(t.id, m)
            }
            m.unit.volume.setValue(t.mix.volume_db)
            m.unit.panning.setValue(t.mix.pan)
            m.unit.mute.setValue(t.mix.mute)
            // Notes: replace every region on this track with one region per section that has notes.
            const adapter = project.boxAdapters.adapterFor(m.track, TrackBoxAdapter)
            for (const region of adapter.regions.collection.asArray()) region.box.delete()
            const inst = this.#instrument(t.sound)
            const rr = new Map<string, number>() // hat and shaker alternation runs across the whole track
            for (const clip of t.clips) {
                const section = song.sections.find(s => s.id === clip.section)
                if (!section || clip.notes.length === 0) continue
                const position = starts.get(section.id)! * BAR
                const region: NoteRegionBox = api.createNoteRegion({trackBox: m.track, position, duration: section.bars * BAR, name: section.name})
                for (const [beat, pitch, len, vel] of clip.notes) {
                    const p = inst.kind === "kit" ? kitPadNote(inst, pitch, vel, rr) : pitch
                    if (p === null) continue
                    api.createNoteEvent({owner: region, position: Math.round(beat * Q), duration: Math.max(1, Math.round(len * Q)), pitch: p, velocity: vel / 127})
                }
            }
        })
        // Sound: track chains (duck keys on the drums), master chain, key, swing.
        const drums = song.tracks.find(t => t.role === "drums" && !t.mix.mute)
        const duckSource = drums ? this.#managed.get(drums.id)?.unit ?? null : null
        for (const t of song.tracks) {
            const m = this.#managed.get(t.id)!
            const inst = this.#instrument(t.sound)
            const trim = inst.kind === "synth" || inst.kind === "sampled" ? inst.trim_db : 0
            const auto = this.#automation[t.id]
            const ctx = {duckSource, trim, sectionFilter: !!auto?.lowpass}
            const sig = trackSignature(t.effects, ctx)
            const autoSig = automationSignature(auto) + `|${bar}`
            if (m.fx !== sig) {
                // Our lanes point at devices in the chain: they go before it is rebuilt.
                clearAutomation(project, m.unit)
                buildTrackChain(project, m.unit, t.effects, ctx)
                m.fx = sig
                m.auto = ""
            }
            if (m.auto !== autoSig) {
                writeAutomation(project, m.unit, auto, sectionFilterFrequency(m.unit), bar)
                m.auto = autoSig
            }
        }
        const ms = masterSignature(song.master)
        if (this.#masterSig !== ms) {
            buildMaster(project, song.master)
            this.#masterSig = ms
        }
        applyKey(project, song.key)
        applySwing(project, song.tracks.flatMap(t => {
            const m = this.#managed.get(t.id)
            return m ? [{unit: m.unit, swing: t.swing}] : []
        }), song.swing)
        // Loop the whole song in the transport.
        const tb = project.timelineBox
        tb.loopArea.from.setValue(0)
        tb.loopArea.to.setValue(bar * BAR)
        tb.durationInPulses?.setValue?.(bar * BAR)
    }

    // ---------- project -> song (studio edits) ----------

    #scheduleReadback() {
        if (this.#editTimer) clearTimeout(this.#editTimer)
        this.#editTimer = setTimeout(() => this.#readback(), 1200)
    }

    #readback() {
        const project = this.#project
        const prev = this.#song
        if (!project || !prev || !this.#songId) return
        const song: Song = structuredClone(prev)
        song.bpm = Math.round(project.timelineBox.bpm.getValue() * 100) / 100
        const starts: Array<{ id: string, from: number, to: number }> = []
        let bar = 0
        for (const s of song.sections) {
            starts.push({id: s.id, from: bar * 4, to: (bar + s.bars) * 4})
            bar += s.bars
        }
        song.tracks = song.tracks.filter(t => {
            const m = this.#managed.get(t.id)
            return isDefined(m) && m.unit.isAttached()
        })
        for (const t of song.tracks) {
            const m = this.#managed.get(t.id)!
            const inst = this.#instrument(t.sound)
            t.mix = {
                volume_db: Math.round(m.unit.volume.getValue() * 10) / 10,
                pan: Math.round(m.unit.panning.getValue() * 100) / 100,
                mute: m.unit.mute.getValue()
            }
            const bySection = new Map<string, Note[]>()
            const adapter = project.boxAdapters.adapterFor(m.track, TrackBoxAdapter)
            for (const region of adapter.regions.collection.asArray()) {
                if (!region.isNoteRegion()) continue
                const content = region.position - region.loopOffset
                region.optCollection.ifSome(col => {
                    for (const ev of col.events.asArray()) {
                        const absBeat = (content + ev.position) / Q
                        if (ev.position < region.loopOffset || ev.position >= region.loopOffset + region.duration) continue
                        const sec = starts.find(s => absBeat >= s.from && absBeat < s.to)
                        if (!sec) continue
                        const list = bySection.get(sec.id) ?? []
                        const pitch = inst.kind === "kit" ? kitGmOf(inst, ev.pitch) : ev.pitch
                        if (pitch === null) continue
                        list.push([Math.round((absBeat - sec.from) * 1000) / 1000, pitch, Math.round(ev.duration / Q * 1000) / 1000,
                            Math.max(1, Math.min(127, Math.round(ev.velocity * 127)))])
                        bySection.set(sec.id, list)
                    }
                })
            }
            t.clips = [...bySection].map(([section, notes]) => ({section, notes: notes.sort((a, b) => a[0] - b[0] || a[1] - b[1])}))
        }
        if (JSON.stringify(song) === JSON.stringify(prev)) return
        this.#song = song
        this.#send({t: "edited", song_id: this.#songId, base_version: this.#version, song})
        this.#badge.flash("Saved your edit. Your AI will see it.")
    }

    // ---------- render ----------

    async #render(m: { req: string, song_id: string, from_bar: number, bars: number }) {
        const fail = (why: string) => fetch(`${API}/studio/clip?req=${m.req}&error=${encodeURIComponent(why)}`, {
            method: "POST", headers: {authorization: `Bearer ${this.#session}`}
        })
        // tell the API first (it waits for the reloaded tab and asks again), then reload
        if (await this.#outdated() && this.#reloadForUpdate(m.song_id, () => fail(STUDIO_UPDATED))) return
        if (!this.#project || m.song_id !== this.#songId) return void fail("the studio shows another song")
        this.#badge.set("busy", `Rendering bars ${m.from_bar}–${m.from_bar + m.bars - 1}…`)
        try {
            const start = (m.from_bar - 1) * BAR
            const section: MixdownSection = {type: "loop", key: "ux-daw", label: "ux-daw", start, end: start + m.bars * BAR, passes: 1, tail: false} as MixdownSection
            const audio = await OfflineEngineRenderer.renderSection(this.#project.copy(), Option.None, section,
                new DefaultObservableValue(0), new AbortController().signal, 48000)
            const seconds = audio.numberOfFrames / audio.sampleRate
            const wav = WavFile.encodeInts16(seconds > 40 ? halfRate(audio) : audio)
            const r = await fetch(`${API}/studio/clip?req=${m.req}`, {
                method: "POST", headers: {authorization: `Bearer ${this.#session}`, "content-type": "audio/wav"}, body: wav
            })
            if (!r.ok) throw new Error(`upload failed (${r.status})`)
            this.#badge.set("ok", `Rendered · ${this.#song?.title ?? ""}`)
        } catch (e) {
            console.error("[ux-daw] render", e)
            this.#badge.set("error", `Render failed: ${(e as Error).message}`)
            await fail((e as Error).message || "render failed")
        }
    }
}

/** 2:1 decimation with averaging, for long clips (keeps the upload under the size cap). */
function halfRate(a: AudioData): AudioData {
    const n = Math.floor(a.numberOfFrames / 2)
    const out = AudioData.create(a.sampleRate / 2, n, a.numberOfChannels)
    a.frames.forEach((ch, c) => {
        const dst = out.frames[c]
        for (let i = 0; i < n; i++) dst[i] = (ch[2 * i] + ch[2 * i + 1]) / 2
    })
    return out
}

export const installBridge = (service: StudioService) => {
    const bridge = new Bridge(service);
    (window as any).uxDawBridge = bridge
    mountAbout(API)
    bridge.start().catch(e => console.error("[ux-daw] start", e))
}

