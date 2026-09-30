/**
 * ```excalidraw``` code block — embed a drawing inside a note.
 *
 *   ```excalidraw
 *   file: [[My Sketch]]     → the drawing to show (wikilink or vault path)
 *   height: 400             → optional embed height (px)
 *   ```
 *
 * Reading views render a static, read-only SVG of the scene (cheap — no editor);
 * clicking it opens the live `.excalidraw` editor. Mounts lazily when scrolled in.
 */
import codeBlockExamples from './codeBlockExamples.json'
import { React, api } from './runtime'
import type { FC } from 'react'
import type { ValleyPluginApi } from '@valley/plugin-sdk'
import { parseFenceParams, fenceValue, fenceInt } from '@valley/plugin-sdk/fenceParams'
import { renderPreviewSvg } from './island'
import { createDrawingPreviews, type DrawingPreviews } from './previews'
import { uiText } from './localization'
import { isDrawingPath } from './formats'

/** Resolve the `file:` ref (wikilink or path) to a vault-relative `.excalidraw` path. */
function resolveTarget(ref: string, sessionApi: ValleyPluginApi): string | null {
  const bare = ref.replace(/^\[\[/, '').replace(/\]\]$/, '').trim()
  if (!bare) return null
  const path = sessionApi.workspace.resolveWikilink(bare) ?? bare
  return isDrawingPath(path) ? path : null
}

const ExcalidrawFence: FC<{ code: string; previews: DrawingPreviews; sessionApi: ValleyPluginApi }> = ({ code, previews, sessionApi }) => {
  const hostRef = React.useRef<HTMLDivElement>(null)
  const previewRef = React.useRef<HTMLDivElement>(null)
  const [visible, setVisible] = React.useState(false)
  const [darkMode, setDarkMode] = React.useState(false)
  const [state, setState] = React.useState<'loading' | 'ready' | 'empty' | 'missing' | 'error'>('loading')
  const [revision, invalidate] = React.useReducer((value: number) => value + 1, 0)

  const params = parseFenceParams(code)
  const ref = fenceValue(params, 'file', 'of', 'drawing') ?? ''
  const target = resolveTarget(ref, sessionApi)

  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const io = new IntersectionObserver(
      (records) => {
        if (records.some((r) => r.isIntersecting)) {
          setVisible(true)
          io.disconnect()
        }
      },
      { rootMargin: '120px' }
    )
    io.observe(host)
    return () => io.disconnect()
  }, [])

  React.useEffect(() => {
    const owner = hostRef.current?.ownerDocument
    const view = owner?.defaultView
    if (!owner || !view) return
    const update = () => setDarkMode(view.getComputedStyle(owner.documentElement).colorScheme === 'dark')
    update()
    const observer = new view.MutationObserver(update)
    observer.observe(owner.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] })
    return () => observer.disconnect()
  }, [])

  // Render the scene to a static SVG once visible.
  React.useEffect(() => {
    if (!visible) return
    let cancelled = false
    const preview = previewRef.current
    if (!preview) return
    preview.replaceChildren()
    setState('loading')
    if (!target) {
      setState('missing')
      return
    }
    const request = previews.acquire(target, darkMode, preview.ownerDocument, invalidate)
    void request.load().then((svg) => {
      if (cancelled) return
      if (svg) {
        svg.style.maxWidth = '100%'
        svg.style.height = '100%'
        preview.appendChild(svg)
        setState('ready')
      } else {
        setState('empty')
      }
    }).catch(() => { if (!cancelled) setState('error') })
    return () => {
      cancelled = true
      request.release()
      preview.replaceChildren()
    }
  }, [visible, target, darkMode, revision, previews])

  const onOpen = React.useCallback(() => {
    if (target) sessionApi.workspace.openFile(target)
  }, [target, sessionApi])

  const hint =
    state === 'missing'
      ? uiText('auto.ec4a540b3f68', { p0: ref || uiText('auto.3c6b183d348f') })
      : state === 'error'
        ? uiText('excalidraw.error.preview')
        : state === 'empty'
          ? uiText('auto.28ada8fd4202')
          : state === 'loading'
            ? uiText('auto.329e1c1fb40a')
            : ''

  return (
    <div
      ref={hostRef}
      className="excalidraw-fence-inner"
      role="button"
      tabIndex={0}
      title={target ? uiText('auto.19295522fe5c', { p0: target }) : undefined}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onOpen()
      }}
    >
      <div ref={previewRef} className="excalidraw-fence-preview" hidden={state !== 'ready'} />
      {state !== 'ready' ? <div className="excalidraw-fence-hint">{hint}</div> : null}
    </div>
  )
}

/** Register the ```excalidraw``` fence; returns the unregister fn. */
export function registerExcalidrawFence(): () => void {
  const sessionApi = api
  const previews = createDrawingPreviews(sessionApi, (scene, dark, owner, active) => renderPreviewSvg(scene, dark, owner, active, sessionApi))
  const unregister = sessionApi.markdown.registerCodeBlockRenderer('excalidraw', (code, el, ctx) => {
    void ctx
    el.classList.add('excalidraw-fence')
    const params = parseFenceParams(code)
    const height = fenceInt(params, 'height', 2000) ?? 360
    el.style.height = `${height}px`
    return sessionApi.ui.renderReact(el, <ExcalidrawFence code={code} previews={previews} sessionApi={sessionApi} />)
  }, { examples: codeBlockExamples.excalidraw })
  return () => { unregister(); previews.dispose() }
}
