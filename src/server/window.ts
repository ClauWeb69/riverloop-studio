import type { AppClientMessage, AppWindowInfo, NativeSummary, Rect } from '../shared/protocol.js';
import { AppBridge, type BridgeClient } from './bridge.js';
import type { DesktopApp } from './desktop.js';
import { t } from './i18n.js';
import { log } from './util.js';
import { CaptureUnavailable, type NativeWindow, type WindowCapturer } from './wincapture.js';

const LIST_MS = 1000;
const FRAME_MS = 450;
/** Senza una dimensione comunicata dalla pagina l'anteprima non supera questa misura. */
const DEFAULT_PREVIEW = { width: 1600, height: 1200 };

interface WindowBridgeOptions {
  app: DesktopApp;
  capturer: WindowCapturer | null;
  /** Perché la cattura non è disponibile su questo sistema (capturer null). */
  unavailable: string;
  /** Testo che il titolo della finestra deve contenere (--window-title). */
  title: string;
}

/**
 * Modalità window: l'app è una finestra nativa qualunque (WPF, Qt, Tauri, Flutter, giochi...).
 * Studio non può entrarci: ne mostra l'immagine nella pagina, dove l'utente la annota con
 * riquadri e disegni (e, dove il sistema lo permette, scegliendo gli elementi dell'interfaccia).
 * L'app si usa nella sua finestra vera.
 */
export class WindowBridge extends AppBridge {
  private readonly opts: WindowBridgeOptions;
  private listTimer: NodeJS.Timeout | null = null;
  private frameTimer: NodeJS.Timeout | null = null;
  private listing = false;
  private capturing = false;
  private windows: NativeWindow[] = [];
  /** Finestra scelta dall'utente: id e titolo (dopo un riavvio dell'app l'id cambia). */
  private wanted: { id: string; title: string } | null = null;
  private currentId: string | null = null;
  private lastHash = '';
  /** Cambia quando l'anteprima va rifatta comunque (pannello ridimensionato, altra finestra). */
  private previewEpoch = 0;
  private stopped = false;
  private unavailable: string;

  constructor(opts: WindowBridgeOptions) {
    super();
    this.opts = opts;
    this.unavailable = opts.capturer ? '' : opts.unavailable;
    this.current = { ...this.current, ...this.idleView() };
  }

  private idleView(): { state: 'waiting' | 'unsupported'; message: string } {
    if (this.unavailable) return { state: 'unsupported', message: this.unavailable };
    const { app, title } = this.opts;
    if (app.state === 'exited') return { state: 'waiting', message: this.text('app.stopped') };
    if (app.managed) return { state: 'waiting', message: this.text('window.waiting') };
    if (title) return { state: 'waiting', message: this.text('window.noTitleMatch', { title }) };
    return { state: 'waiting', message: this.text('window.choose') };
  }

  start(): void {
    if (!this.opts.capturer || this.listTimer) return;
    this.listTimer = setInterval(() => void this.refreshWindows(), LIST_MS);
    this.listTimer.unref();
    this.frameTimer = setInterval(() => void this.preview(), FRAME_MS);
    this.frameTimer.unref();
    this.opts.app.on('status', () => {
      if (!this.currentId) this.setView(this.idleView());
    });
    void this.refreshWindows();
  }

  close(): void {
    this.stopped = true;
    if (this.listTimer) clearInterval(this.listTimer);
    if (this.frameTimer) clearInterval(this.frameTimer);
    this.listTimer = this.frameTimer = null;
    this.opts.capturer?.dispose();
    this.closeClients();
  }

  private fail(err: unknown): void {
    if (err instanceof CaptureUnavailable) {
      // Da qui la pagina propone la condivisione della finestra dal browser
      this.unavailable = t('window.shareFromBrowser', { reason: err.message });
      this.currentId = null;
      this.setView({ ...this.idleView(), windows: [], current: null, elements: false });
      this.opts.app.setReady(this.opts.app.pid !== null);
    } else {
      log.debug(`finestra: ${(err as Error).message}`);
    }
  }

