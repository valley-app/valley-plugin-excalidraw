import type { FileBaseline } from '@valley/plugin-sdk/types'
import type { RawScene, EditorHandle } from './island'
import { api } from './runtime'
export type DrawingView = ReturnType<EditorHandle['getView']>
export interface DrawingSession {
  get(): { revision: string; scene: RawScene; view: DrawingView; error: string }
  commit(scene: RawScene, revision: string): Promise<void>
  restore(view: Partial<DrawingView>): void
}
interface DrawingState {
  sessions: Map<string, DrawingSession>
  drafts: Map<string, { json: string; baseline: FileBaseline | null; error: string }>
  views: Map<string, Partial<DrawingView>>
  listeners: Set<() => void>
}
function state(): DrawingState { return api.runtime.getOrCreate('excalidraw.sessions', () => ({ sessions: new Map(), drafts: new Map(), views: new Map(), listeners: new Set() })) }
export function drawingSession(path: string): DrawingSession | undefined { return state().sessions.get(path) }
export function drawingDraft(path: string) { return state().drafts.get(path) }
export function saveDrawingDraft(path: string, draft: NonNullable<ReturnType<typeof drawingDraft>> | null): void { if (draft) state().drafts.set(path, draft); else state().drafts.delete(path) }
export function notifyDrawing(): void { for (const listener of state().listeners) listener() }
export function subscribeDrawing(listener: () => void): () => void {
  const listeners = state().listeners
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function registerDrawingSession(path: string, session: DrawingSession): () => void {
  const current = state()
  current.sessions.set(path, session)
  notifyDrawing()
  return () => {
    if (current.sessions.get(path) === session) current.sessions.delete(path)
    for (const listener of current.listeners) listener()
  }
}
export function restoreDrawingView(path: string, view: Partial<DrawingView>): void { const session = drawingSession(path); if (session) session.restore(view); else state().views.set(path, view); notifyDrawing() }
export function pendingDrawingView(path: string): Partial<DrawingView> | undefined { const view = state().views.get(path); state().views.delete(path); return view }
