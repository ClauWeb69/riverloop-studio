import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import type { Params } from '../shared/i18n.js';
import type { AppClientMessage, AppServerMessage, AppView, FrameMeta } from '../shared/protocol.js';
import { t, type MessageKey } from './i18n.js';

/** Oltre questa coda verso un client lento i fotogrammi vengono saltati (non accumulati). */
const MAX_BUFFERED = 6 * 1024 * 1024;

export const EMPTY_VIEW: AppView = {
  state: 'waiting',
  message: '',
  windows: [],
  current: null,
  title: '',
  url: '',
  width: 0,
  height: 0,
  scale: 1,
  overlay: false,
  elements: false,
};

export interface BridgeClient {
  ws: WebSocket;
  /** Dimensione del pannello della pagina, in pixel fisici. */
  width: number;
  height: number;
  /** Anteprima dal vivo richiesta (pannello visibile). */
  live: boolean;
}

/**
 * Ponte tra la pagina Studio e un'app desktop (canale /ws/app). Le due modalità desktop lo
 * estendono: ElectronBridge parla con la pagina dell'app tramite la porta di debug,
 * WindowBridge cattura l'immagine di una finestra nativa.
 */
export abstract class AppBridge extends EventEmitter {
  protected readonly clients = new Set<BridgeClient>();
  protected current: AppView = { ...EMPTY_VIEW };
  private lastFrame: { meta: FrameMeta; data: Buffer } | null = null;
  private seq = 0;
  /** Testi dei messaggi mostrati e la loro chiave, per ritradurli se la lingua cambia. */
  private readonly texts = new Map<string, { key: MessageKey; params?: Params }>();

  abstract start(): void;
  abstract close(): void;
  protected abstract handle(client: BridgeClient, msg: AppClientMessage): void;
  /** Un client si è collegato o scollegato, oppure ha cambiato dimensione/anteprima. */
  protected clientsChanged(): void {}
  /** Messaggi iniziali per un client appena collegato (oltre a vista e ultimo fotogramma). */
  protected greet(_client: BridgeClient): void {}

  view(): AppView {
    return this.current;
  }

  /** Messaggio per la vista nella lingua corrente (ricordato per relocalize). */
  protected text(key: MessageKey, params?: Params): string {
    const text = t(key, params);
    if (this.texts.size > 64) this.texts.clear();
    this.texts.set(text, { key, params });
    return text;
  }

  /** La lingua è cambiata: il messaggio mostrato nella pagina viene ritradotto. */
  relocalize(): void {
    const source = this.texts.get(this.current.message);
    if (source) this.setView({ message: this.text(source.key, source.params) });
  }

  attach(ws: WebSocket): void {
    const client: BridgeClient = { ws, width: 0, height: 0, live: true };
    this.clients.add(client);
    this.sendJson({ type: 'view', view: this.current }, client);
    if (this.lastFrame) this.sendFrameTo(client, this.lastFrame.meta, this.lastFrame.data);
    this.greet(client);
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let msg: AppClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as AppClientMessage;
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
      if (msg.type === 'viewport') {
        client.width = Math.min(8192, Math.max(0, Math.floor(Number(msg.width)) || 0));
        client.height = Math.min(8192, Math.max(0, Math.floor(Number(msg.height)) || 0));
        this.clientsChanged();
        return;
      }
      if (msg.type === 'live') {
        client.live = msg.on === true;
        this.clientsChanged();
        return;
      }
      try {
        this.handle(client, msg);
      } catch {
        /* messaggio malformato: ignorato */
      }
    });
    ws.on('close', () => {
      this.clients.delete(client);
      this.clientDetached(client);
      this.clientsChanged();
    });
    ws.on('error', () => undefined);
    this.clientsChanged();
  }

  protected clientDetached(_client: BridgeClient): void {}

  protected sendJson(msg: AppServerMessage, only?: BridgeClient): void {
    const text = JSON.stringify(msg);
    for (const client of only ? [only] : this.clients) {
      if (client.ws.readyState === client.ws.OPEN) client.ws.send(text);
    }
  }

  private sendFrameTo(client: BridgeClient, meta: FrameMeta, data: Buffer): void {
    const { ws } = client;
    if (ws.readyState !== ws.OPEN) return;
    // I fermi immagine arrivano sempre; l'anteprima si salta se il client è indietro
    if (meta.still === undefined && ws.bufferedAmount > MAX_BUFFERED) return;
    ws.send(JSON.stringify({ type: 'frame', meta } satisfies AppServerMessage));
    ws.send(data, { binary: true });
  }

  /** Fotogramma dell'anteprima a tutti i client (e ai prossimi che si collegano). */
  protected broadcastFrame(format: FrameMeta['format'], width: number, height: number, data: Buffer): void {
    const meta: FrameMeta = { seq: ++this.seq, format, width, height };
    this.lastFrame = { meta, data };
    for (const client of this.clients) if (client.live) this.sendFrameTo(client, meta, data);
  }

  /** Fermo immagine chiesto da un client. */
  protected sendStill(client: BridgeClient, req: number, width: number, height: number, data: Buffer): void {
    this.sendFrameTo(client, { seq: ++this.seq, format: 'png', still: req, width, height }, data);
  }

  protected forgetFrame(): void {
    this.lastFrame = null;
  }

  protected setView(patch: Partial<AppView>): void {
    const next = { ...this.current, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.current)) return;
    this.current = next;
    this.sendJson({ type: 'view', view: next });
    this.emit('view', next);
  }

  /** Dimensione massima richiesta dai client collegati (0 se nessuno l'ha comunicata). */
  protected wantedSize(): { width: number; height: number } {
    let width = 0;
    let height = 0;
    for (const c of this.clients) {
      width = Math.max(width, c.width);
      height = Math.max(height, c.height);
    }
    return { width, height };
  }

  protected closeClients(): void {
    for (const client of this.clients) {
      try {
        client.ws.close(1001, 'Riverloop Studio chiuso');
      } catch {
        /* ignorato */
      }
    }
    this.clients.clear();
  }
}