  // -------------------------------------------------------------------------
  // Finestre dell'app
  // -------------------------------------------------------------------------
  private async refreshWindows(): Promise<void> {
    const capturer = this.opts.capturer;
    if (!capturer || this.listing || this.stopped || this.unavailable) return;
    this.listing = true;
    try {
      const { app, title } = this.opts;
      // Con un'app avviata da Studio contano le finestre dei suoi processi; altrimenti il titolo
      const root = app.managed ? app.pid : null;
      const list = app.managed && root === null ? [] : await capturer.list(root, title);
      if (this.stopped) return;
      // Prima le finestre principali, poi le più grandi
      this.windows = list.sort((a, b) => Number(b.main) - Number(a.main) || b.width * b.height - a.width * a.height);
      app.setReady(this.windows.length > 0 && (app.managed || Boolean(title) || this.currentId !== null));
      const infos: AppWindowInfo[] = this.windows.map((w) => ({ id: w.id, title: w.title || t('window.untitled') }));

      let current = this.windows.find((w) => w.id === this.currentId);
      if (!current) {
        const byWanted = this.wanted
          ? (this.windows.find((w) => w.id === this.wanted!.id) ?? this.windows.find((w) => w.title === this.wanted!.title))
          : undefined;
        // Senza processo né titolo di riferimento la finestra la sceglie l'utente
        const automatic = app.managed || title ? this.windows[0] : undefined;
        current = byWanted ?? automatic;
        if (current?.id !== this.currentId) {
          this.currentId = current?.id ?? null;
          this.lastHash = '';
          this.forgetFrame();
        }
      }
      if (!current) {
        this.setView({ ...this.idleView(), windows: infos, current: null, title: '', width: 0, height: 0, elements: capturer.elements });
        return;
      }
      this.setView({ windows: infos, current: current.id, title: current.title, url: '', elements: capturer.elements });
      if (current.minimized) this.setHidden();
    } catch (err) {
      this.fail(err);
    } finally {
      this.listing = false;
    }
  }

  private setHidden(): void {
    this.setView({ state: 'hidden', message: this.text('window.minimized') });
  }

  // -------------------------------------------------------------------------
  // Anteprima dal vivo
  // -------------------------------------------------------------------------
  private async preview(): Promise<void> {
    const capturer = this.opts.capturer;
    const id = this.currentId;
    if (!capturer || !id || this.capturing || this.stopped || this.unavailable) return;
    if (![...this.clients].some((c) => c.live)) return;
    this.capturing = true;
    const epoch = this.previewEpoch;
    try {
      const wanted = this.wantedSize();
      const max = wanted.width >= 200 && wanted.height >= 150 ? wanted : DEFAULT_PREVIEW;
      const shot = await capturer.capture(id, { format: 'jpeg', quality: 84, maxWidth: max.width, maxHeight: max.height, lastHash: this.lastHash });
      if (this.currentId !== id || this.stopped) return;
      if (shot.status === 'minimized') return this.setHidden();
      if (shot.status === 'gone') {
        this.currentId = null;
        this.lastHash = '';
        return;
      }
      this.setView({ state: 'live', message: '', width: shot.width, height: shot.height, scale: shot.scale });
      if (shot.status === 'ok' && shot.data) {
        // Se nel frattempo è cambiata la dimensione richiesta, questa cattura è già vecchia:
        // la si mostra, ma la prossima va rifatta anche se la finestra non cambia
        this.lastHash = epoch === this.previewEpoch ? shot.hash : '';
        this.broadcastFrame('jpeg', shot.width, shot.height, shot.data);
      }
    } catch (err) {
      this.fail(err);
    } finally {
      this.capturing = false;
    }
  }

  protected override clientsChanged(): void {
    // Un pannello più grande vuole un'anteprima più definita: si ricattura anche se la finestra non è cambiata
    this.lastHash = '';
    this.previewEpoch++;
  }

