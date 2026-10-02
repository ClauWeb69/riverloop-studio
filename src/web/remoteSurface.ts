import { MOD_ALT, MOD_CTRL, MOD_META, MOD_SHIFT, type AppView, type PageToOverlay, type Rect, type StudioConfig } from '../shared/protocol';
import type { AppChannel, AppFrame } from './appChannel';
import { DesktopChrome } from './desktopChrome';
import { forAppOverlay, type Surface, type SurfaceHost } from './surface';
import { t } from './i18n';
import { $ } from './ui';

const mods = (ev: MouseEvent | KeyboardEvent | WheelEvent): number => {
  // AltGr arriva come Ctrl+Alt: per il testo (es. @ e # sulle tastiere italiane) non sono modificatori
  if (ev.getModifierState?.('AltGraph')) return ev.shiftKey ? MOD_SHIFT : 0;
  return (ev.altKey ? MOD_ALT : 0) | (ev.ctrlKey ? MOD_CTRL : 0) | (ev.metaKey ? MOD_META : 0) | (ev.shiftKey ? MOD_SHIFT : 0);
};

/**
 * App desktop Chromium (Electron, WebView2): la pagina dell'app è mostrata con uno screencast
 * e riceve da qui mouse e tastiera. Le annotazioni le gestisce lo stesso overlay delle app
 * web, iniettato nella pagina dell'app: i suoi segni si vedono nello screencast.
 */
export class RemoteSurface implements Surface {
  ready = false;
  private readonly chrome: DesktopChrome;
  private lastSeq = 0;
  private clicks = { time: 0, x: 0, y: 0, count: 0, button: -1 };
  private moveQueued: PointerEvent | null = null;
  /**
   * Campo invisibile che tiene il focus della tastiera. I tasti normali vengono inoltrati
   * all'app (e non scrivono qui); ciò che arriva solo come testo — accenti composti con i tasti
   * morti, IME, selettore di emoji, dettatura, "Incolla" dal menu — passa da qui all'app.
   */
  private readonly keys = document.createElement('textarea');

