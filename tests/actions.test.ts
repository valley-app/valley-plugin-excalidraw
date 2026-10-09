import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { registerDrawingActions, nativeActionNames } from '../src/actions'
import { initRuntime } from '../src/runtime'
import { mountedDrawingSession, registerDrawingSession, type DrawingSession } from '../src/session'
import type { MountedPluginView } from '@valley/plugin-sdk'
import type { DrawingControls } from '../src/islandRuntime'

const mounted: MountedPluginView = { pluginId: 'excalidraw', filePath: 'Board.excalidraw', mountId: 'left', generation: 1, area: 'main', paneId: 'left', tabId: 'board' }
const original = { elements: [{ id: 'shape', type: 'rectangle', x: 0, y: 0, width: 100, height: 50, link: '[[Note.md]]' }], appState: { viewBackgroundColor: '#fff' }, files: {} }
let mock: ReturnType<typeof createMockValleyApi>
let session: DrawingSession
let other: DrawingSession
let view: { selectedIds: string[]; scrollX: number; scrollY: number; zoom: number; readOnly: boolean }
let controls: DrawingControls
let scene = original
beforeEach(() => {
  mock = createMockValleyApi({ manifest: { id: 'excalidraw' }, files: { 'Board.excalidraw': JSON.stringify(original), 'Note.md': 'content' } })
  initRuntime(mock.api)
  vi.spyOn(mock.api.files, 'openExternalUrl').mockResolvedValue(true)
  view = { selectedIds: ['shape'], scrollX: 0, scrollY: 0, zoom: 1, readOnly: false }
  scene = original
  controls = { revision: 'native:1', activeTool: 'selection', toolLocked: false, penMode: false, openMenu: null, dialog: null, sidebar: null, history: { undo: true, redo: false }, values: {}, receipt: null, forms: { 'command-palette': { revision: 'palette:1', value: { open: false } } }, actions: nativeActionNames.map(name => ({ name, enabled: true, viewMode: false })) }
  session = {
    get: () => ({ scene, revision: JSON.stringify(scene), sceneRevision: JSON.stringify(scene) === JSON.stringify(original) ? 'scene:1' : 'scene:2', viewRevision: JSON.stringify(view), view, error: '', ready: true }),
    restore: vi.fn(next => { view = { ...view, ...next } }),
    commit: vi.fn(async (next, _revision, beforeWrite, beforeApply) => { await beforeWrite?.(); beforeApply?.(); scene = { ...scene, ...next } }),
    controls: () => controls,
    action: vi.fn(async (_name, _value, beforePerform, beforeApply) => { beforePerform(); beforeApply(); controls = { ...controls, revision: 'native:2' } }),
    nativeControl: vi.fn(async (id, action, value, beforeEffect) => { await beforeEffect(); if (id === 'command-palette') controls = { ...controls, dialog: { name: 'commandPalette', tab: null }, revision: 'native:2' } }),
    nativeEdit: vi.fn(async (_action, _value, beforeEffect) => { await beforeEffect() }),
    tool: vi.fn(type => { controls = { ...controls, activeTool: type, revision: 'native:2' } }), pen: vi.fn(enabled => { controls = { ...controls, penMode: enabled, revision: 'native:2' } }), toolLock: vi.fn(() => { controls = { ...controls, toolLocked: true, revision: 'native:2' } }), sidebar: vi.fn(open => { controls = { ...controls, sidebar: open ? { name: 'default', tab: 'library' } : null, revision: 'native:2' } }),
    persistence: vi.fn(async () => ({ diskRevision: 'disk:1', draftRevision: 'draft:1', dirty: true, uncertain: false, error: 'conflict' })), lifecycle: vi.fn(async (_name, _disk, _draft, beforeEffect, beforeApply) => { await beforeEffect(); beforeApply() })
  }
  other = { ...session, restore: vi.fn(), action: vi.fn() }
  registerDrawingSession(mounted.filePath, session, mounted)
  registerDrawingSession(mounted.filePath, other, { ...mounted, mountId: 'right', paneId: 'right', tabId: 'other' })
  registerDrawingActions(mock.api)
})
function args(extra: Record<string, unknown> = {}, native = false) {
  const current = session.get()
  return { mountedView: mounted, expectedSceneRevision: current.sceneRevision, expectedViewRevision: current.viewRevision, selectedIds: view.selectedIds, ...(native ? { expectedControlRevision: controls.revision } : {}), ...extra }
}
describe('exact mounted drawing commands', () => {
  it('inspects the explicit left drawing and restores selection, complete viewport, and lock without focus or disk effects', async () => {
    expect(await mock.api.commands.execute('excalidraw:view-inspect', { mountedView: mounted })).toMatchObject({ ok: true, value: { mountedView: mounted, sceneRevision: 'scene:1', controls: { revision: 'native:1' } } })
    expect((await mock.api.commands.execute('excalidraw:selection-set', args({ targetIds: [] }))).ok).toBe(true)
    expect(view.selectedIds).toEqual([])
    expect((await mock.api.commands.execute('excalidraw:viewport-set', args({ scrollX: 12, scrollY: 30, zoom: 2 }))).ok).toBe(true)
    expect(view).toMatchObject({ scrollX: 12, scrollY: 30, zoom: 2 })
    expect((await mock.api.commands.execute('excalidraw:read-only-set', args({ readOnly: true }))).ok).toBe(true)
    expect(view.readOnly).toBe(true)
    expect(other.restore).not.toHaveBeenCalled()
    expect(mock.api.workspace.openFile).not.toHaveBeenCalled()
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
    expect(mock.busUndo).toHaveLength(0)
  })
  it.each(['mountId', 'generation', 'area', 'paneId', 'tabId', 'filePath', 'pluginId'])('refuses changed mount %s and never falls back to the same-file active instance', async key => {
    const result = await mock.api.commands.execute('excalidraw:selection-set', { ...args({ targetIds: [] }), mountedView: { ...mounted, [key]: key === 'generation' ? 2 : key === 'area' ? 'right' : key === 'filePath' ? 'Other.excalidraw' : 'changed' } })
    expect(result.ok).toBe(false)
    expect(session.restore).not.toHaveBeenCalled(); expect(other.restore).not.toHaveBeenCalled()
  })
  it.each(['expectedSceneRevision', 'expectedViewRevision'])('refuses stale %s before effect', async key => {
    expect((await mock.api.commands.execute('excalidraw:viewport-set', { ...args({ scrollX: 1, scrollY: 2, zoom: 2 }), [key]: 'stale' })).ok).toBe(false)
    expect(session.restore).not.toHaveBeenCalled()
  })
  it('revalidates cancellation, authorization, owner, exact source and control state before dispatch', async () => {
    const command = mock.commands.find(command => command.id === 'action-duplicateSelection')!
    const parsed = command.input!.parse(args({}, true))
    await expect(command.run(parsed, { caller: 'plugin', validateBeforeRun: async () => false })).rejects.toMatchObject({ code: 'DENIED', outcome: 'not-applied' })
    await expect(command.run(parsed, { caller: 'plugin', cancellation: { aborted: true } as any })).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(command.run(parsed, { caller: 'plugin', validateBeforeRun: async () => { controls = { ...controls, revision: 'native:changed' }; return true } })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(session.action).not.toHaveBeenCalled()
    initRuntime(createMockValleyApi({ manifest: { id: 'excalidraw' } }).api)
    expect(() => mountedDrawingSession(mounted, mock.api)).toThrow('owner')
    await expect(command.run(parsed, { caller: 'plugin' })).rejects.toMatchObject({ code: 'OWNER_UNAVAILABLE' })
  })
  it('retains a replacement same-file pane after the original pane retires', () => {
    const third = { ...other }
    const off = registerDrawingSession(mounted.filePath, third, { ...mounted, mountId: 'third' })
    expect(mountedDrawingSession(mounted)).toBe(session)
    off()
    expect(mountedDrawingSession(mounted)).toBe(session)
  })
  it('validates native choices, strict payload keys and bounded source before native dispatch', () => {
    const opacity = mock.commands.find(command => command.id === 'action-changeOpacity')!
    for (const value of [NaN, Infinity, -1, 101, '40', { value: 50 }]) expect(() => opacity.input!.parse(args({ value }, true))).toThrow()
    expect(() => opacity.input!.parse(args({ value: 50, arbitrary: true }, true))).toThrow('Unsupported')
    const stroke = mock.commands.find(command => command.id === 'action-changeStrokeColor')!
    expect(() => stroke.input!.parse(args({ value: { currentItemStrokeColor: '#123456', viewModeEnabled: false } }, true))).toThrow('Unsupported')
    expect(session.action).not.toHaveBeenCalled()
  })
  it.each(nativeActionNames)('routes native %s to the exact owner and retains the native history domain', async name => {
    const values: Record<string, unknown> = { changeStrokeColor: { currentItemStrokeColor: '#123456' }, changeBackgroundColor: { currentItemBackgroundColor: '#654321' }, changeViewBackgroundColor: { viewBackgroundColor: '#fff' }, changeFillStyle: 'solid', changeStrokeWidth: 2, changeSloppiness: 1, changeStrokeStyle: 'dashed', changeArrowhead: { position: 'end', type: 'bar' }, changeArrowType: 'sharp', changeOpacity: 50, changeFontSize: 28, changeProjectName: 'Blätter äöüß', changeExportBackground: false, changeExportEmbedScene: true, changeExportScale: 2, exportWithDarkMode: true, changeFontFamily: { currentItemFontFamily: 5 }, changeTextAlign: 'center', changeVerticalAlign: 'middle', changeRoundness: 'round' }
    const result = await mock.api.commands.execute(`excalidraw:action-${name}`, args(Object.hasOwn(values, name) ? { value: values[name] } : {}, true))
    expect(result.ok).toBe(true)
    if (name === 'commandPalette') expect(controls.dialog?.name).toBe('commandPalette'); else expect(session.action).toHaveBeenCalledWith(name, values[name] ?? null, expect.any(Function), expect.any(Function), expect.any(Function))
    expect(other.action).not.toHaveBeenCalled(); expect(mock.busUndo).toHaveLength(0)
  })
  it('reports genuinely disabled native predicates without claiming an effect', async () => {
    controls.actions = controls.actions.map(action => ({ ...action, enabled: action.name !== 'group' }))
    expect(await mock.api.commands.execute('excalidraw:action-group', args({}, true))).toMatchObject({ ok: false })
    expect(session.action).not.toHaveBeenCalled()
  })
  it('reports an accepted native action followed by lost owner as unknown without replay', async () => {
    vi.mocked(session.action!).mockImplementationOnce(async (_name, _value, check, accept) => { check(); accept(); initRuntime(createMockValleyApi({ manifest: { id: 'excalidraw' } }).api) })
    const command = mock.commands.find(command => command.id === 'action-group')!
    await expect(command.run(command.input!.parse(args({}, true)), { caller: 'plugin' })).rejects.toMatchObject({ outcome: 'unknown', retryable: false })
    expect(session.action).toHaveBeenCalledTimes(1)
  })
  it('keeps external native refusals before an authorized effect not-applied and later failures unknown', async () => {
    const command = mock.commands.find(command => command.id === 'action-paste')!
    vi.mocked(session.action!).mockImplementationOnce(async (_name, _value, beforePerform) => { beforePerform(); throw Object.assign(new Error('The native drawing action was cancelled or refused.'), { code: 'NATIVE_ACTION_REFUSED', outcome: 'not-applied' }) })
    await expect(command.run(command.input!.parse(args({}, true)), { caller: 'plugin' })).rejects.toMatchObject({ code: 'NATIVE_ACTION_REFUSED', outcome: 'not-applied' })
    let allowed = true
    vi.mocked(session.action!).mockImplementationOnce(async (_name, _value, beforePerform, _beforeApply, beforeEffect) => { beforePerform(); allowed = false; await beforeEffect!() })
    await expect(command.run(command.input!.parse(args({}, true)), { caller: 'plugin', validateBeforeRun: async () => allowed })).rejects.toMatchObject({ code: 'DENIED', outcome: 'not-applied' })
    vi.mocked(session.action!).mockImplementationOnce(async (_name, _value, beforePerform, _beforeApply, beforeEffect) => { beforePerform(); await beforeEffect!(); throw Object.assign(new Error('The native drawing scene changed after its clipboard effect.'), { code: 'REVISION_CONFLICT', outcome: 'not-applied' }) })
    await expect(command.run(command.input!.parse(args({}, true)), { caller: 'plugin' })).rejects.toMatchObject({ code: 'ACTION_OUTCOME_UNKNOWN', outcome: 'unknown', retryable: false })
  })
  it('keeps an accepted external clipboard effect refused by its owner not-applied only while the drawing observation is unchanged', async () => {
    const command = mock.commands.find(command => command.id === 'action-copy')!
    const refusal = () => Object.assign(new Error('The clipboard text exceeds 8 MiB.'), { code: 'CLIPBOARD_LIMIT', outcome: 'not-applied', effectRefused: true })
    vi.mocked(session.action!).mockImplementationOnce(async (_name, _value, beforePerform, _beforeApply, beforeEffect) => { beforePerform(); await beforeEffect!(); throw refusal() })
    await expect(command.run(command.input!.parse(args({}, true)), { caller: 'plugin' })).rejects.toMatchObject({ code: 'CLIPBOARD_LIMIT', outcome: 'not-applied' })
    vi.mocked(session.action!).mockImplementationOnce(async (_name, _value, beforePerform, _beforeApply, beforeEffect) => { beforePerform(); await beforeEffect!(); controls = { ...controls, activeTool: 'rectangle', revision: 'native:2' }; throw refusal() })
    await expect(command.run(command.input!.parse(args({}, true)), { caller: 'plugin' })).rejects.toMatchObject({ code: 'ACTION_OUTCOME_UNKNOWN', outcome: 'unknown', retryable: false })
  })
  it.each(['selection', 'rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text', 'image', 'eraser', 'embeddable', 'laser', 'frame', 'hand'])('changes the exact native %s tool', async tool => {
    expect((await mock.api.commands.execute(`excalidraw:tool-${tool}`, args({}, true))).ok).toBe(true)
    expect(controls.activeTool).toBe(tool)
    expect(session.tool).toHaveBeenCalledWith(tool, expect.any(Function))
  })
  it('routes native pen, tool lock and library sidebar callbacks', async () => {
    expect((await mock.api.commands.execute('excalidraw:pen-mode-set', args({ enabled: true }, true))).ok).toBe(true)
    expect(controls.penMode).toBe(true)
    expect((await mock.api.commands.execute('excalidraw:tool-lock', args({}, true))).ok).toBe(true)
    expect(controls.toolLocked).toBe(true)
    expect((await mock.api.commands.execute('excalidraw:library-open-set', args({ open: true }, true))).ok).toBe(true)
    expect(controls.sidebar).toEqual({ name: 'default', tab: 'library' })
  })
  it('binds persistence actions to actual disk/draft observations and explicit discard intent', async () => {
    expect(await mock.api.commands.execute('excalidraw:disk-inspect', { mountedView: mounted })).toMatchObject({ ok: true, value: { diskRevision: 'disk:1', draftRevision: 'draft:1' } })
    const retry = await mock.api.commands.execute('excalidraw:retry-save', args({ expectedDiskRevision: 'disk:1', expectedDraftRevision: 'draft:1' }))
    expect(retry.ok).toBe(true)
    expect(session.lifecycle).toHaveBeenCalledWith('retry-save', 'disk:1', 'draft:1', expect.any(Function), expect.any(Function))
    const reload = mock.commands.find(command => command.id === 'reload-disk')!
    expect(() => reload.input!.parse(args({ expectedDiskRevision: 'disk:1', expectedDraftRevision: 'draft:1', discardDraft: false }))).toThrow('choice')
    expect((await mock.api.commands.execute('excalidraw:reload-disk', args({ expectedDiskRevision: 'disk:1', expectedDraftRevision: 'draft:1', discardDraft: true }))).ok).toBe(true)
  })
  it('opens only the exact observed element link and rejects unsafe external targets', async () => {
    vi.spyOn(mock.api.workspace, 'resolveWikilink').mockReturnValue('Note.md')
    expect((await mock.api.commands.execute('excalidraw:element-link-vault-open', args({ elementId: 'shape', link: '[[Note.md]]' }))).ok).toBe(true)
    expect(mock.api.workspace.openFile).toHaveBeenCalledWith('Note.md')
    expect((await mock.api.commands.execute('excalidraw:element-link-vault-open', args({ elementId: 'shape', link: '[[Other.md]]' }))).ok).toBe(false)
    scene = { ...scene, elements: [{ ...scene.elements[0], link: 'javascript:alert(1)' }] }
    expect((await mock.api.commands.execute('excalidraw:element-link-external-open', args({ elementId: 'shape', link: 'javascript:alert(1)' }))).ok).toBe(false)
    expect(mock.api.files.openExternalUrl).not.toHaveBeenCalled()
    scene = { ...scene, elements: [{ ...scene.elements[0], link: 'https://example.test/' }] }
    vi.mocked(mock.api.files.openExternalUrl).mockResolvedValueOnce(true)
    expect((await mock.api.commands.execute('excalidraw:element-link-external-open', args({ elementId: 'shape', link: 'https://example.test/' }))).ok).toBe(true)
    expect(mock.api.files.openExternalUrl).toHaveBeenCalledWith('https://example.test/')
  })
  it.each(['library-item-select', 'library-items-insert', 'library-selected-remove', 'library-reset', 'library-import', 'library-export', 'library-publish-dialog'])('requires current library and exact native form before %s', async id => {
    session.library = vi.fn(async () => [] as any)
    const command = mock.commands.find(command => command.id === id)!
    const input = args({ expectedLibraryRevision: 'library:stale', expectedFormRevision: 'form:stale', ...(['library-item-select', 'library-items-insert', 'library-selected-remove', 'library-publish-dialog'].includes(id) ? { itemIds: ['item'] } : {}), ...(id === 'library-reset' ? { discardLibrary: true } : {}) }, true)
    await expect(command.run(command.input!.parse(input), { caller: 'plugin' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT', outcome: 'not-applied' })
    expect(session.nativeControl).not.toHaveBeenCalled()
    expect(() => command.input!.parse({ ...input, expectedFormRevision: undefined })).toThrow()
  })
  it.each(['library-publish-confirm', 'library-publish-cancel', 'extra-tools-menu-set', 'mermaid-dialog-open', 'mermaid-draft-edit', 'mermaid-insert', 'mermaid-dialog-close'])('refuses unmounted or stale native form %s before callback', async id => {
    const command = mock.commands.find(command => command.id === id)!
    const input = args({ expectedFormRevision: 'form:stale', ...(id === 'extra-tools-menu-set' ? { open: true } : {}), ...(id === 'mermaid-draft-edit' ? { text: 'flowchart LR; A-->B' } : {}) }, true)
    await expect(command.run(command.input!.parse(input), { caller: 'plugin' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT', outcome: 'not-applied' })
    expect(session.nativeControl).not.toHaveBeenCalled()
  })
  it('rejects unparsed native Mermaid and busy or incomplete publisher drafts without callback effects', async () => {
    controls.forms = { mermaid: { revision: 'form:1', value: { text: 'flowchart LR; A-->B', parsedText: '', renderedText: '', ready: true, error: '', elements: 1 } }, 'library-publish': { revision: 'form:1', value: { busy: true, items: [{ id: 'item', name: '' }], draft: { name: '', description: '', authorName: '', githubHandle: '', twitterHandle: '', website: '' } } } }
    for (const id of ['mermaid-insert', 'library-publish-confirm', 'library-publish-cancel']) {
      const result = await mock.api.commands.execute(`excalidraw:${id}`, args({ expectedFormRevision: 'form:1' }, true))
      expect(result.ok).toBe(false)
    }
    expect(session.nativeControl).not.toHaveBeenCalled()
  })

  it('refuses aggregate native form overflow before changing the recoverable draft', async () => {
    controls.forms = { mermaid: { revision: 'form:1', value: { text: '', parsedText: '', renderedText: '', ready: true, error: '', elements: 1 } }, 'library-publish': { revision: 'form:1', value: { busy: false, items: Array.from({ length: 200 }, (_, i) => ({ id: `item-${i}`, name: '', error: '' })), draft: { name: '', description: '', authorName: '', githubHandle: '', twitterHandle: '', website: '' } } } }
    for (const [id, extra] of [['mermaid-draft-edit', { text: 'x'.repeat(50000) }], ['library-publish-patch', { fields: { name: 'Library', description: '', authorName: '', githubHandle: '', twitterHandle: '', website: '' }, names: Array.from({ length: 200 }, (_, i) => ({ id: `item-${i}`, name: 'x'.repeat(1024) })) }]] as const) {
      const command = mock.commands.find(command => command.id === id)!
      await expect(command.run(command.input!.parse(args({ expectedFormRevision: 'form:1', ...extra }, true)), { caller: 'plugin' })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT', outcome: 'not-applied' })
    }
    expect(session.nativeControl).not.toHaveBeenCalled()
  })

})
