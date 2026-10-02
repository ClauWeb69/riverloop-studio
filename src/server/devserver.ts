import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { DevServerState, DevServerStatus } from '../shared/protocol.js';
import { t } from './i18n.js';
import { claimPort, releasePort } from './portlock.js';
import { c, delay, isAlive, isPortOpen, isWindows, killTree, stripAnsi } from './util.js';

const LOG_LINES = 60;

export interface DevServerOptions {
  /** Comando da lanciare; null se Studio si aggancia a un server già attivo. */
  command: string | null;
  port: number;
  cwd: string;
  /** Scrive l'output del dev server nel terminale di avvio. */
  echo?: boolean;
}

/**
 * Gestisce il dev server dell'app: avvio, attesa della porta, ultime righe di log,
 * riavvio e chiusura dell'intero albero di processi.
 */
export class DevServer extends EventEmitter {
  /** Porta attuale dell'app: può cambiare se il dev server ne sceglie un'altra (es. Vite, porta occupata). */
  port: number;
  /** Porta letta dall'output del dev server ("Local: http://localhost:5173"). */
  private detectedPort: number | null = null;
  readonly command: string | null;
  private readonly cwd: string;
  private readonly echo: boolean;
  private child: ChildProcess | null = null;
  /** Gruppo di processi del dev server (Unix): resta valido anche se il processo principale esce. */
  private pgid: number | null = null;
  /** La porta ha risposto almeno una volta: da lì in poi non si cambia più porta. */
  private everOpened = false;
  private stopping = false;
  private logLines: string[] = [];
  private partial = '';
  private monitorTimer: NodeJS.Timeout | null = null;
  state: DevServerState;
  exitCode: number | null = null;

  constructor(opts: DevServerOptions) {
    super();
    this.port = opts.port;
    this.command = opts.command;
    this.cwd = opts.cwd;
    this.echo = opts.echo ?? true;
    this.state = opts.command ? 'starting' : 'external';
  }

  get managed(): boolean {
    return this.command !== null;
  }

  status(): DevServerStatus {
    return {
      state: this.state,
      port: this.port,
      managed: this.managed,
      command: this.command,
      exitCode: this.exitCode,
      log: [...this.logLines],
    };
  }

  private setState(state: DevServerState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit('status', this.status());
  }

