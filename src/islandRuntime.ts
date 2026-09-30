import type { ComponentProps } from 'react'
import { configureFontAssets } from './fontAssets'
let assetBase = ''
export function configureAssets(value: string): void { assetBase = value; configureFontAssets(value) }
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import excalidrawCss from '@excalidraw/excalidraw/index.css'
import { createSceneSerialization, type RawScene } from './sceneSerialization'
export type { RawScene } from './sceneSerialization'

// `typeof import(...)` is a pure type query (erased at runtime), so these types
// cost nothing — the library JS only evaluates when `loadLib()` first runs.
type ExcalidrawModule = typeof import('@excalidraw/excalidraw')
type ExcalidrawProps = ComponentProps<ExcalidrawModule['Excalidraw']>
type ImperativeApi = Parameters<NonNullable<ExcalidrawProps['excalidrawAPI']>>[0]

let libPromise: Promise<ExcalidrawModule> | null = null
function loadLib(): Promise<ExcalidrawModule> {
  return (libPromise ??= import('@excalidraw/excalidraw'))
}

export interface EditorHandle {
  /** Serialize the live scene to canonical `.excalidraw` JSON (stable across pan/zoom). */
  serialize(): string
  /** Replace the on-canvas scene (used for external-change reloads). */
  updateScene(scene: RawScene, capture?: boolean): void
  getView(): { selectedIds: string[]; scrollX: number; scrollY: number; zoom: number; readOnly: boolean }
  restoreView(view: { selectedIds?: string[]; scrollX?: number; scrollY?: number; zoom?: number; readOnly?: boolean }): void
  setLanguage(language: string): void
  /** Tear the island down (unmounts its React root). */
  unmount(): void
}

export interface MountOptions {
  initialData: RawScene
  language?: string
  /** Fired on every Excalidraw edit; the caller debounces + pulls `serialize()`. */
  onChange(): void
  /** A hyperlink on an element was activated; `href` is its raw link string. */
  onLinkOpen(href: string, preventDefault: () => void): void
}

/** Configure the read-only app-asset origin that serves Excalidraw's bundled fonts. */
function ensureAssetPath(): void {
  const w = window as unknown as { EXCALIDRAW_ASSET_PATH?: string }
  w.EXCALIDRAW_ASSET_PATH = assetBase
}

