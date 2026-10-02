import {
  type AnnotationCapture,
  type AnnotationKind,
  type AnnotationView,
  type DraftInfo,
  type ElementSummary,
  type OverlayToPage,
  type Rect,
  type ToolMode,
} from '../shared/protocol';
import {
  commonAncestor,
  containerOf,
  describe,
  elementsInRect,
  headingAbove,
  pickStyles,
  reactInfo,
  reducedHtml,
  stableSelector,
  summary,
  visibleText,
} from './collect';
import { baseFromViewport, captureBase, finalizeShot, SHOT_MARGIN, type BaseShot, type Box } from './screenshot';
import { setOverlayLocale, t } from './i18n';
import { OVERLAY_CSS } from './styles';
import type { BridgeRequest, Incoming, Transport } from './transport';

type MarkStatus = 'draft' | 'pending' | 'sending' | 'sent' | 'error';

interface Mark {
  localId: string;
  id: number | null;
  kind: AnnotationKind;
  status: MarkStatus;
  comment: string;
  url: string;
  /** Elemento annotato (kind = element). */
  target: Element | null;
  selector: string | null;
  /** Elemento di ancoraggio per riquadri e disegni: la zona segue il suo scroll. */
  anchor: Element | null;
  anchorSelector: string | null;
  offX: number;
  offY: number;
  w: number;
  h: number;
  /** Posizione nel documento, usata se l'ancoraggio sparisce. */
  docRect: Rect;
  path?: Array<[number, number]>;
  el: HTMLDivElement;
  badge: HTMLDivElement;
  svgLine?: SVGPolylineElement;
  svg?: SVGSVGElement;
  shot?: { base?: BaseShot; box?: Box; error?: string };
  shotPosted: boolean;
  /** Ultima posizione comunicata alla pagina Studio (solo bozze). */
  sentRect?: string;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const PILL_KIND: Record<Exclude<ToolMode, 'navigate'>, AnnotationKind> = { select: 'element', area: 'area', draw: 'drawing' };

/** Contenuto della pastiglia in alto: nome dello strumento e come si usa. */
function pillContent(mode: Exclude<ToolMode, 'navigate'>): Node[] {
  const name = document.createElement('b');
  name.textContent = t(`kind.${PILL_KIND[mode]}`);
  const sep = document.createElement('span');
  sep.className = 'sep';
  sep.textContent = '·';
  const hint = document.createElement('span');
  hint.className = 'muted';
  hint.textContent = t(`pill.${mode}`);
  return [name, sep, hint];
}

/** Percorso della pagina; per i file locali (app desktop) basta il nome del file. */
const currentUrl = () => {
  const path = location.protocol === 'file:' ? `/${location.pathname.split('/').pop() ?? ''}` : location.pathname;
  return path + location.search + location.hash;
};
const samePage = (a: string, b: string) => a.split('#')[0] === b.split('#')[0];
const round = (n: number) => Math.round(n * 10) / 10;

function div(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

function query(selector: string | null): Element | null {
  if (!selector) return null;
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

function scrollableAncestor(el: Element | null, dx: number, dy: number): Element | null {
  for (let cur = el; cur && cur !== document.body && cur !== document.documentElement; cur = cur.parentElement) {
    const cs = getComputedStyle(cur);
    const canY = /(auto|scroll|overlay)/.test(cs.overflowY) && cur.scrollHeight > cur.clientHeight + 1;
    const canX = /(auto|scroll|overlay)/.test(cs.overflowX) && cur.scrollWidth > cur.clientWidth + 1;
    const moreY = dy > 0 ? cur.scrollTop + cur.clientHeight < cur.scrollHeight - 1 : dy < 0 && cur.scrollTop > 0;
    const moreX = dx > 0 ? cur.scrollLeft + cur.clientWidth < cur.scrollWidth - 1 : dx < 0 && cur.scrollLeft > 0;
    if ((dy && canY && moreY) || (dx && canX && moreX)) return cur;
  }
  return null;
}

/**
 * Overlay di annotazione dentro l'app. Disegna evidenziazioni, badge e tratti, raccoglie i dati
 * degli elementi e cattura gli screenshot. Il commento si scrive nella pagina Studio: qui ci sono
 * solo le "bozze" (zona scelta, in attesa del commento) e le annotazioni salvate.
 */
export class Overlay {
  private readonly transport: Transport;
  /** Catture chieste al companion (modalità desktop), in attesa dell'immagine. */
  private readonly captures = new Map<string, (msg: { data: string | null; error?: string }) => void>();
  private hiddenForCapture = 0;
  private host!: HTMLElement;
  private root!: HTMLDivElement;
  private marksLayer!: HTMLDivElement;
  private badgesLayer!: HTMLDivElement;
  private shield!: HTMLDivElement;
  private frameEl!: HTMLDivElement;
  private pill!: HTMLDivElement;
  private pillText!: HTMLSpanElement;
  private pillClose!: HTMLButtonElement;
  private hoverBox!: HTMLDivElement;
  private hoverLabel!: HTMLDivElement;
  private draftRect!: HTMLDivElement;
  private drawLine!: SVGPolylineElement;

  private mode: ToolMode = 'navigate';
  private marks: Mark[] = [];
  private readonly drafts = new Map<string, Mark>();
  private hoverEl: Element | null = null;
  private childStack: Element[] = [];
  private drag: { kind: 'select' | 'area' | 'draw'; x0: number; y0: number; points: Array<[number, number]>; at: number } | null = null;
  private lastHref = location.href;
  private rafQueued = false;
  private counter = 0;
  private attached = false;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  // -------------------------------------------------------------------------
  // Avvio
  // -------------------------------------------------------------------------
  init(): void {
    this.build();
    this.transport.listen((msg) => this.onMessage(msg));
    window.addEventListener('keydown', (ev) => this.onKey(ev), true);
    window.addEventListener('scroll', () => this.schedule(), { capture: true, passive: true });
    window.addEventListener('resize', () => this.schedule());
    window.addEventListener('popstate', () => this.checkLocation());
    window.addEventListener('hashchange', () => this.checkLocation());
    window.addEventListener('pageshow', (ev) => {
      if (ev.persisted) this.announce();
    });
    // L'host entra nel DOM dopo il caricamento, per non interferire con l'idratazione di React.
    const attachLater = () => setTimeout(() => this.attach(), 60);
    if (document.readyState === 'complete') attachLater();
    else window.addEventListener('load', attachLater, { once: true });
    setTimeout(() => this.attach(), 4000);
    setInterval(() => this.tick(), 400);
    this.announce();
  }

  private announce(attempt = 0): void {
    // Nelle app desktop il canale con il companion può non essere ancora pronto: si riprova
    if (!this.post({ type: 'ready', url: currentUrl(), title: document.title }) && attempt < 40) {
      setTimeout(() => this.announce(attempt + 1), 250);
    }
  }

  private build(): void {
    const host = document.createElement('rls-studio-overlay');
    host.setAttribute('data-riverloop-studio', '');
    host.style.cssText =
      'all:initial!important;position:fixed!important;top:0!important;left:0!important;width:0!important;height:0!important;' +
      'z-index:2147483647!important;pointer-events:none!important;display:block!important;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = OVERLAY_CSS;
    shadow.appendChild(style);
    this.host = host;

    const root = div('root');
    this.root = root;
    this.marksLayer = div('layer');
    this.shield = div('shield');
    this.shield.hidden = true;
    this.hoverBox = div('hover-box');
    this.hoverLabel = div('hover-label');
    this.hoverBox.hidden = this.hoverLabel.hidden = true;
    this.draftRect = div('draft-rect');
    this.draftRect.hidden = true;
    const drawSvg = document.createElementNS(SVG_NS, 'svg');
    drawSvg.setAttribute('class', 'draw-layer');
    this.drawLine = document.createElementNS(SVG_NS, 'polyline');
    this.drawLine.setAttribute('fill', 'none');
    this.drawLine.setAttribute('stroke', '#e5484d');
    this.drawLine.setAttribute('stroke-width', '3');
    this.drawLine.setAttribute('stroke-linecap', 'round');
    this.drawLine.setAttribute('stroke-linejoin', 'round');
    drawSvg.appendChild(this.drawLine);
    this.badgesLayer = div('layer');
    this.frameEl = div('frame');
    this.frameEl.hidden = true;
    this.pill = div('pill');
    this.pill.hidden = true;
    this.pill.style.pointerEvents = 'none';
    this.pillText = document.createElement('span');
    const pillClose = document.createElement('button');
    pillClose.type = 'button';
    pillClose.title = t('pill.close');
    this.pillClose = pillClose;
    pillClose.textContent = '×';
    pillClose.style.pointerEvents = 'auto';
    pillClose.addEventListener('click', () => this.setMode('navigate', true));
    this.pill.append(this.pillText, pillClose);
    root.append(this.marksLayer, this.shield, this.hoverBox, this.hoverLabel, this.draftRect, drawSvg, this.badgesLayer, this.frameEl, this.pill);
    shadow.appendChild(root);

    this.shield.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.shield.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.shield.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.shield.addEventListener('pointercancel', () => this.cancelDrag());
    this.shield.addEventListener('contextmenu', (e) => e.preventDefault());
    this.shield.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
  }

  private attach(): void {
    if (!document.documentElement) return;
    if (!this.host.isConnected) document.documentElement.appendChild(this.host);
    this.attached = true;
    this.schedule();
  }

  // -------------------------------------------------------------------------
  // Messaggi con la pagina Studio
  // -------------------------------------------------------------------------
  private post(msg: OverlayToPage | BridgeRequest): boolean {
    return this.transport.post(msg);
  }

  private onMessage(msg: Incoming): void {
    switch (msg.type) {
      case 'announce':
        this.announce();
        break;
      case 'capture:result':
        this.captures.get(msg.key)?.(msg);
        break;
      case 'hello':
        if (setOverlayLocale(msg.locale)) this.applyLocale();
        this.setMode(msg.mode, false);
        this.syncMarks(msg.annotations);
        break;
      case 'mode':
        this.setMode(msg.mode, false);
        break;
      case 'draft:commit': {
        const m = this.drafts.get(msg.localId);
        if (m) this.commitDraft(m);
        break;
      }
      case 'draft:cancel': {
        const m = this.drafts.get(msg.localId);
        if (m) this.destroyMark(m);
        break;
      }
      case 'draft:adjust': {
        const m = this.drafts.get(msg.localId);
        if (m) this.adjustDraftTarget(m, msg.dir);
        break;
      }
      case 'annotation:assigned': {
        const m = this.marks.find((x) => x.localId === msg.localId);
        if (m) {
          m.id = msg.id;
          this.refreshBadge(m);
          this.flushShot(m);
        }
        break;
      }
      case 'annotation:update': {
        const m = this.marks.find((x) => x.id === msg.id);
        if (m && typeof msg.comment === 'string') {
          m.comment = msg.comment;
          this.refreshBadge(m);
        }
        break;
      }
      case 'annotations:sync':
        this.syncMarks(msg.annotations);
        break;
      case 'annotation:remove': {
        const m = this.marks.find((x) => x.id === msg.id);
        if (m) this.destroyMark(m);
        break;
      }
      case 'annotation:status':
        if (!Array.isArray(msg.ids)) break;
        for (const id of msg.ids) {
          const m = this.marks.find((x) => x.id === id);
          if (!m) continue;
          if (msg.status === 'sent') {
            m.status = 'sent';
            m.el.classList.add('sent');
            this.refreshBadge(m);
            setTimeout(() => this.destroyMark(m), 1600);
          } else {
            m.status = msg.status === 'error' ? 'error' : 'pending';
            this.refreshBadge(m);
          }
        }
        break;
      case 'annotation:focus': {
        const m = this.marks.find((x) => x.id === msg.id);
        if (m) this.focusMark(m);
        break;
      }
      case 'nav':
        if (msg.action === 'back') history.back();
        else if (msg.action === 'forward') history.forward();
        else if (msg.action === 'reload') location.reload();
        break;
      default:
        break;
    }
  }

  private tick(): void {
    this.checkLocation();
    if (this.attached && !this.host.isConnected) this.attach();
    if (this.marks.length || this.drafts.size) this.schedule();
  }

  private checkLocation(): void {
    if (location.href === this.lastHref) return;
    this.lastHref = location.href;
    this.post({ type: 'location', url: currentUrl(), title: document.title });
    this.schedule();
  }

  // -------------------------------------------------------------------------
  // Modalità
  // -------------------------------------------------------------------------
  private setMode(mode: ToolMode, notify: boolean): void {
    if (!['navigate', 'select', 'area', 'draw'].includes(mode)) return;
    if (mode !== 'navigate' && !this.host.isConnected) this.attach();
    if (mode !== this.mode) {
      // Lo strumento scelto nella pagina arriva con un messaggio, e il browser dà la precedenza
      // all'input: un gesto cominciato subito dopo il clic sullo strumento può arrivare prima.
      // Se è appena cominciato si prosegue con il nuovo strumento invece di perderlo.
      const fresh = this.drag && mode !== 'navigate' && performance.now() - this.drag.at < 300 ? this.drag : null;
      this.cancelDrag();
      this.mode = mode;
      if (fresh) this.beginDrag(fresh.x0, fresh.y0);
    }
    const active = mode !== 'navigate';
    this.shield.hidden = !active;
    this.frameEl.hidden = !active;
    this.pill.hidden = !active;
    if (active) this.pillText.replaceChildren(...pillContent(mode as Exclude<ToolMode, 'navigate'>));
    this.shield.style.cursor = mode === 'select' ? 'default' : 'crosshair';
    this.hoverEl = null;
    this.childStack = [];
    this.hoverBox.hidden = this.hoverLabel.hidden = true;
    if (notify) this.post({ type: 'mode', mode });
  }

  // -------------------------------------------------------------------------
  // Tastiera: in modalità Naviga i tasti restano all'app (solo Ctrl+Invio con annotazioni in sospeso)
  // -------------------------------------------------------------------------
  private onKey(e: KeyboardEvent): void {
    const annotating = this.mode !== 'navigate';
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const hasPending = this.marks.some((m) => m.status === 'pending' || m.status === 'error');
    if (mod && key === 'Enter') {
      if (hasPending) {
        stop();
        this.post({ type: 'send' });
      }
      return;
    }
    if (!annotating) return;
    if (mod && !e.shiftKey && !e.altKey && (key === 'z' || key === 'Z')) {
      if (hasPending) {
        stop();
        this.post({ type: 'undo' });
      }
      return;
    }
    if (mod || e.altKey) return;
    if (key === 'Escape') {
      stop();
      if (this.drafts.size) this.closeDrafts();
      else this.setMode('navigate', true);
      return;
    }
    if (this.mode === 'select' && (key === 'ArrowUp' || key === 'ArrowDown') && this.hoverEl) {
      stop();
      this.moveHover(key === 'ArrowUp' ? 'parent' : 'child');
      return;
    }
    const lower = key.toLowerCase();
    const next: ToolMode | null = lower === 's' ? 'select' : lower === 'r' ? 'area' : lower === 'd' ? 'draw' : null;
    if (next) {
      stop();
      this.setMode(next, true);
    }
  }

  // -------------------------------------------------------------------------
  // Puntatore
  // -------------------------------------------------------------------------
  private elementAt(x: number, y: number): Element | null {
    const list = document.elementsFromPoint(x, y);
    for (const el of list) {
      if (el === this.host || el === document.documentElement) continue;
      if (el.tagName === 'NEXTJS-PORTAL' || el.hasAttribute('data-riverloop-studio')) continue;
      return el;
    }
    return null;
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    this.shield.setPointerCapture(e.pointerId);
    this.beginDrag(e.clientX, e.clientY);
  }

  private beginDrag(x: number, y: number): void {
    this.drag = { kind: this.mode === 'area' ? 'area' : this.mode === 'draw' ? 'draw' : 'select', x0: x, y0: y, points: [[x, y]], at: performance.now() };
    this.draftRect.hidden = this.drag.kind !== 'area';
    this.drawLine.setAttribute('points', this.drag.kind === 'draw' ? `${x},${y}` : '');
    if (this.drag.kind === 'area') this.placeDraftRect(x, y);
  }

  private onPointerMove(e: PointerEvent): void {
    this.dodgePill(e.clientX, e.clientY);
    if (this.drag?.kind === 'area') {
      this.placeDraftRect(e.clientX, e.clientY);
      return;
    }
    if (this.drag?.kind === 'draw') {
      const pts = this.drag.points;
      const [lx, ly] = pts[pts.length - 1];
      if (Math.hypot(e.clientX - lx, e.clientY - ly) >= 2) {
        pts.push([e.clientX, e.clientY]);
        this.drawLine.setAttribute('points', pts.map(([x, y]) => `${x},${y}`).join(' '));
      }
      return;
    }
    if (this.mode === 'select' && !this.drag) {
      const el = this.elementAt(e.clientX, e.clientY);
      if (el && el !== this.hoverEl) {
        this.hoverEl = el;
        this.childStack = [];
        this.renderHover();
      }
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const drag = this.drag;
    this.drag = null;
    try {
      this.shield.releasePointerCapture(e.pointerId);
    } catch {
      /* già rilasciato */
    }
    if (!drag) return;
    if (drag.kind === 'select') {
      const el = this.hoverEl ?? this.elementAt(e.clientX, e.clientY);
      if (el) this.startElementDraft(el);
      return;
    }
    if (drag.kind === 'area') {
      this.draftRect.hidden = true;
      const x = Math.min(drag.x0, e.clientX);
      const y = Math.min(drag.y0, e.clientY);
      const w = Math.abs(e.clientX - drag.x0);
      const h = Math.abs(e.clientY - drag.y0);
      if (w >= 8 && h >= 8) this.startAreaDraft({ x, y, width: w, height: h });
      return;
    }
    this.drawLine.setAttribute('points', '');
    const pts = drag.points;
    let length = 0;
    for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (pts.length >= 2 && length >= 8) this.startDrawingDraft(pts);
  }

  private cancelDrag(): void {
    this.drag = null;
    this.draftRect.hidden = true;
    this.drawLine.setAttribute('points', '');
  }

  private onWheel(e: WheelEvent): void {
    // Lo scudo copre la pagina: inoltriamo lo scroll al contenitore sotto il puntatore.
    e.preventDefault();
    const factor = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
    const dx = e.deltaX * factor;
    const dy = e.deltaY * factor;
    const target = scrollableAncestor(this.elementAt(e.clientX, e.clientY), dx, dy) ?? document.scrollingElement ?? document.documentElement;
    target.scrollBy({ left: dx, top: dy });
    this.schedule();
  }

  private placeDraftRect(x: number, y: number): void {
    if (!this.drag) return;
    const s = this.draftRect.style;
    s.left = `${Math.min(this.drag.x0, x)}px`;
    s.top = `${Math.min(this.drag.y0, y)}px`;
    s.width = `${Math.abs(x - this.drag.x0)}px`;
    s.height = `${Math.abs(y - this.drag.y0)}px`;
  }

  private dodgePill(x: number, y: number): void {
    if (this.pill.hidden) return;
    const r = this.pill.getBoundingClientRect();
    const near = x > r.left - 30 && x < r.right + 30 && y > r.top - 30 && y < r.bottom + 30;
    if (near) {
      const atTop = r.top < innerHeight / 2;
      this.pill.style.top = atTop ? 'auto' : '10px';
      this.pill.style.bottom = atTop ? '10px' : 'auto';
    }
  }

  // -------------------------------------------------------------------------
  // Evidenziazione in modalità Elemento
  // -------------------------------------------------------------------------
  private moveHover(dir: 'parent' | 'child'): void {
    const el = this.hoverEl;
    if (!el) return;
    const next = this.relative(el, dir);
    if (next) this.hoverEl = next;
    this.renderHover();
  }

  private relative(el: Element, dir: 'parent' | 'child'): Element | null {
    if (dir === 'parent') {
      const parent = el.parentElement;
      if (!parent || parent === document.documentElement) return null;
      this.childStack.push(el);
      return parent;
    }
    return this.childStack.pop() ?? Array.from(el.children).find((c) => c.getBoundingClientRect().width > 0) ?? null;
  }

  private renderHover(): void {
    const el = this.hoverEl;
    if (!el || !el.isConnected || this.mode !== 'select') {
      this.hoverBox.hidden = this.hoverLabel.hidden = true;
      return;
    }
    const r = el.getBoundingClientRect();
    const b = this.hoverBox.style;
    b.left = `${r.left}px`;
    b.top = `${r.top}px`;
    b.width = `${r.width}px`;
    b.height = `${r.height}px`;
    this.hoverBox.hidden = false;
    this.hoverLabel.textContent = describe(el);
    const dim = document.createElement('span');
    dim.className = 'dim';
    dim.textContent = `  ${Math.round(r.width)}×${Math.round(r.height)}`;
    this.hoverLabel.append(dim);
    this.hoverLabel.hidden = false;
    const top = r.top > 26 ? r.top - 24 : Math.min(innerHeight - 24, r.bottom + 4);
    this.hoverLabel.style.left = `${Math.max(4, Math.min(innerWidth - 200, r.left))}px`;
    this.hoverLabel.style.top = `${top}px`;
  }

  // -------------------------------------------------------------------------
  // Bozze: zona scelta, il commento arriva dalla pagina Studio
  // -------------------------------------------------------------------------
  private newMark(kind: AnnotationKind, partial: Partial<Mark>): Mark {
    const el = div(`mark ${kind}`);
    el.appendChild(div('box'));
    const badge = div(`badge ${kind} draft`);
    badge.textContent = '+';
    const mark: Mark = {
      localId: `l${Date.now().toString(36)}${(this.counter++).toString(36)}`,
      id: null,
      kind,
      status: 'draft',
      comment: '',
      url: currentUrl(),
      target: null,
      selector: null,
      anchor: null,
      anchorSelector: null,
      offX: 0,
      offY: 0,
      w: 0,
      h: 0,
      docRect: { x: 0, y: 0, width: 0, height: 0 },
      el,
      badge,
      shotPosted: false,
      ...partial,
    };
    if (kind === 'drawing') {
      const svg = document.createElementNS(SVG_NS, 'svg');
      const line = document.createElementNS(SVG_NS, 'polyline');
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', '#e5484d');
      line.setAttribute('stroke-width', '3');
      line.setAttribute('stroke-linecap', 'round');
      line.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(line);
      el.appendChild(svg);
      mark.svg = svg;
      mark.svgLine = line;
    }
    badge.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    badge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.editMark(mark);
    });
    this.marksLayer.appendChild(el);
    this.badgesLayer.appendChild(badge);
    return mark;
  }

  private startElementDraft(el: Element): void {
    const r = el.getBoundingClientRect();
    const mark = this.newMark('element', {
      target: el,
      selector: stableSelector(el),
      w: r.width,
      h: r.height,
      docRect: { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height },
    });
    this.hoverEl = null;
    this.hoverBox.hidden = this.hoverLabel.hidden = true;
    this.openDraft(mark);
  }

  private startAreaDraft(rect: Box): void {
    const inside = elementsInRect(rect);
    const anchor = inside[0] ?? this.elementAt(rect.x + rect.width / 2, rect.y + rect.height / 2) ?? document.body;
    const ar = anchor.getBoundingClientRect();
    const mark = this.newMark('area', {
      anchor,
      anchorSelector: stableSelector(anchor),
      offX: rect.x - ar.left,
      offY: rect.y - ar.top,
      w: rect.width,
      h: rect.height,
      docRect: { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height },
    });
    this.openDraft(mark);
  }

  private startDrawingDraft(points: Array<[number, number]>): void {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const w = Math.max(1, Math.max(...xs) - x);
    const h = Math.max(1, Math.max(...ys) - y);
    const anchor = this.elementAt(points[0][0], points[0][1]) ?? document.body;
    const ar = anchor.getBoundingClientRect();
    const mark = this.newMark('drawing', {
      anchor,
      anchorSelector: stableSelector(anchor),
      offX: x - ar.left,
      offY: y - ar.top,
      w,
      h,
      docRect: { x: x + scrollX, y: y + scrollY, width: w, height: h },
      path: points.map(([px, py]) => [round(px - x), round(py - y)] as [number, number]),
    });
    this.openDraft(mark);
  }

  private draftInfo(m: Mark): DraftInfo {
    const b = this.boxOf(m) ?? { x: 0, y: 0, width: m.w, height: m.h };
    let label = `${Math.round(b.width)}×${Math.round(b.height)}`;
    if (m.kind === 'element' && m.target) label = `${describe(m.target)}  ${label}`;
    if (m.kind === 'drawing') label = t('draft.freehand');
    let rect: Rect = { x: round(b.x), y: round(b.y), width: round(b.width), height: round(b.height) };
    if (m.kind === 'drawing' && m.path?.length) {
      // Per i disegni la casella del commento si apre accanto al punto finale del tratto
      const [px, py] = m.path[m.path.length - 1];
      rect = { x: round(b.x + px), y: round(b.y + py), width: 1, height: 1 };
    }
    return { localId: m.localId, kind: m.kind, label, rect, canAdjust: m.kind === 'element' };
  }

  private openDraft(mark: Mark): void {
    this.drafts.set(mark.localId, mark);
    this.update();
    const info = this.draftInfo(mark);
    mark.sentRect = JSON.stringify(info.rect);
    this.post({ type: 'draft:open', ...info });
  }

  private adjustDraftTarget(m: Mark, dir: 'parent' | 'child'): void {
    if (m.kind !== 'element' || !m.target) return;
    const next = this.relative(m.target, dir);
    if (!next) return;
    const r = next.getBoundingClientRect();
    m.target = next;
    m.selector = stableSelector(next);
    m.w = r.width;
    m.h = r.height;
    m.docRect = { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
    this.update();
    const info = this.draftInfo(m);
    m.sentRect = JSON.stringify(info.rect);
    this.post({ type: 'draft:update', ...info });
  }

  /** Esc nell'app: scarta le bozze aperte e avvisa la pagina Studio. */
  private closeDrafts(): void {
    for (const m of [...this.drafts.values()]) {
      this.destroyMark(m);
      this.post({ type: 'draft:closed', localId: m.localId });
    }
  }

  private editMark(m: Mark): void {
    if (m.id === null || m.status === 'sent' || m.status === 'sending') return;
    const b = this.boxOf(m);
    if (b) this.post({ type: 'annotation:edit', id: m.id, rect: { x: round(b.x), y: round(b.y), width: round(b.width), height: round(b.height) } });
  }

  // -------------------------------------------------------------------------
  // Salvataggio: dati + screenshot
  // -------------------------------------------------------------------------
  private commitDraft(m: Mark): void {
    this.drafts.delete(m.localId);
    m.status = 'pending';
    this.marks.push(m);
    this.refreshBadge(m);
    let data: AnnotationCapture;
    try {
      data = this.capture(m);
    } catch (err) {
      console.warn('[Riverloop Studio] raccolta dati non riuscita', err);
      this.destroyMark(m);
      this.post({ type: 'draft:closed', localId: m.localId });
      return;
    }
    this.post({ type: 'annotation:create', localId: m.localId, data });
    this.startScreenshot(m, data.viewportRect);
    this.update();
  }

  private elementsUnderPath(m: Mark, b: Box): Element[] {
    const pts = m.path ?? [];
    // Un contenitore senza testo proprio (div di layout, main...) è solo lo sfondo del tratto.
    const isContainer = (el: Element) =>
      el.childElementCount > 0 && !Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
    const weight = new Map<Element, number>();
    let last: [number, number] | null = null;
    for (const [px, py] of pts) {
      if (last && Math.hypot(px - last[0], py - last[1]) < 10) continue;
      last = [px, py];
      let el = this.elementAt(b.x + px, b.y + py);
      if (!el || el === document.body) continue;
      // Un tratto che sottolinea o cerchia qualcosa cade spesso nello spazio tra gli elementi:
      // sopra un contenitore cerchiamo poco sopra e poco sotto un elemento più preciso.
      if (isContainer(el)) {
        for (const dy of [-8, 8, -16, 16]) {
          const near = this.elementAt(b.x + px, b.y + py + dy);
          if (near && near !== el && el.contains(near)) {
            el = near;
            break;
          }
        }
      }
      weight.set(el, (weight.get(el) ?? 0) + (isContainer(el) ? 0.25 : 1));
    }
    // Prima gli elementi toccati più spesso; un elemento dentro (o attorno a) uno già scelto
    // non aggiunge nulla: sottolineando un paragrafo resta il paragrafo, non i suoi link.
    const chosen: Element[] = [];
    for (const [el] of [...weight].sort((x, y) => y[1] - x[1])) {
      if (chosen.some((c) => c.contains(el) || el.contains(c))) continue;
      chosen.push(el);
      if (chosen.length >= 10) break;
    }
    return chosen;
  }

  private capture(m: Mark): AnnotationCapture {
    const b = this.boxOf(m) ?? { x: 0, y: 0, width: m.w, height: m.h };
    const viewportRect: Rect = { x: round(b.x), y: round(b.y), width: round(b.width), height: round(b.height) };
    const rect: Rect = { x: round(b.x + scrollX), y: round(b.y + scrollY), width: viewportRect.width, height: viewportRect.height };
    let primary: Element | null = null;
    let contains: ElementSummary[] | undefined;
    let container: ElementSummary | null | undefined;
    let heading: string | null | undefined;
    if (m.kind === 'element') {
      primary = m.target;
    } else {
      const els = m.kind === 'area' ? elementsInRect(b) : this.elementsUnderPath(m, b);
      contains = els.map(summary);
      primary = els.length === 1 ? els[0] : commonAncestor(els);
      if (!primary && m.kind === 'area') primary = this.elementAt(b.x + b.width / 2, b.y + b.height / 2);
      if (primary === document.body || primary === document.documentElement) primary = null;
      // Dove si trova la zona: il contenitore più piccolo e il titolo più vicino sopra di essa
      const box = containerOf(b, (x, y) => this.elementAt(x, y));
      container = box ? summary(box) : null;
      heading = headingAbove(b);
    }
    const info = primary ? reactInfo(primary) : { components: [], source: null };
    return {
      kind: m.kind,
      comment: '',
      url: m.url,
      title: document.title.slice(0, 200),
      viewport: { width: innerWidth, height: innerHeight, scrollX: round(scrollX), scrollY: round(scrollY), dpr: devicePixelRatio || 1 },
      selector: primary ? (m.kind === 'element' ? m.selector : stableSelector(primary)) : null,
      label: primary ? describe(primary) : null,
      html: primary ? reducedHtml(primary) : null,
      text: primary ? visibleText(primary) || null : null,
      styles: primary ? pickStyles(primary) : null,
      rect,
      viewportRect,
      contains,
      ...(m.kind === 'element' ? {} : { container, heading }),
      source: info.source,
      components: info.components,
      path: m.kind === 'drawing' ? m.path : undefined,
      anchor: { selector: m.kind === 'element' ? m.selector : m.anchorSelector, offsetX: round(m.offX), offsetY: round(m.offY) },
    };
  }

  /**
   * Cattura fatta dal motore del browser (modalità desktop): fedele anche per canvas, video e
   * immagini di altri domini. I segni dell'overlay spariscono per un istante, così l'immagine
   * contiene solo l'app; il numero e il contorno vengono ridisegnati sopra da finalizeShot.
   * Lo scudo resta attivo: un'annotazione cominciata nel frattempo non va persa.
   */
  private async nativeShot(m: Mark, zone: Box): Promise<BaseShot> {
    const x0 = Math.max(0, zone.x - SHOT_MARGIN);
    const y0 = Math.max(0, zone.y - SHOT_MARGIN);
    const x1 = Math.min(innerWidth, zone.x + zone.width + SHOT_MARGIN);
    const y1 = Math.min(innerHeight, zone.y + zone.height + SHOT_MARGIN);
    if (x1 - x0 < 2 || y1 - y0 < 2) throw new Error('zona fuori dalla pagina');
    const area: Box = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    this.hiddenForCapture++;
    this.root.classList.add('capturing');
    try {
      await frame();
      await frame();
      const result = await new Promise<{ data: string | null; error?: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.captures.delete(m.localId);
          reject(new Error(t('shot.slow')));
        }, 11000);
        this.captures.set(m.localId, (msg) => {
          clearTimeout(timer);
          this.captures.delete(m.localId);
          resolve(msg);
        });
        if (!this.post({ type: 'capture:request', key: m.localId })) {
          clearTimeout(timer);
          this.captures.delete(m.localId);
          reject(new Error(t('shot.unreachable')));
        }
      });
      if (!result.data) throw new Error(result.error || t('shot.failed'));
      return await baseFromViewport(result.data, area);
    } finally {
      if (--this.hiddenForCapture <= 0) {
        this.hiddenForCapture = 0;
        this.root.classList.remove('capturing');
      }
    }
  }

