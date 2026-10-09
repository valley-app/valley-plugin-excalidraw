import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { patchNativeActions, patchNativeEffects } from './nativeActions.mjs'
const require = createRequire(import.meta.url)
export default async function ({ root, outDir }) {
  const library = path.dirname(require.resolve('@excalidraw/excalidraw'))
  const fonts = path.join(library, 'fonts')
  const packageVersion = JSON.parse(await fs.readFile(path.join(library, '../../package.json'), 'utf8')).version
  await fs.mkdir(path.join(outDir, 'assets'), { recursive: true })
  await fs.cp(fonts, path.join(outDir, 'assets/fonts'), { recursive: true })
  let fontExportPatches = 0
  const plugins = [{ name: 'plugin-owned-fonts', setup(builder) {
      builder.onLoad({ filter: /[\\/]browser-fs-access[\\/]dist[\\/]file-save-[^\\/]+\.js$/ }, async ({ path: file }) => ({ contents: patchNativeEffects(await fs.readFile(file, 'utf8'), path.basename(file), JSON.parse(await fs.readFile(path.join(path.dirname(file), '../package.json'), 'utf8')).version), loader: 'js', resolveDir: path.dirname(file) }))
      builder.onLoad({ filter: /[\\/]@excalidraw[\\/]excalidraw[\\/]dist[\\/].*\.js$/ }, async ({ path: file }) => {
        const source = await fs.readFile(file, 'utf8')
        for (const [, , font] of source.matchAll(/(["'])\.\/fonts\/([^"']+\.woff2)\1/g)) {
          const data = await fs.readFile(path.join(fonts, font))
          await fs.writeFile(path.join(outDir, 'assets/fonts', `${font}.js`), `export default ${JSON.stringify(`data:font/woff2;base64,${data.toString('base64')}`)};\n`)
        }
        let contents = path.basename(file) === 'index.js' && path.dirname(file).endsWith(`${path.sep}prod`) ? patchNativeActions(source, packageVersion, path.join(root, 'src/nativeBridge.ts')) : path.basename(file) === 'chunk-K2UTITRG.js' ? patchNativeEffects(source, path.basename(file), packageVersion) : source
        contents = contents.replace(/(["'])\.\/fonts\/([^"']+\.woff2)\1/g, (_match, _quote, font) => JSON.stringify(`fonts/${font}`))
        if (/async getContent\([$\w]+\)\s*\{/.test(contents)) {
          fontExportPatches++
          if ((contents.match(/[$\w]+\.ASSETS_FALLBACK_URL/g) ?? []).length !== 1) throw new Error('The pinned Excalidraw font fallback adapter no longer matches')
          contents = contents.replace(/[$\w]+\.ASSETS_FALLBACK_URL/g, 'window.EXCALIDRAW_ASSET_PATH')
          contents = `import { ownedFontContent as __valleyExcalidrawFontContent } from ${JSON.stringify(path.join(root, 'src/fontAssets.ts'))};\n` + contents.replace(/async getContent\([$\w]+\)\s*\{/, (match) => `${match}return __valleyExcalidrawFontContent(this.urls);`)
        }
        return { contents, loader: 'js', resolveDir: path.dirname(file) }
      })
    }}]
  await build({ absWorkingDir: root, entryPoints: [path.join(root, 'src/islandRuntime.ts')], outfile: path.join(outDir, 'assets/island.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', conditions: ['production'], jsx: 'automatic', loader: { '.css': 'text' }, plugins, minify: true, logLevel: 'silent' })
  if (fontExportPatches !== 1) throw new Error('The pinned Excalidraw font export adapter no longer matches')
  return { plugins }
}
