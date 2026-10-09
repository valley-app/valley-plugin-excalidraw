import type { MountedPluginView, ValleyPluginApi } from '@valley/plugin-sdk'
import { normalizeRelPathOpt, isAllowedExternalUrl } from '@valley/plugin-sdk/paths'
import { api as currentApi } from './runtime'
import { mountedDrawingSession, type DrawingSession } from './session'
import { drawingSceneSchema, parseDrawingScene } from './commands'
import type { NativeRequest } from './nativeBridge'
import { isDrawingPath } from './formats'

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false })
const text = { type: 'string', minLength: 1, maxLength: 256 }
const revision = { type: 'string', minLength: 1, maxLength: 4096 }
const idsSchema = { type: 'array', items: text, uniqueItems: true, maxItems: 512 }
const longText = { type: 'string', minLength: 0, maxLength: 65536 }
const boolean = { type: 'boolean' }
const number = (minimum: number, maximum: number) => ({ type: 'number', minimum, maximum })
const choice = (...values: (string | number | null)[]) => ({ enum: values })
const record = (raw: unknown): Record<string, unknown> => { if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected an Excalidraw action object.'); return raw as Record<string, unknown> }
const string = (raw: unknown): string => { if (typeof raw !== 'string' || !raw || raw.length > 4096) throw new Error('Expected a bounded Excalidraw revision or identity.'); return raw }
const ids = (raw: unknown): string[] => { if (!Array.isArray(raw) || raw.length > 512 || new Set(raw).size !== raw.length || raw.some(value => typeof value !== 'string' || !value || value.length > 256)) throw new Error('Expected exact Excalidraw element ids.'); return raw }
function validate(raw: unknown, schema: Record<string, unknown>): unknown {
  if (schema.enum) { if (!(schema.enum as unknown[]).includes(raw)) throw new Error('Invalid native Excalidraw choice.'); return raw }
  if (schema.type === 'object') {
    const value = record(raw), fields = schema.properties as Record<string, Record<string, unknown>>, required = schema.required as string[]
    if (Object.keys(value).some(key => !Object.hasOwn(fields, key)) || required.some(key => !Object.hasOwn(value, key))) throw new Error('Unsupported or missing native Excalidraw argument.')
    return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, validate(value, fields[key])]))
  }
  if (schema.type === 'array' && Array.isArray(raw) && raw.length <= Number(schema.maxItems ?? 512)) return raw.map(value => validate(value, schema.items as Record<string, unknown>))
  if (schema.type === 'boolean' && typeof raw === 'boolean') return raw
  if (schema.type === 'number' && typeof raw === 'number' && Number.isFinite(raw) && raw >= Number(schema.minimum) && raw <= Number(schema.maximum)) return raw
  if (schema.type === 'string' && typeof raw === 'string' && raw.length >= Number(schema.minLength ?? 0) && raw.length <= Number(schema.maxLength ?? 4096)) return raw
  throw new Error('Invalid native Excalidraw value.')
}
export const nativeActionNames = ['copy', 'cut', 'paste', 'copyAsPng', 'copyAsSvg', 'copyText', 'sendBackward', 'bringForward', 'sendToBack', 'bringToFront', 'copyStyles', 'selectAll', 'pasteStyles', 'gridMode', 'zenMode', 'objectsSnapMode', 'stats', 'changeStrokeColor', 'changeBackgroundColor', 'changeFillStyle', 'changeStrokeWidth', 'changeSloppiness', 'changeStrokeStyle', 'changeArrowhead', 'changeArrowType', 'changeOpacity', 'changeFontSize', 'toggleCanvasMenu', 'toggleEditMenu', 'finalize', 'changeProjectName', 'changeExportBackground', 'changeExportEmbedScene', 'changeExportScale', 'saveToActiveFile', 'saveFileToDisk', 'loadScene', 'duplicateSelection', 'deleteSelectedElements', 'changeViewBackgroundColor', 'clearCanvas', 'zoomIn', 'zoomOut', 'resetZoom', 'zoomToFit', 'zoomToFitSelection', 'zoomToFitSelectionInViewport', 'changeFontFamily', 'changeTextAlign', 'changeVerticalAlign', 'toggleShortcuts', 'group', 'ungroup', 'addToLibrary', 'changeRoundness', 'alignTop', 'alignBottom', 'alignLeft', 'alignRight', 'alignVerticallyCentered', 'alignHorizontallyCentered', 'distributeHorizontally', 'distributeVertically', 'flipHorizontal', 'flipVertical', 'viewMode', 'exportWithDarkMode', 'toggleTheme', 'increaseFontSize', 'decreaseFontSize', 'unbindText', 'hyperlink', 'bindText', 'unlockAllElements', 'toggleElementLock', 'toggleLinearEditor', 'toggleEraserTool', 'toggleHandTool', 'selectAllElementsInFrame', 'removeAllElementsFromFrame', 'updateFrameRendering', 'setFrameAsActiveTool', 'wrapTextInContainer', 'commandPalette', 'autoResize', 'searchMenu', 'copyElementLink', 'linkToElement', 'cropEditor', 'wrapSelectionInFrame', 'undo', 'redo'] as const
const nativeValues: Record<string, Record<string, unknown>> = {
  changeStrokeColor: object({ currentItemStrokeColor: { type: 'string', minLength: 1, maxLength: 64 } }),
  changeBackgroundColor: object({ currentItemBackgroundColor: { type: 'string', minLength: 1, maxLength: 64 } }),
  changeViewBackgroundColor: object({ viewBackgroundColor: { type: 'string', minLength: 1, maxLength: 64 } }),
  changeFillStyle: choice('hachure', 'cross-hatch', 'solid', 'zigzag'), changeStrokeWidth: choice(1, 2, 4), changeSloppiness: choice(0, 1, 2), changeStrokeStyle: choice('solid', 'dashed', 'dotted'),
  changeArrowhead: object({ position: choice('start', 'end'), type: choice(null, 'arrow', 'bar', 'dot', 'circle', 'circle_outline', 'triangle', 'triangle_outline', 'diamond', 'diamond_outline', 'crowfoot_one', 'crowfoot_many', 'crowfoot_one_or_many') }),
  changeArrowType: choice('sharp', 'round', 'elbow'), changeOpacity: number(0, 100), changeFontSize: number(1, 1000),
  changeProjectName: { type: 'string', minLength: 0, maxLength: 1024 }, changeExportBackground: boolean, changeExportEmbedScene: boolean, changeExportScale: choice(1, 2, 3), exportWithDarkMode: boolean,
  changeFontFamily: object({ currentItemFontFamily: choice(1, 2, 3, 5, 6, 7, 8) }), changeTextAlign: choice('left', 'center', 'right'), changeVerticalAlign: choice('top', 'middle', 'bottom'), changeRoundness: choice('sharp', 'round')
}
const externalActions = new Set(['copy', 'cut', 'paste', 'copyAsPng', 'copyAsSvg', 'copyText', 'copyElementLink', 'saveToActiveFile', 'saveFileToDisk', 'loadScene'])
const mutatingTools = new Set(['selection', 'rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text', 'image', 'eraser', 'embeddable', 'laser', 'frame', 'hand'])
interface ExactInput { mountedView: MountedPluginView; expectedSceneRevision: string; expectedViewRevision: string; selectedIds: string[]; expectedControlRevision?: string; [key: string]: unknown }

