import type { ComponentProps } from 'react'
import { configureFontAssets } from './fontAssets'
let assetBase = ''
export function configureAssets(value: string): void { assetBase = value; configureFontAssets(value) }
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { NativeBridge, NativeRequest } from './nativeBridge'
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
  controls?(): DrawingControls
  nativeAction?(name: string, value: unknown, beforePerform: () => void, beforeApply: () => void, beforeEffect?: () => Promise<void>): Promise<void>
  tool?(type: string, beforeEffect?: () => Promise<void>): void | Promise<void>
  pen?(enabled: boolean): void
  toolLock?(): void
  library?(): Promise<readonly unknown[]>
  updateLibrary?(items: unknown[], merge: boolean): Promise<void>
  sidebar?(open: boolean): void
  nativeControl?(form: string, action: string, value: unknown, beforeEffect: () => Promise<void>): Promise<void>
  nativeEdit?(action: string, value: Record<string, unknown>, beforeEffect: () => Promise<void>): Promise<void>
  /** Tear the island down (unmounts its React root). */
  unmount(): void
}

export interface DrawingControls {
  revision: string
  activeTool: string
  toolLocked: boolean
  penMode: boolean
  openMenu: string | null
  dialog: { name: string; tab: string | null } | null
  sidebar: { name: string; tab: string | null } | null
  history: { undo: boolean; redo: boolean }
  actions: { name: string; enabled: boolean; viewMode: boolean }[]
  values: Record<string, string | number | boolean | null>
  receipt: ReturnType<NativeBridge['receipt']>
  forms: Record<string, { revision: string; value: Record<string, unknown> }>
}

export interface MountOptions {
  initialData: RawScene
  language?: string
  /** Fired on every Excalidraw edit; the caller debounces + pulls `serialize()`. */
  onChange(): void
  onNativeRequest?(request: NativeRequest): Promise<void>
  /** Host clipboard writer; native copy actions write through it instead of the frame's navigator clipboard. */
  writeClipboardText?(text: string): Promise<void>
  acceptsNativeRequest?(request: NativeRequest): boolean
  /** A hyperlink on an element was activated; `href` is its raw link string. */
  onLinkOpen(href: string, preventDefault: () => void, elementId?: string): void
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
  let controlSource = '', controlRevision = 0
  const bridge = (): NativeBridge => {
    if (disposed || !imp) throw new Error('The Excalidraw viewer is unavailable.')
    const native = (imp as ImperativeApi & { __valleyNative?: NativeBridge }).__valleyNative
    if (!native) throw new Error('The pinned Excalidraw native action bridge is unavailable. Rebuild its owning plugin.')
    return native
  }
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

  let offRouting: (() => void) | undefined, offClipboard: (() => void) | undefined
  const props: ExcalidrawProps = {
    initialData: opts.initialData as ExcalidrawProps['initialData'],
    handleKeyboardGlobally: true,
    excalidrawAPI: (a: ImperativeApi) => {
      if (disposed) return
      imp = a
      if (opts.onNativeRequest) { offRouting?.(); offRouting = bridge().routing(opts.onNativeRequest, opts.acceptsNativeRequest) }
      if (opts.writeClipboardText) { offClipboard?.(); offClipboard = bridge().clipboard(opts.writeClipboardText) }
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
      opts.onLinkOpen(href, () => event.preventDefault(), element.id)
    }
  }
  const render = () => root.render(createElement(Excalidraw, { ...props, langCode }))
  render()

