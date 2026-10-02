// Cartella di configurazione dell'utente (progetti recenti, impostazioni). Senza altre
// dipendenze del server: la usa anche i18n.ts, che viene valutato prima di quasi tutto.
import os from 'node:os';
import path from 'node:path';

export function studioConfigDir(): string {
  if (process.env.RIVERLOOP_STUDIO_CONFIG_DIR) return process.env.RIVERLOOP_STUDIO_CONFIG_DIR;
  if (process.platform === 'win32' && process.env.APPDATA) return path.join(process.env.APPDATA, 'riverloop-studio');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'riverloop-studio');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'riverloop-studio');
}
