// Testi dell'overlay (disegnati dentro l'app). La lingua arriva dalla pagina Studio con il
// messaggio hello; fino ad allora si usa l'inglese.
import { createTranslator, DEFAULT_LOCALE, normalizeLocale, type Locale, type Messages } from '../shared/i18n';

const it = {
  'kind.element': 'Elemento',
  'kind.area': 'Riquadro',
  'kind.drawing': 'Disegno',
  'pill.select': 'clic per scegliere · ↑ ↓ genitore/figlio · Esc per uscire',
  'pill.area': 'trascina per segnare una zona · Esc per uscire',
  'pill.draw': 'traccia a mano libera · Esc per uscire',
  'pill.close': 'Torna a Naviga (Esc)',
  'draft.freehand': 'tratto a mano libera',
  'shot.failed': 'cattura non riuscita',
  'shot.slow': 'cattura troppo lenta',
  'shot.offPage': 'zona fuori dalla pagina',
  'shot.unreachable': 'Studio non raggiungibile',
  'shot.protected': 'contenuto protetto (canvas o immagini di altri domini)',
  'shot.noCanvas': 'canvas non disponibile',
  'shot.emptyImage': 'immagine vuota',
  'shot.badImage': 'immagine non valida',
} as const;

const en: Messages<typeof it> = {
  'kind.element': 'Element',
  'kind.area': 'Area',
  'kind.drawing': 'Drawing',
  'pill.select': 'click to choose · ↑ ↓ parent/child · Esc to exit',
  'pill.area': 'drag to mark an area · Esc to exit',
  'pill.draw': 'draw freehand · Esc to exit',
  'pill.close': 'Back to Navigate (Esc)',
  'draft.freehand': 'freehand stroke',
  'shot.failed': 'capture failed',
  'shot.slow': 'capture too slow',
  'shot.offPage': 'area outside the page',
  'shot.unreachable': 'Studio unreachable',
  'shot.protected': 'protected content (canvas or images from other domains)',
  'shot.noCanvas': 'canvas not available',
  'shot.emptyImage': 'empty image',
  'shot.badImage': 'invalid image',
};

let current: Locale = DEFAULT_LOCALE;

export const t = createTranslator<typeof it>({ it, en }, () => current);

/** Lingua indicata dalla pagina Studio; true se è cambiata. Valori sconosciuti ignorati. */
export function setOverlayLocale(value: unknown): boolean {
  const locale = typeof value === 'string' ? normalizeLocale(value) : null;
  if (!locale || locale === current) return false;
  current = locale;
  return true;
}
