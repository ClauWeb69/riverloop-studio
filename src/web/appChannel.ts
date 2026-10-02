import { t } from './i18n';
import type { AppClientMessage, AppServerMessage, AppView, FrameMeta, NativeElement, NativeSummary, OverlayToPage, Rect } from '../shared/protocol';

export interface AppFrame {
  meta: FrameMeta;
  bitmap: ImageBitmap;
}

interface Waiter<T> {
  resolve: (value: T) => void;
  timer: number;
}

/**
 * Canale /ws/app con il companion (modalità desktop): stato della vista, fotogrammi dell'app,
 * messaggi dell'overlay (electron), fermi immagine ed elementi dell'interfaccia (window).
 * Si ricollega da solo; il token viaggia come sottoprotocollo, come per la console.
 */
export class AppChannel {
  private ws: WebSocket | null = null;
  private retry = 0;
  private stopped = false;
  private pendingMeta: FrameMeta | null = null;
  private nextReq = 0;
  private readonly stills = new Map<number, Waiter<AppFrame | string>>();
  private readonly elements = new Map<number, Waiter<NativeElement | null>>();
  private readonly zones = new Map<number, Waiter<NativeSummary[]>>();
  /** Messaggi da rimandare a ogni collegamento (dimensione del pannello, anteprima attiva). */
  private readonly sticky = new Map<string, AppClientMessage>();
  onView?: (view: AppView) => void;
  onFrame?: (frame: AppFrame) => void;
  onOverlay?: (msg: OverlayToPage) => void;
  onOpen?: () => void;

  constructor(private readonly token: string) {
    this.connect();
  }

  private connect(): void {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/app`, ['riverloop-studio', `rls-token.${this.token}`]);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      for (const msg of this.sticky.values()) ws.send(JSON.stringify(msg));
      this.onOpen?.();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        const meta = this.pendingMeta;
        this.pendingMeta = null;
        if (meta) void this.decode(meta, ev.data as ArrayBuffer);
        return;
      }
      let msg: AppServerMessage;
      try {
        msg = JSON.parse(ev.data) as AppServerMessage;
      } catch {
        return;
      }
      switch (msg.type) {
        case 'view':
          this.onView?.(msg.view);
          break;
        case 'frame':
          this.pendingMeta = msg.meta;
          break;
        case 'overlay':
          this.onOverlay?.(msg.msg);
          break;
        case 'still':
          if (!msg.ok) this.settle(this.stills, msg.req, msg.error || t('channel.captureFailed'));
          break;
        case 'element':
          this.settle(this.elements, msg.req, msg.element);
          break;
        case 'elementsIn':
          this.settle(this.zones, msg.req, Array.isArray(msg.items) ? msg.items : []);
          break;
        default:
          break;
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.pendingMeta = null;
      for (const req of [...this.stills.keys()]) this.settle(this.stills, req, t('result.unreachable'));
      for (const req of [...this.elements.keys()]) this.settle(this.elements, req, null);
      for (const req of [...this.zones.keys()]) this.settle(this.zones, req, []);
      if (this.stopped) return;
      this.retry++;
      setTimeout(() => this.connect(), Math.min(5000, 400 * 2 ** Math.min(this.retry, 4)));
    };
  }

  private settle<T>(map: Map<number, Waiter<T>>, req: number, value: T): void {
    const waiter = map.get(req);
    if (!waiter) return;
    map.delete(req);
    clearTimeout(waiter.timer);
    waiter.resolve(value);
  }

  private async decode(meta: FrameMeta, data: ArrayBuffer): Promise<void> {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(new Blob([data], { type: meta.format === 'png' ? 'image/png' : 'image/jpeg' }));
    } catch {
      if (meta.still !== undefined) this.settle(this.stills, meta.still, t('channel.badImage'));
      return;
    }
    if (meta.still !== undefined) {
      if (this.stills.has(meta.still)) this.settle(this.stills, meta.still, { meta, bitmap });
      else bitmap.close();
      return;
    }
    this.onFrame?.({ meta, bitmap });
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: AppClientMessage): void {
    // L'ultimo valore di questi messaggi vale anche dopo una riconnessione
    if (msg.type === 'viewport' || msg.type === 'live') this.sticky.set(msg.type, msg);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Fermo immagine a piena risoluzione della finestra; una stringa è il motivo del fallimento. */
  still(timeoutMs = 15000): Promise<AppFrame | string> {
    const req = ++this.nextReq;
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => this.settle(this.stills, req, t('channel.captureTimeout')), timeoutMs);
      this.stills.set(req, { resolve, timer });
      if (!this.connected) return this.settle(this.stills, req, t('result.unreachable'));
      this.send({ type: 'still', req });
    });
  }

  /** Elemento dell'interfaccia nativa sotto un punto della finestra (pixel dell'immagine). */
  elementAt(x: number, y: number, timeoutMs = 2500): Promise<NativeElement | null> {
    const req = ++this.nextReq;
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => this.settle(this.elements, req, null), timeoutMs);
      this.elements.set(req, { resolve, timer });
      if (!this.connected) return this.settle(this.elements, req, null);
      this.send({ type: 'element', req, x, y });
    });
  }

  /** Controlli dell'interfaccia nativa dentro una zona della finestra (pixel dell'immagine). */
  elementsIn(rect: Rect, timeoutMs = 3000): Promise<NativeSummary[]> {
    const req = ++this.nextReq;
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => this.settle(this.zones, req, []), timeoutMs);
      this.zones.set(req, { resolve, timer });
      if (!this.connected) return this.settle(this.zones, req, []);
      this.send({ type: 'elementsIn', req, rect });
    });
  }

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
}
