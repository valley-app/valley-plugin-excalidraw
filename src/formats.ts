import type { ValleyPluginApi } from '@valley/plugin-sdk'
import { decodeDrawingSvg, encodeDrawingSvg } from './island'
import type { RawScene } from './sceneSerialization'
import { uiText } from './localization'

export const DRAWING_EXTENSIONS = ['.excalidraw', '.excalidraw.json', '.excalidraw.svg']
const ELEMENT_TYPES = new Set(['rectangle', 'diamond', 'ellipse', 'embeddable', 'iframe', 'image', 'frame', 'magicframe', 'text', 'line', 'arrow', 'freedraw'])

export function isDrawingPath(path: string): boolean {
  return DRAWING_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension))
}

export function parseScene(content: string): RawScene {
  try {
    const scene = JSON.parse(content)
    if (!scene || typeof scene !== 'object' || Array.isArray(scene) || !Array.isArray(scene.elements)
      || (scene.type !== undefined && scene.type !== 'excalidraw')
      || scene.elements.some((element: Record<string, unknown> | null) => !element || typeof element !== 'object' || Array.isArray(element)
        || typeof element.id !== 'string' || !element.id || !ELEMENT_TYPES.has(String(element.type))
        || ['x', 'y', 'width', 'height'].some((key) => element[key] !== undefined && (typeof element[key] !== 'number' || !Number.isFinite(element[key]))))
      || ['appState', 'files'].some((key) => scene[key] !== undefined && (!scene[key] || typeof scene[key] !== 'object' || Array.isArray(scene[key])))) throw new Error()
    return scene as RawScene
  } catch { throw new Error(uiText('excalidraw.error.invalid')) }
}

export async function readScene(path: string, content: string, owner = document, sessionApi?: ValleyPluginApi): Promise<RawScene> {
  if (!path.toLowerCase().endsWith('.excalidraw.svg')) return parseScene(content)
  try {
    return parseScene(JSON.stringify(await decodeDrawingSvg(content, owner, sessionApi)))
  } catch { throw new Error(uiText('excalidraw.error.svg')) }
}

export async function writeScene(path: string, json: string, owner = document, sessionApi?: ValleyPluginApi): Promise<string> {
  const scene = parseScene(json)
  if (!path.toLowerCase().endsWith('.excalidraw.svg')) return json
  return encodeDrawingSvg(scene, owner, sessionApi)
}
