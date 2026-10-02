import http, { type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import { Transform, type Readable, type TransformCallback } from 'node:stream';
import zlib from 'node:zlib';
import httpProxy from 'http-proxy';
import type { DevServer } from './devserver.js';
import { t } from './i18n.js';
import { escapeHtml, rejectUpgrade, type Security, sendText, simplePage, STUDIO_COOKIE_RE, stripStudioCookies } from './security.js';

export const OVERLAY_PATH = '/__studio/overlay.js';
const INJECT_TAG = `<script src="${OVERLAY_PATH}" async data-riverloop-studio=""></script>`;
const MAX_BUFFERED_HTML = 8 * 1024 * 1024;
const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'proxy-connection', 'upgrade', 'te', 'trailer'];

export interface AppProxyOptions {
  /** Porta attuale del dev server (può cambiare durante la sessione). */
  targetPort: () => number;
  proxyPort: number;
  security: Security;
  devServer: DevServer;
  /** Sorgente dell'overlay (già configurato con le origini ammesse). */
  overlayScript: () => string | null;
}

// ---------------------------------------------------------------------------
// Riscritture degli header
// ---------------------------------------------------------------------------
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0', '[::]']);

export function rewriteLocation(location: string, targetPort: number, publicHost: string): string {
  try {
    const u = new URL(location);
    if (LOCAL_HOSTS.has(u.hostname) && u.port === String(targetPort) && (u.protocol === 'http:' || u.protocol === 'https:')) {
      return `http://${publicHost}${u.pathname}${u.search}${u.hash}`;
    }
  } catch {
    /* percorso relativo: resta com'è */
  }
  return location;
}

/**
 * Cookie dell'app: via Domain (così valgono per 127.0.0.1) e via Secure, perché Studio è
 * servito in http. I cookie __Secure-/__Host- restano intatti (senza Secure verrebbero rifiutati).
 */
export function rewriteSetCookie(cookie: string): string {
  const parts = cookie.split(';');
  const nameValue = parts.shift() ?? '';
  const name = nameValue.split('=')[0].trim();
  const keepSecure = name.startsWith('__Secure-') || name.startsWith('__Host-');
  let removedSecure = false;
  const attrs: string[] = [];
  for (const raw of parts) {
    const key = raw.split('=')[0].trim().toLowerCase();
    if (key === 'domain') continue;
    if (!keepSecure && key === 'secure') {
      removedSecure = true;
      continue;
    }
    if (!keepSecure && key === 'partitioned') continue;
    attrs.push(raw);
  }
  const fixed = attrs.map((a) => (removedSecure && /^\s*samesite\s*=\s*none\s*$/i.test(a) ? ' SameSite=Lax' : a));
  return [nameValue, ...fixed].join(';');
}

function rewriteResponseHeaders(res: IncomingMessage, targetPort: number, publicHost: string): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    const k = key.toLowerCase();
    if (HOP_BY_HOP.includes(k)) continue;
    // Solo in questo proxy locale: l'app deve poter stare nell'iframe e caricare l'overlay.
    if (k === 'x-frame-options') continue;
    if (k === 'content-security-policy' || k === 'content-security-policy-report-only') continue;
    if (k === 'location' && typeof value === 'string') {
      out[key] = rewriteLocation(value, targetPort, publicHost);
      continue;
    }
    if (k === 'set-cookie') {
      const list = (Array.isArray(value) ? value : [value])
        // L'app non può impostare cookie con i nomi riservati a Studio
        .filter((c) => !STUDIO_COOKIE_RE.test(c.split('=')[0].trim()))
        .map(rewriteSetCookie);
      if (list.length) out[key] = list;
      continue;
    }
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Iniezione dello script dell'overlay
// ---------------------------------------------------------------------------
export function shouldInject(req: IncomingMessage, res: IncomingMessage): boolean {
  if (req.method !== 'GET') return false;
  const status = res.statusCode ?? 200;
  if (status < 200 || status === 204 || status === 304 || (status >= 300 && status < 400)) return false;
  const type = String(res.headers['content-type'] || '');
  if (!/^\s*text\/html/i.test(type)) return false;
  const dest = req.headers['sec-fetch-dest'];
  if (dest && dest !== 'document' && dest !== 'iframe' && dest !== 'frame') return false;
  // Richieste RSC / navigazioni client-side di Next.js
  if (req.headers.rsc || req.headers['next-router-state-tree'] || req.headers['x-nextjs-data']) return false;
  return true;
}

/** Inserisce lo script prima dell'ultimo </body> (o in fondo, se manca). */
export function injectIntoHtml(html: string, tag = INJECT_TAG): string {
  const lower = html.toLowerCase();
  const idx = lower.lastIndexOf('</body');
  return idx >= 0 ? html.slice(0, idx) + tag + html.slice(idx) : html + tag;
}

