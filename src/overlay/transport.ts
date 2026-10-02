// Canale tra l'overlay e Studio. Due casi:
// - app web: l'overlay sta nell'iframe e parla con la pagina Studio via postMessage;
// - app desktop Chromium (Electron, WebView2): l'overlay sta nella pagina dell'app e parla con
//   il companion tramite la porta di debug (una funzione esposta in ingresso, una in uscita).
// In entrambi i casi i messaggi dell'overlay non sono fidati: chi li riceve li valida.
import { MESSAGE_SOURCE, type OverlayToPage, type PageToOverlay } from '../shared/protocol';

/** Messaggi che esistono solo tra overlay e companion (modalità desktop). */
export type BridgeRequest = { type: 'capture:request'; key: string };
export type BridgeMessage = { type: 'announce' } | { type: 'capture:result'; key: string; data: string | null; error?: string };

export type Incoming = PageToOverlay | BridgeMessage;

export interface Transport {
  /** Il companion sa catturare la pagina con il motore del browser (più fedele di html-to-image). */
  readonly nativeCapture: boolean;
  /** false se il messaggio non è partito (canale non ancora pronto). */
  post(msg: OverlayToPage | BridgeRequest): boolean;
  listen(handler: (msg: Incoming) => void): void;
}

export class FrameTransport implements Transport {
  readonly nativeCapture = false;
  private parentOrigin: string | null = null;

  constructor(private readonly origins: string[]) {}

  post(msg: OverlayToPage | BridgeRequest): boolean {
    const payload = { ...msg, source: MESSAGE_SOURCE };
    if (!this.parentOrigin) {
      // Chrome e Safari conoscono già l'origine della pagina Studio; altrimenti si provano tutte.
      const ancestor = (location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins?.[0];
      if (ancestor && this.origins.includes(ancestor)) this.parentOrigin = ancestor;
    }
    const targets = this.parentOrigin ? [this.parentOrigin] : this.origins;
    for (const origin of targets) {
      try {
        window.parent.postMessage(payload, origin);
      } catch {
        /* origine non corrispondente */
      }
    }
    return true;
  }

  listen(handler: (msg: Incoming) => void): void {
    window.addEventListener('message', (ev) => {
      if (ev.source !== window.parent || !this.origins.includes(ev.origin)) return;
      const msg = ev.data as (Incoming & { source?: string }) | null;
      if (!msg || typeof msg !== 'object' || msg.source !== MESSAGE_SOURCE) return;
      this.parentOrigin = ev.origin;
      handler(msg);
    });
  }
}

/** Nomi concordati con il companion (src/server/electron.ts). */
const BRIDGE_SEND = '__rlsStudioSend';
const BRIDGE_RECEIVE = '__rlsStudioReceive';

export class BridgeTransport implements Transport {
  readonly nativeCapture = true;

  post(msg: OverlayToPage | BridgeRequest): boolean {
    const send = (window as unknown as Record<string, unknown>)[BRIDGE_SEND];
    if (typeof send !== 'function') return false;
    try {
      (send as (payload: string) => void)(JSON.stringify({ ...msg, source: MESSAGE_SOURCE }));
      return true;
    } catch {
      return false;
    }
  }

  listen(handler: (msg: Incoming) => void): void {
    Object.defineProperty(window, BRIDGE_RECEIVE, {
      configurable: true,
      enumerable: false,
      writable: false,
      value: (msg: unknown) => {
        if (msg && typeof msg === 'object' && typeof (msg as { type?: unknown }).type === 'string') handler(msg as Incoming);
      },
    });
  }
}
