import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { getLocale } from './i18n.js';

/** Cookie di Studio (uno per istanza): non vanno mai inoltrati all'app né accettati da essa. */
export const STUDIO_COOKIE_RE = /^rls_(?:studio|proxy)_\d+$/;
/** Sottoprotocollo WebSocket di Studio e prefisso con cui la pagina presenta il token. */
export const WS_PROTOCOL = 'riverloop-studio';
export const WS_TOKEN_PREFIX = 'rls-token.';

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

/** Tutti i valori di un cookie (un'app potrebbe impostarne uno con lo stesso nome). */
export function parseCookieValues(header: string | undefined, name: string): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() === name) out.push(part.slice(eq + 1).trim());
  }
  return out;
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name && !out.has(name)) out.set(name, value);
  }
  return out;
}

/** Rimuove dall'header Cookie tutti i cookie di Studio prima di inoltrare la richiesta all'app. */
export function stripStudioCookies(req: IncomingMessage): void {
  const header = req.headers.cookie;
  if (!header) return;
  const kept = header
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p && !STUDIO_COOKIE_RE.test(p.split('=')[0].trim()));
  if (kept.length) req.headers.cookie = kept.join('; ');
  else delete req.headers.cookie;
}

function safeEqual(a: string, b: Buffer): boolean {
  const buf = Buffer.from(a, 'utf8');
  return buf.length === b.length && timingSafeEqual(buf, b);
}

export interface SecurityOptions {
  token: string;
  studioPort: number;
  proxyPort: number;
}

/**
 * Regole di accesso. Solo loopback; controllo di Host (DNS rebinding) e di Origin.
 * - Il token di sessione (console, API) non sta mai in un cookie: i cookie valgono per tutte le
 *   porte di 127.0.0.1 e finirebbero a qualunque altro servizio locale. La pagina lo riceve nel
 *   frammento del link (#t=...), lo tiene nel localStorage della propria origine (che l'app, su
 *   un'altra porta, non può leggere) e lo presenta nell'header X-Studio-Token o come
 *   sottoprotocollo WebSocket.
 * - L'iframe dell'app usa un cookie separato, valido solo per il proxy (che dà accesso all'app,
 *   già raggiungibile in locale): se trapelasse, non aprirebbe la console.
 */
export class Security {
  readonly token: string;
  readonly proxyToken: string;
  readonly studioPort: number;
  readonly proxyPort: number;
  readonly proxyCookieName: string;
  private readonly tokenBuf: Buffer;
  private readonly proxyTokenBuf: Buffer;

  constructor(opts: SecurityOptions) {
    this.token = opts.token;
    this.proxyToken = generateToken();
    this.studioPort = opts.studioPort;
    this.proxyPort = opts.proxyPort;
    this.proxyCookieName = `rls_proxy_${opts.studioPort}`;
    this.tokenBuf = Buffer.from(opts.token, 'utf8');
    this.proxyTokenBuf = Buffer.from(this.proxyToken, 'utf8');
  }

  tokenMatches(candidate: string | null | undefined): boolean {
    return typeof candidate === 'string' && safeEqual(candidate, this.tokenBuf);
  }

  /** Host ammessi: 127.0.0.1:<porta> o localhost:<porta>. */
  hostAllowed(req: IncomingMessage, port: number): boolean {
    const host = (req.headers.host || '').toLowerCase();
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  }

  studioOrigins(): string[] {
    return [`http://127.0.0.1:${this.studioPort}`, `http://localhost:${this.studioPort}`];
  }

  proxyOrigins(): string[] {
    return [`http://127.0.0.1:${this.proxyPort}`, `http://localhost:${this.proxyPort}`];
  }

  originIn(req: IncomingMessage, allowed: string[]): boolean {
    const origin = req.headers.origin;
    return typeof origin === 'string' && allowed.includes(origin.toLowerCase());
  }

  /** API della pagina Studio: header X-Studio-Token. */
  isAuthorized(req: IncomingMessage): boolean {
    const header = req.headers['x-studio-token'];
    return typeof header === 'string' && this.tokenMatches(header);
  }

  /** WebSocket della pagina Studio: sottoprotocollo "rls-token.<token>". */
  wsAuthorized(req: IncomingMessage): boolean {
    const raw = req.headers['sec-websocket-protocol'];
    if (typeof raw !== 'string') return false;
    return raw
      .split(',')
      .map((p) => p.trim())
      .some((p) => p.startsWith(WS_TOKEN_PREFIX) && this.tokenMatches(p.slice(WS_TOKEN_PREFIX.length)));
  }

  /** Proxy dell'app: basta che uno dei cookie con il nome giusto sia valido. */
  proxyAuthorized(req: IncomingMessage): boolean {
    return parseCookieValues(req.headers.cookie, this.proxyCookieName).some((v) => safeEqual(v, this.proxyTokenBuf));
  }

  proxyCookie(): string {
    return `${this.proxyCookieName}=${this.proxyToken}; HttpOnly; SameSite=Strict; Path=/`;
  }
}

export function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  try {
    socket.write(
      `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
    );
  } catch {
    /* socket già chiuso */
  }
  socket.destroy();
}

export function sendText(res: ServerResponse, status: number, text: string, headers: OutgoingHttpHeaders = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(text);
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] as string);

/** Pagina HTML minima (403, attesa del dev server...). */
export function simplePage(title: string, body: string, opts: { refreshSeconds?: number } = {}): string {
  const refresh = opts.refreshSeconds ? `<meta http-equiv="refresh" content="${opts.refreshSeconds}">` : '';
  return `<!doctype html><html lang="${getLocale()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh}<title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f6f7;--fg:#1c1c21;--muted:#6b6b76;--card:#fff;--line:#e3e3e8;--brand:#b12584}
@media (prefers-color-scheme:dark){:root{--bg:#141417;--fg:#ececf1;--muted:#9a9aa6;--card:#1c1c21;--line:#2c2c33}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:560px;margin:24px;padding:28px 30px;background:var(--card);border:1px solid var(--line);border-radius:14px}
h1{margin:0 0 8px;font-size:18px;display:flex;align-items:center;gap:10px}
h1::before{content:"";width:10px;height:10px;border-radius:3px;background:var(--brand);transform:rotate(45deg)}
p{margin:6px 0;color:var(--muted)}code,pre{font:12.5px/1.5 ui-monospace,"JetBrains Mono","Cascadia Code",Menlo,monospace}
pre{margin:14px 0 0;padding:12px;background:var(--bg);border:1px solid var(--line);border-radius:8px;overflow:auto;max-height:240px;white-space:pre-wrap;color:var(--fg)}
</style></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
}

export { esc as escapeHtml };
