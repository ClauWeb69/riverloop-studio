import type { PermissionModeName } from '../shared/protocol.js';

// Lettura (euristica) dello schermo di Claude Code: serve all'invio automatico per capire se
// il testo incollato è rimasto nel riquadro di input. Nel dubbio la risposta è sempre "no":
// un Invio in più nel momento sbagliato potrebbe confermare una richiesta di permesso.

/**
 * Linea continua che delimita il riquadro di input (anche con gli angoli delle versioni vecchie).
 * Può finire con una breve etichetta: con ultracode attivo la linea di sopra è "──── ultracode ─"
 * (Claude Code 2.1.287).
 */
const SOLID_RULE = /^[╭╰┌└]?─{10,}(?: [a-z][a-z0-9 -]{0,23} ─{1,4})?[╮╯┐┘]?$/;
/** Linea inferiore del riquadro: sempre senza etichetta (nel dubbio, nessun riquadro). */
const PLAIN_RULE = /^[╰└]?─{10,}[╯┘]?$/;
/** Prima riga del riquadro: il cursore del prompt ("❯ testo", "> testo", "│ > testo"). */
const PROMPT_LINE = /^(?:│\s*)?[❯>](?:\s|$)/;
/** Voce di un menu di scelta ("❯ 1. Yes"): non è il riquadro di input. */
const MENU_LINE = /^(?:│\s*)?[❯>]?\s*\d+\.\s/;
/** Voce selezionata di un menu (con il cursore): c'è una scelta in attesa. */
const MENU_CURSOR = /^(?:│\s*)?[❯>]\s*\d+\.\s/;
/** Testi delle finestre di conferma di Claude Code. */
const DIALOG_HINT = /Do you want to|Would you like to|Esc to cancel|Enter to confirm|\[y\/n\]|\(y\/n\)/i;
/** Righe ammesse sotto il riquadro di input (avvisi, status line, modalità, suggerimenti brevi). */
const MAX_FOOTER_LINES = 6;

/**
 * Testo del riquadro di input se l'ultima cosa sullo schermo è proprio il riquadro di input
 * (linea, "❯ ...", linea, al massimo qualche riga di stato); altrimenti null.
 */
export function inputBoxText(screen: string[]): string | null {
  const box = inputBox(screen);
  return box && box.content.join('\n');
}

/** Posizione del riquadro di input (righe delle due linee) e il suo contenuto; vedi inputBoxText. */
function inputBox(screen: string[]): { top: number; bottom: number; content: string[] } | null {
  const lines = screen.map((l) => l.replace(/\s+$/, ''));
  let bottom = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (SOLID_RULE.test(lines[i].trim())) {
      bottom = i;
      break;
    }
  }
  if (bottom < 1) return null;
  // L'ultima linea dello schermo è quella inferiore: se ha un'etichetta non è il riquadro
  if (!PLAIN_RULE.test(lines[bottom].trim())) return null;
  const footer = lines.slice(bottom + 1).filter((l) => l.trim());
  if (footer.length > MAX_FOOTER_LINES || footer.some((l) => MENU_LINE.test(l.trim()) || DIALOG_HINT.test(l))) return null;
  let top = -1;
  for (let i = bottom - 1; i >= 0 && i >= bottom - 60; i--) {
    if (SOLID_RULE.test(lines[i].trim())) {
      top = i;
      break;
    }
  }
  if (top < 0 || top === bottom - 1) return null;
  const content = lines.slice(top + 1, bottom);
  const first = content[0].trim();
  if (!PROMPT_LINE.test(first) || MENU_LINE.test(first)) return null;
  return { top, bottom, content };
}

/**
 * true solo se il testo incollato è con certezza ancora nel riquadro di input (segnaposto
 * "[Pasted text #N]" oppure la prima riga del messaggio). Una richiesta di permesso prende il
 * posto del riquadro di input: se in fondo allo schermo c'è il riquadro, Invio va lì.
 * Più in alto possono restare testi come "Do you want to…" (risposte di Claude): non contano.
 */
