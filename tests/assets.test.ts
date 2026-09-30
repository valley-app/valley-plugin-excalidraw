import { readFileSync, readdirSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { disposeExcalidrawStyles, ensureExcalidrawStyles, renderPreviewSvg } from '../src/island'
import { initRuntime } from '../src/runtime'

vi.mock('@excalidraw/excalidraw/index.css', async () => {
  const { readFileSync } = await import('node:fs')
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  return { default: readFileSync(require.resolve('@excalidraw/excalidraw/index.css'), 'utf8') }
})

afterEach(disposeExcalidrawStyles)

describe('owned Excalidraw stylesheet assets', () => {
  it('packages lazy SVG font modules with the original font bytes', () => {
    const root = `${process.cwd()}/runtime/assets/fonts`
    const modules = readdirSync(root, { recursive: true }).filter((file) => String(file).endsWith('.woff2.js'))
    expect(modules.length).toBeGreaterThan(0)
    for (const file of modules) {
      const source = readFileSync(`${root}/${file}`, 'utf8')
      const data = JSON.parse(source.slice('export default '.length).trim().replace(/;$/, ''))
      expect(data).toBe(`data:font/woff2;base64,${readFileSync(`${root}/${String(file).slice(0, -3)}`).toString('base64')}`)
    }
  })

  it('captures the originating asset session and skips retired exports after the lazy island loads', async () => {
    const first = createMockValleyApi({ manifest: { id: 'excalidraw' } })
    const second = createMockValleyApi({ manifest: { id: 'excalidraw' } })
    vi.spyOn(first.api.assets, 'url').mockImplementation((path) => `https://session-one.invalid/${path}`)
    vi.spyOn(second.api.assets, 'url').mockImplementation((path) => `https://session-two.invalid/${path}`)
    const frame = document.createElement('iframe')
    document.body.append(frame)
    const owner = frame.contentDocument!
    const island = { configureAssets: vi.fn(), renderPreviewSvg: vi.fn(async () => null) }
    Object.assign(owner.defaultView!, { valleyExcalidrawIsland: island })
    let active = true
    const pending = renderPreviewSvg({ elements: [] }, false, owner, () => active, first.api)
      .catch((error: Error) => error.message)
    const script = owner.querySelector('script')!
    expect(script.src).toBe('https://session-one.invalid/island.js')
    initRuntime(second.api)
    active = false
    script.dispatchEvent(new Event('load'))
    expect(await pending).toContain('no longer active')
    expect(island.configureAssets).toHaveBeenCalledWith('https://session-one.invalid/')
    expect(island.renderPreviewSvg).not.toHaveBeenCalled()
    expect(owner.querySelector('script')).toBeNull()
    const current = renderPreviewSvg({ elements: [] }, false, owner, () => true, second.api)
    const next = owner.querySelector('script')!
    expect(next.src).toBe('https://session-two.invalid/island.js')
    next.dispatchEvent(new Event('load'))
    await current
    expect(island.configureAssets).toHaveBeenLastCalledWith('https://session-two.invalid/')
    expect(island.renderPreviewSvg).toHaveBeenCalledTimes(1)
    expect(owner.querySelector('script')).toBeNull()
    frame.remove()
  })

  it('resolves its drawing island through the injected asset session', () => {
    const island = readFileSync(`${process.cwd()}/src/island.ts`, 'utf8')
    expect(island).toContain("sessionApi.assets.url('')")
    expect(island).not.toMatch(/TODO|system-ui/)
  })

  it('loads every UI font through the active plugin asset session', () => {
    const mock = createMockValleyApi({ manifest: { id: 'excalidraw' } })
    const assetUrl = vi.spyOn(mock.api.assets, 'url').mockImplementation((relativePath) => `valley-asset://plugin/session-one/7/${relativePath}`)
    initRuntime(mock.api)
    ensureExcalidrawStyles()
    const css = document.getElementById('excalidraw-lib-styles')?.textContent ?? ''
    for (const weight of ['Regular', 'Medium', 'SemiBold', 'Bold']) {
      const font = `fonts/Assistant/Assistant-${weight}.woff2`
      expect(assetUrl).toHaveBeenCalledWith(font)
      expect(css).toContain(`url("valley-asset://plugin/session-one/7/${font}")`)
    }
    expect(css).not.toMatch(/url\(["']?\.\/fonts\//)
    ensureExcalidrawStyles()
    expect(document.querySelectorAll('#excalidraw-lib-styles')).toHaveLength(1)

    disposeExcalidrawStyles()
    assetUrl.mockImplementation((relativePath) => `valley-asset://plugin/session-two/8/${relativePath}`)
    ensureExcalidrawStyles()
    const refreshed = document.getElementById('excalidraw-lib-styles')?.textContent ?? ''
    expect(refreshed).toContain('valley-asset://plugin/session-two/8/fonts/Assistant/Assistant-Regular.woff2')
    expect(refreshed).not.toContain('session-one')
  })
})
