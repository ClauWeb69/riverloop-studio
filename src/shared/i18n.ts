// Traduzioni: lingue supportate, riconoscimento della lingua e funzione t() con parametri.
// Compilato sia per Node sia per il browser: niente dipendenze, niente accesso all'ambiente.
// Ogni parte (server, pagina, overlay) ha i suoi dizionari: l'italiano è il riferimento e
// l'inglese deve avere le stesse chiavi (il tipo Messages<typeof it> lo controlla).

export type Locale = 'en' | 'it';
export const LOCALES: readonly Locale[] = ['en', 'it'];
/** Lingua usata quando quella del sistema non è tra quelle supportate. */
export const DEFAULT_LOCALE: Locale = 'en';
/** Nome di ogni lingua scritto nella lingua stessa (per il selettore). */
export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', it: 'Italiano' };

/** Riconosce una lingua da un tag BCP 47 o da una variabile POSIX ("it-IT", "en_US.UTF-8", "it"). */
export function normalizeLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const base = tag
    .trim()
    .toLowerCase()
    .split(/[-_.@]/)[0];
  return (LOCALES as readonly string[]).includes(base) ? (base as Locale) : null;
}

/** Un dizionario con le stesse chiavi di quello di riferimento. */
export type Messages<T> = { readonly [K in keyof T]: string };

export type Params = Record<string, string | number>;

/**
 * Crea la funzione di traduzione per un insieme di dizionari. I parametri si scrivono {nome};
 * con il parametro count, se esiste la chiave "<chiave>_one" viene usata quando count è 1.
 * Una chiave mancante nella lingua scelta ricade sull'inglese, poi sulla chiave stessa.
 */
export function createTranslator<T extends Record<string, string>>(dicts: Record<Locale, Messages<T>>, locale: () => Locale) {
  return function t(key: keyof T & string, params?: Params): string {
    const dict = dicts[locale()] as Record<string, string>;
    const fallback = dicts[DEFAULT_LOCALE] as Record<string, string>;
    let text = dict[key] ?? fallback[key] ?? key;
    if (params && params.count === 1) {
      const one = dict[`${key}_one`] ?? fallback[`${key}_one`];
      if (one !== undefined) text = one;
    }
    return params ? text.replace(/\{(\w+)\}/g, (all, name: string) => (name in params ? String(params[name]) : all)) : text;
  };
}