/** Versione in streaming: non blocca le risposte che Next.js invia a pezzi (Suspense). */
export class InjectTransform extends Transform {
  private tail = '';
  private done = false;
  constructor(private readonly tag = INJECT_TAG) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    if (this.done) {
      cb(null, chunk);
      return;
    }
    // latin1 è 1:1 con i byte: niente problemi con caratteri UTF-8 spezzati tra i pezzi.
    const text = this.tail + chunk.toString('latin1');
    const idx = text.search(/<\/body/i);
    if (idx >= 0) {
      this.done = true;
      this.tail = '';
      cb(null, Buffer.from(text.slice(0, idx) + this.tag + text.slice(idx), 'latin1'));
      return;
    }
    // Trattiene solo l'eventuale inizio di "</body" alla fine del pezzo (0–5 byte),
    // così il resto (es. gli script di Suspense) arriva subito al browser.
    let keep = 0;
    const lower = text.slice(-5).toLowerCase();
    for (let k = Math.min(5, lower.length); k > 0; k--) {
      if ('</body'.startsWith(lower.slice(lower.length - k))) {
        keep = k;
        break;
      }
    }
    this.tail = keep ? text.slice(text.length - keep) : '';
    const out = keep ? text.slice(0, text.length - keep) : text;
    cb(null, out ? Buffer.from(out, 'latin1') : undefined);
  }
  override _flush(cb: TransformCallback): void {
    if (!this.done) this.push(Buffer.from(this.tail + this.tag, 'latin1'));
    else if (this.tail) this.push(Buffer.from(this.tail, 'latin1'));
    cb();
  }
}

function decodeBody(res: IncomingMessage): Readable {
  const enc = String(res.headers['content-encoding'] || '')
    .toLowerCase()
    .trim();
  if (enc === 'gzip' || enc === 'x-gzip') return res.pipe(zlib.createGunzip());
  if (enc === 'deflate') return res.pipe(zlib.createInflate());
  if (enc === 'br') return res.pipe(zlib.createBrotliDecompress());
  return res;
}

// ---------------------------------------------------------------------------
// Pagine di servizio
// ---------------------------------------------------------------------------
function waitingPage(opts: AppProxyOptions): string {
  const status = opts.devServer.status();
  const port = opts.targetPort();
  // I testi dei dizionari sono fidati e vanno nell'HTML così come sono; il comando è protetto con escapeHtml
  let title = t('proxy.waiting.title', { port });
  let text = `<p>${t('proxy.waiting.text')}</p>`;
  if (status.state === 'exited') {
    title = t('proxy.exited.title');
    const command = `<code>${escapeHtml(status.command || '')}</code>`;
    text = `<p>${
      status.exitCode !== null && status.exitCode !== undefined
        ? t('proxy.exited.textCode', { command, code: status.exitCode })
        : t('proxy.exited.text', { command })
    }</p>`;
  } else if (!status.managed) {
    text = `<p>${t('proxy.external.text', { address: `<code>localhost:${port}</code>`, option: '<code>--port</code>' })}</p>`;
  }
  const lines = status.log.slice(-15).join('\n');
  const logBlock = lines ? `<pre>${escapeHtml(lines)}</pre>` : '';
  return simplePage(title, text + logBlock, { refreshSeconds: 2 });
}

/** Pagina per chi apre la porta del proxy senza passare da Studio (nella lingua corrente). */
const deniedPage = (): string => simplePage(t('proxy.denied.title'), `<p>${t('proxy.denied.text', { command: '<code>riverloop-studio</code>' })}</p>`);

