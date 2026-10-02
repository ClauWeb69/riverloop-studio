// Overlay di Riverloop Studio. Due modi di arrivare nella pagina dell'app:
// - app web: iniettato dal proxy in ogni pagina HTML; si attiva solo quando la pagina è dentro
//   l'iframe di Studio (e non in iframe annidati);
// - app desktop Chromium (modalità electron): iniettato dal companion tramite la porta di
//   debug; si attiva solo nel documento principale della finestra.
import { Overlay } from './overlay';
import { BridgeTransport, FrameTransport } from './transport';

declare const __RLS_OVERLAY_CONFIG__: { parentOrigins?: string[]; bridge?: boolean } | undefined;

(() => {
  const script = document.currentScript;
  try {
    script?.remove();
    const config = typeof __RLS_OVERLAY_CONFIG__ !== 'undefined' ? __RLS_OVERLAY_CONFIG__ : undefined;
    if (!config) return;
    const bridge = config.bridge === true;
    if (bridge ? window.top !== window : window.top === window || window.parent !== window.top) return;
    const flag = '__riverloopStudioOverlay__';
    const w = window as unknown as Record<string, unknown>;
    if (w[flag]) return;
    Object.defineProperty(w, flag, { value: true });
    if (bridge) {
      new Overlay(new BridgeTransport()).init();
      return;
    }
    if (!Array.isArray(config.parentOrigins)) return;
    new Overlay(new FrameTransport(config.parentOrigins)).init();
  } catch (err) {
    console.warn('[Riverloop Studio] overlay non avviato:', err);
  }
})();
