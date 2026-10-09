import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/dom'
import { patchNativeActions, patchNativeEffects } from '../nativeActions.mjs'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { initRuntime } from '../src/runtime'
import { registerDrawingSession } from '../src/session'
import { registerDrawingActions } from '../src/actions'

let native: any
let restoreCanvas: () => void
let openedLibrary = ''
let exportedLibrary = ''
let copiedText = ''
let copiedImages = 0
beforeAll(() => {
  const source = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { build } from 'esbuild'; import fs from 'node:fs/promises'; import path from 'node:path';
    import { patchNativeActions, patchNativeEffects } from './nativeActions.mjs';
    const result = await build({ entryPoints: ['node_modules/@excalidraw/excalidraw/dist/prod/index.js'], bundle: true, write: false,
      platform: 'browser', format: 'iife', globalName: 'nativeDrawing', conditions: ['production'],
      define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent', plugins: [{ name: 'native-action-fixture', setup(builder) {
        builder.onLoad({filter: /(chunk-K2UTITRG|file-save-745eba88|file-save-3189631c)\\.js$/}, async ({path:file})=>({contents:patchNativeEffects(await fs.readFile(file,'utf8'),path.basename(file),path.basename(file).startsWith('file-save')?'0.29.1':'0.18.1'),loader:'js',resolveDir:path.dirname(file)}));
        builder.onLoad({filter: /excalidraw\\/dist\\/prod\\/index\\.js$/}, async ({path: file}) => ({
          contents: patchNativeActions(await fs.readFile(file,'utf8'), '0.18.1', path.resolve('src/nativeBridge.ts')) + '\\nimport {createRoot as valleyRoot} from \\'react-dom/client\\'; import {flushSync as valleyFlush} from \\'react-dom\\'; export const valleyNativeTest = {App:Ng,defaults:$n,createBridge:__valleyCreateNativeBridge,exportGuard:__valleyExportGuard,helpers:{drag:FE,transform:DE,clone:xr,textLayout:ox,container:Qt,newElement:q,bound:Jt,bounds:Se}, mountForm(host,app,id,props){const root=valleyRoot(host),store=st;let render;function Owner(){let tunnels=xw();return Uo.createElement(gT.Provider,{value:app},Uo.createElement(hT.Provider,{value:app.props},Uo.createElement(Og.Provider,{value:app.device},Uo.createElement(Fg.Provider,{value:{container:host,id:app.id}},Uo.createElement(Bg.Provider,{value:app.scene.getNonDeletedElements()},Uo.createElement(Ip.Provider,{value:app.state},Uo.createElement(Ug.Provider,{value:patch=>{app.setState(patch);render()}},Uo.createElement(Hg.Provider,{value:app.actionManager},Uo.createElement(Iu.Provider,{value:tunnels},Uo.createElement(tunnels.tunnelsJotai.Provider,{},Uo.createElement(({publisher:bS,menu:MS,selection:fw,mermaid:VA,palette:VK,tools:Yc})[id],props)))))))))));}render=()=>valleyFlush(()=>root.render(Uo.createElement(VE,{store},Uo.createElement(Owner))));render();return{render,unmount:()=>valleyFlush(()=>root.unmount())};}};', loader:'js', resolveDir:path.dirname(file)
        }));
      }}] }); process.stdout.write(result.outputFiles[0].text);
  `], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:fixture' })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} })
  vi.stubGlobal('FontFace', class { family: string; status = 'loaded'; constructor(family: string) { this.family = family }; async load() { return this } })
  Object.defineProperty(document, 'fonts', { configurable: true, value: Object.assign(new Set(), { check: () => true, load: async () => [], ready: Promise.resolve(), addEventListener() {}, removeEventListener() {} }) })
  const imageSource = vi.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation(function (this: HTMLImageElement) { queueMicrotask(() => this.onload?.(new Event('load'))) })
  for (const key of ['width', 'naturalWidth']) Object.defineProperty(HTMLImageElement.prototype, key, { configurable: true, get: () => 2 })
  for (const key of ['height', 'naturalHeight']) Object.defineProperty(HTMLImageElement.prototype, key, { configurable: true, get: () => 1 })
  let pixels: { data: Uint8ClampedArray; width: number; height: number } | null = null
  const context = new Proxy({ putImageData: (value: { data: Uint8ClampedArray; width: number; height: number }) => { pixels = value }, getImageData: (_x: number, _y: number, width: number, height: number) => pixels?.width === width && pixels.height === height ? pixels : ({ data: new Uint8ClampedArray(width * height * 4), width, height }), createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }), filter: 'none', font: '20px sans-serif', measureText: (value: string) => ({ width: value.length * 12, actualBoundingBoxAscent: 20, actualBoundingBoxDescent: 5 }) }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => {} })
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
  const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback, type) => callback(new Blob(['native-preview'], { type: type || 'image/png' })))
  restoreCanvas = () => { canvas.mockRestore(); toBlob.mockRestore(); imageSource.mockRestore() }
  Object.defineProperty(Blob.prototype, 'text', { configurable: true, value: function (this: Blob) { return new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(this) }) } })
  Object.assign(window, { showOpenFilePicker: async () => [{ kind: 'file', getFile: async () => new File([openedLibrary], 'Library.excalidrawlib', { type: 'application/json' }) }], showSaveFilePicker: async () => ({ kind: 'file', name: 'Library.excalidrawlib', createWritable: async () => ({ write: async (blob: Blob | string) => { exportedLibrary = typeof blob === 'string' ? blob : await blob.text() }, close: async () => {} }) }) })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copiedText = text }, write: async () => { copiedImages++ } } })
  Object.assign(window, { ClipboardItem: class { constructor(public data: unknown) {} } })
  native = new Function(`${source}; return nativeDrawing`)()
})
afterAll(() => { restoreCanvas?.(); vi.unstubAllGlobals() })
const mounts: { unmount(): void }[] = []
afterEach(() => { for (const mount of mounts.splice(0)) mount.unmount() })
function form(app: any, id: string, props: any) { const host = document.createElement('div'); document.body.append(host); const mounted = native.valleyNativeTest.mountForm(host, app, id, props); mounts.push({ unmount: () => { mounted.unmount(); host.remove() } }); return mounted }
function board() {
  let imperative: any
  const app = new native.valleyNativeTest.App({ excalidrawAPI: (value: any) => { imperative = value }, UIOptions: { canvasActions: { changeViewBackgroundColor: true, loadScene: true, saveToActiveFile: true, toggleTheme: true, export: { saveFileToDisk: true } }, tools: { image: true } }, aiEnabled: false, name: 'Drawing', detectScroll: false, handleKeyboardGlobally: false })
  app.setState = (patch: any, callback?: () => void) => { app.state = { ...app.state, ...(typeof patch === 'function' ? patch(app.state) : patch) }; callback?.() }
  const elements = native.restoreElements([
    { id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 50, version: 1, versionNonce: 1, index: 'a0', boundElements: null },
    { id: 'b', type: 'rectangle', x: 200, y: 100, width: 80, height: 40, version: 1, versionNonce: 2, index: 'a1', boundElements: null },
    { id: 'c', type: 'ellipse', x: 400, y: 200, width: 50, height: 80, version: 1, versionNonce: 3, index: 'a2', boundElements: null }
  ], null, { repairBindings: true })
  app.scene.replaceAllElements(elements)
  app.state = { ...app.state, isLoading: false, width: 800, height: 600, selectedElementIds: { a: true, b: true }, activeTool: { ...app.state.activeTool, type: 'selection' } }
  app.store.onStoreIncrementEmitter.on((entry: any) => app.history.record(entry.elementsChange, entry.appStateChange))
  app.store.shouldUpdateSnapshot(); app.store.commit(app.scene.getNonDeletedElementsMap(), app.state)
  app.canvas = document.createElement('canvas')
  app.excalidrawContainerRef.current = document.createElement('div')
  const bridge = native.valleyNativeTest.createBridge(app, native.valleyNativeTest.helpers)
  const run = async (name: string, value: unknown = null) => { await bridge.execute(name, value, () => {}, () => {}); app.store.commit(app.scene.getNonDeletedElementsMap(), app.state) }
  return { app, bridge, imperative, run, elements: () => app.scene.getNonDeletedElements() as any[] }
}
describe('pinned native Excalidraw action algorithms', () => {
  it('refuses version/hash drift before adapting native library code', () => {
    const source = readFileSync('node_modules/@excalidraw/excalidraw/dist/prod/index.js', 'utf8')
    for (const [text, version] of [[source, '0.18.2'], [`${source}\n`, '0.18.1']]) {
      expect(() => patchNativeActions(text, version, 'bridge')).toThrow('pinned')
    }
  })
  it('runs native opacity, color, style and font-independent properties with untouched other elements', async () => {
    const { run, elements, app } = board()
    const unaffected = JSON.stringify(elements()[2])
    for (const [name, value, field, expected] of [
      ['changeOpacity', 42, 'opacity', 42], ['changeStrokeColor', { currentItemStrokeColor: '#123456' }, 'strokeColor', '#123456'], ['changeBackgroundColor', { currentItemBackgroundColor: '#654321' }, 'backgroundColor', '#654321'],
      ['changeFillStyle', 'solid', 'fillStyle', 'solid'], ['changeStrokeWidth', 4, 'strokeWidth', 4], ['changeSloppiness', 2, 'roughness', 2], ['changeStrokeStyle', 'dashed', 'strokeStyle', 'dashed']
    ]) { await run(String(name), value); expect(elements().slice(0, 2).every(element => element[String(field)] === expected)).toBe(true); expect(JSON.stringify(elements()[2])).toBe(unaffected) }
    await run('changeViewBackgroundColor', { viewBackgroundColor: '#abcdef' })
    expect(app.state.viewBackgroundColor).toBe('#abcdef')
  })
  it('uses the native history store for property Undo/Redo, preserving a later native edit', async () => {
    const { run, elements, bridge } = board()
    const before = elements()[0].opacity
    await run('changeOpacity', 40)
    expect(bridge.history()).toEqual({ undo: true, redo: false })
    await run('undo'); expect(elements()[0].opacity).toBe(before)
    expect(bridge.history()).toEqual({ undo: false, redo: true })
    await run('redo'); expect(elements()[0].opacity).toBe(40)
    await run('changeOpacity', 60)
    await run('undo'); expect(elements()[0].opacity).toBe(40)
  })
  it.each(['alignTop', 'alignBottom', 'alignLeft', 'alignRight', 'alignVerticallyCentered', 'alignHorizontallyCentered'])('runs native %s geometry and keeps unknown metadata', async name => {
    const { run, elements } = board()
    elements()[0].customData = { retained: 'äöüß' }
    await run(name)
    const [a, b] = elements()
    const metric = name === 'alignTop' ? (e: any) => e.y : name === 'alignBottom' ? (e: any) => e.y + e.height : name === 'alignLeft' ? (e: any) => e.x : name === 'alignRight' ? (e: any) => e.x + e.width : name === 'alignVerticallyCentered' ? (e: any) => e.y + e.height / 2 : (e: any) => e.x + e.width / 2
    expect(metric(a)).toBe(metric(b)); expect(a.customData).toEqual({ retained: 'äöüß' })
  })
  it.each(['sendBackward', 'bringForward', 'sendToBack', 'bringToFront'])('runs native %s ordering', async name => {
    const { app, run, elements } = board()
    app.state.selectedElementIds = { b: true }
    await run(name)
    expect(elements().map(element => element.id)).toEqual(name.startsWith('send') ? ['b', 'a', 'c'] : ['a', 'c', 'b'])
  })
  it('groups, ungroups, duplicates and deletes through actual registered native algorithms', async () => {
    const { app, run, elements } = board()
    await run('group')
    expect(elements()[0].groupIds).toHaveLength(1)
    expect(elements()[1].groupIds).toEqual(elements()[0].groupIds)
    await run('ungroup')
    expect(elements()[0].groupIds).toHaveLength(0)
    await run('duplicateSelection')
    expect(elements()).toHaveLength(5)
    expect(Object.keys(app.state.selectedElementIds)).toHaveLength(2)
    await run('deleteSelectedElements')
    expect(elements()).toHaveLength(3)
  })
  it.each([['changeProjectName', 'Blätter äöüß', 'name'], ['changeExportBackground', false, 'exportBackground'], ['changeExportEmbedScene', true, 'exportEmbedScene'], ['changeExportScale', 3, 'exportScale'], ['exportWithDarkMode', true, 'exportWithDarkMode']])('runs native %s settings with its exact native value', async (name, value, field) => {
    const { app, run } = board(); await run(String(name), value); expect(app.state[String(field)]).toBe(value)
  })
  it.each([['zenMode', 'zenModeEnabled'], ['objectsSnapMode', 'objectsSnapModeEnabled'], ['viewMode', 'viewModeEnabled']])('runs native %s mode', async (name, field) => {
    const { app, run } = board(); const before = app.state[field]; await run(name); expect(app.state[field]).toBe(!before)
  })
  it('runs the actual native Stats action', async () => { const { app, run } = board(); const before = app.state.stats.open; await run('stats'); expect(app.state.stats.open).toBe(!before) })
  it('runs native zoom, selection, menu and help actions', async () => {
    const { app, run } = board()
    await run('selectAll'); expect(Object.keys(app.state.selectedElementIds)).toHaveLength(3)
    await run('zoomIn'); expect(app.state.zoom.value).toBeGreaterThan(1)
    const zoomed = app.state.zoom.value; await run('zoomOut'); expect(app.state.zoom.value).toBeLessThan(zoomed); app.state.zoom = { value: 2 }; await run('resetZoom'); expect(app.state.zoom.value).toBe(1)
    await run('zoomToFit'); expect(Number.isFinite(app.state.zoom.value)).toBe(true)
    await run('zoomToFitSelection'); expect(Number.isFinite(app.state.scrollX)).toBe(true)
    await run('toggleCanvasMenu'); expect(app.state.openMenu).toBe('canvas')
    await run('toggleEditMenu'); expect(app.state.openMenu).toBe('shape')
    await run('toggleShortcuts'); expect(app.state.openDialog.name).toBe('help')
    app.state.openDialog = null
    app.setOpenDialog({ name: 'commandPalette' }); expect(app.state.openDialog.name).toBe('commandPalette')
    await run('searchMenu'); expect(app.state.openSidebar.name).toBe('default')
  })
  it('runs native element locks, frame wrapping and frame child selection', async () => {
    const { app, run, elements } = board()
    await run('toggleElementLock'); expect(elements().slice(0, 2).every(element => element.locked)).toBe(true)
    app.state.selectedElementIds = {}
    await run('unlockAllElements'); expect(elements().every(element => !element.locked)).toBe(true)
    app.state.selectedElementIds = { a: true, b: true }
    await run('wrapSelectionInFrame'); const frame = elements().find(element => element.type === 'frame')
    expect(frame).toBeDefined(); expect(elements().filter(element => element.frameId === frame.id)).toHaveLength(2)
    await run('selectAllElementsInFrame'); expect(Object.keys(app.state.selectedElementIds)).toEqual(['a', 'b'])
    app.state.selectedElementIds = { [frame.id]: true }
    await run('removeAllElementsFromFrame'); expect(elements().every(element => !element.frameId)).toBe(true)
    const before = app.state.frameRendering.enabled; await run('updateFrameRendering'); expect(app.state.frameRendering.enabled).toBe(!before)
  })
  it('uses actual native pen, tool lock and tool callbacks', () => {
    const { app, bridge } = board()
    bridge.pen(true); expect(app.state.penMode).toBe(true)
    bridge.lock(); expect(app.state.activeTool.locked).toBe(true)
    app.setActiveTool({ type: 'rectangle' }); expect(app.state.activeTool.type).toBe('rectangle')
    app.setActiveTool({ type: 'eraser' }); expect(app.state.activeTool.type).toBe('eraser')
    bridge.sidebar(true); expect(app.state.openSidebar).toEqual({ name: 'default', tab: 'library' }); bridge.sidebar(false); expect(app.state.openSidebar).toBe(null)
  })
  it('refuses the actual native disabled predicate and replaced source before applying an asynchronous result', async () => {
    const { app, bridge } = board()
    app.state.selectedElementIds = {}
    await expect(bridge.execute('hyperlink', null, () => {}, () => {})).rejects.toMatchObject({ code: 'ACTION_UNAVAILABLE' })
    let finish!: (value: any) => void
    app.actionManager.registerAction({ name: 'test-delay', perform: () => new Promise(resolve => { finish = resolve }) })
    const pending = bridge.execute('test-delay', null, () => {}, () => {})
    app.scene.replaceAllElements([])
    finish({ appState: { name: 'stale' }, captureUpdate: 'EVENTUALLY' })
    await expect(pending).rejects.toMatchObject({ outcome: 'unknown', retryable: false })
    expect(app.state.name).toBe('Drawing')
  })
  it('moves, resizes and rotates through pinned native pointer geometry with one native history owner', async () => {
    const { app, bridge, run, elements } = board()
    await bridge.edit('selection-move', { dx: 30, dy: -20, snapToGrid: false }, async () => {})
    app.store.commit(app.scene.getNonDeletedElementsMap(), app.state)
    expect(elements().slice(0, 2).map(element => [element.x, element.y])).toEqual([[30, -20], [230, 80]])
    await run('undo'); expect(elements().slice(0, 2).map(element => [element.x, element.y])).toEqual([[0, 0], [200, 100]])
    app.state.selectedElementIds = { a: true }
    await bridge.edit('selection-resize', { handle: 'se', pointerX: 150, pointerY: 100, discreteAngle: false, fromCenter: false, maintainAspectRatio: false }, async () => {})
    expect(elements()[0]).toMatchObject({ width: 150, height: 100 })
    await bridge.edit('selection-rotate', { pointerX: 175, pointerY: 50, discreteAngle: false, fromCenter: false, maintainAspectRatio: false }, async () => {})
    expect(elements()[0].angle).not.toBe(0)
    expect(elements()[2]).toMatchObject({ x: 400, y: 200, angle: 0 })
  })
  it('edits the exact native text content using existing wrapping and dimension calculation', async () => {
    const { app, bridge, elements } = board()
    const text = native.restoreElements([{ id: 'text', type: 'text', x: 0, y: 0, text: 'old', originalText: 'old', width: 36, height: 25, fontSize: 20, fontFamily: 1, version: 1 }], null, { repairBindings: true })[0]
    app.scene.replaceAllElements([...elements(), text]); app.state.selectedElementIds = { text: true }
    await bridge.edit('text-content-edit', { elementId: 'text', text: 'Blätter äöüß' }, async () => {})
    expect(elements().find(element => element.id === 'text')).toMatchObject({ text: 'Blätter äöüß', originalText: 'Blätter äöüß', width: 144 })
  })
  it('mounts the actual command-palette callback and extra tool native draft closures', async () => {
    const { app, bridge } = board()
    const palette = form(app, 'palette', {})
    expect(bridge.forms()['command-palette'].value.open).toBe(false)
    await bridge.control('command-palette', 'toggle', null, async () => {})
    expect(app.state.openDialog.name).toBe('commandPalette')
    await bridge.control('command-palette', 'toggle', null, async () => {})
    expect(app.state.openDialog).toBe(null)
    palette.unmount()
    const tools = form(app, 'tools', { activeTool: app.state.activeTool, appState: app.state, app, UIOptions: app.props.UIOptions })
    await bridge.control('extra-tools', 'set', true, async () => {}); tools.render()
    expect(bridge.forms()['extra-tools'].value.open).toBe(true)
    await bridge.control('extra-tools', 'mermaid', null, async () => {})
    expect(app.state.openDialog).toEqual({ name: 'ttd', tab: 'mermaid' })
    await bridge.control('extra-tools', 'close', null, async () => {})
    expect(app.state.openDialog).toBe(null)
  })

  it('selects and inserts through the actual native library component closures', async () => {
    const { app, bridge, elements } = board()
    const selected = elements().slice(0, 1)
    await app.library.setLibrary([{ id: 'item', name: 'Box', status: 'unpublished', created: 1, elements: selected }])
    const selection = form(app, 'selection', {})
    await bridge.control('library-selection', 'select', ['item'], async () => {})
    expect(bridge.forms()['library-selection'].value.selectedIds).toEqual(['item'])
    const before = elements().length
    await bridge.control('library-selection', 'insert', await bridge.library(), async () => {})
    expect(elements()).toHaveLength(before + 1)
    expect(elements().at(-1)).toMatchObject({ type: 'rectangle', width: 100, height: 50 })
    expect(elements().at(-1).id).not.toBe('a')
    selection.render()
  })
  it('uses native library menu removal/reset, export and publish state without a second library', async () => {
    const { app, bridge, elements } = board()
    const item = { id: 'item', name: 'Box', status: 'unpublished', created: 1, elements: elements().slice(0, 1) }
    await app.library.setLibrary([item])
    let ids = ['item']
    const menu = form(app, 'menu', { setAppState: app.setState, selectedItems: ids, library: app.library, appState: app.state, onSelectItems: (value: string[]) => { ids = value }, onRemoveFromLibrary: () => app.library.setLibrary([]), resetLibrary: () => app.library.resetLibrary() })
    await bridge.control('library-menu', 'publish', null, async () => {})
    expect(bridge.forms()['library-menu'].value.publishOpen).toBe(true)
    expect(bridge.forms()['library-publish'].value.items).toMatchObject([{ id: 'item', name: 'Box' }])
    await bridge.control('library-menu', 'cancel', null, async () => {})
    expect(bridge.forms()['library-publish']).toBeUndefined()
    await bridge.control('library-menu', 'remove', null, async () => {})
    expect(await bridge.library()).toEqual([])
    expect(elements()).toHaveLength(3)
    menu.render()
  })
  it('patches and cancels the actual native publisher draft with the original item update callback', async () => {
    const { app, bridge, elements } = board()
    const updated = vi.fn(), closed = vi.fn()
    const publisher = form(app, 'publisher', { onClose: closed, libraryItems: [{ id: 'item', name: '', status: 'unpublished', created: 1, elements: elements().slice(0, 1) }], appState: app.state, onSuccess: vi.fn(), onError: vi.fn(), updateItemsInStorage: updated, onRemove: vi.fn() })
    const before = bridge.forms()['library-publish'].revision
    const fields = { name: 'Library äöüß', description: 'Native boxes', authorName: 'Author', githubHandle: '', twitterHandle: '', website: '' }
    await bridge.control('library-publish', 'patch', { fields, names: { item: 'Named box' } }, async () => {})
    expect(bridge.forms()['library-publish'].value).toMatchObject({ draft: fields, items: [{ id: 'item', name: 'Named box' }], busy: false })
    expect(bridge.forms()['library-publish'].revision).not.toBe(before)
    await bridge.control('library-publish', 'cancel', null, async () => {})
    expect(closed).toHaveBeenCalledOnce()
    expect(updated).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: 'item', name: 'Named box' })]))
    expect(elements()).toHaveLength(3)
    publisher.render()
  })
  it('edits, parses and inserts the actual native Mermaid draft through its native paste owner', async () => {
    const { app, bridge, elements } = board()
    const parse = vi.fn(async () => ({ elements: elements().slice(0, 1), files: {} }))
    const mermaid = form(app, 'mermaid', { mermaidToExcalidrawLib: { loaded: true, api: Promise.resolve({ parseMermaidToExcalidraw: parse }) } })
    const definition = 'flowchart LR; A-->B'
    await waitFor(() => expect(String(bridge.forms().mermaid.value.parsedText).length).toBeGreaterThan(0))
    await bridge.control('mermaid', 'patch', definition, async () => {})
    await waitFor(() => expect(bridge.forms().mermaid.value.parsedText).toBe(definition))
    expect(bridge.forms().mermaid.value).toMatchObject({ text: definition, elements: 1, ready: true, error: '' })
    const before = elements().length
    await bridge.control('mermaid', 'insert', null, async () => {})
    expect(elements()).toHaveLength(before + 1)
    expect(app.state.openDialog).toBe(null)
    expect(parse).toHaveBeenLastCalledWith(definition)
    mermaid.render()
  })

  it('inserts actual native image bytes and dimensions after the native image loader guard', async () => {
    const { app, bridge, elements } = board()
    vi.stubGlobal('Image', class { width = 2; height = 1; naturalWidth = 2; naturalHeight = 1; onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(_value: string) { queueMicrotask(() => this.onload?.()) }; get src() { return '' } })
    const dataURL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAQAAAD8fJRsAAAADklEQVR42mP8z8AARMAAAAYAAf4CBpkAAAAASUVORK5CYII='
    const guard = vi.fn(async () => {})
    await bridge.edit('image-insert', { dataURL, name: 'pixel.png', x: 10, y: 20 }, guard)
    const image = elements().find(element => element.type === 'image')
    expect(image).toMatchObject({ x: 9, y: 19.5, width: 2, height: 1, status: 'pending' })
    expect(image.fileId).toBeTruthy()
    expect(app.files[image.fileId].dataURL).toBe('data:image/png;base64,bmF0aXZlLXByZXZpZXc=')
    expect(guard.mock.calls.length).toBeGreaterThan(1)
  })
  it('submits the actual bounded native publisher payload and records the server receipt separately', async () => {
    const { app, bridge, elements } = board()
    vi.stubGlobal('Image', class { width = 100; height = 50; naturalWidth = 100; naturalHeight = 50; onload: (() => void) | null = null; set src(_value: string) { queueMicrotask(() => this.onload?.()) } })
    const success = vi.fn(), failure = vi.fn()
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ url: 'https://example.test/library' }) }))
    vi.stubGlobal('fetch', fetch)
    form(app, 'publisher', { onClose: vi.fn(), libraryItems: [{ id: 'item', name: 'Box', status: 'unpublished', created: 1, elements: elements().slice(0, 1) }], appState: app.state, onSuccess: success, onError: failure, updateItemsInStorage: vi.fn(), onRemove: vi.fn() })
    const fields = { name: 'Library', description: 'Native box', authorName: 'Author', githubHandle: '', twitterHandle: '', website: '' }
    await bridge.control('library-publish', 'patch', { fields, names: {} }, async () => {})
    const guard = vi.fn(async () => {})
    await bridge.control('library-publish', 'confirm', null, guard)
    expect(fetch).toHaveBeenCalledOnce()
    const request = (fetch.mock.calls[0] as unknown as [string, { method: string; body: FormData }])[1]
    expect(request.method).toBe('post')
    expect(request.body.get('title')).toBe('Library')
    expect(request.body.get('authorName')).toBe('Author')
    expect((request.body.get('previewImage') as Blob).type).toBe('image/jpeg')
    const serialized = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(request.body.get('excalidrawLib') as Blob) })
    expect(JSON.parse(serialized).libraryItems[0]).toMatchObject({ id: 'item', name: 'Box', elements: [{ id: 'a', width: 100 }] })
    expect(bridge.receipt()).toEqual({ kind: 'library-publish', outcome: 'server-receipt', url: 'https://example.test/library' })
    expect(success).toHaveBeenCalledWith({ url: 'https://example.test/library', authorName: 'Author', items: expect.arrayContaining([expect.objectContaining({ id: 'item' })]) })
    expect(failure).not.toHaveBeenCalled()
    expect(guard.mock.calls.length).toBeGreaterThan(1)
  })

  it('imports and exports actual native library JSON through existing file pickers and resets the reviewed library', async () => {
    const { app, bridge, elements } = board()
    const item = { id: 'first', name: 'Box', status: 'unpublished', created: 1, elements: elements().slice(0, 1) }
    await app.library.setLibrary([item, { ...item, id: 'second', name: 'Ellipse', elements: elements().slice(2) }])
    const menu = form(app, 'menu', { setAppState: app.setState, selectedItems: ['first'], library: app.library, appState: app.state, onSelectItems() {}, onRemoveFromLibrary: () => app.library.setLibrary([]), resetLibrary: () => app.library.resetLibrary() })
    exportedLibrary = ''
    await bridge.control('library-menu', 'export', null, async () => {})
    expect(JSON.parse(exportedLibrary)).toMatchObject({ type: 'excalidrawlib', libraryItems: [{ id: 'first', name: 'Box' }] })
    expect(JSON.parse(exportedLibrary).libraryItems).toHaveLength(1)
    menu.unmount()
    const all = form(app, 'menu', { setAppState: app.setState, selectedItems: [], library: app.library, appState: app.state, onSelectItems() {}, onRemoveFromLibrary: () => app.library.setLibrary([]), resetLibrary: () => app.library.resetLibrary() })
    openedLibrary = JSON.stringify({ type: 'excalidrawlib', version: 2, libraryItems: [{ ...item, id: 'imported', elements: [{ ...item.elements[0], id: 'imported-shape', x: 999, width: 20 }] }] })
    await bridge.control('library-menu', 'import', null, async () => {})
    expect((await bridge.library()).map((item: any) => item.id)).toContain('imported')
    await bridge.control('library-menu', 'remove', null, async () => {})
    expect(await bridge.library()).toEqual([])
    expect(elements()).toHaveLength(3)
    all.render()
  })
  it('routes actual native action, property-panel and tool callbacks through the installed owner while keeping native effects guarded', async () => {
    const { app, bridge, elements } = board()
    const received: string[] = []
    let completed: Promise<void> = Promise.resolve()
    const off = bridge.routing(async (request: any) => { received.push(`${request.kind}:${request.name}`); completed = request.kind === 'tool' ? bridge.tool(request.name, async () => {}) : bridge.execute(request.name, request.value, () => {}, () => {}); await completed }, (request: any) => request.kind !== 'control')
    app.actionManager.executeAction(app.actionManager.actions.changeOpacity, 'ui', 32)
    await completed
    expect(elements().slice(0, 2).every(element => element.opacity === 32)).toBe(true)
    app.actionManager.renderAction('changeStrokeWidth').props.updateData(4)
    await completed
    expect(elements().slice(0, 2).every(element => element.strokeWidth === 4)).toBe(true)
    app.setActiveTool({ type: 'rectangle' }); await Promise.resolve(); await completed
    expect(app.state.activeTool.type).toBe('rectangle')
    expect(received).toEqual(['action:changeOpacity', 'action:changeStrokeWidth', 'tool:rectangle'])
    off()
  })
  it('refuses native publisher final authorization and payload bounds before any server request, and retains unknown on lost receipt', async () => {
    const { app, bridge, elements } = board()
    const fields = { name: 'Library', description: 'Native box', authorName: 'Author', githubHandle: '', twitterHandle: '', website: '' }
    const failure = vi.fn(), fetch = vi.fn()
    vi.stubGlobal('Image', class { width = 100; height = 50; naturalWidth = 100; naturalHeight = 50; onload: (() => void) | null = null; set src(_value: string) { queueMicrotask(() => this.onload?.()) } })
    vi.stubGlobal('fetch', fetch)
    const publisher = form(app, 'publisher', { onClose: vi.fn(), libraryItems: [{ id: 'item', name: 'Box', status: 'unpublished', created: 1, elements: elements().slice(0, 1) }], appState: app.state, onSuccess: vi.fn(), onError: failure, updateItemsInStorage: vi.fn(), onRemove: vi.fn() })
    await bridge.control('library-publish', 'patch', { fields, names: {} }, async () => {})
    let count = 0
    await expect(bridge.control('library-publish', 'confirm', null, async () => { if (++count > 1) throw Object.assign(new Error('denied'), { code: 'DENIED', outcome: 'not-applied' }) })).rejects.toMatchObject({ code: 'DENIED', outcome: 'not-applied' })
    expect(fetch).not.toHaveBeenCalled()
    publisher.render()
    await bridge.control('library-publish', 'patch', { fields: { ...fields, description: 'x'.repeat(16385) }, names: {} }, async () => {})
    await expect(bridge.control('library-publish', 'confirm', null, async () => {})).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
    expect(fetch).not.toHaveBeenCalled()
    publisher.render()
    await bridge.control('library-publish', 'patch', { fields, names: {} }, async () => {})
    const lost = new Error('lost acknowledgement')
    vi.mocked(console.error).mockImplementationOnce(reason => { expect(reason).toBe(lost) })
    fetch.mockRejectedValueOnce(lost)
    await expect(bridge.control('library-publish', 'confirm', null, async () => {})).rejects.toMatchObject({ outcome: 'unknown', retryable: false })
    expect(fetch).toHaveBeenCalledOnce()
    expect(failure).toHaveBeenCalledWith(lost)
    expect(bridge.receipt()).toEqual({ kind: 'library-publish', outcome: 'unknown', url: '' })
    expect(vi.mocked(console.error).mock.calls).toEqual([[lost]])
    vi.mocked(console.error).mockClear()
    expect(elements()).toHaveLength(3)
  })

  it.each(['copyAsSvg', 'copyAsPng'])('refuses late final authorization for actual native %s bytes without clipboard effect', async name => {
    const { bridge, elements } = board()
    copiedText = ''; copiedImages = 0
    const before = JSON.stringify(elements())
    await expect(bridge.execute(name, null, () => {}, () => {}, async () => { throw Object.assign(new Error('denied'), { code: 'DENIED', outcome: 'not-applied' }) })).rejects.toMatchObject({ code: 'DENIED', outcome: 'not-applied' })
    expect(copiedText).toBe(''); expect(copiedImages).toBe(0); expect(JSON.stringify(elements())).toBe(before)
  })
  it('refuses oversized native PNG export before the clipboard write', async () => {
    const { bridge } = board()
    const originalBlob = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = callback => callback(new Blob(['x'.repeat(2 * 1024 * 1024 + 1)], { type: 'image/png' }))
    copiedImages = 0
    try { await expect(bridge.execute('copyAsPng', null, () => {}, () => {}, async () => {})).rejects.toMatchObject({ code: 'RESOURCE_LIMIT', outcome: 'not-applied' }); expect(copiedImages).toBe(0) }
    finally { HTMLCanvasElement.prototype.toBlob = originalBlob }
  })
  it('keeps the captured export owner bound after the original native command finishes', async () => {
    const { app, bridge } = board()
    let captured!: (data: string) => Promise<void>
    app.actionManager.registerAction({ name: 'capture-export', perform: () => { captured = native.valleyNativeTest.exportGuard(app); return { captureUpdate: 'EVENTUALLY' } } })
    await bridge.execute('capture-export', null, () => {}, () => {}, async () => {})
    await expect(captured('native bytes')).rejects.toMatchObject({ code: 'REVISION_CONFLICT', outcome: 'not-applied' })
  })
  it.each(['saveToActiveFile', 'saveFileToDisk'])('refuses final %s after the existing native file picker without any file write', async name => {
    const { app, bridge } = board()
    const write = vi.fn(), createWritable = vi.fn(async () => ({ write, close: vi.fn(), abort: vi.fn() }))
    const picker = (window as any).showSaveFilePicker
    let finish!: (value: any) => void
    ;(window as any).showSaveFilePicker = vi.fn(() => new Promise(resolve => { finish = resolve }))
    const oldHandle = name === 'saveToActiveFile' ? { name: 'Stale.excalidraw', kind: 'file', getFile: async () => { throw new Error('file handle unavailable') } } : null
    app.state.fileHandle = oldHandle
    let allowed = true
    const request = bridge.execute(name, null, () => {}, () => {}, async () => { if (!allowed) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED', outcome: 'not-applied' }) })
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    allowed = false; finish({ kind: 'file', name: 'Guarded.excalidraw', createWritable })
    try { await expect(request).rejects.toMatchObject({ code: 'CANCELLED', outcome: 'not-applied' }); expect(createWritable).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(app.state.fileHandle).toBe(oldHandle) }
    finally { (window as any).showSaveFilePicker = picker }
  })
  it('propagates a lost native file-close receipt as unknown and keeps the original file handle', async () => {
    const { app, bridge } = board()
    const picker = (window as any).showSaveFilePicker
    const write = vi.fn(), close = vi.fn(async () => { throw new Error('lost close acknowledgement') })
    ;(window as any).showSaveFilePicker = vi.fn(async () => ({ kind: 'file', name: 'Guarded.excalidraw', createWritable: async () => ({ write, close }) }))
    try { await expect(bridge.execute('saveFileToDisk', null, () => {}, () => {}, async () => {})).rejects.toMatchObject({ outcome: 'unknown', retryable: false }); expect(write).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce(); expect(app.state.fileHandle).toBe(null) }
    finally { (window as any).showSaveFilePicker = picker }
  })
  it('routes native toolbar pen and lock changes once through the same exact owner', async () => {
    const { app, bridge } = board()
    const received: string[] = []; let completed = Promise.resolve()
    const off = bridge.routing(async (request: any) => { received.push(request.action); completed = Promise.resolve().then(() => request.action === 'pen' ? bridge.pen(request.value) : request.action === 'library' ? bridge.sidebar(request.value) : bridge.lock()); await completed })
    app.togglePenMode(true); await Promise.resolve(); await completed
    expect(app.state.penMode).toBe(true)
    app.toggleLock(); await Promise.resolve(); await completed
    expect(app.state.activeTool.locked).toBe(true); app.toggleSidebar({ name: 'default', tab: 'library', force: true }); await Promise.resolve(); await completed; expect(app.state.openSidebar).toEqual({ name: 'default', tab: 'library' }); expect(received).toEqual(['pen', 'lock', 'library']); off()
  })

  it('refuses a changed actual native publisher draft at the final request leaf', async () => {
    const { app, bridge, elements } = board()
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('Image', class { width = 100; height = 50; naturalWidth = 100; naturalHeight = 50; onload: (() => void) | null = null; set src(_value: string) { queueMicrotask(() => this.onload?.()) } })
    form(app, 'publisher', { onClose: vi.fn(), libraryItems: [{ id: 'item', name: 'Box', status: 'unpublished', created: 1, elements: elements().slice(0, 1) }], appState: app.state, onSuccess: vi.fn(), onError: vi.fn(), updateItemsInStorage: vi.fn(), onRemove: vi.fn() })
    const fields = { name: 'Library', description: 'Native box', authorName: 'Author', githubHandle: '', twitterHandle: '', website: '' }
    await bridge.control('library-publish', 'patch', { fields, names: {} }, async () => {})
    let count = 0
    await expect(bridge.control('library-publish', 'confirm', null, async () => { if (++count > 1) (bridge.forms()['library-publish'].value.draft as Record<string, string>).name = 'replaced draft' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT', outcome: 'not-applied' })
    expect(fetch).not.toHaveBeenCalled(); expect(bridge.receipt()).toBe(null)
  })

  it('executes exact SDK selection, pan, zoom, read-only and scene commit against the real native imperative scene and guarded bytes', async () => {
    const { app, bridge, imperative, elements } = board()
    const mountedView = { mountId: 'native-left', generation: 1, area: 'main' as const, paneId: 'left', tabId: 'drawing', filePath: 'Board.excalidraw', pluginId: 'excalidraw' }
    const scene = () => ({ elements: imperative.getSceneElementsIncludingDeleted(), appState: { viewBackgroundColor: app.state.viewBackgroundColor }, files: imperative.getFiles() })
    const source = createMockValleyApi({ manifest: { id: 'excalidraw' }, files: { 'Board.excalidraw': JSON.stringify(scene()) } })
    initRuntime(source.api)
    const session = {
      get: () => { const view = { selectedIds: Object.keys(app.state.selectedElementIds), scrollX: app.state.scrollX, scrollY: app.state.scrollY, zoom: app.state.zoom.value, readOnly: app.state.viewModeEnabled }; return { scene: scene(), revision: JSON.stringify(scene()), sceneRevision: JSON.stringify(scene()), viewRevision: JSON.stringify(view), view, error: '', ready: true } },
      restore: (view: any) => imperative.updateScene({ appState: { ...(view.selectedIds ? { selectedElementIds: Object.fromEntries(view.selectedIds.map((id: string) => [id, true])) } : {}), ...(view.scrollX !== undefined ? { scrollX: view.scrollX, scrollY: view.scrollY, zoom: { value: view.zoom } } : {}), ...(view.readOnly !== undefined ? { viewModeEnabled: view.readOnly } : {}) }, captureUpdate: 'NEVER' }),
      commit: async (next: any, _revision: string, beforeWrite: any, beforeApply: any) => { const baseline = await source.api.vault.readFileBaseline(mountedView.filePath); await beforeWrite(); const written = await source.api.vault.writeFileGuarded(mountedView.filePath, JSON.stringify({ ...scene(), ...next }), baseline?.baseline ?? null); if (!written.ok) throw new Error('guarded native fixture write failed'); beforeApply(); imperative.updateScene({ ...next, captureUpdate: 'IMMEDIATELY' }) }
    }
    const offSession = registerDrawingSession(mountedView.filePath, session, mountedView), offCommands = registerDrawingActions(source.api)
    const input = (extra: any) => { const current = session.get(); return { mountedView, expectedSceneRevision: current.sceneRevision, expectedViewRevision: current.viewRevision, selectedIds: current.view.selectedIds, ...extra } }
    try {
      expect((await source.api.commands.execute('excalidraw:selection-set', input({ targetIds: ['c'] }))).ok).toBe(true)
      expect(app.state.selectedElementIds).toEqual({ c: true })
      const unchanged = JSON.stringify(elements())
      expect((await source.api.commands.execute('excalidraw:viewport-set', input({ scrollX: 45, scrollY: -90, zoom: 2 }))).ok).toBe(true)
      expect(app.state).toMatchObject({ scrollX: 45, scrollY: -90, zoom: { value: 2 } })
      expect((await source.api.commands.execute('excalidraw:read-only-set', input({ readOnly: true }))).ok).toBe(true)
      expect(app.state.viewModeEnabled).toBe(true); expect(JSON.stringify(elements())).toBe(unchanged); expect(source.api.vault.writeFileGuarded).not.toHaveBeenCalled()
      expect((await source.api.commands.execute('excalidraw:read-only-set', input({ readOnly: false }))).ok).toBe(true)
      const next = { elements: elements().map(element => element.id === 'c' ? { ...element, x: 777 } : element) }
      expect((await source.api.commands.execute('excalidraw:scene-commit', input({ scene: next }))).ok).toBe(true)
      expect(elements().find(element => element.id === 'c').x).toBe(777)
      expect(JSON.parse(await source.api.vault.readFile(mountedView.filePath)).elements.find((element: any) => element.id === 'c').x).toBe(777)
      expect(source.busUndo).toHaveLength(0); expect(source.api.workspace.openFile).not.toHaveBeenCalled(); expect(bridge.history().redo).toBe(false)
    } finally { offCommands(); offSession() }
  })

  it.each(['tool', 'edit'])('refuses a changed native scene during initial %s authorization before any native effect', async kind => {
    const { app, bridge } = board()
    let finish!: () => void
    const guard = () => new Promise<void>(resolve => { finish = resolve })
    const pending = (kind === 'tool' ? bridge.tool('rectangle', guard) : bridge.edit('selection-move', { dx: 10, dy: 10, snapToGrid: false }, guard)).catch((reason: unknown) => reason)
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    app.scene.replaceAllElements([]); finish()
    expect(await pending).toMatchObject({ code: 'REVISION_CONFLICT', outcome: 'not-applied' }); expect(app.state.activeTool.type).toBe('selection'); expect(app.scene.getElementsIncludingDeleted()).toEqual([])
  })

  it('imports the actual image picker result through the native tool and file owner before acknowledging completion', async () => {
    const { app, bridge, elements } = board()
    vi.stubGlobal('Image', class { width = 2; height = 1; naturalWidth = 2; naturalHeight = 1; onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(_value: string) { queueMicrotask(() => this.onload?.()) } })
    const originalPicker = (window as any).showOpenFilePicker
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAQAAAD8fJRsAAAADklEQVR42mP8z8AARMAAAAYAAf4CBpkAAAAASUVORK5CYII='), value => value.charCodeAt(0))
    const picker = vi.fn(async () => [{ kind: 'file', getFile: async () => new File([bytes], 'pixel.png', { type: 'image/png' }) }])
    Object.assign(window, { showOpenFilePicker: picker })
    try {
      await bridge.tool('image', async () => {})
      expect(picker).toHaveBeenCalledOnce()
      const image = elements().find(element => element.type === 'image')
      expect(image).toMatchObject({ type: 'image', width: 0, height: 0, status: 'pending' })
      expect(await app.imageCache.get(image.fileId).image).toMatchObject({ naturalWidth: 2, naturalHeight: 1 })
      expect(app.state.pendingImageElementId).toBe(image.id)
      expect(app.files[image.fileId]).toMatchObject({ mimeType: 'image/png', dataURL: 'data:image/png;base64,bmF0aXZlLXByZXZpZXc=' })
      expect(elements()).toHaveLength(4)
    } finally { Object.assign(window, { showOpenFilePicker: originalPicker }) }
  })

})
