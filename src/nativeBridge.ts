import type { Action, ActionResult } from '@excalidraw/excalidraw/actions/types'
import type { AppClassProperties, AppState, LibraryItems } from '@excalidraw/excalidraw/types'
import { useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import type { ExcalidrawImageElement, ExcalidrawTextElement } from '@excalidraw/excalidraw/element/types'

type NativeApp = AppClassProperties & {
  actionManager: {
    actions: Record<string, Action>
    isActionEnabled(action: Action): boolean
    executeAction(action: Action, source: 'api', value: unknown): void | Promise<void>
  }
  history: { isUndoStackEmpty: boolean; isRedoStackEmpty: boolean }
  isToolSupported(type: string): boolean
  store: { shouldCaptureIncrement(): void }
  createImageElement(point: { sceneX: number; sceneY: number; addToFrameUnderCursor: boolean }): ExcalidrawImageElement
  insertImageElement(element: ExcalidrawImageElement, file: File, preview: boolean): Promise<ExcalidrawImageElement | null | undefined>
  initializeImageDimensions(element: ExcalidrawImageElement, natural: boolean): void
  toggleSidebar(value: { name: string; tab?: string; force?: boolean }): boolean
}
interface NativeHelpers {
  drag: typeof import('@excalidraw/excalidraw/element/dragElements')['dragSelectedElements']
  transform: typeof import('@excalidraw/excalidraw/element/resizeElements')['transformElements']
  clone: typeof import('@excalidraw/excalidraw/element/newElement')['deepCopyElement']
  textLayout: typeof import('@excalidraw/excalidraw/element/newElement')['refreshTextDimensions']
  container: typeof import('@excalidraw/excalidraw/element/textElement')['getContainerElement']
  newElement: typeof import('@excalidraw/excalidraw')['newElementWith']
  bound: typeof import('@excalidraw/excalidraw/element/binding')['updateBoundElements']
  bounds: typeof import('@excalidraw/excalidraw')['getCommonBounds']
}
export type NativeRequest = { kind: 'action'; name: string; value: unknown } | { kind: 'tool'; name: string; value: unknown } | { kind: 'control'; form: string; action: string; value: unknown }
const routes = new WeakMap<object, { handler: (request: NativeRequest) => Promise<void>; accepts: (request: NativeRequest) => boolean }>()
export function routeNativeAction(app: NativeApp, name: string, value: unknown): boolean { return routeRequest(app, { kind: 'action', name, value }) }
export function routeNativeTool(app: NativeApp, value: { type: string }): boolean { return routeRequest(app, { kind: 'tool', name: value.type, value: null }) }
export function routeNativeControl(app: NativeApp, form: string, action: string, value: unknown): boolean { return routeRequest(app, { kind: 'control', form, action, value }) }
function routeRequest(app: NativeApp, request: NativeRequest): boolean { const route = routes.get(app); if (!route || !route.accepts(request) || effectGuards.has(app)) return false; void route.handler(request).catch(reason => app.syncActionResult({ appState: { errorMessage: String(reason).slice(0, 4096) }, captureUpdate: 'EVENTUALLY' })); return true }
export interface NativeBridge {
  routing(handler: (request: NativeRequest) => Promise<void>, accepts?: (request: NativeRequest) => boolean): () => void
  state(): AppState
  actions(): { name: string; enabled: boolean; viewMode: boolean }[]
  history(): { undo: boolean; redo: boolean }
  execute(name: string, value: unknown, beforePerform: () => void, beforeApply: () => void, beforeEffect?: () => Promise<void>): Promise<void>
  library(): Promise<LibraryItems>
  receipt(): { kind: 'library-publish'; outcome: 'server-receipt' | 'unknown'; url: string } | null
  pen(enabled: boolean): void
  lock(): void
  sidebar(open: boolean): void
  toolSupported(type: string): boolean
  tool(type: string, beforeEffect: () => Promise<void>): Promise<void>
  forms(): Record<string, { revision: string; value: Record<string, unknown> }>
  control(form: string, action: string, value: unknown, beforeEffect: () => Promise<void>): Promise<void>
  edit(action: string, value: Record<string, unknown>, beforeEffect: () => Promise<void>): Promise<void>
  clipboard(write: (text: string) => Promise<void>): () => void
}
interface NativeForm { get(): Record<string, unknown>; callbacks: Record<string, (value: unknown) => void | Promise<void>>; signature: string; revision: number }
const forms = new WeakMap<object, Map<string, NativeForm>>()
const publishingForms = new WeakMap<object, { form: NativeForm; signature: string }>()
const publisherSignature = (form: NativeForm): string => { const { busy: _busy, ...value } = form.get(); return JSON.stringify(value) }
const receipts = new WeakMap<object, { kind: 'library-publish'; outcome: 'server-receipt' | 'unknown'; url: string }>()
export function recordNativePublish(app: object, outcome: 'server-receipt' | 'unknown', url: unknown): void { if (typeof url !== 'string' || url.length > 4096 || outcome === 'server-receipt' && !/^https?:\/\//.test(url)) throw new Error('Invalid native publisher receipt.'); receipts.set(app, { kind: 'library-publish', outcome, url }) }
const libraryVersions = new WeakMap<NativeApp, { source: string; sequence: number }>()
export function nativeLibraryRevision(app: NativeApp): string { const source = librarySource(app), previous = libraryVersions.get(app), sequence = source === previous?.source ? previous.sequence : (previous?.sequence ?? 0) + 1; libraryVersions.set(app, { source, sequence }); return `excalidraw-native-library:${app.id}:${sequence}` }
const expectedLibraries = new WeakMap<NativeApp, string>()
const librarySource = (app: NativeApp): string => JSON.stringify((app.library as unknown as { currLibraryItems: LibraryItems }).currLibraryItems)
export function recordNativeLibrary(app: NativeApp): void { if (expectedLibraries.has(app)) expectedLibraries.set(app, librarySource(app)) }
const expectedScenes = new WeakMap<NativeApp, ReturnType<NativeApp['scene']['getElementsIncludingDeleted']>>()
export function recordNativeScene(app: NativeApp): void { if (expectedScenes.has(app)) expectedScenes.set(app, app.scene.getElementsIncludingDeleted()) }
const effectGuards = new WeakMap<object, () => Promise<void>>()
const clipboards = new WeakMap<object, (text: string) => Promise<void>>()
export function useNativeControl(app: object, id: string, get: NativeForm['get'], callbacks: NativeForm['callbacks']): void {
  const ref = useRef<NativeForm>({ get, callbacks, signature: '', revision: 0 })
  ref.current.get = get; ref.current.callbacks = callbacks
  useLayoutEffect(() => {
    const entries = forms.get(app) ?? new Map<string, NativeForm>()
    forms.set(app, entries)
    const entry = ref.current
    if (entries.has(id)) throw new Error('The native drawing form has duplicate owners.')
    entries.set(id, entry)
    return () => { if (entries.get(id) === entry) entries.delete(id) }
  }, [app, id])
}
export function nativeExportGuard(app: object): ((data: string | Blob) => Promise<void>) & { writeText?: (text: string) => Promise<void> } {
  const guard = effectGuards.get(app), write = clipboards.get(app)
  const before = async (data: string | Blob): Promise<void> => {
    if (guard && effectGuards.get(app) !== guard) throw Object.assign(new Error('The native export owner changed.'), { code: 'REVISION_CONFLICT', outcome: 'not-applied' })
    await beforeNativeEffect(app, { kind: 'export', data })
    if (guard && effectGuards.get(app) !== guard) throw Object.assign(new Error('The native export owner changed during authorization.'), { code: 'REVISION_CONFLICT', outcome: 'not-applied' })
  }
  if (!write) return before
  return Object.assign(before, { writeText: async (text: string): Promise<void> => {
    if (guard && effectGuards.get(app) !== guard || clipboards.get(app) !== write) throw Object.assign(new Error('The native clipboard owner changed.'), { code: 'REVISION_CONFLICT', outcome: 'not-applied' })
    try { await write(text) } catch (reason) {
      const failure = reason as { message?: unknown; code?: unknown; outcome?: unknown; retryable?: unknown } | null
      if (failure?.outcome === 'not-applied') throw Object.assign(new Error(String(failure.message ?? reason)), { ...(failure.code === undefined ? {} : { code: failure.code }), outcome: 'not-applied', retryable: failure.retryable === true, effectRefused: true })
      if (failure?.outcome) throw reason
      throw Object.assign(reason instanceof Error ? reason : new Error(String(reason)), { outcome: 'unknown', outcomeUnknown: true, retryable: false })
    }
  } })
}
export async function beforeNativeEffect(app: object, payload?: { kind: 'export'; data: string | Blob } | { kind: 'library-update'; items: LibraryItems } | { kind: 'library-publish'; library: { libraryItems: { id: string; name?: string }[] }; fields: Record<string, unknown>; preview: Blob }): Promise<void> {
  if (payload?.kind === 'export' && effectGuards.has(app) && (typeof payload.data === 'string' ? new TextEncoder().encode(payload.data).byteLength : payload.data.size) > 2 * 1024 * 1024) throw Object.assign(new Error('The native export exceeds 2 MiB.'), { code: 'RESOURCE_LIMIT', outcome: 'not-applied' })
  if (payload?.kind === 'library-update' && effectGuards.has(app) && (payload.items.length > 512 || new TextEncoder().encode(JSON.stringify(payload.items)).byteLength > 512 * 1024)) throw Object.assign(new Error('The native library exceeds 512 items or 512 KiB.'), { code: 'RESOURCE_LIMIT', outcome: 'not-applied' })
  if (payload?.kind === 'library-publish' && effectGuards.has(app)) {
    if (payload.kind !== 'library-publish' || payload.library.libraryItems.length > 512 || new TextEncoder().encode(JSON.stringify(payload.library)).byteLength > 512 * 1024 || payload.preview.size > 2 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/svg+xml'].includes(payload.preview.type) || Object.entries(payload.fields).some(([key, value]) => !['name', 'description', 'authorName', 'githubHandle', 'twitterHandle', 'website'].includes(key) || typeof value !== 'string' || value.length > (key === 'description' ? 16384 : 1024)) || payload.library.libraryItems.some(item => !item.id || !item.name || item.name.length > 1024)) throw Object.assign(new Error('The native publishing payload exceeds its bound or has invalid fields.'), { code: 'RESOURCE_LIMIT', outcome: 'not-applied' })
  }
  const pendingForm = payload?.kind === 'library-publish' ? publishingForms.get(app) : undefined
  const checkForm = () => { if (pendingForm && (forms.get(app)?.get('library-publish') !== pendingForm.form || publisherSignature(pendingForm.form) !== pendingForm.signature)) throw Object.assign(new Error('The native publishing draft changed before its request.'), { code: 'REVISION_CONFLICT', outcome: 'not-applied' }) }
  checkForm()
  const guard = effectGuards.get(app)
  await guard?.()
  checkForm()
  if (guard && effectGuards.get(app) !== guard) throw Object.assign(new Error('The native effect owner changed during authorization.'), { code: 'REVISION_CONFLICT', outcome: 'not-applied' })
}
function installEffectGuard(app: NativeApp, authorize: () => Promise<void>): void {
  expectedLibraries.set(app, librarySource(app)); expectedScenes.set(app, app.scene.getElementsIncludingDeleted())
  const check = () => { if (expectedLibraries.get(app) !== librarySource(app) || expectedScenes.get(app) !== app.scene.getElementsIncludingDeleted()) throw Object.assign(new Error('The native drawing scene or library changed before its pending effect.'), { code: 'REVISION_CONFLICT', outcome: 'not-applied' }) }
  effectGuards.set(app, async () => { check(); await authorize(); check() })
}
function clearEffectGuard(app: NativeApp): void { effectGuards.delete(app); expectedScenes.delete(app); expectedLibraries.delete(app); publishingForms.delete(app) }
export function createNativeBridge(app: NativeApp, helpers?: NativeHelpers): NativeBridge {
  const enabled = (action: Action): boolean => app.props.UIOptions.canvasActions[action.name as keyof typeof app.props.UIOptions.canvasActions] !== false && (!app.state.viewModeEnabled || action.viewMode === true) && app.actionManager.isActionEnabled(action) && (action.name !== 'undo' || !app.history.isUndoStackEmpty) && (action.name !== 'redo' || !app.history.isRedoStackEmpty) && (action.name !== 'copyAsPng' || !clipboards.has(app))
  return {
    routing(handler, accepts = () => true) { const entry = { handler, accepts }; routes.set(app, entry); return () => { if (routes.get(app) === entry) routes.delete(app) } },
    state: () => app.state,
    actions: () => [...Object.values(app.actionManager.actions).map(action => ({ name: action.name, enabled: enabled(action), viewMode: action.viewMode === true })), { name: 'commandPalette', enabled: forms.get(app)?.has('command-palette') === true, viewMode: true }],
    history: () => ({ undo: !app.history.isUndoStackEmpty, redo: !app.history.isRedoStackEmpty }),
    async execute(name, value, beforePerform, beforeApply, beforeEffect) {
      const action = app.actionManager.actions[name]
      if (name === 'copyAsPng' && clipboards.has(app)) throw Object.assign(new Error('The host clipboard accepts text only; copy the drawing as SVG instead.'), { code: 'CLIPBOARD_UNSUPPORTED', outcome: 'not-applied', retryable: false })
      if (!action || !enabled(action)) throw Object.assign(new Error('This native Excalidraw action is currently disabled.'), { code: 'ACTION_UNAVAILABLE', outcome: 'not-applied' })
      let authorized = false
      const guarded: Action = { ...action, perform: (elements, state) => {
        beforePerform()
        const result = action.perform(elements, state, value, app)
        const apply = (next: ActionResult): ActionResult => {
          if (next !== false && next.appState?.errorMessage && next.appState.errorMessage !== state.errorMessage) throw Object.assign(new Error(String(next.appState.errorMessage)), authorized ? { code: 'NATIVE_ACTION_FAILED', outcome: 'unknown', outcomeUnknown: true, retryable: false } : { code: 'NATIVE_ACTION_FAILED', outcome: 'not-applied', retryable: false })
          if (next === false) throw Object.assign(new Error('The native drawing action was cancelled or refused.'), { code: 'NATIVE_ACTION_REFUSED', outcome: 'not-applied' })
          if (app.scene.getElementsIncludingDeleted() !== elements && next.elements !== app.scene.getElementsIncludingDeleted() && expectedScenes.get(app) !== app.scene.getElementsIncludingDeleted()) throw Object.assign(new Error('The native drawing scene was replaced during this action.'), { code: 'REVISION_CONFLICT', outcome: 'unknown', outcomeUnknown: true, retryable: false })
          beforeApply(); return next
        }
        return result instanceof Promise ? result.then(async next => { if (next !== false && !(next.appState?.errorMessage && next.appState.errorMessage !== state.errorMessage)) await beforeEffect?.(); return apply(next) }) : apply(result)
      } }
      if (effectGuards.has(app)) throw Object.assign(new Error('The native drawing action is busy.'), { code: 'ACTION_UNAVAILABLE', outcome: 'not-applied' })
      installEffectGuard(app, async () => { await beforeEffect?.(); authorized = true })
      try { await app.actionManager.executeAction(guarded, 'api', value) } finally { clearEffectGuard(app) }
    },
    receipt: () => receipts.get(app) ?? null,
    clipboard(write) { clipboards.set(app, write); return () => { if (clipboards.get(app) === write) clipboards.delete(app) } },
    library: () => app.library.getLatestLibrary(),
    pen(enabled) { if (effectGuards.has(app)) throw new Error('The native drawing action is busy.'); effectGuards.set(app, async () => {}); try { app.togglePenMode(enabled) } finally { effectGuards.delete(app) } },
    lock() { if (effectGuards.has(app)) throw new Error('The native drawing action is busy.'); effectGuards.set(app, async () => {}); try { app.toggleLock() } finally { effectGuards.delete(app) } },
    sidebar(open) { if (effectGuards.has(app)) throw new Error('The native drawing action is busy.'); effectGuards.set(app, async () => {}); try { app.toggleSidebar({ name: 'default', tab: 'library', force: open }) } finally { effectGuards.delete(app) } },
    toolSupported: type => app.isToolSupported(type),
    async tool(type, beforeEffect) {
      if (!app.isToolSupported(type) || effectGuards.has(app)) throw Object.assign(new Error('The native drawing tool is unavailable or busy.'), { code: 'ACTION_UNAVAILABLE', outcome: 'not-applied' })
      installEffectGuard(app, beforeEffect)
      try { await beforeNativeEffect(app); let request: unknown; flushSync(() => { request = app.setActiveTool({ type } as Parameters<NativeApp['setActiveTool']>[0]) }); await request } finally { clearEffectGuard(app) }
    },
    forms: () => Object.fromEntries([...(forms.get(app) ?? [])].map(([id, form]) => {
      const value = form.get(), signature = JSON.stringify(value)
      if (signature.length > 128 * 1024) throw new Error('The native Excalidraw form exceeds 128 KiB.')
      if (signature !== form.signature) { form.signature = signature; form.revision++ }
      return [id, { revision: `excalidraw-form:${app.id}:${id}:${form.revision}`, value }]
    })),
    async control(formId, action, value, beforeEffect) {
      const form = forms.get(app)?.get(formId), callback = form?.callbacks[action]
      if (!form || !callback || effectGuards.has(app)) throw Object.assign(new Error('The native drawing form is unavailable or busy.'), { code: 'ACTION_UNAVAILABLE', outcome: 'not-applied' })
      const initialForm = JSON.stringify(form.get())
      installEffectGuard(app, beforeEffect)
      if (formId === 'library-publish' && action === 'confirm') publishingForms.set(app, { form, signature: publisherSignature(form) })
      try { await beforeNativeEffect(app); if (forms.get(app)?.get(formId) !== form || JSON.stringify(form.get()) !== initialForm) throw Object.assign(new Error('The native drawing form changed during authorization.'), { code: 'REVISION_CONFLICT', outcome: 'not-applied' }); let result: void | Promise<void> = undefined; flushSync(() => { result = callback(value) }); await result; await app.library.getLatestLibrary(); if (formId === 'library-publish' && action === 'confirm' && receipts.get(app)?.outcome !== 'server-receipt') throw Object.assign(new Error('The native publisher did not return an external server receipt.'), { outcome: 'unknown', outcomeUnknown: true, retryable: false }) }
      finally { clearEffectGuard(app) }
    },
    async edit(action, value, beforeEffect) {
      if (!helpers || app.state.viewModeEnabled || effectGuards.has(app)) throw Object.assign(new Error('The native drawing edit is unavailable or busy.'), { code: 'ACTION_UNAVAILABLE', outcome: 'not-applied' })
      installEffectGuard(app, beforeEffect)
      try {
        await beforeNativeEffect(app)
        if (action === 'image-insert') {
          const match = /^data:(image\/(?:png|jpeg|gif|webp|svg\+xml));base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(value.dataURL))
          if (!match || !app.isToolSupported('image')) throw new Error('Invalid native drawing image data.')
          const bytes = Uint8Array.from(atob(match[2]), character => character.charCodeAt(0))
          const file = new File([bytes], String(value.name), { type: match[1] })
          const element = app.createImageElement({ sceneX: Number(value.x), sceneY: Number(value.y), addToFrameUnderCursor: true })
          const inserted = await app.insertImageElement(element, file, false)
          if (!inserted) throw Object.assign(new Error('The native drawing image insertion failed.'), { outcome: 'unknown', outcomeUnknown: true, retryable: false })
          await beforeEffect()
          app.initializeImageDimensions(inserted, true)
          app.syncActionResult({ elements: app.scene.getElementsIncludingDeleted(), appState: { selectedElementIds: { [inserted.id]: true } }, captureUpdate: 'IMMEDIATELY' })
          return
        }
        const selected = app.scene.getSelectedElements(app.state)
        if (!selected.length || selected.some(element => element.locked)) throw new Error('Select unlocked native drawing elements.')
        const map = app.scene.getElementsMapIncludingDeleted(), originals = new Map([...map].map(([id, element]) => [id, helpers.clone(element)]))
        app.store.shouldCaptureIncrement()
        if (action === 'selection-move') helpers.drag({ originalElements: originals } as Parameters<NativeHelpers['drag']>[0], selected, { x: Number(value.dx), y: Number(value.dy) }, app.scene, { x: 0, y: 0 }, value.snapToGrid ? app.getEffectiveGridSize() : null)
        else if (action === 'selection-resize' || action === 'selection-rotate') {
          const [x1, y1, x2, y2] = helpers.bounds(selected, map)
          helpers.transform(originals, action === 'selection-rotate' ? 'rotation' : value.handle as Parameters<NativeHelpers['transform']>[1], selected, map, app.scene, Boolean(value.discreteAngle), Boolean(value.fromCenter), Boolean(value.maintainAspectRatio), Number(value.pointerX), Number(value.pointerY), (x1 + x2) / 2, (y1 + y2) / 2)
        } else if (action === 'text-content-edit') {
          const element = map.get(String(value.elementId))
          if (element?.type !== 'text' || app.state.editingTextElement) throw new Error('Select a native text element outside an active typing session.')
          const text = String(value.text)
          const next = helpers.newElement(element, { originalText: text, isDeleted: false, ...helpers.textLayout(element as ExcalidrawTextElement, helpers.container(element, map), map, text) })
          app.scene.replaceAllElements(app.scene.getElementsIncludingDeleted().map(element => element.id === next.id ? next : element))
          helpers.bound(next, app.scene.getNonDeletedElementsMap())
        } else throw new Error('Unsupported native drawing edit.')
        app.scene.triggerUpdate()
      } finally { clearEffectGuard(app) }
    }
  }
}
