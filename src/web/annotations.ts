import type {
  AnchorInfo,
  AnnotationCapture,
  AnnotationData,
  AnnotationKind,
  AnnotationResponse,
  AnnotationStatus,
  AnnotationView,
  ElementSummary,
  NativeElement,
  OverlayToPage,
  Rect,
} from '../shared/protocol';
import type { AppPanel } from './appPanel';
import { CommentBox } from './commentBox';
import type { ConsolePanel } from './console';
import { t } from './i18n';
import { icon } from './icons';
import { prefs } from './prefs';
import { $, escapeHtml, toast } from './ui';

interface StoredAnnotation extends AnnotationData {
  status: AnnotationStatus;
  capturing: boolean;
}

interface OpenDraft {
  localId: string;
  kind: AnnotationKind;
}

interface Committing {
  comment: string;
  sendAfter: boolean;
  timer: number;
}

const kindLabel = (kind: AnnotationKind) => t(`kind.${kind}`);
const KIND_ICON: Record<AnnotationKind, string> = { element: 'target', area: 'area', drawing: 'pen' };
const KINDS: AnnotationKind[] = ['element', 'area', 'drawing'];

const samePage = (a: string, b: string) => a.split('#')[0] === b.split('#')[0];

// ---------------------------------------------------------------------------
// I messaggi dell'overlay arrivano dall'origine dell'app: tipi e lunghezze vanno controllati.
// ---------------------------------------------------------------------------
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const optStr = (v: unknown, max: number) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const isLocalId = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9]{1,40}$/i.test(v);

function cleanRect(v: unknown): Rect {
  const r = (v ?? {}) as Record<string, unknown>;
  return { x: num(r.x), y: num(r.y), width: Math.max(0, num(r.width)), height: Math.max(0, num(r.height)) };
}

function cleanNative(v: unknown): NativeElement | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const role = str(o.role, 60);
  if (!role) return null;
  return {
    role,
    name: str(o.name, 200),
    automationId: str(o.automationId, 120),
    className: str(o.className, 120),
    framework: str(o.framework, 40),
    path: Array.isArray(o.path)
      ? o.path
          .filter((x): x is string => typeof x === 'string')
          .slice(-6)
          .map((x) => x.slice(0, 80))
      : [],
    rect: cleanRect(o.rect),
  };
}

function cleanCapture(v: unknown): AnnotationCapture | null {
  if (!v || typeof v !== 'object') return null;
  const d = v as Record<string, unknown>;
  const kind = KINDS.includes(d.kind as AnnotationKind) ? (d.kind as AnnotationKind) : null;
  if (!kind) return null;
  const vp = (d.viewport ?? {}) as Record<string, unknown>;
  const anchor = (d.anchor ?? {}) as Record<string, unknown>;
  const styles: Record<string, string> = {};
  if (d.styles && typeof d.styles === 'object') {
    for (const [k, val] of Object.entries(d.styles as Record<string, unknown>).slice(0, 40)) {
      if (typeof val === 'string') styles[k.slice(0, 40)] = val.slice(0, 200);
    }
  }
  const summary = (e: unknown): ElementSummary => {
    const o = (e ?? {}) as Record<string, unknown>;
    return { label: str(o.label, 120), selector: str(o.selector, 400), text: optStr(o.text, 120) ?? undefined };
  };
  const contains: ElementSummary[] | undefined = Array.isArray(d.contains) ? d.contains.slice(0, 10).map(summary) : undefined;
  // Zone e disegni: dove si trovano nella pagina (contenitore e titolo più vicino)
  const where =
    kind === 'element'
      ? {}
      : {
          container: d.container && typeof d.container === 'object' ? summary(d.container) : null,
          heading: optStr(d.heading, 120),
        };
  const path = Array.isArray(d.path)
    ? d.path
        .slice(0, 2000)
        .filter((p): p is [number, number] => Array.isArray(p) && p.length === 2)
        .map(([x, y]) => [num(x), num(y)] as [number, number])
    : undefined;
  const anchorInfo: AnchorInfo = { selector: optStr(anchor.selector, 600), offsetX: num(anchor.offsetX), offsetY: num(anchor.offsetY) };
  return {
    kind,
    comment: '',
    url: str(d.url, 2000) || '/',
    title: str(d.title, 300),
    viewport: { width: num(vp.width), height: num(vp.height), scrollX: num(vp.scrollX), scrollY: num(vp.scrollY), dpr: num(vp.dpr, 1) },
    selector: optStr(d.selector, 600),
    label: optStr(d.label, 200),
    html: optStr(d.html, 3000),
    text: optStr(d.text, 400),
    styles: Object.keys(styles).length ? styles : null,
    rect: cleanRect(d.rect),
    viewportRect: cleanRect(d.viewportRect),
    contains,
    ...where,
    source: optStr(d.source, 500),
    components: Array.isArray(d.components)
      ? d.components
          .filter((c): c is string => typeof c === 'string')
          .slice(0, 6)
          .map((c) => c.slice(0, 80))
      : [],
    path: kind === 'drawing' ? path : undefined,
    anchor: anchorInfo,
    native: cleanNative(d.native),
  };
}

