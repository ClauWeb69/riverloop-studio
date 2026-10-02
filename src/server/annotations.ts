import { lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AnnotationContext, AnnotationData, AnnotationRequest, NativeElement, Rect, ViewportInfo } from '../shared/protocol.js';
import { t } from './i18n.js';
import { fileTimestamp, sanitizeForTerminal, sanitizeInline as sanitizeText, toPosix } from './util.js';

/**
 * Testo che viene dall'app (selettori, testi, titoli, sorgente, nomi dei controlli): ripulito e
 * senza menzioni "@percorso". Claude Code allega i file citati con @ quando il messaggio parte:
 * una pagina potrebbe così far allegare file fuori dal progetto. Uno spazio di larghezza zero
 * dopo la @ la lascia leggibile ma non più una menzione. Il commento dell'utente non passa di qui.
 */
const sanitizeInline = (text: string, max?: number): string => sanitizeText(text, max).replace(/@/g, '@​');

export const STUDIO_DIR = path.join('.claude', 'studio');
export const ANNOTATIONS_DIR = path.join(STUDIO_DIR, 'annotations');

/**
 * Percorso assoluto di una cartella di Studio nel progetto (es. ANNOTATIONS_DIR), creata se
 * richiesto. Rifiuta link simbolici e junction lungo il percorso: un repository potrebbe far
 * puntare .claude/studio altrove, e Studio vi scriverebbe o cancellerebbe file fuori dal progetto.
 */
export async function studioDir(cwd: string, rel: string, create: boolean): Promise<string> {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (create) await mkdir(cwd, { recursive: true });
  let current = cwd;
  for (const part of parts) {
    current = path.join(current, part);
    let st;
    try {
      st = await lstat(current);
    } catch {
      if (!create) throw new Error(t('studioDir.missing', { dir: current }));
      await mkdir(current);
      st = await lstat(current);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(t('studioDir.notPlain', { dir: current }));
  }
  const [root, real] = await Promise.all([realpath(cwd), realpath(current)]);
  if (path.relative(root, real).startsWith('..') || path.isAbsolute(path.relative(root, real))) throw new Error(t('studioDir.notPlain', { dir: current }));
  return current;
}

const MAX_ANNOTATIONS = 50;
const MAX_COMMENT = 4000;
const MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024;
const MAX_CONTEXTS = 12;
/** Identificativo di un'immagine della finestra intera (generato dalla pagina Studio). */
const CONTEXT_ID = /^[\w-]{1,40}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class AnnotationError extends Error {}

// ---------------------------------------------------------------------------
// Validazione (i dati arrivano dal browser: li trattiamo come non fidati)
// ---------------------------------------------------------------------------
const num = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : fallback;
};
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const optStr = (v: unknown, max: number): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null);

function rect(v: unknown): Rect {
  const r = (v ?? {}) as Record<string, unknown>;
  return { x: num(r.x), y: num(r.y), width: Math.max(0, num(r.width)), height: Math.max(0, num(r.height)) };
}

function viewport(v: unknown): ViewportInfo {
  const r = (v ?? {}) as Record<string, unknown>;
  return {
    width: Math.max(0, num(r.width)),
    height: Math.max(0, num(r.height)),
    scrollX: num(r.scrollX),
    scrollY: num(r.scrollY),
    dpr: num(r.dpr, 1) || 1,
  };
}

function nativeElement(v: unknown): NativeElement | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const role = str(o.role, 60);
  if (!role) return null;
  return {
    role,
    name: str(o.name, 200),
    automationId: str(o.automationId, 120),
    className: str(o.className, 120),
    framework: str(o.framework, 40),
    path: Array.isArray(o.path)
      ? (o.path as unknown[])
          .filter((x): x is string => typeof x === 'string')
          .slice(-6)
          .map((x) => x.slice(0, 80))
      : [],
    rect: rect(o.rect),
  };
}

