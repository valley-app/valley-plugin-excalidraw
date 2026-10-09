import { execFileSync } from 'node:child_process'
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest'

let native: any
let restoreCanvas: () => void
let exportedCanvas: { width: number; height: number } | undefined
let clipboardText = ''
let clipboardItems: { types: string[]; getType(type: string): Promise<Blob> }[] = []
let fileBytes = ''
let fileOpenBytes = ''
let nextFileHandle: any
beforeAll(() => {
  const source = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { build } from 'esbuild'; import fs from 'node:fs/promises'; import path from 'node:path';
    import { patchNativeActions, patchNativeEffects } from './nativeActions.mjs';
    const result = await build({ entryPoints:['node_modules/@excalidraw/excalidraw/dist/prod/index.js'],bundle:true,write:false,
      platform:'browser',format:'iife',globalName:'nativeDrawing',conditions:['production'],define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent',
      plugins:[{name:'native-matrix-fixture',setup(builder){builder.onLoad({filter:/(chunk-K2UTITRG|file-save-745eba88|file-save-3189631c)\\.js$/},async({path:file})=>({contents:patchNativeEffects(await fs.readFile(file,'utf8'),path.basename(file),path.basename(file).startsWith('file-save')?'0.29.1':'0.18.1'),loader:'js',resolveDir:path.dirname(file)}));builder.onLoad({filter:/excalidraw\\/dist\\/prod\\/index\\.js$/},async({path:file})=>({
        contents:patchNativeActions(await fs.readFile(file,'utf8'),'0.18.1',path.resolve('src/nativeBridge.ts'))+'\\nexport const valleyNativeTest={App:Ng,defaults:$n,createBridge:__valleyCreateNativeBridge,helpers:{drag:FE,transform:DE,clone:xr,textLayout:ox,container:Qt,newElement:q,bound:Jt,bounds:Se}};',loader:'js',resolveDir:path.dirname(file)
      }));}}]});process.stdout.write(result.outputFiles[0].text);
  `], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const context = new Proxy({ filter: 'none', font: '20px sans-serif', measureText: (value: string) => ({ width: value.length * 12, actualBoundingBoxAscent: 20, actualBoundingBoxDescent: 5 }) }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => {} })
  const canvasContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
  const canvasBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback: BlobCallback) { exportedCanvas = { width: this.width, height: this.height }; callback(new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' })) })
  const canvasData = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,iVBORw0KGgo=')
  restoreCanvas = () => { canvasContext.mockRestore(); canvasBlob.mockRestore(); canvasData.mockRestore() }
  Object.defineProperty(document, 'fonts', { configurable: true, value: { check: () => true, load: async () => [], ready: Promise.resolve(), add: () => {}, has: () => true, forEach: () => {} } })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async (text: string) => { clipboardText = text }, readText: async () => clipboardText,
    write: async (items: typeof clipboardItems) => { clipboardItems = items }, read: async () => clipboardItems
  } })
  class Item {
    types: string[]
    constructor(private data: Record<string, Blob>) { this.types = Object.keys(data) }
    async getType(type: string) { return this.data[type] }
    static supports(type: string) { return ['image/png', 'text/plain', 'text/html'].includes(type) }
  }
  Object.assign(window, { ClipboardItem: Item, showSaveFilePicker: async () => nextFileHandle, showOpenFilePicker: async () => [{ ...nextFileHandle, getFile: async () => new File([fileOpenBytes], 'Loaded.excalidraw', { type: 'application/json' }) }] })
  Object.assign(globalThis, { ClipboardItem: Item, FontFace: class { status = 'loaded'; loaded = Promise.resolve(this); constructor(public family: string, public source: string) {} async load() { return this } } })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false })
  Object.defineProperty(Blob.prototype, 'text', { configurable: true, value: function () { return new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(this) }) } })
  class Transfer {
    data: Record<string, string> = {}; files: File[] = []
    items = { add: (file: File) => { this.files.push(file) } }
    get types() { return Object.keys(this.data) }
    setData(type: string, data: string) { this.data[type] = data }
    getData(type: string) { return this.data[type] ?? '' }
  }
  Object.assign(globalThis, { DataTransfer: Transfer, ClipboardEvent: class extends Event { clipboardData: Transfer; constructor(type: string, value: { clipboardData: Transfer }) { super(type); this.clipboardData = value.clipboardData } } })
  native = new Function(`${source}; return nativeDrawing`)()
})
afterEach(() => { clipboardText = ''; clipboardItems = []; fileBytes = ''; fileOpenBytes = ''; exportedCanvas = undefined })
afterAll(() => restoreCanvas?.())
function board(raw?: any[], selection = ['a', 'b']) {
  const app = new native.valleyNativeTest.App({ UIOptions: { canvasActions: { clearCanvas: true, changeViewBackgroundColor: true, loadScene: true, saveToActiveFile: true, toggleTheme: true, export: { saveFileToDisk: true } }, tools: { image: true } }, aiEnabled: false, name: 'Drawing', detectScroll: false, handleKeyboardGlobally: false })
  app.setState = (patch: any, callback?: () => void) => { app.state = { ...app.state, ...(typeof patch === 'function' ? patch(app.state) : patch) }; callback?.() }
  app.interactiveCanvas = document.createElement('canvas'); app.canvas = document.createElement('canvas')
  nextFileHandle = { kind: 'file', name: 'Saved.excalidraw', getFile: async () => new File([fileBytes], 'Saved.excalidraw'), createWritable: async () => ({ write: async (data: Blob | string) => { fileBytes = typeof data === 'string' ? data : await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(data) }) }, close: async () => {} }), queryPermission: async () => 'granted', requestPermission: async () => 'granted' }
  const elements = native.restoreElements(raw ?? [
    { id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 50, version: 1, versionNonce: 1, index: 'a0', boundElements: null },
    { id: 'b', type: 'rectangle', x: 200, y: 100, width: 80, height: 40, version: 1, versionNonce: 2, index: 'a1', boundElements: null },
    { id: 'c', type: 'ellipse', x: 400, y: 200, width: 50, height: 80, version: 1, versionNonce: 3, index: 'a2', boundElements: null }
  ], null, { repairBindings: true })
  app.scene.replaceAllElements(elements)
  app.state = { ...app.state, isLoading: false, width: 800, height: 600, selectedElementIds: Object.fromEntries(selection.map(id => [id, true])), activeTool: { ...app.state.activeTool, type: 'selection' } }
  app.store.onStoreIncrementEmitter.on((entry: any) => app.history.record(entry.elementsChange, entry.appStateChange))
  app.store.shouldUpdateSnapshot(); app.store.commit(app.scene.getNonDeletedElementsMap(), app.state)
  const bridge = native.valleyNativeTest.createBridge(app, native.valleyNativeTest.helpers)
  const run = async (name: string, value: unknown = null) => { await bridge.execute(name, value, () => {}, () => {}); app.store.commit(app.scene.getNonDeletedElementsMap(), app.state) }
  return { app, bridge, run, elements: () => app.scene.getNonDeletedElements() as any[] }
}
const textElement = (extra = {}) => ({ id: 'text', type: 'text', x: 10, y: 10, width: 120, height: 25, text: 'Blätter äöüß', originalText: 'Blätter äöüß', fontSize: 20, fontFamily: 1, lineHeight: 1.25, textAlign: 'left', verticalAlign: 'top', autoResize: true, containerId: null, ...extra })
const arrowElement = (extra = {}) => ({ id: 'arrow', type: 'arrow', x: 0, y: 0, width: 200, height: 100, points: [[0, 0], [90, 30], [200, 100]], startArrowhead: null, endArrowhead: 'arrow', ...extra })
describe('native drawing property and algorithm effects', () => {
  it.each([
    ['changeFillStyle', ['hachure', 'cross-hatch', 'solid', 'zigzag'], 'fillStyle'], ['changeStrokeWidth', [1, 2, 4], 'strokeWidth'],
    ['changeSloppiness', [0, 1, 2], 'roughness'], ['changeStrokeStyle', ['solid', 'dashed', 'dotted'], 'strokeStyle'], ['changeOpacity', [0, 1, 50, 99, 100], 'opacity']
  ])('applies every %s scalar option to selected elements only', async (name, values, field) => {
    const { run, elements } = board(); const untouched = JSON.stringify(elements()[2])
    for (const value of values as any[]) { await run(String(name), value); expect(elements().slice(0, 2).map(element => element[String(field)])).toEqual([value, value]); expect(JSON.stringify(elements()[2])).toBe(untouched) }
  })
  it.each(['start', 'end'])('applies every native %s arrowhead option without altering the other endpoint', async position => {
    const { run, elements, app } = board([arrowElement(), { id: 'other', type: 'rectangle', x: 500, y: 0, width: 20, height: 20 }], ['arrow'])
    const other = JSON.stringify(elements()[1]), opposite = position === 'start' ? 'end' : 'start', retained = elements()[0][`${opposite}Arrowhead`]
    for (const type of [null, 'arrow', 'bar', 'dot', 'circle', 'circle_outline', 'triangle', 'triangle_outline', 'diamond', 'diamond_outline', 'crowfoot_one', 'crowfoot_many', 'crowfoot_one_or_many']) {
      await run('changeArrowhead', { position, type }); expect(elements()[0][`${position}Arrowhead`]).toBe(type); expect(elements()[0][`${opposite}Arrowhead`]).toBe(retained); expect(app.state[position === 'start' ? 'currentItemStartArrowhead' : 'currentItemEndArrowhead']).toBe(type); expect(JSON.stringify(elements()[1])).toBe(other)
    }
  })
  it.each(['sharp', 'round', 'elbow'])('runs native %s arrow conversion and preserves endpoints', async type => {
    const { run, elements, app } = board([arrowElement()], ['arrow'])
    await run('changeArrowType', type)
    const arrow = elements()[0]
    expect(arrow.elbowed).toBe(type === 'elbow'); expect(!!arrow.roundness).toBe(type === 'round'); expect(app.state.currentItemArrowType).toBe(type)
    expect(arrow.points[0]).toEqual([0, 0]); expect(arrow.points.at(-1)).toEqual([200, 100])
  })
  it('runs actual native text sizes, relative size commands and all font families', async () => {
    const { run, elements, app } = board([textElement(), { id: 'other', type: 'rectangle', x: 500, y: 0, width: 20, height: 20 }], ['text'])
    const other = JSON.stringify(elements()[1])
    for (const size of [1, 16, 20, 28, 36, 1000]) { await run('changeFontSize', size); expect(elements()[0].fontSize).toBe(size); expect(app.state.currentItemFontSize).toBe(size); expect(elements()[0].originalText).toBe('Blätter äöüß') }
    await run('changeFontSize', 20); await run('increaseFontSize'); expect(elements()[0].fontSize).toBe(22); await run('decreaseFontSize'); expect(elements()[0].fontSize).toBe(20)
    for (const family of [1, 2, 3, 5, 6, 7, 8]) { await run('changeFontFamily', { currentItemFontFamily: family }); expect(elements()[0].fontFamily).toBe(family); expect(app.state.currentItemFontFamily).toBe(family); expect(elements()[0].originalText).toBe('Blätter äöüß') }
    expect(JSON.stringify(elements()[1])).toBe(other)
  })
  it.each(['left', 'center', 'right'])('runs native %s text alignment', async alignment => {
    const { run, elements, app } = board([textElement()], ['text']); await run('changeTextAlign', alignment); expect(elements()[0].textAlign).toBe(alignment); expect(app.state.currentItemTextAlign).toBe(alignment)
  })
  it.each(['top', 'middle', 'bottom'])('runs native %s bound text vertical alignment', async alignment => {
    const { run, elements } = board([{ id: 'box', type: 'rectangle', x: 0, y: 0, width: 200, height: 100, boundElements: [{ type: 'text', id: 'text' }] }, textElement({ containerId: 'box' })], ['box'])
    await run('changeVerticalAlign', alignment); expect(elements()[1].verticalAlign).toBe(alignment)
    expect(elements()[1].y).toBeGreaterThanOrEqual(elements()[0].y); expect(elements()[1].y + elements()[1].height).toBeLessThanOrEqual(elements()[0].y + elements()[0].height)
  })
  it.each(['sharp', 'round'])('runs native %s edge roundness', async roundness => {
    const { run, elements, app } = board(); await run('changeRoundness', roundness); expect(elements().slice(0, 2).every(element => !!element.roundness === (roundness === 'round'))).toBe(true); expect(app.state.currentItemRoundness).toBe(roundness)
  })
  it('binds and unbinds actual native text without losing Unicode or unrelated elements', async () => {
    const { run, elements, app } = board([{ id: 'box', type: 'rectangle', x: 0, y: 0, width: 200, height: 100 }, textElement(), { id: 'other', type: 'ellipse', x: 500, y: 0, width: 20, height: 20 }], ['box', 'text'])
    const other = JSON.stringify(elements()[2]); await run('bindText')
    expect(elements()[1].containerId).toBe('box'); expect(elements()[0].boundElements).toContainEqual({ id: 'text', type: 'text' }); expect(app.state.selectedElementIds).toEqual({ box: true })
    await run('unbindText'); expect(elements()[1].containerId).toBeNull(); expect(elements()[0].boundElements).toEqual([]); expect(elements()[1].originalText).toBe('Blätter äöüß'); expect(JSON.stringify(elements()[2])).toBe(other)
  })
  it('wraps native text in a new container then restores native auto-size dimensions', async () => {
    const { run, elements } = board([textElement({ autoResize: false, width: 300 })], ['text'])
    await run('autoResize'); expect(elements()[0].autoResize).toBe(true); expect(elements()[0].width).toBeLessThan(300)
    await run('wrapTextInContainer'); expect(elements()).toHaveLength(2)
    const text = elements().find(element => element.type === 'text'), box = elements().find(element => element.type === 'rectangle')
    expect(text.containerId).toBe(box.id); expect(box.boundElements).toContainEqual({ id: text.id, type: 'text' }); expect(text.textAlign).toBe('center'); expect(text.verticalAlign).toBe('middle')
  })
  it.each(['distributeHorizontally', 'distributeVertically'])('runs native %s and observes equal free gaps', async name => {
    const { run, elements } = board(undefined, ['a', 'b', 'c']); await run(name)
    const [a, b, c] = elements().sort((a, b) => name.endsWith('Horizontally') ? a.x - b.x : a.y - b.y)
    const gap = name.endsWith('Horizontally') ? (l: any, r: any) => r.x - l.x - l.width : (l: any, r: any) => r.y - l.y - l.height
    expect(gap(a, b)).toBeCloseTo(gap(b, c))
  })
  it.each(['flipHorizontal', 'flipVertical'])('runs native %s geometry twice and restores the original image scale', async name => {
    const { run, elements } = board([{ id: 'image', type: 'image', x: 0, y: 0, width: 100, height: 80, scale: [1, 1], fileId: 'asset', status: 'saved' }], ['image'])
    await run(name); expect(elements()[0].scale).toEqual(name === 'flipHorizontal' ? [-1, 1] : [1, -1]); await run(name); expect(elements()[0].scale).toEqual([1, 1])
  })
  it('copies native style state then applies it to a different selected element', async () => {
    const { run, elements, app } = board(); app.state.selectedElementIds = { a: true }; await run('changeStrokeColor', { currentItemStrokeColor: '#f0a' }); await run('changeOpacity', 37); await run('copyStyles')
    app.state.selectedElementIds = { b: true }; await run('pasteStyles'); expect(elements()[1].strokeColor).toBe('#f0a'); expect(elements()[1].opacity).toBe(37); expect(elements()[2].strokeColor).not.toBe('#f0a')
  })
  it('runs native theme, grid and both hand/eraser tool transitions', async () => {
    const { run, app } = board(); const theme = app.state.theme; await run('toggleTheme'); expect(app.state.theme).not.toBe(theme); await run('toggleTheme'); expect(app.state.theme).toBe(theme)
    await run('gridMode'); expect(app.state.gridModeEnabled).toBe(true); expect(app.state.objectsSnapModeEnabled).toBe(false); await run('gridMode'); expect(app.state.gridModeEnabled).toBe(false)
    for (const [name, tool] of [['toggleHandTool', 'hand'], ['toggleEraserTool', 'eraser']]) { await run(name); expect(app.state.activeTool.type).toBe(tool); await run(name); expect(app.state.activeTool.type).toBe('selection') }
    await run('setFrameAsActiveTool'); expect(app.state.activeTool.type).toBe('frame')
  })
  it('runs the actual native linear editor and finalizes its edit', async () => {
    const { run, app } = board([arrowElement()], ['arrow']); await run('toggleLinearEditor'); expect(app.state.editingLinearElement.elementId).toBe('arrow'); await run('finalize'); expect(app.state.editingLinearElement).toBeNull(); expect(app.state.cursorButton).toBe('up')
  })
  it('opens exact native crop and hyperlink/element-link dialogs', async () => {
    const image = board([{ id: 'image', type: 'image', x: 0, y: 0, width: 100, height: 80, scale: [1, 1], fileId: 'asset', status: 'saved' }], ['image'])
    await image.run('cropEditor'); expect(image.app.state.croppingElementId).toBe('image')
    const drawing = board(undefined, ['a']); await drawing.run('hyperlink'); expect(drawing.app.state.showHyperlinkPopup).toBe('editor'); await drawing.run('linkToElement'); expect(drawing.app.state.openDialog).toEqual({ name: 'elementLinkSelector', sourceElementId: 'a' })
  })
  it('adds selected native elements to the actual native library and clears the native canvas', async () => {
    const { run, bridge, elements, app } = board(); await run('addToLibrary'); const library = await bridge.library(); expect(library).toHaveLength(1); expect(library[0].elements.map((element: any) => element.id)).toEqual(['a', 'b']); expect(library[0].status).toBe('unpublished'); expect(library[0].elements[0]).not.toBe(elements()[0])
    app.state.theme = 'dark'; await run('clearCanvas'); expect(elements()).toEqual([]); expect(app.state.theme).toBe('dark'); expect(await bridge.library()).toHaveLength(1)
  })
  it('writes actual native clipboard scene bytes and copies Unicode text and element links', async () => {
    const { run, app, elements } = board([textElement()], ['text']); await run('copy'); expect(JSON.parse(clipboardText)).toMatchObject({ type: 'excalidraw/clipboard', elements: [{ id: 'text', text: 'Blätter äöüß' }] })
    await run('copyText'); expect(clipboardText).toBe('Blätter äöüß')
    app.props.generateLinkForSelection = (id: string) => `https://drawing.invalid/#${id}`; await run('copyElementLink'); expect(clipboardText).toBe('https://drawing.invalid/#text')
    await run('cut'); expect(elements()).toHaveLength(0); expect(JSON.parse(clipboardText).elements).toHaveLength(1)
  })
  it('waits for native text clipboard acknowledgement before returning', async () => {
    const { bridge } = board([textElement()], ['text']); let finish!: () => void, settled = false
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockImplementationOnce(text => new Promise<void>(resolve => { finish = () => { clipboardText = text; resolve() } }))
    const pending = bridge.execute('copyText', null, () => {}, () => {}).then(() => { settled = true })
    try { await vi.waitFor(() => expect(finish).toBeTypeOf('function')); expect(settled).toBe(false); expect(clipboardText).toBe('') } finally { finish?.() }
    await pending; expect(clipboardText).toBe('Blätter äöüß'); write.mockRestore()
  })
  it('keeps native cut selection when clipboard acknowledgement is lost', async () => {
    const { bridge, elements } = board(); const before = JSON.stringify(elements()); vi.mocked(console.error).mockImplementation(() => {})
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('clipboard acknowledgement lost'))
    try { await expect(bridge.execute('cut', null, () => {}, () => {})).rejects.toMatchObject({ outcome: 'unknown', retryable: false }); expect(JSON.stringify(elements())).toBe(before); expect(write).toHaveBeenCalledOnce(); expect(vi.mocked(console.error)).not.toHaveBeenCalled(); vi.mocked(console.error).mockClear() } finally { write.mockRestore() }
  })
  it('writes every native text clipboard action through the registered host clipboard instead of the frame clipboard', async () => {
    const { run, app, bridge, elements } = board([textElement()], ['text']); const host: string[] = []
    const frame = vi.spyOn(navigator.clipboard, 'writeText')
    const off = bridge.clipboard(async (text: string) => { host.push(text) })
    try {
      await run('copy'); expect(JSON.parse(host[0])).toMatchObject({ type: 'excalidraw/clipboard', elements: [{ id: 'text', text: 'Blätter äöüß' }] })
      await run('copyText'); expect(host[1]).toBe('Blätter äöüß')
      app.props.generateLinkForSelection = (id: string) => `https://drawing.invalid/#${id}`; await run('copyElementLink'); expect(host[2]).toBe('https://drawing.invalid/#text')
      vi.mocked(console.error).mockImplementation(() => {}); await run('copyAsSvg'); expect(host[3]).toContain('<svg'); vi.mocked(console.error).mockClear()
      await run('cut'); expect(elements()).toHaveLength(0); expect(JSON.parse(host[4]).elements).toHaveLength(1)
      expect(frame).not.toHaveBeenCalled(); expect(clipboardText).toBe('')
    } finally { off(); frame.mockRestore() }
  })
  it('refuses a PNG clipboard copy before any effect while only the text host clipboard is registered', async () => {
    const { app, bridge, elements } = board(undefined, ['a']); const before = JSON.stringify(elements()); const host: string[] = []
    const write = vi.spyOn(navigator.clipboard, 'write'), beforeEffect = vi.fn(async () => {}), beforeApply = vi.fn()
    const off = bridge.clipboard(async (text: string) => { host.push(text) })
    try {
      expect(bridge.actions().find((action: { name: string }) => action.name === 'copyAsPng')).toMatchObject({ enabled: false })
      await expect(bridge.execute('copyAsPng', null, () => {}, beforeApply, beforeEffect)).rejects.toMatchObject({ code: 'CLIPBOARD_UNSUPPORTED', outcome: 'not-applied' })
      vi.mocked(console.warn).mockImplementation(() => {}); vi.mocked(console.error).mockImplementation(() => {})
      await app.actionManager.executeAction(app.actionManager.actions.copyAsPng, 'keyboard', null).catch(() => {})
      vi.mocked(console.warn).mockClear(); vi.mocked(console.error).mockClear()
      expect(beforeEffect).not.toHaveBeenCalled(); expect(beforeApply).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
      expect(clipboardItems).toHaveLength(0); expect(host).toEqual([]); expect(JSON.stringify(elements())).toBe(before)
    } finally { off(); write.mockRestore() }
    expect(bridge.actions().find((action: { name: string }) => action.name === 'copyAsPng')).toMatchObject({ enabled: true })
  })
  it('keeps native cut elements and reports the host clipboard refusal or uncertainty exactly', async () => {
    const { bridge, elements } = board(); const before = JSON.stringify(elements())
    let failure: unknown = Object.assign(new Error('The clipboard text exceeds 8 MiB.'), { code: 'CLIPBOARD_LIMIT', outcome: 'not-applied' })
    const off = bridge.clipboard(async () => { throw failure })
    try {
      await expect(bridge.execute('cut', null, () => {}, () => {})).rejects.toMatchObject({ code: 'CLIPBOARD_LIMIT', outcome: 'not-applied', effectRefused: true }); expect(JSON.stringify(elements())).toBe(before)
      failure = new Error('host clipboard acknowledgement lost')
      await expect(bridge.execute('copy', null, () => {}, () => {})).rejects.toMatchObject({ outcome: 'unknown', outcomeUnknown: true, retryable: false }); expect(JSON.stringify(elements())).toBe(before)
    } finally { off() }
  })
  it.each([['denied', new DOMException('denied', 'NotAllowedError'), 'NATIVE_ACTION_REFUSED'], ['unreadable', new Error('clipboard unreadable'), 'NATIVE_ACTION_FAILED']])('refuses a %s native paste read before authorizing any effect', async (_name, reason, code) => {
    const { bridge, elements } = board(undefined, ['a']); const before = JSON.stringify(elements()); vi.mocked(console.error).mockImplementation(() => {}); vi.mocked(console.warn).mockImplementation(() => {})
    const read = vi.spyOn(navigator.clipboard, 'read').mockRejectedValueOnce(reason), readText = vi.spyOn(navigator.clipboard, 'readText').mockRejectedValueOnce(reason)
    const beforeEffect = vi.fn(async () => {}), beforeApply = vi.fn()
    try { await expect(bridge.execute('paste', null, () => {}, beforeApply, beforeEffect)).rejects.toMatchObject({ code, outcome: 'not-applied' }); expect(beforeEffect).not.toHaveBeenCalled(); expect(beforeApply).not.toHaveBeenCalled(); expect(JSON.stringify(elements())).toBe(before) } finally { read.mockRestore(); readText.mockRestore(); vi.mocked(console.error).mockClear(); vi.mocked(console.warn).mockClear() }
  })
  it('runs native PNG export and observes its selected canvas dimensions and clipboard payload', async () => {
    const { run } = board(undefined, ['a']); await run('copyAsPng')
    expect(exportedCanvas).toEqual({ width: 120, height: 70 }); expect(clipboardItems).toHaveLength(1); expect(clipboardItems[0].types).toEqual(['image/png']); expect((await clipboardItems[0].getType('image/png')).size).toBe(8)
  })
  it.each(['zoomToFit', 'zoomToFitSelection', 'zoomToFitSelectionInViewport'])('runs native %s and positions the observed selection inside the viewport', async name => {
    const { run, app } = board([{ id: 'a', type: 'rectangle', x: 2400, y: 3500, width: 1600, height: 1000 }], ['a'])
    await run(name); expect(app.state.zoom.value).toBeGreaterThan(0); expect(app.state.zoom.value).toBeLessThan(1)
    const x = (2400 + app.state.scrollX) * app.state.zoom.value, y = (3500 + app.state.scrollY) * app.state.zoom.value
    expect(x).toBeGreaterThanOrEqual(0); expect(y).toBeGreaterThanOrEqual(0); expect(x + 1600 * app.state.zoom.value).toBeLessThanOrEqual(800); expect(y + 1000 * app.state.zoom.value).toBeLessThanOrEqual(600)
  })
  it.each(['selection', 'rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text', 'eraser', 'embeddable', 'laser', 'frame', 'hand'])('applies the actual native %s tool setter and native selection rules', tool => {
    const { app, bridge } = board(); expect(bridge.toolSupported(tool)).toBe(true); app.setActiveTool({ type: tool }); expect(app.state.activeTool.type).toBe(tool); if (tool !== 'selection') expect(app.state.selectedElementIds).toEqual({})
  })
  it('opens the actual native image file picker and preserves the scene on native cancellation', async () => {
    const { app, elements } = board(); const before = JSON.stringify(elements())
    const picker = vi.spyOn(window as any, 'showOpenFilePicker').mockRejectedValueOnce(new DOMException('cancel', 'AbortError'))
    const warnings = vi.mocked(console.warn).mockImplementation(() => {})
    try { await app.setActiveTool({ type: 'image' }); expect(picker).toHaveBeenCalledTimes(1); expect(JSON.stringify(elements())).toBe(before); expect(app.state.activeTool.type).toBe('selection'); expect(warnings.mock.calls).toHaveLength(1); expect(warnings.mock.calls[0][0]).toMatchObject({ name: 'AbortError', message: 'cancel' }) } finally { picker.mockRestore() }
  })
  it.each(['denied', 'replaced'])('refuses actual native paste %s after clipboard read before any insertion', async scenario => {
    const { run, bridge, elements, app } = board(undefined, ['a'])
    const container = document.createElement('div'); container.appendChild(app.interactiveCanvas); document.body.appendChild(container); app.excalidrawContainerRef.current = container
    app.interactiveCanvas.tabIndex = 0; app.interactiveCanvas.focus(); Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => app.interactiveCanvas })
    await run('copy'); const before = JSON.stringify(elements()); let finish!: (value: Blob) => void
    clipboardItems = [{ types: ['text/plain'], getType: () => new Promise<Blob>(resolve => { finish = resolve }) }]
    let denied = false
    const pending = bridge.execute('paste', null, () => {}, () => {}, async () => { if (denied) throw Object.assign(new Error('authorization denied'), { code: 'DENIED', outcome: 'not-applied' }) })
    const outcome = pending.catch((error: unknown) => error)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    if (scenario === 'denied') denied = true
    else app.scene.replaceAllElements(native.restoreElements([{ id: 'replacement', type: 'ellipse', x: 300, y: 500, width: 80, height: 60 }], null))
    const expected = JSON.stringify(elements()); finish(new Blob([clipboardText], { type: 'text/plain' }))
    const failure = await outcome
    expect(failure).toMatchObject({ code: scenario === 'denied' ? 'DENIED' : 'REVISION_CONFLICT', outcome: 'not-applied' }); expect(JSON.stringify(elements())).toBe(expected); if (scenario === 'denied') expect(JSON.stringify(elements())).toBe(before); container.remove()
  })
  it('exports selected native SVG geometry to actual clipboard text', async () => {
    const { run, elements } = board(undefined, ['a']); await run('copyAsSvg')
    expect(clipboardText).toContain('<svg'); expect(clipboardText).toContain('width="120"'); expect(clipboardText).toContain('height="70"'); expect(clipboardText).toContain('<path'); expect(elements()).toHaveLength(3)
  })
  it('loads an actual native scene from the selected file handle', async () => {
    const { run, elements, app } = board()
    fileOpenBytes = JSON.stringify({ type: 'excalidraw', version: 2, source: 'native-fixture', elements: [{ id: 'loaded', type: 'ellipse', x: 31, y: 42, width: 74, height: 83 }], appState: { viewBackgroundColor: '#edfedf' }, files: {} })
    await run('loadScene'); expect(elements().map(element => element.id)).toEqual(['loaded']); expect(elements()[0]).toMatchObject({ x: 31, y: 42, width: 74, height: 83 }); expect(app.state.viewBackgroundColor).toBe('#edfedf')
  })
  it('pastes actual native clipboard scene elements into the native scene', async () => {
    const { run, elements, app } = board(undefined, ['a'])
    const container = document.createElement('div'); container.appendChild(app.interactiveCanvas); document.body.appendChild(container); app.excalidrawContainerRef.current = container
    app.interactiveCanvas.tabIndex = 0; app.interactiveCanvas.focus(); Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => app.interactiveCanvas })
    await run('copy'); clipboardItems = [{ types: ['text/plain'], getType: async () => new Blob([clipboardText], { type: 'text/plain' }) }]
    await run('paste'); await vi.waitFor(() => expect(elements()).toHaveLength(4))
    const inserted = elements().find(element => !['a', 'b', 'c'].includes(element.id)); expect(inserted).toMatchObject({ type: 'rectangle', width: 100, height: 50 }); expect(app.state.selectedElementIds).toEqual({ [inserted.id]: true }); container.remove()
  })
  it('persists the actual native serialized scene through save-as and existing native handle', async () => {
    const { run, app, elements } = board(); await run('saveFileToDisk'); expect(JSON.parse(fileBytes)).toMatchObject({ type: 'excalidraw', elements: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }); expect(app.state.fileHandle).toBe(nextFileHandle)
    await run('changeOpacity', 26); await run('saveToActiveFile'); expect(JSON.parse(fileBytes).elements[0].opacity).toBe(26); expect(elements()[0].opacity).toBe(26)
  })
})