  return {
    serialize(): string {
      // Excalidraw hands out its API from the constructor, before `initialData` is loaded.
      if (!imp || imp.getAppState().isLoading) return ''
      return serialization.serialize()
    },
    updateScene(scene: RawScene, capture = false): void {
      serialization.invalidate()
      if (scene.files && imp) imp.addFiles(Object.values(scene.files) as Parameters<ImperativeApi['addFiles']>[0])
      // Commit synchronously: callers serialize right after and adopt that as the on-disk scene.
      flushSync(() => imp?.updateScene({
        ...(scene.elements ? { elements: restoreElements(scene.elements as Parameters<typeof restoreElements>[0], null, { repairBindings: true }) } : {}),
        appState: scene.appState,
        captureUpdate: capture ? CaptureUpdateAction.IMMEDIATELY : CaptureUpdateAction.NEVER
      } as Parameters<ImperativeApi['updateScene']>[0]))
    },
    getView() {
      const state = imp?.getAppState()
      return { selectedIds: Object.keys(state?.selectedElementIds ?? {}).filter((id) => state?.selectedElementIds[id]), scrollX: state?.scrollX ?? 0, scrollY: state?.scrollY ?? 0, zoom: state?.zoom.value ?? 1, readOnly: state?.viewModeEnabled ?? false }
    },
    restoreView,
    controls() {
      const native = bridge(), state = native.state()
      const values = { ...Object.fromEntries(['viewBackgroundColor', 'currentItemStrokeColor', 'currentItemBackgroundColor', 'currentItemFillStyle', 'currentItemStrokeWidth', 'currentItemStrokeStyle', 'currentItemRoughness', 'currentItemOpacity', 'currentItemFontFamily', 'currentItemFontSize', 'currentItemTextAlign', 'currentItemRoundness', 'name', 'theme', 'gridSize', 'gridModeEnabled', 'objectsSnapModeEnabled', 'zenModeEnabled', 'exportBackground', 'exportEmbedScene', 'exportScale', 'exportWithDarkMode', 'showHyperlinkPopup', 'croppingElementId'].map(key => {
        const value = (state as unknown as Record<string, unknown>)[key]
        return [key, typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null]
      })), statsOpen: state.stats.open }
      const result = { activeTool: state.activeTool.type, toolLocked: state.activeTool.locked, penMode: state.penMode, openMenu: state.openMenu, dialog: state.openDialog ? { name: state.openDialog.name, tab: 'tab' in state.openDialog ? state.openDialog.tab : null } : null, sidebar: state.openSidebar ? { name: state.openSidebar.name, tab: state.openSidebar.tab ?? null } : null, history: native.history(), actions: native.actions(), values, receipt: native.receipt(), forms: native.forms() }
      const source = JSON.stringify([serialization.serialize(), state.selectedElementIds, state.scrollX, state.scrollY, state.zoom, state.viewModeEnabled, result])
      if (source !== controlSource) { controlSource = source; controlRevision++ }
      return { ...result, revision: `excalidraw-native:${imp!.id}:${controlRevision}` }
    },
    async nativeAction(name, value, beforePerform, beforeApply, beforeEffect) {
      const native = bridge()
      let effect!: Promise<void>
      flushSync(() => { effect = native.execute(name, value, beforePerform, beforeApply, beforeEffect) })
      try { await effect; flushSync(() => {}) }
      finally { serialization.invalidate(); opts.onChange() }
    },
    async tool(type, beforeEffect = async () => {}) { try { await bridge().tool(type, beforeEffect); flushSync(() => {}) } finally { serialization.invalidate(); opts.onChange() } },
    pen(enabled) { flushSync(() => bridge().pen(enabled)); opts.onChange() },
    toolLock() { flushSync(() => bridge().lock()); opts.onChange() },
    library: () => bridge().library(),
    async updateLibrary(items, merge) { bridge(); await imp!.updateLibrary({ libraryItems: items, merge } as Parameters<ImperativeApi['updateLibrary']>[0]); opts.onChange() },
    sidebar(open) { flushSync(() => bridge().sidebar(open)); opts.onChange() },
    async nativeControl(form, action, value, beforeEffect) { await bridge().control(form, action, value, beforeEffect); flushSync(() => {}); serialization.invalidate(); opts.onChange() },
    async nativeEdit(action, value, beforeEffect) { try { await bridge().edit(action, value, beforeEffect); flushSync(() => {}) } finally { serialization.invalidate(); opts.onChange() } },
    setLanguage(language): void {
      const next = languageCodes[language] ?? 'en'
      if (disposed || next === langCode) return
      langCode = next
      render()
    },
    unmount(): void {
      if (disposed) return
      disposed = true
      offRouting?.()
      offClipboard?.()
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
