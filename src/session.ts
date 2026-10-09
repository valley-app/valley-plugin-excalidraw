import type { FileBaseline } from '@valley/plugin-sdk/types'
import type { MountedPluginView, ValleyPluginApi } from '@valley/plugin-sdk'
import type { RawScene, EditorHandle } from './island'
import { api } from './runtime'
export type DrawingView = ReturnType<EditorHandle['getView']>
export interface DrawingSession {
  get(): { revision: string; scene: RawScene; view: DrawingView; error: string; sceneRevision?: string; viewRevision?: string; ready?: boolean; uncertain?: boolean; blocked?: boolean }
  commit(scene: RawScene, revision: string, beforeWrite?: () => Promise<void>, beforeApply?: () => void): Promise<void>
  restore(view: Partial<DrawingView>): void
  controls?: EditorHandle['controls']
  action?(name: string, value: unknown, beforePerform: () => void, beforeApply: () => void, beforeEffect?: () => Promise<void>): Promise<void>
  tool?: EditorHandle['tool']
  pen?(enabled: boolean): void
  toolLock?(): void
  library?: EditorHandle['library']
  updateLibrary?: EditorHandle['updateLibrary']
  sidebar?: EditorHandle['sidebar']
  nativeControl?: EditorHandle['nativeControl']
  nativeEdit?: EditorHandle['nativeEdit']
  persistence?(): Promise<{ diskRevision: string; draftRevision: string; dirty: boolean; uncertain: boolean; error: string }>
  lifecycle?(action: 'reload-disk' | 'retry-save', diskRevision: string, draftRevision: string, beforeEffect: () => Promise<void>, beforeApply: () => void): Promise<void>
}
export interface DrawingDraft { json: string; baseline: FileBaseline | null; error: string; uncertain?: boolean }
interface DrawingState {
  sessions: Map<string, DrawingSession>
  panes?: Map<string, DrawingSession[]>
  mounted?: Map<string, { view: MountedPluginView; session: DrawingSession }>
  // Recovery drafts belong to the mount that wrote them; same-file mounts never read or clear each other's.
  drafts: Map<string, Map<string, DrawingDraft>>
  owners?: Map<string, Map<string, number>>
  views: Map<string, Partial<DrawingView>>
  listeners: Set<() => void>
}
function state(source = api): DrawingState { return source.runtime.getOrCreate('excalidraw.sessions', () => ({ sessions: new Map(), drafts: new Map(), views: new Map(), listeners: new Set() })) }
export function drawingSession(path: string, source = api): DrawingSession | undefined { return state(source).sessions.get(path) }
export function drawingSessionCount(path: string, source = api): number { return state(source).panes?.get(path)?.length ?? 0 }
export function mountedDrawingSession(view: MountedPluginView, source: ValleyPluginApi = api): DrawingSession {
  if (source !== api || view.pluginId !== source.pluginId) throw new Error('The Excalidraw owner is unavailable.')
  const current = state(source).mounted?.get(view.mountId)
  if (!current || (['mountId', 'generation', 'area', 'paneId', 'tabId', 'filePath', 'pluginId'] as const).some(key => current.view[key] !== view[key])) throw new Error('The exact Excalidraw viewer was replaced or is unavailable.')
  return current.session
}
/** Any retained draft of `path`, or only `owner`'s own when given. */
export function drawingDraft(path: string, owner?: string): DrawingDraft | undefined {
  const drafts = state().drafts.get(path)
  if (!drafts) return undefined
  if (owner !== undefined) return drafts.get(owner)
  return [...drafts.values()].pop()
}
/** Set or clear only `owner`'s draft of `path`; another mount's draft is never touched. */
export function saveDrawingDraft(path: string, owner: string, draft: DrawingDraft | null): void {
  const drafts = state().drafts
  const owned = drafts.get(path) ?? new Map<string, DrawingDraft>()
  owned.delete(owner)
  if (draft) owned.set(owner, draft)
  if (owned.size) drafts.set(path, owned); else drafts.delete(path)
}
/** Mark `owner` as a live mount of `path` until the returned release runs. */
export function claimDrawingDraftOwner(path: string, owner: string): () => void {
  const owners = (state().owners ??= new Map()), live = owners.get(path) ?? new Map<string, number>()
  live.set(owner, (live.get(owner) ?? 0) + 1); owners.set(path, live)
  let released = false
  return () => {
    if (released) return
    released = true
    const count = (live.get(owner) ?? 1) - 1
    if (count > 0) live.set(owner, count); else live.delete(owner)
    if (!live.size && owners.get(path) === live) owners.delete(path)
  }
}
/** Owners of `path`'s drafts left by mounts that are gone, oldest first; a live mount's draft is never listed. */
export function orphanedDrawingDraftOwners(path: string): string[] {
  const drafts = state().drafts.get(path)
  if (!drafts) return []
  const live = state().owners?.get(path)
  return [...drafts.keys()].filter(key => !live?.has(key))
}
/**
 * The draft a (re)mounting `owner` resumes: its own, else the newest one left by a mount that is gone. Only the
 * adopted orphan moves to `owner`; older orphans stay retained for the next mount and are never dropped silently.
 */
export function adoptDrawingDraft(path: string, owner: string): DrawingDraft | undefined {
  const drafts = state().drafts.get(path)
  if (!drafts) return undefined
  const own = drafts.get(owner)
  if (own) return own
  const orphans = orphanedDrawingDraftOwners(path).filter(key => key !== owner)
  if (!orphans.length) return undefined
  const key = orphans[orphans.length - 1], adopted = drafts.get(key)!
  drafts.delete(key)
  drafts.set(owner, adopted)
  return adopted
}
export function notifyDrawing(): void { for (const listener of state().listeners) listener() }
export function subscribeDrawing(listener: () => void): () => void {
  const listeners = state().listeners
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function registerDrawingSession(path: string, session: DrawingSession, view?: MountedPluginView, source = api): () => void {
  if (view && (view.filePath !== path || view.pluginId !== source.pluginId)) throw new Error('Invalid Excalidraw mount identity.')
  const current = state(source)
  const panes = (current.panes ??= new Map()).get(path) ?? []
  panes.push(session); current.panes.set(path, panes)
  current.sessions.set(path, session)
  const entry = view ? { view, session } : undefined
  if (view && entry) (current.mounted ??= new Map()).set(view.mountId, entry)
  notifyDrawing()
  return () => {
    if (view && current.mounted?.get(view.mountId) === entry) current.mounted?.delete(view.mountId)
    const index = panes.indexOf(session)
    if (index >= 0) panes.splice(index, 1)
    if (current.sessions.get(path) === session) { if (panes.length) current.sessions.set(path, panes[panes.length - 1]); else current.sessions.delete(path) }
    if (!panes.length) current.panes!.delete(path)
    for (const listener of current.listeners) listener()
  }
}
export function restoreDrawingView(path: string, view: Partial<DrawingView>): void { const session = drawingSession(path); if (session) session.restore(view); else state().views.set(path, view); notifyDrawing() }
export function pendingDrawingView(path: string): Partial<DrawingView> | undefined { const view = state().views.get(path); state().views.delete(path); return view }
