import * as React from 'react'
import { act } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { mountEditor } from '../src/islandRuntime'

const library = vi.hoisted(() => ({ props: null as any, api: null as any, serialize: vi.fn() }))
vi.mock('@excalidraw/excalidraw/index.css', () => ({ default: '' }))
vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: (props: any) => {
    library.props = props
    React.useLayoutEffect(() => { props.excalidrawAPI(library.api) }, [])
    return React.createElement('div', null,
      React.createElement('button', { 'data-testid': 'button-undo', 'aria-label': props.langCode === 'de-DE' ? 'Rückgängig machen' : 'Undo' }),
      React.createElement('button', { 'data-testid': 'button-redo', 'aria-label': props.langCode === 'de-DE' ? 'Wiederholen' : 'Redo' }))
  },
  serializeAsJSON: library.serialize,
  restoreElements: (elements: unknown[]) => elements,
  CaptureUpdateAction: { NEVER: 'never', IMMEDIATELY: 'immediately' }
}))

describe('drawing island serialization lifecycle', () => {
  it('reuses scene serialization across callbacks and flushes, invalidates commands, and ignores retired callbacks', async () => {
    let elements = [{ id: 'shape', version: 1, versionNonce: 1, isDeleted: false }]
    let state = { viewBackgroundColor: '#fff', scrollX: 0 }
    let files = {}
    library.api = {
      getSceneElements: vi.fn(() => elements), getAppState: () => state, getFiles: () => files,
      addFiles: vi.fn(), updateScene: vi.fn((scene) => {
        elements = scene.elements ?? elements; state = { ...state, ...scene.appState }
      })
    }
    library.serialize.mockReset().mockImplementation((next, appState) => JSON.stringify({ elements: next, background: appState.viewBackgroundColor }))
    const host = document.createElement('div')
    document.body.append(host)
    const changed = vi.fn()
    const link = vi.fn()
    let handle!: Awaited<ReturnType<typeof mountEditor>>
    await act(async () => { handle = await mountEditor(host, { initialData: { elements, appState: state, files }, onChange: changed, onLinkOpen: link }) })
    expect(library.props.handleKeyboardGlobally).toBe(true)
    const mac = /Mac|iPhone|iPad/.test(navigator.platform)
    expect(host.querySelector('[data-testid="button-undo"]')).toHaveAttribute('data-drawing-tooltip', mac ? 'Undo (⌘Z)' : 'Undo (Ctrl+Z)')
    expect(host.querySelector('[data-testid="button-redo"]')).toHaveAttribute('aria-keyshortcuts', mac ? 'Meta+Shift+Z' : 'Control+Shift+Z')
    await act(async () => { handle.setLanguage('de') })
    expect(host.querySelector('[data-testid="button-undo"]')).toHaveAttribute('data-drawing-tooltip', mac ? 'Rückgängig machen (⌘Z)' : 'Rückgängig machen (Ctrl+Z)')
    const first = handle.serialize()
    for (let i = 0; i < 30; i++) {
      state = { ...state, scrollX: i }
      library.props.onChange(elements, state, files)
      expect(handle.serialize()).toBe(first)
    }
    expect(library.serialize).toHaveBeenCalledTimes(1)
    expect(library.api.getSceneElements).toHaveBeenCalledTimes(1)
    handle.updateScene({ elements: [{ ...elements[0], version: 2 }], files: { image: { id: 'image' } } }, true)
    expect(library.api.addFiles).toHaveBeenCalledWith([{ id: 'image' }])
    expect(library.api.updateScene).toHaveBeenLastCalledWith(expect.objectContaining({ captureUpdate: 'immediately' }))
    expect(handle.serialize()).not.toBe(first)
    expect(library.serialize).toHaveBeenCalledTimes(2)
    expect(handle.serialize()).toBe(handle.serialize())
    const count = changed.mock.calls.length
    handle.unmount()
    library.props.excalidrawAPI(library.api)
    library.props.onChange(elements, state, files)
    library.props.onLinkOpen({ link: 'Board.md' }, { preventDefault: vi.fn() })
    handle.restoreView({ scrollX: 10 })
    expect(handle.serialize()).toBe('')
    expect(changed).toHaveBeenCalledTimes(count)
    expect(link).not.toHaveBeenCalled()
    expect(library.api.updateScene).toHaveBeenCalledTimes(1)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1)) })
    host.remove()
  })
  it('commits view changes synchronously and keeps the selection when view mode flips', async () => {
    let state: any = { selectedElementIds: { c: true }, scrollX: 0, scrollY: 0, zoom: { value: 1 }, viewModeEnabled: false }
    library.api = {
      getSceneElements: () => [], getAppState: () => state, getFiles: () => ({}), addFiles: vi.fn(),
      updateScene: vi.fn((scene) => {
        const flipped = scene.appState.viewModeEnabled !== undefined && scene.appState.viewModeEnabled !== state.viewModeEnabled
        state = { ...state, ...scene.appState, ...(flipped ? { selectedElementIds: {} } : {}) }
      })
    }
    library.serialize.mockReset().mockReturnValue('{}')
    const host = document.createElement('div')
    document.body.append(host)
    let handle!: Awaited<ReturnType<typeof mountEditor>>
    await act(async () => { handle = await mountEditor(host, { initialData: {}, onChange: vi.fn(), onLinkOpen: vi.fn() }) })
    handle.restoreView({ scrollX: 25, scrollY: -35, zoom: 0.75 })
    expect(handle.getView()).toEqual({ selectedIds: ['c'], scrollX: 25, scrollY: -35, zoom: 0.75, readOnly: false })
    handle.restoreView({ readOnly: true })
    expect(handle.getView()).toEqual({ selectedIds: ['c'], scrollX: 25, scrollY: -35, zoom: 0.75, readOnly: true })
    handle.restoreView({ readOnly: false })
    expect(handle.getView()).toEqual({ selectedIds: ['c'], scrollX: 25, scrollY: -35, zoom: 0.75, readOnly: false })
    handle.restoreView({ selectedIds: [], readOnly: true })
    expect(handle.getView().selectedIds).toEqual([])
    handle.unmount()
    host.remove()
  })
  it('reports the native stats and grid toggles through control values and revisions', async () => {
    let state = { activeTool: { type: 'selection', locked: false }, penMode: false, openMenu: null, openDialog: null, openSidebar: null, selectedElementIds: {}, scrollX: 0, scrollY: 0, zoom: { value: 1 }, viewModeEnabled: false, gridSize: 20, gridModeEnabled: true, stats: { open: true, panels: 3 } }
    const native = { state: () => state, history: () => ({ undo: false, redo: false }), actions: () => [], receipt: () => null, forms: () => ({}) }
    library.api = { id: 'board', __valleyNative: native, getSceneElements: () => [], getAppState: () => state, getFiles: () => ({}) }
    library.serialize.mockReset().mockReturnValue('{}')
    const host = document.createElement('div')
    document.body.append(host)
    let handle!: Awaited<ReturnType<typeof mountEditor>>
    await act(async () => { handle = await mountEditor(host, { initialData: {}, onChange: vi.fn(), onLinkOpen: vi.fn() }) })
    const open = handle.controls!()
    expect(open.values).toMatchObject({ statsOpen: true, gridModeEnabled: true, gridSize: 20 })
    expect(open.values).not.toHaveProperty('showStats')
    state = { ...state, gridModeEnabled: false, stats: { ...state.stats, open: false } }
    const closed = handle.controls!()
    expect(closed.values).toMatchObject({ statsOpen: false, gridModeEnabled: false })
    expect(closed.revision).not.toBe(open.revision)
    handle.unmount()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1)) })
    host.remove()
  })
  it('registers the host clipboard writer on the native bridge and removes it on unmount', async () => {
    const off = vi.fn(), clipboard = vi.fn(() => off)
    library.api = { id: 'board', __valleyNative: { clipboard }, getSceneElements: () => [], getAppState: () => ({}), getFiles: () => ({}) }
    library.serialize.mockReset().mockReturnValue('{}')
    const host = document.createElement('div')
    document.body.append(host)
    const writeClipboardText = vi.fn(async () => {})
    let handle!: Awaited<ReturnType<typeof mountEditor>>
    await act(async () => { handle = await mountEditor(host, { initialData: {}, onChange: vi.fn(), onLinkOpen: vi.fn(), writeClipboardText }) })
    expect(clipboard).toHaveBeenCalledOnce()
    expect(clipboard).toHaveBeenCalledWith(writeClipboardText)
    expect(off).not.toHaveBeenCalled()
    handle.unmount()
    expect(off).toHaveBeenCalledOnce()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1)) })
    host.remove()
  })
  it('serializes nothing while the native scene is still loading its initial data', async () => {
    const loaded = [{ id: 'shape', version: 1, versionNonce: 1, isDeleted: false }]
    let elements: typeof loaded = [], state = { isLoading: true, viewBackgroundColor: '#fff' }
    library.api = { getSceneElements: () => elements, getAppState: () => state, getFiles: () => ({}) }
    library.serialize.mockReset().mockImplementation(next => JSON.stringify(next))
    const host = document.createElement('div')
    document.body.append(host)
    const seen: string[] = []
    let handle!: Awaited<ReturnType<typeof mountEditor>>
    await act(async () => { handle = await mountEditor(host, { initialData: { elements: loaded }, onChange: () => seen.push(handle?.serialize() ?? ''), onLinkOpen: vi.fn() }) })
    expect(seen).toEqual([''])
    expect(handle.serialize()).toBe('')
    elements = loaded; state = { ...state, isLoading: false }
    library.props.onChange(elements, state, {})
    expect(seen.at(-1)).toBe(JSON.stringify(loaded))
    handle.unmount()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1)) })
    host.remove()
  })
})
