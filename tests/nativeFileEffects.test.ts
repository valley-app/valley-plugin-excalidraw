import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/dom'
import { nativeEffectSources, patchNativeEffects } from '../nativeActions.mjs'
import { createNativeBridge, nativeExportGuard } from '../src/nativeBridge'

type BeforeEffect = (data: Blob | string) => Promise<void>
type Save = (data: Blob | Response | Promise<Blob>, options?: { fileName?: string; __valleyBeforeEffect?: BeforeEffect }, handle?: unknown) => Promise<unknown>
const sourcePath = (name: string) => name.startsWith('file-save-') ? `node_modules/browser-fs-access/dist/${name}` : `node_modules/@excalidraw/excalidraw/dist/prod/${name}`
const originals = Object.fromEntries(Object.keys(nativeEffectSources).map(name => [name, readFileSync(sourcePath(name), 'utf8')]))
const modern = 'file-save-745eba88.js'
const fallback = 'file-save-3189631c.js'
function saveFunction(name: string, patched = true): Save {
  const source = patched ? patchNativeEffects(originals[name], name, nativeEffectSources[name].version) : originals[name]
  return new Function(source.replace('export{e as default};', 'return e;'))() as Save
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
}
async function bytes(value: Blob | string | Uint8Array): Promise<Uint8Array> {
  if (typeof value === 'string') return new TextEncoder().encode(value)
  if (value instanceof Uint8Array) return value
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  if (typeof value.arrayBuffer === 'function') return new Uint8Array(await value.arrayBuffer())
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(value)
  })
}
const restorers: (() => void)[] = []
function property(owner: object, key: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(owner, key)
  Object.defineProperty(owner, key, { configurable: true, value })
  restorers.push(() => { if (previous) Object.defineProperty(owner, key, previous); else Reflect.deleteProperty(owner, key) })
}
afterEach(() => { for (const restore of restorers.splice(0).reverse()) restore(); vi.restoreAllMocks() })
function target(options: { close?: Promise<void>; abortFails?: boolean; create?: Promise<void>; pick?: Promise<void> } = {}) {
  let committed = new TextEncoder().encode('retained native bytes')
  let staged: Uint8Array[] = []
  const write = vi.fn(async (value: Blob | string | Uint8Array) => { staged.push(await bytes(value)) })
  const close = vi.fn(async () => {
    await options.close
    const next = new Uint8Array(staged.reduce((size, item) => size + item.byteLength, 0))
    let offset = 0
    for (const item of staged) { next.set(item, offset); offset += item.byteLength }
    committed = next
  })
  const abort = vi.fn(async () => { if (options.abortFails) throw new Error('Native abort acknowledgment lost'); staged = [] })
  const writable = new WritableStream<Blob | string | Uint8Array>({ write, close, abort })
  Object.defineProperties(writable, { write: { value: write }, close: { value: close }, abort: { value: abort } })
  const createWritable = vi.fn(async () => { await options.create; return writable })
  const handle = { kind: 'file', name: 'Drawing.excalidraw', createWritable, getFile: async () => new File([new Uint8Array(committed)], 'Drawing.excalidraw') }
  const picker = vi.fn(async () => { await options.pick; return handle })
  property(window, 'showSaveFilePicker', picker)
  return { handle, picker, createWritable, write, close, abort, committed: () => new TextDecoder().decode(committed) }
}
function denial() { return Object.assign(new Error('Native effect authorization revoked'), { code: 'PERMISSION_DENIED', outcome: 'not-applied', retryable: false }) }
function nativeOwner(save: Save, data: Blob | Promise<Blob>, authorization?: Promise<void>, authorizationAt = 1) {
  let elements: unknown[] = []
  let allowed = true
  let authorizationCalls = 0
  const library: { currLibraryItems: unknown[] } = { currLibraryItems: [] }
  const app = {
    id: 'native-file-owner', props: { UIOptions: { canvasActions: {} } }, state: { viewModeEnabled: false },
    history: { isUndoStackEmpty: true, isRedoStackEmpty: true }, library,
    scene: { getElementsIncludingDeleted: () => elements },
    actionManager: {
      actions: { export: { name: 'export', perform: async () => { await save(data, { fileName: 'Drawing.excalidraw', __valleyBeforeEffect: nativeExportGuard(app) }); return { captureUpdate: 'NEVER' } } } },
      isActionEnabled: () => true,
      executeAction: async (action: { perform: (...args: unknown[]) => unknown }) => { await action.perform(elements, app.state) }
    }
  }
  const authorize = vi.fn(async () => { if (++authorizationCalls === authorizationAt) await authorization; if (!allowed) throw denial() })
  const bridge = createNativeBridge(app as unknown as Parameters<typeof createNativeBridge>[0])
  return { run: () => bridge.execute('export', null, () => {}, () => {}, authorize), revoke: () => { allowed = false }, replaceScene: () => { elements = [] }, replaceLibrary: () => { library.currLibraryItems = [{ id: 'changed-library-item' }] }, authorize }
}
function downloadTarget() {
  const objectUrl = vi.fn((_blob: Blob) => 'blob:native-file-effect')
  const revoke = vi.fn()
  let clicked: { href: string; name: string } | null = null
  property(URL, 'createObjectURL', objectUrl)
  property(URL, 'revokeObjectURL', revoke)
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked = { href: this.href, name: this.download } })
  return { objectUrl, click, clicked: () => clicked }
}

