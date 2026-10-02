import { MESSAGE_SOURCE, type OverlayToPage, type PageToOverlay, type Rect, type StudioConfig } from '../shared/protocol';
import { forAppOverlay, type Surface, type SurfaceHost } from './surface';
import { t } from './i18n';
import { $ } from './ui';

/** App web: iframe sul proxy del companion; l'overlay nella pagina parla via postMessage. */
export class FrameSurface implements Surface {
  readonly frame: HTMLIFrameElement;
  readonly proxyOrigin: string;
  ready = false;
  /** L'overlay annuncia "ready" prima dell'evento load dell'iframe (lo script è async). */
  private readySinceLoad = false;
  private current = '/';

  constructor(
    config: StudioConfig,
    private readonly host: SurfaceHost,
    initialPath: string,
  ) {
    this.frame = $('app-frame') as HTMLIFrameElement;
    this.frame.hidden = false;
    this.proxyOrigin = `${location.protocol}//${location.hostname}:${config.proxyPort}`;
    this.current = initialPath;
    this.frame.src = this.proxyOrigin + initialPath;

    window.addEventListener('message', (ev) => this.onMessage(ev));
    this.frame.addEventListener('load', () => {
      // Senza overlay (pagina d'errore del proxy, file non HTML...) gli strumenti non sono disponibili.
      this.ready = this.readySinceLoad;
      this.readySinceLoad = false;
      this.host.onSurfaceReady();
    });
  }

  private onMessage(ev: MessageEvent): void {
    if (ev.origin !== this.proxyOrigin || ev.source !== this.frame.contentWindow) return;
    const msg = ev.data as (OverlayToPage & { source?: string }) | null;
    if (!msg || typeof msg !== 'object' || msg.source !== MESSAGE_SOURCE || typeof msg.type !== 'string') return;
    if (msg.type === 'ready') {
      this.ready = true;
      this.readySinceLoad = true;
    }
    if ((msg.type === 'ready' || msg.type === 'location') && typeof msg.url === 'string') this.current = msg.url.slice(0, 2000);
    this.host.onSurfaceMessage(msg);
  }

  post(msg: PageToOverlay): void {
    this.frame.contentWindow?.postMessage({ ...forAppOverlay(msg), source: MESSAGE_SOURCE }, this.proxyOrigin);
  }

  nav(action: 'back' | 'forward' | 'reload'): void {
    if (this.ready) {
      this.post({ type: 'nav', action });
      return;
    }
    if (action === 'reload') this.frame.src = this.proxyOrigin + this.current;
  }

  navigate(url: string): void {
    this.current = url;
    this.frame.src = this.proxyOrigin + url;
  }

  /** L'iframe può essere ridimensionato (viewport tablet e mobile): la zona segue la sua scala. */
  locate(rect: Rect): Rect {
    const stage = $('stage').getBoundingClientRect();
    const frame = this.frame.getBoundingClientRect();
    const scale = this.frame.offsetWidth ? frame.width / this.frame.offsetWidth : 1;
    return {
      x: frame.left - stage.left + rect.x * scale,
      y: frame.top - stage.top + rect.y * scale,
      width: rect.width * scale,
      height: rect.height * scale,
    };
  }

  unavailable(): string | null {
    return this.ready ? null : t('frame.noOverlay');
  }
}
