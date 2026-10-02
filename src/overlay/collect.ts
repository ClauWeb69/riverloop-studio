// Raccolta dei dati di un elemento: selettore stabile, HTML ridotto, testo, stili, componente React.
import type { ElementSummary } from '../shared/protocol';

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BR', 'WBR', 'HEAD', 'TITLE', 'BASE']);
const VOID_TAGS = new Set(['AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT', 'LINK', 'META', 'SOURCE', 'TRACK', 'WBR']);
const TEST_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];

const cssEscape = (value: string): string =>
  typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);

/** id generati automaticamente (React useId, Radix, Headless UI, MUI...) non sono stabili. */
export function isStableId(id: string): boolean {
  if (!id || id.length > 64) return false;
  if (/^[:«]|[:»]$/.test(id)) return false;
  if (/^(radix|headlessui|mui|react-aria|rc_|tippy|popover|__next)/i.test(id)) return false;
  if (/\d{4,}/.test(id) || /[0-9a-f]{8}-[0-9a-f]{4}/i.test(id)) return false;
  return /^[A-Za-z][\w-]*$/.test(id);
}

/** Classi "leggibili": escluse quelle generate (CSS-in-JS, styled-jsx) e con caratteri speciali. */
export function stableClasses(el: Element, max = 2): string[] {
  const out: string[] = [];
  for (const cls of Array.from(el.classList)) {
    if (out.length >= max) break;
    if (cls.length > 40) continue;
    if (/^(css|sc|jsx|emotion|svelte|astro|chakra|mantine)-[\w-]+$/i.test(cls)) continue;
    if (/[:[\]/()!.@%#*,>~+='"]/.test(cls)) continue;
    if (/^[\d-]/.test(cls)) continue;
    out.push(cls);
  }
  return out;
}

/** Etichetta breve: tag, id stabile e fino a due classi (es. "button.cta.primary"). */
export function describe(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (el.id && isStableId(el.id)) return `${tag}#${el.id}`;
  const classes = stableClasses(el, 2);
  return classes.length ? `${tag}.${classes.join('.')}` : tag;
}

function isUnique(selector: string): boolean {
  try {
    return document.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

function anchorStep(el: Element): string | null {
  if (el.id && isStableId(el.id)) {
    const s = `#${cssEscape(el.id)}`;
    if (isUnique(s)) return s;
  }
  for (const attr of TEST_ATTRS) {
    const v = el.getAttribute(attr);
    if (v && v.length < 80) {
      const s = `[${attr}="${v.replace(/"/g, '\\"')}"]`;
      if (isUnique(s)) return s;
    }
  }
  return null;
}

function step(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const classes = stableClasses(el, 2);
  let s = tag + classes.map((c) => `.${cssEscape(c)}`).join('');
  const parent = el.parentElement;
  if (parent) {
    const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
    if (same.length > 1) {
      const matching = same.filter((c) => classes.every((cls) => c.classList.contains(cls)));
      if (matching.length > 1) s += `:nth-of-type(${same.indexOf(el) + 1})`;
    }
  }
  return s;
}

/**
 * Selettore CSS stabile: preferisce id e data-testid, poi una catena di tag e classi con
 * nth-of-type quando serve. Tiene almeno tre passaggi per restare leggibile ("main > section.hero > h1").
 */
export function stableSelector(el: Element): string {
  const direct = anchorStep(el);
  if (direct) return direct;
  const steps: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.documentElement) {
    if (cur !== el) {
      const anchor = anchorStep(cur);
      if (anchor) {
        steps.unshift(anchor);
        break;
      }
    }
    steps.unshift(step(cur));
    if (cur === document.body) break;
    cur = cur.parentElement;
  }
  for (let n = Math.min(3, steps.length); n <= steps.length; n++) {
    const candidate = steps.slice(steps.length - n).join(' > ');
    if (isUnique(candidate)) return candidate;
  }
  return steps.join(' > ');
}

// ---------------------------------------------------------------------------
// HTML ridotto e testo
// ---------------------------------------------------------------------------
const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function serialize(node: Node, depth: number): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = (node.textContent || '').replace(/\s+/g, ' ');
    return text.trim() ? escapeText(clip(text, 80)) : '';
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  if (SKIP_TAGS.has(el.tagName) && depth > 0) return '';
  const tag = el.tagName.toLowerCase();
  const attrs = Array.from(el.attributes)
    .filter((a) => !a.name.startsWith('on'))
    .map((a) => {
      const max = a.name === 'class' ? 160 : a.name === 'd' || a.name === 'style' ? 60 : 100;
      return a.value === '' ? ` ${a.name}` : ` ${a.name}="${escapeAttr(clip(a.value, max))}"`;
    })
    .join('');
  if (VOID_TAGS.has(el.tagName)) return `<${tag}${attrs}>`;
  if (tag === 'svg') return `<svg${attrs}>…</svg>`;
  const children = Array.from(el.childNodes).filter((c) => c.nodeType === Node.ELEMENT_NODE || (c.textContent || '').trim());
  let inner = '';
  if (children.length) {
    if (depth >= 2) {
      const onlyText = children.every((c) => c.nodeType === Node.TEXT_NODE);
      inner = onlyText ? escapeText(clip((el.textContent || '').replace(/\s+/g, ' ').trim(), 80)) : '…';
    } else {
      inner = children
        .slice(0, 8)
        .map((c) => serialize(c, depth + 1))
        .join('');
      if (children.length > 8) inner += `<!-- +${children.length - 8} -->`;
    }
  }
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

export function reducedHtml(el: Element, max = 1500): string {
  return clip(serialize(el, 0), max);
}

export function visibleText(el: Element, max = 200): string {
  const raw = el instanceof HTMLElement ? el.innerText : el.textContent || '';
  return clip((raw || '').replace(/\s+/g, ' ').trim(), max);
}

// ---------------------------------------------------------------------------
// Stili calcolati
// ---------------------------------------------------------------------------
function isTransparent(color: string): boolean {
  return !color || color === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(color) || /\/\s*0\)$/.test(color);
}

export function effectiveBackground(el: Element | null): string {
  for (let cur = el; cur; cur = cur.parentElement) {
    const bg = getComputedStyle(cur).backgroundColor;
    if (!isTransparent(bg)) return bg;
  }
  return '#ffffff';
}

export function pickStyles(el: Element): Record<string, string> {
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const out: Record<string, string> = {
    display: cs.display,
    position: cs.position,
    width: `${Math.round(r.width)}px`,
    height: `${Math.round(r.height)}px`,
    'font-family': cs.fontFamily,
    'font-size': cs.fontSize,
    'font-weight': cs.fontWeight,
    'line-height': cs.lineHeight,
    color: cs.color,
    'background-color': cs.backgroundColor,
    padding: cs.padding,
    margin: cs.margin,
    'text-align': cs.textAlign,
    'border-radius': cs.borderRadius,
  };
  if (isTransparent(cs.backgroundColor)) out['sfondo-effettivo'] = effectiveBackground(el.parentElement);
  if (cs.borderStyle !== 'none' && parseFloat(cs.borderWidth) > 0) out.border = `${cs.borderWidth} ${cs.borderStyle} ${cs.borderColor}`;
  if (cs.backgroundImage && cs.backgroundImage !== 'none') out['background-image'] = clip(cs.backgroundImage, 160);
  if (cs.display.includes('flex')) {
    out['flex-direction'] = cs.flexDirection;
    out['justify-content'] = cs.justifyContent;
    out['align-items'] = cs.alignItems;
    out.gap = cs.gap;
  } else if (cs.display.includes('grid')) {
    out['grid-template-columns'] = clip(cs.gridTemplateColumns, 120);
    out.gap = cs.gap;
  }
  if (cs.boxShadow && cs.boxShadow !== 'none') out['box-shadow'] = clip(cs.boxShadow, 120);
  if (cs.opacity !== '1') out.opacity = cs.opacity;
  return out;
}

// ---------------------------------------------------------------------------
// React: nomi dei componenti e sorgente (solo build di sviluppo)
// ---------------------------------------------------------------------------
const INTERNAL_COMPONENTS = new Set([
  'AppRouter',
  'Router',
  'ServerRoot',
  'Root',
  'HotReload',
  'ReactDevOverlay',
  'DevRootHTTPAccessFallbackBoundary',
  'InnerLayoutRouter',
  'OuterLayoutRouter',
  'RenderFromTemplateContext',
  'ScrollAndFocusHandler',
  'InnerScrollAndFocusHandler',
  'RedirectBoundary',
  'RedirectErrorBoundary',
  'NotFoundBoundary',
  'NotFoundErrorBoundary',
  'LoadingBoundary',
  'ErrorBoundary',
  'ErrorBoundaryHandler',
  'HTTPAccessFallbackBoundary',
  'HTTPAccessFallbackErrorBoundary',
  'GlobalError',
  'AppDevOverlay',
  'AppDevOverlayErrorBoundary',
  'SegmentViewNode',
  'SegmentTrieNode',
  'SegmentStateProvider',
  'MetadataBoundary',
  'ViewportBoundary',
  'OutletBoundary',
  'Head',
  'ClientPageRoot',
  'ClientSegmentRoot',
  'RootLayoutBoundary',
  'LayoutRouter',
  'Fragment',
  'Suspense',
  'StrictMode',
  'Profiler',
  'PathnameContextProviderAdapter',
  'Container',
  'AppContainer',
  'ReactDevOverlayWrapper',
  'RouteAnnouncer',
  'Portal',
  'Link',
  'LinkComponent',
  'Image',
  'ImageElement',
  'Script',
  'HandleRedirect',
  'NextDevTools',
  'InnerScrollHandlerNew',
  'ScrollAndMaybeFocusHandler',
  'SegmentBoundaryTriggerNode',
  'ReplaySsrOnlyErrors',
  'HistoryUpdater',
  'RuntimeStyles',
  'AsyncMetadataOutlet',
  'MetadataOutlet',
  'NonIndex',
  'DevOverlay',
  'RenderChildren',
  'TemplateContext',
]);

function componentName(type: unknown): string | null {
  if (!type) return null;
  if (typeof type === 'function') {
    const t = type as { displayName?: string; name?: string };
    return t.displayName || t.name || null;
  }
  if (typeof type === 'object') {
    const t = type as { displayName?: string; render?: unknown; type?: unknown };
    if (t.displayName) return t.displayName;
    if (t.render) return componentName(t.render);
    if (t.type) return componentName(t.type);
  }
  return null;
}

// Involucri generici che non aiutano a trovare il componente.
const INTERNAL_SUFFIX = /(Provider|Context|Consumer|Boundary|ErrorBoundaryHandler)$/;

function isUsefulName(name: string | null | undefined): name is string {
  if (!name || name.length < 2 || name.length > 60) return false;
  if (INTERNAL_COMPONENTS.has(name)) return false;
  if (!/^[A-Z]/.test(name)) return false;
  return !INTERNAL_SUFFIX.test(name);
}

type DebugSource = { fileName?: string; lineNumber?: number; columnNumber?: number };

/** Fiber di React (sviluppo) oppure ReactComponentInfo di un Server Component (React 19). */
interface Owner {
  name?: unknown;
  type?: unknown;
  _debugOwner?: Owner | null;
  owner?: Owner | null;
  _debugSource?: DebugSource;
}

interface Fiber extends Owner {
  return?: Fiber | null;
  _debugInfo?: Array<{ name?: unknown; env?: unknown }> | null;
}

function fiberOf(el: Element): Fiber | null {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    for (const key of Object.keys(cur)) {
      if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
        return (cur as unknown as Record<string, Fiber>)[key];
      }
    }
  }
  return null;
}

