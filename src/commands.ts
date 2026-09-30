import { guardedCreatedFileRevert, type ValleyPluginApi } from '@valley/plugin-sdk'
import type { FileBaseline } from '@valley/plugin-sdk/types'
import { EMPTY_SCENE_JSON } from './emptyScene'
import { normalizeRelPathOpt } from '@valley/plugin-sdk/paths'
import { drawingDraft, drawingSession } from './session'
import type { RawScene } from './island'
import { isDrawingPath, readScene, writeScene } from './formats'

/** Parent folder of the active file (or vault root when nothing is open). */
function activeFolder(api: ValleyPluginApi): string {
  const active = api.getState().activePath
  if (!active) return ''
  const slash = active.lastIndexOf('/')
  return slash > 0 ? active.slice(0, slash) : ''
}

/** Atomically create the first free `Untitled[.n].excalidraw` in `folder`. */
async function createDrawingFile(
  api: ValleyPluginApi,
  folder: string
): Promise<{ relPath: string; baseline: FileBaseline }> {
  const prefix = folder ? `${folder}/` : ''
  for (let n = 0; n < 1000; n++) {
    const name = n === 0 ? 'Untitled.excalidraw' : `Untitled ${n + 1}.excalidraw`
    const relPath = `${prefix}${name}`
    const written = await api.vault.writeFileGuarded(relPath, EMPTY_SCENE_JSON, null)
    if (written.ok) return { relPath, baseline: written.baseline }
    if (written.reason === 'error') throw new Error(`Could not create ${relPath}`)
  }
  throw new Error(`Could not find a free drawing name in ${folder || 'the vault root'}`)
}

/**
 * `excalidraw:create` — write an empty `.excalidraw` next to the active file and
 * open it. Undo removes only the exact baseline created here; an edited file wins.
 */
export function registerExcalidrawCommands(api: ValleyPluginApi): () => void {
  const offCreate = api.commands.register<{ folder?: string }, { relPath: string }, 'write'>({
    id: 'create',
    label: 'Excalidraw: New drawing', labelKey: 'auto.78a7802d9bd6',
    sideEffect: 'write',
    revision: ({ folder }) => ({ folder: folder ?? activeFolder(api) }),
    preview: ({ folder }) => ({ action: 'create-drawing', folder: folder ?? activeFolder(api) }),
    input: { schema: { type: 'object', properties: { folder: { type: 'string' } }, additionalProperties: false }, parse: (raw) => { const folder = (raw as { folder?: unknown } | undefined)?.folder; if (folder !== undefined && (typeof folder !== 'string' || (folder && normalizeRelPathOpt(folder) !== folder))) throw new Error('Expected a vault folder.'); return { folder: folder as string | undefined } } },
    run: async ({ folder }) => {
      const { relPath, baseline } = await createDrawingFile(api, folder ?? activeFolder(api))
      await api.workspace.openFile(relPath)
      return {
        value: { relPath },
        revert: guardedCreatedFileRevert(
          api.vault,
          relPath,
          EMPTY_SCENE_JSON,
          baseline,
          'Create Excalidraw drawing'
        )
      }
    }
  })
  const offGet = api.commands.register({ id: 'get', label: 'Excalidraw: Inspect drawing', labelKey: 'excalidraw.command.get', paletteSafe: false, sideEffect: 'read', input: { schema: { type: 'object', properties: { path: stringSchema }, required: ['path'], additionalProperties: false }, parse: (raw) => ({ path: drawingPath((raw as Record<string, unknown>)?.path) }) }, run: async ({ path }) => { const drawing = await readDrawing(api, path); return { path, scene: drawing.scene, revision: drawing.revision, view: drawing.view ?? null } } })
  const offUpdate = api.commands.register({ id: 'scene-update', label: 'Excalidraw: Update scene', labelKey: 'excalidraw.command.update', paletteSafe: false, sideEffect: 'write', input: { schema: { type: 'object', properties: { path: stringSchema, expectedRevision: { type: 'string' }, scene: drawingSceneSchema }, required: ['path', 'scene', 'expectedRevision'], additionalProperties: false }, parse: (raw) => { const input = raw as Record<string, unknown>; if (!input || typeof input.expectedRevision !== 'string') throw new Error('Inspect the drawing and provide its revision.'); return { path: drawingPath(input.path), scene: parseDrawingScene(input.scene), expectedRevision: input.expectedRevision } } }, revision: async ({ path }) => (await readDrawing(api, path)).revision, preview: ({ path, scene }) => ({ path, scene }), run: ({ path, scene, expectedRevision }) => updateDrawing(api, path, scene, expectedRevision) })
  return () => { offCreate(); offGet(); offUpdate() }

}