export function normalizeAnnotation(input: unknown): AnnotationData {
  const a = (input ?? {}) as Record<string, unknown>;
  const kind = a.kind === 'area' || a.kind === 'drawing' ? a.kind : a.kind === 'element' ? 'element' : null;
  if (!kind) throw new AnnotationError(t('annotation.invalidKind'));
  const id = Math.floor(Number(a.id));
  if (!Number.isFinite(id) || id < 1 || id > 1_000_000) throw new AnnotationError(t('annotation.invalidId'));
  const styles: Record<string, string> = {};
  if (a.styles && typeof a.styles === 'object') {
    for (const [k, v] of Object.entries(a.styles as Record<string, unknown>).slice(0, 40)) {
      if (typeof v === 'string') styles[k.slice(0, 40)] = v.slice(0, 200);
    }
  }
  const summary = (e: unknown) => {
    const o = (e ?? {}) as Record<string, unknown>;
    return { label: str(o.label, 120), selector: str(o.selector, 400), text: optStr(o.text, 120) ?? undefined };
  };
  const contains = Array.isArray(a.contains) ? (a.contains as unknown[]).slice(0, 10).map(summary) : undefined;
  const container = kind !== 'element' && a.container && typeof a.container === 'object' ? summary(a.container) : null;
  const components = Array.isArray(a.components)
    ? (a.components as unknown[])
        .filter((x): x is string => typeof x === 'string')
        .slice(0, 6)
        .map((x) => x.slice(0, 80))
    : undefined;
  const pathPoints = Array.isArray(a.path)
    ? (a.path as unknown[])
        .slice(0, 2000)
        .filter((p): p is [number, number] => Array.isArray(p) && p.length === 2)
        .map(([x, y]) => [num(x), num(y)] as [number, number])
    : undefined;
  const anchor = (a.anchor ?? {}) as Record<string, unknown>;
  const surface = a.surface === 'window' || a.surface === 'electron' ? a.surface : undefined;
  return {
    id,
    kind,
    comment: str(a.comment, MAX_COMMENT),
    url: str(a.url, 2000) || '/',
    title: str(a.title, 300),
    viewport: viewport(a.viewport),
    selector: optStr(a.selector, 600),
    label: optStr(a.label, 200),
    html: optStr(a.html, 3000),
    text: optStr(a.text, 400),
    styles: Object.keys(styles).length ? styles : null,
    rect: rect(a.rect),
    viewportRect: rect(a.viewportRect),
    contains,
    ...(kind === 'element' ? {} : { container: container && (container.label || container.selector) ? container : null, heading: optStr(a.heading, 120) }),
    source: optStr(a.source, 500),
    components,
    path: kind === 'drawing' ? pathPoints : undefined,
    anchor: { selector: optStr(anchor.selector, 600), offsetX: num(anchor.offsetX), offsetY: num(anchor.offsetY) },
    screenshot: typeof a.screenshot === 'string' ? a.screenshot : null,
    screenshotError: optStr(a.screenshotError, 300),
    ...(surface ? { surface } : {}),
    ...(surface === 'window'
      ? { native: nativeElement(a.native), context: typeof a.context === 'string' && CONTEXT_ID.test(a.context) ? a.context : null }
      : {}),
  };
}

export function parseRequest(body: unknown): AnnotationRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(b.annotations) || b.annotations.length === 0) throw new AnnotationError(t('annotation.none'));
  if (b.annotations.length > MAX_ANNOTATIONS) throw new AnnotationError(t('annotation.tooMany', { max: MAX_ANNOTATIONS }));
  const session = typeof b.session === 'string' && /^\d{1,4}$/.test(b.session) ? b.session : undefined;
  const contexts: AnnotationContext[] = [];
  if (Array.isArray(b.contexts)) {
    for (const c of (b.contexts as unknown[]).slice(0, MAX_CONTEXTS)) {
      const o = (c ?? {}) as Record<string, unknown>;
      if (typeof o.id === 'string' && CONTEXT_ID.test(o.id) && typeof o.image === 'string') contexts.push({ id: o.id, image: o.image });
    }
  }
  return { autoSend: b.autoSend === true, session, annotations: b.annotations.map(normalizeAnnotation), ...(contexts.length ? { contexts } : {}) };
}

