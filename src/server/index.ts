import { readFile } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type {
  AppMode,
  ControlMessage,
  DevServerStatus,
  HistoryResponse,
  ProjectsResponse,
  StudioConfig,
  SuggestionInfo,
  SuggestionsResponse,
} from '../shared/protocol.js';
import { DEFAULT_LOCALE, LOCALE_NAMES, LOCALES, type Locale } from '../shared/i18n.js';
import { AnnotationError, parseRequest, saveAnnotations } from './annotations.js';
import type { AppBridge } from './bridge.js';
import type { DesktopApp } from './desktop.js';
import type { DevServer } from './devserver.js';
import { ProjectHistory } from './history.js';
import { HOOK_HEADER, type HookEvent, type IdleTracker, type StatusPayload } from './hooks.js';
import type { ClaudeSession } from './pty.js';
import { findNativeSource } from './nativeSource.js';
import { overlayLoader } from './overlay-source.js';
import { closeInstance, listInstances, openProject, ProjectError, readRecent, toPublic } from './projects.js';
import { createAppProxy } from './proxy.js';
import { rejectUpgrade, type Security, sendJson, sendText, WS_PROTOCOL } from './security.js';
import type { SessionManager } from './sessions.js';
import { readProjectState, updateProjectState } from './state.js';
import { detectSuggestions } from './suggestions.js';
import { getLocale, localeChosen, saveLocale, setLocale, systemLocale, t } from './i18n.js';
import { log, sanitizeInline as sanitizeText } from './util.js';
import { CLAUDE_EFFORTS, CLAUDE_MODELS, CLAUDE_MODES, type ClaudeStatus, type PermissionModeName } from '../shared/protocol.js';

const DIST_DIR = fileURLToPath(new URL('../../', import.meta.url));
const WEB_DIR = path.join(DIST_DIR, 'web');
const MAX_BODY = 96 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

/** Modalità desktop (window, electron): processo dell'app, ponte verso la pagina e fine risposta di Claude. */
export interface DesktopOptions {
  app: DesktopApp;
  bridge: AppBridge;
  /** Riavvia l'app quando Claude Code finisce una risposta con modifiche. */
  restartOnIdle: boolean;
  /** La scelta è stata cambiata dalla pagina: va salvata per il progetto. */
  onRestartOnIdle: (value: boolean) => void;
}

export interface CompanionOptions {
  mode: AppMode;
  cwd: string;
  version: string;
  studioPort: number;
  proxyPort: number;
  autoSend: boolean;
  security: Security;
  sessions: SessionManager;
  /** Modalità web: dev server del progetto (dietro il proxy dell'iframe). */
  devServer: DevServer | null;
  desktop: DesktopOptions | null;
  /** Hook e status line di Claude Code (null se lo script non è compilato). */
  hooks: IdleTracker | null;
  /** --claude-bin indicato all'avvio: vale anche per i progetti aperti dalla pagina. */
  claudeBin?: string;
  /** Comando con cui Studio ha avviato il dev server (per i suggerimenti sul progetto). */
  devCommand?: string | null;
  /** Chiusura ordinata di tutto (come Ctrl+C), chiesta dalla pagina. */
  onShutdown: () => void;
}

export interface Companion {
  studioServer: http.Server;
  /** Proxy dell'app web (null nelle modalità desktop). */
  proxyServer: http.Server | null;
  broadcast(msg: ControlMessage): void;
  close(): Promise<void>;
}

type ClaudeActionResult = 'ok' | 'invalid' | 'not-running' | 'awaiting-answer' | 'input-not-empty' | 'unknown-mode' | 'unavailable' | 'ultracode-unconfirmed';

/**
 * Dati della status line di Claude Code, controllati uno per uno: arrivano da uno script locale
 * con il token degli hook, ma restano dati esterni (finiscono nella pagina).
 */
