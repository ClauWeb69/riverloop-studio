import type {
  AnnotationContext,
  AnnotationData,
  AnnotationView,
  AppMode,
  OverlayToPage,
  PageToOverlay,
  Rect,
  StudioConfig,
  ToolMode,
} from '../shared/protocol';
import type { AppChannel } from './appChannel';
import { FrameSurface } from './frameSurface';
import { pageLocale } from './i18n';
import { ImageSurface } from './imageSurface';
import { prefs, projectValue, setProjectValue, type ViewportMode } from './prefs';
import { RemoteSurface } from './remoteSurface';
import type { Surface, SurfaceHost } from './surface';
import { $, toast } from './ui';

const VIEWPORT_WIDTH: Record<ViewportMode, number | null> = { desktop: null, tablet: 768, mobile: 390 };

export interface AppPanelHooks {
  /** Annotazioni da mostrare nella pagina corrente. */
  viewsFor(url: string): AnnotationView[];
  onOverlayMessage(msg: OverlayToPage): void;
  /** Un nuovo documento nell'iframe ha caricato l'overlay. */
  onOverlayReady(): void;
  /** Prima di cambiare strumento (chiude la casella del commento aperta). */
  beforeModeChange(): void;
}

/**
 * Pannello dell'app: barra di navigazione, viewport e strumenti di annotazione attorno a una
 * "superficie" che dipende dal tipo di app (iframe per le app web, copia dal vivo per le app
 * desktop Chromium, immagine della finestra per le app native).
 */
export class AppPanel implements SurfaceHost {
  readonly appMode: AppMode;
  readonly surface: Surface;
  mode: ToolMode = 'navigate';
  currentUrl = '/';
  private readonly hooks: AppPanelHooks;
  private readonly project: string;
  private viewport: ViewportMode;

  constructor(config: StudioConfig, hooks: AppPanelHooks, channel: AppChannel | null) {
    this.hooks = hooks;
    this.project = config.project;
    this.appMode = config.mode;
    $('stage').dataset.app = config.mode;

    if (config.mode === 'web' || !channel) {
      $('url-host').textContent = `localhost:${config.devPort}`;
      // Un percorso dell'app (salvato da messaggi dell'overlay): sempre "/qualcosa", mai "//host"
      // o "@host", che attaccati all'origine del proxy porterebbero a un altro sito
      const saved = projectValue(this.project, 'path');
      const initial = saved && /^\/(?![/\\])/.test(saved) ? saved : '/';
      this.currentUrl = initial;
      ($('url-input') as HTMLInputElement).value = initial;
      this.surface = new FrameSurface(config, this, initial);
    } else {
      this.surface = config.mode === 'electron' ? new RemoteSurface(config, this, channel) : new ImageSurface(config, this, channel);
    }

    $('nav-back').addEventListener('click', () => this.nav('back'));
    $('nav-forward').addEventListener('click', () => this.nav('forward'));
    $('nav-reload').addEventListener('click', () => this.nav('reload'));
    $('url-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('url-input') as HTMLInputElement;
      this.navigate(input.value);
      input.blur();
    });

    this.viewport = this.appMode === 'web' ? prefs.get('viewport') : 'desktop';
    document.querySelectorAll<HTMLButtonElement>('[data-viewport]').forEach((btn) => {
      btn.addEventListener('click', () => this.setViewport(btn.dataset.viewport as ViewportMode));
    });
    this.applyViewport();
    new ResizeObserver(() => this.layoutDevice()).observe($('stage'));

