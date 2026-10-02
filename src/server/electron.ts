import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MESSAGE_SOURCE,
  MOD_CTRL,
  MOD_META,
  MOD_SHIFT,
  type AppClientMessage,
  type AppWindowInfo,
  type OverlayToPage,
  type PageToOverlay,
} from '../shared/protocol.js';
import { AppBridge, type BridgeClient } from './bridge.js';
import { CdpConnection, listTargets, type CdpTarget } from './cdp.js';
import type { DesktopApp } from './desktop.js';
import { t } from './i18n.js';
import { isWindows, log, toPosix } from './util.js';

/** Funzione esposta alla pagina dell'app: l'overlay la usa per parlare con Studio. */
export const BRIDGE_SEND = '__rlsStudioSend';
/** Funzione definita dall'overlay: Studio la chiama per consegnargli i messaggi. */
export const BRIDGE_RECEIVE = '__rlsStudioReceive';

const ELECTRON_HOOK = fileURLToPath(new URL('./electron-hook.cjs', import.meta.url));
const POLL_MS = 700;
const MAX_OVERLAY_MESSAGE = 24 * 1024 * 1024;
/**
 * Valutata nella pagina dell'app: "1|LxA" se la pagina disegna (un requestAnimationFrame
 * arriva entro mezzo secondo), "0|LxA" se no (finestra a icona o nascosta).
 */
const PAINT_PROBE =
  'new Promise(function(resolve){var done=false,size=innerWidth+"x"+innerHeight;' +
  'requestAnimationFrame(function(){done=true;resolve("1|"+size)});' +
  'setTimeout(function(){if(!done)resolve("0|"+size)},500)})';
const NO_BACKGROUND = ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'];

/**
 * Variabili d'ambiente per il comando che avvia l'app (--app-cmd) in modalità electron:
 * - NODE_OPTIONS carica nel processo principale di Electron l'hook che apre la porta di debug;
 * - REMOTE_DEBUGGING_PORT è la variabile letta da electron-vite;
 * - WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS fa lo stesso per le app WebView2 (Tauri su Windows, .NET).
 */
export function electronEnv(port: number, base: NodeJS.ProcessEnv = process.env, appWindow: 'background' | 'normal' = 'background'): Record<string, string> {
  const hook = `--require "${toPosix(ELECTRON_HOOK).replace(/\\/g, '/')}"`;
  const nodeOptions = base.NODE_OPTIONS?.includes(path.basename(ELECTRON_HOOK)) ? base.NODE_OPTIONS : [base.NODE_OPTIONS, hook].filter(Boolean).join(' ');
  const webview = [base.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, `--remote-debugging-port=${port}`, ...NO_BACKGROUND].filter(Boolean).join(' ');
  return {
    NODE_OPTIONS: nodeOptions,
    RIVERLOOP_STUDIO_CDP_PORT: String(port),
    // Finestre dell'app ridotte a icona (l'app si usa dalla pagina Studio) oppure normali
    RIVERLOOP_STUDIO_APP_WINDOW: appWindow,
    REMOTE_DEBUGGING_PORT: String(port),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: webview,
  };
}

/** Nel comando dell'app "{port}" diventa la porta di debug scelta da Studio. */
export function expandAppCommand(command: string, port: number): string {
  return command.replace(/\{port\}/g, String(port));
}

// ---------------------------------------------------------------------------
// Tastiera e mouse: dagli eventi del browser ai comandi Input.* del protocollo DevTools
// ---------------------------------------------------------------------------
const BUTTONS = ['left', 'middle', 'right', 'back', 'forward'] as const;

export function mouseParams(msg: Extract<AppClientMessage, { type: 'mouse' }>): Record<string, unknown> {
  const type = msg.action === 'down' ? 'mousePressed' : msg.action === 'up' ? 'mouseReleased' : 'mouseMoved';
  let button: string = BUTTONS[msg.button] ?? 'left';
  if (msg.action === 'move') {
    // Durante un trascinamento CDP vuole il pulsante tenuto premuto
    const held = msg.buttons & 1 ? 'left' : msg.buttons & 2 ? 'right' : msg.buttons & 4 ? 'middle' : 'none';
    button = held;
  }
  return {
    type,
    x: Math.round(Number(msg.x) * 10) / 10 || 0,
    y: Math.round(Number(msg.y) * 10) / 10 || 0,
    button,
    buttons: Number(msg.buttons) & 31,
    clickCount: msg.action === 'move' ? 0 : Math.max(1, Math.min(3, Number(msg.clicks) || 1)),
    modifiers: Number(msg.mods) & 15,
  };
}