const sourceOf = (s: DebugSource | undefined) => (s?.fileName ? `${s.fileName}:${s.lineNumber ?? 0}` : null);

export interface ReactInfo {
  components: string[];
  source: string | null;
}

/**
 * Componenti React che hanno scritto il JSX dell'elemento, dal più vicino (es. "Counter",
 * poi "Home", "RootLayout"): si segue la catena degli "owner", che salta gli involucri
 * interni del framework e include i Server Components. Con React 18 c'è anche file:riga.
 */
export function reactInfo(el: Element): ReactInfo {
  const components: string[] = [];
  let source: string | null = null;
  const add = (name: string) => {
    if (!components.includes(name)) components.push(name);
  };
  try {
    const fiber = fiberOf(el);
    if (fiber) {
      source = sourceOf(fiber._debugSource);
      let owner: Owner | null = fiber._debugOwner ?? null;
      for (let i = 0; owner && i < 20 && components.length < 3; i++) {
        const name = typeof owner.name === 'string' ? owner.name : componentName(owner.type);
        if (isUsefulName(name)) add(name);
        source ??= sourceOf(owner._debugSource);
        owner = owner._debugOwner ?? owner.owner ?? null;
      }
      // Senza informazioni sugli owner: risaliamo l'albero dei fiber
      if (!components.length) {
        let cur: Fiber | null = fiber;
        for (let i = 0; cur && i < 80 && components.length < 3; i++, cur = cur.return ?? null) {
          if (Array.isArray(cur._debugInfo)) {
            for (const info of cur._debugInfo) {
              const name = typeof info?.name === 'string' ? info.name : null;
              if (isUsefulName(name) && info.env) add(name);
            }
          }
          const name = componentName(cur.type);
          if (isUsefulName(name)) add(name);
        }
      }
    }
  } catch {
    /* strutture interne diverse: niente informazioni React */
  }
  // Attributo opzionale aggiunto da un plugin di build (vedi README)
  const attr = el.closest('[data-studio-src]')?.getAttribute('data-studio-src');
  if (attr) source = attr;
  return { components, source };
}

