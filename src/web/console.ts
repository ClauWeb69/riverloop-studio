import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal, type ITheme } from '@xterm/xterm';
import type { ClaudeState, PermissionsMode, TermClientMessage, TermServerMessage } from '../shared/protocol';
import { t } from './i18n';
import { isMac, showFatal } from './ui';

const DARK: ITheme = {
  background: '#121317',
  foreground: '#e3e4e9',
  cursor: '#e3e4e9',
  cursorAccent: '#121317',
  selectionBackground: 'rgba(217, 71, 159, 0.38)',
  black: '#1e1f25',
  red: '#f0716b',
  green: '#5fd08e',
  yellow: '#e8c35a',
  blue: '#6aa7ff',
  magenta: '#d98bd6',
  cyan: '#5bc8d6',
  white: '#d4d6dd',
  brightBlack: '#6b6f7b',
  brightRed: '#ff8a84',
  brightGreen: '#7ee2a6',
  brightYellow: '#f5d77a',
  brightBlue: '#8dbcff',
  brightMagenta: '#e8a6e6',
  brightCyan: '#7fdbe6',
  brightWhite: '#ffffff',
};

const LIGHT: ITheme = {
  background: '#ffffff',
  foreground: '#1f2328',
  cursor: '#1f2328',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(177, 37, 132, 0.22)',
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#8a6100',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#633c01',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#8c959f',
};

type ConnState = 'connecting' | 'open' | 'closed';

export interface ConsoleOptions {
  container: HTMLElement;
  dot: HTMLElement;
  sub: HTMLElement;
  exitOverlay: HTMLElement;
  exitDetail: HTMLElement;
  platform: string;
  windowsBuild: number | null;
  fontFamily: string;
  fontSize: number;
  dark: boolean;
  /** Token di sessione, presentato come sottoprotocollo WebSocket. */
  token: string;
  permissions: PermissionsMode;
  /** Sessione di Claude Code mostrata all'avvio (scheda della console). */
  sessionId: string;
}

/** Console di Claude Code: xterm.js collegato al PTY del companion via /ws/term. */
export class ConsolePanel {
  readonly term: Terminal;
  private readonly fit = new FitAddon();
  private readonly opts: ConsoleOptions;
  private ws: WebSocket | null = null;
  private retry = 0;
  private serverCols = 0;
  private serverRows = 0;
  private awaitingSnapshot = false;
  private claudeState: ClaudeState = 'idle';
  private webgl: WebglAddon | null = null;
  private fitQueued = false;
  private stopped = false;
  /** La dimensione va comunicata al companion appena possibile (dopo ogni collegamento). */
  private sizePending = false;
  permissions: PermissionsMode;
  /** Sessione di Claude Code collegata a questa console. */
  sessionId: string;
  onClaudeState?: (state: ClaudeState, code: number | null) => void;
  onPermissions?: (value: PermissionsMode) => void;
  /** La sessione mostrata è stata chiusa (da questa o da un'altra scheda del browser). */
  onSessionGone?: (id: string) => void;
  /** Il token non vale più (Studio riavviato): la pagina va riaperta dal nuovo link. */
  onUnauthorized?: () => void;