let stylesInjected = false
/** Inject the library's own stylesheet once (esbuild inlines it as text). */
export function ensureExcalidrawStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const id = 'excalidraw-lib-styles'
  if (document.getElementById(id)) return
  const el = document.createElement('style')
  el.id = id
  el.textContent = excalidrawCss.replace(
    /url\((["']?)\.\/(fonts\/[^"')]+)\1\)/g,
    (_match, _quote, relativePath) => `url(${JSON.stringify(`${assetBase}${relativePath}`)})`
  )
  document.head.appendChild(el)
}

export function disposeExcalidrawStyles(): void {
  document.getElementById('excalidraw-lib-styles')?.remove()
  stylesInjected = false
}

/** Mount a full, editable Excalidraw canvas into `host`, on its own React root. */
export async function mountEditor(host: HTMLElement, opts: MountOptions): Promise<EditorHandle> {
  ensureAssetPath()
  ensureExcalidrawStyles()
  const { Excalidraw, serializeAsJSON, restoreElements, CaptureUpdateAction } = await loadLib()

  let imp: ImperativeApi | null = null
  let disposed = false
  const serialization = createSceneSerialization(
    () => ({ elements: imp!.getSceneElements(), appState: imp!.getAppState() as unknown as Record<string, unknown>, files: imp!.getFiles() }),
    ({ elements, appState, files }) => serializeAsJSON(elements as Parameters<typeof serializeAsJSON>[0], appState, files as Parameters<typeof serializeAsJSON>[2], 'local')
  )
  const languageCodes: Record<string, string> = { en: 'en', de: 'de-DE', es: 'es-ES', fr: 'fr-FR', 'zh-CN': 'zh-CN' }
  let langCode = languageCodes[opts.language ?? 'en'] ?? 'en'
  const root: Root = createRoot(host)
  const mac = /Mac|iPhone|iPad/.test(host.ownerDocument.defaultView?.navigator.platform ?? '')
  const labelControls = () => {
    for (const [action, shortcut, keys] of mac
      ? [['undo', '⌘Z', 'Meta+Z'], ['redo', '⇧⌘Z', 'Meta+Shift+Z']]
      : [['undo', 'Ctrl+Z', 'Control+Z'], ['redo', 'Ctrl+Shift+Z', 'Control+Shift+Z']]) {
      const button = host.querySelector<HTMLButtonElement>(`[data-testid="button-${action}"]`)
      if (!button) continue
      button.dataset.drawingTooltip = `${button.getAttribute('aria-label') ?? action} (${shortcut})`
      button.setAttribute('aria-keyshortcuts', keys)
    }
    for (const control of host.querySelectorAll<HTMLElement>('.mobile-misc-tools-container [title]')) {
      control.dataset.drawingTooltip = control.title
      control.removeAttribute('title')
    }
  }
  const historyObserver = new MutationObserver(labelControls)
  historyObserver.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'title'] })
  let pendingView: Parameters<EditorHandle['restoreView']>[0] | null = null
  const restoreView: EditorHandle['restoreView'] = (view) => {
    if (disposed) return
    if (!imp) { pendingView = { ...pendingView, ...view }; return }
    imp.updateScene({ appState: { ...(view.selectedIds ? { selectedElementIds: Object.fromEntries(view.selectedIds.map((id) => [id, true])) } : {}), ...(view.scrollX !== undefined ? { scrollX: view.scrollX } : {}), ...(view.scrollY !== undefined ? { scrollY: view.scrollY } : {}), ...(view.zoom !== undefined ? { zoom: { value: view.zoom } } : {}), ...(view.readOnly !== undefined ? { viewModeEnabled: view.readOnly } : {}) }, captureUpdate: CaptureUpdateAction.NEVER } as Parameters<ImperativeApi['updateScene']>[0])
  }

  const props: ExcalidrawProps = {
    initialData: opts.initialData as ExcalidrawProps['initialData'],
    handleKeyboardGlobally: true,
    excalidrawAPI: (a: ImperativeApi) => {
      if (disposed) return
      imp = a
      if (pendingView) { restoreView(pendingView); pendingView = null }
      opts.onChange()
    },
    onChange: (elements, appState, files) => {
      if (disposed) return
      serialization.observe({ elements, appState: appState as unknown as Record<string, unknown>, files })
      opts.onChange()
    },
    onLinkOpen: (element, event) => {
      if (disposed) return
      const href = (element as { link?: string | null }).link ?? ''
      opts.onLinkOpen(href, () => event.preventDefault())
    }
  }
  const render = () => root.render(createElement(Excalidraw, { ...props, langCode }))
  render()

  return {
    serialize(): string {
      if (!imp) return ''
      return serialization.serialize()
    },
    updateScene(scene: RawScene, capture = false): void {
      serialization.invalidate()
      if (scene.files && imp) imp.addFiles(Object.values(scene.files) as Parameters<ImperativeApi['addFiles']>[0])
      imp?.updateScene({
        ...(scene.elements ? { elements: restoreElements(scene.elements as Parameters<typeof restoreElements>[0], null, { repairBindings: true }) } : {}),
        appState: scene.appState,
        captureUpdate: capture ? CaptureUpdateAction.IMMEDIATELY : CaptureUpdateAction.NEVER
      } as Parameters<ImperativeApi['updateScene']>[0])
    },
    getView() {
      const state = imp?.getAppState()
      return { selectedIds: Object.keys(state?.selectedElementIds ?? {}).filter((id) => state?.selectedElementIds[id]), scrollX: state?.scrollX ?? 0, scrollY: state?.scrollY ?? 0, zoom: state?.zoom.value ?? 1, readOnly: state?.viewModeEnabled ?? false }
    },
    restoreView,
    setLanguage(language): void {
      const next = languageCodes[language] ?? 'en'
      if (disposed || next === langCode) return
      langCode = next
      render()
    },
    unmount(): void {
      if (disposed) return
      disposed = true
      historyObserver.disconnect()
      serialization.dispose()
      // Defer: React forbids unmounting a root while it is rendering.
      const r = root
      setTimeout(() => r.unmount(), 0)
      imp = null
    }
  }
}

/**
 * Render a scene to a static, read-only SVG (for the ```excalidraw``` embed) — no
 * React root, so note embeds stay cheap. Returns null on an empty/invalid scene.
 */
export async function renderPreviewSvg(scene: RawScene, darkMode = false, active = () => true): Promise<SVGSVGElement | null> {
  ensureAssetPath()
  const elements = scene.elements ?? []
  if (!Array.isArray(elements) || elements.length === 0) return null
  const { exportToSvg } = await loadLib()
  if (!active()) throw new Error('Drawing preview is no longer active')
  const svg = await exportToSvg({
    elements,
    appState: { ...(scene.appState ?? {}), exportBackground: false, exportWithDarkMode: darkMode },
    files: scene.files ?? null
  } as Parameters<typeof exportToSvg>[0])
  return svg
}

export async function decodeDrawingSvg(content: string): Promise<RawScene> {
  ensureAssetPath()
  const xml = new DOMParser().parseFromString(content, 'image/svg+xml')
  if (xml.querySelector('parsererror') || xml.documentElement.localName !== 'svg') throw new Error('Invalid drawing SVG')
  const { loadFromBlob, serializeAsJSON } = await loadLib()
  const scene = await loadFromBlob(new Blob([content], { type: 'image/svg+xml' }), null, null)
  return JSON.parse(serializeAsJSON(scene.elements, scene.appState, scene.files ?? {}, 'local')) as RawScene
}

export async function encodeDrawingSvg(scene: RawScene): Promise<string> {
  ensureAssetPath()
  const { exportToSvg } = await loadLib()
  const svg = await exportToSvg({
    elements: scene.elements ?? [],
    appState: { ...scene.appState, exportEmbedScene: true, exportWithDarkMode: false },
    files: scene.files ?? {}
  } as Parameters<typeof exportToSvg>[0])
  const content = svg.outerHTML
  await decodeDrawingSvg(content)
  return content
}

Object.assign(window, { valleyExcalidrawIsland: { configureAssets, mountEditor, renderPreviewSvg, decodeDrawingSvg, encodeDrawingSvg, ensureExcalidrawStyles, disposeExcalidrawStyles } })