export function pasteStillInInput(screen: string[], firstLine: string): boolean {
  const box = inputBoxText(screen);
  if (box === null || DIALOG_HINT.test(box)) return false;
  if (/\[Pasted text #\d+/.test(box)) return true;
  const needle = firstLine.replace(/\s+/g, ' ').trim().slice(0, 40);
  if (needle.length < 8) return false;
  // Il riquadro va a capo: confrontiamo il testo senza gli a capo e gli spazi di rientro.
  const flat = box
    .split('\n')
    .map((l) => l.replace(/^(?:│\s*)?(?:[❯>]\s)?\s*/, '').replace(/\s*│$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ');
  return flat.includes(needle);
}

export type ScreenState = 'input' | 'awaiting-answer' | 'unknown';

/**
 * Cosa mostra Claude Code in fondo allo schermo: il riquadro di input, una richiesta di
 * permesso o un menu in attesa di risposta, oppure qualcosa che non riconosciamo.
 */
export function screenState(screen: string[]): ScreenState {
  if (inputBoxText(screen) !== null) return 'input';
  const tail = screen
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim())
    .slice(-16);
  if (tail.some((l) => DIALOG_HINT.test(l) || MENU_CURSOR.test(l.trim()))) return 'awaiting-answer';
  return 'unknown';
}

/** Testo della modalità in fondo allo schermo (Claude Code 2.1.28x: "⏸ manual mode on", "⏵⏵ accept edits on"...). */
const MODE_TEXTS: Array<[RegExp, PermissionModeName]> = [
  [/\bmanual mode on\b/i, 'default'],
  [/\baccept edits on\b/i, 'acceptEdits'],
  [/\bplan mode on\b/i, 'plan'],
  [/\bauto mode on\b/i, 'auto'],
  [/\bbypass permissions on\b/i, 'bypassPermissions'],
  [/\bdon'?t ask (?:mode )?on\b/i, 'dontAsk'],
];

/**
 * Modalità dei permessi mostrata sotto il riquadro di input; null se il riquadro non c'è o se
 * il testo non si riconosce (versioni di Claude Code diverse: nel dubbio, nessuna modalità).
 */
export function permissionMode(screen: string[]): PermissionModeName | null {
  const box = inputBox(screen);
  if (!box) return null;
  for (const line of screen.slice(box.bottom + 1)) {
    for (const [re, mode] of MODE_TEXTS) if (re.test(line.trim())) return mode;
  }
  return null;
}

/** Livelli che l'indicatore dell'effort può mostrare. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';

/**
 * Indicatore dell'effort di Claude Code 2.1.287, allineato a destra sopra il riquadro di input:
 * "◉ xhigh · /effort", "◐ medium · /effort", con ultracode "◉ xhigh · ultracode · /effort".
 * Il simbolo iniziale cambia con il livello: qualunque va bene.
 */
const EFFORT_INDICATOR = /^[^\s·]{1,3}\s(low|medium|high|xhigh|max|auto)(\s·\sultracode)?\s·\s\/effort$/;

/**
 * Effort e ultracode letti dall'indicatore sopra il riquadro di input; null se il riquadro non
 * c'è o se la riga subito sopra non è proprio l'indicatore (nel dubbio, nessun valore). Conta
 * solo quella riga, e solo se allineata a destra (finisce vicino alla fine della linea superiore
 * del riquadro): la stessa frase nella conversazione non conta.
 */
export function effortIndicator(screen: string[]): { level: EffortLevel; ultracode: boolean } | null {
  const box = inputBox(screen);
  if (!box || box.top < 1) return null;
  const raw = screen[box.top - 1].replace(/\s+$/, '');
  const text = raw.trim();
  const indent = raw.length - raw.trimStart().length;
  // Allineata a destra: rientrata e finita entro pochi caratteri dalla fine della linea del riquadro
  // (Claude Code 2.1.28x lascia 2 colonne di margine)
  const ruleEnd = [...screen[box.top].replace(/\s+$/, '')].length;
  if (indent < 4 || [...raw].length < ruleEnd - 4) return null;
  const m = EFFORT_INDICATOR.exec(text);
  return m ? { level: m[1] as EffortLevel, ultracode: Boolean(m[2]) } : null;
}