export function parseStatus(raw: StatusPayload | undefined): Partial<ClaudeStatus> {
  const o = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
  const percent = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v * 10) / 10)) : null);
  const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? sanitizeText(v, max) : null);
  const usage = (w: unknown) => {
    const used = percent(o(w).used_percentage);
    const resetsAt = o(w).resets_at;
    return used === null ? null : { used, resetsAt: typeof resetsAt === 'number' && Number.isFinite(resetsAt) ? Math.round(resetsAt) : null };
  };
  const data = o(raw);
  const limits = o(data.rate_limits);
  const cost = o(data.cost).total_cost_usd;
  return {
    model: text(o(data.model).display_name, 40),
    modelId: text(o(data.model).id, 80),
    effort: text(o(data.effort).level, 16),
    fiveHour: usage(limits.five_hour),
    sevenDay: usage(limits.seven_day),
    context: percent(o(data.context_window).used_percentage),
    costUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? Math.round(cost * 100) / 100 : null,
  };
}

/** Ciò che dev server e app desktop hanno in comune per la pagina Studio: stato, log e riavvio. */
interface AppRunner {
  port: number;
  managed: boolean;
  status(): DevServerStatus;
  restart(): Promise<void>;
  on(event: 'status', listener: (status: DevServerStatus) => void): unknown;
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new AnnotationError(t('http.tooLarge')));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function studioCsp(opts: CompanionOptions): string {
  const { studioPort, proxyPort } = opts;
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ws://127.0.0.1:${studioPort} ws://localhost:${studioPort}`,
    // L'iframe serve solo alle app web; le app desktop arrivano come immagini dal companion
    opts.mode === 'web' ? `frame-src http://127.0.0.1:${proxyPort} http://localhost:${proxyPort}` : "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

async function serveStatic(res: ServerResponse, urlPath: string, csp: string): Promise<boolean> {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.replace(/^\/+/, ''));
  const file = path.resolve(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR + path.sep) && file !== path.join(WEB_DIR, 'index.html')) return false;
  let data: Buffer;
  try {
    data = await readFile(file);
  } catch {
    return false;
  }
  const ext = path.extname(file).toLowerCase();
  const isIndex = rel === 'index.html';
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': isIndex ? 'no-store' : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    ...(isIndex
      ? { 'Content-Security-Policy': csp, 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Opener-Policy': 'same-origin' }
      : {}),
  });
  res.end(data);
  return true;
}