function decodePng(dataUrl: string | null): Buffer | null {
  if (!dataUrl) return null;
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > MAX_SCREENSHOT_BYTES || buf.length < PNG_SIGNATURE.length) return null;
  if (!buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
  return buf;
}

// ---------------------------------------------------------------------------
// Composizione del prompt
// ---------------------------------------------------------------------------
export function describePosition(r: Rect, vp: ViewportInfo): string {
  if (!vp.width || !vp.height) return '';
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const h = cx < vp.width / 3 ? 'Left' : cx > (vp.width * 2) / 3 ? 'Right' : '';
  const v = cy < vp.height / 3 ? 'top' : cy > (vp.height * 2) / 3 ? 'bottom' : '';
  if (!h && !v) return t('prompt.pos.center');
  if (!h) return t(v === 'top' ? 'prompt.pos.top' : 'prompt.pos.bottom');
  if (!v) return t(h === 'Left' ? 'prompt.pos.left' : 'prompt.pos.right');
  return t(`prompt.pos.${v}${h}` as 'prompt.pos.topLeft' | 'prompt.pos.topRight' | 'prompt.pos.bottomLeft' | 'prompt.pos.bottomRight');
}

const size = (r: Rect) => `${Math.round(r.width)}×${Math.round(r.height)}`;
const vpSize = (vp: ViewportInfo) => `${Math.round(vp.width)}×${Math.round(vp.height)}`;

function indentComment(comment: string): string {
  const clean = sanitizeForTerminal(comment).trim() || t('prompt.noComment');
  return clean.split('\n').join('\n   ');
}