/** Comandi di modifica per le scorciatoie su macOS (lì i tasti sintetici non li attivano da soli). */
const MAC_COMMANDS: Record<string, string> = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo' };

export function keyParams(msg: Extract<AppClientMessage, { type: 'key' }>, platform = process.platform): Record<string, unknown> {
  const key = String(msg.key ?? '').slice(0, 32);
  const code = String(msg.code ?? '').slice(0, 32);
  const keyCode = Math.max(0, Math.min(255, Math.floor(Number(msg.keyCode)) || 0));
  const mods = Number(msg.mods) & 15;
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers: mods, location: Number(msg.location) & 3 };
  if (msg.action === 'up') return { type: 'keyUp', ...base };
  const shortcut = (mods & (MOD_CTRL | MOD_META)) !== 0;
  const printable = [...key].length === 1 && !shortcut;
  const text = printable ? key : key === 'Enter' && !shortcut ? '\r' : undefined;
  const out: Record<string, unknown> = { type: text ? 'keyDown' : 'rawKeyDown', ...base, autoRepeat: msg.repeat === true };
  if (text) {
    out.text = text;
    out.unmodifiedText = text;
  }
  if (platform === 'darwin' && mods & MOD_META) {
    const command = key.toLowerCase() === 'z' && mods & MOD_SHIFT ? 'redo' : MAC_COMMANDS[key.toLowerCase()];
    if (command) out.commands = [command];
  }
  return out;
}

interface ElectronBridgeOptions {
  app: DesktopApp;
  /** Porta di debug dell'app. */
  port: number;
  /** Sorgente dell'overlay (già configurato per parlare con Studio tramite il ponte). */
  overlayScript: () => string | null;
}

/**
 * Modalità electron: la pagina dell'app (Electron, o un'altra app basata su Chromium con la
 * porta di debug aperta) viene mostrata nella pagina Studio con uno screencast, riceve mouse
 * e tastiera, e ospita lo stesso overlay di annotazione delle app web.
 *
 * Come per le app web, l'overlay vive nella pagina dell'app e i suoi messaggi non sono
 * fidati: passano dal companion alla pagina Studio, che li valida, e l'invio a Claude parte
 * solo da lì.
 */
export class ElectronBridge extends AppBridge {
  private readonly opts: ElectronBridgeOptions;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private targets: CdpTarget[] = [];
  /** Finestra scelta dall'utente (id della pagina), se c'è. */
  private wanted: string | null = null;
  private conn: CdpConnection | null = null;
  private connId: string | null = null;
  private connecting = false;
  private overlayState: { url: string; title: string } | null = null;
  private castSize = { width: 0, height: 0 };
  private castTimer: NodeJS.Timeout | null = null;
  /** Client che sta usando l'app: solo lui decide quali annotazioni mostra l'overlay. */
  private primary: BridgeClient | null = null;
  private stopped = false;
  private failures = 0;

  constructor(opts: ElectronBridgeOptions) {
    super();
    this.opts = opts;
    this.current = { ...this.current, message: this.waitingMessage() };
  }

  private waitingMessage(): string {
    const { app, port } = this.opts;
    if (app.state === 'exited') return this.text('app.stopped');
    if (!app.managed) return this.text('electron.noApp', { port });
    return this.text('electron.waiting');
  }

  start(): void {
    if (this.timer) return;
    const tick = () => void this.poll();
    this.timer = setInterval(tick, POLL_MS);
    this.timer.unref();
    this.opts.app.on('status', () => {
      if (!this.conn) this.setView({ message: this.waitingMessage() });
    });
    tick();
  }

