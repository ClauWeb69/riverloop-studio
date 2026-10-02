import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OVERLAY_FILE = path.join(fileURLToPath(new URL('../../', import.meta.url)), 'overlay', 'overlay.js');

/** Configurazione passata all'overlay quando viene servito o iniettato. */
export type OverlayConfig =
  /** App web: l'overlay sta in un iframe e parla con la pagina Studio (origini ammesse) via postMessage. */
  | { parentOrigins: string[] }
  /** App desktop Chromium: l'overlay sta nella pagina dell'app e parla con il companion tramite il ponte CDP. */
  | { bridge: true };

/**
 * Sorgente dell'overlay compilato (dist/overlay/overlay.js) con la sua configurazione.
 * Restituisce null se manca la build; il file viene letto una volta sola.
 */
export function overlayLoader(config: OverlayConfig): () => string | null {
  let cached: string | null = null;
  return () => {
    if (cached) return cached;
    if (!existsSync(OVERLAY_FILE)) return null;
    const source = readFileSync(OVERLAY_FILE, 'utf8');
    cached = `(function(){var __RLS_OVERLAY_CONFIG__=${JSON.stringify(config)};\n${source}\n})();\n`;
    return cached;
  };
}
