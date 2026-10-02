import type { AnnotationContext, AnnotationData, OverlayToPage, PageToOverlay, Rect, ToolMode } from '../shared/protocol';

/** Chi ospita la superficie (il pannello dell'app). */
export interface SurfaceHost {
  /** Messaggio dell'overlay dell'app, o dell'annotatore locale nelle finestre native. */
  onSurfaceMessage(msg: OverlayToPage): void;
  /** La superficie è diventata pronta o non lo è più (pagina ricaricata, finestra sparita). */
  onSurfaceReady(): void;
}

/**
 * Ciò che il pannello dell'app mostra e su cui si annota. Tre casi:
 * - app web: iframe sul proxy, con l'overlay iniettato nella pagina;
 * - app desktop Chromium (electron): copia dal vivo della pagina, con mouse e tastiera, e lo
 *   stesso overlay iniettato tramite la porta di debug;
 * - finestra nativa (window): immagine della finestra, annotata direttamente nella pagina Studio.
 * Verso il resto della pagina parlano tutte la stessa lingua dei messaggi dell'overlay.
 */
export interface Surface {
  /** Gli strumenti di annotazione sono utilizzabili. */
  readonly ready: boolean;
  post(msg: PageToOverlay): void;
  nav(action: 'back' | 'forward' | 'reload'): void;
  /** Apre un percorso dell'app (solo app web). */
  navigate(url: string): void;
  /** Converte una zona dalle coordinate della superficie a quelle dello stage. */
  locate(rect: Rect): Rect;
  /** Spiega perché uno strumento non è disponibile (null se lo è). */
  unavailable(mode: ToolMode): string | null;
  /** Finestre native: immagini della finestra intera con le annotazioni del gruppo evidenziate. */
  contextImages?(batch: AnnotationData[]): Promise<AnnotationContext[]>;
  /** Claude Code ha finito una risposta (l'app può essere cambiata o riavviata). */
  idle?(): void;
}

/** Adatta un riquadro (larghezza × altezza) dentro un contenitore, senza ingrandirlo oltre 1:1. */
export function fitInside(width: number, height: number, boxWidth: number, boxHeight: number, maxScale = 1): { width: number; height: number; scale: number } {
  if (!width || !height || !boxWidth || !boxHeight) return { width: 0, height: 0, scale: 1 };
  const scale = Math.min(maxScale, boxWidth / width, boxHeight / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

/**
 * Messaggio per un overlay che gira dentro l'app (iframe o app desktop): gli script dell'app lo
 * possono leggere, quindi niente testo dei commenti, che resta nella pagina Studio.
 */
export function forAppOverlay(msg: PageToOverlay): PageToOverlay {
  if (msg.type === 'annotation:update') return { ...msg, comment: '' };
  if (msg.type === 'hello' || msg.type === 'annotations:sync') return { ...msg, annotations: msg.annotations.map((a) => ({ ...a, comment: '' })) };
  return msg;
}
