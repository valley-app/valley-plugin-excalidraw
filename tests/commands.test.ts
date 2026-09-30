import { PLUGIN_SURFACE_V1 } from '@valley/plugin-sdk'
import { registerDrawingSurfaces } from '../src/surfaces'
import { initRuntime } from '../src/runtime'
import { pendingDrawingView, registerDrawingSession, saveDrawingDraft } from '../src/session'
import { describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { readDrawing, updateDrawing, parseDrawingScene, registerExcalidrawCommands } from '../src/commands'
import { EMPTY_SCENE_JSON } from '../src/emptyScene'

describe('excalidraw:create', () => {
  it('creates with guarded undo and redo', async () => {
    const mock = createMockValleyApi({
      manifest: { id: 'excalidraw' },
      activePath: 'Drawings/Index.md',
      files: { 'Drawings/Untitled.excalidraw': 'occupied' }
    })
    registerExcalidrawCommands(mock.api)

    expect(mock.commands.find((command) => command.id === 'create')?.sideEffect).toBe('write')
    const result = await mock.api.commands.execute('excalidraw:create')

    expect(result).toEqual({ ok: true, value: { relPath: 'Drawings/Untitled 2.excalidraw' } })
    expect(mock.api.vault.writeFile).not.toHaveBeenCalled()
    expect(mock.api.vault.writeFileGuarded).toHaveBeenNthCalledWith(
      1,
      'Drawings/Untitled.excalidraw',
      EMPTY_SCENE_JSON,
      null
    )
    expect(mock.api.vault.writeFileGuarded).toHaveBeenNthCalledWith(
      2,
      'Drawings/Untitled 2.excalidraw',
      EMPTY_SCENE_JSON,
      null
    )
    expect(mock.api.workspace.openFile).toHaveBeenCalledWith('Drawings/Untitled 2.excalidraw')
    expect(mock.busUndo).toHaveLength(1)
    await mock.busUndo[0].undo()
    expect(await mock.api.vault.stat('Drawings/Untitled 2.excalidraw')).toBeNull()
    await mock.busUndo[0].redo?.()
    expect(await mock.api.vault.readFile('Drawings/Untitled 2.excalidraw')).toBe(EMPTY_SCENE_JSON)
  })

  it('does not open a file when the guarded write fails', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'excalidraw' } })
    vi.mocked(mock.api.vault.writeFileGuarded).mockResolvedValueOnce({ ok: false, reason: 'error' })
    registerExcalidrawCommands(mock.api)

    const result = await mock.api.commands.execute('excalidraw:create')

    expect(result).toMatchObject({ ok: false, error: { kind: 'threw' } })
    expect(mock.api.workspace.openFile).not.toHaveBeenCalled()
  })

  it('refuses undo after the created file was edited', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'excalidraw' } })
    registerExcalidrawCommands(mock.api)
    await mock.api.commands.execute('excalidraw:create')
    await mock.api.vault.writeFile('Untitled.excalidraw', 'edited')

    await expect(mock.busUndo[0].undo()).rejects.toThrow('Refusing to remove edited file')
    expect(await mock.api.vault.readFile('Untitled.excalidraw')).toBe('edited')
  })
})


describe('explicit drawing updates', () => {
  const scene = { elements: [{ id: 'shape', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 }], appState: { viewBackgroundColor: '#ffffff' }, files: {} }
  const setup = () => { const mock = createMockValleyApi({ manifest: { id: 'excalidraw' }, activePath: 'Other.excalidraw', files: { 'Board.excalidraw': JSON.stringify(scene), 'Other.excalidraw': EMPTY_SCENE_JSON } }); initRuntime(mock.api); registerExcalidrawCommands(mock.api); return mock }

  it('updates the explicit file with a baseline and reversible history', async () => {
    const mock = setup()
    const before = await readDrawing(mock.api, 'Board.excalidraw')
    const result = await updateDrawing(mock.api, 'Board.excalidraw', { appState: { viewBackgroundColor: '#000000' } }, before.revision)
    expect(result.value.scene).toMatchObject({ elements: scene.elements, appState: { viewBackgroundColor: '#000000' } })
    expect(await mock.api.vault.readFile('Other.excalidraw')).toBe(EMPTY_SCENE_JSON)
    await result.revert!.run()
    expect(await mock.api.vault.readFile('Board.excalidraw')).toBe(before.revision)
    await result.revert!.reapply()
    await mock.api.vault.writeFile('Board.excalidraw', EMPTY_SCENE_JSON)
    await expect(result.revert!.run()).rejects.toThrow('newer work')
  })

  it('rejects stale revisions, invalid scene geometry, and closed unsaved drafts', async () => {
    const mock = setup()
    await expect(updateDrawing(mock.api, 'Board.excalidraw', {}, 'stale')).rejects.toThrow('changed')
    expect(() => parseDrawingScene({ elements: [{ ...scene.elements[0], width: -1 }] })).toThrow('geometry')
    saveDrawingDraft('Board.excalidraw', { json: JSON.stringify(scene), baseline: null, error: 'conflict' })
    await expect(updateDrawing(mock.api, 'Board.excalidraw', {}, JSON.stringify(scene))).rejects.toThrow('unsaved draft')
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
  })

  it('restores a background view without changing focus and refuses deleted selections', async () => {
    const mock = setup()
    const off = registerDrawingSurfaces(mock.api)
    const surface = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1)[0].extension
    await surface.restore({ v: 1, path: 'Board.excalidraw', selectedIds: ['shape'], scrollX: 12, zoom: 2 }, 'Board.excalidraw', { background: true })
    expect(mock.api.workspace.openFile).not.toHaveBeenCalled()
    expect(pendingDrawingView('Board.excalidraw')).toMatchObject({ selectedIds: ['shape'], scrollX: 12, zoom: 2 })
    await expect(surface.restore({ v: 1, path: 'Board.excalidraw', selectedIds: ['missing'] })).rejects.toThrow('no longer exists')
    off()
  })

  it('binds a scene update preview to the exact file revision', async () => {
    const mock = setup()
    const command = mock.commands.find((entry) => entry.id === 'scene-update')!
    const input = command.input!.parse({ path: 'Board.excalidraw', expectedRevision: JSON.stringify(scene), scene: { elements: [] } })
    const before = await command.revision!(input)
    expect(command.preview!(input)).toEqual({ path: 'Board.excalidraw', scene: { elements: [] } })
    await mock.api.vault.writeFile('Board.excalidraw', EMPTY_SCENE_JSON)
    expect(await command.revision!(input)).not.toBe(before)
  })

  it('routes live changes through the native editor history without a second undo entry', async () => {
    const mock = setup()
    let current = scene
    const commit = vi.fn(async (patch) => { current = { ...current, ...patch } })
    const off = registerDrawingSession('Board.excalidraw', { get: () => ({ scene: current, revision: JSON.stringify(current), error: '', view: { selectedIds: ['shape'], scrollX: 0, scrollY: 0, zoom: 1, readOnly: false } }), commit, restore: vi.fn() })
    const result = await mock.api.commands.execute('excalidraw:scene-update', { path: 'Board.excalidraw', expectedRevision: JSON.stringify(scene), scene: { appState: { viewBackgroundColor: '#000000' } } })
    expect(result.ok).toBe(true)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
    expect(mock.busUndo).toHaveLength(0)
    off()
  })
})