  private startScreenshot(m: Mark, box: Box): void {
    // I segni dell'overlay stanno fuori dal body: html-to-image cattura solo l'app.
    const viaDom = () => captureBase(box, this.host, (x, y) => this.elementAt(x, y));
    const shot = this.transport.nativeCapture ? this.nativeShot(m, box).catch(viaDom) : viaDom();
    shot
      .then((base) => {
        m.shot = { base, box };
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        m.shot = { error: /tainted|insecure|security/i.test(msg) ? t('shot.protected') : msg.slice(0, 120) };
      })
      .finally(() => this.flushShot(m));
  }

  private flushShot(m: Mark): void {
    if (m.id === null || !m.shot || m.shotPosted) return;
    m.shotPosted = true;
    const { base, box, error } = m.shot;
    if (base && box) {
      try {
        const png = finalizeShot(base, { kind: m.kind, box, path: m.path, id: m.id });
        this.post({ type: 'annotation:screenshot', id: m.id, screenshot: png });
      } catch (err) {
        this.post({ type: 'annotation:screenshot', id: m.id, screenshot: null, error: (err as Error).message.slice(0, 120) });
      }
    } else {
      this.post({ type: 'annotation:screenshot', id: m.id, screenshot: null, error: error ?? t('shot.failed') });
    }
    m.shot = undefined;
  }

