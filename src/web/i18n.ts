// Traduzioni della pagina Studio. La lingua la decide il companion (/api/config); finché non
// arriva si usa l'ultima vista in questo browser, oppure quella del browser.
import { createTranslator, DEFAULT_LOCALE, normalizeLocale, type Locale } from '../shared/i18n';
import { en } from './locales/en';
import { it } from './locales/it';

export type MessageKey = keyof typeof it & string;

const CACHE_KEY = 'riverloop-studio:locale';

function cachedLocale(): Locale | null {
  try {
    return normalizeLocale(localStorage.getItem(CACHE_KEY));
  } catch {
    return null;
  }
}

let current: Locale = cachedLocale() ?? normalizeLocale(navigator.language) ?? DEFAULT_LOCALE;
document.documentElement.lang = current;

export const t = createTranslator<typeof it>({ it, en }, () => current);

export function pageLocale(): Locale {
  return current;
}

/** Ricorda la lingua per il prossimo caricamento (evita un lampo nella lingua sbagliata). */
export function rememberLocale(locale: Locale): void {
  try {
    localStorage.setItem(CACHE_KEY, locale);
  } catch {
    /* storage non disponibile */
  }
}

/** Imposta la lingua della pagina e ritraduce il markup statico se è cambiata. */
export function setPageLocale(value: Locale | string | null | undefined): void {
  const locale = normalizeLocale(value);
  if (!locale) return;
  rememberLocale(locale);
  if (locale === current) return;
  current = locale;
  document.documentElement.lang = locale;
  translateDom();
}

const ATTRS: Array<[string, string]> = [
  ['i18nTitle', 'title'],
  ['i18nAriaLabel', 'aria-label'],
  ['i18nPlaceholder', 'placeholder'],
];

/**
 * Traduce il markup statico di index.html: data-i18n (testo), data-i18n-title,
 * data-i18n-aria-label, data-i18n-placeholder. I pulsanti con icona (data-icon-left) tengono
 * il testo in uno <span class="lbl"> dopo hydrateIcons: si traduce quello.
 */
export function translateDom(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const text = t(el.dataset.i18n as MessageKey);
    const label = el.dataset.iconLeft !== undefined ? el.querySelector(':scope > .lbl') : null;
    if (label) label.textContent = text;
    else el.textContent = text;
  });
  for (const [data, attr] of ATTRS) {
    const selector = `[data-${data.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}]`;
    root.querySelectorAll<HTMLElement>(selector).forEach((el) => el.setAttribute(attr, t(el.dataset[data] as MessageKey)));
  }
}