export async function startCompanion(opts: CompanionOptions): Promise<Companion> {
  const { security, sessions, devServer, desktop, cwd } = opts;
  const runner: AppRunner | null = devServer ?? desktop?.app ?? null;
  if (!runner) throw new Error(t('companion.noApp'));
  const csp = studioCsp(opts);
  const controlClients = new Set<WebSocket>();
  let lastAnnotationId = 0;
  let restartOnIdle = desktop?.restartOnIdle ?? false;
  let lastIdleRestart = 0;
  const windowsBuild = process.platform === 'win32' ? Number(os.release().split('.')[2]) || null : null;
  // Annulla e Ripeti delle modifiche ai file: una fotografia prima di ogni richiesta
  const history = new ProjectHistory(cwd);
  history.on('change', () => broadcast({ type: 'history', history: history.state() }));
  history.warm();
  /** Testo per Claude con, se serve, l'avviso che i file sono stati riportati indietro o avanti. */
  const withNotice = (prompt: string): string => {
    const notice = history.takeNotice();
    return notice ? `${prompt}\n\n${notice}` : prompt;
  };
  // Suggerimenti: già chiesti a Claude in questo avvio, e rimandati con "Non ora"
  const suggestionsAsked = new Set<string>();
  const suggestionsSnoozed = new Set<string>();
  const currentSuggestions = async (): Promise<SuggestionInfo[]> => {
    const state = await readProjectState(cwd);
    const dismissed = new Set(state.dismissedSuggestions ?? []);
    return detectSuggestions(cwd, { mode: opts.mode, devCommand: opts.devCommand ?? null, gitignoreDeclined: state.gitignoreDeclined === true })
      .filter((s) => !dismissed.has(s.id) && !suggestionsAsked.has(s.id))
      .map((s) => ({ ...s, snoozed: suggestionsSnoozed.has(s.id) }));
  };

  const broadcast = (msg: ControlMessage) => {
    const text = JSON.stringify(msg);
    for (const ws of controlClients) if (ws.readyState === ws.OPEN) ws.send(text);
  };
  runner.on('status', (status) => broadcast({ type: 'devserver', status }));
  sessions.on('change', () => broadcast({ type: 'sessions', sessions: sessions.list() }));
  sessions.on('autosend', (s: { id: string; name: string }, ok: boolean) =>
    broadcast({ type: 'autosend', ok, session: s.id, name: sessions.size > 1 ? s.name : 'Claude Code' }),
  );

  const config = (): StudioConfig => ({
    mode: opts.mode,
    restartOnIdle,
    version: opts.version,
    project: path.basename(cwd),
    platform: process.platform,
    studioPort: opts.studioPort,
    proxyPort: opts.proxyPort,
    devPort: runner.port,
    autoSend: opts.autoSend,
    nextAnnotationId: lastAnnotationId + 1,
    windowsBuild,
    devServer: runner.status(),
    sessions: sessions.list(),
    permissions: sessions.permissions,
    runningAsRoot: typeof process.getuid === 'function' && process.getuid() === 0,
    history: history.state(),
    locale: getLocale(),
    localeChosen: localeChosen(),
  });

  /** Controlli comuni alle API in POST: Origin della pagina Studio e corpo JSON. */
  const readJson = async (req: IncomingMessage, res: ServerResponse, limit: number): Promise<Record<string, unknown> | null> => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: t('http.methodNotAllowed') });
      return null;
    }
    if (!security.originIn(req, security.studioOrigins())) {
      sendJson(res, 403, { ok: false, error: t('http.originDenied') });
      return null;
    }
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
      sendJson(res, 415, { ok: false, error: t('http.jsonRequired') });
      return null;
    }
    try {
      const body = JSON.parse((await readBody(req, limit)) || '{}') as unknown;
      return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    } catch {
      sendJson(res, 400, { ok: false, error: t('http.invalidJson') });
      return null;
    }
  };

  /**
   * Hook e status line di Claude Code: uno strumento ha modificato il progetto, la risposta è
   * finita, oppure sono cambiati modello, effort o utilizzo. Lo chiamano gli script di Studio,
   * non un browser: hanno un token loro (che vale solo qui) e non devono avere Origin.
   */
  const handleHook = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const hooks = opts.hooks;
    if (!hooks || req.method !== 'POST' || req.headers.origin || !hooks.authorized(req.headers[HOOK_HEADER])) {
      sendJson(res, 403, { ok: false });
      return;
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse((await readBody(req, 4096)) || '{}') as Record<string, unknown>;
    } catch {
      /* corpo non valido: evento ignorato */
    }
    const event = body.event === 'Stop' || body.event === 'PostToolUse' ? (body.event as HookEvent) : null;
    const session = typeof body.session === 'string' && /^\d{1,4}$/.test(body.session) ? body.session : '1';
    sendJson(res, 200, { ok: true });
    if (body.event === 'status') {
      sessions.get(session)?.setStatus(parseStatus(body.status as StatusPayload));
      return;
    }
    if (!event) return;
    const outcome = hooks.record(event, session);
    if (!outcome) return;
    // Più sessioni possono finire quasi insieme: un solo riavvio
    const restart = outcome === 'changed' && Boolean(desktop) && restartOnIdle && Boolean(desktop?.app.managed) && Date.now() - lastIdleRestart > 2500;
    if (restart && desktop) {
      lastIdleRestart = Date.now();
      log.info(t('companion.idleRestart'));
      void desktop.app.restart();
    }
    broadcast({ type: 'idle', session, restarted: restart });
  };

  /** Esegue un'azione della barra di Claude sulla sessione: comandi di Claude Code o Shift+Tab. */
  const runClaudeAction = async (session: ClaudeSession, body: Record<string, unknown>): Promise<ClaudeActionResult> => {
    const value = typeof body.value === 'string' ? body.value : '';
    switch (body.action) {
      case 'model':
        if (!(CLAUDE_MODELS as readonly string[]).includes(value)) return 'invalid';
        return session.runCommand(`/model ${value}`);
      case 'effort':
        if (!(CLAUDE_EFFORTS as readonly string[]).includes(value)) return 'invalid';
        return session.runCommand(`/effort ${value}`);
      case 'ultracode':
        // Solo per la sessione: l'effort resta quello scelto
        if (typeof body.value !== 'boolean') return 'invalid';
        return session.setUltracode(body.value);
      case 'goal': {
        const goal = sanitizeText(value, 400);
        return session.runCommand(goal ? `/goal ${goal}` : '/goal clear');
      }
      case 'usage':
        return session.runCommand('/usage');
      case 'mode':
        if (!CLAUDE_MODES.includes(value as PermissionModeName)) return 'invalid';
        return session.cycleMode(value as PermissionModeName);
      default:
        return 'invalid';
    }
  };

  // -------------------------------------------------------------------------
  // Pagina Studio e API
  // -------------------------------------------------------------------------
  const studioServer = http.createServer(async (req, res) => {
    try {
      if (!security.hostAllowed(req, opts.studioPort)) {
        sendText(res, 403, t('http.hostDenied'));
        return;
      }
      const url = new URL(req.url || '/', 'http://studio.local');

      // La pagina e i suoi file statici sono pubblici e innocui; il token (nel frammento #t=
      // del link) lo legge lo script della pagina e lo presenta alle API e ai WebSocket.
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        if (await serveStatic(res, url.pathname, csp)) return;
        if (url.pathname === '/') {
          sendText(res, 500, t('http.pageNotBuilt'));
          return;
        }
        sendText(res, 404, t('http.notFound'));
        return;
      }

      if (url.pathname === '/api/hook') {
        await handleHook(req, res);
        return;
      }

      if (!security.isAuthorized(req)) {
        sendJson(res, 401, { ok: false, error: t('http.unauthorized') });
        return;
      }

      // Cookie (a basso privilegio) che permette all'iframe di caricare l'app dal proxy.
      if (url.pathname === '/api/session' && req.method === 'POST') {
        if (!security.originIn(req, security.studioOrigins())) {
          sendJson(res, 403, { ok: false, error: t('http.originDenied') });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Set-Cookie': security.proxyCookie(),
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (url.pathname === '/api/config' && req.method === 'GET') {
        sendJson(res, 200, config());
        return;
      }

      if (url.pathname === '/api/annotation') {
        const body = await readJson(req, res, MAX_BODY);
        if (!body) return;
        try {
          const request = parseRequest(body);
          // La scheda scelta nella pagina; mai un'altra al suo posto (le annotazioni sono per lei)
          const session = request.session ? sessions.get(request.session) : sessions.first();
          if (!session) {
            sendJson(res, 409, { ok: false, code: 'not-running', error: t('api.sessionClosed') });
            return;
          }
          const who = sessions.size > 1 ? session.name : 'Claude Code';
          const notRunning = { ok: false, code: 'not-running', error: t('api.notRunning', { who }) };
          const awaiting = {
            ok: false,
            code: 'awaiting-answer',
            error: t('api.awaitingSend', { who }),
          };
          if (session.state !== 'running') {
            sendJson(res, 409, notRunning);
            return;
          }
          if (await session.awaitingAnswer()) {
            sendJson(res, 409, awaiting);
            return;
          }
          for (const a of request.annotations) lastAnnotationId = Math.max(lastAnnotationId, a.id);
          // Finestre native: dove compare il controllo nel codice del progetto (non c'è data-studio-src)
          await Promise.all(
            request.annotations
              .filter((a) => a.surface === 'window' && a.native)
              .map(async (a) => {
                const hits = await findNativeSource(cwd, a.native!).catch(() => []);
                if (hits.length) a.sources = hits.map((h) => `${h.file}:${h.line}`);
              }),
          );
          const saved = await saveAnnotations(cwd, request);
          // Da qui Annulla riporta i file a com'erano prima di questa richiesta
          await history.checkpoint(request.annotations[0].comment || t('api.annotationsLabel'));
          const prompt = withNotice(saved.prompt);
          const pasted = await session.paste(prompt, request.autoSend);
          if (pasted !== 'ok') {
            sendJson(res, 409, pasted === 'awaiting-answer' ? awaiting : notRunning);
            return;
          }
          sendJson(res, 200, { ok: true, prompt, json: saved.jsonPath, files: saved.files, session: session.id });
        } catch (err) {
          const status = err instanceof AnnotationError ? 400 : err instanceof SyntaxError ? 400 : 500;
          sendJson(res, status, { ok: false, error: (err as Error).message });
        }
        return;
      }

      // Annulla e Ripeti delle modifiche ai file del progetto ------------------------------
      if (url.pathname === '/api/history' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, history: history.state() } satisfies HistoryResponse);
        return;
      }
      if (url.pathname === '/api/history/undo' || url.pathname === '/api/history/redo') {
        const body = await readJson(req, res, 1024);
        if (!body) return;
        // Mentre Claude scrive i file, riportarli indietro darebbe un risultato a metà
        if (sessions.busy()) {
          sendJson(res, 409, { ok: false, error: t('api.claudeBusy'), history: history.state() } satisfies HistoryResponse);
          return;
        }
        const result = url.pathname.endsWith('/undo') ? await history.undo() : await history.redo();
        if (result.ok && desktop && restartOnIdle && desktop.app.managed) {
          // Un'app desktop non si aggiorna da sola: per vedere i file ripristinati va riavviata
          lastIdleRestart = Date.now();
          void desktop.app.restart();
        }
        sendJson(res, result.ok ? 200 : 409, {
          ok: result.ok,
          ...(result.ok ? { message: result.message } : { error: result.message }),
          history: history.state(),
        } satisfies HistoryResponse);
        return;
      }

      // Suggerimenti per il progetto: proposti dalla pagina, eseguiti da Claude Code -------
      if (url.pathname === '/api/suggestions' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, suggestions: await currentSuggestions() } satisfies SuggestionsResponse);
        return;
      }
      if (url.pathname === '/api/suggestions/apply') {
        const body = await readJson(req, res, 64 * 1024);
        if (!body) return;
        // Il testo per Claude lo scrive il companion: dalla pagina arriva solo quale suggerimento
        const suggestion = (await currentSuggestions()).find((s) => s.id === body.id);
        if (!suggestion) {
          sendJson(res, 404, { ok: false, error: t('api.suggestionInvalid') } satisfies SuggestionsResponse);
          return;
        }
        const wanted = typeof body.session === 'string' && /^\d{1,4}$/.test(body.session) ? body.session : null;
        const session = wanted ? sessions.get(wanted) : sessions.first();
        const who = session && sessions.size > 1 ? session.name : 'Claude Code';
        if (!session || session.state !== 'running') {
          sendJson(res, 409, { ok: false, code: 'not-running', error: t('api.notRunning', { who }) } satisfies SuggestionsResponse);
          return;
        }
        // Il clic nella pagina è la conferma dell'utente: la richiesta viene anche inviata
        await history.checkpoint(suggestion.title);
        const pasted = await session.paste(withNotice(suggestion.prompt), true);
        if (pasted !== 'ok') {
          const awaiting = pasted === 'awaiting-answer';
          sendJson(res, 409, {
            ok: false,
            code: awaiting ? 'awaiting-answer' : 'not-running',
            error: awaiting ? t('api.awaitingRetry', { who }) : t('api.notRunning', { who }),
          } satisfies SuggestionsResponse);
          return;
        }
        suggestionsAsked.add(suggestion.id);
        sendJson(res, 200, { ok: true, suggestions: await currentSuggestions() } satisfies SuggestionsResponse);
        return;
      }
      if (url.pathname === '/api/suggestions/dismiss') {
        const body = await readJson(req, res, 64 * 1024);
        if (!body) return;
        const id = typeof body.id === 'string' && /^[a-z-]{1,40}$/.test(body.id) ? body.id : null;
        if (id) {
          if (body.forever === true) {
            const state = await readProjectState(cwd);
            await updateProjectState(cwd, { dismissedSuggestions: [...new Set([...(state.dismissedSuggestions ?? []), id])] });
          } else {
            suggestionsSnoozed.add(id);
          }
        }
        sendJson(res, 200, { ok: true, suggestions: await currentSuggestions() } satisfies SuggestionsResponse);
        return;
      }

      // Sessioni di Claude Code (schede della console) ---------------------------
      if (url.pathname === '/api/sessions' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, sessions: sessions.list() });
        return;
      }
      if (url.pathname === '/api/sessions') {
        const body = await readJson(req, res, 64 * 1024);
        if (!body) return;
        try {
          const session = sessions.create({ resumeFirst: body.mode === 'resume' });
          sendJson(res, 200, { ok: true, session: sessions.list().find((s) => s.id === session.id) });
        } catch (err) {
          sendJson(res, 409, { ok: false, error: (err as Error).message });
        }
        return;
      }
      // Barra di Claude: modello, effort, modalità, goal e utilizzo della scheda indicata ----
      if (url.pathname === '/api/claude') {
        const body = await readJson(req, res, 8 * 1024);
        if (!body) return;
        const session = sessions.get(typeof body.session === 'string' ? body.session : null);
        if (!session) {
          sendJson(res, 404, { ok: false, error: t('api.sessionNotFound') });
          return;
        }
        const result = await runClaudeAction(session, body);
        if (result === 'ok') sendJson(res, 200, { ok: true, sessions: sessions.list() });
        else sendJson(res, result === 'invalid' ? 400 : 409, { ok: false, code: result, error: t(`claude.error.${result}`) });
        return;
      }
      if (url.pathname === '/api/sessions/rename') {
        const body = await readJson(req, res, 4 * 1024);
        if (!body) return;
        const renamed = typeof body.id === 'string' && typeof body.name === 'string' && sessions.rename(body.id, body.name);
        if (renamed) sendJson(res, 200, { ok: true, sessions: sessions.list() });
        else sendJson(res, 409, { ok: false, error: t('api.sessionNotFound') });
        return;
      }
      if (url.pathname === '/api/sessions/close') {
        const body = await readJson(req, res, 64 * 1024);
        if (!body) return;
        const closed = typeof body.id === 'string' && (await sessions.close(body.id));
        if (closed) sendJson(res, 200, { ok: true });
        else sendJson(res, 409, { ok: false, error: sessions.size <= 1 ? t('api.lastSession') : t('api.sessionNotFound') });
        return;
      }

      // Progetti: altre istanze di Studio su questo computer ----------------------
      if (url.pathname === '/api/projects' && req.method === 'GET') {
        const instances = (await listInstances()).map(toPublic);
        sendJson(res, 200, { ok: true, instances, recent: readRecent(), sep: path.sep } satisfies ProjectsResponse);
        return;
      }
      if (url.pathname === '/api/projects/open') {
        const body = await readJson(req, res, 64 * 1024);
        if (!body) return;
        try {
          const target = await openProject(String(body.path ?? ''), { claudeBin: opts.claudeBin });
          sendJson(res, 200, { ok: true, url: target } satisfies ProjectsResponse);
        } catch (err) {
          sendJson(res, err instanceof ProjectError ? 400 : 500, { ok: false, error: (err as Error).message });
        }
        return;
      }
      if (url.pathname === '/api/projects/close') {
        const body = await readJson(req, res, 64 * 1024);
        if (!body) return;
        const pid = Number(body.pid);
        try {
          if (pid === process.pid) {
            sendJson(res, 200, { ok: true });
            setTimeout(() => opts.onShutdown(), 50);
            return;
          }
          await closeInstance(pid);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, err instanceof ProjectError ? 400 : 500, { ok: false, error: (err as Error).message });
        }
        return;
      }
      // Lingua dell'interfaccia e delle richieste a Claude Code (null: quella del sistema) ---
      if (url.pathname === '/api/locale') {
        const body = await readJson(req, res, 1024);
        if (!body) return;
        const wanted = body.locale === null ? null : (LOCALES as readonly unknown[]).includes(body.locale) ? (body.locale as Locale) : undefined;
        if (wanted === undefined) {
          sendJson(res, 400, { ok: false, error: t('api.localeInvalid') });
          return;
        }
        // Salvata per l'utente: vale per tutti i progetti e per i prossimi avvii
        saveLocale(wanted);
        setLocale(wanted ?? systemLocale() ?? DEFAULT_LOCALE, wanted !== null);
        log.info(t('lang.changed', { name: LOCALE_NAMES[getLocale()] }));
        desktop?.bridge.relocalize();
        // Le pagine aperte si ricaricano nella nuova lingua
        broadcast({ type: 'locale', locale: getLocale() });
        sendJson(res, 200, { ok: true, locale: getLocale(), localeChosen: localeChosen() });
        return;
      }
      if (url.pathname === '/api/shutdown') {
        const body = await readJson(req, res, 1024);
        if (!body) return;
        sendJson(res, 200, { ok: true });
        setTimeout(() => opts.onShutdown(), 50);
        return;
      }

      sendJson(res, 404, { ok: false, error: t('http.notFound') });
    } catch (err) {
      sendText(res, 500, t('http.internalError', { message: (err as Error).message }));
    }
  });

  // -------------------------------------------------------------------------
  // WebSocket: /ws/term (console), /ws/overlay (canale di controllo della pagina) e
  // /ws/app (app desktop: fotogrammi, input e messaggi dell'overlay)
  // -------------------------------------------------------------------------
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 2 * 1024 * 1024,
    perMessageDeflate: false,
    // Il browser offre "riverloop-studio" e "rls-token.<token>": rispondiamo solo col primo.
    handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
  });
  const alive = new WeakMap<WebSocket, boolean>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      try {
        ws.ping();
      } catch {
        /* ignorato */
      }
    }
  }, 20000);
  heartbeat.unref();

  studioServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    socket.on('error', () => undefined);
    if (!security.hostAllowed(req, opts.studioPort)) return rejectUpgrade(socket, 403, 'Host non consentito');
    // Solo la pagina Studio: l'app nell'iframe (altra porta) non può aprire la console.
    if (!security.originIn(req, security.studioOrigins())) return rejectUpgrade(socket, 403, 'Origin non consentita');
    if (!security.wsAuthorized(req)) return rejectUpgrade(socket, 401, 'Token mancante');
    const wsUrl = new URL(req.url || '/', 'http://studio.local');
    const pathname = wsUrl.pathname;
    const known = pathname === '/ws/term' || pathname === '/ws/overlay' || (pathname === '/ws/app' && desktop !== null);
    if (!known) return rejectUpgrade(socket, 404, 'Non trovato');
    wss.handleUpgrade(req, socket, head, (ws) => {
      alive.set(ws, true);
      ws.on('pong', () => alive.set(ws, true));
      if (pathname === '/ws/term') {
        // Console di una scheda: ?s=<numero> (senza, la prima sessione aperta)
        const wanted = wsUrl.searchParams.get('s');
        const session = wanted ? sessions.get(wanted) : sessions.first();
        if (!session) {
          ws.close(4404, 'Sessione non trovata');
          return;
        }
        session.attach(ws);
      } else if (pathname === '/ws/app') {
        desktop?.bridge.attach(ws);
      } else {
        controlClients.add(ws);
        ws.on('close', () => controlClients.delete(ws));
        ws.on('error', () => undefined);
        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(raw.toString()) as { type?: string; value?: unknown };
            if (msg.type === 'devserver:restart' && runner.managed) void runner.restart();
            else if (msg.type === 'restart-on-idle' && desktop && typeof msg.value === 'boolean') {
              restartOnIdle = msg.value;
              desktop.onRestartOnIdle(restartOnIdle);
              broadcast({ type: 'restart-on-idle', value: restartOnIdle });
            }
          } catch {
            /* ignorato */
          }
        });
        ws.send(JSON.stringify({ type: 'devserver', status: runner.status() } satisfies ControlMessage));
        ws.send(JSON.stringify({ type: 'sessions', sessions: sessions.list() } satisfies ControlMessage));
      }
    });
  });

  // -------------------------------------------------------------------------
  // Proxy verso l'app web, sulla sua porta dedicata
  // -------------------------------------------------------------------------
  const proxyServer = devServer
    ? createAppProxy({
        targetPort: () => devServer.port,
        proxyPort: opts.proxyPort,
        security,
        devServer,
        overlayScript: overlayLoader({ parentOrigins: security.studioOrigins() }),
      })
    : null;

  const listen = (server: http.Server, port: number) =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  await listen(studioServer, opts.studioPort);
  if (proxyServer) await listen(proxyServer, opts.proxyPort);
  desktop?.bridge.start();

  const closeServer = (server: http.Server) =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
      setTimeout(resolve, 1000).unref();
    });

  return {
    studioServer,
    proxyServer,
    broadcast,
    async close() {
      clearInterval(heartbeat);
      broadcast({ type: 'shutdown' });
      sessions.closeAllClients();
      desktop?.bridge.close();
      history.dispose();
      for (const ws of controlClients) ws.close(1001, 'Riverloop Studio chiuso');
      for (const ws of wss.clients) ws.terminate();
      await Promise.all([closeServer(studioServer), ...(proxyServer ? [closeServer(proxyServer)] : [])]);
    },
  };
}
