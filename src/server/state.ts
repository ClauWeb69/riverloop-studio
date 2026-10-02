import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { STUDIO_DIR, studioDir } from './annotations.js';

/** Preferenze di Studio salvate per progetto in .claude/studio/state.json. */
export interface ProjectState {
  /** L'utente ha detto di no alla proposta per il .gitignore. */
  gitignoreDeclined?: boolean;
  /** Modalità desktop: riavvia l'app quando Claude Code finisce una risposta con modifiche. */
  restartOnIdle?: boolean;
  /** Nomi dati alle schede, per conversazione di Claude Code (id della conversazione → nome). */
  sessionNames?: Record<string, string>;
  /** Suggerimenti che l'utente non vuole più vedere per questo progetto. */
  dismissedSuggestions?: string[];
}

/** Nomi di schede ricordati per progetto: i più recenti. */
export const MAX_SESSION_NAMES = 60;

/** Nome di una scheda: una riga, senza caratteri di controllo, al più 40 caratteri. */
export function cleanSessionName(name: string): string {
  return String(name)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

const stateFile = (cwd: string) => path.join(cwd, STUDIO_DIR, 'state.json');

export async function readProjectState(cwd: string): Promise<ProjectState> {
  try {
    const data = JSON.parse(await readFile(stateFile(cwd), 'utf8')) as Record<string, unknown>;
    const out: ProjectState = {};
    if (data.gitignoreDeclined === true) out.gitignoreDeclined = true;
    // I permessi non si leggono più da qui (vedi userState.ts): un file del progetto non li decide
    if (typeof data.restartOnIdle === 'boolean') out.restartOnIdle = data.restartOnIdle;
    if (data.sessionNames && typeof data.sessionNames === 'object' && !Array.isArray(data.sessionNames)) {
      const names: Record<string, string> = {};
      for (const [id, name] of Object.entries(data.sessionNames as Record<string, unknown>).slice(-MAX_SESSION_NAMES)) {
        if (/^[0-9a-f-]{36}$/i.test(id) && typeof name === 'string') {
          const clean = cleanSessionName(name);
          if (clean) names[id] = clean;
        }
      }
      out.sessionNames = names;
    }
    if (Array.isArray(data.dismissedSuggestions)) {
      out.dismissedSuggestions = data.dismissedSuggestions.filter((x): x is string => typeof x === 'string' && /^[a-z-]{1,40}$/.test(x)).slice(0, 20);
    }
    return out;
  } catch {
    return {};
  }
}

/** Aggiorna solo i campi indicati (scrittura atomica: file temporaneo + rename). */
export async function updateProjectState(cwd: string, patch: Partial<ProjectState>): Promise<void> {
  const current = await readProjectState(cwd);
  const next = { ...current, ...patch };
  const file = path.join(await studioDir(cwd, STUDIO_DIR, true), 'state.json');
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}
