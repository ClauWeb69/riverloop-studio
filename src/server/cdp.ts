import { EventEmitter } from 'node:events';
import http from 'node:http';
import WebSocket from 'ws';
import { t } from './i18n.js';

/**
 * Client minimo del protocollo DevTools (CDP) per la modalità electron: elenco delle pagine
 * dell'app tramite la porta di debug e una connessione WebSocket per pagina.
 * La porta di debug ascolta solo su 127.0.0.1 (è Chromium a garantirlo) e la usa solo il
 * companion: la pagina Studio non la raggiunge mai direttamente.
 */
export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

function getJson<T>(port: number, pathname: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
        } catch (err) {
          reject(err as Error);
        }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** Pagine dell'app annotabili: niente DevTools, estensioni o pagine interne di Chromium. */
export function isAppPage(t: CdpTarget): boolean {
  if (t.type !== 'page' && t.type !== 'webview') return false;
  if (!t.webSocketDebuggerUrl) return false;
  return !/^(devtools|chrome-extension|chrome|edge|about):/i.test(t.url) || t.url === 'about:blank';
}

/**
 * L'indirizzo WebSocket indicato da /json/list punta davvero alla porta di debug interrogata, in
 * locale: chi risponde su quella porta non deve poter dirottare Studio verso un altro servizio.
 */
export function isLocalDebuggerUrl(url: string | undefined, port: number): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && Number(u.port) === port;
  } catch {
    return false;
  }
}

/** Elenco delle pagine dell'app; null se la porta di debug non risponde. */
export async function listTargets(port: number, timeoutMs = 800): Promise<CdpTarget[] | null> {
  try {
    const list = await getJson<CdpTarget[]>(port, '/json/list', timeoutMs);
    return Array.isArray(list) ? list.filter((t) => isAppPage(t) && isLocalDebuggerUrl(t.webSocketDebuggerUrl, port)) : [];
  } catch {
    return null;
  }
}

export class CdpError extends Error {}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Connessione a una pagina. Eventi: 'event' (metodo, parametri) e 'close'.
 * Ogni comando ha una scadenza: una pagina che non disegna (finestra nascosta) può non
 * rispondere mai ai comandi di input.
 */
export class CdpConnection extends EventEmitter {
  private ws: WebSocket | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  closed = false;

  static connect(url: string, timeoutMs = 4000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      // La porta di debug accetta solo client senza Origin (niente pagine web): ws non lo invia.
      const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024, handshakeTimeout: timeoutMs });
      const conn = new CdpConnection();
      const fail = (err: Error) => {
        ws.removeAllListeners();
        ws.on('error', () => undefined);
        try {
          ws.terminate();
        } catch {
          /* mai aperto */
        }
        reject(err);
      };
      ws.once('error', fail);
      ws.once('open', () => {
        ws.off('error', fail);
        conn.adopt(ws);
        resolve(conn);
      });
    });
  }

  private adopt(ws: WebSocket): void {
    this.ws = ws;
    ws.on('message', (raw) => {
      let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: unknown };
      try {
        msg = JSON.parse(raw.toString()) as typeof msg;
      } catch {
        return;
      }
      if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new CdpError(msg.error.message || t('cdp.error')));
        else p.resolve(msg.result);
      } else if (typeof msg.method === 'string') {
        this.emit('event', msg.method, msg.params ?? {});
      }
    });
    ws.on('error', () => undefined);
    ws.on('close', () => this.finish());
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new CdpError(t('cdp.closed')));
    }
    this.pending.clear();
    this.emit('close');
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs = 5000): Promise<T> {
    const ws = this.ws;
    if (!ws || this.closed || ws.readyState !== WebSocket.OPEN) return Promise.reject(new CdpError(t('cdp.closed')));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new CdpError(t('cdp.noResponse', { method })));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ id, method, params }), (err) => {
        if (err && this.pending.delete(id)) {
          clearTimeout(timer);
          reject(new CdpError(err.message));
        }
      });
    });
  }

  /** Comando di cui non interessa l'esito (né l'eventuale errore). */
  fire(method: string, params: Record<string, unknown> = {}): void {
    void this.send(method, params).catch(() => undefined);
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      /* già chiuso */
    }
    this.finish();
  }
}
