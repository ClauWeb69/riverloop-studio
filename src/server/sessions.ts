import { EventEmitter } from 'node:events';
import type { SessionInfo } from '../shared/protocol.js';
import { t } from './i18n.js';
import { ClaudeSession, type Permissions, withoutResumeArgs } from './pty.js';
import { cleanSessionName, MAX_SESSION_NAMES } from './state.js';
import type { ResolvedCommand } from './util.js';

/** Massimo di sessioni di Claude Code aperte insieme nello stesso progetto. */
export const MAX_SESSIONS = 8;

export interface SessionManagerOptions {
  command: ResolvedCommand;
  extraArgs: string[];
  cwd: string;
  /** Permessi con cui partono le nuove sessioni (l'ultima scelta fatta per il progetto). */
  permissions: Permissions;
  /** Variabili d'ambiente per il processo claude di una sessione (hook delle modalità desktop). */
  env?: (sessionId: string) => Record<string, string>;
  /** Nomi dati alle schede nelle esecuzioni precedenti, per conversazione. */
  savedNames?: Record<string, string>;
  /** I nomi da ricordare sono cambiati (da salvare per il progetto). */
  onNamesChange?: (names: Record<string, string>) => void;
}

/**
 * Le sessioni di Claude Code di un progetto: ognuna è un processo claude nella cartella del
 * progetto, con la sua scheda nella console di Studio.
 *
 * Eventi: 'change' (elenco o stato cambiato), 'state' (sessione, stato, codice),
 * 'permissions' (sessione, valore), 'autosend' (sessione, esito).
 */
export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, ClaudeSession>();
  private counter = 0;
  private changeTimer: NodeJS.Timeout | null = null;
  private readonly opts: SessionManagerOptions;
  /** Nomi delle schede per conversazione di Claude Code (ripresi quando la si riapre). */
  private names: Record<string, string>;
  permissions: Permissions;

  constructor(opts: SessionManagerOptions) {
    super();
    this.opts = opts;
    this.permissions = opts.permissions;
    this.names = { ...(opts.savedNames ?? {}) };
  }

  /**
   * Nuova sessione. Il processo claude parte quando una console si collega.
   * inheritResumeArgs: solo la prima sessione usa un --continue/--resume passato con --claude-args;
   * le schede aperte dalla pagina partono come chiesto (nuova o scelta dall'elenco).
   */
  create(options: { resumeFirst?: boolean; inheritResumeArgs?: boolean } = {}): ClaudeSession {
    if (this.sessions.size >= MAX_SESSIONS) throw new Error(t('sessions.max', { max: MAX_SESSIONS }));
    const id = String(++this.counter);
    const session = new ClaudeSession({
      command: this.opts.command,
      extraArgs: options.inheritResumeArgs ? this.opts.extraArgs : withoutResumeArgs(this.opts.extraArgs),
      resumeFirst: Boolean(options.resumeFirst),
      cwd: this.opts.cwd,
      permissions: this.permissions,
      extraEnv: () => this.opts.env?.(id) ?? {},
    });
    session.id = id;
    session.name = `Claude ${id}`;
    session.on('conversation', (conversation: string) => this.onConversation(session, conversation));
    session.on('state', (state, exitCode) => {
      this.emit('state', session, state, exitCode);
      this.emit('change');
    });
    session.on('permissions', (value: Permissions) => {
      // L'ultima scelta vale anche per le sessioni aperte dopo
      this.permissions = value;
      this.emit('permissions', session, value);
      this.emit('change');
    });
    session.on('autosend', (ok: boolean) => this.emit('autosend', session, ok));
    // Modello, utilizzo e modalità cambiano spesso mentre Claude lavora: un aggiornamento ogni tanto
    session.on('status', () => this.changeSoon());
    this.sessions.set(id, session);
    this.emit('change');
    return session;
  }

  /**
   * Rinomina una scheda (nome vuoto: torna "Claude <n>"). Il nome resta legato alla
   * conversazione: riaprendola in un'altra esecuzione di Studio, la scheda lo ritrova.
   */
  rename(id: string, name: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    const clean = cleanSessionName(name);
    session.name = clean || `Claude ${id}`;
    session.renamed = Boolean(clean);
    if (session.conversationId) this.remember(session.conversationId, clean);
    this.emit('change');
    return true;
  }

  private onConversation(session: ClaudeSession, conversation: string): void {
    if (session.renamed) {
      // Nome scelto prima che si sapesse la conversazione, o conversazione cambiata (/clear, /resume)
      this.remember(conversation, session.name);
      return;
    }
    const saved = this.names[conversation];
    if (saved) {
      session.name = saved;
      session.renamed = true;
      this.emit('change');
    }
  }

  private remember(conversation: string, name: string): void {
    if (name) {
      delete this.names[conversation];
      this.names[conversation] = name;
      const keys = Object.keys(this.names);
      for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SESSION_NAMES))) delete this.names[key];
    } else {
      delete this.names[conversation];
    }
    this.opts.onNamesChange?.({ ...this.names });
  }

  private changeSoon(): void {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.emit('change');
    }, 300);
    this.changeTimer.unref();
  }

  get(id: string | null | undefined): ClaudeSession | undefined {
    return id ? this.sessions.get(id) : undefined;
  }

  /** La prima sessione ancora aperta (quella predefinita per le console senza scheda scelta). */
  first(): ClaudeSession | undefined {
    return this.sessions.values().next().value;
  }

  all(): ClaudeSession[] {
    return [...this.sessions.values()];
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Qualche sessione sta scrivendo sullo schermo in questo momento (Claude al lavoro, o l'utente che digita). */
  busy(withinMs = 1500): boolean {
    return this.all().some((s) => s.state === 'running' && s.quietMs < withinMs);
  }

  list(): SessionInfo[] {
    return this.all().map((s) => ({
      id: s.id,
      name: s.name,
      renamed: s.renamed,
      claude: { ...s.status },
      state: s.state,
      exitCode: s.exitCode,
      permissions: s.permissions,
    }));
  }

  /** Chiude una sessione (processo claude compreso). L'ultima sessione non si chiude. */
  async close(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session || this.sessions.size <= 1) return false;
    this.sessions.delete(id);
    // Da qui la sessione non riparte più (neanche un riavvio per i permessi già in corso)
    session.closed = true;
    session.closeClients(4001, 'Sessione chiusa');
    session.removeAllListeners('state');
    await session.stop().catch(() => undefined);
    this.emit('change');
    return true;
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.all().map((s) => s.stop().catch(() => undefined)));
  }

  closeAllClients(): void {
    for (const s of this.all()) s.closeClients();
  }
}