/**
 * Elenco delle annotazioni della pagina Studio: numerazione, commenti (scritti qui, mai
 * nell'app), stato e invio al companion, che li incolla nella console di Claude Code.
 */
export class AnnotationManager {
  private items: StoredAnnotation[] = [];
  private nextId: number;
  private app: AppPanel | null = null;
  private readonly consolePanel: ConsolePanel;
  private readonly box = new CommentBox();
  private draft: OpenDraft | null = null;
  private readonly committing = new Map<string, Committing>();
  private sending = false;
  private readonly authHeaders: () => Record<string, string>;
  autoSend: boolean;
  /** Nome della sessione che riceve le annotazioni ("Claude Code", oppure "Claude 2" con più schede). */
  targetName: () => string = () => 'Claude Code';
  /** La sessione indicata è in esecuzione? (stato dall'elenco delle schede) */
  isRunning: (id: string) => boolean = () => this.consolePanel.running;

  constructor(startId: number, autoSendDefault: boolean, consolePanel: ConsolePanel, authHeaders: () => Record<string, string>) {
    this.nextId = Math.max(1, startId);
    this.consolePanel = consolePanel;
    this.authHeaders = authHeaders;
    const stored = prefs.get('autoSend');
    this.autoSend = stored === null ? autoSendDefault : stored;
    const toggle = $('auto-send') as HTMLInputElement;
    toggle.checked = this.autoSend;
    toggle.addEventListener('change', () => {
      this.autoSend = toggle.checked;
      prefs.set('autoSend', this.autoSend);
    });
    $('btn-send').addEventListener('click', () => void this.send());
    $('btn-undo').addEventListener('click', () => this.undo());
    $('tray-clear-sent').addEventListener('click', () => {
      this.items = this.items.filter((a) => a.status !== 'sent');
      $('tray-prompt').hidden = true;
      this.render();
    });
    window.addEventListener('beforeunload', (e) => {
      if (this.items.some((a) => a.status === 'pending' || a.status === 'error')) e.preventDefault();
    });
    this.render();
  }

  attach(app: AppPanel): void {
    this.app = app;
    this.box.locate = (rect) => app.locate(rect);
  }

  /** Le finestre native non hanno pagine: tutte le annotazioni appartengono alla stessa vista. */
  private get paged(): boolean {
    return this.app?.appMode !== 'window';
  }

  get pendingCount(): number {
    return this.items.filter((a) => a.status === 'pending' || a.status === 'error').length;
  }

  viewsFor(url: string): AnnotationView[] {
    return this.items
      .filter((a) => a.status !== 'sent' && (!this.paged || samePage(a.url, url)))
      .map((a) => ({
        id: a.id,
        kind: a.kind,
        status: a.status,
        comment: a.comment,
        url: a.url,
        selector: a.selector,
        anchor: a.anchor,
        rect: a.rect,
        path: a.path,
      }));
  }

  /** Chiude la casella aperta (salva se c'è testo): usato al cambio di strumento. */
  resolveOpenBox(): void {
    this.box.resolve();
  }

  /** Il documento nell'iframe è cambiato: le bozze dell'overlay precedente non esistono più. */
  overlayRestarted(): void {
    if (this.draft) {
      this.draft = null;
      this.box.close();
    }
  }

