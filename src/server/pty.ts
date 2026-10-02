import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { WebSocket } from 'ws';
import type { ClaudeState, ClaudeStatus, PermissionModeName, TermClientMessage, TermServerMessage } from '../shared/protocol.js';
import { t } from './i18n.js';
import { effortIndicator, inputBoxText, pasteStillInInput, permissionMode, screenState } from './tui.js';
import { commandLine, isWindows, log, sanitizeForTerminal, type ResolvedCommand } from './util.js';

// I pacchetti xterm sono CommonJS: li carichiamo con require per avere le classi senza sorprese.
const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = require('@xterm/headless') as typeof import('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize');
const { Unicode11Addon } = require('@xterm/addon-unicode11') as typeof import('@xterm/addon-unicode11');

// ---------------------------------------------------------------------------
// node-pty (ufficiale, con binari precompilati per Windows e macOS) oppure il fork
// @lydell/node-pty (binari precompilati anche per Linux/WSL).
// ---------------------------------------------------------------------------
interface IPtyLike {
  readonly pid: number;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface PtyModule {
  spawn(
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
      useConptyDll?: boolean;
    },
  ): IPtyLike;
}

let ptyModulePromise: Promise<{ module: PtyModule; name: string }> | null = null;

export function loadPty(): Promise<{ module: PtyModule; name: string }> {
  ptyModulePromise ??= (async () => {
    const errors: string[] = [];
    for (const name of ['node-pty', '@lydell/node-pty']) {
      try {
        const mod = (await import(name)) as { spawn?: PtyModule['spawn']; default?: PtyModule };
        const resolved = (typeof mod.spawn === 'function' ? mod : mod.default) as PtyModule | undefined;
        if (resolved && typeof resolved.spawn === 'function') return { module: resolved, name };
        errors.push(t('pty.noSpawn', { name }));
      } catch (err) {
        errors.push(`${name}: ${(err as Error).message.split('\n')[0]}`);
      }
    }
    throw new Error(t('pty.unavailable', { errors: errors.join('; ') }));
  })();
  return ptyModulePromise;
}

/**
 * Chiude il PTY su Windows. node-pty, per elencare i processi della console, avvia un piccolo
 * processo di servizio che eredita il nostro terminale: se claude è già uscito quel processo
 * fallisce ("AttachConsole failed") e stampa il suo errore in mezzo ai messaggi di Studio.
 * Qui parte senza terminale: l'esito non cambia (i processi sono comunque chiusi), l'errore
 * non si vede più.
 */
function killWindowsPty(pty: IPtyLike): void {
  const childProcess = require('node:child_process') as typeof import('node:child_process');
  const fork = childProcess.fork;
  childProcess.fork = ((modulePath: string, args?: readonly string[], options?: object) =>
    fork(modulePath, args as string[], { ...options, silent: true })) as typeof fork;
  try {
    pty.kill();
  } finally {
    childProcess.fork = fork;
  }
}

/** Risposte automatiche del terminale (DA, CPR, DECRQM, OSC, DCS...). */

