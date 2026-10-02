// Icone SVG inline (tratto 1.8, currentColor): nessuna richiesta esterna.
const PATHS: Record<string, string> = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  forward: '<path d="M9 18l6-6-6-6"/>',
  reload: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>',
  desktop: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  tablet: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M11 17.5h2"/>',
  mobile: '<rect x="7.5" y="3" width="9" height="18" rx="2"/><path d="M11 17.5h2"/>',
  pointer: '<path d="M5 3.5l6.5 16 2.3-6.2 6.2-2.3z"/>',
  target:
    '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><rect x="8.5" y="8.5" width="7" height="7" rx="1"/>',
  area: '<rect x="3.5" y="5.5" width="17" height="13" rx="1.5" stroke-dasharray="3.2 2.6"/>',
  pen: '<path d="M4 20c2.5-.2 3.7-1.2 5-3.2l8.6-10.4a2 2 0 0 0-3-2.6L6.2 14.4C4.6 16 4 17.6 4 20z"/><path d="M13.5 5.5l3 2.6"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  send: '<path d="M21 3L10 14"/><path d="M21 3l-6.5 18-4-8-8-4z"/>',
  swap: '<path d="M4 8h15l-3.5-3.5M20 16H5l3.5 3.5"/>',
  split: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M13 4.5v15"/>',
  appOnly: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 8.5h18"/>',
  terminal: '<path d="M5 7l5 5-5 5"/><path d="M12.5 17.5H19"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  settings:
    '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>',
  close: '<path d="M18 6L6 18M6 6l12 12"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  trash: '<path d="M4 7h16M9 7V4.5h6V7M18 7l-.8 12.2a1.5 1.5 0 0 1-1.5 1.3H8.3a1.5 1.5 0 0 1-1.5-1.3L6 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  folder: '<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.5l2 2.2H19a1.5 1.5 0 0 1 1.5 1.5v8.3a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18z"/>',
  chevron: '<path d="M7 10l5 5 5-5"/>',
  bulb: '<path d="M9.5 18h5M10.5 21h3"/><path d="M12 3a6 6 0 0 0-3.7 10.7c.7.6 1.1 1.3 1.2 2.3h5c.1-1 .5-1.7 1.2-2.3A6 6 0 0 0 12 3z"/>',
};

export function icon(name: string): string {
  const body = PATHS[name] ?? '';
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}

/** Sostituisce i segnaposto data-icon / data-icon-left / data-icon-inline presenti nell'HTML. */
export function hydrateIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
    el.innerHTML = icon(el.dataset.icon!);
  });
  root.querySelectorAll<HTMLElement>('[data-icon-left]').forEach((el) => {
    const label = el.textContent?.trim() ?? '';
    el.innerHTML = `${icon(el.dataset.iconLeft!)}${label ? `<span class="lbl">${label}</span>` : ''}`;
  });
  root.querySelectorAll<HTMLElement>('[data-icon-inline]').forEach((el) => {
    el.outerHTML = icon(el.dataset.iconInline!);
  });
}