// ---------------------------------------------------------------------------
// Server del proxy
// ---------------------------------------------------------------------------
export function createAppProxy(opts: AppProxyOptions): http.Server {
  const { security, targetPort, proxyPort } = opts;
  const target = () => `http://localhost:${targetPort()}`;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  const proxy = httpProxy.createProxyServer({
    changeOrigin: false,
    xfwd: false,
    ws: true,
    selfHandleResponse: true,
  });

  // Origin "localhost" per gli endpoint interni di Next.js (allowedDevOrigins) e per gli
  // upgrade WebSocket dell'HMR; le altre richieste (es. Server Actions) restano invariate.
  const devOrigin = `http://localhost:${proxyPort}`;
  const prepare = (req: IncomingMessage, upgrade: boolean) => {
    stripStudioCookies(req);
    delete req.headers['accept-encoding'];
    const url = req.url || '/';
    // Solo per richieste che vengono davvero dall'app nell'iframe: un'altra pagina locale (stesso
    // sito 127.0.0.1, quindi con il cookie del proxy) non deve passare i controlli di Next.js
    const fromApp = req.headers.origin !== undefined && security.proxyOrigins().includes(req.headers.origin);
    if (fromApp && (upgrade || url.startsWith('/_next/') || url.startsWith('/__nextjs'))) {
      req.headers.origin = devOrigin;
    }
  };

  proxy.on('proxyRes', (proxyRes: IncomingMessage, req: IncomingMessage, res: ServerResponse) => {
    const publicHost = req.headers.host || `127.0.0.1:${proxyPort}`;
    const headers = rewriteResponseHeaders(proxyRes, targetPort(), publicHost);
    const status = proxyRes.statusCode ?? 502;
    res.on('close', () => {
      if (!proxyRes.complete) proxyRes.destroy();
    });

    if (!shouldInject(req, proxyRes)) {
      res.writeHead(status, proxyRes.statusMessage, headers);
      proxyRes.pipe(res);
      return;
    }

    const encoded = Boolean(proxyRes.headers['content-encoding']);
    delete headers['content-encoding'];
    delete headers['content-length'];
    const body = decodeBody(proxyRes);
    body.on('error', () => res.destroy());
    const knownLength = Number(proxyRes.headers['content-length']);

    if (!encoded && Number.isFinite(knownLength) && knownLength > 0 && knownLength < MAX_BUFFERED_HTML) {
      // Risposta completa di lunghezza nota: inserimento prima dell'ultimo </body> e content-length ricalcolato.
      const chunks: Buffer[] = [];
      body.on('data', (d: Buffer) => chunks.push(d));
      body.on('end', () => {
        const html = injectIntoHtml(Buffer.concat(chunks).toString('latin1'));
        const out = Buffer.from(html, 'latin1');
        headers['content-length'] = String(out.length);
        res.writeHead(status, proxyRes.statusMessage, headers);
        res.end(out);
      });
      return;
    }
    res.writeHead(status, proxyRes.statusMessage, headers);
    body.pipe(new InjectTransform()).pipe(res);
  });

  proxy.on('error', (err: Error, req: IncomingMessage, resOrSocket: unknown) => {
    if (resOrSocket instanceof http.ServerResponse) {
      const res = resOrSocket;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const dest = req.headers['sec-fetch-dest'];
      const wantsHtml =
        req.method === 'GET' && (!dest || dest === 'document' || dest === 'iframe') && /text\/html|\*\/\*/.test(String(req.headers.accept || '*/*'));
      if (wantsHtml) {
        res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(waitingPage(opts));
      } else {
        sendText(res, 502, t('proxy.unreachable', { port: targetPort(), reason: (err as NodeJS.ErrnoException).code || err.message }));
      }
      return;
    }
    const socket = resOrSocket as { destroy?: () => void } | undefined;
    socket?.destroy?.();
  });

  const server = http.createServer((req, res) => {
    if (!security.hostAllowed(req, proxyPort)) {
      sendText(res, 403, t('http.hostDenied'));
      return;
    }
    if (!security.proxyAuthorized(req)) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(deniedPage());
      return;
    }
    // Niente Service Worker dall'app: uno registrato sull'origine del proxy resterebbe nel browser
    // anche dopo la chiusura di Studio, e controllerebbe quell'origine se un giorno diventasse
    // la pagina Studio (stessa porta) leggendone il token.
    if (req.headers['service-worker'] === 'script') {
      sendText(res, 403, t('proxy.serviceWorker'));
      return;
    }
    const path = (req.url || '/').split('?')[0];
    if (path === OVERLAY_PATH) {
      const script = opts.overlayScript();
      if (!script) {
        sendText(res, 500, t('proxy.overlayMissing'));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(script);
      return;
    }
    prepare(req, false);
    proxy.web(req, res, { agent, target: target() });
  });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    socket.on('error', () => undefined);
    if (!security.hostAllowed(req, proxyPort)) return rejectUpgrade(socket, 403, 'Host non consentito');
    if (!security.proxyAuthorized(req)) return rejectUpgrade(socket, 403, 'Token mancante');
    const origin = req.headers.origin;
    if (origin && !security.originIn(req, [...security.proxyOrigins(), ...security.studioOrigins()])) {
      return rejectUpgrade(socket, 403, 'Origin non consentita');
    }
    prepare(req, true);
    proxy.ws(req, socket, head, { target: target() });
  });

  server.on('clientError', (_err, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch {
      /* ignorato */
    }
  });

  server.on('close', () => {
    agent.destroy();
    proxy.close();
  });

  return server;
}
