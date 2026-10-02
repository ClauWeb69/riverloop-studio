import { normalizeLocale, type Locale } from '../shared/i18n';
import type { AppMode, ControlMessage, DevServerStatus, HistoryState, SessionInfo } from '../shared/protocol';
import { t, type MessageKey } from './i18n';
import { $, toast } from './ui';

/**
 * Canale di controllo con il companion (/ws/overlay): stato del dev server o dell'app desktop
 * (chip in alto e banner con le ultime righe di log), riavvio, fine risposta di Claude Code.
 */
export class ControlChannel {
  private ws: WebSocket | null = null;
  private retry = 0;
  private status: DevServerStatus;
  private dismissedExit = false;
  onDevStatus?: (status: DevServerStatus, previous: DevServerStatus) => void;
  /** Elenco delle sessioni di Claude Code aggiornato (schede aperte, chiuse, stato). */
  onSessions?: (sessions: SessionInfo[]) => void;
  /** Claude Code ha finito una risposta (modalità desktop). */
  onIdle?: (restarted: boolean) => void;
  /** La scelta "riavvia a fine risposta" è cambiata (anche da un'altra finestra di Studio). */
  onRestartOnIdle?: (value: boolean) => void;
  /** Annulla e Ripeti: cosa si può fare adesso (cambia dopo ogni richiesta e ogni ripristino). */
  onHistory?: (history: HistoryState) => void;
  /** Studio si sta chiudendo. */
  onShutdown?: () => void;
  /** La lingua di Studio è cambiata (da questa o da un'altra pagina). */
  onLocale?: (locale: Locale) => void;
  private stopped = false;

  private readonly token: string;
  private readonly desktop: boolean;

  constructor(initial: DevServerStatus, token: string, mode: AppMode = 'web') {
    this.status = initial;
    this.token = token;
    this.desktop = mode !== 'web';
    if (this.desktop) {
      $('dev-restart').dataset.i18n = 'devBanner.restartApp';
      $('dev-restart').querySelector('.lbl')?.replaceChildren(t('devBanner.restartApp'));
    }
    $('dev-restart').addEventListener('click', () => this.restartDevServer());
    $('dev-banner-close').addEventListener('click', () => {
      this.dismissedExit = true;
      $('dev-banner').hidden = true;
    });
    $('dev-chip').addEventListener('click', () => {
      if (this.status.state === 'exited') {
        this.dismissedExit = false;
        this.render();
      }
    });
    this.render();
    this.connect();
  }

  private connect(): void {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/overlay`, ['riverloop-studio', `rls-token.${this.token}`]);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
    };
    ws.onmessage = (ev) => {
      let msg: ControlMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ControlMessage;
      } catch {
        return;
      }
      if (msg.type === 'devserver') {
        const previous = this.status;
        if (msg.status.state !== 'exited') this.dismissedExit = false;
        this.status = msg.status;
        this.render();
        this.onDevStatus?.(msg.status, previous);
      } else if (msg.type === 'sessions') {
        this.onSessions?.(msg.sessions);
      } else if (msg.type === 'autosend' && !msg.ok) {
        toast(t('send.autosendFailed', { name: msg.name }), 'error', 8000);
      } else if (msg.type === 'idle') {
        this.onIdle?.(msg.restarted);
      } else if (msg.type === 'restart-on-idle') {
        this.onRestartOnIdle?.(msg.value);
      } else if (msg.type === 'history') {
        this.onHistory?.(msg.history);
      } else if (msg.type === 'locale') {
        const locale = normalizeLocale(msg.locale);
        if (locale) this.onLocale?.(locale);
      } else if (msg.type === 'shutdown') {
        this.stop();
        this.onShutdown?.();
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws || this.stopped) return;
      this.ws = null;
      this.retry++;
      setTimeout(() => this.connect(), Math.min(5000, 400 * 2 ** Math.min(this.retry, 4)));
    };
  }

  /** Niente più riconnessioni (Studio chiuso). */
  stop(): void {
    this.stopped = true;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* già chiuso */
    }
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Riavvia il dev server (web) o l'app desktop. */
  restartDevServer(): void {
    this.send({ type: 'devserver:restart' });
  }

  setRestartOnIdle(value: boolean): void {
    this.send({ type: 'restart-on-idle', value });
  }

  private render(): void {
    const s = this.status;
    const chip = $('dev-chip');
    chip.dataset.state = s.state;
    const label = chip.querySelector('.label') as HTMLElement;
    const host = `localhost:${s.port}`;
    const kind = this.desktop ? 'app' : 'web';
    const states = ['starting', 'external', 'unreachable', 'exited', 'disabled'];
    label.textContent =
      s.state === 'running'
        ? this.desktop
          ? t('chip.app.running')
          : host
        : states.includes(s.state)
          ? t(`chip.${kind}.${s.state}` as MessageKey, { host })
          : host;
    chip.title = s.command ? t(`chip.${kind}.command`, { command: s.command }) : t(`chip.${kind}.outside`);
    chip.classList.toggle('clickable', s.state === 'exited');

    const banner = $('dev-banner');
    const showBanner = s.state === 'exited' && !this.dismissedExit;
    banner.hidden = !showBanner;
    if (showBanner) {
      const hasCode = s.exitCode !== null && s.exitCode !== undefined;
      const title = this.desktop
        ? hasCode
          ? 'devBanner.stoppedAppCode'
          : 'devBanner.stoppedApp'
        : hasCode
          ? 'devBanner.stoppedWebCode'
          : 'devBanner.stoppedWeb';
      $('dev-banner-title').textContent = t(title, { code: String(s.exitCode) });
      $('dev-banner-log').textContent = s.log.slice(-20).join('\n') || t('devBanner.noOutput');
      ($('dev-restart') as HTMLButtonElement).hidden = !s.managed;
    }
  }
}
