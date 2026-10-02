import type { HistoryResponse, HistoryState } from '../shared/protocol';
import { t } from './i18n';
import { $, toast } from './ui';

/**
 * Annulla e Ripeti per le modifiche ai file del progetto (di solito fatte da Claude Code dopo
 * una richiesta partita da Studio). I file li ripristina il companion, da fotografie tenute in
 * un archivio suo: il repository del progetto non viene toccato.
 */
export class CodeHistory {
  private readonly undoButton = $('code-undo') as HTMLButtonElement;
  private readonly redoButton = $('code-redo') as HTMLButtonElement;
  private busy = false;
  private state: HistoryState;

  constructor(
    initial: HistoryState,
    private readonly authHeaders: () => Record<string, string>,
  ) {
    this.state = initial;
    this.undoButton.addEventListener('click', () => void this.act('undo'));
    this.redoButton.addEventListener('click', () => void this.act('redo'));
    this.render();
  }

  update(state: HistoryState): void {
    this.state = state;
    this.render();
  }

  private render(): void {
    const s = this.state;
    // Senza git su questo computer i pulsanti restano visibili ma spenti, con il motivo
    $('history').hidden = false;
    this.undoButton.disabled = this.busy || !s.canUndo;
    this.redoButton.disabled = this.busy || !s.canRedo;
    this.undoButton.title = !s.available ? s.reason : s.canUndo ? t('history.undoFrom', { label: s.undoLabel }) : t('history.undoNone');
    this.redoButton.title = !s.available ? s.reason : s.canRedo ? t('history.redoOf', { label: s.redoLabel }) : t('topbar.redo.title');
  }

  private async act(action: 'undo' | 'redo'): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try {
      const res = await fetch(`/api/history/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: '{}',
      });
      const body = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as HistoryResponse;
      if (body.history) this.state = body.history;
      if (body.ok) toast(body.message || t('result.done'), 'ok', 5000);
      else toast(body.error || t('result.failed'), 'error', 6500);
    } catch {
      toast(t('result.unreachable'), 'error');
    } finally {
      this.busy = false;
      this.render();
    }
  }
}