  // -------------------------------------------------------------------------
  // Messaggi dall'overlay
  // -------------------------------------------------------------------------
  handle(msg: OverlayToPage): void {
    // Bozze e annullamenti arrivano dall'overlay, che è nell'app: valgono solo mentre l'utente
    // ha scelto uno strumento di annotazione nella pagina (in Naviga l'app non può aprire la
    // casella del commento, togliendo la tastiera alla console, né cancellare annotazioni).
    const annotating = !this.app || this.app.mode !== 'navigate';
    switch (msg.type) {
      case 'draft:open': {
        if (!annotating || !isLocalId(msg.localId) || !KINDS.includes(msg.kind)) return;
        // Una bozza alla volta: quella precedente si salva (se ha un commento) o si scarta.
        if (this.box.isOpen) this.box.resolve();
        this.draft = { localId: msg.localId, kind: msg.kind };
        const localId = msg.localId;
        this.box.open({
          mode: 'new',
          kind: msg.kind,
          label: str(msg.label, 200),
          rect: cleanRect(msg.rect),
          canAdjust: msg.canAdjust === true,
          comment: '',
          onSave: (text, sendAfter) => this.commitDraft(localId, text, sendAfter),
          onCancel: () => {
            if (this.draft?.localId === localId) this.draft = null;
            this.app?.post({ type: 'draft:cancel', localId });
          },
          onAdjust: (dir) => this.app?.post({ type: 'draft:adjust', localId, dir }),
        });
        break;
      }
      case 'draft:update':
        if (this.draft && msg.localId === this.draft.localId) this.box.update(str(msg.label, 200), cleanRect(msg.rect));
        break;
      case 'draft:closed':
        if (this.draft && msg.localId === this.draft.localId) {
          this.draft = null;
          this.box.close();
        }
        break;
      case 'annotation:create':
        this.create(msg.localId, msg.data);
        break;
      case 'annotation:screenshot': {
        const a = this.find(msg.id);
        if (a && a.capturing) {
          a.screenshot = typeof msg.screenshot === 'string' && msg.screenshot.startsWith('data:image/png;base64,') ? msg.screenshot : null;
          a.screenshotError = a.screenshot ? null : str(msg.error, 160) || t('shot.failed');
          if (a.surface === 'window') a.context = typeof msg.context === 'string' && /^[a-z0-9]{1,40}$/i.test(msg.context) ? msg.context : null;
          a.capturing = false;
          this.render();
        }
        break;
      }
      case 'annotation:edit': {
        const a = this.find(msg.id);
        if (a && (a.status === 'pending' || a.status === 'error')) this.edit(a, cleanRect(msg.rect));
        break;
      }
      case 'send':
        // Ctrl+Invio dentro l'app: l'invio va confermato nella pagina Studio.
        if (this.pendingCount) {
          const btn = $('btn-send');
          btn.focus();
          btn.classList.remove('pulse');
          void btn.offsetWidth;
          btn.classList.add('pulse');
          toast(t('send.pressEnter'));
        }
        break;
      case 'undo':
        if (annotating) this.undo();
        break;
      default:
        break;
    }
  }

  private find(id: unknown): StoredAnnotation | undefined {
    return typeof id === 'number' ? this.items.find((a) => a.id === id) : undefined;
  }

  private commitDraft(localId: string, comment: string, sendAfter: boolean): void {
    if (this.draft?.localId === localId) this.draft = null;
    if (!comment) {
      // Ctrl+Invio con la casella vuota: scarta la bozza e invia quelle già pronte
      this.app?.post({ type: 'draft:cancel', localId });
      if (sendAfter) void this.send();
      return;
    }
    const timer = window.setTimeout(() => {
      if (this.committing.delete(localId)) toast(t('send.notRegistered'), 'error');
    }, 5000);
    this.committing.set(localId, { comment: comment.slice(0, 4000), sendAfter, timer });
    this.app?.post({ type: 'draft:commit', localId });
  }

