import Ajv from 'ajv'
import { PLUGIN_SURFACE_V1 } from '@valley/plugin-sdk'
import { registerDrawingSurfaces } from '../src/surfaces'
import { initRuntime } from '../src/runtime'
import { adoptDrawingDraft, claimDrawingDraftOwner, drawingDraft, orphanedDrawingDraftOwners, pendingDrawingView, registerDrawingSession, saveDrawingDraft } from '../src/session'
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
  it('validates every semantic result and observes the selected file and exact restoration', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'excalidraw' }, files: { 'Board.excalidraw': EMPTY_SCENE_JSON } })
    initRuntime(mock.api)
    const registrations = vi.spyOn(mock.api.commands, 'register')
    const off = registerExcalidrawCommands(mock.api)
    const offSurfaces = registerDrawingSurfaces(mock.api)
    const seen = new Set<string>()
    try {
      const commands = registrations.mock.calls.map(([value]) => value as typeof value & { outputSchema: Record<string, unknown> })
      expect(commands).toHaveLength(4)
      const ajv = new Ajv({ strict: false, strictSchema: true, allErrors: true })
      const call = async (id: string, input?: unknown) => {
        const result = await mock.api.commands.execute(`excalidraw:${id}`, input)
        expect(result.ok, id).toBe(true)
        if (!result.ok) throw new Error(JSON.stringify(result))
        const validate = ajv.compile(commands.find(command => command.id === id)!.outputSchema)
        expect(validate(result.value), `${id}: ${JSON.stringify(validate.errors)}`).toBe(true)
        expect(validate({ ...(result.value as Record<string, unknown>), unexpected: true }), id).toBe(false)
        seen.add(id)
        return result.value as Record<string, unknown>
      }
      await call('create', {})
      expect(await mock.api.vault.readFile('Untitled.excalidraw')).toBe(EMPTY_SCENE_JSON)
      await mock.busUndo.at(-1)!.undo()
      expect(await mock.api.vault.stat('Untitled.excalidraw')).toBeNull()
      const baseline = await call('get', { path: 'Board.excalidraw' })
      await call('scene-update', { path: 'Board.excalidraw', expectedRevision: baseline.revision, scene: { elements: [{ id: 'fern', type: 'rectangle', x: 0, y: 0, width: 10, height: 20, locked: false, customData: { generationData: { status: 'done', html: '<p>Canopy</p>' } } }], appState: { gridSize: 0, gridModeEnabled: false } } })
      expect(JSON.parse((await mock.api.vault.readFile('Board.excalidraw'))!)).toMatchObject({ elements: [{ id: 'fern', locked: false }], appState: { gridSize: 0, gridModeEnabled: false } })
      await mock.busUndo.at(-1)!.undo()
      expect(await mock.api.vault.readFile('Board.excalidraw')).toBe(EMPTY_SCENE_JSON)
      await call('open', { path: 'Board.excalidraw', scrollX: 0, zoom: 1, selectedIds: [] })
      expect(mock.api.workspace.openFile).toHaveBeenCalledWith('Board.excalidraw')
      expect([...seen].sort()).toEqual(commands.map(command => command.id).sort())
    } finally { offSurfaces(); off() }
  })

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
    saveDrawingDraft('Board.excalidraw', 'closed-copy', { json: JSON.stringify(scene), baseline: null, error: 'conflict' })
    await expect(updateDrawing(mock.api, 'Board.excalidraw', {}, JSON.stringify(scene))).rejects.toThrow('unsaved draft')
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
  })

  it('refuses a file-level edit or undo through an open copy while a closed copy\'s draft is retained', async () => {
    const mock = setup()
    const edited = await updateDrawing(mock.api, 'Board.excalidraw', { appState: { viewBackgroundColor: '#000000' } }, JSON.stringify(scene))
    const written = await mock.api.vault.readFile('Board.excalidraw')
    const open = { get: () => ({ scene, revision: written, error: '', view: { selectedIds: [], scrollX: 0, scrollY: 0, zoom: 1, readOnly: false } }), commit: vi.fn(), restore: vi.fn() }
    const release = claimDrawingDraftOwner('Board.excalidraw', 'open-copy'), off = registerDrawingSession('Board.excalidraw', open)
    try {
      // The open copy's own draft is its live state, not a blocker.
      saveDrawingDraft('Board.excalidraw', 'open-copy', { json: JSON.stringify(scene), baseline: null, error: '' })
      await updateDrawing(mock.api, 'Board.excalidraw', {}, written)
      expect(open.commit).toHaveBeenCalledTimes(1)
      saveDrawingDraft('Board.excalidraw', 'closed-copy', { json: JSON.stringify(scene), baseline: null, error: 'conflict' })
      await expect(updateDrawing(mock.api, 'Board.excalidraw', {}, written)).rejects.toMatchObject({ message: expect.stringContaining('unsaved draft'), code: 'REVISION_CONFLICT', outcome: 'not-applied' })
      await expect(edited.revert!.run()).rejects.toMatchObject({ code: 'REVISION_CONFLICT', outcome: 'not-applied' })
      expect(open.commit).toHaveBeenCalledTimes(1)
      expect(await mock.api.vault.readFile('Board.excalidraw')).toBe(written)
      expect(drawingDraft('Board.excalidraw', 'closed-copy')?.error).toBe('conflict')
    } finally { off(); release(); saveDrawingDraft('Board.excalidraw', 'open-copy', null); saveDrawingDraft('Board.excalidraw', 'closed-copy', null) }
  })

  it('resumes the newest closed copy\'s draft without dropping older closed drafts', () => {
    setup()
    const draft = (error: string) => ({ json: JSON.stringify(scene), baseline: null, error })
    saveDrawingDraft('Board.excalidraw', 'older-copy', draft('older'))
    saveDrawingDraft('Board.excalidraw', 'newer-copy', draft('newer'))
    const release = claimDrawingDraftOwner('Board.excalidraw', 'reopened')
    try {
      expect(adoptDrawingDraft('Board.excalidraw', 'reopened')?.error).toBe('newer')
      expect(drawingDraft('Board.excalidraw', 'newer-copy')).toBeUndefined()
      expect(drawingDraft('Board.excalidraw', 'older-copy')?.error).toBe('older')
      expect(orphanedDrawingDraftOwners('Board.excalidraw')).toEqual(['older-copy'])
      expect(adoptDrawingDraft('Board.excalidraw', 'second')?.error).toBe('older')
      expect(drawingDraft('Board.excalidraw', 'reopened')?.error).toBe('newer')
    } finally { release(); saveDrawingDraft('Board.excalidraw', 'reopened', null); saveDrawingDraft('Board.excalidraw', 'second', null) }
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

  it('opens a closed drawing whose unsaved draft is retained, validating against the draft it resumes', async () => {
    const mock = setup()
    const offSurfaces = registerDrawingSurfaces(mock.api)
    const draftScene = { ...scene, elements: [...scene.elements, { id: 'drafted', type: 'ellipse', x: 5, y: 5, width: 10, height: 10 }] }
    saveDrawingDraft('Board.excalidraw', 'closed-copy', { json: JSON.stringify(draftScene), baseline: null, error: 'conflict' })
    const command = mock.commands.find((entry) => entry.id === 'open')!
    try {
      await command.run(command.input!.parse({ path: 'Board.excalidraw', selectedIds: ['drafted'], zoom: 2 }), { caller: 'plugin' })
      expect(mock.api.workspace.openFile).toHaveBeenCalledWith('Board.excalidraw')
      expect(pendingDrawingView('Board.excalidraw')).toEqual({ selectedIds: ['drafted'], zoom: 2 })
      expect(drawingDraft('Board.excalidraw', 'closed-copy')?.json).toBe(JSON.stringify(draftScene))
      expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
      await expect(command.run(command.input!.parse({ path: 'Board.excalidraw', selectedIds: ['missing'] }), { caller: 'plugin' })).rejects.toThrow('no longer exists')
      expect(mock.api.workspace.openFile).toHaveBeenCalledTimes(1)
    } finally { offSurfaces(); saveDrawingDraft('Board.excalidraw', 'closed-copy', null) }
  })

  it('refuses to open a drawing view when more than one same-path view could receive it', async () => {
    const mock = setup()
    const offSurfaces = registerDrawingSurfaces(mock.api)
    const view = { selectedIds: [], scrollX: 0, scrollY: 0, zoom: 1, readOnly: false }
    const pane = () => ({ get: () => ({ scene, revision: JSON.stringify(scene), error: '', view }), commit: vi.fn(), restore: vi.fn() })
    const left = pane(), right = pane()
    const offLeft = registerDrawingSession('Board.excalidraw', left), offRight = registerDrawingSession('Board.excalidraw', right)
    const command = mock.commands.find((entry) => entry.id === 'open')!
    const input = command.input!.parse({ path: 'Board.excalidraw', selectedIds: ['shape'], scrollX: 12, zoom: 2 })
    try {
      await expect(command.run(input, { caller: 'plugin' })).rejects.toMatchObject({ code: 'AMBIGUOUS_TARGET', outcome: 'not-applied', retryable: false })
      expect(left.restore).not.toHaveBeenCalled(); expect(right.restore).not.toHaveBeenCalled()
      expect(mock.api.workspace.openFile).not.toHaveBeenCalled()
      expect(pendingDrawingView('Board.excalidraw')).toBeUndefined()
      offRight()
      await command.run(input, { caller: 'plugin' })
      expect(left.restore).toHaveBeenCalledWith({ selectedIds: ['shape'], scrollX: 12, zoom: 2 })
      expect(mock.api.workspace.openFile).toHaveBeenCalledWith('Board.excalidraw')
    } finally { offLeft(); offRight(); offSurfaces() }
  })

  it('opens a drawing view into one exact mounted view while several same-path views show it', async () => {
    const mock = setup()
    const offSurfaces = registerDrawingSurfaces(mock.api)
    const view = { selectedIds: [], scrollX: 0, scrollY: 0, zoom: 1, readOnly: false }
    const pane = () => ({ get: () => ({ scene, revision: JSON.stringify(scene), error: '', view }), commit: vi.fn(), restore: vi.fn() })
    const left = pane(), right = pane(), leftView = { mountId: 'left', generation: 1, area: 'main' as const, paneId: 'left-pane', tabId: 'left-tab', filePath: 'Board.excalidraw', pluginId: 'excalidraw' }
    const offLeft = registerDrawingSession('Board.excalidraw', left, leftView), offRight = registerDrawingSession('Board.excalidraw', right, { ...leftView, mountId: 'right', paneId: 'right-pane', tabId: 'right-tab' })
    const command = mock.commands.find((entry) => entry.id === 'open')!
    const validate = new Ajv({ strict: false }).compile(command.input!.schema!)
    try {
      expect(validate({ path: 'Board.excalidraw', mountedView: leftView, selectedIds: ['shape'] })).toBe(true)
      expect(validate({ path: 'Board.excalidraw', mountedView: { ...leftView, extra: true } })).toBe(false)
      expect(() => command.input!.parse({ path: 'Board.excalidraw', mountedView: { ...leftView, generation: -1 } })).toThrow('exact mounted')
      const result = await command.run(command.input!.parse({ path: 'Board.excalidraw', mountedView: leftView, selectedIds: ['shape'], scrollX: 12, zoom: 2 }), { caller: 'agent' })
      expect(result).toEqual({ v: 1, path: 'Board.excalidraw', selectedIds: ['shape'], scrollX: 12, zoom: 2 })
      expect(left.restore).toHaveBeenCalledWith({ selectedIds: ['shape'], scrollX: 12, zoom: 2 }); expect(right.restore).not.toHaveBeenCalled()
      expect(mock.api.workspace.openFile).not.toHaveBeenCalled()
      for (const input of [{ path: 'Board.excalidraw', mountedView: { ...leftView, generation: 2 } }, { path: 'Other.excalidraw', mountedView: leftView }, { path: 'Board.excalidraw', mountedView: leftView, selectedIds: ['missing'] }]) await expect(command.run(command.input!.parse(input), { caller: 'agent' })).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND', outcome: 'not-applied' })
      expect(left.restore).toHaveBeenCalledTimes(1); expect(right.restore).not.toHaveBeenCalled(); expect(mock.api.workspace.openFile).not.toHaveBeenCalled()
      await expect(command.run(command.input!.parse({ path: 'Board.excalidraw', selectedIds: ['shape'] }), { caller: 'agent' })).rejects.toMatchObject({ code: 'AMBIGUOUS_TARGET', outcome: 'not-applied' })
    } finally { offLeft(); offRight(); offSurfaces() }
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
