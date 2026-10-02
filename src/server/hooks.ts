import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDir, toPosix } from './util.js';

/**
 * Collegamento con Claude Code senza leggere lo schermo. Studio avvia claude con un file di
 * impostazioni aggiuntive (--settings), senza toccare le impostazioni dell'utente:
 * - hook PostToolUse su Edit/Write/MultiEdit/NotebookEdit/Bash: la risposta ha modificato qualcosa;
 * - hook Stop: la risposta è finita (riavvio delle app desktop);
 * - status line: Claude Code passa al comando un JSON con modello, effort, utilizzo del piano e
 *   contesto, che la pagina mostra. Una status line dell'utente continua a funzionare: lo script
 *   di Studio la esegue con gli stessi dati e ne stampa l'output.
 * Hook e status line eseguono script in dist/bin, che avvisano il companion con un token
 * dedicato (vale solo per /api/hook: se trapelasse, al massimo farebbe riavviare l'app o
 * cambierebbe i numeri mostrati).
 */
const HOOK_SCRIPT = fileURLToPath(new URL('../../bin/hook.js', import.meta.url));
const STATUS_SCRIPT = fileURLToPath(new URL('../../bin/statusline.js', import.meta.url));
const CHANGING_TOOLS = 'Edit|Write|MultiEdit|NotebookEdit|Bash';

export const HOOK_HEADER = 'x-studio-hook';

type Json = Record<string, unknown>;

interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: 'command'; command: string; timeout?: number }>;
}

/**
 * Comando dell'hook: "node" seguito dallo script tra virgolette, con le barre "/".
 * Claude Code lo esegue con la shell che trova (bash, cmd o PowerShell): un eseguibile tra
 * virgolette in PowerShell sarebbe un errore di sintassi, quindi qui c'è solo il nome, e la
 * cartella del Node che sta eseguendo Studio viene aggiunta al PATH di claude (vedi hookPath).
 */
export function hookCommand(script = HOOK_SCRIPT): string {
  return `node "${toPosix(script).replace(/\\/g, '/')}"`;
}

/**
 * PATH per il processo claude: quello attuale più, in fondo, la cartella di questo Node.
 * In fondo: non cambia quale node (o altro programma) trovano i comandi di Claude, ma
 * garantisce che l'hook ne trovi uno anche quando Node non è nel PATH.
 */
export function hookPath(env: NodeJS.ProcessEnv = process.env, nodePath = process.execPath): { name: string; value: string } {
  const name = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const dir = path.dirname(nodePath);
  const parts = (env[name] ?? '').split(path.delimiter).filter(Boolean);
  if (!parts.includes(dir)) parts.push(dir);
  return { name, value: parts.join(path.delimiter) };
}

/** Status line dell'utente (impostazioni di Claude Code): Studio la esegue al posto suo. */
export interface UserStatusLine {
  command: string;
  padding?: number;
  refreshInterval?: number;
}

interface StudioSettings {
  hooks: Record<string, HookEntry[]>;
  statusLine?: { type: 'command'; command: string; padding?: number; refreshInterval?: number };
}

export function hookSettings(command = hookCommand(), statusCommand: string | null = null, user: UserStatusLine | null = null): StudioSettings {
  const run = { type: 'command' as const, command, timeout: 5 };
  const settings: StudioSettings = {
    hooks: {
      PostToolUse: [{ matcher: CHANGING_TOOLS, hooks: [run] }],
      Stop: [{ hooks: [run] }],
    },
  };
  if (statusCommand) {
    settings.statusLine = { type: 'command', command: statusCommand, padding: user?.padding ?? 0 };
    if (user?.refreshInterval) settings.statusLine.refreshInterval = user.refreshInterval;
  }
  return settings;
}

