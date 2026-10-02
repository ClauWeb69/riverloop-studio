// Piccoli aiuti per il DOM della pagina Studio.
export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Elemento #${id} mancante`);
  return el;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'range', 'color'].includes(type);
  }
  return false;
}

let toastRoot: HTMLElement | null = null;

export function toast(message: string, kind: 'info' | 'ok' | 'error' = 'info', ms = 3800): void {
  toastRoot ??= document.getElementById('toasts');
  if (!toastRoot) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  toastRoot.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, ms);
}

export function showFatal(title: string, message: string): void {
  const root = document.getElementById('fatal');
  if (!root) return;
  root.innerHTML = `<div class="fatal-card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div>`;
  root.hidden = false;
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
