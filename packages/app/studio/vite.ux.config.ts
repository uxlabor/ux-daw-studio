// ux-daw build: upstream openDAW's own vite config plus one plugin that starts our bridge. No openDAW source
// file is edited (rule R1): the plugin adds the bridge call to boot.ts while building, right after the
// studio's shortcuts are installed. If upstream moves that line, the build fails here instead of shipping a
// studio without the bridge. Used by .github/workflows/ux-build.yml and for local dev:
//   npx vite build -c vite.ux.config.ts      npx vite -c vite.ux.config.ts
import {type ConfigEnv, defineConfig, mergeConfig, type Plugin, type UserConfig} from "vite"
import upstream from "./vite.config"

const ANCHOR = "StudioShortcutManager.install(service)"

const uxBridge: Plugin = {
    name: "ux-bridge",
    enforce: "pre",
    transform(code, id) {
        if (!id.replace(/\\/g, "/").endsWith("/src/boot.ts")) return null
        if (!code.includes(ANCHOR)) this.error(`ux-bridge: "${ANCHOR}" is no longer in boot.ts; update vite.ux.config.ts`)
        return {
            code: `import {installBridge as __uxInstallBridge} from "@/ux/bridge"\n`
                + code.replace(ANCHOR, `${ANCHOR}; __uxInstallBridge(service)`),
            map: null
        }
    }
}

export default defineConfig(async (env: ConfigEnv) => {
    const base = (typeof upstream === "function" ? await (upstream as (e: ConfigEnv) => UserConfig | Promise<UserConfig>)(env) : upstream) as UserConfig
    return mergeConfig(base, {plugins: [uxBridge]})
})
