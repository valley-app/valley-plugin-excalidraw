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
})