function relativeSource(source: string | null | undefined, cwd: string): string | null {
  if (!source) return null;
  const clean = sanitizeInline(source, 300);
  const norm = clean.replace(/\\/g, '/');
  const root = toPosix(cwd).replace(/\\/g, '/').replace(/\/$/, '');
  if (norm.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return norm.slice(root.length + 1);
  return norm;
}

export interface ComposeInput {
  annotations: AnnotationData[];
  screenshots: Map<number, string | null>;
  jsonPath: string;
  /** Modalità window: immagini della finestra intera salvate (id → percorso relativo). */
  contexts?: Map<string, string>;
}

/** Dove sono state fatte le annotazioni di un gruppo: pagina web, pagina di un'app desktop o finestra nativa. */
function describePlace(a: AnnotationData): string {
  const vp = a.viewport;
  const title = a.title ? ` «${sanitizeInline(a.title, 80).replace(/[«»]/g, "'")}»` : '';
  if (a.surface === 'window') return t('prompt.place.window', { title, size: vpSize(vp) });
  if (a.surface === 'electron') return t('prompt.place.electron', { title, url: sanitizeInline(a.url, 300), size: vpSize(vp) });
  return t('prompt.place.page', { url: sanitizeInline(a.url, 300), size: vpSize(vp) });
}

export function composePrompt(input: ComposeInput, cwd: string): string {
  const groups = new Map<string, AnnotationData[]>();
  for (const a of input.annotations) {
    // Le finestre native non hanno un indirizzo: si raggruppano per titolo
    const key = a.surface === 'window' ? `finestra:${a.title}` : a.url || '/';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(a);
  }
  const lines: string[] = [];
  const single = groups.size === 1;
  const native = input.annotations.every((a) => a.surface === 'window');
  let first = true;
  for (const items of groups.values()) {
    const where = describePlace(items[0]);
    if (single) lines.push(t('prompt.header.single', { where }));
    else {
      const group = t('prompt.header.group', { where });
      lines.push(first ? `${t(native ? 'prompt.header.multiWindows' : 'prompt.header.multiPages')}\n\n${group}` : group);
    }
    first = false;
    lines.push('');
    for (const a of items) {
      lines.push(`${a.id}. ${describeTarget(a)}`);
      lines.push(...describeLocation(a));
      lines.push(`   ${t('prompt.item.request', { text: indentComment(a.comment) })}`);
      if (a.components && a.components.length) {
        const [first, ...rest] = a.components.map((c) => sanitizeInline(c, 80));
        lines.push(
          `   ${rest.length ? t('prompt.item.componentInside', { name: first, parents: rest.join(', ') }) : t('prompt.item.component', { name: first })}`,
        );
      }
      const source = relativeSource(a.source, cwd);
      if (source) lines.push(`   ${t('prompt.item.source', { source })}`);
      const shot = input.screenshots.get(a.id);
      if (shot) lines.push(`   ${t('prompt.item.screenshot', { path: shot })}`);
      else if (a.screenshotError) lines.push(`   ${t('prompt.item.noScreenshotReason', { reason: sanitizeInline(a.screenshotError, 120) })}`);
      else lines.push(`   ${t('prompt.item.noScreenshot')}`);
      lines.push('');
    }
    // Finestre native: l'immagine della finestra intera, per capire dove cadono le annotazioni
    const seen = new Set<string>();
    for (const a of items) {
      const shot = a.context ? input.contexts?.get(a.context) : undefined;
      if (!a.context || !shot || seen.has(a.context)) continue;
      seen.add(a.context);
      const ids = items.filter((x) => x.context === a.context).map((x) => x.id);
      lines.push(t('prompt.context', { count: ids.length, ids: ids.join(', '), path: shot }));
    }
    if (seen.size) lines.push('');
  }
  lines.push(t(native ? 'prompt.details.native' : 'prompt.details.web', { path: input.jsonPath }));
  // L'ultima riga è testo semplice: se il messaggio finisse con un percorso @..., Claude Code
  // potrebbe aprire i suggerimenti dei file e l'Invio sceglierebbe il suggerimento invece di inviare.
  const anyShot = input.annotations.some((a) => input.screenshots.get(a.id));
  lines.push(t(anyShot ? 'prompt.footer.screenshots' : 'prompt.footer.noScreenshots'));
  return lines.join('\n');
}

const quote = (text: string, max: number) => `"${sanitizeInline(text, max).replace(/"/g, "'")}"`;
const code = (text: string, max: number) => `\`${sanitizeInline(text, max).replace(/`/g, "'")}\``;
const span = (start: number, length: number) => `${Math.round(start)}–${Math.round(start + length)}`;

/** Elemento dell'interfaccia nativa: tipo, nome e gli identificativi utili per trovarlo nel codice. */
function describeNative(n: NativeElement): string {
  const label = n.name ? `${n.role} «${sanitizeInline(n.name, 60).replace(/[«»]/g, "'")}»` : n.role;
  const ids = [
    n.automationId ? `AutomationId ${code(n.automationId, 80)}` : '',
    n.className ? t('prompt.native.class', { name: code(n.className, 80) }) : '',
    n.framework ? sanitizeInline(n.framework, 30) : '',
  ].filter(Boolean);
  return `${code(label, 120)}${ids.length ? ` (${ids.join(', ')})` : ''}`;
}

function describeTarget(a: AnnotationData): string {
  const windowed = a.surface === 'window';
  if (a.kind === 'element') {
    const fallback = t('prompt.target.elementFallback');
    if (windowed) return t('prompt.target.element', { target: a.native ? describeNative(a.native) : code(a.label || fallback, 120) });
    const target = code(a.selector || a.label || fallback, 200);
    return a.text ? t('prompt.target.elementWithText', { target, text: quote(a.text, 80) }) : t('prompt.target.element', { target });
  }
  const pos = describePosition(a.viewportRect, a.viewport);
  const what = t(a.kind === 'area' ? 'prompt.target.area' : 'prompt.target.drawing', { size: size(a.rect) });
  return pos ? `${what} ${t(windowed ? 'prompt.target.inWindow' : 'prompt.target.onScreen', { pos })}` : what;
}

