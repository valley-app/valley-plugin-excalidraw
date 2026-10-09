import { guardedCreatedFileRevert, type PluginCommand, type ValleyPluginApi } from '@valley/plugin-sdk'
import type { FileBaseline } from '@valley/plugin-sdk/types'
import { EMPTY_SCENE_JSON } from './emptyScene'
import { normalizeRelPathOpt } from '@valley/plugin-sdk/paths'
import { drawingDraft, drawingSession, orphanedDrawingDraftOwners } from './session'
import type { RawScene } from './island'
import { isDrawingPath, parseScene, readScene, writeScene } from './formats'

const resultText = { type: 'string', maxLength: 16777216 }
const resultNumber = { type: 'number' }
const resultFlag = { type: 'boolean' }
const resultObject = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })
const resultArray = (items: Record<string, unknown>, maxItems = 10000) => ({ type: 'array', items, maxItems })
const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] })
const pointResult = { type: 'array', items: resultNumber, minItems: 2, maxItems: 2 }
const bindingResult = nullable(resultObject({ elementId: resultText, focus: resultNumber, gap: resultNumber, fixedPoint: pointResult }, ['elementId', 'focus', 'gap']))
const elementResult = resultObject({
  id: resultText, type: { enum: ['rectangle', 'diamond', 'ellipse', 'embeddable', 'iframe', 'image', 'frame', 'magicframe', 'text', 'line', 'arrow', 'freedraw'] },
  x: resultNumber, y: resultNumber, width: resultNumber, height: resultNumber, angle: resultNumber,
  strokeColor: resultText, backgroundColor: resultText, fillStyle: { enum: ['hachure', 'cross-hatch', 'solid', 'zigzag'] }, strokeWidth: resultNumber, strokeStyle: { enum: ['solid', 'dashed', 'dotted'] },
  roundness: nullable(resultObject({ type: { type: 'integer' }, value: resultNumber }, ['type'])), roughness: resultNumber, opacity: resultNumber,
  seed: resultNumber, version: resultNumber, versionNonce: resultNumber, index: nullable(resultText), isDeleted: resultFlag,
  groupIds: resultArray(resultText), frameId: nullable(resultText), boundElements: nullable(resultArray(resultObject({ id: resultText, type: { enum: ['arrow', 'text'] } }, ['id', 'type']))), updated: resultNumber, link: nullable(resultText), locked: resultFlag,
  customData: { type: 'object', maxProperties: 512, additionalProperties: { $ref: '#/$defs/customDataValue' } },
  fontSize: resultNumber, fontFamily: { type: 'integer' }, text: resultText, textAlign: { enum: ['left', 'center', 'right'] }, verticalAlign: { enum: ['top', 'middle', 'bottom'] }, containerId: nullable(resultText), originalText: resultText, autoResize: resultFlag, lineHeight: resultNumber,
  points: resultArray(pointResult), lastCommittedPoint: nullable(pointResult), startBinding: bindingResult, endBinding: bindingResult, startArrowhead: nullable(resultText), endArrowhead: nullable(resultText), elbowed: resultFlag,
  fixedSegments: nullable(resultArray(resultObject({ start: pointResult, end: pointResult, index: { type: 'integer' } }, ['start', 'end', 'index']))), startIsSpecial: nullable(resultFlag), endIsSpecial: nullable(resultFlag),
  pressures: resultArray(resultNumber), simulatePressure: resultFlag,
  fileId: nullable(resultText), status: { enum: ['pending', 'saved', 'error'] }, scale: pointResult, crop: nullable(resultObject({ x: resultNumber, y: resultNumber, width: resultNumber, height: resultNumber, naturalWidth: resultNumber, naturalHeight: resultNumber }, ['x', 'y', 'width', 'height', 'naturalWidth', 'naturalHeight'])), name: nullable(resultText)
}, ['id', 'type'])
const binaryFileResult = resultObject({ mimeType: resultText, id: resultText, dataURL: resultText, created: resultNumber, lastRetrieved: resultNumber, version: resultNumber }, ['mimeType', 'id', 'dataURL', 'created'])
const sceneResult = resultObject({ type: { const: 'excalidraw' }, version: { type: 'integer' }, source: resultText, elements: resultArray(elementResult), appState: resultObject({ gridSize: nullable(resultNumber), gridStep: resultNumber, gridModeEnabled: resultFlag, viewBackgroundColor: resultText }), files: { type: 'object', maxProperties: 10000, additionalProperties: binaryFileResult } }, ['elements'])
const viewResult = resultObject({ selectedIds: resultArray(resultText, 512), scrollX: resultNumber, scrollY: resultNumber, zoom: resultNumber, readOnly: resultFlag }, ['selectedIds', 'scrollX', 'scrollY', 'zoom', 'readOnly'])
const drawingOutput = (view: boolean) => ({ ...resultObject({ path: resultText, scene: sceneResult, revision: resultText, ...(view ? { view: nullable(viewResult) } : {}) }, ['path', 'scene', 'revision', ...(view ? ['view'] : [])]), $defs: { customDataValue: { anyOf: [resultText, resultNumber, resultFlag, { type: 'null' }, resultArray({ $ref: '#/$defs/customDataValue' }, 512), { type: 'object', maxProperties: 512, additionalProperties: { $ref: '#/$defs/customDataValue' } }] } } })

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
  const register = <I, O, E extends 'read' | 'write' | 'execute'>(command: PluginCommand<I, O, E> & { outputSchema: Record<string, unknown> }) => api.commands.register(command)
  const offCreate = register<{ folder?: string }, { relPath: string }, 'write'>({
    id: 'create',
    outputSchema: resultObject({ relPath: resultText }, ['relPath']),
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
  const offGet = register({ id: 'get', outputSchema: drawingOutput(true), label: 'Excalidraw: Inspect drawing', labelKey: 'excalidraw.command.get', paletteSafe: false, sideEffect: 'read', input: { schema: { type: 'object', properties: { path: stringSchema }, required: ['path'], additionalProperties: false }, parse: (raw) => ({ path: drawingPath((raw as Record<string, unknown>)?.path) }) }, run: async ({ path }) => { const drawing = await readDrawing(api, path); return { path, scene: drawing.scene, revision: drawing.revision, view: drawing.view ?? null } } })
  const offUpdate = register({ id: 'scene-update', outputSchema: drawingOutput(false), label: 'Excalidraw: Update scene', labelKey: 'excalidraw.command.update', paletteSafe: false, sideEffect: 'write', input: { schema: { type: 'object', properties: { path: stringSchema, expectedRevision: { type: 'string' }, scene: drawingSceneSchema }, required: ['path', 'scene', 'expectedRevision'], additionalProperties: false }, parse: (raw) => { const input = raw as Record<string, unknown>; if (!input || typeof input.expectedRevision !== 'string') throw new Error('Inspect the drawing and provide its revision.'); return { path: drawingPath(input.path), scene: parseDrawingScene(input.scene), expectedRevision: input.expectedRevision } } }, revision: async ({ path }) => (await readDrawing(api, path)).revision, preview: ({ path, scene }) => ({ path, scene }), run: ({ path, scene, expectedRevision }) => updateDrawing(api, path, scene, expectedRevision) })
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
const unsavedDraft = () => Object.assign(new Error('The drawing has an unsaved draft. Reopen it and resolve the save error before editing.'), { code: 'REVISION_CONFLICT', outcome: 'not-applied', retryable: false })
/** Read `path` for an edit: a closed copy's retained draft is unsaved work no open copy holds, so never edit past it through another copy. */
async function readDrawingForEdit(api: ValleyPluginApi, path: string) {
  drawingPath(path)
  if (orphanedDrawingDraftOwners(path).length) throw unsavedDraft()
  return readDrawing(api, path)
}
export async function readDrawing(api: ValleyPluginApi, path: string) {
  drawingPath(path)
  const session = drawingSession(path)
  if (session) { const snapshot = session.get(); return { scene: snapshot.scene, revision: snapshot.revision, baseline: null, session, view: snapshot.view } }
  if (drawingDraft(path)) throw unsavedDraft()
  const file = await api.vault.readFileBaseline(path)
  if (!file) throw new Error('The drawing file no longer exists.')
  const scene = await readScene(path, file.content, document, api)
  return { scene, revision: file.content, baseline: file.baseline, session: undefined, view: undefined }
}
/** The scene opening `path` shows: the open copy's, else the closed copy's draft a reopened mount resumes, else the file. */
export async function readDrawingForOpen(api: ValleyPluginApi, path: string): Promise<{ scene: RawScene }> {
  drawingPath(path)
  const session = drawingSession(path)
  if (session) return { scene: session.get().scene }
  const resumed = orphanedDrawingDraftOwners(path).at(-1)
  const draft = resumed === undefined ? undefined : drawingDraft(path, resumed)
  if (draft) return { scene: parseScene(draft.json) }
  const file = await api.vault.readFileBaseline(path)
  if (!file) throw new Error('The drawing file no longer exists.')
  return { scene: await readScene(path, file.content, document, api) }
}
export async function updateDrawing(api: ValleyPluginApi, path: string, scene: RawScene, expectedRevision: string) {
  const current = await readDrawingForEdit(api, path)
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
    const latest = await readDrawingForEdit(api, path)
    if (latest.revision !== expected) throw new Error('The drawing changed after this edit. Undo would overwrite newer work.')
    if (latest.session) await latest.session.commit(await readScene(path, content, document, api), expected)
    else if (!(await api.vault.writeFileGuarded(path, content, latest.baseline)).ok) throw new Error('Could not restore the drawing.')
  }
  return { value: { path, scene: next, revision: content }, revert: { label: 'Edit drawing', run: () => restore(current.revision, content), reapply: () => restore(content, current.revision) } }
}
