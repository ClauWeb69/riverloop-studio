import type { ProjectInstance, ProjectsResponse } from '../shared/protocol';
import { t } from './i18n';
import { icon } from './icons';
import { $, escapeHtml, toast } from './ui';

/**
 * Menu "Progetti": le istanze di Studio aperte su questo computer (una per progetto), con
 * apertura in una nuova scheda del browser, avvio di Studio su un'altra cartella e chiusura.
 */
export class ProjectsMenu {
  private readonly authHeaders: () => Record<string, string>;
  private readonly platform: string;
  private confirmPid: number | null = null;
  private confirmTimer = 0;
  private currentPid: number | null = null;
  /** Questa istanza sta per chiudersi (chiesto da questa pagina). */
  onShutdownRequested?: () => void;

  constructor(authHeaders: () => Record<string, string>, platform: string) {
    this.authHeaders = authHeaders;
    this.platform = platform;
    const button = $('btn-projects');
    const popover = $('projects');
    const input = $('project-path') as HTMLInputElement;
    input.placeholder = t(platform === 'win32' ? 'projects.pathPlaceholderWin' : 'projects.pathPlaceholderUnix');

    button.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!popover.hidden) return this.close();
      const r = button.getBoundingClientRect();
      popover.style.top = `${r.bottom + 6}px`;
      popover.style.left = `${Math.max(8, Math.min(window.innerWidth - 470, r.left))}px`;
      popover.hidden = false;
      $('project-error').hidden = true;
      void this.refresh();
    });
    document.addEventListener('pointerdown', (e) => {
      if (!popover.hidden && !popover.contains(e.target as Node) && !button.contains(e.target as Node)) this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !popover.hidden) this.close();
    });
    $('project-form').addEventListener('submit', (e) => {
      e.preventDefault();
      void this.openPath(input.value);
    });
    $('projects-list').addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
      if (!btn) return;
      const pid = Number(btn.dataset.pid);
      if (btn.dataset.action === 'open') window.open(btn.dataset.url!, '_blank', 'noopener');
      else if (btn.dataset.action === 'close') void this.closeInstance(pid);
    });
    $('projects-recent').addEventListener('click', (e) => {
      const chip = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-cwd]');
      if (chip) void this.openPath(chip.dataset.cwd!);
    });
  }

  private close(): void {
    $('projects').hidden = true;
    this.confirmPid = null;
  }

  private async refresh(): Promise<void> {
    const list = $('projects-list');
    try {
      const res = await fetch('/api/projects', { headers: this.authHeaders(), cache: 'no-store' });
      const body = (await res.json()) as ProjectsResponse;
      if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
      this.renderInstances(body.instances ?? []);
      const open = new Set((body.instances ?? []).map((i) => this.key(i.cwd)));
      const recent = (body.recent ?? []).filter((r) => !open.has(this.key(r.cwd))).slice(0, 8);
      $('projects-recent-wrap').hidden = recent.length === 0;
      $('projects-recent').innerHTML = recent
        .map((r) => {
          // La modalità ricordata (app desktop) si vede sul pulsante: il progetto riparte così
          const mode = r.launch?.mode && r.launch.mode !== 'web' ? ` · ${t(`projects.mode.${r.launch.mode}`)}` : '';
          return `<button type="button" class="chip" data-cwd="${escapeHtml(r.cwd)}" title="${escapeHtml(r.cwd + mode)}">${escapeHtml(r.project)}${mode ? `<small>${escapeHtml(mode)}</small>` : ''}</button>`;
        })
        .join('');
    } catch (err) {
      list.innerHTML = `<li class="proj-empty">${escapeHtml(t('projects.unavailable', { error: (err as Error).message }))}</li>`;
    }
  }

  private key(cwd: string): string {
    return this.platform === 'win32' ? cwd.toLowerCase() : cwd;
  }

  private renderInstances(instances: ProjectInstance[]): void {
    this.currentPid = instances.find((p) => p.current)?.pid ?? this.currentPid;
    $('projects-list').innerHTML = instances
      .map((p) => {
        const confirming = this.confirmPid === p.pid;
        const closeLabel = confirming ? t(p.current ? 'projects.confirmCloseStudio' : 'projects.confirmClose') : t('common.close');
        return `<li class="proj${p.current ? ' current' : ''}">
          <span class="proj-icon" aria-hidden="true">${icon('folder')}</span>
          <span class="proj-main"><strong>${escapeHtml(p.project)}</strong><small title="${escapeHtml(p.cwd)}">${escapeHtml(p.cwd)}</small></span>
          ${p.current ? `<span class="proj-badge">${escapeHtml(t('projects.thisPage'))}</span>` : `<button type="button" class="btn btn-small" data-action="open" data-pid="${p.pid}" data-url="${escapeHtml(p.url)}">${icon('external')}<span>${escapeHtml(t('projects.open'))}</span></button>`}
          <button type="button" class="btn btn-small${confirming ? ' btn-danger' : ''}" data-action="close" data-pid="${p.pid}" title="${escapeHtml(t('projects.close.title'))}">${escapeHtml(closeLabel)}</button>
        </li>`;
      })
      .join('');
  }

  /** Avvia Studio per un'altra cartella (o apre quello già attivo) in una nuova scheda. */
  private async openPath(dir: string): Promise<void> {
    const error = $('project-error');
    error.hidden = true;
    if (!dir.trim()) {
      error.textContent = t('projects.emptyPath');
      error.hidden = false;
      return;
    }
    const button = $('project-open') as HTMLButtonElement;
    if (button.disabled) return; // apertura già in corso
    // La scheda va aperta subito, nel gesto dell'utente: dopo l'attesa il browser la bloccherebbe.
    const win = window.open('', '_blank');
    if (win) win.document.write(`<title>Riverloop Studio</title><p style="font:15px system-ui;padding:24px">${escapeHtml(t('projects.launching'))}</p>`);
    button.disabled = true;
    button.textContent = t('projects.starting');
    const chips = Array.from($('projects-recent').querySelectorAll<HTMLButtonElement>('button'));
    chips.forEach((c) => (c.disabled = true));
    try {
      const res = await fetch('/api/projects/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({ path: dir }),
      });
      const body = (await res.json().catch(() => ({}))) as ProjectsResponse;
      if (!res.ok || !body.ok || !body.url) throw new Error(body.error || `HTTP ${res.status}`);
      if (win) {
        win.opener = null;
        win.location.href = body.url;
      } else {
        window.open(body.url, '_blank', 'noopener');
      }
      ($('project-path') as HTMLInputElement).value = '';
      toast(t('projects.opened'), 'ok');
      void this.refresh();
    } catch (err) {
      win?.close();
      error.textContent = (err as Error).message;
      error.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = t('projects.start');
      chips.forEach((c) => (c.disabled = false));
    }
  }

  /** Chiude un progetto (o questo, con un secondo clic di conferma). */
  private async closeInstance(pid: number): Promise<void> {
    if (this.confirmPid !== pid) {
      this.confirmPid = pid;
      window.clearTimeout(this.confirmTimer);
      this.confirmTimer = window.setTimeout(() => {
        this.confirmPid = null;
        void this.refresh();
      }, 4000);
      void this.refresh();
      return;
    }
    this.confirmPid = null;
    try {
      const res = await fetch('/api/projects/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({ pid }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (pid === this.currentPid) {
        this.close();
        this.onShutdownRequested?.();
        return;
      }
      toast(t('projects.closed'), 'ok');
      setTimeout(() => void this.refresh(), 600);
    } catch (err) {
      toast(t('projects.closeFailed', { error: (err as Error).message }), 'error');
    }
  }
}
