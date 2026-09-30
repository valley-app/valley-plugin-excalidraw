import { api } from './runtime'
import excalidrawCss from '@excalidraw/excalidraw/index.css'
import type { ValleyPluginApi } from '@valley/plugin-sdk'
import type { EditorHandle, MountOptions, RawScene } from './islandRuntime'
export type { EditorHandle, MountOptions, RawScene } from './islandRuntime'

type Island = Pick<typeof import('./islandRuntime'), 'configureAssets' | 'mountEditor' | 'renderPreviewSvg' | 'decodeDrawingSvg' | 'encodeDrawingSvg'>
const islands = new WeakMap<Document, WeakMap<ValleyPluginApi, Promise<Island>>>()

function loadIsland(document: Document, sessionApi = api): Promise<Island> {
  const sessions = islands.get(document) ?? new WeakMap<ValleyPluginApi, Promise<Island>>()
  islands.set(document, sessions)
  const existing = sessions.get(sessionApi)
  if (existing) return existing
  const assetBase = sessionApi.assets.url('')
  const pending = new Promise<Island>((resolve, reject) => {
    const script = document.createElement('script')
    script.type = 'module'
    script.src = sessionApi.assets.url('island.js')
    script.onload = () => {
      const island = (document.defaultView as unknown as { valleyExcalidrawIsland?: Island })?.valleyExcalidrawIsland
      if (!island) { sessions.delete(sessionApi); script.remove(); reject(new Error('Drawing runtime did not initialize')); return }
      island.configureAssets(assetBase)
      script.remove()
      resolve(island)
    }
    script.onerror = () => { sessions.delete(sessionApi); script.remove(); reject(new Error('Unable to load drawing runtime')) }
    document.head.appendChild(script)
  })
  sessions.set(sessionApi, pending)
  return pending
}

export function ensureExcalidrawStyles(): void {
  const id = 'excalidraw-lib-styles'
  if (document.getElementById(id)) return
  const style = document.createElement('style')
  style.id = id
  style.textContent = excalidrawCss.replace(/url\((["']?)\.\/(fonts\/[^"')]+)\1\)/g,
    (_match, _quote, relativePath) => `url(${JSON.stringify(api.assets.url(relativePath))})`)
  document.head.appendChild(style)
}

export function disposeExcalidrawStyles(): void { document.getElementById('excalidraw-lib-styles')?.remove() }

export async function mountEditor(host: HTMLElement, options: MountOptions): Promise<EditorHandle> {
  ensureExcalidrawStyles()
  const island = await loadIsland(host.ownerDocument)
  const handle = await island.mountEditor(host, { ...options, language: api.ui.language() })
  let disposed = false
  const updateLanguage = () => { if (!disposed) handle.setLanguage(api.ui.language()) }
  const unsubscribe = api.ui.onLanguageChanged(updateLanguage)
  updateLanguage()
  return {
    ...handle,
    unmount() {
      if (disposed) return
      disposed = true
      unsubscribe()
      handle.unmount()
    }
  }
}

export async function renderPreviewSvg(scene: RawScene, darkMode = false, owner = document, active = () => true, sessionApi = api): Promise<SVGSVGElement | null> {
  if (!active()) throw new Error('Drawing preview is no longer active')
  const island = await loadIsland(owner, sessionApi)
  if (!active()) throw new Error('Drawing preview is no longer active')
  return island.renderPreviewSvg(scene, darkMode, active)
}

export async function decodeDrawingSvg(content: string, owner = document, sessionApi = api): Promise<RawScene> {
  return (await loadIsland(owner, sessionApi)).decodeDrawingSvg(content)
}

export async function encodeDrawingSvg(scene: RawScene, owner = document, sessionApi = api): Promise<string> {
  return (await loadIsland(owner, sessionApi)).encodeDrawingSvg(scene)
}
