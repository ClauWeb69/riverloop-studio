import { execFile, spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { DevServerState, DevServerStatus } from '../shared/protocol.js';
import { t } from './i18n.js';
import { c, delay, isAlive, isWindows, killTree, stripAnsi } from './util.js';

const LOG_LINES = 60;

export interface ProcessRow {
  pid: number;
  parent: number;
  name: string;
}

/**
 * I processi a cui chiedere la chiusura, nell'albero che parte da root: per ogni programma solo
 * quello principale, cioè quello il cui padre è un altro programma. "taskkill /T" senza /F non va
 * bene: chiede la chiusura anche ai processi ausiliari (in Electron: grafica, rete), che si chiudono,
 * mentre rifiuta il principale finché ha figli. L'app resta aperta e Chromium, perso il processo
 * della grafica, ridisegna la finestra e la riporta in primo piano. conhost è escluso: chiudere la
 * console chiuderebbe di colpo tutti i programmi a riga di comando.
 */
export function closeTargets(root: number, rows: ProcessRow[]): number[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const tree = new Set<number>([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) {
      if (!tree.has(r.pid) && tree.has(r.parent) && r.pid !== r.parent) {
        tree.add(r.pid);
        grew = true;
      }
    }
  }
  const targets: number[] = [];
  for (const pid of tree) {
    const row = byPid.get(pid);
    if (!row || row.name.toLowerCase() === 'conhost.exe') continue;
    const parent = tree.has(row.parent) ? byPid.get(row.parent) : undefined;
    if (parent && parent.name.toLowerCase() === row.name.toLowerCase()) continue;
    targets.push(pid);
  }
  return targets;
}

/** Elenco dei processi di Windows (pid, padre, eseguibile); null se non si riesce a leggerlo. */
function windowsProcesses(): Promise<ProcessRow[] | null> {
  return new Promise((resolve) => {
    // Percorso assoluto: un powershell.exe nella cartella del progetto o nel PATH non va eseguito
    const system = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    execFile(
      path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.Name }",
      ],
      { windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        const rows: ProcessRow[] = [];
        for (const line of stdout.split(/\r?\n/)) {
          const m = /^(\d+) (\d+) (.+)$/.exec(line.trim());
          if (m) rows.push({ pid: Number(m[1]), parent: Number(m[2]), name: m[3] });
        }
        resolve(rows.length ? rows : null);
      },
    );
  });
}

/** Chiede all'app di chiudersi come chiudendo le sue finestre (WM_CLOSE), senza forzare nulla. */
async function askToClose(root: number): Promise<void> {
  const rows = await windowsProcesses();
  // Senza elenco dei processi si chiude solo con la forza (dopo l'attesa): meglio che riportare su l'app
  if (!rows) return;
  const targets = closeTargets(root, rows);
  if (!targets.length) return;
  await new Promise<void>((resolve) => {
    execFile(
      'taskkill',
      targets.flatMap((pid) => ['/pid', String(pid)]),
      { windowsHide: true, timeout: 5000 },
      () => resolve(),
    );
  });
}

export interface DesktopAppOptions {
  /** Comando che avvia l'app (--app-cmd); null se Studio si aggancia a un'app già aperta. */
  command: string | null;
  cwd: string;
  /** Variabili d'ambiente aggiunte al processo (porta di debug, hook di Electron...). */
  env?: Record<string, string>;
  /** Porta di debug dell'app (modalità electron); 0 se non c'è. */
  port?: number;
  /** Scrive l'output dell'app nel terminale di avvio. */
  echo?: boolean;
}

/**
 * Il processo dell'app desktop (modalità window ed electron): avvio, ultime righe di log,
 * riavvio e chiusura dell'intero albero di processi. Ha la stessa superficie di DevServer,
 * così la pagina Studio mostra stato, log e pulsante di riavvio allo stesso modo.
 *
 * "Pronta" non dipende da una porta: lo decide chi guarda l'app (finestra trovata, porta di
 * debug raggiungibile) chiamando setReady().
 */
export class DesktopApp extends EventEmitter {
  readonly command: string | null;
  port: number;
  private readonly cwd: string;
  private readonly env: Record<string, string>;
  private readonly echo: boolean;
  private child: ChildProcess | null = null;
  private pgid: number | null = null;
  private stopping = false;
  private logLines: string[] = [];
  private partial = '';
  private ready = false;
  /** Avvii completati: cambia a ogni riavvio (chi guarda l'app ricomincia a cercarla). */
  generation = 0;
  state: DevServerState;
  exitCode: number | null = null;