  constructor(opts: ConsoleOptions) {
    this.opts = opts;
    this.permissions = opts.permissions;
    this.sessionId = opts.sessionId;
    this.term = new Terminal({
      allowProposedApi: true,
      fontFamily: opts.fontFamily,
      fontSize: opts.fontSize,
      lineHeight: 1.12,
      cursorBlink: false,
      scrollback: 10000,
      macOptionIsMeta: false,
      macOptionClickForcesSelection: true,
      theme: opts.dark ? DARK : LIGHT,
      windowsPty: opts.platform === 'win32' ? { backend: 'conpty', buildNumber: opts.windowsBuild ?? 19045 } : undefined,
    });
    this.term.loadAddon(this.fit);
    const unicode = new Unicode11Addon();
    this.term.loadAddon(unicode);
    this.term.unicode.activeVersion = '11';
    this.term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener,noreferrer')));
    this.term.open(opts.container);
    this.tryWebgl();

    this.term.onData((data) => this.sendInput(data));
    this.term.attachCustomKeyEventHandler((ev) => this.handleKey(ev));
    this.term.textarea?.addEventListener('focus', () => this.scheduleFit());

    // Incolla un'immagine: Claude Code la legge dagli appunti di sistema con Ctrl+V (Alt+V su Windows).
    opts.container.addEventListener(
      'paste',
      (e) => {
        const dt = e.clipboardData;
        if (!dt) return;
        const hasText = dt.getData('text/plain').length > 0;
        const hasImage = Array.from(dt.items).some((i) => i.kind === 'file' && i.type.startsWith('image/'));
        if (hasImage && !hasText) {
          e.preventDefault();
          e.stopPropagation();
          this.sendInput(opts.platform === 'win32' ? '\x1bv' : '\x16');
        }
      },
      true,
    );

    new ResizeObserver(() => this.scheduleFit()).observe(opts.container);
    // Una scheda aperta in background non ha ancora una dimensione: la misuriamo quando diventa visibile.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.scheduleFit();
    });
    opts.exitOverlay.querySelectorAll<HTMLButtonElement>('[data-restart]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.send({ type: 'restart', mode: btn.dataset.restart as 'continue' | 'resume' | 'new' });
        this.term.focus();
      });
    });
    this.connect();
  }

  private tryWebgl(): void {
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        addon.dispose();
        this.webgl = null;
      });
      this.term.loadAddon(addon);
      this.webgl = addon;
    } catch {
      this.webgl = null; // resta il renderer DOM
    }
  }

  // -------------------------------------------------------------------------
  // Tastiera
  // -------------------------------------------------------------------------
  private handleKey(ev: KeyboardEvent): boolean {
    if (ev.type !== 'keydown') return true;
    const ctrl = ev.ctrlKey && !ev.metaKey;
    // Shift+Enter: nuova riga, come nel terminale nativo configurato per Claude Code
    if (ev.key === 'Enter' && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
      ev.preventDefault();
      this.sendInput('\x1b\r');
      return false;
    }
    if (!isMac) {
      // Copia: Ctrl+Shift+C, oppure Ctrl+C se c'è una selezione (altrimenti Ctrl+C interrompe Claude)
      if (ctrl && ev.code === 'KeyC' && (ev.shiftKey || this.term.hasSelection())) {
        const text = this.term.getSelection();
        if (text) void navigator.clipboard?.writeText(text).catch(() => undefined);
        this.term.clearSelection();
        ev.preventDefault();
        return false;
      }
      // Incolla: lascia fare al browser (evento paste), senza inviare ^V
      if (ctrl && ev.code === 'KeyV') return false;
    }
    // Combinazioni riservate dal browser: arrivano qui solo a schermo intero (Keyboard Lock)
    if (ctrl && !ev.shiftKey && !ev.altKey && (ev.code === 'KeyW' || ev.code === 'KeyT' || ev.code === 'KeyN')) {
      ev.preventDefault();
      this.sendInput(String.fromCharCode(ev.code.charCodeAt(3) - 64));
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Connessione
  // -------------------------------------------------------------------------
  private setConn(state: ConnState, text?: string): void {
    this.opts.dot.dataset.state = state;
    this.opts.dot.title = t(state === 'open' ? 'conn.open' : state === 'connecting' ? 'conn.connecting' : 'conn.closed');
    if (text !== undefined) this.opts.sub.textContent = text;
  }

  private connect(): void {
    this.setConn('connecting');
    const sid = encodeURIComponent(this.sessionId);
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/term?s=${sid}`, [
      'riverloop-studio',
      `rls-token.${this.opts.token}`,
    ]);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setConn('open', this.subtitle());
    };
    ws.onmessage = (ev) => this.onMessage(ev);
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      // 4404: la sessione non esiste più; 4001: chiusa dall'utente
      if (ev.code === 4404 || ev.code === 4001) {
        this.setConn('closed', t('console.sub.sessionClosed'));
        this.onSessionGone?.(this.sessionId);
        return;
      }
      void this.reconnect();
    };
  }

  /** Mostra un'altra sessione di Claude Code (scheda della console). */
  switchTo(id: string): void {
    if (id === this.sessionId && this.ws) return;
    this.sessionId = id;
    const old = this.ws;
    this.ws = null;
    try {
      old?.close(1000, 'cambio sessione');
    } catch {
      /* già chiuso */
    }
    this.retry = 0;
    this.awaitingSnapshot = false;
    this.term.reset();
    this.setClaudeState('idle', null);
    this.connect();
  }

  private async reconnect(): Promise<void> {
    if (this.stopped) return;
    this.retry++;
    const delay = Math.min(5000, 300 * 2 ** Math.min(this.retry, 5));
    this.setConn(this.retry > 4 ? 'closed' : 'connecting', this.retry > 4 ? t('console.sub.unreachable') : t('conn.connecting'));
    // Ogni tre tentativi: se Studio è stato riavviato (token nuovo) inutile continuare a riprovare
    if (this.retry % 3 === 0) {
      try {
        const res = await fetch('/api/config', { cache: 'no-store', headers: { 'X-Studio-Token': this.opts.token } });
        if (res.status === 401) {
          this.stop();
          this.setConn('closed', t('console.sub.unauthorized'));
          showFatal(t('fatal.invalidSession.title'), t('fatal.invalidSession'));
          this.onUnauthorized?.();
          return;
        }
      } catch {
        /* server spento: continuiamo a riprovare */
      }
    }
    setTimeout(() => {
      // Nel frattempo la console può essere passata a un'altra sessione o essere stata fermata
      if (!this.ws && !this.stopped) this.connect();
    }, delay);
  }

  /** Studio è stato chiuso: niente più tentativi di riconnessione. */
  stop(): void {
    this.stopped = true;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, 'Studio chiuso');
    } catch {
      /* già chiuso */
    }
    this.setConn('closed', t('console.sub.studioClosed'));
  }

  private onMessage(ev: MessageEvent): void {
    if (typeof ev.data === 'string') {
      let msg: TermServerMessage;
      try {
        msg = JSON.parse(ev.data) as TermServerMessage;
      } catch {
        return;
      }
      switch (msg.type) {
        case 'hello':
          this.term.reset();
          this.serverCols = msg.cols;
          this.serverRows = msg.rows;
          if (this.term.cols !== msg.cols || this.term.rows !== msg.rows) this.term.resize(msg.cols, msg.rows);
          this.awaitingSnapshot = true;
          this.sizePending = true;
          this.setClaudeState(msg.state, msg.exitCode);
          this.setPermissionsState(msg.permissions);
          break;
        case 'permissions':
          this.setPermissionsState(msg.value);
          break;
        case 'started':
          this.setClaudeState('running', null);
          break;
        case 'exit':
          this.setClaudeState('exited', msg.code);
          break;
        case 'size':
          this.serverCols = msg.cols;
          this.serverRows = msg.rows;
          if (document.activeElement !== this.term.textarea) {
            if (this.term.cols !== msg.cols || this.term.rows !== msg.rows) this.term.resize(msg.cols, msg.rows);
          }
          break;
        default:
          break;
      }
      return;
    }
    const data = new Uint8Array(ev.data as ArrayBuffer);
    if (this.awaitingSnapshot) {
      // Lo snapshot è scritto alla dimensione del PTY; poi la console si adatta al pannello.
      this.awaitingSnapshot = false;
      this.term.write(data, () => this.fitAndSend(true));
    } else {
      this.term.write(data);
    }
  }

  private send(msg: TermClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  sendInput(data: string): void {
    if (this.claudeState !== 'running') return;
    this.send({ type: 'input', data });
  }

  // -------------------------------------------------------------------------
  // Dimensioni
  // -------------------------------------------------------------------------
  scheduleFit(): void {
    if (this.fitQueued) return;
    this.fitQueued = true;
    requestAnimationFrame(() => {
      this.fitQueued = false;
      this.fitAndSend(false);
    });
  }

  private fitAndSend(force: boolean): void {
    if (!this.opts.container.offsetWidth || !this.opts.container.offsetHeight) return;
    const dims = this.fit.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows) || dims.cols < 2 || dims.rows < 2) return;
    if (this.awaitingSnapshot) return;
    if (dims.cols !== this.term.cols || dims.rows !== this.term.rows) this.term.resize(dims.cols, dims.rows);
    // Il primo resize dopo il collegamento serve anche ad avviare claude: va sempre inviato.
    if (force || this.sizePending || dims.cols !== this.serverCols || dims.rows !== this.serverRows) {
      this.serverCols = dims.cols;
      this.serverRows = dims.rows;
      this.sizePending = false;
      this.send({ type: 'resize', cols: dims.cols, rows: dims.rows });
    }
  }

  // -------------------------------------------------------------------------
  // Stato di Claude e aspetto
  // -------------------------------------------------------------------------
  private subtitle(): string {
    if (this.claudeState === 'running') return t('console.sub.running');
    if (this.claudeState === 'idle') return t('console.sub.starting');
    return t('console.sub.exited');
  }

  private setClaudeState(state: ClaudeState, code: number | null): void {
    this.claudeState = state;
    this.opts.exitOverlay.hidden = state !== 'exited';
    if (state === 'exited') {
      this.opts.exitDetail.textContent = code === null || code === undefined ? t('exit.detail') : t('exit.detailCode', { code });
    }
    if (this.ws?.readyState === WebSocket.OPEN) this.opts.sub.textContent = this.subtitle();
    this.onClaudeState?.(state, code);
  }

  get running(): boolean {
    return this.claudeState === 'running';
  }

  private setPermissionsState(value: PermissionsMode | undefined): void {
    if (value !== 'ask' && value !== 'skip') return;
    this.permissions = value;
    this.onPermissions?.(value);
  }

  /** Chiede al companion di cambiare i permessi (riavvia claude con --continue se attivo). */
  requestPermissions(value: PermissionsMode): void {
    this.send({ type: 'permissions', value });
  }

  setFont(family: string, size: number): void {
    this.term.options.fontFamily = family;
    this.term.options.fontSize = size;
    // Il renderer WebGL rigenera l'atlante dei glifi al cambio di carattere
    this.webgl?.clearTextureAtlas();
    this.scheduleFit();
  }

  setDark(dark: boolean): void {
    this.term.options.theme = dark ? DARK : LIGHT;
  }

  focus(): void {
    this.term.focus();
  }

  /** Testo visibile e scrollback (diagnostica e test end-to-end). */
  text(): string {
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    return lines.join('\n').replace(/\n+$/, '');
  }
}
