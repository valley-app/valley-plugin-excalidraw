/**
 * Excalidraw — a real Excalidraw whiteboard that owns the `.excalidraw` file type
 * (standard Excalidraw JSON, portable with excalidraw.com). The host mounts
 * `ExcalidrawEditor` as a full workspace tab whenever a `.excalidraw` file opens
 * (manifest `fileViews`), passing the vault-relative `relPath`; the editor
 * reads/writes the file through `api.vault` and owns its debounced persistence.
 *
 * Note integration: a ```excalidraw``` code block embeds a drawing inside a
 * note (static SVG preview, click to open), and `[[wikilinks]]` on drawing elements
 * navigate to vault notes. The Excalidraw React library renders on its own bundled
 * React root inside `island.ts` (never the host instance).
 */
import type { ValleyPluginApi, ValleyPluginModule } from '@valley/plugin-sdk'
import { initRuntime } from './runtime'
import { injectStyles } from './styles'
import { registerDrawingSurfaces } from './surfaces'
import { registerExcalidrawCommands } from './commands'
import { registerExcalidrawFence } from './fence'
import { disposeExcalidrawStyles } from './island'
import ExcalidrawEditor from './ExcalidrawEditor'
import { initLocalization } from './localization'

export function register(api: ValleyPluginApi): () => void {
  initLocalization(api)
  initRuntime(api)
  const disposeStyles = injectStyles()

  // The host mounts this file view with a `relPath` prop (see TabView); cast
  // through the registry's propless `ComponentType` slot (same as Canvas).
  api.registerView('excalidraw.editor', ExcalidrawEditor as unknown as Parameters<typeof api.registerView>[1])
  const offCommands = registerExcalidrawCommands(api)
  const offSurfaces = registerDrawingSurfaces(api)
  const offFence = registerExcalidrawFence()

  return () => {
    offCommands()
    offSurfaces()
    offFence()
    disposeExcalidrawStyles()
    disposeStyles()
  }
}

const plugin: ValleyPluginModule = { register }
export default plugin
