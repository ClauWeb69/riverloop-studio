import { execFile, spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NativeElement, NativeSummary, Rect } from '../shared/protocol.js';
import { t, type MessageKey } from './i18n.js';
import { log } from './util.js';
import { WIN32_BOOTSTRAP, WIN32_SCRIPT } from './wincapture-win32.js';

/**
 * Cattura delle finestre native (modalità window). Ogni sistema ha il suo modo:
 * - Windows: aiutante PowerShell persistente (PrintWindow, UI Automation), niente da installare;
 * - macOS: screencapture e l'elenco delle finestre di CoreGraphics (serve il permesso
 *   "Registrazione schermo" per il terminale);
 * - Linux con X11: wmctrl e ImageMagick (import).
 * Se la cattura non è disponibile la pagina Studio ripiega sulla condivisione della finestra
 * dal browser.
 */
export interface NativeWindow {
  id: string;
  pid: number;
  title: string;
  minimized: boolean;
  width: number;
  height: number;
  /** Finestra principale (non una finestra di dialogo o uno strumento di un'altra finestra). */
  main: boolean;
}

export interface CaptureOptions {
  format: 'jpeg' | 'png';
  quality?: number;
  /** Riduce l'immagine se supera questa dimensione (anteprima dal vivo). */
  maxWidth?: number;
  maxHeight?: number;
  /** Impronta dell'ultima immagine ricevuta: se la finestra non è cambiata non viene rispedita. */
  lastHash?: string;
}

export interface CaptureResult {
  status: 'ok' | 'same' | 'minimized' | 'gone';
  /** Dimensione della finestra in pixel (non dell'immagine eventualmente ridotta). */
  width: number;
  height: number;
  /** Fattore di scala dello schermo (1 = 96 dpi). */
  scale: number;
  hash: string;
  data: Buffer | null;
}

export interface WindowCapturer {
  readonly name: string;
  /** Sa riconoscere gli elementi dell'interfaccia sotto un punto. */
  readonly elements: boolean;
  /** Finestre dell'albero di processi indicato (null = tutte) con il testo nel titolo. */
  list(rootPid: number | null, title: string): Promise<NativeWindow[]>;
  capture(id: string, opts: CaptureOptions): Promise<CaptureResult>;
  show(id: string): Promise<void>;
  activate(id: string): Promise<void>;
  elementAt(id: string, x: number, y: number): Promise<NativeElement | null>;
  /** Controlli dentro una zona della finestra (strumento Riquadro); [] se non si sa riconoscerli. */
  elementsIn(id: string, rect: Rect): Promise<NativeSummary[]>;
  dispose(): void;
}

export class CaptureUnavailable extends Error {}

// ---------------------------------------------------------------------------
// Dimensioni di un'immagine dai suoi byte (PNG e JPEG)
// ---------------------------------------------------------------------------
export function imageSize(data: Buffer): { width: number; height: number } | null {
  if (data.length > 24 && data[0] === 0x89 && data.toString('latin1', 1, 4) === 'PNG') {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = data[i + 1];
      // SOF0..SOF15, esclusi DHT (C4), JPG (C8) e DAC (CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7) };
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2;
        continue;
      }
      i += 2 + data.readUInt16BE(i + 2);
    }
  }
  return null;
}

function run(file: string, args: string[], opts: { timeout?: number; encoding?: 'buffer' } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: opts.timeout ?? 8000, maxBuffer: 96 * 1024 * 1024, encoding: 'buffer', windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout as unknown as Buffer);
    });
  });
}

/** pid → pid del processo padre, da ps (macOS e Linux). */
async function processParents(): Promise<Map<number, number>> {
  const out = (await run('ps', ['-axo', 'pid=,ppid='])).toString('utf8');
  const parents = new Map<number, number>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)/.exec(line);
    if (m) parents.set(Number(m[1]), Number(m[2]));
  }
  return parents;
}