describe('pinned native file publication effects', () => {
  it.each(Object.keys(nativeEffectSources))('refuses %s version drift before transforming native code', name => {
    expect(() => patchNativeEffects(originals[name], name, '0.0.0')).toThrow('pinned')
  })
  it.each(Object.keys(nativeEffectSources))('refuses %s byte drift before transforming native code', name => {
    expect(() => patchNativeEffects(`${originals[name]}\n`, name, nativeEffectSources[name].version)).toThrow('pinned')
  })
  it('refuses an unrecognized native dependency leaf', () => {
    expect(() => patchNativeEffects(originals[modern], 'file-save-other.js', '0.29.1')).toThrow('pinned')
  })
  it.each(['authorization', 'scene'] as const)('checks the original %s after a delayed native picker', async change => {
    const pick = deferred<void>(), file = target({ pick: pick.promise })
    const owner = nativeOwner(saveFunction(modern), new Blob(['guarded bytes']))
    const result = owner.run().catch(error => error)
    await waitFor(() => expect(file.picker).toHaveBeenCalledOnce())
    if (change === 'authorization') owner.revoke(); else owner.replaceScene()
    pick.resolve()
    expect(await result).toMatchObject({ outcome: 'not-applied', code: change === 'authorization' ? 'PERMISSION_DENIED' : 'REVISION_CONFLICT' })
    expect(file.createWritable).not.toHaveBeenCalled()
    expect(file.write).not.toHaveBeenCalled()
    expect(file.committed()).toBe('retained native bytes')
  })
  it('reauthorizes the original owner after asynchronous blob rendering', async () => {
    const render = deferred<Blob>(), file = target()
    const owner = nativeOwner(saveFunction(modern), render.promise)
    const result = owner.run().catch(error => error)
    await waitFor(() => expect(file.picker).toHaveBeenCalledOnce())
    owner.revoke(); render.resolve(new Blob(['guarded bytes']))
    expect(await result).toMatchObject({ code: 'PERMISSION_DENIED', outcome: 'not-applied' })
    expect(file.createWritable).not.toHaveBeenCalled()
    expect(file.write).not.toHaveBeenCalled()
    expect(file.committed()).toBe('retained native bytes')
  })
  it.each([1, 2])('rechecks the captured native library after asynchronous authorization %s', async authorizationAt => {
    const authorization = deferred<void>(), file = target()
    const owner = nativeOwner(saveFunction(modern), new Blob(['guarded bytes']), authorization.promise, authorizationAt)
    const result = owner.run().catch(error => error)
    await waitFor(() => expect(owner.authorize).toHaveBeenCalledTimes(authorizationAt))
    owner.replaceLibrary(); authorization.resolve()
    expect(await result).toMatchObject({ code: 'REVISION_CONFLICT', outcome: 'not-applied' })
    expect(file.createWritable).toHaveBeenCalledTimes(authorizationAt - 1)
    expect(file.abort).toHaveBeenCalledTimes(authorizationAt - 1)
    expect(file.write).not.toHaveBeenCalled()
    expect(file.committed()).toBe('retained native bytes')
  })
  it.each(['authorization', 'scene'] as const)('aborts an opened native writable when %s changes during its creation', async change => {
    const create = deferred<void>(), file = target({ create: create.promise })
    const owner = nativeOwner(saveFunction(modern), new Blob(['guarded bytes']))
    const result = owner.run().catch(error => error)
    await waitFor(() => expect(file.createWritable).toHaveBeenCalledOnce())
    if (change === 'authorization') owner.revoke(); else owner.replaceScene()
    create.resolve()
    expect(await result).toMatchObject({ outcome: 'not-applied', code: change === 'authorization' ? 'PERMISSION_DENIED' : 'REVISION_CONFLICT' })
    expect(file.abort).toHaveBeenCalledOnce()
    expect(file.write).not.toHaveBeenCalled()
    expect(file.close).not.toHaveBeenCalled()
    expect(file.committed()).toBe('retained native bytes')
  })
  it('preserves unknown outcome when the denied native writable fails to acknowledge abort', async () => {
    const create = deferred<void>(), file = target({ create: create.promise, abortFails: true })
    const owner = nativeOwner(saveFunction(modern), new Blob(['guarded bytes']))
    const result = owner.run().catch(error => error)
    await waitFor(() => expect(file.createWritable).toHaveBeenCalledOnce())
    owner.revoke(); create.resolve()
    expect(await result).toMatchObject({ code: 'PERMISSION_DENIED', outcome: 'unknown', outcomeUnknown: true, retryable: false })
    expect(file.abort).toHaveBeenCalledOnce()
    expect(file.write).not.toHaveBeenCalled()
    expect(file.committed()).toBe('retained native bytes')
  })
  it('publishes actual rendered bytes and waits for the native close acknowledgment', async () => {
    const finish = deferred<void>(), file = target({ close: finish.promise })
    let returned = false
    const result = saveFunction(modern)(new Blob(['native äöüß bytes']), { __valleyBeforeEffect: async () => {} }).then(handle => { returned = true; return handle })
    await waitFor(() => expect(file.close).toHaveBeenCalledOnce())
    expect(file.committed()).toBe('retained native bytes')
    expect(returned).toBe(false)
    finish.resolve()
    expect(await result).toBe(file.handle)
    expect(file.committed()).toBe('native äöüß bytes')
    expect(file.write).toHaveBeenCalledOnce()
  })
  it('publishes the same guarded Response bytes after resolving the response body', async () => {
    const file = target(), guard = vi.fn(async () => {})
    expect(await saveFunction(modern)(new Response('native response bytes', { headers: { 'content-type': 'application/json' } }), { __valleyBeforeEffect: guard })).toBe(file.handle)
    expect(file.committed()).toBe('native response bytes')
    expect(guard).toHaveBeenCalledTimes(2)
    expect(file.write).toHaveBeenCalledOnce()
  })
  it('enforces the native 2 MiB export bound before opening a writable', async () => {
    const file = target()
    const owner = nativeOwner(saveFunction(modern), new Blob([new Uint8Array(2 * 1024 * 1024 + 1)]))
    await expect(owner.run()).rejects.toMatchObject({ code: 'RESOURCE_LIMIT', outcome: 'not-applied' })
    expect(file.createWritable).not.toHaveBeenCalled()
    expect(file.committed()).toBe('retained native bytes')
  })
  it('keeps the original unguarded picker, write and close behavior', async () => {
    const observations: { file: string; picks: number; writes: number; closes: number }[] = []
    for (const patched of [false, true]) {
      const file = target()
      expect(await saveFunction(modern, patched)(new Blob(['native interactive bytes']), { fileName: 'Drawing.excalidraw' })).toBe(file.handle)
      observations.push({ file: file.committed(), picks: file.picker.mock.calls.length, writes: file.write.mock.calls.length, closes: file.close.mock.calls.length })
    }
    expect(observations[1]).toEqual(observations[0])
    expect(observations[1]).toEqual({ file: 'native interactive bytes', picks: 1, writes: 1, closes: 1 })
  })
  it('checks late authorization before fallback object URL creation or download click', async () => {
    const render = deferred<Blob>(), download = downloadTarget()
    const owner = nativeOwner(saveFunction(fallback), render.promise)
    const result = owner.run().catch(error => error)
    owner.revoke(); render.resolve(new Blob(['fallback bytes']))
    expect(await result).toMatchObject({ code: 'PERMISSION_DENIED', outcome: 'not-applied' })
    expect(download.objectUrl).not.toHaveBeenCalled()
    expect(download.click).not.toHaveBeenCalled()
  })
  it('enforces the native fallback blob bound before object URL creation or download click', async () => {
    const download = downloadTarget()
    const owner = nativeOwner(saveFunction(fallback), new Blob([new Uint8Array(2 * 1024 * 1024 + 1)]))
    await expect(owner.run()).rejects.toMatchObject({ code: 'RESOURCE_LIMIT', outcome: 'not-applied' })
    expect(download.objectUrl).not.toHaveBeenCalled()
    expect(download.click).not.toHaveBeenCalled()
  })
  it('downloads the actual bounded fallback blob after its guard', async () => {
    const download = downloadTarget(), blob = new Blob(['native fallback äöüß bytes'])
    await nativeOwner(saveFunction(fallback), blob).run()
    expect(download.objectUrl).toHaveBeenCalledOnce()
    expect(Array.from(await bytes(download.objectUrl.mock.calls[0][0]))).toEqual(Array.from(new TextEncoder().encode('native fallback äöüß bytes')))
    expect(download.click).toHaveBeenCalledOnce()
    expect(download.clicked()).toEqual({ href: 'blob:native-file-effect', name: 'Drawing.excalidraw' })
  })
  it('preserves the original unguarded fallback download behavior', async () => {
    for (const patched of [false, true]) {
      const download = downloadTarget(), blob = new Blob(['native interactive fallback bytes'])
      expect(await saveFunction(fallback, patched)(blob, { fileName: 'Drawing.excalidraw' })).toBeNull()
      expect(download.objectUrl).toHaveBeenCalledWith(blob)
      expect(download.click).toHaveBeenCalledOnce()
      expect(download.clicked()).toEqual({ href: 'blob:native-file-effect', name: 'Drawing.excalidraw' })
    }
  })
})
describe('native action failure outcomes', () => {
  function failingOwner(guarded: boolean) {
    const elements: unknown[] = []
    const app = {
      id: 'native-failure-owner', props: { UIOptions: { canvasActions: {} } }, state: { viewModeEnabled: false, errorMessage: null },
      history: { isUndoStackEmpty: true, isRedoStackEmpty: true }, library: { currLibraryItems: [] },
      scene: { getElementsIncludingDeleted: () => elements },
      actionManager: {
        actions: { paste: { name: 'paste', perform: async () => { if (guarded) await nativeExportGuard(app)('native clipboard text'); return { captureUpdate: 'EVENTUALLY', appState: { errorMessage: 'Native clipboard failure' } } } } },
        isActionEnabled: () => true,
        executeAction: async (action: { perform: (...args: unknown[]) => unknown }) => { await action.perform(elements, app.state) }
      }
    }
    return createNativeBridge(app as unknown as Parameters<typeof createNativeBridge>[0])
  }
  it.each([[false, 'not-applied'], [true, 'unknown']] as const)('reports a native error message after authorized effect %s as %s', async (guarded, outcome) => {
    await expect(failingOwner(guarded).execute('paste', null, () => {}, () => {}, async () => {})).rejects.toMatchObject({ code: 'NATIVE_ACTION_FAILED', outcome, retryable: false })
  })
})
