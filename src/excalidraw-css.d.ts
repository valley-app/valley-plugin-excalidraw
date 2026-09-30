// esbuild loads `.css` as text (loader configured in tooling/build/build-plugins.mjs),
// so this import resolves to the stylesheet's source string. Declared narrowly for
// the exact specifier to avoid clashing with Vite's generic `*.css` typing.
declare module '@excalidraw/excalidraw/index.css' {
  const css: string
  export default css
}
