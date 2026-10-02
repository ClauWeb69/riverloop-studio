// Lingua del server: messaggi nel terminale, testi delle richieste a Claude Code, errori delle API.
// Priorità: --lang, poi RIVERLOOP_STUDIO_LANG, poi la scelta salvata dalla pagina Studio
// (settings.json nella cartella di configurazione dell'utente), poi la lingua del sistema.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createTranslator, DEFAULT_LOCALE, normalizeLocale, type Locale } from '../shared/i18n.js';
import { en } from './locales/en.js';
import { it } from './locales/it.js';
import { studioConfigDir } from './paths.js';

let current: Locale = detectLocale();
/** La lingua è stata scelta (--lang, variabile d'ambiente, pagina Studio) e non presa dal sistema. */
let chosen = Boolean(normalizeLocale(process.env.RIVERLOOP_STUDIO_LANG) ?? savedLocale());

/** Lingua del sistema operativo, se supportata. */
export function systemLocale(env: NodeJS.ProcessEnv = process.env): Locale | null {
  for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE'] as const) {
    const value = env[name];
    // "C" e "POSIX" non dicono nulla sulla lingua: si guarda oltre
    if (value && value !== 'C' && value !== 'POSIX') {
      const found = normalizeLocale(value.split(':')[0]);
      if (found) return found;
    }
  }
  try {
    return normalizeLocale(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return null;
  }
}

function settingsFile(): string {
  return path.join(studioConfigDir(), 'settings.json');
}

/** Lingua scelta nella pagina Studio e salvata per l'utente; null se non è mai stata scelta. */
export function savedLocale(): Locale | null {
  try {
    const data = JSON.parse(readFileSync(settingsFile(), 'utf8')) as { locale?: unknown };
    return typeof data.locale === 'string' ? normalizeLocale(data.locale) : null;
  } catch {
    return null;
  }
}

/** Salva la lingua scelta (null: si torna a quella del sistema). Non lancia mai. */
export function saveLocale(locale: Locale | null): void {
  try {
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(readFileSync(settingsFile(), 'utf8')) as Record<string, unknown>;
    } catch {
      /* file assente o illeggibile: si riparte da zero */
    }
    if (locale) data.locale = locale;
    else delete data.locale;
    mkdirSync(studioConfigDir(), { recursive: true });
    writeFileSync(settingsFile(), `${JSON.stringify(data, null, 2)}\n`);
  } catch {
    /* la scelta vale comunque per questa esecuzione */
  }
}

/** Lingua da usare senza --lang: variabile d'ambiente, scelta salvata, sistema, inglese. */
export function detectLocale(env: NodeJS.ProcessEnv = process.env): Locale {
  return normalizeLocale(env.RIVERLOOP_STUDIO_LANG) ?? savedLocale() ?? systemLocale(env) ?? DEFAULT_LOCALE;
}

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale, isChosen = true): void {
  current = locale;
  chosen = isChosen;
}

export function localeChosen(): boolean {
  return chosen;
}

/** Traduce una chiave dei dizionari del server nella lingua corrente. */
export const t = createTranslator({ en, it }, () => current);

/** Chiave di un testo del server (per i testi da ritradurre se la lingua cambia). */
export type MessageKey = Parameters<typeof t>[0];

/** Traduce in una lingua precisa (per esempio il testo di una richiesta per un'altra pagina). */
export const tIn = (locale: Locale) => createTranslator({ en, it }, () => locale);