  constructor(
    config: StudioConfig,
    private readonly host: SurfaceHost,
    private readonly channel: AppChannel,
  ) {
    this.chrome = new DesktopChrome('electron', channel, config.devServer.managed);
    const canvas = this.chrome.canvas;
    canvas.classList.add('interactive');
    canvas.removeAttribute('tabindex');
    const keys = this.keys;
    keys.className = 'app-keys';
    keys.setAttribute('aria-label', t('app.keys'));
    keys.autocapitalize = 'off';
    keys.spellcheck = false;
    $('app-view').appendChild(keys);

    channel.onView = (view) => this.onView(view);
    channel.onFrame = (frame) => this.onFrame(frame);
    channel.onOverlay = (msg) => {
      if (msg.type === 'ready') this.setReady(true);
      this.host.onSurfaceMessage(msg);
    };
    channel.onOpen = () => this.chrome.sendViewport();
    new ResizeObserver(() => this.chrome.sendViewport()).observe($('stage'));
    this.chrome.sendViewport();

    // --- mouse ---
    canvas.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      keys.focus({ preventScroll: true });
      try {
        canvas.setPointerCapture(ev.pointerId);
      } catch {
        /* puntatore non catturabile */
      }
      const p = this.chrome.point(ev);
      const c = this.clicks;
      const again = ev.button === c.button && ev.timeStamp - c.time < 450 && Math.hypot(ev.clientX - c.x, ev.clientY - c.y) < 6;
      this.clicks = { time: ev.timeStamp, x: ev.clientX, y: ev.clientY, count: again ? Math.min(3, c.count + 1) : 1, button: ev.button };
      this.flushMove();
      channel.send({ type: 'mouse', action: 'down', x: p.x, y: p.y, button: ev.button, buttons: ev.buttons, clicks: this.clicks.count, mods: mods(ev) });
    });
    canvas.addEventListener('pointermove', (ev) => {
      // Al più un movimento per fotogramma: basta e non intasa il canale
      if (!this.moveQueued) requestAnimationFrame(() => this.flushMove());
      this.moveQueued = ev;
    });
    canvas.addEventListener('pointerup', (ev) => {
      ev.preventDefault();
      this.flushMove();
      const p = this.chrome.point(ev);
      channel.send({ type: 'mouse', action: 'up', x: p.x, y: p.y, button: ev.button, buttons: ev.buttons, clicks: this.clicks.count || 1, mods: mods(ev) });
    });
    canvas.addEventListener('pointercancel', (ev) => {
      // Gesto interrotto dal browser o dal sistema: l'app non deve restare con il pulsante premuto
      this.moveQueued = null;
      const p = this.chrome.point(ev);
      channel.send({ type: 'mouse', action: 'up', x: p.x, y: p.y, button: ev.button > 0 ? ev.button : 0, buttons: 0, clicks: 1, mods: 0 });
    });
    canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
    canvas.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        const factor = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? this.chrome.size.height || 600 : 1;
        const p = this.chrome.point(ev);
        channel.send({ type: 'wheel', x: p.x, y: p.y, dx: ev.deltaX * factor, dy: ev.deltaY * factor, mods: mods(ev) });
      },
      { passive: false },
    );

    // --- tastiera: i tasti vanno all'app, non alle scorciatoie della pagina Studio ---
    const key = (action: 'down' | 'up') => (ev: KeyboardEvent) => {
      ev.stopPropagation();
      // Composizione in corso (IME, tasti morti): il testo arriva dopo, dal campo
      if (ev.isComposing || ev.key === 'Process' || ev.key === 'Dead' || ev.key === 'Unidentified') return;
      ev.preventDefault();
      channel.send({ type: 'key', action, key: ev.key, code: ev.code, keyCode: ev.keyCode, mods: mods(ev), repeat: ev.repeat, location: ev.location });
    };
    keys.addEventListener('keydown', key('down'));
    keys.addEventListener('keyup', key('up'));
    const flushText = () => {
      const text = keys.value;
      keys.value = '';
      if (text) channel.send({ type: 'text', text });
    };
    keys.addEventListener('compositionend', () => setTimeout(flushText, 0));
    keys.addEventListener('input', (ev) => {
      if (!(ev as InputEvent).isComposing) flushText();
    });
  }

  private flushMove(): void {
    const ev = this.moveQueued;
    this.moveQueued = null;
    if (!ev) return;
    const p = this.chrome.point(ev);
    this.channel.send({ type: 'mouse', action: 'move', x: p.x, y: p.y, button: 0, buttons: ev.buttons, clicks: 0, mods: mods(ev) });
  }

  private setReady(ready: boolean): void {
    if (this.ready === ready) return;
    this.ready = ready;
    this.host.onSurfaceReady();
  }

  private onView(view: AppView): void {
    this.chrome.render(view);
    if (!view.overlay || view.state === 'waiting') this.setReady(false);
    if (view.state === 'waiting') {
      this.lastSeq = 0;
      this.chrome.clear();
    }
  }

  private onFrame(frame: AppFrame): void {
    const { meta, bitmap } = frame;
    // La decodifica è asincrona: un fotogramma vecchio non deve coprirne uno più recente
    if (meta.seq < this.lastSeq) {
      bitmap.close();
      return;
    }
    this.lastSeq = meta.seq;
    this.chrome.draw(bitmap, bitmap.width, bitmap.height, meta.width, meta.height);
    bitmap.close();
  }

  post(msg: PageToOverlay): void {
    this.channel.send({ type: 'overlay', msg: forAppOverlay(msg) });
  }

  nav(action: 'back' | 'forward' | 'reload'): void {
    this.channel.send({ type: 'nav', action });
  }

  navigate(): void {
    /* le app desktop non hanno una barra degli indirizzi */
  }

  locate(rect: Rect): Rect {
    return this.chrome.locate(rect);
  }

  unavailable(): string | null {
    if (this.ready) return null;
    return this.chrome.view?.state === 'live' ? t('remote.noOverlay') : t('remote.hidden');
  }
}