  constructor(opts: DesktopAppOptions) {
    super();
    this.command = opts.command;
    this.cwd = opts.cwd;
    this.env = opts.env ?? {};
    this.port = opts.port ?? 0;
    this.echo = opts.echo ?? true;
    this.state = opts.command ? 'starting' : 'unreachable';
  }

  get managed(): boolean {
    return this.command !== null;
  }

  /** Processo avviato da Studio (radice dell'albero in cui cercare le finestre dell'app). */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  status(): DevServerStatus {
    return { state: this.state, port: this.port, managed: this.managed, command: this.command, exitCode: this.exitCode, log: [...this.logLines] };
  }

  private setState(state: DevServerState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit('status', this.status());
  }

  /** L'app è visibile a Studio (finestra trovata o porta di debug raggiungibile) oppure no. */
  setReady(ready: boolean): void {
    this.ready = ready;
    if (this.managed) {
      if (this.state === 'exited') return;
      this.setState(ready ? 'running' : 'starting');
    } else {
      this.setState(ready ? 'external' : 'unreachable');
    }
  }

  get isReady(): boolean {
    return this.ready;
  }

  private pushOutput(chunk: Buffer, stream: NodeJS.WriteStream): void {
    const text = chunk.toString('utf8');
    if (this.echo) stream.write(text.replace(/(^|\n)(?=[^\n])/g, `$1${c.dim('app │ ')}`));
    const all = this.partial + stripAnsi(text).replace(/\r(?!\n)/g, '\n');
    const lines = all.split(/\r?\n/);
    this.partial = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) this.logLines.push(line.slice(0, 400));
    if (this.logLines.length > LOG_LINES) this.logLines.splice(0, this.logLines.length - LOG_LINES);
  }

  start(): void {
    if (!this.command || this.child) return;
    this.stopping = false;
    this.exitCode = null;
    this.logLines = [];
    this.partial = '';
    this.ready = false;
    this.generation++;
    this.state = 'starting';
    this.emit('status', this.status());

    const env: NodeJS.ProcessEnv = { ...process.env, ...this.env };
    if (process.stdout.isTTY && !process.env.NO_COLOR) env.FORCE_COLOR = env.FORCE_COLOR ?? '1';
    const child = spawn(this.command, {
      cwd: this.cwd,
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Su Unix l'app diventa capogruppo, così la chiudiamo con tutti i suoi processi.
      detached: !isWindows,
      // Senza finestra di console per la shell; le finestre dell'app si aprono normalmente.
      windowsHide: true,
    });
    this.child = child;
    this.pgid = !isWindows && child.pid ? child.pid : null;
    child.stdout?.on('data', (d: Buffer) => this.pushOutput(d, process.stdout));
    child.stderr?.on('data', (d: Buffer) => this.pushOutput(d, process.stderr));
    child.on('error', (err) => {
      this.logLines.push(t('process.startFailed', { command: this.command ?? '', message: err.message }));
    });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      if (this.partial.trim()) this.logLines.push(this.partial);
      this.partial = '';
      this.child = null;
      this.ready = false;
      this.exitCode = code ?? (signal ? 128 : null);
      if (this.stopping) return;
      this.setState('exited');
      this.emit('exit', this.exitCode);
    });
  }

  /**
   * Chiude l'app: prima con garbo (come chiudendo la finestra: l'app può salvare il suo
   * stato), poi con la forza se non esce in tempo. Chiude sempre tutto l'albero di processi.
   */
  async stop(timeoutMs = 4000): Promise<void> {
    this.stopping = true;
    const child = this.child;
    const pgid = this.pgid;
    if (child && child.pid !== undefined) {
      const pid = child.pid;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      if (isWindows) {
        await askToClose(pid);
      } else {
        killTree(pid, 'SIGTERM');
      }
      const finished = await Promise.race([exited.then(() => true), delay(timeoutMs).then(() => false)]);
      if (!finished || (!isWindows && isAlive(pid))) {
        killTree(pid, 'SIGKILL');
        await Promise.race([exited, delay(1500)]);
      } else if (isWindows) {
        // La shell è uscita: eventuali processi rimasti nell'albero vengono chiusi comunque
        killTree(pid, 'SIGKILL');
      }
    }
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
    this.ready = false;
  }

  private restarting: Promise<void> | null = null;

  /** Riavvia l'app (pulsante nella pagina, oppure fine risposta di Claude con --restart-on-idle). */
  restart(): Promise<void> {
    if (!this.managed) return Promise.resolve();
    this.restarting ??= (async () => {
      try {
        await this.stop();
        this.start();
        this.emit('restart');
      } finally {
        this.restarting = null;
      }
    })();
    return this.restarting;
  }

  /** Chiusura immediata e sincrona (uscita forzata o errore imprevisto). */
  killNow(): void {
    this.stopping = true;
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
