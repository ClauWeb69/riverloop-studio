import type { AppMode, AppView } from '../shared/protocol';
import type { AppChannel } from './appChannel';
import { fitInside } from './surface';
import { t } from './i18n';
import { $ } from './ui';

/**
 * Parti comuni alle due modalità desktop nel pannello dell'app: la tela su cui viene disegnata
 * l'app, la barra con finestra e titolo, e il riquadro di avviso quando l'app non è visibile.
 */
export class DesktopChrome {
  readonly canvas = $('app-canvas') as HTMLCanvasElement;
  readonly marks = $('app-marks');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly select = $('win-select') as HTMLSelectElement;
  view: AppView | null = null;
  /** Dimensione logica di ciò che è disegnato sulla tela (px della pagina o della finestra). */
  private logical = { width: 0, height: 0 };
  /** Azione del pulsante "Condividi la finestra" (solo finestre native senza cattura dal sistema). */
  onShare?: () => void;
  onLayout?: () => void;

  constructor(
    mode: AppMode,
    private readonly channel: AppChannel,
    managed: boolean,
  ) {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('canvas non disponibile');
    this.ctx = ctx;
    $('app-view').hidden = false;
    $('app-frame').hidden = true;
    $('url-form').hidden = true;
    $('viewport-seg').hidden = true;
    $('desk-info').hidden = false;
    $('desk-kind').textContent = t(mode === 'electron' ? 'desk.kindApp' : 'desk.kindWindow');
    ($('app-front') as HTMLButtonElement).hidden = false;
    ($('app-restart') as HTMLButtonElement).hidden = !managed;
    if (mode === 'window') {
      // Una finestra nativa non ha cronologia: resta solo "aggiorna"
      $('nav-back').hidden = true;
      $('nav-forward').hidden = true;
      $('nav-reload').title = t('nav.reloadWindow');
    }

    this.select.addEventListener('change', () => {
      if (this.select.value) channel.send({ type: 'select', id: this.select.value });
    });
    $('app-front').addEventListener('click', () => channel.send({ type: 'activate' }));
    $('app-restart').addEventListener('click', () => channel.send({ type: 'restart' }));
    $('app-notice-show').addEventListener('click', () => channel.send({ type: 'show' }));
    $('app-notice-share').addEventListener('click', () => this.onShare?.());
    new ResizeObserver(() => this.layout()).observe($('stage'));
  }

  /** Aggiorna barra e avviso con lo stato della vista. */
  render(view: AppView, options: { sharing?: boolean; title?: string } = {}): void {
    this.view = view;
    const windows = view.windows;
    // L'elenco serve se c'è da scegliere: più finestre, oppure nessuna ancora scelta
    const choose = windows.length > 1 || (windows.length === 1 && !view.current);
    this.select.hidden = !choose;
    if (choose) {
      const wanted = [...(view.current ? [] : [{ id: '', title: t('desk.chooseWindow') }]), ...windows];
      const signature = JSON.stringify(wanted);
      if (this.select.dataset.signature !== signature) {
        this.select.dataset.signature = signature;
        this.select.replaceChildren(
          ...wanted.map((w) => {
            const option = document.createElement('option');
            option.value = w.id;
            option.textContent = w.title.slice(0, 80) || t('desk.untitled');
            return option;
          }),
        );
      }
      this.select.value = view.current ?? '';
    }
    const title = options.title ?? view.title;
    const text = view.url && !/^file:/i.test(view.url) && view.url !== title ? `${title} — ${view.url}` : title;
    $('desk-title').textContent = choose ? '' : text;
    $('desk-title').title = text;

    const live = view.state === 'live' || options.sharing === true;
    const notice = $('app-notice');
    notice.hidden = live;
    if (!live) {
      const titles: Record<string, string> = {
        waiting: t('notice.waiting'),
        hidden: t('notice.hidden'),
        unsupported: t('notice.unsupported'),
      };
      $('app-notice-title').textContent = titles[view.state] ?? '';
      $('app-notice-text').textContent = view.message;
      ($('app-notice-show') as HTMLButtonElement).hidden = view.state !== 'hidden';
      ($('app-notice-share') as HTMLButtonElement).hidden = view.state !== 'unsupported';
    }
    ($('app-front') as HTMLButtonElement).disabled = !view.current;
  }

  /** Disegna un'immagine sulla tela; width/height sono la sua dimensione logica. */
  draw(image: CanvasImageSource, pixelWidth: number, pixelHeight: number, width: number, height: number): void {
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }
    this.ctx.drawImage(image, 0, 0, pixelWidth, pixelHeight);
    if (this.logical.width !== width || this.logical.height !== height) {
      this.logical = { width, height };
      // Dimensione logica leggibile da fuori (diagnostica e test end-to-end)
      this.canvas.dataset.logicalWidth = String(width);
      this.canvas.dataset.logicalHeight = String(height);
      this.layout();
    }
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Dimensione logica attuale (0 finché non è arrivata un'immagine). */
  get size(): { width: number; height: number } {
    return this.logical;
  }

  /** Pixel sullo schermo per ogni px logico dell'app. */
  get scale(): number {
    return this.logical.width ? this.canvas.getBoundingClientRect().width / this.logical.width : 1;
  }

  layout(): void {
    const stage = $('stage');
    const fit = fitInside(this.logical.width, this.logical.height, stage.clientWidth, stage.clientHeight);
    const style = this.canvas.style;
    style.width = `${fit.width}px`;
    style.height = `${fit.height}px`;
    const left = Math.max(0, Math.round((stage.clientWidth - fit.width) / 2));
    const top = Math.max(0, Math.round((stage.clientHeight - fit.height) / 2));
    style.left = `${left}px`;
    style.top = `${top}px`;
    const m = this.marks.style;
    m.left = style.left;
    m.top = style.top;
    m.width = style.width;
    m.height = style.height;
    this.onLayout?.();
  }

  /** Dimensione utile del pannello in pixel fisici: i fotogrammi non servono più grandi. */
  sendViewport(): void {
    const stage = $('stage');
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    this.channel.send({ type: 'viewport', width: Math.round(stage.clientWidth * dpr), height: Math.round(stage.clientHeight * dpr) });
  }

  /** Punto del puntatore in coordinate logiche dell'app. */
  point(ev: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    const k = r.width ? this.logical.width / r.width : 1;
    return { x: (ev.clientX - r.left) * k, y: (ev.clientY - r.top) * k };
  }

  /** Zona in coordinate logiche dell'app → coordinate dello stage (per la casella del commento). */
  locate(rect: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number } {
    const stage = $('stage').getBoundingClientRect();
    const r = this.canvas.getBoundingClientRect();
    const k = this.scale;
    return { x: r.left - stage.left + rect.x * k, y: r.top - stage.top + rect.y * k, width: rect.width * k, height: rect.height * k };
  }
}