  close(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.castTimer) clearTimeout(this.castTimer);
    this.timer = null;
    this.conn?.close();
    this.conn = null;
    this.closeClients();
  }

  // -------------------------------------------------------------------------
  // Finestre dell'app
  // -------------------------------------------------------------------------
  private windows(): AppWindowInfo[] {
    return this.targets.map((t) => ({ id: t.id, title: t.title || t.url, url: t.url }));
  }

  private async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const list = await listTargets(this.opts.port);
      if (this.stopped) return;
      if (list === null) {
        this.targets = [];
        this.opts.app.setReady(false);
        if (!this.conn) this.setView({ state: 'waiting', message: this.waitingMessage(), windows: [], current: null, overlay: false });
        return;
      }
      this.targets = list;
      this.opts.app.setReady(list.length > 0);
      if (this.conn && !list.some((t) => t.id === this.connId)) {
        // La finestra mostrata è stata chiusa
        this.conn.close();
      }
      if (!this.conn && !this.connecting) {
        const target = list.find((t) => t.id === this.wanted) ?? list.find((t) => t.url !== 'about:blank') ?? list[0];
        if (target) await this.connect(target);
        else this.setView({ state: 'waiting', message: this.text('electron.noWindow'), windows: [], current: null, overlay: false });
      }
      const current = list.find((t) => t.id === this.connId);
      if (this.conn && current) {
        this.setView({ windows: this.windows(), current: current.id, title: current.title || current.url, url: current.url });
        await this.checkVisible(this.conn);
      }
    } finally {
      this.polling = false;
    }
  }

  /**
   * Una finestra nascosta o ridotta a icona non disegna: lo screencast si ferma. Per saperlo
   * non basta document.visibilityState (con il focus emulato la pagina si dichiara visibile
   * anche a icona): si chiede alla pagina se riesce a disegnare un fotogramma.
   */
  private async checkVisible(conn: CdpConnection): Promise<void> {
    try {
      const res = await conn.send<{ result?: { value?: unknown } }>(
        'Runtime.evaluate',
        { expression: PAINT_PROBE, awaitPromise: true, returnByValue: true },
        3000,
      );
      if (this.conn !== conn) return;
      this.failures = 0;
      const [painting, size] = String(res.result?.value ?? '').split('|');
      if (painting === '0') {
        this.setView({ state: 'hidden', message: this.text('electron.hidden') });
      } else if (size === '0x0') {
        // Finestra creata ma mai mostrata (show: false): non ha ancora una superficie da disegnare
        this.setView({ state: 'hidden', message: this.text('electron.neverShown') });
      } else if (this.current.state !== 'live') {
        this.setView({ state: 'live', message: '' });
      }
    } catch {
      if (this.conn !== conn) return;
      // La pagina non risponde (bloccata da una finestra di dialogo, da un punto di interruzione...)
      if (++this.failures >= 3) {
        this.setView({ state: 'hidden', message: this.text('electron.notResponding') });
      }
    }
  }

  private async connect(target: CdpTarget): Promise<void> {
    if (!target.webSocketDebuggerUrl) return;
    this.connecting = true;
    try {
      const conn = await CdpConnection.connect(target.webSocketDebuggerUrl);
      if (this.stopped) {
        conn.close();
        return;
      }
      this.conn = conn;
      this.connId = target.id;
      this.overlayState = null;
      this.failures = 0;
      this.forgetFrame();
      conn.on('event', (method: string, params: Record<string, unknown>) => this.onEvent(conn, method, params));
      conn.on('close', () => {
        if (this.conn !== conn) return;
        this.conn = null;
        this.connId = null;
        this.overlayState = null;
        this.setView({ state: 'waiting', message: this.waitingMessage(), overlay: false, current: null });
      });
      await conn.send('Page.enable');
      await conn.send('Runtime.enable');
      await conn.send('Runtime.addBinding', { name: BRIDGE_SEND });
      const overlay = this.opts.overlayScript();
      if (overlay) {
        await conn.send('Page.addScriptToEvaluateOnNewDocument', { source: overlay });
        await conn.send('Runtime.evaluate', { expression: overlay });
        // Un overlay già presente (Studio riavviato con l'app aperta) si annuncia di nuovo
        conn.fire('Runtime.evaluate', { expression: `window.${BRIDGE_RECEIVE}&&window.${BRIDGE_RECEIVE}({"type":"announce"})` });
      } else {
        log.warn(t('overlay.notBuilt'));
      }
      // La pagina si comporta come se avesse il focus (cursore nei campi, stati :focus)
      conn.fire('Emulation.setFocusEmulationEnabled', { enabled: true });
      this.setView({ state: 'live', message: '', windows: this.windows(), current: target.id, title: target.title || target.url, url: target.url });
      await this.startScreencast(conn);
    } catch (err) {
      log.debug(`electron: collegamento alla pagina non riuscito: ${(err as Error).message}`);
      this.conn?.close();
    } finally {
      this.connecting = false;
    }
  }

  // -------------------------------------------------------------------------
  // Screencast
  // -------------------------------------------------------------------------
  private async startScreencast(conn: CdpConnection): Promise<void> {
    const wanted = this.wantedSize();
    this.castSize = wanted;
    const params: Record<string, unknown> = { format: 'jpeg', quality: 88, everyNthFrame: 1 };
    // I fotogrammi non servono più grandi del pannello della pagina Studio
    if (wanted.width >= 200 && wanted.height >= 150) {
      params.maxWidth = wanted.width;
      params.maxHeight = wanted.height;
    }
    await conn.send('Page.startScreencast', params);
  }

  protected override clientsChanged(): void {
    const wanted = this.wantedSize();
    if (!this.conn || (wanted.width === this.castSize.width && wanted.height === this.castSize.height)) return;
    if (this.castTimer) clearTimeout(this.castTimer);
    this.castTimer = setTimeout(() => {
      this.castTimer = null;
      const conn = this.conn;
      if (!conn) return;
      void conn
        .send('Page.stopScreencast')
        .catch(() => undefined)
        .then(() => this.startScreencast(conn))
        .catch(() => undefined);
    }, 300);
    this.castTimer.unref();
  }

  private onEvent(conn: CdpConnection, method: string, params: Record<string, unknown>): void {
    if (this.conn !== conn) return;
    if (method === 'Page.screencastFrame') {
      conn.fire('Page.screencastFrameAck', { sessionId: params.sessionId });
      const meta = (params.metadata ?? {}) as { deviceWidth?: number; deviceHeight?: number };
      const width = Math.round(Number(meta.deviceWidth) || 0);
      const height = Math.round(Number(meta.deviceHeight) || 0);
      if (typeof params.data !== 'string' || !width || !height) return;
      this.setView({ state: 'live', message: '', width, height });
      this.broadcastFrame('jpeg', width, height, Buffer.from(params.data, 'base64'));
      return;
    }
    if (method === 'Runtime.bindingCalled' && params.name === BRIDGE_SEND) {
      this.onOverlayMessage(conn, params.payload);
      return;
    }
    if (method === 'Page.frameNavigated') {
      const frame = (params.frame ?? {}) as { parentId?: string };
      if (!frame.parentId) {
        // Nuovo documento: l'overlay si riannuncia quando è pronto
        this.overlayState = null;
        this.setView({ overlay: false });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Overlay nella pagina dell'app
  // -------------------------------------------------------------------------
  private onOverlayMessage(conn: CdpConnection, payload: unknown): void {
    if (typeof payload !== 'string' || payload.length > MAX_OVERLAY_MESSAGE) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || msg.source !== MESSAGE_SOURCE || typeof msg.type !== 'string') return;
    if (msg.type === 'capture:request') {
      void this.capture(conn, msg);
      return;
    }
    if (msg.type === 'ready' || msg.type === 'location') {
      this.overlayState = { url: String(msg.url ?? '/').slice(0, 2000), title: String(msg.title ?? '').slice(0, 300) };
      this.setView({ overlay: true });
    }
    // Pagina caricata, indirizzo e strumento interessano tutte le finestre di Studio; bozze e
    // annotazioni solo quella in uso, altrimenti la casella del commento si aprirebbe in tutte.
    const shared = msg.type === 'ready' || msg.type === 'location' || msg.type === 'mode';
    const only = !shared && this.primary && this.clients.has(this.primary) ? this.primary : undefined;
    this.sendJson({ type: 'overlay', msg: msg as unknown as OverlayToPage }, only);
  }

  private toOverlay(msg: PageToOverlay | { type: string; [key: string]: unknown }): void {
    this.conn?.fire('Runtime.evaluate', { expression: `window.${BRIDGE_RECEIVE}&&window.${BRIDGE_RECEIVE}(${JSON.stringify(msg)})` });
  }

  /**
   * Screenshot chiesto dall'overlay: lo fa il motore di Chromium, quindi è fedele anche per
   * canvas, video e immagini di altri domini. Si cattura la vista intera e la zona annotata la
   * ritaglia l'overlay: chiedere a Chromium un ritaglio gli farebbe spostare e ingrandire per
   * un istante la vista dell'app (la finestra vera e la copia nella pagina Studio sobbalzano).
   */
  private async capture(conn: CdpConnection, msg: Record<string, unknown>): Promise<void> {
    const key = String(msg.key ?? '').slice(0, 60);
    try {
      const shot = await conn.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, 9000);
      this.toOverlay({ type: 'capture:result', key, data: `data:image/png;base64,${shot.data}` });
    } catch (err) {
      this.toOverlay({ type: 'capture:result', key, data: null, error: (err as Error).message.slice(0, 120) });
    }
  }

  protected override greet(client: BridgeClient): void {
    if (!this.primary) this.primary = client;
    if (this.overlayState) this.sendJson({ type: 'overlay', msg: { type: 'ready', ...this.overlayState } }, client);
  }

  protected override clientDetached(client: BridgeClient): void {
    if (this.primary !== client) return;
    this.primary = this.clients.values().next().value ?? null;
    // La pagina che ora comanda rimanda strumento e annotazioni all'overlay (per esempio dopo
    // una riconnessione, quando il suo primo "hello" era stato scartato)
    if (this.primary && this.overlayState) this.sendJson({ type: 'overlay', msg: { type: 'ready', ...this.overlayState } }, this.primary);
  }

  // -------------------------------------------------------------------------
  // Messaggi dalla pagina Studio
  // -------------------------------------------------------------------------
  protected handle(client: BridgeClient, msg: AppClientMessage): void {
    const conn = this.conn;
    switch (msg.type) {
      case 'select':
        if (typeof msg.id === 'string' && this.targets.some((t) => t.id === msg.id) && msg.id !== this.connId) {
          this.wanted = msg.id;
          this.conn?.close();
          void this.poll();
        }
        return;
      case 'restart':
        if (this.opts.app.managed) void this.opts.app.restart();
        return;
      case 'show':
      case 'activate':
        conn?.fire('Page.bringToFront');
        return;
      default:
        break;
    }
    if (!conn) return;
    switch (msg.type) {
      case 'overlay': {
        const inner = msg.msg as PageToOverlay | undefined;
        if (!inner || typeof inner !== 'object' || typeof inner.type !== 'string') return;
        // Con più finestre di Studio aperte, l'elenco delle annotazioni lo detta solo quella in uso
        if ((inner.type === 'hello' || inner.type === 'annotations:sync') && this.primary && this.primary !== client) return;
        if (inner.type !== 'hello' && inner.type !== 'annotations:sync') this.primary = client;
        this.toOverlay(inner);
        return;
      }
      case 'mouse':
        if (msg.action !== 'move') this.primary = client;
        conn.fire('Input.dispatchMouseEvent', mouseParams(msg));
        return;
      case 'wheel':
        conn.fire('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: Number(msg.x) || 0,
          y: Number(msg.y) || 0,
          deltaX: Math.max(-4000, Math.min(4000, Number(msg.dx) || 0)),
          deltaY: Math.max(-4000, Math.min(4000, Number(msg.dy) || 0)),
          modifiers: Number(msg.mods) & 15,
        });
        return;
      case 'key':
        this.primary = client;
        conn.fire('Input.dispatchKeyEvent', keyParams(msg));
        return;
      case 'text':
        if (typeof msg.text === 'string' && msg.text.length <= 100_000) conn.fire('Input.insertText', { text: msg.text });
        return;
      case 'nav':
        void this.navigate(conn, msg.action);
        return;
      default:
        break;
    }
  }

  private async navigate(conn: CdpConnection, action: 'back' | 'forward' | 'reload'): Promise<void> {
    try {
      if (action === 'reload') {
        await conn.send('Page.reload');
        return;
      }
      const history = await conn.send<{ currentIndex: number; entries: Array<{ id: number }> }>('Page.getNavigationHistory');
      const entry = history.entries[history.currentIndex + (action === 'back' ? -1 : 1)];
      if (entry) await conn.send('Page.navigateToHistoryEntry', { entryId: entry.id });
    } catch {
      /* pagina non raggiungibile */
    }
  }
}

/**
 * Nota mostrata all'avvio: su Windows le app WebView2 (Tauri) usano la stessa porta di debug.
 * Una funzione, non una costante: il testo va scelto dopo --lang, non al caricamento del modulo.
 */
export function electronModeNote(): string {
  return t(isWindows ? 'electron.note.webview' : 'electron.note.chromium');
}
