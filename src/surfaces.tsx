import { METADATA_PANEL_SEGMENT_V1, provideBookmarkSurface, type PluginProperty, type ValleyPluginApi } from '@valley/plugin-sdk'
import type { PluginLinkState } from '@valley/plugin-sdk/paths'
import { React, api } from './runtime'
import { readDrawing } from './commands'
import { DRAWING_EXTENSIONS } from './formats'
import { drawingSession, restoreDrawingView, subscribeDrawing, type DrawingView } from './session'
import { uiText } from './localization'
import type { InteropValueSchema } from '@valley/plugin-sdk'

const bookmarkStateSchema = {
  "type": "object",
  "properties": {
    "v": {
      "type": "literal",
      "value": 1
    },
    "path": {
      "type": "string"
    },
    "scrollX": {
      "type": "number"
    },
    "scrollY": {
      "type": "number"
    },
    "zoom": {
      "type": "number"
    },
    "selectedIds": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "maxItems": 512
    }
  },
  "required": [
    "v",
    "path"
  ],
  "additionalProperties": false
} satisfies InteropValueSchema



function viewFrom(raw: PluginLinkState): Partial<DrawingView> {
  const result: Partial<DrawingView> = {}
  if (raw.selectedIds !== undefined && (!Array.isArray(raw.selectedIds) || raw.selectedIds.some((id) => typeof id !== 'string'))) throw new Error('Expected drawing element ids.')
  for (const key of ['scrollX', 'scrollY', 'zoom']) if (raw[key] !== undefined && (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || (key === 'zoom' && (Number(raw[key]) < 0.1 || Number(raw[key]) > 30)))) throw new Error('Invalid drawing viewport.')
  if (Array.isArray(raw.selectedIds)) result.selectedIds = raw.selectedIds.filter((id): id is string => typeof id === 'string')
  for (const key of ['scrollX', 'scrollY', 'zoom'] as const) if (typeof raw[key] === 'number' && Number.isFinite(raw[key])) result[key] = key === 'zoom' ? Math.min(30, Math.max(0.1, raw[key])) : raw[key]
  return result
}
async function inspect(path: string): Promise<PluginProperty[]> {
  const drawing = await readDrawing(api, path)
  const elements = (drawing.scene.elements ?? []) as { id?: string; type?: string; isDeleted?: boolean }[]
  const live = elements.filter((element) => !element.isDeleted)
  const selected = live.filter((element) => drawing.view?.selectedIds.includes(element.id ?? ''))
  return [
    { id: 'file', label: uiText('excalidraw.property.file'), value: path, readOnly: true },
    { id: 'elements', label: uiText('excalidraw.property.elements'), value: live.length, readOnly: true },
    { id: 'selected', label: uiText('excalidraw.property.selected'), value: selected.length, readOnly: true },
    { id: 'selection', label: uiText('excalidraw.property.types'), value: [...new Set(selected.map((element) => element.type ?? ''))], readOnly: true },
    { id: 'files', label: uiText('excalidraw.property.files'), value: Object.keys(drawing.scene.files ?? {}).length, readOnly: true },
    { id: 'background', label: uiText('excalidraw.property.background'), value: String(drawing.scene.appState?.viewBackgroundColor ?? ''), readOnly: true }
  ]
}
function Properties({ path }: { path: string }): React.ReactElement {
  const [rows, setRows] = React.useState<PluginProperty[]>([])
  const [error, setError] = React.useState('')
  React.useEffect(() => { let disposed = false; const refresh = () => { void inspect(path).then((values) => { if (!disposed) { setRows(values); setError('') } }).catch((reason) => { if (!disposed) setError(String(reason)) }) }; refresh(); const off = subscribeDrawing(refresh); return () => { disposed = true; off() } }, [path])
  return <div className="right-panel-body props-info">{error && <p role="alert">{error}</p>}<dl className="props-info-table">{rows.map((row) => <div className="props-info-row" key={row.id}><dt className="props-info-key">{row.label}</dt><dd className="props-info-value">{Array.isArray(row.value) ? row.value.join(', ') : String(row.value ?? '')}</dd></div>)}</dl><p className="props-info-hint">{uiText('excalidraw.property.native')}</p></div>
}
export function registerDrawingSurfaces(pluginApi: ValleyPluginApi): () => void {
  const restore = async (raw: PluginLinkState, _instanceId?: string, options?: { background?: boolean }): Promise<void> => {
    if (raw.v !== 1 || typeof raw.path !== 'string') throw new Error('Unsupported drawing bookmark.')
    const { scene } = await readDrawing(pluginApi, raw.path)
    const view = viewFrom(raw)
    if (view.selectedIds?.some((id) => !(scene.elements ?? []).some((element) => (element as { id?: string; isDeleted?: boolean }).id === id && !(element as { isDeleted?: boolean }).isDeleted))) throw new Error('The bookmarked drawing selection no longer exists.')
    restoreDrawingView(raw.path, view)
    if (!options?.background) pluginApi.workspace.openFile(raw.path)
  }
  const offs = [provideBookmarkSurface(pluginApi, {
    id: 'excalidraw.editor', surface: 'main_workspace', subscribe: subscribeDrawing,
    getSnapshot: (instanceId) => {
      const path = instanceId ?? pluginApi.getState().activePath ?? ''
      let drawing: ReturnType<NonNullable<ReturnType<typeof drawingSession>>['get']> | undefined
      try { drawing = drawingSession(path)?.get() } catch { drawing = undefined }
      const view: PluginLinkState = { v: 1, path, ...(drawing ? { scrollX: drawing.view.scrollX, scrollY: drawing.view.scrollY, zoom: drawing.view.zoom } : {}) }
      const selected = drawing?.view.selectedIds ?? []
      return { title: path.split('/').pop() ?? uiText('manifest.name'), view, ...(selected.length ? { item: { id: selected.join(','), title: uiText('excalidraw.property.selection', { count: selected.length }), state: { ...view, selectedIds: selected } } } : {}) }
    }, restore
  }, { stateSchema: bookmarkStateSchema, itemStateSchema: { ...bookmarkStateSchema, required: [...bookmarkStateSchema.required, "selectedIds"] }, description: (snapshot, item) => typeof snapshot.view.path === 'string' && snapshot.view.path ? snapshot.view.path : uiText(item ? 'bookmark.item' : 'bookmark.view'), validate: state => { viewFrom(state); return DRAWING_EXTENSIONS.some(extension => String(state.path).endsWith(extension)) }, primary: snapshot => Array.isArray(snapshot.item?.state.selectedIds) && snapshot.item.state.selectedIds.length > 1 ? undefined : snapshot.item }), pluginApi.interop.extensions.provide(METADATA_PANEL_SEGMENT_V1, {
    id: 'excalidraw.properties', label: 'Excalidraw', labelKey: 'manifest.name', icon: 'shapes', extensions: DRAWING_EXTENSIONS, pluginSurfaces: ['main_workspace'],
    inspect: ({ relPath, subject }) => inspect(typeof subject?.view.path === 'string' ? subject.view.path : relPath),
    render: ({ relPath, subject }) => <Properties path={typeof subject?.view.path === 'string' ? subject.view.path : relPath} />
  }), pluginApi.commands.register({ id: 'open', label: 'Excalidraw: Open drawing view', labelKey: 'excalidraw.command.open', paletteSafe: false, sideEffect: 'read', input: {
    schema: { type: 'object', properties: { path: { type: 'string' }, selectedIds: { type: 'array', items: { type: 'string' } }, scrollX: { type: 'number' }, scrollY: { type: 'number' }, zoom: { type: 'number', minimum: 0.1, maximum: 30 } }, required: ['path'], additionalProperties: false },
    parse: (raw) => { const input = raw as PluginLinkState; if (!input || typeof input.path !== 'string') throw new Error('Expected a drawing path.'); return { ...input, v: 1 } }
  }, run: async (view) => { await restore(view); return view } })]
  return () => offs.forEach((off) => off())
}