  private pushOutput(chunk: Buffer, stream: NodeJS.WriteStream): void {
    const text = chunk.toString('utf8');
    if (this.echo) {
      const prefixed = text.replace(/(^|\n)(?=[^\n])/g, `$1${c.dim('dev │ ')}`);
      stream.write(prefixed);
    }
    const all = this.partial + stripAnsi(text).replace(/\r(?!\n)/g, '\n');
    const lines = all.split(/\r?\n/);
    this.partial = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      this.logLines.push(line.slice(0, 400));
      const m = /local\b.*?https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d{2,5})/i.exec(line);
      if (m) this.detectedPort = Number(m[1]);
    }
    if (this.logLines.length > LOG_LINES) this.logLines.splice(0, this.logLines.length - LOG_LINES);
  }

  /** Avvia il comando del dev server (solo in modalità gestita). */
  start(): void {
    if (!this.command || this.child) return;
    this.stopping = false;
    this.exitCode = null;
    this.startedAt = Date.now();
    this.logLines = [];
    this.partial = '';
    this.setState('starting');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(this.port),
      BROWSER: 'none',
    };
    if (process.stdout.isTTY && !process.env.NO_COLOR) env.FORCE_COLOR = env.FORCE_COLOR ?? '1';

    const child = spawn(this.command, {
      cwd: this.cwd,
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Su Unix il dev server diventa capogruppo, così lo chiudiamo con tutti i figli.
      detached: !isWindows,
      windowsHide: true,
    });
    this.child = child;
    this.pgid = !isWindows && child.pid ? child.pid : null;
    this.everOpened = false;
    child.stdout?.on('data', (d: Buffer) => this.pushOutput(d, process.stdout));
    child.stderr?.on('data', (d: Buffer) => this.pushOutput(d, process.stderr));
    child.on('error', (err) => {
      this.logLines.push(t('process.startFailed', { command: this.command ?? '', message: err.message }));
    });
    child.on('exit', (code, signal) => {
      if (this.partial.trim()) this.logLines.push(this.partial);
      this.partial = '';
      this.child = null;
      this.exitCode = code ?? (signal ? 128 : null);
      if (this.stopping) return;
      // Due sessioni di Studio avviate quasi insieme possono scegliere la stessa porta libera:
      // se il dev server non è mai partito per "porta in uso" proprio sulla nostra porta, ne
      // prendiamo un'altra e riproviamo (al massimo 3 volte).
      // (Vale anche se la porta risultava aperta: era il server di qualcun altro.)
      if (Date.now() - this.startedAt < 90000 && this.portRetries < 3 && this.conflictOnOwnPort()) {
        this.portRetries++;
        this.everOpened = false;
        void this.retryOnFreePort();
        return;
      }
      this.setState('exited');
      this.emit('exit', this.exitCode);
    });
  }

  private portRetries = 0;
  private startedAt = 0;

  private conflictOnOwnPort(): boolean {
    const port = String(this.port);
    return this.logLines.some((l) => /EADDRINUSE|address already in use|already in use|is in use/i.test(l) && l.includes(port));
  }

  private async retryOnFreePort(): Promise<void> {
    const previous = this.port;
    const next = await claimPort(previous + 1);
    releasePort(previous);
    this.logLines.push(t('devserver.retryPort', { port: previous, next }));
    this.port = next;
    this.detectedPort = null;
    this.emit('port', next);
    this.start();
  }

  /**
   * Se la porta configurata non risponde ma il dev server ha annunciato un'altra porta
   * locale (Vite usa la 5173, Next.js passa alla 3001 se la 3000 è occupata), la adotta.
   */
  private async adoptDetectedPort(): Promise<boolean> {
    const detected = this.detectedPort;
    if (this.everOpened || !detected || detected === this.port) return false;
    if (await isPortOpen(this.port, 400)) return false;
    if (!(await isPortOpen(detected, 400))) return false;
    this.port = detected;
    this.emit('port', detected);
    this.emit('status', this.status());
    return true;
  }

  /** Attende che la porta risponda. Restituisce false su timeout o se il processo termina. */
  async waitReady(timeoutMs = 60000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let ok = false;
    while (Date.now() < deadline) {
      if (this.managed && this.state === 'exited') break;
      if (await isPortOpen(this.port, 500)) {
        ok = true;
        this.everOpened = true;
        break;
      }
      if (this.managed && (await this.adoptDetectedPort())) {
        ok = true;
        this.everOpened = true;
        break;
      }
      await delay(300);
    }
    if (ok) this.setState(this.managed ? 'running' : 'external');
    else if (!this.managed) this.setState('unreachable');
    return ok;
  }

  /** Controlla periodicamente se la porta risponde, per aggiornare lo stato nella pagina. */
  startMonitor(intervalMs = 3000): void {
    if (this.monitorTimer) return;
    this.monitorTimer = setInterval(async () => {
      if (this.state === 'exited' || this.stopping) return;
      let open = await isPortOpen(this.port, 500);
      if (!open && this.managed) open = await this.adoptDetectedPort();
      if (open) this.everOpened = true;
      if (this.managed) {
        if (open && this.state === 'starting') this.setState('running');
      } else {
        this.setState(open ? 'external' : 'unreachable');
      }
    }, intervalMs);
    this.monitorTimer.unref();
  }

  async restart(): Promise<void> {
    if (!this.managed) return;
    await this.stop();
    this.stopping = false;
    this.detectedPort = null;
    this.portRetries = 0;
    this.start();
    this.startMonitor();
  }

  /** Chiude il dev server avviato dal tool e tutti i suoi processi figli. */
  async stop(timeoutMs = 5000): Promise<void> {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    this.stopping = true;
    const child = this.child;
    const pgid = this.pgid;
    if (child && child.pid !== undefined) {
      const pid = child.pid;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      killTree(pid, 'SIGTERM');
      const finished = await Promise.race([exited.then(() => true), delay(timeoutMs).then(() => false)]);
      if (!finished || (!isWindows && isAlive(pid))) {
        killTree(pid, 'SIGKILL');
        await Promise.race([exited, delay(1500)]);
      }
    }
    // Su Unix chiudiamo sempre tutto il gruppo: anche processi rimasti dopo l'uscita del
    // principale (es. "tailwindcss -w & next dev" quando next si ferma).
    if (pgid) {
      try {
        process.kill(-pgid, 0);
        process.kill(-pgid, 'SIGTERM');
        await delay(400);
        process.kill(-pgid, 0);
        process.kill(-pgid, 'SIGKILL');
      } catch {
        /* nessun processo rimasto */
      }
    }
    this.child = null;
    this.pgid = null;
  }

  /** Chiusura immediata e sincrona (uscita forzata o errore imprevisto). */
  killNow(): void {
    if (this.child?.pid) killTree(this.child.pid, 'SIGKILL');
    if (this.pgid) {
      try {
        process.kill(-this.pgid, 'SIGKILL');
      } catch {
        /* nessun processo rimasto */
      }
    }
  }
}
