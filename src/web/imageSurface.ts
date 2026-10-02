import type {
  AnnotationCapture,
  AnnotationContext,
  AnnotationData,
  AnnotationKind,
  AnnotationView,
  AppView,
  NativeElement,
  NativeSummary,
  PageToOverlay,
  Rect,
  StudioConfig,
  ToolMode,
} from '../shared/protocol';
import type { AppChannel, AppFrame } from './appChannel';
import { DesktopChrome } from './desktopChrome';
import type { Surface, SurfaceHost } from './surface';
import { t } from './i18n';
import { $, toast } from './ui';

type MarkStatus = 'draft' | 'pending' | 'sending' | 'sent' | 'error';

/** Fermo immagine della finestra: la base su cui sono state fatte una o più annotazioni. */
interface Still {
  key: string;
  canvas: HTMLCanvasElement;
  /** Dimensione della finestra in pixel (quella dell'immagine). */
  width: number;
  height: number;
}

interface Mark {
  localId: string;
  id: number | null;
  kind: AnnotationKind;
  status: MarkStatus;
  comment: string;
  /** Zona nella finestra, in pixel dell'immagine. */
  rect: Rect;
  /** Punti del tratto relativi a rect.x / rect.y (solo disegni). */
  path?: Array<[number, number]>;
  native: NativeElement | null;
  /** Zone: controlli che contiene (UI Automation), per l'elenco "Contiene" nel messaggio. */
  contains?: NativeSummary[];
  still: string;
  el: HTMLDivElement;
  badge: HTMLDivElement;
  line?: SVGPolylineElement;
  svg?: SVGSVGElement;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const BRAND = '#b12584';
const RED = '#e5484d';
/** Margine attorno alla zona nello screenshot dell'annotazione, in pixel della finestra. */
const SHOT_MARGIN = 70;
const MAX_CONTEXT_SIDE = 1600;
const round = (n: number) => Math.round(n * 10) / 10;

function div(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

/** Etichetta di un elemento dell'interfaccia nativa: tipo e nome (es. "Button «Salva»"). */
export function nativeLabel(n: NativeElement): string {
  return n.name ? `${n.role} «${n.name.slice(0, 40)}»` : n.role;
}

/** Disegna contorno (o tratto) e numero di un'annotazione su un'immagine della finestra. */
function drawMark(
  ctx: CanvasRenderingContext2D,
  mark: { kind: AnnotationKind; rect: Rect; path?: Array<[number, number]>; id: number | null },
  origin: { x: number; y: number },
  k: number,
): void {
  const x = (mark.rect.x - origin.x) * k;
  const y = (mark.rect.y - origin.y) * k;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  let bx = x;
  let by = y;
  if (mark.kind === 'drawing' && mark.path && mark.path.length > 1) {
    ctx.strokeStyle = RED;
    ctx.lineWidth = 3;
    ctx.beginPath();
    mark.path.forEach(([px, py], i) => (i ? ctx.lineTo(x + px * k, y + py * k) : ctx.moveTo(x + px * k, y + py * k)));
    ctx.stroke();
    const last = mark.path[mark.path.length - 1];
    bx = x + last[0] * k;
    by = y + last[1] * k;
  } else {
    ctx.strokeStyle = BRAND;
    ctx.lineWidth = 2;
    if (mark.kind === 'area') ctx.setLineDash([6, 4]);
    ctx.strokeRect(x - 1, y - 1, mark.rect.width * k + 2, mark.rect.height * k + 2);
    ctx.setLineDash([]);
  }
  if (mark.id !== null) {
    const label = String(mark.id);
    ctx.font = '700 12px system-ui, -apple-system, "Segoe UI", sans-serif';
    const w = Math.max(22, ctx.measureText(label).width + 12);
    ctx.fillStyle = mark.kind === 'drawing' ? RED : BRAND;
    ctx.beginPath();
    ctx.roundRect(bx - w / 2, by - 11, w, 22, 11);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx, by + 0.5);
  }
  ctx.restore();
}

/**
 * Finestra nativa: Studio ne mostra l'immagine (catturata dal companion, oppure condivisa dal
 * browser se il sistema non permette la cattura). Qui non c'è una pagina in cui iniettare
 * l'overlay: riquadri, disegni ed elementi si scelgono direttamente sull'immagine, in questa
 * pagina, e arrivano al resto di Studio con gli stessi messaggi dell'overlay delle app web.
 *
 * L'immagine è dal vivo finché non si comincia ad annotare: al primo gesto si ferma (fermo
 * immagine a piena risoluzione), così le zone segnate corrispondono a ciò che l'utente vede,
 * e torna dal vivo quando le annotazioni fatte su di essa sono state inviate o tolte.
 */
export class ImageSurface implements Surface {
  ready = false;
  private readonly chrome: DesktopChrome;
  private view: AppView | null = null;
  private mode: ToolMode = 'navigate';
  private lastSeq = 0;
  /** Ultimo fotogramma dal vivo arrivato mentre l'immagine era ferma. */
  private heldLive: { bitmap: ImageBitmap; width: number; height: number } | null = null;
  private frozen: Still | null = null;
  private readonly stills = new Map<string, Still>();
  private stillCounter = 0;
  private marks: Mark[] = [];
  private readonly drafts = new Map<string, Mark>();
  private counter = 0;
  private drag: { kind: 'select' | 'area' | 'draw'; x0: number; y0: number; points: Array<[number, number]> } | null = null;
  private hover: NativeElement | null = null;
  private hoverReq = 0;
  private hoverTimer: number | null = null;
  /** Ricerca dell'elemento in corso, e ultimo punto arrivato nel frattempo. */
  private hoverBusy = false;
  private hoverNext: { x: number; y: number } | null = null;
  private share: { stream: MediaStream; video: HTMLVideoElement; timer: number; label: string } | null = null;
  private hintAt = 0;

