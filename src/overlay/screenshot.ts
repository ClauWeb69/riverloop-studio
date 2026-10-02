// Screenshot della zona annotata con html-to-image, limitato alla zona (+40 px di margine).
import { getFontEmbedCSS, toCanvas } from 'html-to-image';
import { effectiveBackground } from './collect';
import { t } from './i18n';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BaseShot {
  canvas: HTMLCanvasElement;
  /** Zona catturata, in coordinate viewport al momento della cattura. */
  area: Box;
  ratio: number;
}

export const SHOT_MARGIN = 40;
const MARGIN = SHOT_MARGIN;
const TIMEOUT_MS = 12000;
const PLACEHOLDER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

let fontCss: Promise<string> | null = null;

function fonts(): Promise<string> {
  fontCss ??= Promise.race([getFontEmbedCSS(document.body).catch(() => ''), new Promise<string>((r) => setTimeout(() => r(''), 4000))]);
  return fontCss;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Elemento più piccolo che contiene tutta la zona (altrimenti il body). */
function findContainer(area: Box, exclude: Element, pick: (x: number, y: number) => Element | null): HTMLElement {
  const cx = Math.min(innerWidth - 1, Math.max(0, area.x + area.width / 2));
  const cy = Math.min(innerHeight - 1, Math.max(0, area.y + area.height / 2));
  let el: Element | null = pick(cx, cy);
  while (el && el !== document.body && el !== document.documentElement) {
    if (el instanceof HTMLElement && !exclude.contains(el)) {
      const r = el.getBoundingClientRect();
      if (r.left <= area.x && r.top <= area.y && r.right >= area.x + area.width && r.bottom >= area.y + area.height) return el;
    }
    el = el.parentElement;
  }
  return document.body;
}

/** Cattura la zona (coordinate viewport) e restituisce l'immagine di base, senza i segni. */
export async function captureBase(zone: Box, exclude: Element, pick: (x: number, y: number) => Element | null): Promise<BaseShot> {
  const wanted: Box = { x: zone.x - MARGIN, y: zone.y - MARGIN, width: zone.width + MARGIN * 2, height: zone.height + MARGIN * 2 };
  const container = findContainer(wanted, exclude, pick);
  const cr = container.getBoundingClientRect();
  const x0 = Math.max(wanted.x, cr.left);
  const y0 = Math.max(wanted.y, cr.top);
  const x1 = Math.min(wanted.x + wanted.width, cr.right);
  const y1 = Math.min(wanted.y + wanted.height, cr.bottom);
  if (x1 - x0 < 2 || y1 - y0 < 2) throw new Error(t('shot.offPage'));
  const ratio = Math.max(0.5, Math.min(2, window.devicePixelRatio || 1, 2400 / Math.max(x1 - x0, y1 - y0)));

  const fontEmbedCSS = await fonts();
  const rendered = await withTimeout(
    toCanvas(container, {
      pixelRatio: ratio,
      backgroundColor: effectiveBackground(container),
      imagePlaceholder: PLACEHOLDER,
      cacheBust: false,
      fontEmbedCSS: fontEmbedCSS || undefined,
      skipFonts: !fontEmbedCSS,
      filter: (node) => {
        if (!(node instanceof Element)) return true;
        if (node === exclude || node.tagName === 'NEXTJS-PORTAL' || node.hasAttribute('data-riverloop-studio')) return false;
        return true;
      },
    }),
    TIMEOUT_MS,
    t('shot.slow'),
  );

  const sx = rendered.width / Math.max(1, cr.width);
  const sy = rendered.height / Math.max(1, cr.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round((x1 - x0) * ratio));
  canvas.height = Math.max(1, Math.round((y1 - y0) * ratio));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(t('shot.noCanvas'));
  ctx.drawImage(rendered, (x0 - cr.left) * sx, (y0 - cr.top) * sy, (x1 - x0) * sx, (y1 - y0) * sy, 0, 0, canvas.width, canvas.height);
  return { canvas, area: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, ratio };
}

/**
 * Immagine di base ritagliata da una cattura della vista intera (data URL): area è la zona
 * voluta, in coordinate viewport.
 */
export function baseFromViewport(dataUrl: string, area: Box): Promise<BaseShot> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      // Pixel dell'immagine per ogni px CSS (schermi ad alta densità)
      const density = img.naturalWidth / Math.max(1, window.innerWidth);
      if (!img.naturalWidth || !Number.isFinite(density) || density <= 0) return reject(new Error(t('shot.emptyImage')));
      const ratio = Math.max(0.5, Math.min(2, density, 2400 / Math.max(area.width, area.height)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(area.width * ratio));
      canvas.height = Math.max(1, Math.round(area.height * ratio));
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error(t('shot.noCanvas')));
      ctx.drawImage(img, area.x * density, area.y * density, area.width * density, area.height * density, 0, 0, canvas.width, canvas.height);
      resolve({ canvas, area, ratio });
    };
    img.onerror = () => reject(new Error(t('shot.badImage')));
    img.src = dataUrl;
  });
}

export interface MarkShape {
  kind: 'element' | 'area' | 'drawing';
  /** Zona annotata in coordinate viewport (le stesse usate per la cattura). */
  box: Box;
  /** Punti del tratto, relativi a box.x / box.y. */
  path?: Array<[number, number]>;
  id: number | null;
}

const BRAND = '#b12584';
const RED = '#e5484d';

/** Disegna i segni dell'annotazione sopra l'immagine e restituisce il PNG. */
export function finalizeShot(base: BaseShot, mark: MarkShape): string {
  const out = document.createElement('canvas');
  out.width = base.canvas.width;
  out.height = base.canvas.height;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(base.canvas, 0, 0);
  ctx.save();
  ctx.scale(base.ratio, base.ratio);
  ctx.translate(-base.area.x, -base.area.y);
  const { box } = mark;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (mark.kind === 'drawing' && mark.path && mark.path.length > 1) {
    ctx.strokeStyle = RED;
    ctx.lineWidth = 3;
    ctx.beginPath();
    mark.path.forEach(([px, py], i) => (i ? ctx.lineTo(box.x + px, box.y + py) : ctx.moveTo(box.x + px, box.y + py)));
    ctx.stroke();
  } else {
    ctx.strokeStyle = BRAND;
    ctx.lineWidth = 2;
    if (mark.kind === 'area') ctx.setLineDash([6, 4]);
    ctx.strokeRect(box.x - 1, box.y - 1, box.width + 2, box.height + 2);
    ctx.setLineDash([]);
  }
  if (mark.id !== null) {
    const bx = mark.kind === 'drawing' && mark.path?.length ? box.x + mark.path[mark.path.length - 1][0] : box.x;
    const by = mark.kind === 'drawing' && mark.path?.length ? box.y + mark.path[mark.path.length - 1][1] : box.y;
    const label = String(mark.id);
    ctx.font = '700 12px system-ui, -apple-system, "Segoe UI", sans-serif';
    const w = Math.max(22, ctx.measureText(label).width + 12);
    ctx.fillStyle = mark.kind === 'drawing' ? RED : BRAND;
    ctx.beginPath();
    ctx.roundRect(bx - w / 2, by - 11, w, 22, 11);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx, by + 0.5);
  }
  ctx.restore();
  return out.toDataURL('image/png');
}
