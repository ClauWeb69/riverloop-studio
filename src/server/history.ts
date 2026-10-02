import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HistoryState } from '../shared/protocol.js';
import { t } from './i18n.js';
import { isAlive, log, runDir, sanitizeInline } from './util.js';

/**
 * Annulla e Ripeti per le modifiche ai file del progetto (di solito fatte da Claude Code).
 *
 * Prima di ogni richiesta inviata da Studio viene fotografato lo stato dei file; Annulla riporta
 * i file a quella fotografia (fotografando prima lo stato attuale, che diventa il "Ripeti").
 *
 * Le fotografie stanno in un archivio git privato di Studio, fuori dal progetto: git è usato solo
 * come magazzino di file. Il repository del progetto (se c'è) non viene mai toccato: niente
 * commit, niente rami, niente staging. Funziona anche se il progetto non usa git.
 * Vengono fotografati i file che git seguirebbe: quelli ignorati dal .gitignore del progetto
 * (node_modules, build, .env...) non vengono né salvati né ripristinati.
 */
const ALWAYS_EXCLUDED = ['.claude/studio/', 'node_modules/', '.next/', '.nuxt/', '.turbo/', '.cache/', '.venv/', 'venv/', '__pycache__/', '*.pyc'];
const GIT_CONFIG = [
  // I byte dei file devono tornare identici: nessuna conversione dei fine riga
  ['core.autocrlf', 'false'],
  ['core.safecrlf', 'false'],
  ['core.fileMode', 'false'],
  ['core.longpaths', 'true'],
  ['core.quotepath', 'false'],
  ['gc.auto', '0'],
  ['advice.addEmbeddedRepo', 'false'],
  ['advice.addIgnoredFile', 'false'],
];

interface Snapshot {
  /** Identificativo dello stato dei file (un "tree" di git). */
  tree: string;
  /** La richiesta partita da questo stato (ciò che Annulla toglie tornando qui). */
  label: string;
}

export interface HistoryResult {
  ok: boolean;
  message: string;
}