  private readonly layer: HTMLElement;
  private readonly hoverBox = div('im-hover');
  private readonly hoverLabel = div('im-hover-label');
  private readonly draftRect = div('im-draft');
  private readonly drawLine: SVGPolylineElement;
  private readonly frozenChip = $('app-frozen');

  constructor(
    config: StudioConfig,
    private readonly host: SurfaceHost,
    private readonly channel: AppChannel,
  ) {
    this.chrome = new DesktopChrome('window', channel, config.devServer.managed);
    this.layer = this.chrome.marks;
    this.hoverBox.hidden = this.hoverLabel.hidden = this.draftRect.hidden = true;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'im-draw');
    this.drawLine = document.createElementNS(SVG_NS, 'polyline');
    svg.appendChild(this.drawLine);
    this.layer.append(this.hoverBox, this.hoverLabel, this.draftRect, svg);

    this.chrome.onLayout = () => this.renderMarks();
    this.chrome.onShare = () => void this.startShare();
    channel.onView = (view) => this.onView(view);
    channel.onFrame = (frame) => this.onFrame(frame);
    channel.onOpen = () => this.chrome.sendViewport();
    new ResizeObserver(() => this.chrome.sendViewport()).observe($('stage'));
    document.addEventListener('visibilitychange', () => channel.send({ type: 'live', on: !document.hidden }));
    this.chrome.sendViewport();

    this.layer.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.layer.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.layer.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.layer.addEventListener('pointercancel', () => {
      this.cancelDrag();
      // Il gesto annullato aveva fermato l'immagine: senza annotazioni si torna dal vivo
      this.releaseIfDone();
    });
    this.layer.addEventListener('pointerleave', () => {
      if (!this.drag) this.setHover(null);
    });
    this.layer.addEventListener('contextmenu', (e) => e.preventDefault());
    this.frozenChip.addEventListener('click', () => this.unfreeze());
    // In Naviga la finestra si usa nell'app vera: qui è solo un'immagine
    this.chrome.canvas.addEventListener('click', () => {
      if (this.mode !== 'navigate' || !this.ready || Date.now() - this.hintAt < 6000) return;
      this.hintAt = Date.now();
      toast(t('image.hint'));
    });
  }

  // -------------------------------------------------------------------------
  // Immagine della finestra: dal vivo, ferma, condivisa dal browser
  // -------------------------------------------------------------------------
  private setReady(ready: boolean): void {
    if (this.ready === ready) return;
    this.ready = ready;
    this.host.onSurfaceReady();
  }

