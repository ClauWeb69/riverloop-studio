// Scelte che valgono per un progetto ma non devono stare nel progetto: chi controlla i file
// del progetto (un repository scaricato, un collega che ha fatto commit di .claude/studio)
// non deve poter decidere, per esempio, che Claude Code parta senza richieste di permesso.
// Stanno nella cartella di configurazione dell'utente, con il percorso del progetto come chiave.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { studioConfigDir } from './paths.js';

export interface UserProjectState {
  /** Permessi di Claude Code scelti dalla pagina Studio per questo progetto. */
  permissions?: 'ask' | 'skip';
}

const file = () => path.join(studioConfigDir(), 'projects.json');

/** Chiave del progetto: percorso assoluto, senza distinzione di maiuscole su Windows e macOS. */
export function projectKey(cwd: string): string {
  const abs = path.resolve(cwd);
  return process.platform === 'win32' || process.platform === 'darwin' ? abs.toLowerCase() : abs;
}

async function readAll(): Promise<Record<string, UserProjectState>> {
  try {
    const data = JSON.parse(await readFile(file(), 'utf8')) as unknown;
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, UserProjectState>) : {};
  } catch {
    return {};
  }
}

export async function readUserProjectState(cwd: string): Promise<UserProjectState> {
  const entry = (await readAll())[projectKey(cwd)];
  const out: UserProjectState = {};
  if (entry && (entry.permissions === 'ask' || entry.permissions === 'skip')) out.permissions = entry.permissions;
  return out;
}

/** Aggiorna solo i campi indicati (scrittura atomica, file leggibile solo dall'utente). */
export async function updateUserProjectState(cwd: string, patch: Partial<UserProjectState>): Promise<void> {
  const all = await readAll();
  const key = projectKey(cwd);
  all[key] = { ...all[key], ...patch };
  await mkdir(studioConfigDir(), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, file());
}
