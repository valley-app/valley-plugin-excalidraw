export interface RawScene {
  elements?: readonly unknown[]
  appState?: Record<string, unknown>
  files?: Record<string, unknown>
}

export const LOCAL_APP_STATE_KEYS = ['gridSize', 'gridStep', 'gridModeEnabled', 'viewBackgroundColor'] as const

type SceneValues = Required<RawScene>

export function createSceneSerialization(read: () => SceneValues, encode: (scene: SceneValues) => string) {
  let fingerprint: unknown[][] | null = null
  let current: SceneValues | null = null
  let json: string | null = null
  let needsRead = true
  let disposed = false
  const observe = (scene: SceneValues): void => {
    if (disposed) return
    const next: unknown[][] = []
    const files = new Set<string>()
    for (const raw of scene.elements) {
      const element = raw as Record<string, unknown>
      next.push([element.id, element.version, element.versionNonce, element.isDeleted,
        element.version === undefined ? raw : null])
      if (!element.isDeleted && typeof element.fileId === 'string') files.add(element.fileId)
    }
    next.push(LOCAL_APP_STATE_KEYS.map((key) => scene.appState[key]))
    for (const id of files) {
      const file = scene.files[id]
      next.push([id, ...(file && typeof file === 'object' ? Object.entries(file).flat() : [file])])
    }
    if (!fingerprint || next.length !== fingerprint.length || next.some((row, index) =>
      row.length !== fingerprint![index].length || row.some((value, column) => value !== fingerprint![index][column]))) json = null
    fingerprint = next
    current = scene
    needsRead = false
  }
  return {
    observe,
    invalidate(): void { if (!disposed) { json = null; needsRead = true } },
    serialize(): string {
      if (disposed) return ''
      if (needsRead) observe(read())
      return json ?? (json = encode(current!))
    },
    dispose(): void { disposed = true; fingerprint = null; current = null; json = null }
  }
}