  private onView(view: AppView): void {
    const previous = this.view;
    this.view = view;
    this.chrome.render(view, this.share ? { sharing: true, title: this.share.label } : {});
    if (this.share || this.frozen) return;
    if (view.state !== 'live') {
      if (view.state === 'waiting') {
        this.lastSeq = 0;
        this.chrome.clear();
      }
      this.setReady(false);
    }
    if (previous?.current !== view.current) this.lastSeq = 0;
  }

  private onFrame(frame: AppFrame): void {
    const { meta, bitmap } = frame;
    if (this.share || meta.seq < this.lastSeq) {
      bitmap.close();
      return;
    }
    this.lastSeq = meta.seq;
    if (this.frozen) {
      this.heldLive?.bitmap.close();
      this.heldLive = { bitmap, width: meta.width, height: meta.height };
      return;
    }
    this.chrome.draw(bitmap, bitmap.width, bitmap.height, meta.width, meta.height);
    bitmap.close();
    this.setReady(true);
  }

  private setFrozen(still: Still | null): void {
    this.frozen = still;
    this.frozenChip.hidden = still === null;
    if (still) this.chrome.draw(still.canvas, still.width, still.height, still.width, still.height);
  }

  /**
   * Ferma l'immagine al primo gesto di annotazione. Subito con ciò che è sullo schermo, così
   * il gesto non aspetta; intanto si chiede al companion la cattura a piena risoluzione, che
   * prende il suo posto appena arriva (serve allo screenshot inviato a Claude).
   */
  private freeze(): Still | null {
    if (this.frozen) return this.frozen;
    const size = this.chrome.size;
    if (!size.width || !size.height) return null;
    const share = this.share;
    const source: CanvasImageSource = share ? share.video : this.chrome.canvas;
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    canvas.getContext('2d')?.drawImage(source, 0, 0, size.width, size.height);
    const still: Still = { key: `f${Date.now().toString(36)}${(this.stillCounter++).toString(36)}`, canvas, width: size.width, height: size.height };
    this.stills.set(still.key, still);
    this.setFrozen(still);
    if (!share) {
      void this.channel.still().then((result) => {
        if (typeof result === 'string') return; // resta l'immagine dell'anteprima
        const { bitmap } = result;
        // Stessa finestra, stessa dimensione: i pixel nitidi sostituiscono quelli dell'anteprima
        if (bitmap.width === still.width && bitmap.height === still.height) {
          still.canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
          if (this.frozen === still) this.chrome.draw(still.canvas, still.width, still.height, still.width, still.height);
        }
        bitmap.close();
      });
    }
    return still;
  }

  /** Torna all'immagine dal vivo. Le annotazioni non inviate restano nell'elenco, con la loro immagine. */
  private unfreeze(): void {
    if (!this.frozen) return;
    for (const m of [...this.drafts.values()]) {
      this.destroyMark(m, false);
      this.host.onSurfaceMessage({ type: 'draft:closed', localId: m.localId });
    }
    this.setFrozen(null);
    this.pruneStills();
    const held = this.heldLive;
    this.heldLive = null;
    if (this.share) {
      // Il prossimo fotogramma della condivisione arriva da solo; quello tenuto da parte non serve
      held?.bitmap.close();
    } else if (held) {
      this.chrome.draw(held.bitmap, held.bitmap.width, held.bitmap.height, held.width, held.height);
      held.bitmap.close();
    } else if (this.view?.state !== 'live') {
      this.chrome.clear();
      this.setReady(false);
    }
    this.chrome.sendViewport();
    this.renderMarks();
  }

  /** I fermi immagine restano finché un'annotazione non inviata vi fa riferimento. */
  private pruneStills(): void {
    const used = new Set<string>([...this.marks, ...this.drafts.values()].filter((m) => m.status !== 'sent').map((m) => m.still));
    if (this.frozen) used.add(this.frozen.key);
    for (const key of [...this.stills.keys()]) if (!used.has(key)) this.stills.delete(key);
  }

  /** Quando sull'immagine ferma non resta nulla da inviare, si torna dal vivo. */
  private releaseIfDone(): void {
    const still = this.frozen;
    if (!still || this.drag) return;
    const busy = [...this.marks, ...this.drafts.values()].some((m) => m.still === still.key && m.status !== 'sent');
    if (!busy) this.unfreeze();
    else this.pruneStills();
  }

