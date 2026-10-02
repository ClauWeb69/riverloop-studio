import { CLAUDE_EFFORTS, CLAUDE_MODELS, type ClaudeAction, type PermissionModeName, type SessionInfo, type UsageWindow } from '../shared/protocol';
import type { ConsolePanel } from './console';
import { pageLocale, t } from './i18n';
import type { SessionTabs } from './sessions';
import { $, toast } from './ui';

/** Modalità proposte nel menu, nell'ordine di Shift+Tab. */
const MODES: PermissionModeName[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
/** Voci del menu dell'effort che accendono o spengono ultracode (non sono livelli). */
const ULTRACODE_ON = 'ultracode:on';
const ULTRACODE_OFF = 'ultracode:off';

/**
 * Barra di Claude sotto le schede della console: modello, effort, modalità dei permessi, goal e
 * utilizzo del piano della scheda attiva. Ogni comando equivale a quello scritto nella console
 * (/model, /effort, /goal, /usage, Shift+Tab): il companion lo esegue solo con il riquadro di
 * input di Claude Code libero, e altrimenti spiega perché no.
 */
export class ClaudeBar {
  private readonly tabs: SessionTabs;
  private readonly consolePanel: ConsolePanel;
  private readonly authHeaders: () => Record<string, string>;
  private readonly model = $('cb-model') as HTMLSelectElement;
  private readonly effort = $('cb-effort') as HTMLSelectElement;
  private readonly mode = $('cb-mode') as HTMLSelectElement;
  private readonly usage = $('cb-usage') as HTMLButtonElement;
  private readonly goalPopover = $('goal');
  private readonly goalText = $('goal-text') as HTMLTextAreaElement;
  private busy = false;

  constructor(tabs: SessionTabs, consolePanel: ConsolePanel, authHeaders: () => Record<string, string>) {
    this.tabs = tabs;
    this.consolePanel = consolePanel;
    this.authHeaders = authHeaders;

    this.model.addEventListener('change', () => {
      const value = this.model.value;
      this.render();
      if (value)
        void this.run({ action: 'model', value: value as (typeof CLAUDE_MODELS)[number] }, t('claudeBar.sent.model', { value: this.modelName(value) }));
    });
    this.effort.addEventListener('change', () => {
      const value = this.effort.value;
      this.render();
      if (value === ULTRACODE_ON || value === ULTRACODE_OFF) {
        const on = value === ULTRACODE_ON;
        void this.run({ action: 'ultracode', value: on }, t(on ? 'claudeBar.sent.ultracodeOn' : 'claudeBar.sent.ultracodeOff'));
      } else if (value)
        void this.run({ action: 'effort', value: value as (typeof CLAUDE_EFFORTS)[number] }, t('claudeBar.sent.effort', { value: this.effortName(value) }));
    });
    this.mode.addEventListener('change', () => {
      const value = this.mode.value as PermissionModeName;
      this.render();
      if (value) void this.run({ action: 'mode', value }, t('claudeBar.sent.mode', { value: t(`claudeBar.mode.${value}`) }));
    });
    this.usage.addEventListener('click', () => void this.run({ action: 'usage' }, null));
    this.setupGoal();
    this.render();
  }

  /** La scheda attiva o l'elenco delle schede sono cambiati. */
  update(): void {
    if (!this.busy) this.render();
  }

  private get session(): SessionInfo | undefined {
    return this.tabs.active;
  }

  private modelName(alias: string): string {
    return alias === 'default' ? t('claudeBar.model.default') : alias[0].toUpperCase() + alias.slice(1);
  }

  private effortName(level: string): string {
    return level === 'auto' ? t('claudeBar.effort.auto') : level;
  }

  /** Menu con in cima il valore attuale (scritto, non selezionabile) e sotto le scelte (con un eventuale suggerimento). */
  private fill(select: HTMLSelectElement, current: string, options: Array<[string, string, string?]>): void {
    select.replaceChildren();
    const head = new Option(current, '', true, true);
    head.disabled = true;
    head.hidden = true;
    const items = options.map(([value, label, title]) => {
      const option = new Option(label, value);
      if (title) option.title = title;
      return option;
    });
    select.append(head, ...items);
    select.value = '';
  }

  private render(): void {
    const s = this.session;
    const claude = s?.claude;
    const running = s?.state === 'running';
    const unknown = t('claudeBar.unknown');

    this.fill(
      this.model,
      `${t('claudeBar.model')}: ${claude?.model ?? unknown}`,
      CLAUDE_MODELS.map((m) => [m, this.modelName(m)]),
    );
    // Ultracode: in coda ai livelli, la voce per accenderlo o (se è acceso) spegnerlo
    const ultracode = claude?.ultracode === true;
    const effortHead = `${t('claudeBar.effort')}: ${claude?.effort ? this.effortName(claude.effort) : unknown}${ultracode ? ` · ${t('claudeBar.ultracode')}` : ''}`;
    this.fill(this.effort, effortHead, [
      ...CLAUDE_EFFORTS.map((e): [string, string] => [e, this.effortName(e)]),
      ultracode
        ? [ULTRACODE_OFF, t('claudeBar.ultracodeOff'), t('claudeBar.ultracodeTitle')]
        : [ULTRACODE_ON, t('claudeBar.ultracodeOn'), t('claudeBar.ultracodeTitle')],
    ]);
    this.effort.dataset.ultracode = ultracode ? 'on' : '';
    const modes = MODES.filter((m) => m !== 'bypassPermissions' || s?.permissions === 'skip');
    const current = claude?.mode ? t(`claudeBar.mode.${claude.mode}`) : unknown;
    this.fill(
      this.mode,
      `${t('claudeBar.modeLabel')}: ${current}`,
      modes.map((m) => [m, t(`claudeBar.mode.${m}`)]),
    );
    this.mode.dataset.mode = claude?.mode ?? '';
    for (const el of [this.model, this.effort, this.mode, this.usage, $('cb-goal')]) (el as HTMLButtonElement).disabled = !running || this.busy;

    this.usage.textContent = this.usageText(claude?.fiveHour ?? null, claude?.sevenDay ?? null, claude?.context ?? null);
    this.usage.title = this.usageTitle(claude?.fiveHour ?? null, claude?.sevenDay ?? null);
    const level = Math.max(claude?.fiveHour?.used ?? 0, claude?.sevenDay?.used ?? 0);
    this.usage.dataset.level = level >= 90 ? 'high' : level >= 70 ? 'warn' : '';
  }

  private usageText(five: UsageWindow | null, seven: UsageWindow | null, context: number | null): string {
    const parts: string[] = [];
    if (five) parts.push(t('claudeBar.usage.five', { n: Math.round(five.used) }));
    if (seven) parts.push(t('claudeBar.usage.seven', { n: Math.round(seven.used) }));
    if (context !== null) parts.push(t('claudeBar.usage.context', { n: Math.round(context) }));
    return parts.length ? parts.join(' · ') : t('claudeBar.usage.none');
  }

  private usageTitle(five: UsageWindow | null, seven: UsageWindow | null): string {
    const when = (w: UsageWindow | null) => {
      if (!w?.resetsAt) return '—';
      const date = new Date(w.resetsAt * 1000);
      const sameDay = date.toDateString() === new Date().toDateString();
      return date.toLocaleString(
        pageLocale(),
        sameDay ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
      );
    };
    const lines = [];
    if (five) lines.push(t('claudeBar.usage.fiveTitle', { n: Math.round(five.used), when: when(five) }));
    if (seven) lines.push(t('claudeBar.usage.sevenTitle', { n: Math.round(seven.used), when: when(seven) }));
    if (!lines.length) lines.push(t('claudeBar.usage.noneTitle'));
    lines.push(t('claudeBar.usage.click'));
    return lines.join('\n');
  }

  private setupGoal(): void {
    const button = $('cb-goal');
    const close = () => (this.goalPopover.hidden = true);
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this.goalPopover.hidden) return close();
      const r = button.getBoundingClientRect();
      this.goalPopover.style.top = `${r.bottom + 6}px`;
      this.goalPopover.style.left = `${Math.max(8, Math.min(window.innerWidth - 360, r.left))}px`;
      this.goalPopover.hidden = false;
      this.goalText.focus();
    });
    const set = () => {
      const text = this.goalText.value.trim();
      if (!text) {
        this.goalText.focus();
        return;
      }
      close();
      void this.run({ action: 'goal', value: text }, t('claudeBar.sent.goal')).then((ok) => {
        if (ok) this.goalText.value = '';
      });
    };
    $('goal-set').addEventListener('click', set);
    $('goal-clear').addEventListener('click', () => {
      close();
      void this.run({ action: 'goal', value: '' }, t('claudeBar.sent.goalClear'));
    });
    $('goal-cancel').addEventListener('click', close);
    this.goalText.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        set();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    });
    document.addEventListener('pointerdown', (e) => {
      if (!this.goalPopover.hidden && !this.goalPopover.contains(e.target as Node) && !button.contains(e.target as Node)) close();
    });
  }

  /** Manda l'azione al companion; true se è stata eseguita. Il focus torna alla console. */
  private async run(action: ClaudeAction, done: string | null): Promise<boolean> {
    const s = this.session;
    if (!s || this.busy) return false;
    this.busy = true;
    this.render();
    try {
      const res = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({ session: s.id, ...action }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; sessions?: SessionInfo[] };
      if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (body.sessions) this.tabs.update(body.sessions);
      if (done) toast(done, 'ok', 2500);
      return true;
    } catch (err) {
      toast((err as Error).message, 'error', 7000);
      return false;
    } finally {
      this.busy = false;
      this.render();
      this.consolePanel.focus();
    }
  }
}
