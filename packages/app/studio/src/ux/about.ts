// "About this studio": openDAW credit, licence notice, a statement that this is a modified setup, and a link
// to the source (AGPL-3.0 section 13: users of a modified version over a network get its source). Plain DOM,
// mounted beside the bridge badge; no openDAW file is touched.
const SOURCE = "https://github.com/uxlabor/ux-daw-studio"

const TEXT = (api: string) => `
<h2 style="margin:0 0 12px;font:600 18px/1.3 system-ui,sans-serif">About this studio</h2>
<p>This is <strong>ux-daw studio</strong>, a modified setup of <a href="https://opendaw.studio" target="_blank" rel="noopener">openDAW</a>
by André Michelle and contributors.</p>
<p>openDAW is free software under the <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener">GNU Affero General Public License, version 3 or later</a>.
This modified version is under the same licence and comes with no warranty, to the extent permitted by law.</p>
<p>What we changed: a bridge that connects the studio to your AI, sound settings sent by our server, and a master chain.
All of it lives in its own folder and our build adds it; no openDAW file is edited.</p>
<p>Source code of exactly this studio, including our changes: <a href="${SOURCE}" target="_blank" rel="noopener">${SOURCE}</a>.</p>
<p>Sounds and grooves come from free sources: <a href="${api}/credits" target="_blank" rel="noopener">credits</a>.</p>
`

export function mountAbout(api: string) {
    const button = document.createElement("button")
    button.type = "button"
    button.textContent = "About"
    button.setAttribute("aria-haspopup", "dialog")
    Object.assign(button.style, {
        position: "fixed", left: "12px", bottom: "12px", zIndex: "100000", padding: "6px 12px", borderRadius: "999px",
        border: "0", background: "rgba(20,21,26,.92)", color: "#f1f1f4", font: "500 12px/1.3 system-ui,sans-serif",
        cursor: "pointer", boxShadow: "0 2px 10px rgba(0,0,0,.35)"
    })
    const dialog = document.createElement("dialog")
    dialog.setAttribute("aria-label", "About this studio")
    Object.assign(dialog.style, {
        maxWidth: "min(520px, calc(100vw - 32px))", padding: "20px 24px", borderRadius: "12px", border: "0",
        background: "#1b1c22", color: "#e8e8ee", font: "400 14px/1.5 system-ui,sans-serif"
    })
    dialog.innerHTML = TEXT(api)
    for (const a of dialog.querySelectorAll("a")) a.style.color = "#9fa6ff"
    const close = document.createElement("button")
    close.type = "button"
    close.textContent = "Close"
    Object.assign(close.style, {marginTop: "8px", padding: "6px 14px", borderRadius: "8px", border: "0", background: "#3a43d9", color: "#fff", cursor: "pointer"})
    close.onclick = () => dialog.close()
    dialog.append(close)
    dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close() })
    button.onclick = () => dialog.showModal()
    const mount = () => document.body.append(button, dialog)
    if (document.body) mount()
    else addEventListener("DOMContentLoaded", mount)
}