  /** L'overlay ha raccolto i dati di una bozza confermata da questa pagina. */
  private create(localId: unknown, data: unknown): void {
    if (!isLocalId(localId)) return;
    const pending = this.committing.get(localId);
    if (!pending) return; // nessuna conferma da questa pagina: messaggio ignorato
    this.committing.delete(localId);
    clearTimeout(pending.timer);
    const capture = cleanCapture(data);
    if (!capture) return;
    const id = this.nextId++;
    // Il tipo di superficie lo decide questa pagina (dalla modalità di Studio), non il messaggio ricevuto
    const appMode = this.app?.appMode ?? 'web';
    const surface = appMode === 'web' ? {} : { surface: appMode };
    if (appMode !== 'window') delete capture.native;
    this.items.push({ ...capture, ...surface, comment: pending.comment, id, screenshot: null, status: 'pending', capturing: true });
    this.app?.post({ type: 'annotation:assigned', localId, id });
    this.app?.post({ type: 'annotation:update', id, comment: pending.comment });
    this.render();
    if (pending.sendAfter) void this.send();
  }

  private edit(a: StoredAnnotation, rect: Rect): void {
    if (this.box.isOpen) this.box.resolve();
    this.box.open({
      mode: 'edit',
      kind: a.kind,
      label: t('tray.editLabel', { id: a.id, label: a.label ?? kindLabel(a.kind) }),
      rect,
      canAdjust: false,
      comment: a.comment,
      onSave: (text, sendAfter) => {
        if (text) {
          a.comment = text.slice(0, 4000);
          this.app?.post({ type: 'annotation:update', id: a.id, comment: a.comment });
          this.render();
        }
        if (sendAfter) void this.send();
      },
      onCancel: () => undefined,
      onDelete: () => this.remove(a.id),
    });
  }

  remove(id: number, notifyOverlay = true): void {
    const before = this.items.length;
    this.items = this.items.filter((a) => a.id !== id || a.status === 'sending');
    if (this.items.length !== before && notifyOverlay) this.app?.post({ type: 'annotation:remove', id });
    this.render();
  }

  undo(): void {
    const last = [...this.items].reverse().find((a) => a.status === 'pending' || a.status === 'error');
    if (!last) {
      toast(t('send.nothingToUndo'));
      return;
    }
    this.remove(last.id);
  }

  // -------------------------------------------------------------------------
  // Invio (solo da gesti nella pagina Studio: pulsante, Ctrl+Invio, casella del commento)
  // -------------------------------------------------------------------------
  async send(): Promise<void> {
    if (this.sending) return;
    // La scheda che riceve le annotazioni è quella attiva quando si preme Invia (le attese per
    // le bozze e gli screenshot possono durare secondi, intanto l'utente può cambiare scheda).
    const target = this.consolePanel.sessionId;
    const targetName = this.targetName();
    if (this.box.isOpen) this.box.resolve();
    // Le bozze appena confermate arrivano dall'overlay in pochi millisecondi
    const waitCommit = Date.now() + 2000;
    while (this.committing.size && Date.now() < waitCommit) await new Promise((r) => setTimeout(r, 50));
    const batch = this.items.filter((a) => a.status === 'pending' || a.status === 'error');
    if (!batch.length) {
      toast(t('send.nothingToSend'));
      return;
    }
    if (!this.isRunning(target)) {
      toast(t('send.notRunning', { name: targetName }), 'error');
      return;
    }
    this.sending = true;
    batch.forEach((a) => (a.status = 'sending'));
    this.render();

    // Gli screenshot si catturano in background: aspettiamo al massimo 10 secondi.
    const deadline = Date.now() + 10000;
    while (batch.some((a) => a.capturing) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 120));
    for (const a of batch) {
      if (a.capturing) {
        a.capturing = false;
        a.screenshotError = t('shot.timeout');
      }
    }