const TERMINAL_RESPONSE =
  /^(?:\x1b\[\?[\d;]*c|\x1b\[>[\d;]*c|\x1b\[\d+;\d+R|\x1b\[\??[\d;]*\$y|\x1b\[\?\d*u|\x1b\[\d*n|\x1b\[[\d;]*t|\x1b\]\d+;[^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[\s\S]*?\x1b\\)$/;

const MIN_COLS = 20;
const MAX_COLS = 500;
const MIN_ROWS = 5;
const MAX_ROWS = 300;
const SNAPSHOT_SCROLLBACK = 3000;

interface TermClient {
  ws: WebSocket;
  ready: boolean;
  queue: Buffer[];
}

export type StartMode = 'initial' | 'continue' | 'resume' | 'new';
/** ask = permessi standard di Claude Code (sue modalità e impostazioni); skip = --dangerously-skip-permissions. */
export type Permissions = 'ask' | 'skip';

const SKIP_FLAG = '--dangerously-skip-permissions';

export interface ClaudeSessionOptions {
  command: ResolvedCommand;
  /** Argomenti extra (--claude-args). */
  extraArgs: string[];
  /** true con --resume: la prima sessione parte con "claude --resume". */
  resumeFirst: boolean;
  cwd: string;
  permissions: Permissions;
  /** Variabili d'ambiente aggiunte al processo claude (hook delle modalità desktop). */
  extraEnv?: () => Record<string, string>;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Argomenti extra senza --continue/-c e --resume/-r [id]: li decide Studio per ogni avvio. */
export function withoutResumeArgs(extra: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < extra.length; i++) {
    const a = extra[i];
    if (a === '--continue' || a === '-c') continue;
    if (a === '--resume' || a === '-r') {
      if (i + 1 < extra.length && !extra[i + 1].startsWith('-')) i++;
      continue;
    }
    if (a.startsWith('--resume=')) continue;
    out.push(a);
  }
  return out;
}

/** Cartella dei dati di Claude Code (~/.claude, oppure CLAUDE_CONFIG_DIR). */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/**
 * Conversazione su cui sta lavorando il processo claude con questo pid. Claude Code la scrive
 * in <config>/sessions/<pid>.json e la aggiorna anche dopo /clear o /resume.
 */
export async function readConversationId(pid: number): Promise<string | null> {
  try {
    const data = JSON.parse(await readFile(path.join(claudeConfigDir(), 'sessions', `${pid}.json`), 'utf8')) as {
      pid?: unknown;
      sessionId?: unknown;
    };
    if (data.pid !== pid || typeof data.sessionId !== 'string' || !UUID_RE.test(data.sessionId)) return null;
    return data.sessionId;
  } catch {
    return null;
  }
}
/** Esito di un incolla: fatto, claude non attivo, oppure claude aspetta una risposta. */
export type PasteResult = 'ok' | 'not-running' | 'awaiting-answer';
/** Per --debug: il contenuto del riquadro di input (o "?" se non riconosciuto), abbreviato. */
const boxPreview = (screen: string[]) => {
  const box = inputBoxText(screen);
  return box === null ? '?' : box.replace(/\s+/g, ' ').slice(0, 120);
};

/**
 * Il processo claude in un PTY, con un terminale "specchio" headless che conserva lo
 * schermo: ogni nuova scheda (o ricaricamento) riceve lo stato esatto della console.
 */
export function emptyStatus(): ClaudeStatus {
  return { model: null, modelId: null, effort: null, ultracode: null, fiveHour: null, sevenDay: null, context: null, costUsd: null, mode: null };
}

/** Sequenze di controllo del terminale (CSI e OSC), tolte per cercare testo nell'output. */
const ANSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * Cosa cambia nello stato rileggendo lo schermo: modalità dei permessi, effort e ultracode
 * (dall'indicatore sopra il riquadro, solo se readIndicator). L'effort arriva anche dalla status
 * line: vince il valore arrivato per ultimo, quindi l'indicatore conta solo quando cambia rispetto
 * all'ultima lettura (lastIndicator, "livello|ultracode"), non a ogni rilettura dello schermo.
 * Senza riquadro di input (Claude al lavoro, un menu aperto...) resta l'ultimo valore noto.
 */
export function screenStatusPatch(
  status: ClaudeStatus,
  screen: string[],
  lastIndicator: string | null,
  readIndicator = true,
): { patch: Partial<ClaudeStatus>; lastIndicator: string | null } {
  const patch: Partial<ClaudeStatus> = {};
  const mode = permissionMode(screen);
  if (mode && mode !== status.mode) patch.mode = mode;
  const indicator = readIndicator ? effortIndicator(screen) : null;
  const key = indicator && `${indicator.level}|${indicator.ultracode}`;
  if (indicator && key !== lastIndicator) {
    if (indicator.level !== status.effort) patch.effort = indicator.level;
    if (indicator.ultracode !== status.ultracode) patch.ultracode = indicator.ultracode;
    return { patch, lastIndicator: key };
  }
  return { patch, lastIndicator };
}

export class ClaudeSession extends EventEmitter {
  /** Numero della scheda nella console di Studio. */
  id = '1';
  name = 'Claude 1';
  /** Nome scelto dall'utente (non "Claude <n>"). */
  renamed = false;
  /** Ultima conversazione nota di questo processo: i riavvii riprendono proprio questa. */
  conversationId: string | null = null;
  /** Scheda chiusa: il processo non deve più ripartire. */
  closed = false;
  private conversationTimer: NodeJS.Timeout | null = null;
  state: ClaudeState = 'idle';
  exitCode: number | null = null;
  cols = 100;
  rows = 30;
  private readonly opts: ClaudeSessionOptions;
  private pty: IPtyLike | null = null;
  private starting = false;
  private readonly mirror: InstanceType<typeof HeadlessTerminal>;
  private readonly serializer: InstanceType<typeof SerializeAddon>;
  private cursorHidden = false;
  private readonly clients = new Set<TermClient>();
  private primary: TermClient | null = null;
  private exitWaiters: Array<() => void> = [];
  /** Riavvio voluto (cambio dei permessi): l'uscita non va segnalata come "sessione terminata". */
  private restarting = false;
  private lastOutputAt = 0;
  permissions: Permissions;
  /** Modello, effort e utilizzo (dalla status line di Claude Code) e modalità (dallo schermo). */
  status: ClaudeStatus = emptyStatus();
  private modeTimer: NodeJS.Timeout | null = null;
  /** Ultimo indicatore dell'effort letto dallo schermo ("livello|ultracode"). */
  private lastIndicator: string | null = null;
  /** Il processo attuale ha già disegnato l'indicatore dell'effort (vedi resetScreenStatus). */
  private indicatorDrawn = false;
  private indicatorTail = '';

  constructor(opts: ClaudeSessionOptions) {
    super();
    this.opts = opts;
    this.permissions = opts.permissions;
    this.mirror = new HeadlessTerminal({
      cols: this.cols,
      rows: this.rows,
      scrollback: 5000,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.mirror.loadAddon(this.serializer as never);
    const unicode = new Unicode11Addon();
    this.mirror.loadAddon(unicode as never);
    this.mirror.unicode.activeVersion = '11';
    // La visibilità del cursore non fa parte dello snapshot: la tracciamo a parte.
    const has25 = (params: (number | number[])[]) => params.some((p) => p === 25);
    this.mirror.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      if (has25(params)) this.cursorHidden = false;
      return false;
    });
    this.mirror.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
      if (has25(params)) this.cursorHidden = true;
      return false;
    });
  }

  get pid(): number | null {
    return this.pty?.pid ?? null;
  }

  /** Millisecondi dall'ultimo output di claude (mentre lavora l'indicatore si muove di continuo). */
  get quietMs(): number {
    return Date.now() - this.lastOutputAt;
  }

  // -------------------------------------------------------------------------
  // Avvio e arresto
  // -------------------------------------------------------------------------
  private argsFor(mode: StartMode): string[] {
    // Il flag dei permessi lo decide solo la scelta corrente (riga di comando o pagina Studio).
    const extra = this.opts.extraArgs.filter((a) => a !== SKIP_FLAG);
    const perms = this.permissions === 'skip' ? [SKIP_FLAG] : [];
    return [...perms, ...this.modeArgs(mode, extra)];
  }

  private modeArgs(mode: StartMode, extra: string[]): string[] {
    if (mode === 'initial') return this.opts.resumeFirst ? ['--resume', ...withoutResumeArgs(extra)] : [...extra];
    // Per i riavvii togliamo eventuali --resume/--continue già presenti negli argomenti extra.
    const filtered = withoutResumeArgs(extra);
    // Con più schede nella stessa cartella "--continue" riprenderebbe l'ultima conversazione
    // della cartella, magari di un'altra scheda: se la conosciamo, riprendiamo la nostra.
    if (mode === 'continue') return this.conversationId ? ['--resume', this.conversationId, ...filtered] : ['--continue', ...filtered];
    if (mode === 'resume') return ['--resume', ...filtered];
    return filtered;
  }

  /** Segue la conversazione del processo (cambia con /clear e /resume). */
  private trackConversation(pid: number): void {
    this.stopTrackingConversation();
    const read = async () => {
      if (this.pty?.pid !== pid) return;
      const id = await readConversationId(pid);
      if (id && this.pty?.pid === pid && id !== this.conversationId) {
        this.conversationId = id;
        this.emit('conversation', id);
      }
    };
    this.conversationTimer = setInterval(() => void read(), 2500);
    this.conversationTimer.unref();
    setTimeout(() => void read(), 1200).unref();
  }

  private stopTrackingConversation(): void {
    if (this.conversationTimer) clearInterval(this.conversationTimer);
    this.conversationTimer = null;
  }

  async start(mode: StartMode): Promise<void> {
    if (this.state === 'running' || this.starting || this.closed) return;
    this.starting = true;
    try {
      const { module } = await loadPty();
      const argv = this.argsFor(mode);
      const { file, args } = commandLine(this.opts.command, argv);
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
      env.TERM = 'xterm-256color';
      env.COLORTERM = 'truecolor';
      // Evita che claude pensi di essere annidato in un'altra sessione di Claude Code (Studio
      // lanciato da dentro Claude Code): da "sessione figlia" non salverebbe la conversazione,
      // e "Riprendi" non avrebbe nulla da riprendere.
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_CHILD_SESSION;
      Object.assign(env, this.opts.extraEnv?.() ?? {});

      if (mode !== 'initial') {
        const label =
          mode === 'continue'
            ? argv.includes('--continue')
              ? 'claude --continue'
              : t('pty.restart.same')
            : mode === 'resume'
              ? 'claude --resume'
              : t('pty.restart.new');
        const banner = t('pty.restart.banner', { label: this.permissions === 'skip' ? t('pty.restart.skip', { label }) : label });
        this.broadcastOutput(`\r\n\x1b[2m${banner}\x1b[0m\r\n`);
      }

      // Nuova conversazione o scelta dall'elenco: quella precedente non vale più
      if (mode === 'new' || mode === 'resume' || (mode === 'initial' && this.opts.resumeFirst)) this.conversationId = null;
      const pty = module.spawn(file, this.opts.command.viaCmd ? args.join(' ') : args, {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: this.opts.cwd,
        env,
        useConptyDll: isWindows && process.env.RIVERLOOP_STUDIO_CONPTY_DLL === '1',
      });
      this.pty = pty;
      this.resetScreenStatus();
      this.state = 'running';
      this.exitCode = null;
      pty.onData((data) => this.ptyOutput(data));
      this.trackConversation(pty.pid);
      pty.onExit(({ exitCode }) => {
        if (this.pty !== pty) return;
        this.stopTrackingConversation();
        this.pty = null;
        this.state = 'exited';
        this.exitCode = exitCode;
        if (!this.restarting) {
          this.sendJson({ type: 'exit', code: exitCode });
          this.emit('state', this.state, exitCode);
        }
        const waiters = this.exitWaiters;
        this.exitWaiters = [];
        waiters.forEach((w) => w());
      });
      this.sendJson({ type: 'started' });
      this.emit('state', this.state, null);
    } catch (err) {
      this.state = 'exited';
      this.exitCode = -1;
      const msg = (err as Error).message.replace(/\n/g, '\r\n');
      this.broadcastOutput(`\r\n\x1b[31m${t('pty.startFailed')}\x1b[0m ${msg}\r\n`);
      this.sendJson({ type: 'exit', code: -1 });
      this.emit('state', this.state, -1);
    } finally {
      this.starting = false;
    }
  }

  /** Chiude claude (e i processi del suo gruppo) aspettando che termini. */
  async stop(timeoutMs = 4000): Promise<void> {
    const pty = this.pty;
    if (!pty || this.state !== 'running') return;
    const exited = new Promise<void>((resolve) => this.exitWaiters.push(resolve));
    const pid = pty.pid;
    try {
      if (isWindows) killWindowsPty(pty);
      else {
        try {
          process.kill(-pid, 'SIGHUP');
        } catch {
          pty.kill('SIGHUP');
        }
      }
    } catch {
      /* già terminato */
    }
    const timer = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs));
    const result = await Promise.race([exited.then(() => 'exited' as const), timer]);
    if (result === 'timeout') {
      try {
        if (isWindows) killWindowsPty(pty);
        else process.kill(-pid, 'SIGKILL');
      } catch {
        /* già terminato */
      }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 1500))]);
    }
    if (!isWindows) {
      // Eventuali figli rimasti nel gruppo del processo claude
      try {
        process.kill(-pid, 0);
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* nessun processo rimasto */
      }
    }
  }

  // -------------------------------------------------------------------------
  // Output verso il browser
  // -------------------------------------------------------------------------
  /** Output del processo claude: come broadcastOutput, e segue il primo disegno dell'indicatore dell'effort. */
  private ptyOutput(data: string): void {
    if (!this.indicatorDrawn) {
      // Gli ultimi caratteri restano da un pezzo all'altro: "/effort" può arrivare spezzato
      const text = this.indicatorTail + data.replace(ANSI_SEQUENCE, '');
      if (text.includes('/effort')) this.indicatorDrawn = true;
      this.indicatorTail = text.slice(-16);
    }
    this.broadcastOutput(data);
  }

  /**
   * Nuovo processo: ultracode vale solo per la sessione di Claude Code, quindi torna sconosciuto.
   * Lo specchio conserva però lo schermo del processo precedente (con il suo indicatore): finché
   * il nuovo processo non disegna il proprio indicatore, effort e ultracode non si leggono dallo schermo.
   */
  private resetScreenStatus(): void {
    this.lastIndicator = null;
    this.indicatorDrawn = false;
    this.indicatorTail = '';
    if (this.status.ultracode !== null) {
      this.status = { ...this.status, ultracode: null };
      this.emit('status');
    }
  }

  private broadcastOutput(data: string): void {
    this.lastOutputAt = Date.now();
    this.mirror.write(data);
    this.scheduleModeCheck();
    const buf = Buffer.from(data, 'utf8');
    for (const client of this.clients) {
      if (client.ready) {
        if (client.ws.readyState === client.ws.OPEN) client.ws.send(buf, { binary: true });
      } else {
        client.queue.push(buf);
      }
    }
  }

  private sendJson(msg: TermServerMessage, only?: TermClient): void {
    const text = JSON.stringify(msg);
    const targets = only ? [only] : [...this.clients];
    for (const client of targets) {
      if (client.ws.readyState === client.ws.OPEN) client.ws.send(text);
    }
  }

  /** Collega una scheda del browser: riceve subito lo schermo attuale, poi l'output dal vivo. */
  attach(ws: WebSocket): void {
    const client: TermClient = { ws, ready: false, queue: [] };
    this.clients.add(client);
    this.sendJson({ type: 'hello', cols: this.cols, rows: this.rows, state: this.state, exitCode: this.exitCode, permissions: this.permissions }, client);

    // La scrittura vuota fa da segnaposto: quando viene elaborata, lo specchio contiene
    // tutto l'output arrivato prima del collegamento; il resto è in coda per questo client.
    this.mirror.write('', () => {
      if (!this.clients.has(client)) return;
      let snapshot = this.serializer.serialize({ scrollback: SNAPSHOT_SCROLLBACK });
      if (this.cursorHidden) snapshot += '\x1b[?25l';
      // Inviato anche se vuoto: il client lo usa come segnale per adattare la console al pannello.
      if (ws.readyState === ws.OPEN) ws.send(Buffer.from(snapshot, 'utf8'), { binary: true });
      for (const chunk of client.queue) if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
      client.queue = [];
      client.ready = true;
    });

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let msg: TermClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as TermClientMessage;
      } catch {
        return;
      }
      this.handleMessage(client, msg);
    });
    ws.on('close', () => {
      this.clients.delete(client);
      if (this.primary === client) this.primary = null;
    });
    ws.on('error', () => undefined);
  }

  private handleMessage(client: TermClient, msg: TermClientMessage): void {
    switch (msg?.type) {
      case 'input': {
        if (typeof msg.data !== 'string' || msg.data.length > 1_000_000) return;
        if (this.state !== 'running' || !this.pty) return;
        if (TERMINAL_RESPONSE.test(msg.data)) {
          // Con più schede aperte risponde solo quella attiva, per evitare risposte doppie.
          if (this.primary && this.primary !== client) return;
        } else {
          this.primary = client;
        }
        this.pty.write(msg.data);
        break;
      }
      case 'resize':
        this.resize(client, msg.cols, msg.rows);
        break;
      case 'restart':
        if (this.state !== 'running' && ['continue', 'resume', 'new'].includes(msg.mode)) {
          void this.start(msg.mode);
        }
        break;
      case 'permissions':
        if (msg.value === 'ask' || msg.value === 'skip') void this.setPermissions(msg.value);
        break;
      default:
        break;
    }
  }

  private resize(client: TermClient, colsIn: unknown, rowsIn: unknown): void {
    const cols = Math.floor(Number(colsIn));
    const rows = Math.floor(Number(rowsIn));
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    const nextCols = Math.min(MAX_COLS, Math.max(MIN_COLS, cols));
    const nextRows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, rows));
    this.primary = client;
    if (nextCols !== this.cols || nextRows !== this.rows) {
      this.cols = nextCols;
      this.rows = nextRows;
      this.mirror.resize(nextCols, nextRows);
      try {
        this.pty?.resize(nextCols, nextRows);
      } catch {
        /* processo appena terminato */
      }
      // Le altre schede adeguano la propria console alla nuova dimensione.
      for (const other of this.clients) {
        if (other !== client && other.ws.readyState === other.ws.OPEN) {
          other.ws.send(JSON.stringify({ type: 'size', cols: nextCols, rows: nextRows }));
        }
      }
    }
    // claude parte quando la prima scheda ha comunicato la dimensione della console,
    // così il primo disegno dell'interfaccia è già della misura giusta.
    if (this.state === 'idle' && !this.starting) void this.start('initial');
  }

  // -------------------------------------------------------------------------
  // Annotazioni
  // -------------------------------------------------------------------------
  /**
   * Cambia i permessi di Claude Code. Se claude è in esecuzione lo riavvia riprendendo la
   * stessa conversazione (--continue); altrimenti la scelta vale dal prossimo avvio.
   */
  async setPermissions(value: Permissions): Promise<void> {
    if (value === this.permissions) return;
    this.permissions = value;
    this.sendJson({ type: 'permissions', value });
    this.emit('permissions', value);
    if (this.state !== 'running') return;
    // Ultima lettura della conversazione prima di chiudere (potrebbe essere appena cambiata)
    const pid = this.pty?.pid;
    if (pid) this.conversationId = (await readConversationId(pid)) ?? this.conversationId;
    this.restarting = true;
    try {
      await this.stop();
    } finally {
      this.restarting = false;
    }
    await this.start('continue');
  }

  /**
   * Incolla un testo nell'input di Claude Code come farebbe il terminale (bracketed paste),
   * così gli a capo non inviano il messaggio a metà. Con submit=true preme anche Invio:
   * aspetta che Claude Code abbia finito di elaborare l'incolla e poi controlla sullo schermo
   * che il testo non sia rimasto nel riquadro di input (in quel caso ripete Invio).
   */
  async paste(text: string, submit: boolean): Promise<PasteResult> {
    const pty = this.pty;
    if (!pty || this.state !== 'running') return 'not-running';
    // Con una richiesta di permesso o un menu aperti il testo finirebbe lì (e l'Invio
    // risponderebbe alla richiesta): prima l'utente deve rispondere nella console.
    if (await this.awaitingAnswer()) return 'awaiting-answer';
    if (this.pty !== pty) return 'not-running';
    const clean = sanitizeForTerminal(text).replace(/\n/g, '\r');
    const bracketed = this.mirror.modes.bracketedPasteMode;
    // Senza bracketed paste (raro: terminali o versioni che non lo attivano) ogni a capo
    // diventa Alt+Invio, che in Claude Code va a capo senza inviare.
    if (bracketed) pty.write(`\x1b[200~${clean}\x1b[201~`);
    else pty.write(clean.replace(/\r/g, '\x1b\r'));
    log.debug(`incolla ${clean.length} caratteri (${bracketed ? 'bracketed paste' : 'Alt+Invio per gli a capo'})${submit ? ', invio automatico' : ''}`);
    if (submit) {
      const firstLine = sanitizeForTerminal(text).split('\n')[0];
      void this.submitPasted(pty, firstLine);
    }
    return 'ok';
  }

  // -------------------------------------------------------------------------
  // Modalità, comandi e stato (barra di Claude nella pagina)
  // -------------------------------------------------------------------------
  /**
   * Rilegge modalità, effort e ultracode dallo schermo poco dopo l'ultimo output (non a ogni
   * carattere): così la barra segue subito anche ciò che l'utente cambia nella console.
   */
  private scheduleModeCheck(): void {
    if (this.modeTimer) return;
    this.modeTimer = setTimeout(() => {
      this.modeTimer = null;
      void this.screenLines().then((screen) => {
        const { patch, lastIndicator } = screenStatusPatch(this.status, screen, this.lastIndicator, this.indicatorDrawn);
        this.lastIndicator = lastIndicator;
        if (Object.keys(patch).length) {
          this.status = { ...this.status, ...patch };
          this.emit('status');
        }
      });
    }, 250);
    this.modeTimer.unref();
  }

  /** Aggiorna modello, effort e utilizzo con i dati della status line. */
  setStatus(patch: Partial<ClaudeStatus>): void {
    // Un effort mancante nel JSON non cancella quello noto (letto anche dallo schermo)
    if (patch.effort === null) {
      patch = { ...patch };
      delete patch.effort;
    }
    const next = { ...this.status, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.status)) return;
    this.status = next;
    this.emit('status');
  }

  /**
   * Esegue un comando di Claude Code (es. "/model sonnet") come se l'utente lo scrivesse nel
   * riquadro di input e premesse Invio. Solo con il riquadro di input riconosciuto e vuoto:
   * con una richiesta aperta Invio risponderebbe a quella, e un testo già scritto dall'utente
   * finirebbe mescolato al comando.
   */
  async runCommand(command: string): Promise<'ok' | 'not-running' | 'awaiting-answer' | 'input-not-empty'> {
    const typed = await this.typeCommand(command);
    if (typeof typed === 'string') return typed;
    void typed.submitted;
    return 'ok';
  }

  /**
   * Attiva o disattiva ultracode ("/effort ultracode on|off") e aspetta che Claude Code lo
   * confermi: 'ok' solo quando l'indicatore sopra il riquadro mostra il nuovo valore. Claude Code
   * può rifiutare il comando (ultracode non disponibile per il modello o il piano).
   */
  async setUltracode(value: boolean): Promise<'ok' | 'not-running' | 'awaiting-answer' | 'input-not-empty' | 'ultracode-unconfirmed'> {
    const pty = this.pty;
    const typed = await this.typeCommand(`/effort ultracode ${value ? 'on' : 'off'}`);
    if (typeof typed === 'string') return typed;
    if (!(await typed.submitted)) {
      if (this.pty !== pty || this.state !== 'running') return 'not-running';
      // Invio non premuto (richiesta o menu apparsi nel frattempo) oppure comando rimasto nel riquadro
      return (await this.awaitingAnswer()) ? 'awaiting-answer' : 'ultracode-unconfirmed';
    }
    for (let i = 0; i < 30 && this.indicatorDrawn && this.pty === pty; i++) {
      const indicator = effortIndicator(await this.screenLines());
      if (indicator?.ultracode === value) {
        this.lastIndicator = `${indicator.level}|${indicator.ultracode}`;
        if (this.status.ultracode !== value) {
          this.status = { ...this.status, ultracode: value };
          this.emit('status');
        }
        return 'ok';
      }
      await delay(100);
    }
    log.debug(`ultracode ${value ? 'on' : 'off'}: l'indicatore di Claude Code non lo conferma`);
    return 'ultracode-unconfirmed';
  }

  /**
   * Scrive un comando nel riquadro di input (vuoto) e preme Invio: submitted dice se il comando
   * ha lasciato il riquadro dopo l'Invio.
   */
  private async typeCommand(command: string): Promise<'not-running' | 'awaiting-answer' | 'input-not-empty' | { submitted: Promise<boolean> }> {
    const pty = this.pty;
    if (!pty || this.state !== 'running') return 'not-running';
    const screen = await this.screenLines();
    if (screenState(screen) !== 'input') return 'awaiting-answer';
    if (await this.typedInput()) return 'input-not-empty';
    if (this.pty !== pty) return 'not-running';
    const clean = sanitizeForTerminal(command).replace(/\n/g, ' ');
    log.debug(`comando per Claude Code: ${clean}`);
    if (clean.length <= 60 || !this.mirror.modes.bracketedPasteMode) {
      // Come chi lo scrive a mano: un comando breve digitato non è un incolla, che Claude Code
      // elabora in modo asincrono (e che su Windows ConPTY consegna a pezzi)
      for (const ch of clean) {
        if (this.pty !== pty) return 'not-running';
        pty.write(ch);
        await delay(12);
      }
    } else {
      pty.write(`\x1b[200~${clean}\x1b[201~`);
    }
    // Invio con la stessa cautela dell'invio automatico: ripetuto solo se il comando è ancora,
    // con certezza, nel riquadro di input
    return { submitted: this.submitPasted(pty, clean) };
  }

  /**
   * Porta Claude Code nella modalità indicata premendo Shift+Tab (come farebbe l'utente),
   * controllando lo schermo dopo ogni pressione. Si ferma se la modalità non compare dopo un
   * giro completo (per esempio "salta permessi" senza averla abilitata all'avvio).
   */
  async cycleMode(target: PermissionModeName): Promise<'ok' | 'not-running' | 'awaiting-answer' | 'unknown-mode' | 'unavailable'> {
    const pty = this.pty;
    if (!pty || this.state !== 'running') return 'not-running';
    for (let press = 0; press <= 6; press++) {
      const screen = await this.screenLines();
      if (screenState(screen) !== 'input') return 'awaiting-answer';
      const mode = permissionMode(screen);
      if (!mode) return 'unknown-mode';
      if (mode !== this.status.mode) {
        this.status = { ...this.status, mode };
        this.emit('status');
      }
      if (mode === target) return 'ok';
      if (press === 6 || this.pty !== pty) break;
      pty.write('\x1b[Z');
      // Attende che il testo della modalità cambi (al più 1,5 secondi)
      for (let i = 0; i < 15; i++) {
        await delay(100);
        if (permissionMode(await this.screenLines()) !== mode) break;
      }
    }
    return 'unavailable';
  }

  /**
   * true se Claude Code non mostra con certezza il riquadro di input: una richiesta di permesso,
   * un menu, o una schermata che Studio non riconosce (per esempio dopo un aggiornamento di
   * Claude Code). Nel dubbio no: testo e Invio potrebbero rispondere a una richiesta.
   */
  async awaitingAnswer(): Promise<boolean> {
    if (this.state !== 'running') return false;
    return screenState(await this.screenLines()) !== 'input';
  }

  /** Attende che claude smetta di scrivere (quietMs di silenzio, tra minMs e maxMs). */
  private async settle(quietMs: number, minMs: number, maxMs: number): Promise<void> {
    const start = Date.now();
    for (;;) {
      const now = Date.now();
      if (now - start >= maxMs) return;
      if (now - start >= minMs && now - this.lastOutputAt >= quietMs) return;
      await delay(30);
    }
  }

  /** Righe visibili della console (come le vede l'utente). */
  async screenLines(): Promise<string[]> {
    await new Promise<void>((r) => this.mirror.write('', r));
    const buf = this.mirror.buffer.active;
    const lines: string[] = [];
    for (let i = buf.baseY; i < buf.baseY + this.mirror.rows; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    return lines;
  }

  /**
   * Come screenLines, ma con il testo attenuato (dim) sostituito da spazi: è così che Claude Code
   * disegna il suggerimento nel riquadro vuoto ("Try …"), che non è testo scritto dall'utente.
   */
  private async screenLinesWithoutDim(): Promise<string[]> {
    await new Promise<void>((r) => this.mirror.write('', r));
    const buf = this.mirror.buffer.active;
    const lines: string[] = [];
    for (let i = buf.baseY; i < buf.baseY + this.mirror.rows; i++) {
      const line = buf.getLine(i);
      if (!line) {
        lines.push('');
        continue;
      }
      let text = '';
      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x);
        if (!cell || cell.getWidth() === 0) continue;
        text += cell.isDim() ? ' '.repeat(cell.getWidth()) : cell.getChars() || ' ';
      }
      lines.push(text.replace(/\s+$/, ''));
    }
    return lines;
  }

  /** Testo scritto nel riquadro di input (senza "❯" e senza il suggerimento attenuato); null se il riquadro non c'è. */
  private async typedInput(): Promise<string | null> {
    // Anche le linee del riquadro sono attenuate: restano com'erano, si tolgono solo i testi
    const normal = await this.screenLines();
    const plain = await this.screenLinesWithoutDim();
    const box = inputBoxText(normal.map((line, i) => (/─{10,}/.test(line) ? line : plain[i])));
    let typed = box === null ? null : box.replace(/^(?:│\s*)?[❯>]\s?/, '').trim();
    // Con NO_COLOR il suggerimento non è attenuato: lo si riconosce dal testo e dal cursore, che
    // con il riquadro vuoto sta subito dopo "❯" (con del testo scritto starebbe dopo il testo)
    const buf = this.mirror.buffer.active;
    const cursorRow = normal[buf.cursorY] ?? '';
    if (typed && /^Try "[^"]*"$/.test(typed) && /^(?:│\s*)?[❯>]/.test(cursorRow) && buf.cursorX <= cursorRow.indexOf(typed)) typed = '';
    log.debug(`riquadro di input: scritto ${JSON.stringify(typed)}`);
    return typed;
  }

  /**
   * Preme Invio dopo l'incolla e controlla che il messaggio sia partito. Claude Code può
   * elaborare l'incolla in modo asincrono (su Windows ConPTY consegna l'input a pezzi): un
   * Invio arrivato troppo presto finirebbe dentro il testo incollato. Invio viene ripetuto
   * solo se il testo è ancora, con certezza, nel riquadro di input (mai con una finestra di
   * conferma aperta, dove un Invio approverebbe la richiesta). true se il testo ha lasciato il
   * riquadro di input dopo l'Invio.
   */
  private async submitPasted(pty: IPtyLike, firstLine: string): Promise<boolean> {
    await this.settle(200, isWindows ? 500 : 300, 4000);
    if (this.pty !== pty) return false;
    const before = await this.screenLines();
    const state = screenState(before);
    if (state !== 'input') {
      log.debug(
        `invio automatico: ${state === 'awaiting-answer' ? 'Claude Code aspetta una risposta (permesso o menu)' : 'schermata non riconosciuta'}, Invio non premuto`,
      );
      this.emit('autosend', false);
      return false;
    }
    log.debug(`invio automatico: riquadro prima dell'Invio ${JSON.stringify(boxPreview(before))}`);
    pty.write('\r');
    for (let attempt = 1; attempt <= 3; attempt++) {
      await this.settle(250, 500, 4000);
      if (this.pty !== pty) return false;
      const screen = await this.screenLines();
      const stuck = pasteStillInInput(screen, firstLine);
      log.debug(`invio automatico: riquadro dopo l'Invio ${attempt} ${JSON.stringify(boxPreview(screen))}`);
      if (!stuck) return true;
      if (attempt === 3) break;
      log.debug(`invio automatico: il testo è ancora nel riquadro di input, ripeto Invio`);
      pty.write('\r');
    }
    log.debug('invio automatico: il testo è rimasto nel riquadro di input');
    this.emit('autosend', false);
    return false;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Chiude le console collegate: 1001 = Studio chiuso, 4001 = scheda chiusa dall'utente. */
  closeClients(code = 1001, reason = 'Riverloop Studio chiuso'): void {
    for (const client of this.clients) {
      try {
        client.ws.close(code, reason);
      } catch {
        /* ignorato */
      }
    }
  }
}
