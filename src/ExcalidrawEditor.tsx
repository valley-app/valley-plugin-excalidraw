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
import { uiText } from './localization'
import { drawingDraft, saveDrawingDraft, registerDrawingSession, pendingDrawingView, notifyDrawing } from './session'

const AUTOSAVE_MS = 600

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

const DrawingEditor: FC<{ relPath: string }> = ({ relPath }) => {
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
  const [error, setError] = React.useState('')
  const errorRef = React.useRef('')
  const flush = React.useCallback((json: string): Promise<void> => {
    const path = relPath
    const write = async (): Promise<void> => {
      if (!json || json === lastScene.current) return
      let content: string
      let result: Awaited<ReturnType<typeof sessionApi.vault.writeFileGuarded>>
      try {
        content = await writeScene(path, json, hostRef.current?.ownerDocument ?? document, sessionApi)
        result = await sessionApi.vault.writeFileGuarded(path, content, baseline.current)
      } catch {
        const message = uiText('excalidraw.error.save')
        errorRef.current = message; setError(message)
        saveDrawingDraft(path, { json: handleRef.current?.serialize() || json, baseline: baseline.current, error: message })
        throw new Error(message)
      }
      if (!result.ok) {
        const message = uiText(result.reason === 'conflict' ? 'excalidraw.error.conflict' : 'excalidraw.error.save')
        errorRef.current = message; setError(message)
        saveDrawingDraft(path, { json: handleRef.current?.serialize() || json, baseline: baseline.current, error: message })
        throw new Error(message)
      }
      baseline.current = result.baseline
      lastContent.current = content
      lastScene.current = json
      dirty.current = !!handleRef.current && handleRef.current.serialize() !== json
      saveDrawingDraft(path, dirty.current ? { json: handleRef.current!.serialize(), baseline: result.baseline, error: '' } : null)
      errorRef.current = ''; setError('')
      window.clearTimeout(saveTimer.current)
      if (dirty.current) saveTimer.current = window.setTimeout(() => {
        const next = handleRef.current?.serialize()
        if (next) void flush(next).catch(() => {})
      }, AUTOSAVE_MS)
    }
    const pending = queue.current.then(write, write)
    queue.current = pending.catch(() => {})
    return pending
  }, [relPath, sessionApi])

  const observe = React.useCallback(() => {
    const json = handleRef.current?.serialize()
    if (!json) return
    if (adopting.current) {
      adopting.current = false
      if (!dirty.current) lastScene.current = json
    }
    notifyDrawing()
    if (json === lastScene.current) {
      dirty.current = false
      saveDrawingDraft(relPath, null)
      return
    }
    dirty.current = true
    saveDrawingDraft(relPath, { json, baseline: baseline.current, error: errorRef.current })
    window.clearTimeout(saveTimer.current)
    if (!errorRef.current) saveTimer.current = window.setTimeout(() => {
      const h = handleRef.current
      if (h) void flush(h.serialize()).catch(() => {})
    }, AUTOSAVE_MS)
  }, [relPath, flush])

  React.useEffect(() => api.runtime.onBeforeUnload(async () => {
    window.clearTimeout(saveTimer.current)
    await queue.current
    const retained = drawingDraft(relPath)
    if (retained?.error) throw new Error(retained.error)
    while (dirty.current) {
      const json = handleRef.current?.serialize()
      if (!json) throw new Error(uiText('excalidraw.error.loading'))
      await flush(json)
    }
  }), [relPath, flush])

  // Load + mount the canvas whenever the bound file changes.
  React.useEffect(() => {
    let disposed = false
    const host = hostRef.current
    if (!host) return
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
      const retained = drawingDraft(relPath)
      const scene = retained ? parseScene(retained.json) : await readScene(relPath, file.content, host.ownerDocument, sessionApi)
      if (disposed) return
      baseline.current = retained?.baseline ?? file.baseline
      lastContent.current = file.content
      lastScene.current = retained ? '' : JSON.stringify(scene)
      dirty.current = !!retained
      errorRef.current = retained?.error ?? ''; setError(errorRef.current)
      const handle = await mountEditor(host, {
        initialData: scene,
        onChange: () => {
          if (disposed) return
          observe()
        },
        onLinkOpen: openLink
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
      offSession = registerDrawingSession(relPath, {
        get: () => { const revision = handle.serialize(); if (!revision) throw new Error(uiText('excalidraw.error.loading')); return { revision, scene: JSON.parse(revision) as RawScene, view: handle.getView(), error: errorRef.current } },
        restore: (view) => handle.restoreView(view),
        commit: async (scene, revision) => {
          if (handle.getView().readOnly) throw new Error(uiText('excalidraw.error.readOnly'))
          if (handle.serialize() !== revision) throw new Error(uiText('excalidraw.error.changed'))
          window.clearTimeout(saveTimer.current)
          handle.restoreView({ readOnly: true })
          try {
            const previous = JSON.parse(revision) as RawScene
            const next = { ...previous, ...scene, appState: { ...previous.appState, ...scene.appState } }
            const json = JSON.stringify(next)
            dirty.current = true
            await flush(json)
            handle.updateScene(next, true)
            await Promise.resolve()
            dirty.current = handle.serialize() !== lastScene.current
            if (dirty.current) await flush(handle.serialize())
            notifyDrawing()
          } finally { handle.restoreView({ readOnly: false }) }
        }
      })
      const pending = pendingDrawingView(relPath)
      if (pending) handle.restoreView(pending)
    }).catch((reason) => { if (!disposed) { errorRef.current = String(reason); setError(String(reason)) } })
    return () => {
      disposed = true
      window.clearTimeout(saveTimer.current)
      const h = handleRef.current
      if (h && dirty.current) void flush(h.serialize()).catch(() => {}) // flush pending edits before unmount
      offSession?.()
      h?.unmount()
      handleRef.current = null
    }
  }, [relPath, flush, observe, sessionApi])

  // Reload after an external edit — never while we hold unsaved changes.
  React.useEffect(() => {
    let disposed = false
    let pending = false
    let running: Promise<void> = Promise.resolve()
    const refresh = async (): Promise<void> => {
      pending = true
      try {
        while (!disposed && !dirty.current && handleRef.current) {
          const requested = fileRevisionRef.current
          const written = lastContent.current
          try {
            const file = await api.vault.readFileBaseline(relPath)
            if (disposed || dirty.current) return
            if (requested !== fileRevisionRef.current) continue
            if (written !== lastContent.current) return
            if (!file) throw new Error(uiText('excalidraw.error.missing'))
            if (file.content !== lastContent.current) {
              const scene = await readScene(relPath, file.content, hostRef.current?.ownerDocument ?? document, sessionApi)
              if (disposed || dirty.current) return
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
      if (!disposed && !dirty.current && handleRef.current && !pending) running = refresh()
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
    const choice = await api.ui.confirm({ title: uiText('excalidraw.action.reload'), message: uiText('excalidraw.error.discard'), actions: [{ label: uiText('excalidraw.action.cancel'), value: 'cancel', variant: 'ghost' }, { label: uiText('excalidraw.action.reload'), value: 'reload', variant: 'danger' }] })
    if (choice !== 'reload') return
    try {
      window.clearTimeout(saveTimer.current)
      await queue.current
      const file = await api.vault.readFileBaseline(relPath)
      if (!file) throw new Error(uiText('excalidraw.error.missing'))
      const scene = await readScene(relPath, file.content, hostRef.current?.ownerDocument ?? document, sessionApi)
      baseline.current = file.baseline; lastContent.current = file.content; dirty.current = false
      lastScene.current = JSON.stringify(scene); adopting.current = true
      saveDrawingDraft(relPath, null); handleRef.current?.updateScene(scene)
      observe()
      errorRef.current = ''; setError(''); notifyDrawing()
    } catch (reason) { errorRef.current = String(reason); setError(String(reason)) }
  }

  return <><div ref={hostRef} className="excalidraw-editor" data-native-history />{error && <div className="excalidraw-save-error" role="alert">{error}<button onClick={() => { const json = handleRef.current?.serialize(); if (json) void flush(json).catch(() => {}) }}>{uiText('excalidraw.action.retry')}</button><button onClick={() => void reloadDisk()}>{uiText('excalidraw.action.reload')}</button></div>}</>
}

const ExcalidrawEditor: FC<{ relPath: string }> = ({ relPath }) => <DrawingEditor key={relPath} relPath={relPath} />

export default ExcalidrawEditor