const stringSchema = { type: 'string', minLength: 1 }
export const drawingSceneSchema = { type: 'object', additionalProperties: false, properties: {
  elements: { type: 'array', items: { type: 'object', required: ['id', 'type', 'x', 'y', 'width', 'height'], properties: { id: stringSchema, type: stringSchema, x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number', minimum: 0 }, height: { type: 'number', minimum: 0 } } } },
  appState: { type: 'object' }, files: { type: 'object' }
} }
export function parseDrawingScene(raw: unknown): RawScene {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected an Excalidraw scene.')
  const scene = raw as Record<string, unknown>
  if (Object.keys(scene).some((key) => !['elements', 'appState', 'files'].includes(key))) throw new Error('Unsupported scene property.')
  if (scene.elements !== undefined) {
    if (!Array.isArray(scene.elements)) throw new Error('Expected a scene element array.')
    const seen = new Set<string>()
    for (const rawElement of scene.elements) {
      if (!rawElement || typeof rawElement !== 'object' || Array.isArray(rawElement)) throw new Error('Invalid scene element.')
      const element = rawElement as Record<string, unknown>
      if (typeof element.id !== 'string' || !element.id || seen.has(element.id) || typeof element.type !== 'string' || !element.type) throw new Error('Invalid or duplicate scene element id.')
      seen.add(element.id)
      for (const key of ['x', 'y', 'width', 'height']) if (typeof element[key] !== 'number' || !Number.isFinite(element[key]) || (['width', 'height'].includes(key) && Number(element[key]) < 0)) throw new Error('Invalid scene geometry.')
    }
  }
  for (const key of ['appState', 'files']) if (scene[key] !== undefined && (!scene[key] || typeof scene[key] !== 'object' || Array.isArray(scene[key]))) throw new Error(`Expected scene ${key}.`)
  return scene as RawScene
}
function drawingPath(raw: unknown): string { if (typeof raw !== 'string' || !isDrawingPath(raw) || normalizeRelPathOpt(raw) !== raw) throw new Error('Expected a vault-relative drawing path.'); return raw }
export async function readDrawing(api: ValleyPluginApi, path: string) {
  drawingPath(path)
  const session = drawingSession(path)
  if (session) { const snapshot = session.get(); return { scene: snapshot.scene, revision: snapshot.revision, baseline: null, session, view: snapshot.view } }
  if (drawingDraft(path)) throw new Error('The drawing has an unsaved draft. Reopen it and resolve the save error before editing.')
  const file = await api.vault.readFileBaseline(path)
  if (!file) throw new Error('The drawing file no longer exists.')
  const scene = await readScene(path, file.content, document, api)
  return { scene, revision: file.content, baseline: file.baseline, session: undefined, view: undefined }
}
export async function updateDrawing(api: ValleyPluginApi, path: string, scene: RawScene, expectedRevision: string) {
  const current = await readDrawing(api, path)
  if (current.revision !== expectedRevision) throw new Error('The drawing changed. Inspect it again before editing.')
  if (current.session) {
    await current.session.commit(scene, expectedRevision)
    const next = current.session.get()
    return { value: { path, scene: next.scene, revision: next.revision }, revert: null }
  }
  const next = { ...current.scene, ...scene, appState: { ...current.scene.appState, ...scene.appState } }
  const json = JSON.stringify(next, null, 2)
  const content = await writeScene(path, json, document, api)
  const result = await api.vault.writeFileGuarded(path, content, current.baseline)
  if (!result.ok) throw new Error('The drawing changed or could not be saved. The edit was not applied.')
  const restore = async (content: string, expected: string): Promise<void> => {
    const latest = await readDrawing(api, path)
    if (latest.revision !== expected) throw new Error('The drawing changed after this edit. Undo would overwrite newer work.')
    if (latest.session) await latest.session.commit(await readScene(path, content, document, api), expected)
    else if (!(await api.vault.writeFileGuarded(path, content, latest.baseline)).ok) throw new Error('Could not restore the drawing.')
  }
  return { value: { path, scene: next, revision: content }, revert: { label: 'Edit drawing', run: () => restore(current.revision, content), reapply: () => restore(content, current.revision) } }
}
