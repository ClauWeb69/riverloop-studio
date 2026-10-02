// Preferenze per questo browser (localStorage). Ogni accesso è protetto: in finestre private
// o con i dati del sito bloccati lo storage può mancare, e Studio deve funzionare lo stesso.
export type ViewMode = 'split' | 'app' | 'console';
export type ViewportMode = 'desktop' | 'tablet' | 'mobile';
export type ThemeMode = 'system' | 'light' | 'dark';

export interface Prefs {
  split: number;
  swapped: boolean;
  view: ViewMode;
  viewport: ViewportMode;
  autoSend: boolean | null;
  theme: ThemeMode;
  fontSize: number;
  fontFamily: string;
}

export const DEFAULT_FONT = '"JetBrains Mono", "Cascadia Code", Menlo, monospace';

const DEFAULTS: Prefs = {
  split: 60,
  swapped: false,
  view: 'split',
  viewport: 'desktop',
  autoSend: null,
  theme: 'system',
  fontSize: 14,
  fontFamily: DEFAULT_FONT,
};

const KEY = 'riverloop-studio:prefs';

function read(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    return { ...DEFAULTS };
  }
}

const current: Prefs = read();

export const prefs = {
  get<K extends keyof Prefs>(key: K): Prefs[K] {
    return current[key];
  },
  set<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
    current[key] = value;
    try {
      localStorage.setItem(KEY, JSON.stringify(current));
    } catch {
      /* storage non disponibile: resta in memoria */
    }
  },
};

/** Valori per singolo progetto (es. ultimo percorso aperto nell'iframe). */
export function projectValue(project: string, name: string): string | null {
  try {
    return sessionStorage.getItem(`riverloop-studio:${project}:${name}`);
  } catch {
    return null;
  }
}

export function setProjectValue(project: string, name: string, value: string): void {
  try {
    sessionStorage.setItem(`riverloop-studio:${project}:${name}`, value);
  } catch {
    /* ignorato */
  }
}
