// A small status pill in the corner: is this tab connected to the user's AI, and what just happened.
type State = "idle" | "busy" | "ok" | "error"

const COLORS: Record<State, string> = {idle: "#8a8f99", busy: "#e0a800", ok: "#2fb36d", error: "#e5484d"}

export class BridgeBadge {
    readonly #el: HTMLDivElement
    readonly #dot: HTMLSpanElement
    readonly #text: HTMLSpanElement
    readonly #flash: HTMLDivElement
    #flashTimer: ReturnType<typeof setTimeout> | null = null

    constructor() {
        this.#el = document.createElement("div")
        this.#el.setAttribute("role", "status")
        this.#el.setAttribute("aria-live", "polite")
        Object.assign(this.#el.style, {
            position: "fixed", right: "12px", bottom: "12px", zIndex: "100000", display: "flex", alignItems: "center", gap: "8px",
            padding: "6px 12px", borderRadius: "999px", background: "rgba(20,21,26,.92)", color: "#f1f1f4",
            font: "500 12px/1.3 system-ui,sans-serif", boxShadow: "0 2px 10px rgba(0,0,0,.35)", maxWidth: "70vw", pointerEvents: "none"
        })
        this.#dot = document.createElement("span")
        Object.assign(this.#dot.style, {width: "8px", height: "8px", borderRadius: "50%", flex: "none"})
        this.#text = document.createElement("span")
        this.#el.append(this.#dot, this.#text)
        this.#flash = document.createElement("div")
        Object.assign(this.#flash.style, {
            position: "fixed", right: "12px", bottom: "48px", zIndex: "100000", padding: "8px 14px", borderRadius: "10px",
            background: "#3a43d9", color: "#fff", font: "600 13px/1.3 system-ui,sans-serif", display: "none", pointerEvents: "none"
        })
        const mount = () => document.body.append(this.#el, this.#flash)
        if (document.body) mount()
        else addEventListener("DOMContentLoaded", mount)
        this.set("idle", "ux-daw")
    }

    set(state: State, text: string) {
        this.#dot.style.background = COLORS[state]
        this.#text.textContent = text
    }

    flash(text: string) {
        this.#flash.textContent = text
        this.#flash.style.display = "block"
        if (this.#flashTimer) clearTimeout(this.#flashTimer)
        this.#flashTimer = setTimeout(() => (this.#flash.style.display = "none"), 4000)
    }
}