    const ids = batch.map((a) => a.id);
    try {
      const annotations = batch.map(({ status: _s, capturing: _c, ...rest }) => rest);
      // Finestre native: anche l'immagine della finestra intera con le annotazioni evidenziate
      const contexts = this.app ? await this.app.contextImages(annotations).catch(() => []) : [];
      const payload = {
        autoSend: this.autoSend,
        session: target,
        annotations,
        ...(contexts.length ? { contexts } : {}),
      };
      const res = await fetch('/api/annotation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as AnnotationResponse;
      if (!res.ok || !body.ok) {
        // Claude Code aspetta una risposta: il focus va alla console, dove l'utente deve rispondere
        if (body.code === 'awaiting-answer') this.consolePanel.focus();
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      batch.forEach((a) => (a.status = 'sent'));
      this.app?.post({ type: 'annotation:status', ids, status: 'sent' });
      // Claude Code può mostrare i testi incollati lunghi come "[Pasted text]": qui resta leggibile.
      if (body.prompt) {
        $('tray-prompt-text').textContent = body.prompt;
        $('tray-prompt').hidden = false;
      }
      const count = batch.length;
      if (this.autoSend) toast(t('send.sentAuto', { count, name: targetName }), 'ok');
      else {
        toast(t('send.sentManual', { count }), 'ok', 5000);
        this.consolePanel.focus();
      }
    } catch (err) {
      batch.forEach((a) => (a.status = 'error'));
      this.app?.post({ type: 'annotation:status', ids, status: 'pending' });
      toast(t('send.failed', { error: (err as Error).message }), 'error', 6500);
    } finally {
      this.sending = false;
      this.render();
    }
  }

  // -------------------------------------------------------------------------
  // Vassoio
  // -------------------------------------------------------------------------
  private render(): void {
    const pending = this.pendingCount;
    const btn = $('btn-send') as HTMLButtonElement;
    btn.disabled = pending === 0 || this.sending;
    $('send-count').textContent = String(pending);
    ($('btn-undo') as HTMLButtonElement).disabled = pending === 0;

    const tray = $('tray');
    tray.hidden = this.items.length === 0;
    const sent = this.items.filter((a) => a.status === 'sent').length;
    $('tray-clear-sent').hidden = sent === 0;
    $('tray-hint').textContent = pending ? t('tray.pendingHint', { count: pending }) : sent ? t('tray.sentHint', { count: sent }) : '';

    const list = $('tray-list');
    list.innerHTML = '';
    for (const a of [...this.items].reverse()) {
      const li = document.createElement('li');
      li.className = 'tray-item';
      li.dataset.status = a.status;
      const state = t(
        a.status === 'sent'
          ? 'tray.state.sent'
          : a.status === 'sending'
            ? 'tray.state.sending'
            : a.status === 'error'
              ? 'tray.state.error'
              : a.capturing
                ? 'tray.state.capturing'
                : 'tray.state.pending',
      );
      let target = a.label || a.selector || '';
      if (a.kind !== 'element') {
        // Zone e disegni: dimensione e posizione nella pagina, poi cosa contengono o dove sono
        const r = a.rect;
        const what =
          (a.contains ?? [])
            .map((c) => c.label)
            .filter(Boolean)
            .join(', ') ||
          a.container?.label ||
          '';
        target = `${t('tray.zone', { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) })}${what ? ` · ${what}` : ''}`;
      }
      li.innerHTML = `
        <span class="badge">${a.id}</span>
        <span class="thumb${a.capturing ? ' loading' : ''}"></span>
        <span class="body">
          <span class="comment">${escapeHtml(a.comment || t('tray.noComment'))}</span>
          <span class="meta">${icon(KIND_ICON[a.kind])} ${escapeHtml(kindLabel(a.kind))} · ${escapeHtml(a.url)}${target ? ` · ${escapeHtml(target)}` : ''}</span>
        </span>
        <span class="state">${escapeHtml(state)}</span>
        ${a.status === 'sent' || a.status === 'sending' ? '' : `<button class="icon-btn remove" type="button" title="${escapeHtml(t('tray.remove'))}">${icon('trash')}</button>`}`;
      const thumb = li.querySelector('.thumb') as HTMLElement;
      if (a.screenshot) thumb.style.backgroundImage = `url("${a.screenshot}")`;
      li.querySelector('.meta svg')?.setAttribute('style', 'width:12px;height:12px;vertical-align:-2px');
      li.querySelector('.remove')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.remove(a.id);
      });
      li.addEventListener('click', () => {
        if (!this.app) return;
        if (this.app.appMode === 'web' && !samePage(a.url, this.app.currentUrl)) this.app.navigate(a.url);
        else this.app.post({ type: 'annotation:focus', id: a.id });
      });
      list.appendChild(li);
    }
  }
}
