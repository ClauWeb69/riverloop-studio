import type { SuggestionInfo, SuggestionsResponse } from '../shared/protocol';
import { t } from './i18n';
import { $, toast } from './ui';

export interface SuggestionsHooks {
  authHeaders(): Record<string, string>;
  /** Sessione di Claude Code che riceve la richiesta (scheda attiva) e il suo nome. */
  target(): { id: string; name: string };
  /** Dopo l'invio (o se Claude aspetta una risposta) il focus va alla console. */
  focusConsole(): void;
}

/**
 * Suggerimenti per il progetto: cose da cambiare nella sua configurazione perché Studio funzioni
 * meglio (plugin di file e riga, porta fissa nello script dev, .gitignore). Studio non le cambia
 * da sé: le mostra in un riquadro e, con un clic, manda la richiesta a Claude Code. Il testo
 * della richiesta lo decide il companion e si può leggere prima di cliccare.
 */
export class Suggestions {
  private list: SuggestionInfo[] = [];
  /** Aperto dal pulsante: mostra anche quelli rimandati con "Non ora". */
  private manual = false;
  private busy = false;
  private readonly box = $('suggest');
  private readonly button = $('btn-suggest');

  constructor(private readonly hooks: SuggestionsHooks) {
    this.button.addEventListener('click', () => {
      if (!this.box.hidden) return this.close();
      this.manual = true;
      this.render();
    });
    $('suggest-close').addEventListener('click', () => void this.dismiss(false));
    $('suggest-later').addEventListener('click', () => void this.dismiss(false));
    $('suggest-never').addEventListener('click', () => void this.dismiss(true));
    $('suggest-apply').addEventListener('click', () => void this.apply());
    this.box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        void this.dismiss(false);
      }
    });
  }

  /** Chiede al companion i suggerimenti validi adesso e, se ce ne sono di nuovi, apre il riquadro. */
  async refresh(): Promise<void> {
    try {
      const res = await fetch('/api/suggestions', { headers: this.hooks.authHeaders(), cache: 'no-store' });
      const body = (await res.json()) as SuggestionsResponse;
      if (res.ok && body.ok) this.update(body.suggestions ?? []);
    } catch {
      /* Studio non raggiungibile: nessun suggerimento */
    }
  }

  private update(list: SuggestionInfo[]): void {
    this.list = list;
    this.render();
  }

  /** Quelli da mostrare: tutti se il riquadro è stato aperto a mano, altrimenti solo i non rimandati. */
  private visible(): SuggestionInfo[] {
    return this.manual ? this.list : this.list.filter((s) => !s.snoozed);
  }

  private close(): void {
    this.manual = false;
    this.box.hidden = true;
  }

  private render(): void {
    this.button.hidden = this.list.length === 0;
    $('suggest-count').textContent = String(this.list.length);
    const visible = this.visible();
    const current = visible[0];
    if (!current) {
      this.close();
      return;
    }
    $('suggest-title').textContent = current.title;
    $('suggest-detail').textContent = current.detail;
    $('suggest-text').textContent = current.prompt;
    $('suggest-pos').textContent = visible.length > 1 ? t('suggest.pos', { count: visible.length }) : '';
    ($('suggest-apply') as HTMLButtonElement).textContent = t('suggest.applyTo', { name: this.hooks.target().name });
    this.box.dataset.id = current.id;
    this.box.hidden = false;
  }

  private async post(path: string, payload: Record<string, unknown>): Promise<SuggestionsResponse> {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.hooks.authHeaders() },
      body: JSON.stringify(payload),
    });
    return (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as SuggestionsResponse;
  }

  /** Un clic: la richiesta va a Claude Code, nella scheda attiva della console. */
  private async apply(): Promise<void> {
    const id = this.box.dataset.id;
    if (!id || this.busy) return;
    this.busy = true;
    const button = $('suggest-apply') as HTMLButtonElement;
    button.disabled = true;
    const target = this.hooks.target();
    try {
      const body = await this.post('/api/suggestions/apply', { id, session: target.id });
      if (!body.ok) {
        if (body.code === 'awaiting-answer') this.hooks.focusConsole();
        toast(body.error || t('suggest.notSent'), 'error', 6500);
        return;
      }
      toast(t('suggest.sent', { name: target.name }), 'ok', 5000);
      this.update(body.suggestions ?? []);
      this.hooks.focusConsole();
    } catch {
      toast(t('suggest.unreachable'), 'error');
    } finally {
      this.busy = false;
      button.disabled = false;
    }
  }

  /** "Non ora" (resta disponibile dal pulsante) oppure "Non chiedere più" (salvato per il progetto). */
  private async dismiss(forever: boolean): Promise<void> {
    const id = this.box.dataset.id;
    if (!id || this.busy) return;
    // Aperto a mano e chiuso con "Non ora": si chiude il riquadro, senza passare al successivo
    if (!forever && this.manual) return this.close();
    try {
      const body = await this.post('/api/suggestions/dismiss', { id, forever });
      if (body.ok) this.update(body.suggestions ?? []);
      else this.close();
    } catch {
      this.close();
    }
  }
}