/** Finestre native: coordinate nella finestra ed elemento dell'interfaccia sotto l'annotazione. */
function describeWindowLocation(a: AnnotationData): string[] {
  const out: string[] = [];
  const r = a.rect;
  const pos = a.kind === 'element' ? describePosition(a.viewportRect, a.viewport) : '';
  out.push(`   ${t('prompt.loc.window', { x: span(r.x, r.width), y: span(r.y, r.height), pos: pos || t('prompt.loc.fromTopLeft') })}`);
  const n = a.native;
  if (n) {
    if (a.kind !== 'element') out.push(`   ${t('prompt.loc.over', { element: describeNative(n) })}`);
    const path = n.path.map((p) => sanitizeInline(p, 60)).filter(Boolean);
    if (path.length) out.push(`   ${t('prompt.loc.where', { where: t('prompt.loc.inside', { name: path.join(' > ') }) })}`);
  }
  // Zone: i controlli che contengono (UI Automation)
  const items = (a.contains ?? [])
    .slice(0, 10)
    .map((e) => {
      const label = sanitizeInline(e.label, 60);
      if (!label) return '';
      return `${code(label, 60)}${e.selector ? ` (AutomationId ${code(e.selector, 60)})` : ''}`;
    })
    .filter(Boolean);
  if (items.length) out.push(`   ${t('prompt.loc.contains', { items: items.join(', ') })}`);
  // Righe del progetto dove compare il controllo: un indizio, non una certezza
  if (a.sources?.length) out.push(`   ${t('prompt.loc.sources', { list: a.sources.map((s) => code(s, 200)).join(', ') })}`);
  return out;
}

/** Zone e disegni: coordinate, contenitore, titolo vicino ed elementi coinvolti. */
function describeLocation(a: AnnotationData): string[] {
  if (a.surface === 'window') return describeWindowLocation(a);
  if (a.kind === 'element') return [];
  const out: string[] = [];
  const { rect: r, viewportRect: v, viewport: vp } = a;
  const vertical = Math.round(vp.scrollY) ? t('prompt.loc.scrollY', { n: Math.round(vp.scrollY) }) : '';
  const horizontal = Math.round(vp.scrollX) ? t('prompt.loc.scrollX', { n: Math.round(vp.scrollX) }) : '';
  const scroll = vertical && horizontal ? t('prompt.loc.scrollBoth', { vertical, horizontal }) : vertical || horizontal;
  const detail = scroll ? t('prompt.loc.scrolled', { x: span(v.x, v.width), y: span(v.y, v.height), scroll }) : t('prompt.loc.fromTopLeft');
  out.push(`   ${t('prompt.loc.page', { x: span(r.x, r.width), y: span(r.y, r.height), detail })}`);

  const where: string[] = [];
  const box = a.container;
  if (box && (box.selector || box.label)) {
    // Selettore breve se è leggibile, altrimenti la descrizione (tag#id o tag.classi)
    const short = box.selector && box.selector.length <= 60 && box.selector.split(' > ').length <= 2;
    const name = short ? box.selector : box.label || box.selector;
    where.push(
      !a.heading && box.text
        ? t('prompt.loc.insideWithText', { name: code(name, 120), text: quote(box.text, 60) })
        : t('prompt.loc.inside', { name: code(name, 120) }),
    );
  }
  if (a.heading) where.push(t('prompt.loc.underHeading', { heading: quote(a.heading, 80) }));
  if (where.length) out.push(`   ${t('prompt.loc.where', { where: where.join(', ') })}`);

  const items = (a.contains ?? [])
    // il contenitore è già indicato in "Si trova"
    .filter((e) => !(box && e.selector && e.selector === box.selector))
    .slice(0, 8)
    .map((e) => {
      const label = sanitizeInline(e.label || e.selector, 60);
      if (!label) return '';
      return `${code(label, 60)}${e.text ? ` ${quote(e.text, 40)}` : ''}`;
    })
    .filter(Boolean);
  if (items.length) out.push(`   ${t(a.kind === 'area' ? 'prompt.loc.contains' : 'prompt.loc.crosses', { items: items.join(', ') })}`);
  else if (a.kind === 'area') out.push(`   ${t('prompt.loc.containsNone')}`);
  return out;
}

