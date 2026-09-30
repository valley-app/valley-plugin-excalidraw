import { execFileSync } from 'node:child_process'
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { isDrawingPath, parseScene, readScene, writeScene } from '../src/formats'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { initRuntime } from '../src/runtime'
import { readDrawing, updateDrawing } from '../src/commands'
import { registerDrawingSurfaces } from '../src/surfaces'
import { PLUGIN_SURFACE_V1 } from '@valley/plugin-sdk'
import { pendingDrawingView } from '../src/session'
import { createDrawingPreviews } from '../src/previews'
import type { RawScene } from '../src/sceneSerialization'

const island = vi.hoisted(() => ({ decode: vi.fn(), encode: vi.fn() }))
vi.mock('../src/island', () => ({ decodeDrawingSvg: island.decode, encodeDrawingSvg: island.encode }))
let restoreCanvas: () => void

beforeAll(async () => {
  const source = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { build } from 'esbuild';
    const result = await build({ entryPoints: ['src/islandRuntime.ts'], bundle: true, write: false,
      platform: 'browser', format: 'iife', globalName: 'drawingCodec', conditions: ['production'], loader: { '.css': 'empty' },
      define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
    process.stdout.write(result.outputFiles[0].text);
  `], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ filter: 'none' } as CanvasRenderingContext2D)
  restoreCanvas = () => canvas.mockRestore()
  const codec = new Function(`${source}; return drawingCodec`)() as typeof import('../src/islandRuntime')
  island.decode.mockImplementation(codec.decodeDrawingSvg)
  island.encode.mockImplementation(codec.encodeDrawingSvg)
})

afterAll(() => restoreCanvas?.())

const shape = { id: 'fern', type: 'rectangle', x: 10, y: 20, width: 100, height: 50, angle: 0,
  strokeColor: '#1b1b1f', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1,
  strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null,
  seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1,
  link: '[[Blätter äöüß.md]]', locked: false, index: 'a0' }
const drawing = { type: 'excalidraw', version: 2, elements: [shape], appState: { viewBackgroundColor: '#ffffff' }, files: {} }

describe('drawing file formats with the pinned Excalidraw codec', () => {
  it.each(['.excalidraw', '.excalidraw.json', '.excalidraw.svg'])('edits, saves and reopens %s with reversible guarded commands', async (extension) => {
    const path = `Drawings/Blätter${extension.toUpperCase()}`
    const content = await writeScene(path, JSON.stringify(drawing))
    const mock = createMockValleyApi({ manifest: { id: 'excalidraw' }, files: { [path]: content } })
    initRuntime(mock.api)
    const before = await readDrawing(mock.api, path)
    expect(before.scene.elements).toEqual([expect.objectContaining({ id: 'fern', link: shape.link })])
    const off = registerDrawingSurfaces(mock.api)
    await mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1)[0].extension.restore({ v: 1, path, selectedIds: ['fern'], zoom: 2 })
    expect(mock.api.workspace.openFile).toHaveBeenCalledWith(path)
    expect(pendingDrawingView(path)).toMatchObject({ selectedIds: ['fern'], zoom: 2 })
    off()
    const preview = vi.fn(async (_scene: RawScene) => document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
    const previews = createDrawingPreviews(mock.api, preview)
    const lease = previews.acquire(path, false, document, () => {})
    expect(await lease.load()).not.toBeNull()
    expect(preview.mock.calls[0][0]).toMatchObject({ elements: [expect.objectContaining({ id: 'fern' })] })
    lease.release(); previews.dispose()
    const changed = await updateDrawing(mock.api, path, { elements: [{ ...shape, width: 180 }] }, before.revision)
    const saved = await mock.api.vault.readFile(path)
    if (extension === '.excalidraw.svg') {
      const svg = new DOMParser().parseFromString(saved!, 'image/svg+xml')
      expect(svg.querySelector('parsererror')).toBeNull()
      expect(svg.querySelector('metadata')?.innerHTML).toContain('payload-start')
      expect(svg.querySelector('path')).not.toBeNull()
    } else expect(JSON.parse(saved!).elements[0].width).toBe(180)
    expect((await readDrawing(mock.api, path)).scene.elements?.[0]).toMatchObject({ width: 180, link: shape.link })
    await changed.revert!.run()
    expect(await mock.api.vault.readFile(path)).toBe(content)
    await changed.revert!.reapply()
    expect(await mock.api.vault.readFile(path)).toBe(saved)
    await mock.api.vault.writeFile(path, 'external edit')
    await expect(changed.revert!.run()).rejects.toThrow()
    expect(await mock.api.vault.readFile(path)).toBe('external edit')
  })

  it('round-trips an empty editable SVG with finite image bounds', async () => {
    const svg = await writeScene('Empty.excalidraw.svg', JSON.stringify({ ...drawing, elements: [] }))
    expect(svg).not.toMatch(/NaN|Infinity/)
    expect((await readScene('Empty.excalidraw.svg', svg)).elements).toEqual([])
  })

  it.each(['', '{}', 'null', '{"elements":false}', '{"elements":[null]}', '{"elements":[{}]}', '{"elements":[{"id":"broken","type":"unknown"}]}', '{"elements":[{"id":"broken","type":"rectangle","x":"bad"}]}', '{"elements":[],"files":[]}'])('rejects invalid JSON %j', (content) => {
    expect(() => parseScene(content)).toThrow('Invalid Excalidraw')
  })

  it.each(['<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10"/></svg>', '<svg><metadata>broken</metadata>'])('rejects SVGs without a valid scene', async (svg) => {
    await expect(readScene('Drawing.excalidraw.svg', svg)).rejects.toThrow('no valid embedded')
  })

  it('recognizes only the three drawing suffixes', () => {
    for (const path of ['a.excalidraw', 'a.EXCALIDRAW.JSON', 'a.excalidraw.svg']) expect(isDrawingPath(path)).toBe(true)
    for (const path of ['a.json', 'a.svg', 'a.excalidraw.svg.backup']) expect(isDrawingPath(path)).toBe(false)
  })
})
