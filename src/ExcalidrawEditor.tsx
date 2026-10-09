/**
 * The file-owning view for `.excalidraw` files (manifest `fileViews`). The host
 * mounts it as a full workspace tab with the vault-relative `relPath`. Host-side
 * lifecycle mirrors MarkdownTab + Canvas: load on mount, debounced autosave, and
 * reload on external change while staying authoritative for in-flight edits. The
 * actual Excalidraw canvas lives on its own React root inside `island.ts`.
 *
 * Undo/redo is owned by Excalidraw's own in-canvas ⌘Z history — we deliberately do
 * NOT also push per-edit entries onto `api.undo` (that would double every stroke).
 */
import { React, api } from './runtime'
import type { FC } from 'react'
import { mountEditor, type EditorHandle, type RawScene } from './island'
import { parseScene, readScene, writeScene } from './formats'
import type { FileBaseline } from '@valley/plugin-sdk/types'
import type { MountedPluginView, PluginEditorSnapshot } from '@valley/plugin-sdk'
import { acceptsNativeDrawingRequest, executeNativeDrawingRequest, executeDrawingViewCallback } from './actions'
import { uiText } from './localization'
import { adoptDrawingDraft, claimDrawingDraftOwner, drawingDraft, saveDrawingDraft, registerDrawingSession, pendingDrawingView, notifyDrawing, subscribeDrawing } from './session'

const AUTOSAVE_MS = 600
let editorInstances = 0

/** Resolve a link on a drawing element; `[[wikilinks]]` navigate inside the vault. */
function openLink(href: string, preventDefault: () => void): void {
  const trimmed = href.trim()
  const wikilink = /^\[\[(.+?)\]\]$/.exec(trimmed)
  if (wikilink) {
    preventDefault()
    const target = api.workspace.resolveWikilink(wikilink[1])
    if (target) api.workspace.openFile(target)
    return
  }
  // A bare vault-relative path (no scheme) also opens in-app.
  if (!/^[a-z][\w+.-]*:\/\//i.test(trimmed) && trimmed) {
    const target = api.workspace.resolveWikilink(trimmed)
    if (target) {
      preventDefault()
      api.workspace.openFile(target)
    }
  }
  // Otherwise (http/https/mailto…) let Excalidraw open it normally.
}

