/**
 * A blank Excalidraw scene in the standard `.excalidraw` on-disk format
 * (`type: 'excalidraw'`, `version: 2`) — the same JSON excalidraw.com reads and
 * writes, so drawings stay portable. New files are seeded with this.
 */
export const EMPTY_SCENE = {
  type: 'excalidraw',
  version: 2,
  source: 'https://excalidraw.com',
  elements: [] as unknown[],
  appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
  files: {} as Record<string, unknown>
}

export const EMPTY_SCENE_JSON = JSON.stringify(EMPTY_SCENE, null, 2)
