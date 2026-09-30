import type { ValleyPluginApi } from '@valley/plugin-sdk'
import type { RawScene } from './sceneSerialization'
import { readScene } from './formats'

const RETAINED_BYTES = 16 * 1024 * 1024
const RETAINED_ENTRIES = 32
const PENDING_BYTES = 32 * 1024 * 1024
const PENDING_ENTRIES = 32
const RETIRED = 'Drawing preview is no longer active'

function createQueue() {
  type Task = { bytes: number; active(): boolean; run(): Promise<unknown>; resolve(value: unknown): void; reject(reason: unknown): void }
  const waiting: Task[] = []
  let bytes = 0
  let running = 0
  let disposed = false
  const pump = (): void => {
    while (!disposed && running < 2 && waiting.length) {
      const task = waiting.shift()!
      bytes -= task.bytes
      if (!task.active()) { task.reject(new Error(RETIRED)); continue }
      running++
      void task.run().then(task.resolve, task.reject).finally(() => { running--; pump() })
    }
  }
  return {
    run<T>(size: number, active: () => boolean, run: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (disposed || !active()) { reject(new Error(RETIRED)); return }
        for (let i = waiting.length - 1; i >= 0; i--) {
          if (waiting[i].active()) continue
          const [retired] = waiting.splice(i, 1)
          bytes -= retired.bytes; retired.reject(new Error(RETIRED))
        }
        if (waiting.length >= PENDING_ENTRIES || (running >= 2 && bytes + size > PENDING_BYTES)) {
          reject(new Error('Drawing preview queue is full')); return
        }
        waiting.push({ bytes: size, active, run, resolve: (value) => resolve(value as T), reject })
        bytes += size
        pump()
      })
    },
    dispose(): void {
      disposed = true
      for (const task of waiting.splice(0)) task.reject(new Error(RETIRED))
      bytes = 0
    }
  }
}