export function registerDrawingActions(source: ValleyPluginApi): () => void {
  const vault = source.getState().vault?.path
  let live = true
  const active = (): void => { if (!live || currentApi !== source || source.getState().vault?.path !== vault) throw Object.assign(new Error('The Excalidraw owner is unavailable.'), { code: 'OWNER_UNAVAILABLE', outcome: 'not-applied' }) }
  const mountedSchema = object({ mountId: text, generation: { type: 'integer', minimum: 0 }, area: choice('main', 'right'), paneId: text, tabId: text, filePath: { type: 'string', minLength: 1, maxLength: 4096 }, pluginId: { const: source.pluginId } })
  const mount = (raw: unknown): MountedPluginView => {
    const value = record(raw)
    if (Object.keys(value).sort().join(',') !== Object.keys(mountedSchema.properties).sort().join(',') || ['mountId', 'paneId', 'tabId'].some(key => typeof value[key] !== 'string' || !value[key] || String(value[key]).length > 256) || !Number.isInteger(value.generation) || Number(value.generation) < 0 || !['main', 'right'].includes(String(value.area)) || value.pluginId !== source.pluginId || typeof value.filePath !== 'string' || value.filePath.length > 4096 || normalizeRelPathOpt(value.filePath) !== value.filePath || !isDrawingPath(value.filePath)) throw new Error('Expected an exact mounted Excalidraw identity.')
    return value as unknown as MountedPluginView
  }
  const inspect = (view: MountedPluginView) => {
    active()
    const session = mountedDrawingSession(view, source), state = session.get()
    return { mountedView: view, sceneRevision: state.sceneRevision ?? state.revision, viewRevision: state.viewRevision ?? JSON.stringify(state.view), selectedIds: state.view.selectedIds, scrollX: state.view.scrollX, scrollY: state.view.scrollY, zoom: state.view.zoom, readOnly: state.view.readOnly, ready: state.ready !== false && !state.blocked, uncertain: state.uncertain ?? false, dirtyError: state.error.slice(0, 4096), elementCount: state.scene.elements?.length ?? 0, controls: session.controls?.() ?? null }
  }
  const publishFields = object(Object.fromEntries(['name', 'description', 'authorName', 'githubHandle', 'twitterHandle', 'website'].map(field => [field, { type: 'string', minLength: 0, maxLength: field === 'description' ? 16384 : 1024 }])))
  const formStates = {
    'library-selection': object({ selectedIds: idsSchema, itemsRevision: revision }),
    'library-menu': object({ selectedIds: idsSchema, publishOpen: boolean, confirmRemove: boolean, itemsRevision: revision }),
    'library-publish': object({ draft: publishFields, items: { type: 'array', maxItems: 512, items: object({ id: text, name: { type: 'string', maxLength: 1024 }, error: { type: 'string', maxLength: 4096 } }) }, busy: boolean }),
    mermaid: object({ text: longText, renderedText: longText, parsedText: longText, error: { type: 'string', maxLength: 4096 }, elements: { type: 'integer', minimum: 0 }, ready: boolean }),
    'command-palette': object({ open: boolean }), 'extra-tools': object({ open: boolean })
  }
  const controlsSchema = object({ revision, activeTool: text, toolLocked: boolean, penMode: boolean, openMenu: { type: ['string', 'null'] }, dialog: { type: ['object', 'null'], additionalProperties: false, properties: { name: text, tab: { type: ['string', 'null'] } }, required: ['name', 'tab'] }, sidebar: { type: ['object', 'null'], additionalProperties: false, properties: { name: text, tab: { type: ['string', 'null'] } }, required: ['name', 'tab'] }, history: object({ undo: boolean, redo: boolean }), actions: { type: 'array', maxItems: 128, items: object({ name: text, enabled: boolean, viewMode: boolean }) }, values: { type: 'object', maxProperties: 32, additionalProperties: { type: ['string', 'number', 'boolean', 'null'], maxLength: 4096 } }, receipt: { anyOf: [object({ kind: choice('library-publish'), outcome: choice('server-receipt', 'unknown'), url: { type: 'string', maxLength: 4096 } }), { type: 'null' }] }, forms: { type: 'object', additionalProperties: false, properties: Object.fromEntries(Object.entries(formStates).map(([key, value]) => [key, object({ revision, value })])) } })
  const output = object({ mountedView: mountedSchema, sceneRevision: revision, viewRevision: revision, selectedIds: idsSchema, scrollX: { type: 'number' }, scrollY: { type: 'number' }, zoom: number(0.1, 30), readOnly: boolean, ready: boolean, uncertain: boolean, dirtyError: { type: 'string', maxLength: 4096 }, elementCount: { type: 'integer', minimum: 0 }, controls: { anyOf: [controlsSchema, { type: 'null' }] } })
  const parseMount = (raw: unknown) => { const value = record(raw); if (Object.keys(value).join(',') !== 'mountedView') throw new Error('Unsupported Excalidraw inspection argument.'); return { mountedView: mount(value.mountedView) } }
  const off = [source.commands.register({ id: 'view-inspect', label: 'Excalidraw: Inspect exact mounted drawing', paletteSafe: false, sideEffect: 'read', recovery: 'observational', idempotent: true, input: { schema: object({ mountedView: mountedSchema }), parse: parseMount }, outputSchema: output, run: ({ mountedView }) => inspect(mountedView) })]
  const exact = { mountedView: mountedSchema, expectedSceneRevision: revision, expectedViewRevision: revision, selectedIds: idsSchema }
  const register = (id: string, fields: Record<string, Record<string, unknown>>, effect: (session: DrawingSession, input: ExactInput, beforeEffect: () => Promise<void>, beforeApply: () => void, beforePerform: () => void) => Promise<void> | void, options: { native?: boolean; external?: boolean; allowReadOnly?: boolean; persistence?: boolean; form?: string; library?: boolean } = {}) => {
    const properties = { ...exact, ...(options.native ? { expectedControlRevision: revision } : {}), ...fields }, sideEffect = options.external ? 'execute' as const : 'write' as const
    off.push(source.commands.register<ExactInput, ReturnType<typeof inspect>, 'write' | 'execute'>({
      id, label: `Excalidraw: ${id}`, paletteSafe: false, sideEffect, recovery: 'non-replayable', idempotent: false, limits: { operations: 1 },
      revisionRequirements: [{ argument: 'expectedSceneRevision', inspectionCommand: 'excalidraw:view-inspect', description: 'Use the exact mounted drawing scene revision.' }, { argument: 'expectedViewRevision', inspectionCommand: 'excalidraw:view-inspect', description: 'Use the exact selected drawing view revision.' }, ...(options.native ? [{ argument: 'expectedControlRevision', inspectionCommand: 'excalidraw:view-inspect', description: 'Use the current native control and history revision.' }] : []), ...(options.persistence ? [{ argument: 'expectedDiskRevision', inspectionCommand: 'excalidraw:disk-inspect', description: 'Use this drawing disk baseline revision.' }, { argument: 'expectedDraftRevision', inspectionCommand: 'excalidraw:disk-inspect', description: 'Use this drawing retained draft revision.' }] : []), ...(options.library ? [{ argument: 'expectedLibraryRevision', inspectionCommand: 'excalidraw:library-inspect', description: 'Use this native library item revision.' }] : []), ...(options.form ? [{ argument: 'expectedFormRevision', inspectionCommand: 'excalidraw:view-inspect', description: 'Use the revision of this exact native library/dialog form.' }] : [])],
      input: { schema: object(properties), parse: raw => {
        const value = record(raw)
        if (Object.keys(value).some(key => !Object.hasOwn(properties, key)) || Object.keys(properties).some(key => !Object.hasOwn(value, key))) throw new Error('Unsupported or missing exact Excalidraw action argument.')
        const result: ExactInput = { mountedView: mount(value.mountedView), expectedSceneRevision: string(value.expectedSceneRevision), expectedViewRevision: string(value.expectedViewRevision), selectedIds: ids(value.selectedIds) }
        if (options.native) result.expectedControlRevision = string(value.expectedControlRevision)
        for (const [key, schema] of Object.entries(fields)) result[key] = key === 'scene' ? parseDrawingScene(value.scene) : ['targetIds', 'itemIds'].includes(key) ? ids(value[key]) : validate(value[key], schema)
        if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 512 * 1024) throw new Error('The Excalidraw action exceeds 512 KiB.')
        return result
      } }, outputSchema: output,
      revision: ({ mountedView }) => inspect(mountedView), preview: input => ({ action: id, mountedView: input.mountedView, selectedIds: input.selectedIds, ...Object.fromEntries(Object.keys(fields).map(key => [key, input[key]])) }),
      run: async (input, context) => {
        active()
        const session = mountedDrawingSession(input.mountedView, source), initial = session.get(), initialControls = session.controls?.()
        const nativeInvariant = (controls: typeof initialControls) => JSON.stringify(controls ? { ...controls, revision: '', forms: Object.fromEntries(Object.entries(controls.forms).map(([key, value]) => [key, { ...value, revision: '', value: key === options.form ? { ...value.value, busy: undefined } : value.value }])) } : null)
        const assert = (first = false): void => {
          active()
          if (context.cancellation?.aborted) throw Object.assign(new Error('The Excalidraw action was cancelled.'), { code: 'CANCELLED', outcome: 'not-applied' })
          if (mountedDrawingSession(input.mountedView, source) !== session) throw Object.assign(new Error('The exact Excalidraw viewer changed.'), { code: 'OWNER_UNAVAILABLE', outcome: 'not-applied' })
          const state = session.get()
          if (state.revision !== initial.revision || (state.viewRevision ?? JSON.stringify(state.view)) !== input.expectedViewRevision || JSON.stringify(state.view.selectedIds) !== JSON.stringify(input.selectedIds) || state.blocked && (first || !options.form) || first && ((!options.persistence && state.ready === false) || (state.sceneRevision ?? state.revision) !== input.expectedSceneRevision)) throw Object.assign(new Error('The exact Excalidraw drawing or view changed.'), { code: 'REVISION_CONFLICT', outcome: 'not-applied' })
          if (!options.allowReadOnly && state.view.readOnly) throw Object.assign(new Error('The drawing is read-only.'), { code: 'READ_ONLY', outcome: 'not-applied' })
          if (options.native && session.controls?.().revision !== input.expectedControlRevision && (first || !options.form || nativeInvariant(session.controls?.()) !== nativeInvariant(initialControls))) throw Object.assign(new Error('The native drawing controls changed.'), { code: 'REVISION_CONFLICT', outcome: 'not-applied' })
        }
        let performing = false
        const assertOwner = (): void => { active(); if (context.cancellation?.aborted) throw Object.assign(new Error('The Excalidraw action was cancelled.'), { code: 'CANCELLED', outcome: 'not-applied' }); if (mountedDrawingSession(input.mountedView, source) !== session) throw Object.assign(new Error('The exact Excalidraw viewer changed.'), { code: 'OWNER_UNAVAILABLE', outcome: 'not-applied' }) }
        const authorize = async () => { if (context.validateBeforeRun && !await context.validateBeforeRun()) throw Object.assign(new Error('Excalidraw authorization changed.'), { code: 'DENIED', outcome: 'not-applied' }); if (performing && options.native) assertOwner(); else assert() }
        assert(true); await authorize(); assert(true)
        if (options.form && session.controls?.().forms[options.form]?.revision !== input.expectedFormRevision) throw Object.assign(new Error('The exact native drawing form changed.'), { code: 'REVISION_CONFLICT', outcome: 'not-applied' })
        let accepted = false
        const refusedWithoutEffect = (reason: unknown): boolean => {
          const failure = reason as { outcome?: unknown; outcomeUnknown?: unknown; effectRefused?: unknown } | null
          if (failure?.outcome !== 'not-applied' || failure.effectRefused !== true || failure.outcomeUnknown) return false
          try {
            const state = session.get()
            return mountedDrawingSession(input.mountedView, source) === session && state.revision === initial.revision && JSON.stringify(state.view) === JSON.stringify(initial.view) && (!options.native || nativeInvariant(session.controls?.()) === nativeInvariant(initialControls))
          } catch { return false }
        }
        const accept = (): void => {
          if (options.native) {
            active()
            if (context.cancellation?.aborted || mountedDrawingSession(input.mountedView, source) !== session) throw Object.assign(new Error('The native drawing action lost its exact owner.'), { code: 'ACTION_OUTCOME_UNKNOWN', outcome: 'unknown', outcomeUnknown: true, retryable: false })
          } else assert()
          accepted = true; if (options.native) performing = true
        }
        try {
          await effect(session, input, authorize, accept, () => { assert(); if (options.native) performing = true })
          active()
          const value = inspect(input.mountedView)
          return sideEffect === 'write' ? { value, revert: null } : value
        } catch (reason) {
          if (accepted && !refusedWithoutEffect(reason)) throw Object.assign(new Error(String(reason)), { code: 'ACTION_OUTCOME_UNKNOWN', outcome: 'unknown', outcomeUnknown: true, retryable: false })
          throw reason
        }
      }
    }))
  }
  register('selection-set', { targetIds: idsSchema }, (session, input, _authorize, accept) => { const targetIds = ids(input.targetIds), scene = session.get().scene; if (targetIds.some(id => !scene.elements?.some(element => (element as { id: string; isDeleted?: boolean }).id === id && !(element as { isDeleted?: boolean }).isDeleted))) throw new Error('A selected drawing element no longer exists.'); accept(); session.restore({ selectedIds: targetIds }) }, { allowReadOnly: true })
  register('viewport-set', { scrollX: number(-1e9, 1e9), scrollY: number(-1e9, 1e9), zoom: number(0.1, 30) }, (session, input, _authorize, accept) => { accept(); session.restore({ scrollX: Number(input.scrollX), scrollY: Number(input.scrollY), zoom: Number(input.zoom) }) }, { allowReadOnly: true })
  register('read-only-set', { readOnly: boolean }, (session, input, _authorize, accept) => { accept(); session.restore({ readOnly: Boolean(input.readOnly) }) }, { allowReadOnly: true })
  register('scene-commit', { scene: drawingSceneSchema }, async (session, input, authorize, accept) => { await session.commit(parseDrawingScene(input.scene), session.get().revision, authorize, accept) })
  for (const name of nativeActionNames) register(`action-${name}`, nativeValues[name] ? { value: nativeValues[name] } : {}, async (session, input, authorize, accept, check) => {
    const action = session.controls?.().actions.find(action => action.name === name)
    if (!session.action || !action?.enabled) throw Object.assign(new Error('This native Excalidraw control is currently disabled.'), { code: 'ACTION_UNAVAILABLE', outcome: 'not-applied' })
    await authorize()
    if (name === 'commandPalette') { if (!session.nativeControl) throw new Error('The native command palette is unavailable.'); accept(); await session.nativeControl('command-palette', 'toggle', null, authorize) }
    else await session.action(name, input.value ?? null, check, accept, externalActions.has(name) ? async () => { await authorize(); accept() } : authorize)
  }, { native: true, external: externalActions.has(name), allowReadOnly: true })
  const geometryFields = { pointerX: number(-1e9, 1e9), pointerY: number(-1e9, 1e9), discreteAngle: boolean, fromCenter: boolean, maintainAspectRatio: boolean }
  const edits = {
    'selection-move': { dx: number(-1e9, 1e9), dy: number(-1e9, 1e9), snapToGrid: boolean },
    'selection-resize': { ...geometryFields, handle: choice('n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw') },
    'selection-rotate': geometryFields,
    'text-content-edit': { elementId: text, text: longText },
    'image-insert': { name: text, dataURL: { type: 'string', minLength: 1, maxLength: 384 * 1024 }, x: number(-1e9, 1e9), y: number(-1e9, 1e9) }
  }
  for (const [action, fields] of Object.entries(edits)) register(action, fields, async (session, input, authorize, accept) => {
    if (!session.nativeEdit) throw Object.assign(new Error('The native drawing edit is unavailable.'), { code: 'ACTION_UNAVAILABLE', outcome: 'not-applied' })
    const elements = session.get().scene.elements as { id: string; type: string; locked?: boolean; isDeleted?: boolean }[]
    if (action !== 'image-insert' && (!input.selectedIds.length || input.selectedIds.some(id => !elements.some(element => element.id === id && !element.locked && !element.isDeleted)))) throw new Error('Select exact unlocked native drawing elements.')
    if (action === 'text-content-edit' && (!input.selectedIds.includes(String(input.elementId)) || !elements.some(element => element.id === input.elementId && element.type === 'text'))) throw new Error('Select the exact native text element.')
    if (action === 'image-insert' && !/^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/.test(String(input.dataURL))) throw new Error('Expected bounded native drawing image bytes.')
    await authorize(); accept()
    await session.nativeEdit(action, Object.fromEntries(Object.keys(fields).map(key => [key, input[key]])), authorize)
  }, { native: true })
  for (const tool of mutatingTools) register(`tool-${tool}`, {}, async (session, _input, authorize, accept) => { if (!session.tool) throw new Error('The drawing tool adapter is unavailable.'); accept(); await session.tool(tool, authorize) }, { native: true, external: tool === 'image' })
  register('tool-lock', {}, (session, _input, _authorize, accept) => { if (!session.toolLock) throw new Error('The drawing tool lock adapter is unavailable.'); accept(); session.toolLock() }, { native: true })
  register('pen-mode-set', { enabled: boolean }, (session, input, _authorize, accept) => { if (!session.pen) throw new Error('The drawing pen adapter is unavailable.'); accept(); session.pen(Boolean(input.enabled)) }, { native: true })
  register('library-open-set', { open: boolean }, (session, input, _authorize, accept) => { if (!session.sidebar) throw new Error('The native drawing library is unavailable.'); accept(); session.sidebar(Boolean(input.open)) }, { native: true, allowReadOnly: true })
  const libraries = new WeakMap<DrawingSession, { source: string; sequence: number; revision: string }>()
  const library = async (session: DrawingSession, view: MountedPluginView) => {
    active()
    if (!session.library) throw new Error('The native drawing library is unavailable.')
    const items = await session.library()
    active()
    if (mountedDrawingSession(view, source) !== session) throw new Error('The exact drawing library owner changed.')
    const serialized = JSON.stringify(items)
    if (new TextEncoder().encode(serialized).byteLength > 512 * 1024 || items.length > 512) throw Object.assign(new Error('The native drawing library exceeds 512 items or 512 KiB.'), { code: 'RESOURCE_LIMIT', outcome: 'not-applied' })
    const previous = libraries.get(session), sequence = previous && previous.source === serialized ? previous.sequence : (previous?.sequence ?? 0) + 1
    const revision = `excalidraw-library:${view.mountId}:${view.generation}:${sequence}`
    libraries.set(session, { source: serialized, sequence, revision })
    return { items: items as { id: string; name?: string; status: string; elements: unknown[] }[], revision }
  }
  off.push(source.commands.register({ id: 'library-inspect', label: 'Excalidraw: Inspect native library items', paletteSafe: false, sideEffect: 'read', recovery: 'observational', idempotent: true, input: { schema: object({ mountedView: mountedSchema }), parse: parseMount }, outputSchema: object({ revision, items: { type: 'array', maxItems: 512, items: object({ id: text, name: { type: 'string', maxLength: 1024 }, status: choice('published', 'unpublished'), elementCount: { type: 'integer', minimum: 0 } }) } }), run: async ({ mountedView }) => { const current = await library(mountedDrawingSession(mountedView, source), mountedView); return { revision: current.revision, items: current.items.map(item => ({ id: item.id, name: item.name ?? '', status: item.status, elementCount: item.elements.length })) } } }))
  const form = (session: DrawingSession, id: string) => {
    const current = session.controls?.().forms[id]
    if (!current || !session.nativeControl) throw Object.assign(new Error('Open the corresponding native drawing control before using this action.'), { code: 'ACTION_UNAVAILABLE', outcome: 'not-applied' })
    return current.value
  }
  const ownControl = async (session: DrawingSession, input: ExactInput, id: string, action: string, value: unknown, authorize: () => Promise<void>, accept: () => void) => {
    form(session, id)
    await authorize(); accept()
    await session.nativeControl!(id, action, value, authorize)
  }
  for (const operation of ['item-select', 'items-insert', 'selected-remove', 'reset', 'import', 'export', 'publish-dialog'] as const) {
    const formId = operation === 'item-select' || operation === 'items-insert' ? 'library-selection' : 'library-menu'
    register(`library-${operation}`, { expectedLibraryRevision: revision, expectedFormRevision: revision, ...(['item-select', 'items-insert', 'selected-remove', 'publish-dialog'].includes(operation) ? { itemIds: idsSchema } : {}), ...(operation === 'reset' ? { discardLibrary: { enum: [true] } } : {}) }, async (session, input, authorize, accept) => {
      const current = await library(session, input.mountedView)
      if (current.revision !== input.expectedLibraryRevision) throw Object.assign(new Error('The native drawing library changed.'), { code: 'REVISION_CONFLICT', outcome: 'not-applied' })
      const itemIds = input.itemIds === undefined ? [] : ids(input.itemIds), nativeForm = form(session, formId)
      if (itemIds.some(id => !current.items.some(item => item.id === id))) throw new Error('An exact drawing library item no longer exists.')
      if (['items-insert', 'selected-remove', 'publish-dialog'].includes(operation) && !itemIds.length) throw new Error('Select at least one native drawing library item.')
      if (['selected-remove', 'publish-dialog'].includes(operation) && JSON.stringify(nativeForm.selectedIds) !== JSON.stringify(itemIds) || operation === 'reset' && (nativeForm.selectedIds as string[]).length) throw new Error('The native drawing library selection changed.')
      const action = operation === 'item-select' ? 'select' : operation === 'items-insert' ? 'insert' : operation === 'selected-remove' || operation === 'reset' ? 'remove' : operation === 'publish-dialog' ? 'publish' : operation
      const value = operation === 'item-select' ? itemIds : operation === 'items-insert' ? current.items.filter(item => itemIds.includes(item.id)) : null
      await ownControl(session, input, formId, action, value, authorize, accept)
    }, { native: true, form: formId, library: true, external: operation === 'import' || operation === 'export' })
  }
  register('library-publish-patch', { expectedFormRevision: revision, fields: publishFields, names: { type: 'array', maxItems: 512, items: object({ id: text, name: { type: 'string', minLength: 0, maxLength: 1024 } }) } }, async (session, input, authorize, accept) => {
    const current = form(session, 'library-publish')
    if (current.busy) throw new Error('The native library publisher is busy.')
    const names = input.names as { id: string; name: string }[]
    if (new Set(names.map(item => item.id)).size !== names.length || names.some(item => !(current.items as { id: string }[]).some(current => current.id === item.id))) throw new Error('A native library publishing item changed.')
    const next = { ...current, draft: input.fields, items: (current.items as { id: string; name: string }[]).map(item => ({ ...item, name: names.find(name => name.id === item.id)?.name ?? item.name })) }
    if (JSON.stringify(next).length > 128 * 1024) throw Object.assign(new Error('The native publishing draft exceeds 128 KiB.'), { code: 'RESOURCE_LIMIT', outcome: 'not-applied' })
    await ownControl(session, input, 'library-publish', 'patch', { fields: input.fields, names: Object.fromEntries(names.map(item => [item.id, item.name])) }, authorize, accept)
  }, { native: true, form: 'library-publish' })
  for (const action of ['confirm', 'cancel'] as const) register(`library-publish-${action}`, { expectedFormRevision: revision }, async (session, input, authorize, accept) => {
    const current = form(session, 'library-publish'), fields = record(current.draft)
    if (current.busy) throw new Error('The native library publisher is busy.')
    if (action === 'confirm' && (['name', 'description', 'authorName'].some(key => !String(fields[key]).trim()) || (current.items as { name: string }[]).some(item => !item.name.trim()) || fields.website && !/^https?:\/\//.test(String(fields.website)))) throw new Error('Complete the native library publishing form before submitting it.')
    await ownControl(session, input, 'library-publish', action, null, authorize, accept)
  }, { native: true, form: 'library-publish', external: action === 'confirm' })
  register('extra-tools-menu-set', { expectedFormRevision: revision, open: boolean }, (session, input, authorize, accept) => ownControl(session, input, 'extra-tools', 'set', input.open, authorize, accept), { native: true, form: 'extra-tools', allowReadOnly: true })
  register('mermaid-dialog-open', { expectedFormRevision: revision }, (session, input, authorize, accept) => ownControl(session, input, 'extra-tools', 'mermaid', null, authorize, accept), { native: true, form: 'extra-tools' })
  register('mermaid-draft-edit', { expectedFormRevision: revision, text: longText }, (session, input, authorize, accept) => { const current = form(session, 'mermaid'), text = String(input.text), trimmed = text.trim(); if (JSON.stringify({ ...current, text, renderedText: trimmed, parsedText: trimmed }).length > 128 * 1024) throw Object.assign(new Error('The native Mermaid draft exceeds its 128 KiB form budget.'), { code: 'RESOURCE_LIMIT', outcome: 'not-applied' }); return ownControl(session, input, 'mermaid', 'patch', text, authorize, accept) }, { native: true, form: 'mermaid' })
  register('mermaid-insert', { expectedFormRevision: revision }, async (session, input, authorize, accept) => { const current = form(session, 'mermaid'); if (!current.ready || current.error || !String(current.text).trim() || current.parsedText !== String(current.text).trim() || !current.elements) throw new Error('Wait for the exact native Mermaid draft to parse successfully before inserting it.'); await ownControl(session, input, 'mermaid', 'insert', null, authorize, accept) }, { native: true, form: 'mermaid' })
  register('mermaid-dialog-close', { expectedFormRevision: revision }, async (session, input, authorize, accept) => { if (session.controls?.().dialog?.name !== 'ttd' || session.controls?.().dialog?.tab !== 'mermaid') throw new Error('The native Mermaid dialog is not open.'); await ownControl(session, input, 'extra-tools', 'close', null, authorize, accept) }, { native: true, form: 'extra-tools' })
  const diskOutput = object({ diskRevision: revision, draftRevision: revision, dirty: boolean, uncertain: boolean, error: { type: 'string', maxLength: 4096 } })
  off.push(source.commands.register({ id: 'disk-inspect', label: 'Excalidraw: Inspect disk and retained draft', paletteSafe: false, sideEffect: 'read', recovery: 'observational', idempotent: true, input: { schema: object({ mountedView: mountedSchema }), parse: parseMount }, outputSchema: diskOutput, run: async ({ mountedView }) => { active(); const session = mountedDrawingSession(mountedView, source); if (!session.persistence) throw new Error('The drawing persistence owner is unavailable.'); const result = await session.persistence(); active(); if (mountedDrawingSession(mountedView, source) !== session) throw new Error('The drawing owner changed.'); return result } }))
  for (const action of ['retry-save', 'reload-disk'] as const) register(action, { expectedDiskRevision: revision, expectedDraftRevision: revision, ...(action === 'reload-disk' ? { discardDraft: { enum: [true] } } : {}) }, async (session, input, authorize, accept) => { if (!session.lifecycle) throw new Error('The drawing persistence owner is unavailable.'); await session.lifecycle(action, string(input.expectedDiskRevision), string(input.expectedDraftRevision), authorize, accept) }, { persistence: true, allowReadOnly: true })
  for (const external of [false, true]) register(external ? 'element-link-external-open' : 'element-link-vault-open', { elementId: text, link: { type: 'string', minLength: 1, maxLength: 4096 } }, async (session, input, authorize, accept) => {
    const element = session.get().scene.elements?.find(element => (element as { id: string }).id === input.elementId) as { link?: string } | undefined
    if (!element || element.link !== input.link) throw new Error('The exact drawing element link changed.')
    if (external) { if (!isAllowedExternalUrl(String(input.link))) throw new Error('Unsupported external drawing link.'); await authorize(); accept(); if (!await source.files.openExternalUrl(String(input.link))) throw new Error('The external drawing link outcome is unknown.') }
    else { const link = String(input.link).replace(/^\[\[(.*?)\]\]$/, '$1'), target = source.workspace.resolveWikilink(link); if (!target || normalizeRelPathOpt(target) !== target) throw new Error('The drawing link no longer resolves to a vault file.'); await authorize(); accept(); await source.workspace.openFile(target) }
  }, { external: true, allowReadOnly: true })
  return () => { live = false; for (const unregister of off) unregister() }
}

const nativeControlCommands: Record<string, string> = {
  'toolbar:library': 'library-open-set', 'toolbar:lock': 'tool-lock', 'toolbar:pen': 'pen-mode-set',
  'command-palette:toggle': 'action-commandPalette', 'library-selection:select': 'library-item-select', 'library-selection:insert': 'library-items-insert',
  'library-menu:remove': 'library-selected-remove', 'library-menu:import': 'library-import', 'library-menu:export': 'library-export', 'library-menu:publish': 'library-publish-dialog',
  'library-publish:patch': 'library-publish-patch', 'library-publish:confirm': 'library-publish-confirm', 'library-publish:cancel': 'library-publish-cancel',
  'extra-tools:set': 'extra-tools-menu-set', 'extra-tools:mermaid': 'mermaid-dialog-open', 'extra-tools:close': 'mermaid-dialog-close', 'mermaid:patch': 'mermaid-draft-edit', 'mermaid:insert': 'mermaid-insert'
}
export function acceptsNativeDrawingRequest(request: NativeRequest): boolean { return request.kind === 'action' ? nativeActionNames.includes(request.name as typeof nativeActionNames[number]) : request.kind === 'tool' ? mutatingTools.has(request.name) : Object.hasOwn(nativeControlCommands, `${request.form}:${request.action}`) }
export async function executeNativeDrawingRequest(source: ValleyPluginApi, mountedView: MountedPluginView, request: NativeRequest): Promise<void> {
  if (!acceptsNativeDrawingRequest(request)) throw new Error('Unsupported native drawing callback.')
  const session = mountedDrawingSession(mountedView, source), current = session.get()
  const state = { sceneRevision: current.sceneRevision ?? current.revision, viewRevision: current.viewRevision ?? JSON.stringify(current.view), selectedIds: [...current.view.selectedIds], controls: session.controls?.() }
  const controls = record(state.controls), forms = record(controls.forms)
  const input: Record<string, unknown> = { mountedView, expectedSceneRevision: state.sceneRevision, expectedViewRevision: state.viewRevision, selectedIds: state.selectedIds, expectedControlRevision: controls.revision }
  let command: string
  if (request.kind === 'action') {
    command = `action-${request.name}`
    if (nativeValues[request.name]) input.value = request.name === 'changeFontFamily' ? { currentItemFontFamily: record(request.value).currentItemFontFamily } : request.value
  } else if (request.kind === 'tool') command = `tool-${request.name}`
  else {
    command = nativeControlCommands[`${request.form}:${request.action}`]
    const form = record(forms[request.form]); if (request.form !== 'command-palette' && request.form !== 'toolbar') input.expectedFormRevision = form.revision
    const value = record(form.value)
    if (request.form === 'library-selection' || request.form === 'library-menu') {
      const inspected = await source.commands.execute('excalidraw:library-inspect', { mountedView })
      if (!inspected.ok) throw new Error(inspected.error.message)
      input.expectedLibraryRevision = record(inspected.value).revision
      if (request.form === 'library-selection') input.itemIds = request.action === 'select' ? request.value : (request.value as { id: string }[]).map(item => item.id)
      else if (request.action === 'remove' || request.action === 'publish') { input.itemIds = value.selectedIds; if (request.action === 'remove' && !(value.selectedIds as unknown[]).length) { command = 'library-reset'; delete input.itemIds; input.discardLibrary = true } }
    }
    if (request.form === 'toolbar' && request.action === 'library') input.open = request.value
    if (request.form === 'toolbar' && request.action === 'pen') input.enabled = request.value
    if (request.form === 'library-publish' && request.action === 'patch') { const patch = record(request.value); input.fields = patch.fields; input.names = Object.entries(record(patch.names)).map(([id, name]) => ({ id, name })) }
    if (request.form === 'extra-tools' && request.action === 'set') input.open = request.value
    if (request.form === 'mermaid' && request.action === 'patch') input.text = request.value
  }
  const result = await source.commands.execute(`excalidraw:${command}`, input)
  if (!result.ok) throw Object.assign(new Error(result.error.message), result.error)
}

export async function executeDrawingViewCallback(source: ValleyPluginApi, mountedView: MountedPluginView, action: 'retry-save' | 'reload-disk' | 'element-link-vault-open' | 'element-link-external-open', extras: Record<string, unknown> = {}): Promise<void> {
  const session = mountedDrawingSession(mountedView, source), current = session.get()
  const view = { sceneRevision: current.sceneRevision ?? current.revision, viewRevision: current.viewRevision ?? JSON.stringify(current.view), selectedIds: [...current.view.selectedIds] }
  const input = { mountedView, expectedSceneRevision: view.sceneRevision, expectedViewRevision: view.viewRevision, selectedIds: view.selectedIds, ...extras }
  if (action === 'retry-save' || action === 'reload-disk') {
    const disk = await source.commands.execute('excalidraw:disk-inspect', { mountedView })
    if (!disk.ok) throw new Error(disk.error.message)
    Object.assign(input, { expectedDiskRevision: record(disk.value).diskRevision, expectedDraftRevision: record(disk.value).draftRevision }, action === 'reload-disk' ? { discardDraft: true } : {})
  }
  const result = await source.commands.execute(`excalidraw:${action}`, input)
  if (!result.ok) throw Object.assign(new Error(result.error.message), result.error)
}