    document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => this.setMode(btn.dataset.mode as ToolMode));
    });
    this.renderMode();
    this.updateNavButtons();
  }

  get overlayReady(): boolean {
    return this.surface.ready;
  }

  // -------------------------------------------------------------------------
  // Messaggi dalla superficie (overlay dell'app o annotatore locale)
  // -------------------------------------------------------------------------
  onSurfaceMessage(msg: OverlayToPage): void {
    switch (msg.type) {
      case 'ready':
        this.hooks.onOverlayReady();
        this.setUrl(typeof msg.url === 'string' ? msg.url.slice(0, 2000) : '/');
        this.sendHello();
        this.updateNavButtons();
        break;
      case 'location':
        this.setUrl(typeof msg.url === 'string' ? msg.url.slice(0, 2000) : '/');
        this.post({ type: 'annotations:sync', annotations: this.hooks.viewsFor(this.currentUrl) });
        break;
      case 'mode':
        // Dall'overlay (scorciatoie S/R/D/Esc nell'app) si cambia strumento solo mentre l'utente
        // sta già annotando: in Naviga l'app non deve poter attivare gli strumenti da sola.
        if (this.mode === 'navigate' && msg.mode !== 'navigate') break;
        if (['navigate', 'select', 'area', 'draw'].includes(msg.mode)) {
          if (msg.mode !== this.mode) this.hooks.beforeModeChange();
          this.mode = msg.mode;
          this.renderMode();
        }
        break;
      default:
        this.hooks.onOverlayMessage(msg);
    }
  }

  onSurfaceReady(): void {
    this.updateNavButtons();
    // Senza superficie pronta (pagina d'errore, finestra sparita) gli strumenti non sono disponibili.
    if (!this.surface.ready && this.mode !== 'navigate') {
      this.hooks.beforeModeChange();
      this.mode = 'navigate';
      this.renderMode();
    }
    // Le finestre native non hanno un overlay che si annuncia: la superficie pronta vale come "ready"
    if (this.surface.ready && this.appMode === 'window') this.sendHello();
  }

  /** Primo messaggio all'overlay: strumento attivo, annotazioni della pagina e lingua di Studio. */
  private sendHello(): void {
    this.post({ type: 'hello', mode: this.mode, annotations: this.hooks.viewsFor(this.currentUrl), locale: pageLocale() });
  }

  post(msg: PageToOverlay): void {
    this.surface.post(msg);
  }

  syncAnnotations(): void {
    if (this.surface.ready) this.post({ type: 'annotations:sync', annotations: this.hooks.viewsFor(this.currentUrl) });
  }

  /** Zona della superficie → coordinate dello stage (dove si apre la casella del commento). */
  locate(rect: Rect): Rect {
    return this.surface.locate(rect);
  }

  contextImages(batch: AnnotationData[]): Promise<AnnotationContext[]> {
    return this.surface.contextImages?.(batch) ?? Promise.resolve([]);
  }

  /** Claude Code ha finito una risposta. */
  idle(): void {
    this.surface.idle?.();
  }

  // -------------------------------------------------------------------------
  // Navigazione
  // -------------------------------------------------------------------------
  private setUrl(url: string): void {
    this.currentUrl = url || '/';
    if (this.appMode !== 'web') return;
    const input = $('url-input') as HTMLInputElement;
    if (document.activeElement !== input) input.value = this.currentUrl;
    setProjectValue(this.project, 'path', this.currentUrl);
  }

  private updateNavButtons(): void {
    if (this.appMode !== 'web') return;
    ($('nav-back') as HTMLButtonElement).disabled = !this.surface.ready;
    ($('nav-forward') as HTMLButtonElement).disabled = !this.surface.ready;
  }

  nav(action: 'back' | 'forward' | 'reload'): void {
    this.surface.nav(action);
  }

  navigate(raw: string): void {
    if (this.appMode !== 'web') return;
    let value = raw.trim();
    if (!value) value = '/';
    if (/^https?:\/\//i.test(value)) {
      try {
        const u = new URL(value);
        value = u.pathname + u.search + u.hash;
      } catch {
        /* resta com'è */
      }
    }
    if (!value.startsWith('/')) value = `/${value}`;
    this.currentUrl = value;
    this.surface.navigate(value);
  }

  reload(): void {
    this.nav('reload');
  }

  // -------------------------------------------------------------------------
  // Viewport (solo app web)
  // -------------------------------------------------------------------------
  setViewport(vp: ViewportMode): void {
    this.viewport = vp;
    prefs.set('viewport', vp);
    this.applyViewport();
  }

  private applyViewport(): void {
    $('stage').dataset.viewport = this.viewport;
    document.querySelectorAll<HTMLButtonElement>('[data-viewport]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.viewport === this.viewport);
    });
    this.layoutDevice();
  }

  private layoutDevice(): void {
    const stage = $('stage');
    const device = $('device');
    const badge = $('scale-badge');
    const width = VIEWPORT_WIDTH[this.viewport];
    if (!width) {
      device.style.width = '100%';
      device.style.height = '100%';
      device.style.transform = '';
      badge.hidden = true;
      return;
    }
    const availW = stage.clientWidth - 28;
    const availH = stage.clientHeight - 28;
    const scale = Math.max(0.2, Math.min(1, availW / width));
    device.style.width = `${width}px`;
    device.style.height = `${Math.max(200, availH / scale)}px`;
    device.style.transform = scale < 1 ? `scale(${scale})` : '';
    badge.hidden = scale >= 1;
    badge.textContent = `${width} px · ${Math.round(scale * 100)}%`;
  }

  // -------------------------------------------------------------------------
  // Strumenti
  // -------------------------------------------------------------------------
  setMode(mode: ToolMode): void {
    const reason = mode === 'navigate' ? null : this.surface.unavailable(mode);
    if (reason) {
      toast(reason, 'error');
      return;
    }
    if (mode !== this.mode) this.hooks.beforeModeChange();
    this.mode = mode;
    this.renderMode();
    this.post({ type: 'mode', mode });
  }

  private renderMode(): void {
    document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === this.mode);
    });
    $('stage').classList.toggle('annotating', this.mode !== 'navigate');
  }
}
