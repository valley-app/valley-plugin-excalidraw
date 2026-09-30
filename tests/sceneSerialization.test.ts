import { beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createSceneSerialization, LOCAL_APP_STATE_KEYS, type RawScene } from '../src/sceneSerialization'

let serializeAsJSON: typeof import('@excalidraw/excalidraw')['serializeAsJSON']
let defaultState: Record<string, unknown>
beforeAll(async () => {
  const source = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { build } from 'esbuild';
    const result = await build({
      stdin: { contents: "export { serializeAsJSON, restoreAppState } from '@excalidraw/excalidraw'", resolveDir: process.cwd() },
      bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'pinnedSerializer',
      loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent'
    });
    process.stdout.write(result.outputFiles[0].text);
  `], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ filter: 'none' } as CanvasRenderingContext2D)
  try {
    const library = new Function(`${source}; return pinnedSerializer`)() as Pick<typeof import('@excalidraw/excalidraw'), 'serializeAsJSON' | 'restoreAppState'>
    serializeAsJSON = library.serializeAsJSON
    defaultState = library.restoreAppState({}, null) as unknown as Record<string, unknown>
  } finally { canvas.mockRestore() }
})

const encode = (scene: Required<RawScene>): string => serializeAsJSON(
  scene.elements as Parameters<typeof serializeAsJSON>[0], scene.appState,
  scene.files as Parameters<typeof serializeAsJSON>[2], 'local'
)
const rectangle = (id = 'shape') => ({ id, type: 'rectangle', x: 0, y: 0, width: 100, height: 50, version: 1, versionNonce: 11, isDeleted: false })
const original = (): Required<RawScene> => ({ elements: [rectangle()], appState: { viewBackgroundColor: '#ffffff', gridSize: 20, gridStep: 5, gridModeEnabled: false }, files: {} })

describe('canonical scene serialization reuse', () => {
  it('encodes once across repeated reads and 100 pan/zoom/selection callbacks using the pinned serializer', () => {
    let scene = original()
    const serialize = vi.fn(encode)
    const read = vi.fn(() => scene)
    const cache = createSceneSerialization(read, serialize)
    const baseline = cache.serialize()
    expect(baseline).toBe(encode(scene))
    for (let index = 0; index < 100; index++) {
      scene = { ...scene, elements: [...scene.elements], appState: { ...scene.appState, scrollX: index, zoom: { value: index + 1 }, selectedElementIds: { shape: true }, theme: 'dark', viewModeEnabled: true } }
      cache.observe(scene)
      expect(cache.serialize()).toBe(baseline)
      expect(cache.serialize()).toBe(encode(scene))
    }
    expect(serialize).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('matches every local export app-state field of the pinned Excalidraw serializer', () => {
    expect(Object.keys(JSON.parse(encode({ ...original(), appState: defaultState })).appState).sort()).toEqual([...LOCAL_APP_STATE_KEYS].sort())
    const values = { gridSize: 40, gridStep: 10, gridModeEnabled: true, viewBackgroundColor: '#ff0000',
      scrollX: 100, scrollY: 200, zoom: { value: 2 }, selectedElementIds: { shape: true }, name: 'New name',
      theme: 'dark', viewModeEnabled: true, exportBackground: false, exportScale: 2, exportWithDarkMode: true,
      currentItemStrokeColor: '#123456', frameRendering: { enabled: false }, objectsSnapModeEnabled: true }
    expect(Object.keys(JSON.parse(encode({ ...original(), appState: values })).appState).sort()).toEqual([...LOCAL_APP_STATE_KEYS].sort())
    for (const [key, value] of Object.entries(values)) {
      let scene = original()
      const serialize = vi.fn(encode)
      const cache = createSceneSerialization(() => scene, serialize)
      cache.serialize()
      scene = { ...scene, appState: { ...scene.appState, [key]: value } }
      cache.observe(scene)
      expect(cache.serialize()).toBe(encode(scene))
      expect(serialize).toHaveBeenCalledTimes(LOCAL_APP_STATE_KEYS.includes(key as typeof LOCAL_APP_STATE_KEYS[number]) ? 2 : 1)
    }
  })

  it('invalidates ordered element revisions, deletion, referenced image data and forced replacements', () => {
    let scene = original()
    const serialize = vi.fn(encode)
    const cache = createSceneSerialization(() => scene, serialize)
    const verify = () => { cache.observe(scene); expect(cache.serialize()).toBe(encode(scene)) }
    verify()
    scene = { ...scene, elements: [{ ...rectangle(), x: 20, version: 2, versionNonce: 12 }, rectangle('other')] }; verify()
    scene = { ...scene, elements: [...scene.elements].reverse() }; verify()
    scene = { ...scene, elements: [{ ...rectangle('other'), isDeleted: true, version: 2 }, scene.elements[1]] }; verify()
    scene = { ...scene, elements: [...scene.elements, { ...rectangle('image'), type: 'image', fileId: 'image-file' }], files: { 'image-file': { id: 'image-file', mimeType: 'image/png', dataURL: 'data:image/png;base64,one', created: 1 } } }; verify()
    const image = scene.files['image-file'] as Record<string, unknown>
    image.dataURL = 'data:image/png;base64,two'
    verify()
    expect(serialize).toHaveBeenCalledTimes(6)
    scene = { ...scene, files: { ...scene.files, unused: { id: 'unused', dataURL: 'ignored' } } }; verify()
    expect(serialize).toHaveBeenCalledTimes(6)
    scene = { ...original(), elements: [{ ...rectangle(), x: 500 }] }
    cache.invalidate()
    expect(cache.serialize()).toBe(encode(scene))
    expect(serialize).toHaveBeenCalledTimes(7)
    cache.dispose(); cache.observe(original()); cache.invalidate()
    expect(cache.serialize()).toBe('')
    expect(serialize).toHaveBeenCalledTimes(7)
  })
})