  // -------------------------------------------------------------------------
  // Sincronizzazione con l'elenco della pagina Studio
  // -------------------------------------------------------------------------
  private syncMarks(views: AnnotationView[]): void {
    if (!Array.isArray(views)) return;
    const ids = new Set(views.map((v) => v.id));
    for (const m of [...this.marks]) {
      if (m.id !== null && !ids.has(m.id) && m.status !== 'sent') this.destroyMark(m);
    }
    for (const v of views) {
      if (!v || typeof v.id !== 'number' || !v.anchor || !v.rect) continue;
      let m = this.marks.find((x) => x.id === v.id);
      if (!m) {
        m = this.markFromView(v);
        this.marks.push(m);
      }
      m.comment = String(v.comment ?? '');
      m.status = v.status === 'sending' ? 'sending' : v.status === 'error' ? 'error' : v.status === 'sent' ? 'sent' : 'pending';
      this.refreshBadge(m);
    }
    this.update();
  }

  private markFromView(v: AnnotationView): Mark {
    const isElement = v.kind === 'element';
    return this.newMark(v.kind, {
      id: v.id,
      url: v.url,
      comment: v.comment,
      status: 'pending',
      selector: isElement ? v.selector : null,
      target: isElement ? query(v.selector) : null,
      anchorSelector: isElement ? null : v.anchor.selector,
      anchor: isElement ? null : query(v.anchor.selector),
      offX: v.anchor.offsetX,
      offY: v.anchor.offsetY,
      w: v.rect.width,
      h: v.rect.height,
      docRect: v.rect,
      path: v.path,
      shotPosted: true,
    });
  }