  /** Senza cattura dal sistema (Wayland, permessi mancanti): la finestra si condivide dal browser. */
  private async startShare(): Promise<void> {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      toast(t('image.shareUnsupported'), 'error');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'window' } as MediaTrackConstraints, audio: false });
    } catch {
      return; // l'utente ha annullato
    }
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      toast(t('image.shareFailed'), 'error');
      return;
    }
    const track = stream.getVideoTracks()[0];
    const timer = window.setInterval(() => {
      if (this.frozen || !video.videoWidth) return;
      this.chrome.draw(video, video.videoWidth, video.videoHeight, video.videoWidth, video.videoHeight);
      this.setReady(true);
    }, 200);
    this.share = { stream, video, timer, label: track?.label || t('image.sharedWindow') };
    track?.addEventListener('ended', () => this.stopShare());
    if (this.view) this.chrome.render(this.view, { sharing: true, title: this.share.label });
  }

  private stopShare(): void {
    const share = this.share;
    if (!share) return;
    this.share = null;
    clearInterval(share.timer);
    share.stream.getTracks().forEach((t) => t.stop());
    if (!this.frozen) {
      this.chrome.clear();
      this.setReady(false);
    }
    if (this.view) this.chrome.render(this.view);
    toast(t('image.shareEnded'));
  }

  // -------------------------------------------------------------------------
  // Messaggi dalla pagina Studio (gli stessi che riceve l'overlay delle app web)
  // -------------------------------------------------------------------------
  post(msg: PageToOverlay): void {
    switch (msg.type) {
      case 'hello':
        this.setMode(msg.mode);
        this.syncMarks(msg.annotations);
        break;
      case 'mode':
        this.setMode(msg.mode);
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
      case 'annotation:assigned': {
        const m = this.marks.find((x) => x.localId === msg.localId);
        if (m) {
          m.id = msg.id;
          this.refreshBadge(m);
          this.postScreenshot(m);
        }
        break;
      }
      case 'annotation:update': {
        const m = this.marks.find((x) => x.id === msg.id);
        if (m) {
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
        for (const id of msg.ids) {
          const m = this.marks.find((x) => x.id === id);
          if (!m) continue;
          if (msg.status === 'sent') {
            m.status = 'sent';
            m.el.classList.add('sent');
            this.refreshBadge(m);
            setTimeout(() => this.destroyMark(m), 1600);
          } else {
            m.status = msg.status === 'error' ? 'error' : msg.status === 'sending' ? 'sending' : 'pending';
            this.refreshBadge(m);
          }
        }
        break;
      case 'annotation:focus': {
        const m = this.marks.find((x) => x.id === msg.id);
        if (!m) break;
        // L'annotazione può essere stata fatta su un'altra immagine: si torna a quella
        const still = this.stills.get(m.still);
        if (still && this.frozen !== still && !this.drafts.size) {
          this.setFrozen(still);
          this.renderMarks();
        }
        m.el.classList.remove('flash');
        void m.el.offsetWidth;
        m.el.classList.add('flash');
        break;
      }
      default:
        break;
    }
  }

  /** L'elenco della pagina Studio comanda: i segni di annotazioni che non esistono più spariscono. */
  private syncMarks(views: AnnotationView[]): void {
    const ids = new Set(views.map((v) => v.id));
    for (const m of [...this.marks]) if (m.id !== null && !ids.has(m.id) && m.status !== 'sent') this.destroyMark(m);
    for (const v of views) {
      const m = this.marks.find((x) => x.id === v.id);
      if (!m) continue;
      m.comment = v.comment;
      m.status = v.status === 'sending' ? 'sending' : v.status === 'error' ? 'error' : v.status === 'sent' ? 'sent' : 'pending';
      this.refreshBadge(m);
    }
  }

  nav(action: 'back' | 'forward' | 'reload'): void {
    if (action !== 'reload') return;
    if (this.frozen) this.unfreeze();
    else this.chrome.sendViewport();
  }

  navigate(): void {
    /* una finestra nativa non ha indirizzi */
  }

  locate(rect: Rect): Rect {
    return this.chrome.locate(rect);
  }

  unavailable(mode: ToolMode): string | null {
    if (mode === 'navigate') return null;
    if (!this.ready) return t('image.notVisible');
    if (mode === 'select' && (this.share || !this.view?.elements)) {
      return this.share ? t('image.noElementsShare') : t('image.noElements');
    }
    return null;
  }

  idle(): void {
    // L'app può essere cambiata (o riavviata): senza annotazioni in corso si torna dal vivo
    this.releaseIfDone();
  }

  // -------------------------------------------------------------------------
  // Strumenti
  // -------------------------------------------------------------------------
  private setMode(mode: ToolMode): void {
    if (!['navigate', 'select', 'area', 'draw'].includes(mode)) return;
    const dragging = this.drag !== null;
    this.cancelDrag();
    this.setHover(null);
    this.mode = mode;
    this.layer.dataset.mode = mode;
    if (dragging) this.releaseIfDone();
  }

  private point(e: PointerEvent): { x: number; y: number } {
    const p = this.chrome.point(e);
    const size = this.chrome.size;
    return { x: Math.max(0, Math.min(size.width, p.x)), y: Math.max(0, Math.min(size.height, p.y)) };
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || this.mode === 'navigate' || !this.ready) return;
    if ((e.target as HTMLElement).classList.contains('im-badge')) return;
    e.preventDefault();
    if (!this.freeze()) return;
    this.layer.setPointerCapture(e.pointerId);
    const p = this.point(e);
    this.drag = { kind: this.mode === 'area' ? 'area' : this.mode === 'draw' ? 'draw' : 'select', x0: p.x, y0: p.y, points: [[p.x, p.y]] };
    if (this.drag.kind === 'area') {
      this.draftRect.hidden = false;
      this.placeDraftRect(p.x, p.y);
    } else if (this.drag.kind === 'draw') {
      this.drawLine.setAttribute('points', this.toScreenPoints(this.drag.points));
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.mode === 'navigate' || !this.ready) return;
    const p = this.point(e);
    if (this.drag?.kind === 'area') return this.placeDraftRect(p.x, p.y);
    if (this.drag?.kind === 'draw') {
      const pts = this.drag.points;
      const [lx, ly] = pts[pts.length - 1];
      if (Math.hypot(p.x - lx, p.y - ly) * this.chrome.scale >= 2) {
        pts.push([p.x, p.y]);
        this.drawLine.setAttribute('points', this.toScreenPoints(pts));
      }
      return;
    }
    if (this.mode === 'select' && !this.drag) this.queueHover(p.x, p.y);
  }

  private onPointerUp(e: PointerEvent): void {
    const drag = this.drag;
    this.drag = null;
    try {
      this.layer.releasePointerCapture(e.pointerId);
    } catch {
      /* già rilasciato */
    }
    if (!drag || !this.frozen) return;
    const p = this.point(e);
    const k = this.chrome.scale || 1;
    if (drag.kind === 'select') {
      void this.pickElement(p.x, p.y);
      return;
    }
    if (drag.kind === 'area') {
      this.draftRect.hidden = true;
      const rect: Rect = { x: Math.min(drag.x0, p.x), y: Math.min(drag.y0, p.y), width: Math.abs(p.x - drag.x0), height: Math.abs(p.y - drag.y0) };
      // Almeno 8 px sullo schermo: un clic senza trascinare non crea una zona
      if (rect.width * k >= 8 && rect.height * k >= 8) this.startDraft('area', rect);
      else this.releaseIfDone();
      return;
    }
    this.drawLine.setAttribute('points', '');
    const pts = drag.points;
    let length = 0;
    for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (pts.length < 2 || length * k < 8) return this.releaseIfDone();
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const rect: Rect = { x, y, width: Math.max(1, Math.max(...xs) - x), height: Math.max(1, Math.max(...ys) - y) };
    this.startDraft(
      'drawing',
      rect,
      pts.map(([px, py]) => [round(px - x), round(py - y)] as [number, number]),
    );
  }

  private cancelDrag(): void {
    this.drag = null;
    this.draftRect.hidden = true;
    this.drawLine.setAttribute('points', '');
  }

  private toScreenPoints(points: Array<[number, number]>): string {
    const k = this.chrome.scale;
    return points.map(([x, y]) => `${round(x * k)},${round(y * k)}`).join(' ');
  }

  private placeDraftRect(x: number, y: number): void {
    if (!this.drag) return;
    const k = this.chrome.scale;
    const s = this.draftRect.style;
    s.left = `${Math.min(this.drag.x0, x) * k}px`;
    s.top = `${Math.min(this.drag.y0, y) * k}px`;
    s.width = `${Math.abs(x - this.drag.x0) * k}px`;
    s.height = `${Math.abs(y - this.drag.y0) * k}px`;
  }

  // -------------------------------------------------------------------------
  // Elementi dell'interfaccia nativa (strumento Elemento)
  // -------------------------------------------------------------------------
  private clip(rect: Rect): Rect {
    const size = this.chrome.size;
    const x = Math.max(0, rect.x);
    const y = Math.max(0, rect.y);
    return { x, y, width: Math.max(1, Math.min(size.width, rect.x + rect.width) - x), height: Math.max(1, Math.min(size.height, rect.y + rect.height) - y) };
  }

  /**
   * Una ricerca alla volta: chi risponde (l'aiutante di cattura) fa una cosa per volta, e una
   * coda di ricerche farebbe aspettare anche anteprime e fermi immagine. Mentre una è in corso
   * si ricorda solo l'ultimo punto, cercato appena quella finisce.
   */
  private queueHover(x: number, y: number): void {
    this.hoverNext = { x, y };
    if (this.hoverBusy || this.hoverTimer !== null) return;
    this.hoverTimer = window.setTimeout(() => {
      this.hoverTimer = null;
      const point = this.hoverNext;
      this.hoverNext = null;
      if (!point || this.mode !== 'select') return;
      this.hoverBusy = true;
      const req = ++this.hoverReq;
      void this.channel.elementAt(point.x, point.y).then((el) => {
        this.hoverBusy = false;
        if (req === this.hoverReq && this.mode === 'select' && !this.drag) this.setHover(el);
        if (this.hoverNext && this.mode === 'select') this.queueHover(this.hoverNext.x, this.hoverNext.y);
      });
    }, 90);
  }

  private setHover(el: NativeElement | null): void {
    this.hover = el && el.rect.width > 0 && el.rect.height > 0 ? el : null;
    if (!this.hover) {
      this.hoverReq++;
      this.hoverNext = null;
    }
    this.renderHover();
  }

  private renderHover(): void {
    const el = this.hover;
    if (!el || this.mode !== 'select') {
      this.hoverBox.hidden = this.hoverLabel.hidden = true;
      return;
    }
    const k = this.chrome.scale;
    const r = this.clip(el.rect);
    const b = this.hoverBox.style;
    b.left = `${r.x * k}px`;
    b.top = `${r.y * k}px`;
    b.width = `${r.width * k}px`;
    b.height = `${r.height * k}px`;
    this.hoverBox.hidden = false;
    this.hoverLabel.textContent = `${nativeLabel(el)}  ${Math.round(r.width)}×${Math.round(r.height)}`;
    this.hoverLabel.hidden = false;
    const top = r.y * k > 26 ? r.y * k - 24 : (r.y + r.height) * k + 4;
    this.hoverLabel.style.left = `${Math.max(4, r.x * k)}px`;
    this.hoverLabel.style.top = `${top}px`;
  }

  private async pickElement(x: number, y: number): Promise<void> {
    const el = this.hover ?? (await this.channel.elementAt(x, y));
    if (this.mode !== 'select' || !this.frozen) return;
    if (!el || el.rect.width <= 0 || el.rect.height <= 0) {
      toast(t('image.noElementHere'));
      this.releaseIfDone();
      return;
    }
    this.setHover(null);
    this.startDraft('element', this.clip(el.rect), undefined, el);
  }

  // -------------------------------------------------------------------------
  // Bozze e annotazioni
  // -------------------------------------------------------------------------
  private startDraft(kind: AnnotationKind, rect: Rect, path?: Array<[number, number]>, native: NativeElement | null = null): void {
    const still = this.frozen;
    if (!still) return;
    const el = div(`im-mark ${kind}`);
    el.appendChild(div('box'));
    const badge = div(`im-badge ${kind} draft`);
    badge.textContent = '+';
    const mark: Mark = {
      localId: `w${Date.now().toString(36)}${(this.counter++).toString(36)}`,
      id: null,
      kind,
      status: 'draft',
      comment: '',
      rect: { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) },
      path,
      native,
      still: still.key,
      el,
      badge,
    };
    if (kind === 'drawing') {
      const svg = document.createElementNS(SVG_NS, 'svg');
      const line = document.createElementNS(SVG_NS, 'polyline');
      svg.appendChild(line);
      el.appendChild(svg);
      mark.svg = svg;
      mark.line = line;
    }
    badge.addEventListener('pointerdown', (e) => e.stopPropagation());
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      if (mark.id !== null && mark.status !== 'sent' && mark.status !== 'sending')
        this.host.onSurfaceMessage({ type: 'annotation:edit', id: mark.id, rect: mark.rect });
    });
    this.layer.append(el, badge);
    this.drafts.set(mark.localId, mark);
    this.renderMarks();
    // Zone e disegni: l'elemento dell'interfaccia al centro aiuta Claude a capire di cosa si parla
    if (!native && this.view?.elements && !this.share) {
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      void this.channel.elementAt(cx, cy).then((found) => {
        if (found && mark.status === 'draft') mark.native = found;
      });
      if (kind === 'area') {
        void this.channel.elementsIn(rect).then((items) => {
          if (items.length && mark.status === 'draft') mark.contains = items;
        });
      }
    }
    this.host.onSurfaceMessage({
      type: 'draft:open',
      localId: mark.localId,
      kind,
      label: this.draftLabel(mark),
      rect: this.anchorRect(mark),
      canAdjust: false,
    });
  }

  private draftLabel(m: Mark): string {
    if (m.kind === 'drawing') return t('draft.freehand');
    const size = `${Math.round(m.rect.width)}×${Math.round(m.rect.height)}`;
    return m.kind === 'element' && m.native ? `${nativeLabel(m.native)}  ${size}` : size;
  }

  /** Dove si apre la casella del commento: accanto alla zona, o alla fine del tratto. */
  private anchorRect(m: Mark): Rect {
    if (m.kind === 'drawing' && m.path?.length) {
      const [px, py] = m.path[m.path.length - 1];
      return { x: m.rect.x + px, y: m.rect.y + py, width: 1, height: 1 };
    }
    return m.rect;
  }

  private commitDraft(m: Mark): void {
    const still = this.stills.get(m.still);
    this.drafts.delete(m.localId);
    if (!still) {
      this.destroyMark(m);
      this.host.onSurfaceMessage({ type: 'draft:closed', localId: m.localId });
      return;
    }
    m.status = 'pending';
    this.marks.push(m);
    this.refreshBadge(m);
    const title = (this.share?.label ?? this.view?.title ?? '').slice(0, 200) || t('image.windowFallback');
    const data: AnnotationCapture = {
      kind: m.kind,
      comment: '',
      url: title,
      title,
      viewport: { width: still.width, height: still.height, scrollX: 0, scrollY: 0, dpr: this.share ? 1 : this.view?.scale || 1 },
      selector: null,
      label: m.native ? nativeLabel(m.native) : null,
      html: null,
      text: m.native?.name || null,
      styles: null,
      rect: m.rect,
      viewportRect: m.rect,
      path: m.kind === 'drawing' ? m.path : undefined,
      anchor: { selector: null, offsetX: m.rect.x, offsetY: m.rect.y },
      surface: 'window',
      native: m.native,
      contains: m.contains?.map((e) => ({ label: e.name ? `${e.role} «${e.name}»` : e.role, selector: e.automationId })),
    };
    this.host.onSurfaceMessage({ type: 'annotation:create', localId: m.localId, data });
    this.renderMarks();
  }

  /** Screenshot dell'annotazione: la zona con un margine, ritagliata dal fermo immagine. */
  private postScreenshot(m: Mark): void {
    if (m.id === null) return;
    const still = this.stills.get(m.still);
    if (!still) {
      this.host.onSurfaceMessage({ type: 'annotation:screenshot', id: m.id, screenshot: null, error: t('shot.noWindowImage') });
      return;
    }
    try {
      const x0 = Math.max(0, Math.floor(m.rect.x - SHOT_MARGIN));
      const y0 = Math.max(0, Math.floor(m.rect.y - SHOT_MARGIN));
      const x1 = Math.min(still.width, Math.ceil(m.rect.x + m.rect.width + SHOT_MARGIN));
      const y1 = Math.min(still.height, Math.ceil(m.rect.y + m.rect.height + SHOT_MARGIN));
      const k = Math.min(1, 2400 / Math.max(x1 - x0, y1 - y0));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round((x1 - x0) * k));
      canvas.height = Math.max(1, Math.round((y1 - y0) * k));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error(t('shot.noCanvas'));
      ctx.drawImage(still.canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, canvas.width, canvas.height);
      drawMark(ctx, m, { x: x0, y: y0 }, k);
      this.host.onSurfaceMessage({ type: 'annotation:screenshot', id: m.id, screenshot: canvas.toDataURL('image/png'), context: m.still });
    } catch (err) {
      this.host.onSurfaceMessage({ type: 'annotation:screenshot', id: m.id, screenshot: null, error: (err as Error).message.slice(0, 120), context: m.still });
    }
  }

  /** La finestra intera con le annotazioni del gruppo: dice a Claude dove cadono. */
  async contextImages(batch: AnnotationData[]): Promise<AnnotationContext[]> {
    const out: AnnotationContext[] = [];
    const keys = [...new Set(batch.map((a) => a.context).filter((k): k is string => typeof k === 'string'))];
    for (const key of keys) {
      const still = this.stills.get(key);
      if (!still) continue;
      const k = Math.min(1, MAX_CONTEXT_SIDE / Math.max(still.width, still.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(still.width * k));
      canvas.height = Math.max(1, Math.round(still.height * k));
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      ctx.drawImage(still.canvas, 0, 0, canvas.width, canvas.height);
      for (const a of batch) if (a.context === key) drawMark(ctx, a, { x: 0, y: 0 }, k);
      out.push({ id: key, image: canvas.toDataURL('image/png') });
    }
    return out;
  }

  private destroyMark(m: Mark, release = true): void {
    m.el.remove();
    m.badge.remove();
    this.marks = this.marks.filter((x) => x !== m);
    this.drafts.delete(m.localId);
    if (release) this.releaseIfDone();
  }

  private refreshBadge(m: Mark): void {
    m.badge.className = `im-badge ${m.kind} ${m.status}`;
    m.badge.textContent = m.status === 'sent' ? '✓' : m.id !== null ? String(m.id) : m.status === 'draft' ? '+' : '…';
    m.badge.title = m.comment ? `${m.id ?? ''} ${m.comment}`.trim() : '';
  }

  private renderMarks(): void {
    const k = this.chrome.scale;
    // I segni appartengono all'immagine su cui sono stati fatti: si vedono solo su quella
    const shown = this.frozen?.key;
    for (const m of [...this.marks, ...this.drafts.values()]) {
      const visible = m.still === shown;
      m.el.style.display = visible ? '' : 'none';
      m.badge.style.display = visible ? '' : 'none';
      if (!visible) continue;
      const s = m.el.style;
      s.left = `${m.rect.x * k}px`;
      s.top = `${m.rect.y * k}px`;
      s.width = `${m.rect.width * k}px`;
      s.height = `${m.rect.height * k}px`;
      let bx = m.rect.x * k;
      let by = m.rect.y * k;
      if (m.kind === 'drawing' && m.path && m.svg && m.line) {
        m.svg.setAttribute('width', String(Math.max(1, m.rect.width * k + 4)));
        m.svg.setAttribute('height', String(Math.max(1, m.rect.height * k + 4)));
        m.line.setAttribute('points', m.path.map(([x, y]) => `${round(x * k)},${round(y * k)}`).join(' '));
        const last = m.path[m.path.length - 1];
        bx = (m.rect.x + last[0]) * k;
        by = (m.rect.y + last[1]) * k;
      }
      m.badge.style.left = `${bx}px`;
      m.badge.style.top = `${by}px`;
    }
    this.renderHover();
  }
}
