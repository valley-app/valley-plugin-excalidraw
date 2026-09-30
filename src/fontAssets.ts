let assetBase = ''
const pending = new Map<string, Promise<string>>()

export function configureFontAssets(base: string): void {
  assetBase = base
}

export function ownedFontContent(urls: readonly (URL | string)[]): Promise<string> {
  const url = urls.map(String).find((value) => value.startsWith(`${assetBase}fonts/`) && value.endsWith('.woff2'))
  if (!assetBase || !url) return Promise.reject(new Error('Drawing font is not a package asset'))
  let loading = pending.get(url)
  if (!loading) {
    loading = import(`${url}.js`).then((module: { default: string }) => {
      if (!module.default.startsWith('data:font/woff2;base64,')) throw new Error('Invalid drawing font asset')
      return module.default
    }).catch((error) => { pending.delete(url); throw error })
    pending.set(url, loading)
  }
  return loading
}