function statusLineOf(settings: unknown): UserStatusLine | null {
  const line = settings && typeof settings === 'object' ? (settings as Json).statusLine : null;
  if (!line || typeof line !== 'object') return null;
  const { type, command, padding, refreshInterval } = line as Json;
  if (type !== 'command' || typeof command !== 'string' || !command.trim()) return null;
  return {
    command,
    ...(typeof padding === 'number' ? { padding } : {}),
    ...(typeof refreshInterval === 'number' ? { refreshInterval } : {}),
  };
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/**
 * La status line che Claude Code userebbe senza Studio: --settings dato dall'utente, poi le
 * impostazioni locali e di progetto, poi quelle dell'utente (la stessa precedenza di Claude Code;
 * le impostazioni gestite dall'organizzazione vincono comunque, e allora Studio non vede i dati).
 */
export function findUserStatusLine(cwd: string, flagSettings: Json, env: NodeJS.ProcessEnv = process.env): UserStatusLine | null {
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  for (const source of [
    flagSettings,
    readJsonFile(path.join(cwd, '.claude', 'settings.local.json')),
    readJsonFile(path.join(cwd, '.claude', 'settings.json')),
    readJsonFile(path.join(configDir, 'settings.json')),
  ]) {
    const line = statusLineOf(source);
    if (line) return line;
  }
  return null;
}

/** Unisce le impostazioni dell'utente (--settings in --claude-args) con hook e status line di Studio. */
export function mergeSettings(user: Json, ours: StudioSettings): Json {
  const userHooks = user.hooks && typeof user.hooks === 'object' ? (user.hooks as Record<string, unknown>) : {};
  const hooks: Record<string, unknown> = { ...userHooks };
  for (const [event, entries] of Object.entries(ours.hooks)) {
    const existing = Array.isArray(userHooks[event]) ? (userHooks[event] as unknown[]) : [];
    hooks[event] = [...existing, ...entries];
  }
  return { ...user, hooks, ...(ours.statusLine ? { statusLine: ours.statusLine } : {}) };
}

/** Valore di --settings: percorso di un file JSON oppure JSON scritto direttamente. */
function readUserSettings(value: string, cwd: string): Json {
  const text = value.trim();
  try {
    if (text.startsWith('{')) return JSON.parse(text) as Json;
    return JSON.parse(readFileSync(path.resolve(cwd, text), 'utf8')) as Json;
  } catch {
    return {};
  }
}

export interface HookSetup {
  /** Argomenti extra di claude con --settings che punta al file preparato da Studio. */
  args: string[];
  file: string;
  /** Status line dell'utente, che lo script di Studio esegue (null se non ce n'è). */
  userStatusLine: UserStatusLine | null;
}

/**
 * Prepara il file di impostazioni con gli hook e restituisce gli argomenti extra aggiornati.
 * Un --settings già presente in --claude-args viene letto e unito, non sostituito.
 */
export function prepareHookSettings(extraArgs: string[], cwd: string): HookSetup {
  let user: Json = {};
  const args: string[] = [];
  for (let i = 0; i < extraArgs.length; i++) {
    const a = extraArgs[i];
    if (a === '--settings' && i + 1 < extraArgs.length) {
      user = readUserSettings(extraArgs[++i], cwd);
      continue;
    }
    if (a.startsWith('--settings=')) {
      user = readUserSettings(a.slice('--settings='.length), cwd);
      continue;
    }
    args.push(a);
  }
  const dir = runDir('hooks');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${process.pid}.json`);
  const userStatusLine = findUserStatusLine(cwd, user);
  const statusCommand = existsSync(STATUS_SCRIPT) ? hookCommand(STATUS_SCRIPT) : null;
  writeFileSync(file, `${JSON.stringify(mergeSettings(user, hookSettings(hookCommand(), statusCommand, userStatusLine)), null, 2)}\n`, { mode: 0o600 });
  process.on('exit', () => {
    try {
      rmSync(file, { force: true });
    } catch {
      /* ignorato */
    }
  });
  return { args: ['--settings', file, ...args], file, userStatusLine };
}

export const hookScriptAvailable = (): boolean => existsSync(HOOK_SCRIPT);

export type HookEvent = 'PostToolUse' | 'Stop';

/** Dati della status line inoltrati dallo script di Studio (già ridotti all'essenziale). */
export interface StatusPayload {
  model?: { id?: unknown; display_name?: unknown };
  effort?: { level?: unknown };
  rate_limits?: { five_hour?: { used_percentage?: unknown; resets_at?: unknown }; seven_day?: { used_percentage?: unknown; resets_at?: unknown } };
  context_window?: { used_percentage?: unknown };
  cost?: { total_cost_usd?: unknown };
}

/**
 * Stato degli hook per sessione: una risposta "ha modificato qualcosa" se tra un fine risposta
 * e il successivo è passato almeno uno strumento che scrive file o lancia comandi.
 */
export class IdleTracker {
  readonly token = randomBytes(24).toString('hex');
  /** Comando della status line dell'utente, eseguito dallo script di Studio. */
  userStatusLine: string | null = null;
  private readonly tokenBuf = Buffer.from(this.token, 'utf8');
  private readonly dirty = new Set<string>();

  authorized(header: unknown): boolean {
    if (typeof header !== 'string') return false;
    const buf = Buffer.from(header, 'utf8');
    return buf.length === this.tokenBuf.length && timingSafeEqual(buf, this.tokenBuf);
  }

  /** Registra un evento. Restituisce 'changed' quando una risposta con modifiche è finita. */
  record(event: HookEvent, session: string): 'changed' | 'unchanged' | null {
    if (event === 'PostToolUse') {
      this.dirty.add(session);
      return null;
    }
    return this.dirty.delete(session) ? 'changed' : 'unchanged';
  }

  /** Variabili d'ambiente per il processo claude di una sessione. */
  env(studioPort: number, session: string): Record<string, string> {
    const { name, value } = hookPath();
    return {
      RIVERLOOP_STUDIO_HOOK_URL: `http://127.0.0.1:${studioPort}/api/hook`,
      RIVERLOOP_STUDIO_HOOK_TOKEN: this.token,
      RIVERLOOP_STUDIO_SESSION: session,
      ...(this.userStatusLine ? { RIVERLOOP_STUDIO_USER_STATUSLINE: this.userStatusLine } : {}),
      [name]: value,
    };
  }
}
