import * as React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import type { MountedPluginView, PluginEditorProvider } from '@valley/plugin-sdk'
import { initRuntime } from '../src/runtime'
import { drawingDraft, drawingSession, registerDrawingSession, restoreDrawingView, saveDrawingDraft, subscribeDrawing } from '../src/session'
import { updateDrawing } from '../src/commands'
import type { EditorHandle, MountOptions, RawScene } from '../src/island'
import ExcalidrawEditor from '../src/ExcalidrawEditor'
import { registerExcalidrawFence } from '../src/fence'

const island = vi.hoisted(() => ({ mount: vi.fn(), preview: vi.fn(), decode: vi.fn(), encode: vi.fn() }))
vi.mock('../src/island', () => ({ mountEditor: island.mount, renderPreviewSvg: island.preview, decodeDrawingSvg: island.decode, encodeDrawingSvg: island.encode }))

const svgContent = (scene: RawScene) => `<svg data-scene="${encodeURIComponent(JSON.stringify(scene))}"></svg>`

const original = { elements: [{ id: 'shape', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 }], appState: { viewBackgroundColor: '#ffffff' }, files: {} }
let live: RawScene
let view: ReturnType<EditorHandle['getView']>
let options: MountOptions
let handle: EditorHandle

beforeEach(() => {
  island.decode.mockReset().mockImplementation(async (content: string) => JSON.parse(decodeURIComponent(/data-scene="([^"]+)"/.exec(content)![1])))
  island.encode.mockReset().mockImplementation(async (scene: RawScene) => svgContent(scene))
  live = original
  view = { selectedIds: [], scrollX: 0, scrollY: 0, zoom: 1, readOnly: false }
  handle = { serialize: () => JSON.stringify(live), getView: () => view, restoreView: vi.fn((next) => { view = { ...view, ...next } }), updateScene: vi.fn((scene) => { live = { ...live, ...scene }; options.onChange() }), setLanguage: vi.fn(), unmount: vi.fn() }
  island.mount.mockImplementation(async (_host, next: MountOptions) => { options = next; live = next.initialData; return handle })
})

describe('drawing embed lifecycle', () => {
  async function mountFence() {
    const mock = setup()
    let reveal = () => {}
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) { reveal = () => callback([{ isIntersecting: true }]) }
      observe() {}
      disconnect() {}
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    vi.spyOn(mock.api.ui, 'renderReact').mockImplementation((element, node) => {
      const mounted = render(node, { container: element })
      return () => mounted.unmount()
    })
    const unregister = registerExcalidrawFence()
    const unmount = mock.codeBlockRenderers.get('excalidraw')!('file: [[Board.excalidraw]]', host, { path: 'Observation.md', meta: null })
    await act(async () => { reveal() })
    return { mock, host, dispose: () => { if (unmount) unmount(); unregister(); host.remove(); vi.unstubAllGlobals() } }
  }

  it('replaces its loading hint with a static drawing and unmounts without removing React-owned nodes', async () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    island.preview.mockResolvedValueOnce(svg)
    const { mock, host, dispose } = await mountFence()
    try {
      await waitFor(() => expect(host.querySelector('svg')).not.toBeNull())
      const rendered = host.querySelector('svg')!
      expect(rendered).not.toBe(svg)
      expect(host.querySelector('.excalidraw-fence-hint')).toBeNull()
      expect(rendered.parentElement?.hidden).toBe(false)
      fireEvent.click(rendered)
      expect(mock.api.workspace.openFile).toHaveBeenCalledWith('Board.excalidraw')
    } finally { dispose() }
    expect(svg.isConnected).toBe(false)
  })

  it('renders its own translated error when a preview cannot load', async () => {
    island.preview.mockRejectedValueOnce(new Error('Unavailable drawing runtime'))
    const { host, dispose } = await mountFence()
    try {
      await waitFor(() => expect(host.textContent).toContain('Could not load this drawing.'))
      expect(host.querySelector('svg')).toBeNull()
    } finally { dispose() }
  })

  it('refreshes only its changed drawing and retains its originating navigation API', async () => {
    island.preview.mockImplementation(async (scene: RawScene) => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('aria-label', (scene.elements?.[0] as { id: string }).id)
      return svg
    })
    const { mock, host, dispose } = await mountFence()
    try {
      await waitFor(() => expect(host.querySelector('svg')?.getAttribute('aria-label')).toBe('shape'))
      const read = vi.spyOn(mock.api.vault, 'readFile')
      act(() => mock.emitVaultChanged({ changes: [{ relPath: 'Other.md', kind: 'change' }] }))
      expect(read).not.toHaveBeenCalled()
      read.mockResolvedValueOnce(JSON.stringify({ ...original, elements: [{ ...original.elements[0], id: 'new' }] }))
      act(() => mock.emitVaultChanged({ changes: [{ relPath: 'Board.excalidraw', kind: 'change' }] }))
      await waitFor(() => expect(host.querySelector('svg')?.getAttribute('aria-label')).toBe('new'))
      expect(read).toHaveBeenCalledTimes(1)
      const replacement = setup()
      fireEvent.click(host.querySelector('svg')!)
      expect(mock.api.workspace.openFile).toHaveBeenCalledWith('Board.excalidraw')
      expect(replacement.api.workspace.openFile).not.toHaveBeenCalled()
    } finally { dispose() }
  })
})

