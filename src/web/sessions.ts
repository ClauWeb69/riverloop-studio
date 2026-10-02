import type { SessionInfo } from '../shared/protocol';
import type { ConsolePanel } from './console';
import { t } from './i18n';
import { icon } from './icons';
import { $, escapeHtml, toast } from './ui';

/** URL della pagina con la scheda indicata (?s=<numero>), senza token. */
export function sessionUrl(id: string): string {
  const params = new URLSearchParams(location.search);
  params.set('s', id);
  return `${location.pathname}?${params.toString()}`;
}

/** Scheda richiesta dall'indirizzo della pagina (?s=<numero>), se c'è. */
export function sessionFromUrl(): string | null {
  const s = new URLSearchParams(location.search).get('s');
  return s && /^\d{1,4}$/.test(s) ? s : null;
}

const stateLabel = (state: string): string => (state === 'running' || state === 'idle' || state === 'exited' ? t(`session.state.${state}`) : state);

/**
 * Schede delle sessioni di Claude Code nella testata della console: ogni scheda è un processo
 * claude nella cartella del progetto. La scheda attiva riceve le annotazioni.
 */
export class SessionTabs {
  private sessions: SessionInfo[];
  private readonly consolePanel: ConsolePanel;
  private readonly authHeaders: () => Record<string, string>;
  private confirming: string | null = null;
  private confirmTimer = 0;
  private busy = false;
  /** Scheda con il nome in modifica: gli aggiornamenti non devono ridisegnarla sotto le dita. */
  private renaming: string | null = null;
  /** La scheda attiva è cambiata (o si sono aperte/chiuse schede). */
  onChange?: () => void;