const DrawingEditor: FC<{ relPath: string; mountedView?: MountedPluginView }> = ({ relPath, mountedView: incomingView }) => {
  const mountedView = React.useMemo(() => incomingView, [incomingView?.mountId, incomingView?.generation])
  const instanceId = React.useRef('')
  if (!instanceId.current) instanceId.current = `excalidraw-instance:${++editorInstances}`
  // Recovery drafts are this copy's own; a same-file sibling neither clears nor resumes them while it is open.
  const draftOwner = mountedView?.mountId ?? instanceId.current
  const sessionApi = api
  const hostRef = React.useRef<HTMLDivElement>(null)
  const handleRef = React.useRef<EditorHandle | null>(null)
  const lastContent = React.useRef('')
  const lastScene = React.useRef('')
  const adopting = React.useRef(true)
  const dirty = React.useRef(false)
  const fileRevisionRef = React.useRef(0)
  const refreshExternalRef = React.useRef<() => Promise<void>>(() => Promise.resolve())
  const saveTimer = React.useRef<number | undefined>(undefined)
  const baseline = React.useRef<FileBaseline | null>(null)
  const queue = React.useRef<Promise<unknown>>(Promise.resolve())
  const fenced = React.useRef<string | null>(null)
  const saving = React.useRef(false)
  const controlling = React.useRef(false)
  const uncertain = React.useRef(false)
  const live = React.useRef(true)
  const terminalSnapshot = React.useRef<PluginEditorSnapshot | null>(null)
  const pendingJson = React.useRef<string | null>(null)
  const draftRevision = React.useRef({ source: '', revision: 0 })
  const [error, setError] = React.useState('')
  const errorRef = React.useRef('')
  const editorSnapshot = React.useCallback((): PluginEditorSnapshot => {
    if (!live.current && terminalSnapshot.current) return terminalSnapshot.current
    const source = pendingJson.current ?? handleRef.current?.serialize() ?? ''
    if (draftRevision.current.source !== source) draftRevision.current = { source, revision: draftRevision.current.revision + 1 }
    return { revision: `${mountedView?.mountId ?? relPath}:${draftRevision.current.revision}`, dirty: dirty.current || Boolean(source && source !== lastScene.current), readiness: uncertain.current ? 'uncertain' : !handleRef.current ? 'loading' : saving.current ? 'saving' : 'ready' }
  }, [mountedView?.mountId, relPath])
  React.useEffect(() => {
    live.current = true
    terminalSnapshot.current = null
    if (!mountedView) return
    const off = sessionApi.vault.editors.register(mountedView, {
      getSnapshot: editorSnapshot,
      // Drawing notifications are shared by every mount; report only this copy's own draft changes, so another
      // same-file mount's view or save churn never invalidates a fence this copy has already admitted.
      subscribe: listener => {
        let last = JSON.stringify(editorSnapshot())
        return subscribeDrawing(() => { const next = JSON.stringify(editorSnapshot()); if (next !== last) { last = next; listener() } })
      },
      prepare: (revision, request) => {
        if (!live.current || fenced.current || editorSnapshot().revision !== revision) throw new Error(uiText('excalidraw.error.changed'))
        const handle = handleRef.current, host = hostRef.current
        if (!handle || !host) throw new Error(uiText('excalidraw.error.loading'))
        const readOnly = handle.getView().readOnly, inert = host.inert
        fenced.current = request.fenceId
        window.clearTimeout(saveTimer.current)
        host.inert = true
        handle.restoreView({ readOnly: true })
        return { validate: editorSnapshot, release: () => {
          if (fenced.current !== request.fenceId) return
          fenced.current = null
          host.inert = inert
          handle.restoreView({ readOnly })
          if (!request.ownSave) void refreshExternalRef.current()
        } }
      }
    })
    return () => {
      const snapshot = editorSnapshot()
      terminalSnapshot.current = snapshot.dirty || snapshot.readiness !== 'ready' || fenced.current ? { ...snapshot, dirty: true, readiness: 'uncertain' } : snapshot
      live.current = false
      off()
    }
  }, [editorSnapshot, mountedView, sessionApi])
  const flush = React.useCallback((json: string, beforeWrite?: () => Promise<void>, beforeApply?: () => void): Promise<void> => {
    const path = relPath
    const refused = (message: string, code: unknown = 'REVISION_CONFLICT'): Error => Object.assign(new Error(message), { code, outcome: 'not-applied', retryable: false, effectRefused: true })
    const write = async (): Promise<void> => {
      if (!live.current) throw refused(uiText('excalidraw.error.changed'))
      if (!json || json === lastScene.current) return
      if (uncertain.current) throw refused(uiText('excalidraw.error.save'), 'SAVE_UNCERTAIN')
      if (fenced.current) throw refused(uiText('excalidraw.error.changed'))
      await beforeWrite?.()
      const revision = editorSnapshot().revision
      saving.current = true
      notifyDrawing()
      let content: string
      let result: Awaited<ReturnType<typeof sessionApi.vault.writeFileGuarded>>
      let dispatched = false
      const expected = baseline.current
      // A generic save failure says nothing about whether bytes landed; an unchanged disk proves they did not.
      const untouched = async (): Promise<boolean> => {
        try {
          const now = (await sessionApi.vault.readFileBaseline(path))?.baseline ?? null
          return now === expected || !!now && !!expected && now.hash === expected.hash && now.size === expected.size && now.mtimeMs === expected.mtimeMs
        } catch { return false }
      }
      try {
        content = await writeScene(path, json, hostRef.current?.ownerDocument ?? document, sessionApi)
        await beforeWrite?.()
        beforeApply?.()
        if (!live.current || mountedView && editorSnapshot().revision !== revision) throw Object.assign(new Error(uiText('excalidraw.error.changed')), { outcome: 'not-applied' })
        dispatched = true
        result = mountedView ? await sessionApi.vault.editors.save(mountedView, content, baseline.current, revision) : await sessionApi.vault.writeFileGuarded(path, content, baseline.current)
        if (!live.current) throw Object.assign(new Error(uiText('excalidraw.error.changed')), { outcome: result.ok ? 'unknown' : 'not-applied', outcomeUnknown: result.ok, retryable: false })
      } catch (reason) {
        const failure = reason as { code?: unknown; outcome?: string; outcomeUnknown?: boolean }
        const unknownOutcome = failure?.outcome === 'unknown' || Boolean(failure?.outcomeUnknown)
        if (unknownOutcome) uncertain.current = true
        const message = uiText('excalidraw.error.save')
        errorRef.current = message; setError(message)
        saveDrawingDraft(path, draftOwner, { json: handleRef.current?.serialize() || json, baseline: baseline.current, error: message, uncertain: uncertain.current })
        notifyDrawing()
        saving.current = false
        notifyDrawing()
        if (!unknownOutcome && (!dispatched || failure?.outcome === 'not-applied' || await untouched())) throw refused(message, failure?.code ?? 'SAVE_REFUSED')
        throw new Error(message)
      }
      saving.current = false
      if (!result.ok) {
        const message = uiText(result.reason === 'conflict' ? 'excalidraw.error.conflict' : 'excalidraw.error.save')
        errorRef.current = message; setError(message)
        saveDrawingDraft(path, draftOwner, { json: handleRef.current?.serialize() || json, baseline: baseline.current, error: message, uncertain: uncertain.current })
        notifyDrawing()
        // A guarded conflict is decided before any write; the host's generic error can follow a dispatched write.
        if (result.reason === 'conflict') throw refused(message)
        if (await untouched()) throw refused(message, 'SAVE_REFUSED')
        throw new Error(message)
      }
      baseline.current = result.baseline
      lastContent.current = content
      lastScene.current = json
      // A commit's scene is not on the canvas yet while it saves; compare what the canvas will hold, not the old scene.
      const applied = pendingJson.current ?? handleRef.current?.serialize()
      dirty.current = !!applied && applied !== json
      saveDrawingDraft(path, draftOwner, dirty.current ? { json: applied!, baseline: result.baseline, error: '' } : null)
      errorRef.current = ''; setError('')
      notifyDrawing()
      window.clearTimeout(saveTimer.current)
      if (dirty.current) saveTimer.current = window.setTimeout(() => {
        const next = handleRef.current?.serialize()
        if (next) void flush(next).catch(() => {})
      }, AUTOSAVE_MS)
    }
    const pending = queue.current.then(write, write)
    queue.current = pending.catch(() => {})
    return pending
  }, [draftOwner, editorSnapshot, mountedView, relPath, sessionApi])

  const observe = React.useCallback(() => {
    if (!live.current) return
    const json = handleRef.current?.serialize()
    if (!json) return
    if (adopting.current) {
      adopting.current = false
      if (!dirty.current) lastScene.current = json
    }
    if (json === lastScene.current) {
      dirty.current = false
      saveDrawingDraft(relPath, draftOwner, null)
      notifyDrawing()
      return
    }
    dirty.current = true
    saveDrawingDraft(relPath, draftOwner, { json, baseline: baseline.current, error: errorRef.current, uncertain: uncertain.current })
    notifyDrawing()
    window.clearTimeout(saveTimer.current)
    if (!errorRef.current && !fenced.current) saveTimer.current = window.setTimeout(() => {
      const h = handleRef.current
      if (h) void flush(h.serialize()).catch(() => {})
    }, AUTOSAVE_MS)
  }, [draftOwner, relPath, flush])

  React.useEffect(() => api.runtime.onBeforeUnload(async () => {
    window.clearTimeout(saveTimer.current)
    await queue.current
    const retained = drawingDraft(relPath, draftOwner)
    if (retained?.error) throw new Error(retained.error)
    while (dirty.current) {
      const json = handleRef.current?.serialize()
      if (!json) throw new Error(uiText('excalidraw.error.loading'))
      await flush(json)
    }
  }), [draftOwner, relPath, flush])

  // Load + mount the canvas whenever the bound file changes.
  React.useEffect(() => {
    let disposed = false
    live.current = true
    const host = hostRef.current
    if (!host) return
    const releaseDraftOwner = claimDrawingDraftOwner(relPath, draftOwner)
    let offSession: (() => void) | undefined
    let initialRevision = fileRevisionRef.current
    const readLatest = async () => {
      while (!disposed) {
        const requested = fileRevisionRef.current
        try {
          const file = await api.vault.readFileBaseline(relPath)
          if (disposed) return null
          if (requested !== fileRevisionRef.current) continue
          initialRevision = requested
          return file
        } catch (reason) {
          if (requested !== fileRevisionRef.current) continue
          throw reason
        }
      }
      return null
    }
    void readLatest().then(async (file) => {
      if (disposed) return
      if (!file) throw new Error(uiText('excalidraw.error.missing'))
      const retained = adoptDrawingDraft(relPath, draftOwner)
      const scene = retained ? parseScene(retained.json) : await readScene(relPath, file.content, host.ownerDocument, sessionApi)
      if (disposed) return
      baseline.current = retained?.baseline ?? file.baseline
      lastContent.current = file.content
      lastScene.current = retained ? '' : JSON.stringify(scene)
      dirty.current = !!retained
      uncertain.current = retained?.uncertain ?? false
      errorRef.current = retained?.error ?? ''; setError(errorRef.current)
      const handle = await mountEditor(host, {
        initialData: scene,
        onChange: () => {
          if (disposed) return
          observe()
        },
        acceptsNativeRequest: acceptsNativeDrawingRequest,
        onNativeRequest: mountedView ? request => executeNativeDrawingRequest(sessionApi, mountedView, request) : undefined,
        onLinkOpen: (href, preventDefault, elementId) => { if (!mountedView) { openLink(href, preventDefault); return }; preventDefault(); void executeDrawingViewCallback(sessionApi, mountedView, /^[a-z][\w+.-]*:/i.test(href) ? 'element-link-external-open' : 'element-link-vault-open', { elementId, link: href }).catch(reason => { errorRef.current = String(reason); setError(errorRef.current) }) }
      })
      // The tab may have been torn down while the library lazy-loaded.
      if (disposed) {
        handle.unmount()
        return
      }
      handleRef.current = handle
      observe()
      if (!retained && initialRevision !== fileRevisionRef.current) await refreshExternalRef.current()
      if (disposed) return
      let viewSource = '', viewSequence = 0
      const active = (): void => { if (!live.current || disposed || fenced.current || sessionApi !== api) throw new Error(uiText('excalidraw.error.changed')) }
      const persistence = async () => {
        active()
        const file = await sessionApi.vault.readFileBaseline(relPath)
        active()
        if (!file?.baseline) throw new Error(uiText('excalidraw.error.missing'))
        return { diskRevision: JSON.stringify(file.baseline), draftRevision: editorSnapshot().revision, dirty: editorSnapshot().dirty, uncertain: uncertain.current, error: errorRef.current }
      }
      offSession = registerDrawingSession(relPath, {
        get: () => {
          active()
          const revision = handle.serialize(); if (!revision) throw new Error(uiText('excalidraw.error.loading'))
          const view = handle.getView(), source = JSON.stringify([revision, view, errorRef.current, uncertain.current])
          if (source !== viewSource) { viewSource = source; viewSequence++ }
          return { revision, scene: JSON.parse(revision) as RawScene, view, error: errorRef.current, sceneRevision: editorSnapshot().revision, viewRevision: `excalidraw-view:${mountedView?.mountId ?? relPath}:${mountedView?.generation ?? 0}:${viewSequence}`, ready: !saving.current && !uncertain.current, uncertain: uncertain.current, blocked: Boolean(fenced.current || controlling.current) }
        },
        restore: (view) => { if (!live.current || disposed || fenced.current) throw new Error(uiText('excalidraw.error.changed')); handle.restoreView(view) },
        controls: handle.controls ? () => { active(); return handle.controls!() } : undefined,
        action: handle.nativeAction ? async (name, value, beforePerform, beforeApply, beforeEffect) => {
          active()
          if (controlling.current) throw new Error('The drawing controls are busy.')
          window.clearTimeout(saveTimer.current)
          const inert = host.inert; host.inert = true
          try { await handle.nativeAction!(name, value, () => { beforePerform(); controlling.current = true }, beforeApply, beforeEffect); active(); await flush(handle.serialize()); notifyDrawing() }
          catch (reason) {
            const failure = reason as { outcomeUnknown?: boolean }
            if (failure.outcomeUnknown) { uncertain.current = true; errorRef.current = String(reason); setError(errorRef.current); saveDrawingDraft(relPath, draftOwner, { json: handle.serialize(), baseline: baseline.current, error: errorRef.current, uncertain: true }); window.clearTimeout(saveTimer.current) }
            throw reason
          } finally { controlling.current = false; host.inert = inert; notifyDrawing() }
        } : undefined,
        tool: handle.tool ? async (type, beforeEffect = async () => {}) => { active(); if (controlling.current) throw new Error('The drawing controls are busy.'); const inert = host.inert; host.inert = true; try { const before = handle.serialize(); await handle.tool!(type, async () => { await beforeEffect(); controlling.current = true }); active(); const after = handle.serialize(); if (after !== before) await flush(after) } finally { controlling.current = false; host.inert = inert; notifyDrawing() } } : undefined,
        pen: handle.pen ? enabled => { active(); handle.pen!(enabled) } : undefined,
        toolLock: handle.toolLock ? () => { active(); handle.toolLock!() } : undefined,
        library: handle.library ? () => { active(); return handle.library!() } : undefined,
        updateLibrary: handle.updateLibrary ? async (items, merge) => { active(); await handle.updateLibrary!(items, merge); active() } : undefined,
        sidebar: handle.sidebar ? open => { active(); handle.sidebar!(open) } : undefined,
        nativeControl: handle.nativeControl ? async (form, action, value, beforeEffect) => { active(); if (controlling.current) throw new Error('The drawing controls are busy.'); const inert = host.inert; host.inert = true; try { await handle.nativeControl!(form, action, value, async () => { await beforeEffect(); controlling.current = true }); active(); await flush(handle.serialize()); notifyDrawing() } finally { controlling.current = false; host.inert = inert; notifyDrawing() } } : undefined,
        nativeEdit: handle.nativeEdit ? async (action, value, beforeEffect) => { active(); if (controlling.current) throw new Error('The drawing controls are busy.'); window.clearTimeout(saveTimer.current); const inert = host.inert; host.inert = true; try { await handle.nativeEdit!(action, value, async () => { await beforeEffect(); controlling.current = true }); active(); await flush(handle.serialize()); notifyDrawing() } catch (reason) { const failure = reason as { outcomeUnknown?: boolean }; if (failure.outcomeUnknown) { uncertain.current = true; errorRef.current = String(reason); setError(errorRef.current); saveDrawingDraft(relPath, draftOwner, { json: handle.serialize(), baseline: baseline.current, error: errorRef.current, uncertain: true }); window.clearTimeout(saveTimer.current) } throw reason } finally { controlling.current = false; host.inert = inert; notifyDrawing() } } : undefined,
        persistence,
        lifecycle: async (action, diskRevision, draftRevision, beforeEffect, beforeApply) => {
          active()
          const assertPersistence = async () => { const current = await persistence(); if (current.diskRevision !== diskRevision || current.draftRevision !== draftRevision) throw new Error(uiText('excalidraw.error.changed')) }
          window.clearTimeout(saveTimer.current)
          await queue.current
          await assertPersistence(); await beforeEffect(); await assertPersistence()
          if (action === 'retry-save') { if (uncertain.current) throw new Error(uiText('excalidraw.error.save')); await flush(handle.serialize(), beforeEffect, beforeApply); return }
          const file = await sessionApi.vault.readFileBaseline(relPath)
          if (!file?.baseline) throw new Error(uiText('excalidraw.error.missing'))
          const scene = await readScene(relPath, file.content, host.ownerDocument, sessionApi)
          await assertPersistence(); await beforeEffect(); await assertPersistence(); beforeApply(); active()
          baseline.current = file.baseline; lastContent.current = file.content; dirty.current = false
          lastScene.current = JSON.stringify(scene); adopting.current = true; uncertain.current = false
          saveDrawingDraft(relPath, draftOwner, null); handle.updateScene(scene); observe()
          errorRef.current = ''; setError(''); notifyDrawing()
        },
        commit: async (scene, revision, beforeWrite, beforeApply) => {
          if (!live.current || disposed || fenced.current) throw new Error(uiText('excalidraw.error.changed'))
          if (handle.getView().readOnly) throw new Error(uiText('excalidraw.error.readOnly'))
          if (handle.serialize() !== revision) throw new Error(uiText('excalidraw.error.changed'))
          window.clearTimeout(saveTimer.current)
          const inert = host.inert, wasDirty = dirty.current
          if (beforeWrite) host.inert = true; else handle.restoreView({ readOnly: true })
          try {
            const previous = JSON.parse(revision) as RawScene
            const next = { ...previous, ...scene, appState: { ...previous.appState, ...scene.appState } }
            const json = JSON.stringify(next)
            pendingJson.current = json
            dirty.current = true
            try { await flush(json, beforeWrite, beforeApply) } catch (reason) { if (lastScene.current !== json) dirty.current = wasDirty; throw reason }
            if (!live.current || disposed) throw new Error(uiText('excalidraw.error.changed'))
            // Adopt Excalidraw's own normalization of the saved scene as clean, as load and refresh do, so a commit
            // never chains a second unaddressed save (or an autosave) behind the one its caller authorized.
            window.clearTimeout(saveTimer.current)
            pendingJson.current = null
            dirty.current = false
            adopting.current = true
            handle.updateScene(next, true)
            observe()
            notifyDrawing()
          } finally { pendingJson.current = null; if (beforeWrite) host.inert = inert; else handle.restoreView({ readOnly: false }); notifyDrawing() }
        }
      }, mountedView, sessionApi)
      const pending = pendingDrawingView(relPath)
      if (pending) handle.restoreView(pending)
    }).catch((reason) => { if (!disposed) { errorRef.current = String(reason); setError(String(reason)) } })
    return () => {
      disposed = true
      if (live.current) {
        const snapshot = editorSnapshot()
        terminalSnapshot.current = snapshot.dirty || snapshot.readiness !== 'ready' || fenced.current ? { ...snapshot, dirty: true, readiness: 'uncertain' } : snapshot
        live.current = false
      }
      window.clearTimeout(saveTimer.current)
      const h = handleRef.current
      if (h && dirty.current) saveDrawingDraft(relPath, draftOwner, { json: pendingJson.current ?? h.serialize(), baseline: baseline.current, error: errorRef.current, uncertain: uncertain.current })
      releaseDraftOwner()
      offSession?.()
      h?.unmount()
      handleRef.current = null
    }
  }, [draftOwner, relPath, flush, observe, sessionApi, editorSnapshot])

  // Reload after an external edit — never while we hold unsaved changes.
  React.useEffect(() => {
    let disposed = false
    let pending = false
    let running: Promise<void> = Promise.resolve()
    const refresh = async (): Promise<void> => {
      pending = true
      try {
        while (!disposed && !dirty.current && !fenced.current && !controlling.current && handleRef.current) {
          const requested = fileRevisionRef.current
          const written = lastContent.current
          try {
            const file = await api.vault.readFileBaseline(relPath)
            if (disposed || dirty.current || fenced.current || controlling.current) return
            if (requested !== fileRevisionRef.current) continue
            if (written !== lastContent.current) return
            if (!file) throw new Error(uiText('excalidraw.error.missing'))
            if (file.content !== lastContent.current) {
              const scene = await readScene(relPath, file.content, hostRef.current?.ownerDocument ?? document, sessionApi)
              if (disposed || dirty.current || fenced.current || controlling.current) return
              if (requested !== fileRevisionRef.current) continue
              if (written !== lastContent.current) return
              baseline.current = file.baseline
              lastContent.current = file.content
              lastScene.current = JSON.stringify(scene)
              adopting.current = true
              handleRef.current?.updateScene(scene)
              observe()
              notifyDrawing()
            }
          } catch (reason) {
            if (disposed || dirty.current) return
            if (requested !== fileRevisionRef.current) continue
            if (written !== lastContent.current) return
            errorRef.current = String(reason); setError(String(reason))
          }
          if (requested === fileRevisionRef.current) return
        }
      } finally { pending = false }
    }
    const requestRefresh = (): Promise<void> => {
      if (!disposed && !dirty.current && !controlling.current && handleRef.current && !pending) running = refresh()
      return running
    }
    refreshExternalRef.current = requestRefresh
    const off = api.vault.onChanged((info) => {
      if (!info.full && !info.changes.some((change) => change.relPath === relPath || relPath.startsWith(`${change.relPath}/`))) return
      fileRevisionRef.current++
      void requestRefresh()
    })
    return () => {
      disposed = true
      if (refreshExternalRef.current === requestRefresh) refreshExternalRef.current = () => Promise.resolve()
      off()
    }
  }, [relPath, observe, sessionApi])


  const reloadDisk = async (): Promise<void> => {
    if (!live.current || fenced.current) throw new Error(uiText('excalidraw.error.changed'))
    const choice = await api.ui.confirm({ title: uiText('excalidraw.action.reload'), message: uiText('excalidraw.error.discard'), actions: [{ label: uiText('excalidraw.action.cancel'), value: 'cancel', variant: 'ghost' }, { label: uiText('excalidraw.action.reload'), value: 'reload', variant: 'danger' }] })
    if (choice !== 'reload') return
    if (mountedView) { await executeDrawingViewCallback(sessionApi, mountedView, 'reload-disk'); return }
    try {
      window.clearTimeout(saveTimer.current)
      await queue.current
      const file = await api.vault.readFileBaseline(relPath)
      if (!file) throw new Error(uiText('excalidraw.error.missing'))
      const scene = await readScene(relPath, file.content, hostRef.current?.ownerDocument ?? document, sessionApi)
      if (!live.current || fenced.current) throw new Error(uiText('excalidraw.error.changed'))
      baseline.current = file.baseline; lastContent.current = file.content; dirty.current = false
      lastScene.current = JSON.stringify(scene); adopting.current = true; uncertain.current = false
      saveDrawingDraft(relPath, draftOwner, null); handleRef.current?.updateScene(scene)
      observe()
      errorRef.current = ''; setError(''); notifyDrawing()
    } catch (reason) { errorRef.current = String(reason); setError(String(reason)) }
  }

  return <><div ref={hostRef} className="excalidraw-editor" data-native-history />{error && <div className="excalidraw-save-error" role="alert">{error}<button onClick={() => { if (mountedView) void executeDrawingViewCallback(sessionApi, mountedView, 'retry-save').catch(() => {}); else { const json = handleRef.current?.serialize(); if (json) void flush(json).catch(() => {}) } }}>{uiText('excalidraw.action.retry')}</button><button onClick={() => void reloadDisk()}>{uiText('excalidraw.action.reload')}</button></div>}</>
}

const ExcalidrawEditor: FC<{ relPath: string; mountedView?: MountedPluginView }> = ({ relPath, mountedView }) => <DrawingEditor key={relPath} relPath={relPath} mountedView={mountedView} />

export default ExcalidrawEditor