// ---------------------------------------------------------------------------
// Salvataggio su disco
// ---------------------------------------------------------------------------
export interface SavedAnnotations {
  prompt: string;
  jsonPath: string;
  files: string[];
}

export async function saveAnnotations(cwd: string, request: AnnotationRequest): Promise<SavedAnnotations> {
  const dirAbs = await studioDir(cwd, ANNOTATIONS_DIR, true);

  // Nome univoco anche con più invii nello stesso secondo: il JSON viene creato subito
  // in modo esclusivo (flag wx), così due invii contemporanei non possono sovrascriversi.
  const base = fileTimestamp();
  let stamp = base;
  for (let n = 2; ; n++) {
    try {
      await writeFile(path.join(dirAbs, `${stamp}.json`), '', { flag: 'wx' });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n > 999) throw err;
      stamp = `${base}-${n}`;
    }
  }

  const relDir = toPosix(ANNOTATIONS_DIR);
  const screenshots = new Map<number, string | null>();
  const files: string[] = [];
  for (const a of request.annotations) {
    const png = decodePng(a.screenshot);
    if (!png) {
      if (a.screenshot && !a.screenshotError) a.screenshotError = t('annotation.invalidImage');
      screenshots.set(a.id, null);
      continue;
    }
    const name = `${stamp}-${a.id}.png`;
    await writeFile(path.join(dirAbs, name), png, { flag: 'wx' });
    const rel = `${relDir}/${name}`;
    screenshots.set(a.id, rel);
    files.push(rel);
  }

  // Modalità window: immagini della finestra intera, solo quelle a cui un'annotazione fa riferimento
  const contexts = new Map<string, string>();
  let contextNumber = 0;
  for (const c of request.contexts ?? []) {
    if (contexts.has(c.id) || !request.annotations.some((a) => a.context === c.id)) continue;
    const png = decodePng(c.image);
    if (!png) continue;
    const name = `${stamp}-finestra-${++contextNumber}.png`;
    await writeFile(path.join(dirAbs, name), png, { flag: 'wx' });
    const rel = `${relDir}/${name}`;
    contexts.set(c.id, rel);
    files.push(rel);
  }

  const jsonName = `${stamp}.json`;
  const jsonPath = `${relDir}/${jsonName}`;
  const details = {
    createdAt: new Date().toISOString(),
    tool: 'riverloop-studio',
    annotations: request.annotations.map((a) => {
      const { screenshot: _drop, context, ...rest } = a;
      return { ...rest, screenshot: screenshots.get(a.id) ?? null, ...(context ? { windowScreenshot: contexts.get(context) ?? null } : {}) };
    }),
  };
  await writeFile(path.join(dirAbs, jsonName), `${JSON.stringify(details, null, 2)}\n`, 'utf8');
  files.push(jsonPath);

  const prompt = composePrompt({ annotations: request.annotations, screenshots, jsonPath, contexts }, cwd);
  return { prompt, jsonPath, files };
}

/** Elimina i file delle annotazioni più vecchi di maxAgeDays giorni. */
export async function cleanupAnnotations(cwd: string, maxAgeDays = 7): Promise<number> {
  let removed = 0;
  let entries: string[];
  let dirAbs: string;
  try {
    dirAbs = await studioDir(cwd, ANNOTATIONS_DIR, false);
    entries = await readdir(dirAbs);
  } catch {
    return 0;
  }
  const limit = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const name of entries) {
    if (!/\.(png|json)$/i.test(name)) continue;
    const file = path.join(dirAbs, name);
    try {
      // lstat: un link simbolico non è un file nostro, e non si segue
      const st = await lstat(file);
      if (st.isFile() && st.mtimeMs < limit) {
        await rm(file, { force: true });
        removed++;
      }
    } catch {
      /* ignorato */
    }
  }
  return removed;
}