  constructor(initial: SessionInfo[], consolePanel: ConsolePanel, authHeaders: () => Record<string, string>) {
    this.sessions = initial;
    this.consolePanel = consolePanel;
    this.authHeaders = authHeaders;
    consolePanel.onSessionGone = (id) => {
      this.sessions = this.sessions.filter((s) => s.id !== id);
      const next = this.sessions[0];
      if (next) this.select(next.id, false);
    };
    $('session-tabs').addEventListener('click', (e) => this.onTabClick(e));
    $('session-tabs').addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).closest('.srename')) return;
      const tab = (e.target as HTMLElement).closest<HTMLElement>('.stab');
      if (tab && e.key === 'F2') {
        e.preventDefault();
        this.startRename(tab.dataset.id!);
        return;
      }
      if (tab && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        this.select(tab.dataset.id!);
      }
    });
    this.setupMenu();
    this.render();
  }

  get activeId(): string {
    return this.consolePanel.sessionId;
  }

  get active(): SessionInfo | undefined {
    return this.sessions.find((s) => s.id === this.activeId);
  }

  /** Stato della sessione indicata secondo l'ultimo elenco ricevuto dal companion. */
  isRunning(id: string): boolean {
    if (id === this.activeId) return this.consolePanel.running;
    return this.sessions.find((s) => s.id === id)?.state === 'running';
  }

  /** Nome da mostrare negli avvisi: "Claude Code" con una sola scheda, altrimenti "Claude 2". */
  activeLabel(): string {
    const active = this.active;
    return this.sessions.length > 1 || active?.renamed ? (active?.name ?? 'Claude Code') : 'Claude Code';
  }

  /** Elenco aggiornato dal companion (anche per le schede aperte o chiuse da un'altra finestra). */
  update(list: SessionInfo[]): void {
    this.sessions = list;
    if (this.renaming && list.some((s) => s.id === this.renaming)) return;
    if (!list.some((s) => s.id === this.activeId) && list[0]) {
      this.select(list[0].id, false);
      return;
    }
    this.render();
  }

  /** Mostra la scheda indicata; focus=false quando il cambio non nasce da un gesto dell'utente. */
  select(id: string, focus = true): void {
    if (!this.sessions.some((s) => s.id === id)) return;
    this.confirming = null;
    this.consolePanel.switchTo(id);
    history.replaceState(null, '', sessionUrl(id));
    this.render();
    if (focus) this.consolePanel.focus();
  }

  private onTabClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const close = target.closest<HTMLElement>('.sclose');
    const tab = target.closest<HTMLElement>('.stab');
    if (!tab) return;
    const id = tab.dataset.id!;
    if (close) {
      e.stopPropagation();
      void this.requestClose(id);
      return;
    }
    if (target.closest('.srename')) return;
    // Doppio clic: il primo clic ridisegna le schede, quindi il browser non genera "dblclick"
    // (i due clic cadono su elementi diversi); il secondo clic porta comunque detail = 2.
    if (e.detail === 2) {
      this.startRename(id);
      return;
    }
    this.select(id);
  }

  /** Chiude una scheda; se claude è in esecuzione chiede conferma con un secondo clic. */
  private async requestClose(id: string): Promise<void> {
    const info = this.sessions.find((s) => s.id === id);
    if (!info) return;
    if (info.state === 'running' && this.confirming !== id) {
      this.confirming = id;
      window.clearTimeout(this.confirmTimer);
      this.confirmTimer = window.setTimeout(() => {
        this.confirming = null;
        this.render();
      }, 3500);
      this.render();
      return;
    }
    this.confirming = null;
    try {
      const res = await fetch('/api/sessions/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({ id }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
      this.sessions = this.sessions.filter((s) => s.id !== id);
      if (this.activeId === id && this.sessions[0]) this.select(this.sessions[0].id);
      else this.render();
      toast(t('session.closed', { name: info.name }), 'info');
    } catch (err) {
      toast(t('session.closeFailed', { error: (err as Error).message }), 'error');
      this.render();
    }
  }

  /**
   * Rinomina una scheda direttamente sul suo nome (per dedicarla a un tipo di lavoro). Invio
   * salva, Esc annulla; un nome vuoto torna a "Claude <n>". Il companion lo ricorda per la
   * conversazione, e lo manda a tutte le finestre di Studio aperte.
   */
  startRename(id: string): void {
    if (this.renaming === id) return;
    const info = this.sessions.find((s) => s.id === id);
    const label = $('session-tabs').querySelector<HTMLElement>(`.stab[data-id="${CSS.escape(id)}"] .sname`);
    if (!info || !label) return;
    this.renaming = id;
    const input = document.createElement('input');
    input.className = 'srename';
    input.maxLength = 40;
    input.value = info.renamed ? info.name : '';
    input.placeholder = info.renamed ? '' : info.name;
    input.setAttribute('aria-label', t('session.renameLabel'));
    input.size = Math.max(8, Math.min(24, (input.value || input.placeholder).length + 1));
    label.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      this.renaming = null;
      if (save && input.value.trim() !== (info.renamed ? info.name : '')) void this.rename(id, input.value);
      else this.render();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('input', () => (input.size = Math.max(8, Math.min(24, input.value.length + 1))));
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  private async rename(id: string, name: string): Promise<void> {
    try {
      const res = await fetch('/api/sessions/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({ id, name }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; sessions?: SessionInfo[] };
      if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (body.sessions) this.sessions = body.sessions;
    } catch (err) {
      toast(t('session.renameFailed', { error: (err as Error).message }), 'error');
    }
    this.render();
  }

  /** Apre una nuova sessione: conversazione nuova o scelta dall'elenco (--resume). */
  async create(mode: 'new' | 'resume'): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({ mode }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; session?: SessionInfo };
      if (!res.ok || !body.ok || !body.session) throw new Error(body.error || `HTTP ${res.status}`);
      if (!this.sessions.some((s) => s.id === body.session!.id)) this.sessions = [...this.sessions, body.session];
      this.select(body.session.id);
    } catch (err) {
      toast(t('session.openFailed', { error: (err as Error).message }), 'error');
    } finally {
      this.busy = false;
    }
  }

  /** Apre la scheda indicata in una nuova finestra del browser (stesso token, stessa origine). */
  openWindow(id = this.activeId): void {
    window.open(sessionUrl(id), '_blank');
  }

  private setupMenu(): void {
    const button = $('btn-session-new');
    const menu = $('session-menu');
    const close = () => (menu.hidden = true);
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!menu.hidden) return close();
      const r = button.getBoundingClientRect();
      menu.style.top = `${r.bottom + 6}px`;
      menu.style.left = `${Math.max(8, Math.min(window.innerWidth - 300, r.left - 8))}px`;
      menu.hidden = false;
    });
    menu.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>('[data-session-action]');
      if (!item) return;
      close();
      const action = item.dataset.sessionAction;
      if (action === 'new' || action === 'resume') void this.create(action);
      else if (action === 'window') this.openWindow();
    });
    document.addEventListener('pointerdown', (e) => {
      if (!menu.hidden && !menu.contains(e.target as Node) && !button.contains(e.target as Node)) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !menu.hidden) close();
    });
  }

  private render(): void {
    const host = $('session-tabs');
    const single = this.sessions.length <= 1;
    host.classList.toggle('single', single);
    host.innerHTML = this.sessions
      .map((s) => {
        const active = s.id === this.activeId;
        const confirming = this.confirming === s.id;
        const state = stateLabel(s.state);
        const perms = s.permissions === 'skip' ? ` · ${t('session.skipPerms')}` : '';
        return `<div class="stab${active ? ' active' : ''}${confirming ? ' confirming' : ''}" role="tab" tabindex="0"
            aria-selected="${active}" data-id="${escapeHtml(s.id)}" data-state="${escapeHtml(s.state)}" data-perms="${escapeHtml(s.permissions)}"
            title="${escapeHtml(`${s.name} — ${state}${perms}\n${t('session.renameHint')}`)}">
          <span class="sdot" aria-hidden="true"></span><span class="sname">${escapeHtml(single && !s.renamed ? 'Claude Code' : s.name)}</span>
          ${single ? '' : `<button type="button" class="sclose" title="${escapeHtml(t(confirming ? 'session.closeAgain' : 'session.close'))}">${confirming ? escapeHtml(t('session.closeConfirm')) : icon('close')}</button>`}
        </div>`;
      })
      .join('');
    host.querySelector('.stab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.onChange?.();
  }
}