export function createDrawingPreviews(api: ValleyPluginApi,
  render: (scene: RawScene, dark: boolean, owner: Document, active: () => boolean) => Promise<SVGSVGElement | null>) {
  type FileState = { revision: number; listeners: Set<() => void>; pending?: Promise<string | null>; content?: string | null; bytes: number }
  type Preview = { content: string; svgFormat: boolean; dark: boolean; bytes: number; svg: SVGSVGElement | null }
  type Export = { content: string; svgFormat: boolean; dark: boolean; owner: Document; clients: Set<() => boolean>; pending: Promise<SVGSVGElement | null> }
  const files = new Map<string, FileState>()
  const retained = new Map<string, FileState>()
  const previews: Preview[] = []
  const exports: Export[] = []
  const reads = createQueue()
  const renders = createQueue()
  let cacheDocument: XMLDocument | null = null
  let retainedBytes = 0
  let disposed = false
  const activeFile = (file: FileState, revision: number): boolean => !disposed && file.revision === revision && file.listeners.size > 0
  const dropFile = (path: string, file: FileState): void => {
    retained.delete(path); retainedBytes -= file.bytes; file.bytes = 0; file.content = undefined
    if (!file.listeners.size && !file.pending) files.delete(path)
  }
  const trim = (): void => {
    while (retained.size + previews.length > RETAINED_ENTRIES || retainedBytes > RETAINED_BYTES) {
      const first = retained.entries().next().value
      if (first) dropFile(...first)
      else {
        const preview = previews.shift()
        if (!preview) break
        retainedBytes -= preview.bytes
      }
    }
  }
  const readFile = (path: string, file: FileState): Promise<string | null> => {
    if (file.content !== undefined) {
      retained.delete(path); retained.set(path, file)
      return Promise.resolve(file.content)
    }
    if (file.pending) return file.pending
    const revision = file.revision
    const active = () => activeFile(file, revision)
    const pending = reads.run(0, active, async () => {
      const content = await api.vault.readFile(path)
      if (!active()) throw new Error(RETIRED)
      const size = (content?.length ?? 0) * 2
      if (size <= RETAINED_BYTES) {
        retainedBytes -= file.bytes
        file.content = content; file.bytes = size
        retainedBytes += size; retained.delete(path); retained.set(path, file); trim()
      }
      return content
    })
    file.pending = pending
    const settled = (): void => {
      if (file.pending === pending) file.pending = undefined
      if (!file.listeners.size && file.content === undefined && files.get(path) === file) files.delete(path)
    }
    void pending.then(settled, settled)
    return pending
  }
  const renderContent = (path: string, content: string, dark: boolean, owner: Document, active: () => boolean): Promise<SVGSVGElement | null> => {
    const svgFormat = path.toLowerCase().endsWith('.excalidraw.svg')
    const cachedIndex = previews.findIndex((entry) => entry.content === content && entry.svgFormat === svgFormat && entry.dark === dark)
    if (cachedIndex >= 0) {
      const [cached] = previews.splice(cachedIndex, 1); previews.push(cached)
      return Promise.resolve(cached.svg)
    }
    let task = exports.find((entry) => entry.content === content && entry.svgFormat === svgFormat && entry.dark === dark && entry.owner === owner)
    if (!task) {
      const clients = new Set<() => boolean>()
      const valid = () => !disposed && [...clients].some((check) => check())
      clients.add(active)
      const pending = renders.run(content.length * 2, valid, async () => {
        const scene = await readScene(path, content, owner, api)
        if (!valid()) throw new Error(RETIRED)
        const svg = await render(scene, dark, owner, valid)
        if (!valid()) throw new Error(RETIRED)
        const size = content.length * 2 + (svg?.outerHTML.length ?? 0) * 2
        if (size <= RETAINED_BYTES) {
          cacheDocument ??= owner.implementation.createDocument('http://www.w3.org/2000/svg', 'svg', null)
          const template = svg ? cacheDocument.importNode(svg, true) : null
          previews.push({ content, svgFormat, dark, svg: template, bytes: size }); retainedBytes += size; trim()
        }
        return svg
      })
      task = { content, svgFormat, dark, owner, clients, pending }
      exports.push(task)
      const settled = () => { const index = exports.indexOf(task!); if (index >= 0) exports.splice(index, 1); clients.clear() }
      void pending.then(settled, settled)
    } else task.clients.add(active)
    return task.pending
  }
  const offChanges = api.vault.onChanged((info) => {
    if (disposed) return
    for (const [path, file] of files) {
      if (!info.full && !info.changes.some((change) => path === change.relPath || path.startsWith(`${change.relPath}/`))) continue
      file.revision++
      file.pending = undefined
      dropFile(path, file)
      for (const listener of file.listeners) listener()
    }
  })
  return {
    acquire(path: string, dark: boolean, owner: Document, changed: () => void) {
      if (disposed) throw new Error(RETIRED)
      const file = files.get(path) ?? { revision: 0, listeners: new Set(), bytes: 0 }
      files.set(path, file)
      const listener = () => changed()
      file.listeners.add(listener)
      let released = false
      return {
        async load(): Promise<SVGSVGElement | null> {
          const revision = file.revision
          const active = () => !released && activeFile(file, revision)
          if (!active()) throw new Error(RETIRED)
          const content = await readFile(path, file)
          if (!active()) throw new Error(RETIRED)
          if (content === null) throw new Error('Drawing file no longer exists')
          const svg = await renderContent(path, content, dark, owner, active)
          if (!active()) throw new Error(RETIRED)
          return svg ? owner.importNode(svg, true) : null
        },
        release(): void {
          if (released) return
          released = true; file.listeners.delete(listener)
          if (!file.listeners.size && !file.pending && file.content === undefined) files.delete(path)
        }
      }
    },
    dispose(): void {
      if (disposed) return
      disposed = true; offChanges(); reads.dispose(); renders.dispose()
      for (const file of files.values()) { file.content = undefined; file.bytes = 0; file.listeners.clear() }
      for (const task of exports) task.clients.clear()
      files.clear(); retained.clear(); previews.length = 0; exports.length = 0; retainedBytes = 0
      cacheDocument = null
    }
  }
}

export type DrawingPreviews = ReturnType<typeof createDrawingPreviews>