  // -------------------------------------------------------------------------
  // Messaggi dalla pagina Studio
  // -------------------------------------------------------------------------
  protected handle(client: BridgeClient, msg: AppClientMessage): void {
    const capturer = this.opts.capturer;
    switch (msg.type) {
      case 'restart':
        if (this.opts.app.managed) void this.opts.app.restart();
        return;
      case 'select': {
        const w = this.windows.find((x) => x.id === msg.id);
        if (!w) return;
        this.wanted = { id: w.id, title: w.title };
        if (this.currentId !== w.id) {
          this.currentId = w.id;
          this.lastHash = '';
          this.forgetFrame();
          this.setView({ current: w.id, title: w.title, state: w.minimized ? 'hidden' : 'waiting', message: w.minimized ? this.current.message : '' });
          void this.refreshWindows().then(() => this.preview());
        }
        return;
      }
      case 'show':
      case 'activate': {
        const id = this.currentId;
        if (!capturer || !id) return;
        const done = msg.type === 'show' ? capturer.show(id) : capturer.activate(id);
        void done.then(() => this.refreshWindows()).catch((err: unknown) => this.fail(err));
        return;
      }
      case 'still':
        void this.still(client, Math.floor(Number(msg.req)) || 0);
        return;
      case 'element':
        void this.element(client, Math.floor(Number(msg.req)) || 0, Number(msg.x) || 0, Number(msg.y) || 0);
        return;
      case 'elementsIn': {
        const r = (msg.rect ?? {}) as Partial<Rect>;
        const rect = { x: Number(r.x) || 0, y: Number(r.y) || 0, width: Math.max(1, Number(r.width) || 0), height: Math.max(1, Number(r.height) || 0) };
        void this.elementsIn(client, Math.floor(Number(msg.req)) || 0, rect);
        return;
      }
      default:
        break;
    }
  }

  /** Fermo immagine a piena risoluzione: è la base su cui l'utente annota. */
  private async still(client: BridgeClient, req: number): Promise<void> {
    const capturer = this.opts.capturer;
    const id = this.currentId;
    if (!capturer || !id) {
      this.sendJson({ type: 'still', req, ok: false, error: t('window.noWindow') }, client);
      return;
    }
    try {
      const shot = await capturer.capture(id, { format: 'png' });
      if (shot.status !== 'ok' || !shot.data) {
        const error = t(shot.status === 'minimized' ? 'window.stillMinimized' : 'window.stillGone');
        this.sendJson({ type: 'still', req, ok: false, error }, client);
        return;
      }
      this.setView({ width: shot.width, height: shot.height, scale: shot.scale });
      this.sendStill(client, req, shot.width, shot.height, shot.data);
      this.sendJson({ type: 'still', req, ok: true }, client);
    } catch (err) {
      this.fail(err);
      this.sendJson({ type: 'still', req, ok: false, error: (err as Error).message.slice(0, 200) }, client);
    }
  }

  private async element(client: BridgeClient, req: number, x: number, y: number): Promise<void> {
    const capturer = this.opts.capturer;
    const id = this.currentId;
    let element = null;
    try {
      if (capturer?.elements && id) element = await capturer.elementAt(id, x, y);
    } catch (err) {
      log.debug(`finestra: elemento non riconosciuto: ${(err as Error).message}`);
    }
    this.sendJson({ type: 'element', req, element }, client);
  }

  /** Controlli dentro una zona della finestra, per l'elenco "Contiene" del Riquadro. */
  private async elementsIn(client: BridgeClient, req: number, rect: Rect): Promise<void> {
    const capturer = this.opts.capturer;
    const id = this.currentId;
    let items: NativeSummary[] = [];
    try {
      if (capturer?.elements && id) items = await capturer.elementsIn(id, rect);
    } catch (err) {
      log.debug(`finestra: controlli nella zona non riconosciuti: ${(err as Error).message}`);
    }
    this.sendJson({ type: 'elementsIn', req, items }, client);
  }
}