  private destroyMark(m: Mark): void {
    m.el.remove();
    m.badge.remove();
    this.marks = this.marks.filter((x) => x !== m);
    this.drafts.delete(m.localId);
  }

  private refreshBadge(m: Mark): void {
    m.badge.className = `badge ${m.kind} ${m.status}`;
    m.badge.textContent = m.status === 'sent' ? '✓' : m.id !== null ? String(m.id) : m.status === 'draft' ? '+' : '…';
    m.badge.title = m.comment ? `${m.id ?? ''} ${m.comment}`.trim() : t(`kind.${m.kind}`);
  }

  /** La pagina Studio ha indicato un'altra lingua: si aggiornano i testi già disegnati. */
  private applyLocale(): void {
    this.pillClose.title = t('pill.close');
    if (this.mode !== 'navigate') this.pillText.replaceChildren(...pillContent(this.mode));
    for (const m of this.marks) this.refreshBadge(m);
    for (const m of this.drafts.values()) this.refreshBadge(m);
  }

  private focusMark(m: Mark): void {
    const target = m.kind === 'element' ? m.target : m.anchor;
    if (target?.isConnected) target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    else window.scrollTo({ top: Math.max(0, m.docRect.y - innerHeight / 3), behavior: 'smooth' });
    m.el.classList.remove('flash');
    void m.el.offsetWidth;
    m.el.classList.add('flash');
    setTimeout(() => this.schedule(), 400);
  }