/** Cartella degli archivi: dati che possono essere grandi, quindi mai in una cartella in memoria. */
function archiveBase(): string {
  if (process.env.RIVERLOOP_STUDIO_RUN_DIR || process.platform !== 'linux') return runDir('snapshots');
  const dir = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'riverloop-studio', 'snapshots');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export class ProjectHistory extends EventEmitter {
  private readonly cwd: string;
  private readonly gitDir: string;
  private states: Snapshot[] = [];
  /** Lo stato a cui corrispondono i file (più le eventuali modifiche fatte dopo). */
  private pointer = -1;
  private queue: Promise<unknown> = Promise.resolve();
  private ready: Promise<boolean> | null = null;
  /** Perché Annulla e Ripeti non sono disponibili (tradotto a ogni lettura: la lingua può cambiare). */
  private unavailable: (() => string) | null = null;
  /** Dopo un Annulla o un Ripeti Claude va avvisato che i file sono cambiati sotto di lui. */
  private notice = false;

  constructor(cwd: string, base = archiveBase()) {
    super();
    this.cwd = cwd;
    const key = createHash('sha1').update(path.resolve(cwd)).digest('hex').slice(0, 16);
    this.gitDir = path.join(base, `${key}-${process.pid}`);
    // Archivi di istanze chiuse male: non servono più
    try {
      for (const name of readdirSync(base)) {
        const m = /^[0-9a-f]{16}-(\d+)$/.exec(name);
        if (m && Number(m[1]) !== process.pid && !isAlive(Number(m[1]))) rmSync(path.join(base, name), { recursive: true, force: true });
      }
    } catch {
      /* cartella non leggibile: pazienza */
    }
    process.on('exit', () => this.dispose());
  }

  private git(args: string[], timeoutMs = 60000): Promise<string> {
    const config = GIT_CONFIG.flatMap(([k, v]) => ['-c', `${k}=${v}`]);
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        [...config, ...args],
        {
          cwd: this.cwd,
          env: { ...process.env, GIT_DIR: this.gitDir, GIT_WORK_TREE: this.cwd, GIT_INDEX_FILE: path.join(this.gitDir, 'index'), GIT_TERMINAL_PROMPT: '0' },
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
        },
        (err, stdout, stderr) =>
          err
            ? reject(
                new Error(
                  String(stderr || err.message)
                    .trim()
                    .split('\n')
                    .slice(-2)
                    .join(' '),
                ),
              )
            : resolve(String(stdout).trim()),
      );
    });
  }

  /** Prepara l'archivio (una volta sola). false se git non è disponibile. */
  private init(): Promise<boolean> {
    this.ready ??= (async () => {
      try {
        mkdirSync(this.gitDir, { recursive: true, mode: 0o700 });
        await this.git(['init', '-q']);
        mkdirSync(path.join(this.gitDir, 'info'), { recursive: true });
        writeFileSync(path.join(this.gitDir, 'info', 'exclude'), `${ALWAYS_EXCLUDED.join('\n')}\n`);
        return true;
      } catch (err) {
        const message = (err as Error).message;
        this.unavailable = /ENOENT|not recognized|non è riconosciuto|not found/i.test(message)
          ? () => t('history.gitMissing')
          : () => t('history.unavailable', { message: sanitizeInline(message, 160) });
        log.debug(`cronologia: ${message}`);
        this.emit('change');
        return false;
      }
    })();
    return this.ready;
  }

  /** Un'operazione alla volta: fotografie e ripristini non si devono accavallare. */
  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Fotografa lo stato attuale dei file e ne restituisce l'identificativo. */
  private async snapshot(): Promise<string> {
    await this.git(['add', '-A', '--', '.']);
    return this.git(['write-tree']);
  }

  /** Prepara l'archivio in anticipo, così la prima richiesta non aspetta la prima fotografia. */
  warm(): void {
    void this.run(async () => {
      if (await this.init()) await this.snapshot().catch((err: unknown) => log.debug(`cronologia: ${(err as Error).message}`));
    });
  }

  state(): HistoryState {
    const last = this.states.length - 1;
    const available = !this.unavailable;
    // In fondo alla cronologia c'è quasi sempre qualcosa da annullare (le modifiche fatte dopo
    // l'ultima richiesta): se non c'è, lo si scopre al clic
    const canUndo = available && this.states.length > 0;
    const canRedo = available && this.pointer >= 0 && this.pointer < last;
    return {
      available,
      reason: this.unavailable?.() ?? '',
      canUndo,
      canRedo,
      undoLabel: canUndo ? (this.states[this.pointer === last ? this.pointer : Math.max(0, this.pointer - 1)]?.label ?? '') : '',
      redoLabel: canRedo ? this.states[this.pointer].label : '',
    };
  }

  /**
   * Prima di una richiesta: fotografa i file. Da qui riparte la cronologia (un eventuale
   * "Ripeti" rimasto da un Annulla precedente non ha più senso). Non lancia mai: senza
   * fotografia la richiesta parte lo stesso, solo senza Annulla.
   */
  checkpoint(label: string): Promise<void> {
    return this.run(async () => {
      if (!(await this.init())) return;
      try {
        const tree = await this.snapshot();
        this.states.length = this.pointer + 1;
        const clean = sanitizeInline(label, 80) || t('history.defaultLabel');
        const current = this.states[this.pointer];
        // Nessuna modifica dall'ultima fotografia: la richiesta precedente non ha cambiato nulla
        if (current && current.tree === tree) current.label = clean;
        else {
          this.states.push({ tree, label: clean });
          this.pointer = this.states.length - 1;
        }
        this.emit('change');
      } catch (err) {
        log.debug(`cronologia: fotografia non riuscita: ${(err as Error).message}`);
      }
    });
  }

  /** Riporta i file a com'erano prima dell'ultima richiesta (o prima delle modifiche fatte dopo). */
  undo(): Promise<HistoryResult> {
    return this.run(async () => {
      if (!(await this.init())) return { ok: false, message: this.unavailable?.() ?? '' };
      if (this.pointer < 0) return { ok: false, message: t('history.nothingToUndo') };
      try {
        const now = await this.snapshot();
        let target = this.pointer - 1;
        if (now !== this.states[this.pointer].tree) {
          // Modifiche fatte dopo questo stato: diventano il "Ripeti", e si torna a questo stato
          this.states.length = this.pointer + 1;
          this.states.push({ tree: now, label: this.states[this.pointer].label });
          target = this.pointer;
        }
        if (target < 0) return { ok: false, message: t('history.alreadyFirst') };
        await this.git(['read-tree', '--reset', '-u', this.states[target].tree]);
        this.pointer = target;
        this.notice = true;
        this.emit('change');
        return { ok: true, message: t('history.undone', { label: this.states[target].label }) };
      } catch (err) {
        return { ok: false, message: t('history.undoFailed', { message: sanitizeInline((err as Error).message, 200) }) };
      }
    });
  }

  /** Rimette le modifiche tolte dall'ultimo Annulla. */
  redo(): Promise<HistoryResult> {
    return this.run(async () => {
      if (!(await this.init())) return { ok: false, message: this.unavailable?.() ?? '' };
      if (this.pointer < 0 || this.pointer >= this.states.length - 1) return { ok: false, message: t('history.nothingToRedo') };
      try {
        const now = await this.snapshot();
        if (now !== this.states[this.pointer].tree) {
          // Dopo l'Annulla i file sono stati modificati: rimettere il vecchio stato le cancellerebbe
          this.states.length = this.pointer + 1;
          this.emit('change');
          return { ok: false, message: t('history.redoChanged') };
        }
        const label = this.states[this.pointer].label;
        await this.git(['read-tree', '--reset', '-u', this.states[this.pointer + 1].tree]);
        this.pointer++;
        this.notice = true;
        this.emit('change');
        return { ok: true, message: t('history.redone', { label }) };
      } catch (err) {
        return { ok: false, message: t('history.redoFailed', { message: sanitizeInline((err as Error).message, 200) }) };
      }
    });
  }

  /**
   * Nota da aggiungere alla prossima richiesta per Claude Code dopo un Annulla o un Ripeti:
   * ciò che ricorda dei file può non valere più. Restituita una volta sola.
   */
  takeNotice(): string | null {
    if (!this.notice) return null;
    this.notice = false;
    return t('history.notice');
  }

  dispose(): void {
    try {
      rmSync(this.gitDir, { recursive: true, force: true });
    } catch {
      /* già rimosso */
    }
  }
}