function setup() {
  const mock = createMockValleyApi({ manifest: { id: 'excalidraw' }, files: { 'Board.excalidraw': JSON.stringify(original) } })
  initRuntime(mock.api)
  return mock
}

describe('guarded drawing editor session', () => {
  it.each(['.excalidraw', '.excalidraw.json', '.excalidraw.svg'])('preserves %s on open and saves edits in its original format', async (extension) => {
    const path = `Board${extension}`
    const source = extension.endsWith('.svg') ? svgContent(original) : JSON.stringify(original, null, 2)
    const mock = createMockValleyApi({ manifest: { id: 'excalidraw' }, files: { [path]: source } })
    initRuntime(mock.api)
    const mounted = render(<ExcalidrawEditor relPath={path} />)
    await waitFor(() => expect(drawingSession(path)).toBeDefined())
    expect(mounted.container.querySelector('.excalidraw-editor')).toHaveAttribute('data-native-history')
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
    act(() => { live = { ...original, elements: [] }; options.onChange() })
    await act(async () => { await mock.runBeforeUnload() })
    const content = await mock.api.vault.readFile(path)
    expect(content).toBe(extension.endsWith('.svg') ? svgContent(live) : JSON.stringify(live))
    mounted.unmount()
    render(<ExcalidrawEditor relPath={path} />)
    await waitFor(() => expect(drawingSession(path)).toBeDefined())
    expect(live.elements).toEqual([])
  })

  it('serializes delayed SVG exports and flushes edits made while an export is pending', async () => {
    const path = 'Board.excalidraw.svg'
    const mock = createMockValleyApi({ manifest: { id: 'excalidraw' }, files: { [path]: svgContent(original) } })
    initRuntime(mock.api)
    render(<ExcalidrawEditor relPath={path} />)
    await waitFor(() => expect(drawingSession(path)).toBeDefined())
    let finish!: () => void
    island.encode.mockImplementationOnce((scene) => new Promise((resolve) => { finish = () => resolve(svgContent(scene)) }))
    act(() => { live = { ...original, appState: { viewBackgroundColor: '#111111' } }; options.onChange() })
    const unload = mock.runBeforeUnload()
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
    act(() => { live = { ...original, appState: { viewBackgroundColor: '#222222' } }; options.onChange() })
    await act(async () => { finish(); await unload })
    expect(await mock.api.vault.readFile(path)).toBe(svgContent(live))
    expect(mock.api.vault.writeFileGuarded).toHaveBeenCalledTimes(2)
    expect(drawingDraft(path)).toBeUndefined()
  })

  it('preserves a draft and original SVG when export fails, and retries explicitly', async () => {
    const path = 'Board.excalidraw.svg'
    const mock = createMockValleyApi({ manifest: { id: 'excalidraw' }, files: { [path]: svgContent(original) } })
    initRuntime(mock.api)
    render(<ExcalidrawEditor relPath={path} />)
    await waitFor(() => expect(drawingSession(path)).toBeDefined())
    act(() => { live = { ...original, elements: [] }; options.onChange() })
    island.encode.mockRejectedValueOnce(new Error('Export failed'))
    await act(async () => { await expect(mock.runBeforeUnload()).rejects.toThrow('draft is preserved') })
    expect(drawingDraft(path)?.json).toBe(JSON.stringify(live))
    expect(await mock.api.vault.readFile(path)).toBe(svgContent(original))
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Retry save'))
    await waitFor(() => expect(drawingDraft(path)).toBeUndefined())
    expect(await mock.api.vault.readFile(path)).toBe(svgContent(live))
  })

  it('autosaves an undo back to the original scene while an older SVG export is pending', async () => {
    const path = 'Board.excalidraw.svg'
    const mock = createMockValleyApi({ manifest: { id: 'excalidraw' }, files: { [path]: svgContent(original) } })
    initRuntime(mock.api)
    render(<ExcalidrawEditor relPath={path} />)
    await waitFor(() => expect(drawingSession(path)).toBeDefined())
    let finish!: () => void
    island.encode.mockImplementationOnce((scene) => new Promise((resolve) => { finish = () => resolve(svgContent(scene)) }))
    act(() => { live = { ...original, elements: [] }; options.onChange() })
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    act(() => { live = original; options.onChange() })
    await act(async () => { finish() })
    await waitFor(() => expect(mock.api.vault.writeFileGuarded).toHaveBeenCalledTimes(2))
    expect(await mock.api.vault.readFile(path)).toBe(svgContent(original))
    expect(drawingDraft(path)).toBeUndefined()
  })

  it('keeps an external SVG change when it occurs during export', async () => {
    const path = 'Board.excalidraw.svg'
    const mock = createMockValleyApi({ manifest: { id: 'excalidraw' }, files: { [path]: svgContent(original) } })
    initRuntime(mock.api)
    render(<ExcalidrawEditor relPath={path} />)
    await waitFor(() => expect(drawingSession(path)).toBeDefined())
    let finish!: () => void
    island.encode.mockImplementationOnce((scene) => new Promise((resolve) => { finish = () => resolve(svgContent(scene)) }))
    act(() => { live = { ...original, elements: [] }; options.onChange() })
    const unload = mock.runBeforeUnload().catch((error: Error) => error.message)
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    const external = svgContent({ ...original, appState: { viewBackgroundColor: '#000000' } })
    await mock.api.vault.writeFile(path, external)
    await act(async () => { finish(); expect(await unload).toContain('changed on disk') })
    expect(await mock.api.vault.readFile(path)).toBe(external)
    expect(drawingDraft(path)?.json).toBe(JSON.stringify(live))
  })

  it.each(['.excalidraw.json', '.excalidraw.svg'])('does not mount or overwrite malformed %s', async (extension) => {
    const path = `Broken${extension}`
    const mock = createMockValleyApi({ manifest: { id: 'excalidraw' }, files: { [path]: 'broken' } })
    initRuntime(mock.api)
    const mounted = render(<ExcalidrawEditor relPath={path} />)
    await screen.findByRole('alert')
    expect(drawingSession(path)).toBeUndefined()
    mounted.unmount()
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
    expect(await mock.api.vault.readFile(path)).toBe('broken')
  })
  it.each(['read', 'library'])('keeps a file invalidation during its initial %s load', async (stage) => {
    const mock = setup()
    const file = await mock.api.vault.readFileBaseline('Board.excalidraw')
    const read = vi.spyOn(mock.api.vault, 'readFileBaseline')
    let complete!: () => void
    if (stage === 'read') {
      read.mockImplementationOnce(() => new Promise((resolve) => { complete = () => resolve(file) }))
    } else {
      island.mount.mockImplementationOnce((_host, next: MountOptions) => new Promise((resolve) => {
        options = next
        live = next.initialData
        complete = () => resolve(handle)
      }))
    }
    render(<ExcalidrawEditor relPath="Board.excalidraw" />)
    await waitFor(() => expect(complete).toBeTypeOf('function'))
    const newest = { ...original, appState: { viewBackgroundColor: '#454545' } }
    read.mockResolvedValueOnce({ ...file!, content: JSON.stringify(newest) })
    act(() => mock.emitVaultChanged({ changes: [{ relPath: 'Board.excalidraw', kind: 'change' }] }))
    await act(async () => { complete() })
    await waitFor(() => expect(drawingSession('Board.excalidraw')).toBeDefined())
    expect(live).toEqual(newest)
    expect(read).toHaveBeenCalledTimes(2)
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
  })

  it('scopes external reloads and coalesces a revision burst before updating the scene', async () => {
    const mock = setup()
    render(<ExcalidrawEditor relPath="Board.excalidraw" />)
    await waitFor(() => expect(drawingSession('Board.excalidraw')).toBeDefined())
    const file = await mock.api.vault.readFileBaseline('Board.excalidraw')
    const read = vi.spyOn(mock.api.vault, 'readFileBaseline')
    act(() => mock.emitVaultChanged({ changes: [{ relPath: 'Other.md', kind: 'change' }] }))
    expect(read).not.toHaveBeenCalled()
    let complete!: (value: typeof file) => void
    read.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    const newest = { ...original, appState: { viewBackgroundColor: '#222222' } }
    read.mockResolvedValueOnce({ ...file!, content: JSON.stringify(newest) })
    act(() => {
      for (let index = 0; index < 20; index++) mock.emitVaultChanged({ changes: [{ relPath: 'Board.excalidraw', kind: 'change' }] })
    })
    expect(read).toHaveBeenCalledTimes(1)
    await act(async () => { complete({ ...file!, content: JSON.stringify({ ...original, elements: [] }) }) })
    await waitFor(() => expect(live).toEqual(newest))
    expect(read).toHaveBeenCalledTimes(2)
    expect(handle.updateScene).toHaveBeenCalledTimes(1)
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
  })

  it.each(['edit', 'unmount'])('discards a pending external scene after %s', async (action) => {
    const mock = setup()
    const mounted = render(<ExcalidrawEditor relPath="Board.excalidraw" />)
    await waitFor(() => expect(drawingSession('Board.excalidraw')).toBeDefined())
    const file = await mock.api.vault.readFileBaseline('Board.excalidraw')
    let complete!: (value: typeof file) => void
    vi.spyOn(mock.api.vault, 'readFileBaseline').mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    act(() => mock.emitVaultChanged({ full: true }))
    if (action === 'edit') act(() => { live = { ...original, appState: { viewBackgroundColor: '#333333' } }; options.onChange() })
    else mounted.unmount()
    await act(async () => { complete({ ...file!, content: JSON.stringify({ ...original, elements: [] }) }) })
    expect(handle.updateScene).not.toHaveBeenCalled()
    if (action === 'edit') expect(drawingDraft('Board.excalidraw')?.json).toBe(JSON.stringify(live))
  })

  it('awaits the newest dirty scene before allowing unload and performs no revoked-session save', async () => {
    const mock = setup()
    const mounted = render(<ExcalidrawEditor relPath="Board.excalidraw" />)
    await waitFor(() => expect(drawingSession('Board.excalidraw')).toBeDefined())
    act(() => { live = { ...original, appState: { viewBackgroundColor: '#111111' } }; options.onChange() })
    const write = vi.mocked(mock.api.vault.writeFileGuarded).getMockImplementation()!
    let finish!: () => void
    const blocked = new Promise<void>((resolve) => { finish = resolve })
    vi.mocked(mock.api.vault.writeFileGuarded).mockImplementationOnce(async (...args) => { await blocked; return write(...args) })
    let completed = false
    const unload = mock.runBeforeUnload().then(() => { completed = true })
    await waitFor(() => expect(mock.api.vault.writeFileGuarded).toHaveBeenCalledTimes(1))
    expect(completed).toBe(false)
    act(() => { live = { ...original, appState: { viewBackgroundColor: '#222222' } }; options.onChange() })
    await act(async () => { finish(); await unload })
    expect(JSON.parse(await mock.api.vault.readFile('Board.excalidraw') ?? '')).toEqual(live)
    expect(drawingDraft('Board.excalidraw')).toBeUndefined()
    expect(mock.api.vault.writeFileGuarded).toHaveBeenCalledTimes(2)
    const runtime = vi.spyOn(mock.api.runtime, 'getOrCreate').mockImplementation(() => { throw new Error('Plugin session is no longer active') })
    try { mounted.unmount(); expect(runtime).not.toHaveBeenCalled() } finally { runtime.mockRestore() }
    expect(mock.api.vault.writeFileGuarded).toHaveBeenCalledTimes(2)
  })

  it('rejects unload on a save conflict and keeps the editable draft without an implicit retry', async () => {
    const mock = setup()
    render(<ExcalidrawEditor relPath="Board.excalidraw" />)
    await waitFor(() => expect(drawingSession('Board.excalidraw')).toBeDefined())
    act(() => { live = { ...original, appState: { viewBackgroundColor: '#111111' } }; options.onChange() })
    vi.mocked(mock.api.vault.writeFileGuarded).mockResolvedValueOnce({ ok: false, reason: 'conflict', current: null })
    await act(async () => { await expect(mock.runBeforeUnload()).rejects.toThrow('changed on disk') })
    expect(drawingDraft('Board.excalidraw')?.json).toBe(JSON.stringify(live))
    expect(drawingSession('Board.excalidraw')).toBeDefined()
    expect(JSON.parse(await mock.api.vault.readFile('Board.excalidraw') ?? '')).toEqual(original)
    await expect(mock.runBeforeUnload()).rejects.toThrow('changed on disk')
    expect(mock.api.vault.writeFileGuarded).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('Retry save'))
    await waitFor(() => expect(drawingDraft('Board.excalidraw')).toBeUndefined())
    await expect(mock.runBeforeUnload()).resolves.toBeUndefined()
  })

  it('cleans up only the owning drawing session and subscriptions after revocation', () => {
    const mock = setup()
    const session = { get: () => { throw new Error('Unexpected session read') }, commit: async () => {}, restore: () => {} }
    const offFirst = registerDrawingSession('Meadow.excalidraw', session)
    const next = { ...session }
    const offNext = registerDrawingSession('Meadow.excalidraw', next)
    const notify = vi.fn()
    const unsubscribe = subscribeDrawing(notify)
    const state = mock.api.runtime.getOrCreate('excalidraw.sessions', () => ({ sessions: new Map(), listeners: new Set() }))
    const runtime = vi.spyOn(mock.api.runtime, 'getOrCreate').mockImplementation(() => { throw new Error('Plugin session is no longer active') })
    try {
      offFirst()
      expect(state.sessions.get('Meadow.excalidraw')).toBe(next)
      expect(notify).toHaveBeenCalledTimes(1)
      unsubscribe()
      offNext()
      expect(state.sessions.size).toBe(0)
      expect(state.listeners.size).toBe(0)
      expect(notify).toHaveBeenCalledTimes(1)
      expect(runtime).not.toHaveBeenCalled()
    } finally { runtime.mockRestore() }
  })

  it('commits through native history only after the guarded save succeeds', async () => {
    const mock = setup()
    const pushUndo = vi.spyOn(mock.api.undo, 'push')
    render(<ExcalidrawEditor relPath="Board.excalidraw" />)
    await waitFor(() => expect(drawingSession('Board.excalidraw')).toBeDefined())
    await act(async () => { await updateDrawing(mock.api, 'Board.excalidraw', { appState: { viewBackgroundColor: '#000000' } }, JSON.stringify(original)) })
    expect(handle.updateScene).toHaveBeenCalledWith(expect.objectContaining({ appState: { viewBackgroundColor: '#000000' } }), true)
    expect(JSON.parse(await mock.api.vault.readFile('Board.excalidraw') ?? '')).toEqual(live)
    expect(view.readOnly).toBe(false)
    expect(mock.api.vault.writeFile).not.toHaveBeenCalled()
    expect(pushUndo).not.toHaveBeenCalled()
  })

  it('preserves scene and draft on conflict without refreshing the baseline and retrying', async () => {
    const mock = setup()
    render(<ExcalidrawEditor relPath="Board.excalidraw" />)
    await waitFor(() => expect(drawingSession('Board.excalidraw')).toBeDefined())
    vi.mocked(mock.api.vault.writeFileGuarded).mockResolvedValueOnce({ ok: false, reason: 'conflict', current: null })
    await act(async () => { await expect(updateDrawing(mock.api, 'Board.excalidraw', { elements: [] }, JSON.stringify(original))).rejects.toThrow('changed on disk') })
    expect(handle.updateScene).not.toHaveBeenCalled()
    expect(live).toEqual(original)
    expect(drawingDraft('Board.excalidraw')?.json).toBe(JSON.stringify(original))
    expect(screen.getByRole('alert').textContent).toContain('draft is preserved')
    expect(mock.api.vault.writeFileGuarded).toHaveBeenCalledTimes(1)
  })

  it('discards a conflict draft only after explicit confirmation and reloads the external file', async () => {
    const mock = setup()
    render(<ExcalidrawEditor relPath="Board.excalidraw" />)
    await waitFor(() => expect(drawingSession('Board.excalidraw')).toBeDefined())
    vi.mocked(mock.api.vault.writeFileGuarded).mockResolvedValueOnce({ ok: false, reason: 'conflict', current: null })
    await act(async () => { await expect(updateDrawing(mock.api, 'Board.excalidraw', { elements: [] }, JSON.stringify(original))).rejects.toThrow() })
    const confirm = vi.spyOn(mock.api.ui, 'confirm').mockResolvedValueOnce('cancel')
    fireEvent.click(screen.getByText('Reload from disk'))
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(drawingDraft('Board.excalidraw')).toBeDefined()
    confirm.mockResolvedValueOnce('reload')
    await mock.api.vault.writeFile('Board.excalidraw', JSON.stringify({ ...original, elements: [] }))
    fireEvent.click(screen.getByText('Reload from disk'))
    await waitFor(() => expect(drawingDraft('Board.excalidraw')).toBeUndefined())
    expect(live.elements).toEqual([])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('restores a pending selection and viewport and rejects native read-only editing', async () => {
    const mock = setup()
    restoreDrawingView('Board.excalidraw', { selectedIds: ['shape'], scrollX: 30, scrollY: -10, zoom: 2 })
    render(<ExcalidrawEditor relPath="Board.excalidraw" />)
    await waitFor(() => expect(view.selectedIds).toEqual(['shape']))
    expect(view).toMatchObject({ scrollX: 30, scrollY: -10, zoom: 2 })
    view = { ...view, readOnly: true }
    await expect(updateDrawing(mock.api, 'Board.excalidraw', { elements: [] }, JSON.stringify(original))).rejects.toThrow('read-only')
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
  })
})


describe('mounted drawing draft admission', () => {
  const mountedView: MountedPluginView = { mountId: 'drawing-copy', generation: 1, area: 'main', paneId: 'left', tabId: 'drawing-tab', filePath: 'Board.excalidraw', pluginId: 'excalidraw' }

  it('keeps the exact provider through updates and freezes native and command edits until release', async () => {
    const mock = setup()
    let provider!: PluginEditorProvider
    const dispose = vi.fn()
    const register = vi.spyOn(mock.api.vault.editors, 'register').mockImplementation((_view, owner) => { provider = owner; return dispose })
    const mounted = render(<ExcalidrawEditor relPath={mountedView.filePath} mountedView={mountedView} />)
    await waitFor(() => expect(drawingSession(mountedView.filePath)).toBeDefined())
    const observed = await provider.getSnapshot()
    expect(observed).toMatchObject({ dirty: false, readiness: 'ready' })
    mounted.rerender(<ExcalidrawEditor relPath={mountedView.filePath} mountedView={{ ...mountedView }} />)
    expect(register).toHaveBeenCalledOnce()
    const lease = await provider.prepare(observed.revision, { operationId: 'mutation', fenceId: 'drawing-fence', deadline: Date.now() + 30000, ownSave: false })
    expect(mounted.container.querySelector<HTMLElement>('.excalidraw-editor')?.inert).toBe(true)
    expect(handle.getView().readOnly).toBe(true)
    await expect(drawingSession(mountedView.filePath)!.commit({ elements: [] }, handle.serialize())).rejects.toThrow()
    expect(await lease.validate()).toEqual(observed)
    expect(await mock.api.vault.readFile(mountedView.filePath)).toBe(JSON.stringify(original))
    await lease.release()
    expect(handle.getView().readOnly).toBe(false)
    expect(mounted.container.querySelector<HTMLElement>('.excalidraw-editor')?.inert).toBeFalsy()
    act(() => { live = { ...original, elements: [] }; options.onChange() })
    expect(await provider.getSnapshot()).toMatchObject({ dirty: true, readiness: 'ready' })
    mounted.unmount()
    expect(dispose).toHaveBeenCalledOnce()
    expect(drawingDraft(mountedView.filePath)?.json).toBe(JSON.stringify(live))
    const terminal = await provider.getSnapshot()
    expect(terminal).toMatchObject({ dirty: true, readiness: 'uncertain' })
    act(() => { live = original; options.onChange() })
    expect(await provider.getSnapshot()).toEqual(terminal)
    expect(() => provider.prepare(terminal.revision, { operationId: 'late', fenceId: 'late', deadline: Date.now() + 10000, ownSave: false })).toThrow()
  })

  it('reports a clean immutable terminal after an untouched mounted drawing is disposed', async () => {
    const mock = setup()
    let provider!: PluginEditorProvider
    vi.spyOn(mock.api.vault.editors, 'register').mockImplementation((_view, owner) => { provider = owner; return () => {} })
    const mounted = render(<ExcalidrawEditor relPath={mountedView.filePath} mountedView={mountedView} />)
    await waitFor(() => expect(drawingSession(mountedView.filePath)).toBeDefined())
    const clean = await provider.getSnapshot()
    mounted.unmount()
    expect(await provider.getSnapshot()).toEqual(clean)
    expect(clean).toMatchObject({ dirty: false, readiness: 'ready' })
    act(() => { live = { ...original, elements: [] }; options.onChange() })
    expect(await provider.getSnapshot()).toEqual(clean)
    expect(await mock.api.vault.readFile(mountedView.filePath)).toBe(JSON.stringify(original))
  })

  it('changes a native tool without saving a scene it left unchanged, even while the drawing has an unsaved edit', async () => {
    const mock = setup()
    handle.tool = vi.fn(async (_type: string, beforeEffect?: () => Promise<void>) => { await beforeEffect?.() })
    const save = vi.spyOn(mock.api.vault.editors, 'save').mockResolvedValue({ ok: false, reason: 'error' })
    const mounted = render(<ExcalidrawEditor relPath={mountedView.filePath} mountedView={mountedView} />)
    await waitFor(() => expect(drawingSession(mountedView.filePath)).toBeDefined())
    act(() => { live = { ...original, elements: [] }; options.onChange() })
    const beforeEffect = vi.fn(async () => {})
    await act(async () => { await drawingSession(mountedView.filePath)!.tool!('rectangle', beforeEffect) })
    expect(handle.tool).toHaveBeenCalledWith('rectangle', expect.any(Function))
    expect(beforeEffect).toHaveBeenCalledOnce()
    expect(save).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
    act(() => { live = original; options.onChange() })
    mounted.unmount()
  })

  it('reports a guarded save conflict of a mounted commit as not applied and leaves the drawing clean', async () => {
    const mock = setup()
    let provider!: PluginEditorProvider
    vi.spyOn(mock.api.vault.editors, 'register').mockImplementation((_view, owner) => { provider = owner; return () => {} })
    vi.spyOn(mock.api.vault.editors, 'save').mockResolvedValueOnce({ ok: false, reason: 'conflict', current: null })
    const mounted = render(<ExcalidrawEditor relPath={mountedView.filePath} mountedView={mountedView} />)
    await waitFor(() => expect(drawingSession(mountedView.filePath)).toBeDefined())
    const beforeApply = vi.fn()
    let failure: unknown
    await act(async () => { failure = await drawingSession(mountedView.filePath)!.commit({ elements: [] }, JSON.stringify(original), async () => {}, beforeApply).catch(error => error) })
    expect(beforeApply).toHaveBeenCalledOnce()
    expect(failure).toMatchObject({ code: 'REVISION_CONFLICT', outcome: 'not-applied', effectRefused: true })
    expect(await provider.getSnapshot()).toMatchObject({ dirty: false })
    expect(handle.updateScene).not.toHaveBeenCalled()
    expect(await mock.api.vault.readFile(mountedView.filePath)).toBe(JSON.stringify(original))
    mounted.unmount()
    saveDrawingDraft(mountedView.filePath, mountedView.mountId, null)
  })

  it('notifies a same-file mount only for its own draft changes, never for the other copy', async () => {
    const mock = setup()
    const providers = new Map<string, PluginEditorProvider>()
    vi.spyOn(mock.api.vault.editors, 'register').mockImplementation((owner, provider) => { providers.set(owner.mountId, provider); return () => {} })
    const copies: { scene: RawScene; options: MountOptions }[] = []
    island.mount.mockImplementation(async (_host, next: MountOptions) => {
      const copy = { scene: next.initialData, options: next }
      copies.push(copy)
      return { serialize: () => JSON.stringify(copy.scene), getView: () => view, restoreView: vi.fn(), updateScene: vi.fn(), setLanguage: vi.fn(), unmount: vi.fn() }
    })
    const other: MountedPluginView = { ...mountedView, mountId: 'drawing-split', paneId: 'right', tabId: 'drawing-split-tab' }
    const first = render(<ExcalidrawEditor relPath={mountedView.filePath} mountedView={mountedView} />)
    const second = render(<ExcalidrawEditor relPath={other.filePath} mountedView={other} />)
    await waitFor(() => expect(copies).toHaveLength(2))
    await waitFor(async () => expect(await providers.get(other.mountId)!.getSnapshot()).toMatchObject({ readiness: 'ready' }))
    const own = vi.fn(), split = vi.fn()
    const offOwn = await providers.get(mountedView.mountId)!.subscribe(own), offSplit = await providers.get(other.mountId)!.subscribe(split)
    act(() => { copies[0].scene = { ...original, elements: [] }; copies[0].options.onChange() })
    expect(own).toHaveBeenCalled()
    expect(split).not.toHaveBeenCalled()
    expect(await providers.get(other.mountId)!.getSnapshot()).toMatchObject({ dirty: false, readiness: 'ready' })
    offOwn(); offSplit()
    first.unmount(); second.unmount()
    saveDrawingDraft(mountedView.filePath, mountedView.mountId, null)
  })

  it('keeps each same-file copy\'s draft its own and resumes only a closed copy\'s draft', async () => {
    const mock = setup()
    vi.spyOn(mock.api.vault.editors, 'save').mockResolvedValue({ ok: false, reason: 'conflict', current: null })
    const providers = new Map<string, PluginEditorProvider>()
    vi.spyOn(mock.api.vault.editors, 'register').mockImplementation((owner, provider) => { providers.set(owner.mountId, provider); return () => {} })
    const copies: { scene: RawScene; options: MountOptions }[] = []
    island.mount.mockImplementation(async (_host, next: MountOptions) => {
      const copy = { scene: next.initialData, options: next }
      copies.push(copy)
      return { serialize: () => JSON.stringify(copy.scene), getView: () => view, restoreView: vi.fn(), updateScene: vi.fn(), setLanguage: vi.fn(), unmount: vi.fn() }
    })
    const copy = (mountId: string): MountedPluginView => ({ ...mountedView, mountId, paneId: mountId, tabId: `${mountId}-tab` })
    const path = mountedView.filePath, edited = { ...original, elements: [] }
    const first = render(<ExcalidrawEditor relPath={path} mountedView={mountedView} />)
    const second = render(<ExcalidrawEditor relPath={path} mountedView={copy('drawing-split')} />)
    await waitFor(() => expect(copies).toHaveLength(2))
    act(() => { copies[0].scene = edited; copies[0].options.onChange() })
    expect(drawingDraft(path)?.json).toBe(JSON.stringify(edited))
    // An unchanged scene on the other copy (e.g. its read-only toggle during a fence) must not erase this copy's draft.
    act(() => { copies[1].options.onChange() })
    expect(drawingDraft(path, mountedView.mountId)?.json).toBe(JSON.stringify(edited))
    // A copy opened beside a live dirty one starts from disk and clean; it never adopts the sibling's draft.
    const third = render(<ExcalidrawEditor relPath={path} mountedView={copy('drawing-third')} />)
    await waitFor(() => expect(copies).toHaveLength(3))
    expect(copies[2].scene).toEqual(original)
    await waitFor(async () => expect(await providers.get('drawing-third')!.getSnapshot()).toMatchObject({ dirty: false, readiness: 'ready' }))
    expect(drawingDraft(path, 'drawing-third')).toBeUndefined()
    expect(drawingDraft(path, mountedView.mountId)?.json).toBe(JSON.stringify(edited))
    // Once the dirty copy is gone, the next opened copy resumes its draft and takes it over.
    first.unmount()
    const fourth = render(<ExcalidrawEditor relPath={path} mountedView={copy('drawing-fourth')} />)
    await waitFor(() => expect(copies).toHaveLength(4))
    expect(copies[3].scene).toEqual(edited)
    await waitFor(async () => expect(await providers.get('drawing-fourth')!.getSnapshot()).toMatchObject({ dirty: true }))
    expect(drawingDraft(path, mountedView.mountId)).toBeUndefined()
    expect(drawingDraft(path, 'drawing-fourth')?.json).toBe(JSON.stringify(edited))
    expect(await mock.api.vault.readFile(path)).toBe(JSON.stringify(original))
    second.unmount(); third.unmount(); fourth.unmount()
    saveDrawingDraft(path, 'drawing-fourth', null)
  })

  it('saves a mounted commit once and adopts the canvas normalization of the saved scene as clean', async () => {
    const mock = setup()
    const register = vi.spyOn(mock.api.vault.editors, 'register')
    const save = vi.spyOn(mock.api.vault.editors, 'save')
    handle.updateScene = vi.fn((scene: RawScene) => { live = { ...live, ...scene, appState: { ...live.appState, ...scene.appState, gridSize: null } }; options.onChange() })
    const mounted = render(<ExcalidrawEditor relPath={mountedView.filePath} mountedView={mountedView} />)
    await waitFor(() => expect(drawingSession(mountedView.filePath)).toBeDefined())
    const provider = register.mock.calls[0][1]
    const next = { elements: [] }
    await act(async () => { await drawingSession(mountedView.filePath)!.commit(next, JSON.stringify(original), async () => {}, () => {}) })
    expect(save).toHaveBeenCalledOnce()
    expect(JSON.parse(await mock.api.vault.readFile(mountedView.filePath) as string)).toEqual({ ...original, ...next })
    expect(await provider.getSnapshot()).toMatchObject({ dirty: false, readiness: 'ready' })
    expect(drawingDraft(mountedView.filePath)).toBeUndefined()
    act(() => { options.onChange() })
    expect(await provider.getSnapshot()).toMatchObject({ dirty: false })
    expect(save).toHaveBeenCalledOnce()
    mounted.unmount()
  })

  it('reports a generic mounted save failure as not applied only when the file is provably untouched', async () => {
    const mock = setup()
    const realSave = mock.api.vault.editors.save
    const save = vi.spyOn(mock.api.vault.editors, 'save').mockResolvedValueOnce({ ok: false, reason: 'error' })
    const mounted = render(<ExcalidrawEditor relPath={mountedView.filePath} mountedView={mountedView} />)
    await waitFor(() => expect(drawingSession(mountedView.filePath)).toBeDefined())
    let failure: unknown
    await act(async () => { failure = await drawingSession(mountedView.filePath)!.commit({ elements: [] }, JSON.stringify(original), async () => {}, () => {}).catch(error => error) })
    expect(failure).toMatchObject({ code: 'SAVE_REFUSED', outcome: 'not-applied', effectRefused: true })
    expect(await mock.api.vault.readFile(mountedView.filePath)).toBe(JSON.stringify(original))
    mounted.unmount()
    saveDrawingDraft(mountedView.filePath, mountedView.mountId, null)
    save.mockImplementationOnce(async (...args) => { await realSave(...args); return { ok: false, reason: 'error' } })
    const again = render(<ExcalidrawEditor relPath={mountedView.filePath} mountedView={{ ...mountedView, generation: 2 }} />)
    await waitFor(() => expect(drawingSession(mountedView.filePath)).toBeDefined())
    await act(async () => { failure = await drawingSession(mountedView.filePath)!.commit({ elements: [] }, JSON.stringify(original), async () => {}, () => {}).catch(error => error) })
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toMatchObject({ outcome: 'not-applied' })
    expect(await mock.api.vault.readFile(mountedView.filePath)).not.toBe(JSON.stringify(original))
    again.unmount()
    saveDrawingDraft(mountedView.filePath, mountedView.mountId, null)
  })

  it('retains an unpublished command draft when its SVG export outlives the exact mounted owner', async () => {
    const path = 'Board.excalidraw.svg', source = svgContent(original)
    const mock = createMockValleyApi({ manifest: { id: 'excalidraw' }, files: { [path]: source } })
    initRuntime(mock.api)
    const mounted = render(<ExcalidrawEditor relPath={path} mountedView={{ ...mountedView, filePath: path }} />)
    await waitFor(() => expect(drawingSession(path)).toBeDefined())
    let finishExport!: (content: string) => void
    island.encode.mockReturnValueOnce(new Promise<string>(resolve => { finishExport = resolve }))
    const next = { ...original, elements: [] }
    const pending = drawingSession(path)!.commit(next, JSON.stringify(original)).catch(error => error)
    await waitFor(() => expect(island.encode).toHaveBeenCalled())
    mounted.unmount()
    expect(drawingDraft(path)?.json).toBe(JSON.stringify(next))
    await act(async () => { finishExport(svgContent(next)); await pending })
    expect(await mock.api.vault.readFile(path)).toBe(source)
    expect(mock.api.vault.editors.save).not.toHaveBeenCalled()
    expect(drawingDraft(path)?.json).toBe(JSON.stringify(next))
  })

  it('refuses a stale SVG export before owner-save and preserves both disk bytes and the newer scene', async () => {
    const path = 'Board.excalidraw.svg'
    const source = svgContent(original)
    const mock = createMockValleyApi({ manifest: { id: 'excalidraw' }, files: { [path]: source } })
    initRuntime(mock.api)
    const save = vi.spyOn(mock.api.vault.editors, 'save')
    const mounted = render(<ExcalidrawEditor relPath={path} mountedView={{ ...mountedView, filePath: path }} />)
    await waitFor(() => expect(drawingSession(path)).toBeDefined())
    let finishExport!: (content: string) => void
    const exported = new Promise<string>(resolve => { finishExport = resolve })
    island.encode.mockReturnValueOnce(exported)
    act(() => { live = { ...original, elements: [] }; options.onChange() })
    const unloading = mock.runBeforeUnload().catch((error: Error) => error.message)
    await waitFor(() => expect(island.encode).toHaveBeenCalled())
    const next = { ...original, appState: { viewBackgroundColor: '#202020' } }
    act(() => { live = next; options.onChange() })
    await act(async () => { finishExport(svgContent({ ...original, elements: [] })); await unloading })
    expect(save).not.toHaveBeenCalled()
    expect(await mock.api.vault.readFile(path)).toBe(source)
    expect(drawingDraft(path)?.json).toBe(JSON.stringify(next))
    mounted.unmount()
  })
})