// ---------------------------------------------------------------------------
// Elementi in una zona
// ---------------------------------------------------------------------------
export function summary(el: Element): ElementSummary {
  const text = visibleText(el, 60);
  return { label: describe(el), selector: stableSelector(el), ...(text ? { text } : {}) };
}

/** Elementi interamente contenuti nel rettangolo (coordinate viewport), solo i più esterni. */
export function elementsInRect(r: { x: number; y: number; width: number; height: number }, limit = 10): Element[] {
  const inside: Element[] = [];
  const all = document.body ? document.body.querySelectorAll('*') : [];
  for (const el of Array.from(all)) {
    if (SKIP_TAGS.has(el.tagName)) continue;
    const b = el.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) continue;
    if (b.left >= r.x - 1 && b.top >= r.y - 1 && b.right <= r.x + r.width + 1 && b.bottom <= r.y + r.height + 1) inside.push(el);
  }
  const set = new Set(inside);
  const outer = inside.filter((el) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
    return true;
  });
  return outer.slice(0, limit);
}

/** Elemento più piccolo che contiene tutta la zona (coordinate viewport); null se è solo la pagina. */
export function containerOf(r: { x: number; y: number; width: number; height: number }, pick: (x: number, y: number) => Element | null): Element | null {
  const cx = Math.min(innerWidth - 1, Math.max(0, r.x + r.width / 2));
  const cy = Math.min(innerHeight - 1, Math.max(0, r.y + r.height / 2));
  for (let el = pick(cx, cy); el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    const b = el.getBoundingClientRect();
    if (b.left <= r.x + 1 && b.top <= r.y + 1 && b.right >= r.x + r.width - 1 && b.bottom >= r.y + r.height - 1) return el;
  }
  return null;
}

/** Testo del titolo (h1–h6) più vicino sopra la zona: aiuta a capire in che punto della pagina si trova. */
export function headingAbove(r: { x: number; y: number; width: number; height: number }): string | null {
  let best: { text: string; bottom: number } | null = null;
  for (const h of Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]'))) {
    const b = h.getBoundingClientRect();
    if (b.width < 1 || b.height < 1 || b.bottom > r.y + 4) continue;
    if (best && b.bottom <= best.bottom) continue;
    const text = visibleText(h, 80);
    if (text) best = { text, bottom: b.bottom };
  }
  return best?.text ?? null;
}

/** Antenato comune più vicino di un gruppo di elementi. */
export function commonAncestor(elements: Element[]): Element | null {
  if (!elements.length) return null;
  let candidate: Element | null = elements[0];
  while (candidate && !elements.every((e) => candidate!.contains(e))) candidate = candidate.parentElement;
  return candidate;
}
