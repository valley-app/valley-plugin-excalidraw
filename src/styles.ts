/**
 * The plugin's own chrome — the editor fill box and the ```excalidraw``` embed
 * frame. The heavy Excalidraw library stylesheet is injected separately, only when
 * an editor first mounts (see `ensureExcalidrawStyles` in island.ts), so note
 * embeds (static SVG) never pay for it. Colours use the app's real design tokens.
 */
const CSS = `
.excalidraw-editor { position: absolute; inset: 0; overflow: hidden; }
.excalidraw-editor .excalidraw { height: 100%; width: 100%; }
.excalidraw-editor .excalidraw .main-menu-trigger { display: none; }
.excalidraw-editor .excalidraw { anchor-scope: --drawing-tools; }
.excalidraw-editor .excalidraw .FixedSideContainer_side_top { right: 10px; }
.excalidraw-editor .excalidraw .mobile-misc-tools-container {
  right: 0;
  border-right: 1px solid var(--sidebar-border-color);
  border-radius: var(--border-radius-lg);
  anchor-name: --drawing-tools;
  overflow: visible;
}
.excalidraw-editor .excalidraw:not(.excalidraw--mobile) .default-sidebar-trigger { anchor-name: --drawing-tools; }
.excalidraw-editor .excalidraw :is(.ToolIcon, .ToolIcon__icon, .default-sidebar-trigger) { border-radius: 2px !important; }
.excalidraw-editor .excalidraw .mobile-misc-tools-container :is(.ToolIcon, .default-sidebar-trigger) {
  width: 36px;
  height: 36px;
  box-sizing: border-box;
}
.excalidraw-editor .excalidraw .mobile-misc-tools-container .ToolIcon__icon { width: 100%; height: 100%; }
.excalidraw-editor .excalidraw .undo-redo-buttons,
.excalidraw-editor .excalidraw .App-toolbar-content > div:has(> [data-testid="button-undo"]) {
  position: fixed;
  position-anchor: --drawing-tools;
  top: calc(anchor(bottom) + 8px);
  right: anchor(right);
  bottom: auto;
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  background: var(--island-bg-color);
  border: 1px solid var(--sidebar-border-color);
  border-radius: var(--border-radius-lg);
  pointer-events: auto;
}
.excalidraw-editor .excalidraw .App-toolbar-content > div:has(> [data-testid="button-undo"]) {
  width: anchor-size(width);
  box-sizing: border-box;
  align-items: stretch;
}
.excalidraw-editor .excalidraw .App-bottom-bar > .Island:not(:has(.App-mobile-menu, .App-toolbar-content > .ToolIcon_type_button--show, .scroll-back-to-content)) {
  background: transparent;
  box-shadow: none;
}
.excalidraw-editor .excalidraw [data-testid="button-undo"],
.excalidraw-editor .excalidraw [data-testid="button-redo"] {
  width: 2rem;
  height: 2rem;
  border-radius: 2px !important;
}
.excalidraw-editor .excalidraw .undo-redo-buttons .ToolIcon__icon { width: 2rem; height: 2rem; }
.excalidraw-editor .excalidraw .App-toolbar-content [data-testid="button-undo"],
.excalidraw-editor .excalidraw .App-toolbar-content [data-testid="button-redo"],
.excalidraw-editor .excalidraw .App-toolbar-content [data-testid^="button-"] .ToolIcon__icon { width: 100%; }
.excalidraw-editor .excalidraw .App-toolbar-content :is([data-testid="button-undo"], [data-testid="button-redo"]) { height: 36px; }

.excalidraw-editor .excalidraw :is(.mobile-misc-tools-container, .undo-redo-buttons, .App-toolbar-content > div:has(> [data-testid="button-undo"])) :is(.ToolIcon, .default-sidebar-trigger) {
  position: relative;
  background: transparent !important;
  box-shadow: none;
}
.excalidraw-editor .excalidraw :is(.mobile-misc-tools-container, .undo-redo-buttons, .App-toolbar-content > div:has(> [data-testid="button-undo"])) :is(.ToolIcon, .default-sidebar-trigger)::before {
  content: '';
  position: absolute;
  inset: 3px;
  border-radius: 2px;
  background: transparent;
  opacity: 0;
  transform: scale(.88);
  transition: background-color 160ms ease, opacity 160ms ease, transform 180ms cubic-bezier(.2,.8,.2,1);
  pointer-events: none;
}
.excalidraw-editor .excalidraw :is(.mobile-misc-tools-container, .undo-redo-buttons, .App-toolbar-content > div:has(> [data-testid="button-undo"])) :is(.ToolIcon, .default-sidebar-trigger):is(:hover, :focus-visible, :has(:focus-visible)):not(:disabled):not(:has(input:disabled))::before {
  background: var(--button-hover-bg);
  opacity: 1;
  transform: scale(1);
}
.excalidraw-editor .excalidraw :is(.mobile-misc-tools-container, .undo-redo-buttons, .App-toolbar-content > div:has(> [data-testid="button-undo"])) :is(.ToolIcon:has(input:checked), .default-sidebar-trigger.active, .sidebar-trigger__label-element:has(input:checked) .default-sidebar-trigger)::before {
  background: var(--color-surface-primary-container);
  opacity: 1;
  transform: scale(1);
}
.excalidraw-editor .excalidraw :is(.mobile-misc-tools-container, .undo-redo-buttons, .App-toolbar-content > div:has(> [data-testid="button-undo"])) .ToolIcon__icon {
  position: relative;
  background: transparent !important;
  border-color: transparent !important;
}
.excalidraw-editor .excalidraw .mobile-misc-tools-container .default-sidebar-trigger svg { position: relative; }
.excalidraw-editor [data-drawing-tooltip] { position: relative; }
.excalidraw-editor [data-drawing-tooltip]::after {
  content: attr(data-drawing-tooltip);
  position: absolute;
  right: calc(100% + 8px);
  top: 50%;
  width: max-content;
  max-width: min(280px, calc(100vw - 76px));
  padding: 6px 9px;
  border-radius: 6px;
  background: var(--tooltip-bg, #262629);
  color: #fff;
  font: var(--small-font-size, 12px)/1.4 system-ui, sans-serif;
  text-align: left;
  box-shadow: 0 3px 12px rgb(0 0 0 / 18%);
  pointer-events: none;
  z-index: 20;
  opacity: 0;
  visibility: hidden;
  translate: 3px -50%;
  transition: opacity 140ms ease, translate 140ms ease, visibility 140ms;
}
.excalidraw-editor [data-drawing-tooltip]:is(:hover, :focus-visible, :has(:focus-visible))::after {
  opacity: 1;
  visibility: visible;
  translate: 0 -50%;
}
body:has(.excalidraw-editor .undo-redo-buttons:hover) .excalidraw-tooltip { display: none !important; }
body .excalidraw-tooltip {
  min-width: 0 !important;
  max-width: min(280px, calc(100vw - 24px)) !important;
  padding: 6px 9px;
  border-radius: 6px;
  background: var(--tooltip-bg, #262629);
  color: var(--tooltip-text, #fff);
  font: var(--small-font-size, 12px)/1.4 system-ui, sans-serif;
  text-align: left;
  box-shadow: 0 3px 12px rgb(0 0 0 / 18%);
}
body .excalidraw-tooltip--visible { animation: excalidraw-tooltip-in 140ms ease-out; }
@keyframes excalidraw-tooltip-in {
  from { opacity: 0; translate: 0 3px; }
  to { opacity: 1; translate: 0 0; }
}
@media (prefers-reduced-motion: reduce) {
  .excalidraw-editor .excalidraw .ToolIcon::before,
  .excalidraw-editor .excalidraw .default-sidebar-trigger::before { transition: none !important; }
  .excalidraw-editor [data-drawing-tooltip]::after { transition: none; }
  body .excalidraw-tooltip--visible { animation: none; }
}

.excalidraw-fence {
  position: relative;
  margin: 0;
  box-sizing: border-box;
  border: 1px solid var(--border-light, rgba(128,128,128,.2));
  border-radius: var(--radius, 8px);
  background: var(--container-color, #fff);
  overflow: hidden;
}
.excalidraw-fence-inner {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px;
  box-sizing: border-box;
  cursor: pointer;
  outline: none;
}
.excalidraw-fence-inner:hover { background: var(--hover-bg, rgba(128,128,128,.06)); }
.excalidraw-fence-preview { width: 100%; height: 100%; align-items: center; justify-content: center; }
.excalidraw-fence-preview:not([hidden]) { display: flex; }
.excalidraw-fence-inner svg { display: block; max-width: 100%; height: 100%; }
.excalidraw-fence-hint { color: var(--text-secondary, #888); font-size: var(--small-font-size, 12px); }

.excalidraw-save-error { position:absolute;top:var(--space-3);left:var(--space-3);right:var(--space-3);z-index:1000;padding:var(--space-3);background:var(--container-color);color:var(--text-color);border:1px solid var(--border-color);border-radius:var(--radius); }
.excalidraw-save-error button { margin-left:var(--space-3); }
`

export function injectStyles(): () => void {
  const id = 'excalidraw-plugin-styles'
  let el = document.getElementById(id) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = id
    document.head.appendChild(el)
  }
  el.textContent = CSS
  return () => {
    if (document.getElementById(id) === el) el.remove()
  }
}