  // -------------------------------------------------------------------------
  // Posizionamento (scroll, resize, HMR)
  // -------------------------------------------------------------------------
  private boxOf(m: Mark): Box | null {
    if (m.kind === 'element') {
      if (!m.target || !m.target.isConnected) m.target = query(m.selector);
      if (m.target) {
        const r = m.target.getBoundingClientRect();
        m.w = r.width;
        m.h = r.height;
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      }
    } else {
      if (!m.anchor || !m.anchor.isConnected) m.anchor = query(m.anchorSelector);
      if (m.anchor) {
        const r = m.anchor.getBoundingClientRect();
        return { x: r.left + m.offX, y: r.top + m.offY, width: m.w, height: m.h };
      }
    }
    return { x: m.docRect.x - scrollX, y: m.docRect.y - scrollY, width: m.docRect.width, height: m.docRect.height };
  }

  private schedule(): void {
    if (this.rafQueued) return;
    this.rafQueued = true;
    requestAnimationFrame(() => {
      this.rafQueued = false;
      this.update();
    });
  }

  private update(): void {
    const url = currentUrl();
    for (const m of this.marks) this.renderMark(m, url);
    for (const m of this.drafts.values()) {
      this.renderMark(m, url);
      // La casella del commento (nella pagina Studio) segue la bozza durante lo scroll
      const info = this.draftInfo(m);
      const key = JSON.stringify(info.rect);
      if (key !== m.sentRect) {
        m.sentRect = key;
        this.post({ type: 'draft:update', ...info });
      }
    }
    if (this.mode === 'select' && this.hoverEl) this.renderHover();
  }

  private renderMark(m: Mark, url: string): void {
    const b = samePage(m.url, url) ? this.boxOf(m) : null;
    const visible = Boolean(b);
    m.el.style.display = visible ? '' : 'none';
    m.badge.style.display = visible ? '' : 'none';
    if (!b) return;
    const s = m.el.style;
    s.left = `${b.x}px`;
    s.top = `${b.y}px`;
    s.width = `${b.width}px`;
    s.height = `${b.height}px`;
    let bx = b.x;
    let by = b.y;
    if (m.kind === 'drawing' && m.path && m.svg && m.svgLine) {
      m.svg.setAttribute('width', String(Math.max(1, b.width + 4)));
      m.svg.setAttribute('height', String(Math.max(1, b.height + 4)));
      m.svgLine.setAttribute('points', m.path.map(([x, y]) => `${x},${y}`).join(' '));
      const last = m.path[m.path.length - 1];
      bx = b.x + last[0];
      by = b.y + last[1];
    }
    m.badge.style.left = `${Math.max(12, Math.min(innerWidth - 12, bx))}px`;
    m.badge.style.top = `${Math.max(12, Math.min(innerHeight - 12, by))}px`;
  }
}