/** Il processo indicato e tutti i suoi discendenti. */
export function processTree(root: number, parents: Map<number, number>): Set<number> {
  const tree = new Set<number>([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, parent] of parents) {
      if (!tree.has(pid) && tree.has(parent)) {
        tree.add(pid);
        grew = true;
      }
    }
  }
  return tree;
}

/**
 * Fallimenti consecutivi di uno strumento di cattura. Uno isolato può capitare (finestra chiusa
 * in quel momento); dopo tre di fila la cattura dal sistema si considera non disponibile, e la
 * pagina Studio propone la condivisione della finestra dal browser.
 */
class Strikes {
  private count = 0;
  constructor(private readonly unavailable: MessageKey) {}
  ok(): void {
    this.count = 0;
  }
  fail(err: unknown): void {
    log.debug(`cattura: ${(err as Error).message}`);
    if (++this.count >= 3) throw new CaptureUnavailable(t(this.unavailable));
  }
}

const matchesTitle = (title: string, filter: string) => !filter || title.toLowerCase().includes(filter.toLowerCase());

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

class WindowsCapturer implements WindowCapturer {
  readonly name = 'Windows (PrintWindow)';
  elements = false;
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private buffer = '';
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private failures = 0;
  private disposed = false;

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      if (this.failures >= 3) {
        reject(new CaptureUnavailable(t('capture.win.noStart')));
        return;
      }
      const system = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
      const exe = path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN32_BOOTSTRAP], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (err) {
        // PowerShell non c'è o non si può eseguire: riprovare non cambierebbe nulla
        this.failures = 3;
        reject(new CaptureUnavailable(t('capture.win.noPowershell', { message: (err as Error).message })));
        return;
      }
      this.child = child;
      this.buffer = '';
      let announced = false;
      let stderr = '';
      const startTimer = setTimeout(() => {
        if (!announced) child.kill();
      }, 30000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        this.buffer += chunk;
        let nl: number;
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, nl).trim();
          this.buffer = this.buffer.slice(nl + 1);
          if (!line) continue;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (!announced) {
            announced = true;
            clearTimeout(startTimer);
            if (msg.ready === true) {
              this.elements = msg.elements === true;
              this.failures = 0;
              resolve();
            } else {
              this.failures = 3;
              reject(new CaptureUnavailable(t('capture.win.helperUnavailable', { message: String(msg.error ?? t('capture.win.unknownError')).slice(0, 300) })));
            }
            continue;
          }
          const p = this.pending.get(Number(msg.id));
          if (!p) continue;
          this.pending.delete(Number(msg.id));
          clearTimeout(p.timer);
          if (typeof msg.error === 'string') p.reject(new Error(msg.error));
          else p.resolve(msg);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < 2000) stderr += chunk;
      });
      child.on('error', (err) => {
        // Eseguibile mancante o bloccato (ENOENT, EACCES): Node lo segnala qui, senza evento exit
        if (announced) return;
        announced = true;
        clearTimeout(startTimer);
        if (this.child === child) this.child = null;
        this.failures = 3;
        reject(new CaptureUnavailable(t('capture.win.noPowershell', { message: err.message })));
      });
      child.on('exit', () => {
        clearTimeout(startTimer);
        if (this.child === child) {
          this.child = null;
          this.ready = null;
        }
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error(t('capture.win.helperExited')));
        }
        this.pending.clear();
        if (!announced) {
          announced = true;
          this.failures++;
          log.debug(`cattura: aiutante terminato all'avvio: ${stderr.trim().slice(0, 400)}`);
          // Può essere un inciampo passeggero: si riprova, e solo alla terza si rinuncia
          reject(this.failures >= 3 ? new CaptureUnavailable(t('capture.win.blocked')) : new Error(t('capture.win.notStarted')));
        }
      });
      child.stdin.on('error', () => undefined);
      child.stdin.write(`${Buffer.from(WIN32_SCRIPT, 'utf8').toString('base64')}\n`);
    });
    this.ready.catch(() => {
      this.ready = null;
    });
    return this.ready;
  }

  private async request(op: string, params: Record<string, unknown>, timeoutMs = 8000): Promise<Record<string, unknown>> {
    if (this.disposed) throw new CaptureUnavailable(t('capture.closed'));
    await this.start();
    const child = this.child;
    if (!child) throw new Error(t('capture.win.notActive'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(t('capture.win.timeout')));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, op, ...params })}\n`);
    });
  }

  async list(rootPid: number | null, title: string): Promise<NativeWindow[]> {
    const res = await this.request('list', { root: rootPid ?? 0, title });
    const windows = Array.isArray(res.windows) ? (res.windows as Array<Record<string, unknown>>) : [];
    return windows.map((w) => ({
      id: String(w.id),
      pid: Number(w.pid) || 0,
      title: String(w.title ?? ''),
      minimized: w.minimized === true,
      width: Number(w.width) || 0,
      height: Number(w.height) || 0,
      main: w.main === true,
    }));
  }

  async capture(id: string, opts: CaptureOptions): Promise<CaptureResult> {
    const res = await this.request(
      'capture',
      {
        handle: id,
        format: opts.format,
        quality: opts.quality ?? 82,
        maxWidth: opts.maxWidth ?? 0,
        maxHeight: opts.maxHeight ?? 0,
        lastHash: opts.lastHash ?? '',
      },
      12000,
    );
    const status = res.status === 'ok' || res.status === 'same' || res.status === 'minimized' ? res.status : 'gone';
    return {
      status,
      width: Number(res.width) || 0,
      height: Number(res.height) || 0,
      scale: Number(res.scale) || 1,
      hash: String(res.hash ?? ''),
      data: typeof res.data === 'string' ? Buffer.from(res.data, 'base64') : null,
    };
  }

  async show(id: string): Promise<void> {
    await this.request('show', { handle: id });
  }

  async activate(id: string): Promise<void> {
    await this.request('activate', { handle: id });
  }

  async elementAt(id: string, x: number, y: number): Promise<NativeElement | null> {
    if (!this.elements) return null;
    const res = await this.request('element', { handle: id, x: Math.round(x), y: Math.round(y) }, 4000);
    if (typeof res.role !== 'string') return null;
    return {
      role: res.role,
      name: String(res.name ?? ''),
      automationId: String(res.automationId ?? ''),
      className: String(res.className ?? ''),
      framework: String(res.framework ?? ''),
      path: Array.isArray(res.path) ? (res.path as unknown[]).map(String).slice(-6) : [],
      rect: { x: Number(res.x) || 0, y: Number(res.y) || 0, width: Number(res.width) || 0, height: Number(res.height) || 0 },
    };
  }

  async elementsIn(id: string, rect: Rect): Promise<NativeSummary[]> {
    if (!this.elements) return [];
    const res = await this.request(
      'elementsIn',
      { handle: id, x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      4000,
    );
    const items = Array.isArray(res.items) ? (res.items as Array<Record<string, unknown>>) : [];
    return items.slice(0, 12).map((e) => ({ role: String(e.role ?? ''), name: String(e.name ?? ''), automationId: String(e.automationId ?? '') }));
  }

  dispose(): void {
    this.disposed = true;
    const child = this.child;
    this.child = null;
    try {
      child?.stdin.end();
      child?.kill();
    } catch {
      /* già terminato */
    }
  }
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------
const MAC_LIST_SCRIPT = `
ObjC.import('CoreGraphics');
var info = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0);
var list = ObjC.deepUnwrap(ObjC.castRefToObject(info)) || [];
JSON.stringify(list.filter(function (w) { return w.kCGWindowLayer === 0; }).map(function (w) {
  var b = w.kCGWindowBounds || {};
  return { id: w.kCGWindowNumber, pid: w.kCGWindowOwnerPID, title: w.kCGWindowName || '', owner: w.kCGWindowOwnerName || '', width: b.Width || 0, height: b.Height || 0 };
}));
`;

class MacCapturer implements WindowCapturer {
  readonly name = 'macOS (screencapture)';
  readonly elements = false;
  private readonly tmp = mkdtempSync(path.join(os.tmpdir(), 'rls-capture-'));
  private readonly sizes = new Map<string, number>();
  private counter = 0;
  private readonly listing = new Strikes('capture.mac.list');
  private readonly capturing = new Strikes('capture.mac.permission');

  async list(rootPid: number | null, title: string): Promise<NativeWindow[]> {
    let all: Array<{ id: number; pid: number; title: string; owner: string; width: number; height: number }>;
    try {
      const raw = (await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_LIST_SCRIPT])).toString('utf8').trim();
      all = JSON.parse(raw || '[]') as typeof all;
      this.listing.ok();
    } catch (err) {
      this.listing.fail(err);
      return [];
    }
    const tree = rootPid ? processTree(rootPid, await processParents()) : null;
    const out: NativeWindow[] = [];
    for (const w of all) {
      if (tree && !tree.has(w.pid)) continue;
      if (w.width < 40 || w.height < 30) continue;
      // Senza il permesso "Registrazione schermo" il titolo manca: resta il nome dell'app
      const name = w.title || w.owner;
      if (!matchesTitle(`${w.title} ${w.owner}`, title)) continue;
      if (!tree && !name) continue;
      this.sizes.set(String(w.id), w.width);
      out.push({ id: String(w.id), pid: w.pid, title: name, minimized: false, width: w.width, height: w.height, main: true });
    }
    return out;
  }

  async capture(id: string, opts: CaptureOptions): Promise<CaptureResult> {
    const ext = opts.format === 'jpeg' ? 'jpg' : 'png';
    const file = path.join(this.tmp, `w${++this.counter}.${ext}`);
    try {
      // -x senza suono, -o senza ombra, -l finestra indicata
      await run('/usr/sbin/screencapture', ['-x', '-o', `-l${id}`, '-t', ext, file], { timeout: 10000 });
      const data = readFileSync(file);
      const size = imageSize(data);
      if (!size) throw new Error("screencapture non ha prodotto un'immagine");
      this.capturing.ok();
      const logical = this.sizes.get(id) || size.width;
      return { status: 'ok', width: size.width, height: size.height, scale: Math.max(1, Math.round((size.width / logical) * 100) / 100), hash: '', data };
    } catch (err) {
      // Una volta può essere la finestra appena chiusa (o ridotta nel Dock); se si ripete manca il permesso
      this.capturing.fail(err);
      return { status: 'gone', width: 0, height: 0, scale: 1, hash: '', data: null };
    } finally {
      rmSync(file, { force: true });
    }
  }

  async show(): Promise<void> {
    /* le finestre nel Dock si riaprono dall'app */
  }

  async activate(id: string): Promise<void> {
    const pid = (await this.list(null, '').catch(() => [])).find((w) => w.id === id)?.pid;
    if (pid)
      await run('/usr/bin/osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`]).catch(
        () => undefined,
      );
  }

  async elementAt(): Promise<NativeElement | null> {
    return null;
  }

  async elementsIn(): Promise<NativeSummary[]> {
    return [];
  }

  dispose(): void {
    rmSync(this.tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Linux (X11)
// ---------------------------------------------------------------------------
class X11Capturer implements WindowCapturer {
  readonly name = 'Linux X11 (wmctrl + ImageMagick)';
  readonly elements = false;
  private readonly listing = new Strikes('capture.x11.list');
  private readonly capturing = new Strikes('capture.x11.capture');

  async list(rootPid: number | null, title: string): Promise<NativeWindow[]> {
    // wmctrl -lpG: id, desktop, pid, x, y, larghezza, altezza, host, titolo
    let out: string;
    try {
      out = (await run('wmctrl', ['-lpG'])).toString('utf8');
      this.listing.ok();
    } catch (err) {
      this.listing.fail(err);
      return [];
    }
    const tree = rootPid ? processTree(rootPid, await processParents()) : null;
    const windows: NativeWindow[] = [];
    for (const line of out.split('\n')) {
      const m = /^(0x[0-9a-f]+)\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+\S+\s*(.*)$/i.exec(line);
      if (!m) continue;
      const pid = Number(m[3]);
      const name = m[8].trim();
      if (tree && !tree.has(pid)) continue;
      if (!matchesTitle(name, title)) continue;
      if (!tree && !name) continue;
      if (Number(m[2]) < 0 && !tree) continue; // pannelli e desktop
      windows.push({ id: m[1], pid, title: name, minimized: false, width: Number(m[6]), height: Number(m[7]), main: true });
    }
    return windows;
  }

  async capture(id: string, opts: CaptureOptions): Promise<CaptureResult> {
    try {
      const args = ['-silent', '-window', id];
      if (opts.format === 'jpeg') args.push('-quality', String(opts.quality ?? 82));
      if (opts.maxWidth && opts.maxHeight) args.push('-resize', `${opts.maxWidth}x${opts.maxHeight}>`);
      args.push(opts.format === 'jpeg' ? 'jpeg:-' : 'png:-');
      const data = await run('import', args, { timeout: 10000 });
      const size = imageSize(data);
      if (!size) throw new Error("import non ha prodotto un'immagine");
      this.capturing.ok();
      // Con -resize l'immagine è ridotta: la dimensione vera è quella della geometria della finestra
      const geometry = (await this.list(null, '').catch(() => [])).find((w) => w.id === id);
      return { status: 'ok', width: geometry?.width || size.width, height: geometry?.height || size.height, scale: 1, hash: '', data };
    } catch (err) {
      if (err instanceof CaptureUnavailable) throw err;
      // Finestra chiusa, ridotta a icona o in parte fuori dallo schermo: X11 non le cattura
      this.capturing.fail(err);
      return { status: 'gone', width: 0, height: 0, scale: 1, hash: '', data: null };
    }
  }

  async show(id: string): Promise<void> {
    await run('wmctrl', ['-ia', id]).catch(() => undefined);
  }

  async activate(id: string): Promise<void> {
    await run('wmctrl', ['-ia', id]).catch(() => undefined);
  }

  async elementAt(): Promise<NativeElement | null> {
    return null;
  }

  async elementsIn(): Promise<NativeSummary[]> {
    return [];
  }

  dispose(): void {
    /* niente da chiudere */
  }
}

const hasCommand = (name: string): boolean => {
  try {
    return spawnSync('which', [name], { stdio: 'ignore', timeout: 3000 }).status === 0;
  } catch {
    return false;
  }
};

/**
 * Il modo di catturare le finestre su questo sistema, oppure il motivo per cui non c'è
 * (la pagina Studio allora propone la condivisione della finestra dal browser).
 */
export function createCapturer(platform = process.platform): { capturer: WindowCapturer | null; reason: string } {
  // Per chi preferisce (o deve) condividere la finestra dal browser, e per i test
  if (process.env.RIVERLOOP_STUDIO_NO_CAPTURE === '1') {
    return { capturer: null, reason: t('capture.disabled') };
  }
  if (platform === 'win32') return { capturer: new WindowsCapturer(), reason: '' };
  if (platform === 'darwin') return { capturer: new MacCapturer(), reason: '' };
  // Con Wayland DISPLAY esiste lo stesso (XWayland), ma le finestre native non si possono né
  // elencare né catturare da fuori: lì resta solo la condivisione dal browser.
  if (process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY) {
    return { capturer: null, reason: t('capture.wayland') };
  }
  if (!process.env.DISPLAY) {
    return { capturer: null, reason: t('capture.noDisplay') };
  }
  const missing = ['wmctrl', 'import'].filter((c) => !hasCommand(c));
  if (missing.length) {
    return { capturer: null, reason: t('capture.x11.missing', { missing: missing.join(', ') }) };
  }
  return { capturer: new X11Capturer(), reason: '' };
}
