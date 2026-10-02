import type { AnnotationKind, Rect } from '../shared/protocol';
import { t } from './i18n';
import { $, isMac } from './ui';

export interface CommentBoxRequest {
  mode: 'new' | 'edit';
  kind: AnnotationKind;
  label: string;
  /** Zona annotata in coordinate dell'app (viewport della pagina o pixel della finestra). */
  rect: Rect;
  canAdjust: boolean;
  comment: string;
  onSave(text: string, sendAfter: boolean): void;
  onCancel(): void;
  onDelete?(): void;
  onAdjust?(dir: 'parent' | 'child'): void;
}

/**
 * Casella del commento. Sta nella pagina Studio (non nell'app): così il testo che arriva a
 * Claude lo scrive sempre l'utente, e gli script dell'app non possono né leggerlo né inviarlo
 * (all'overlay nell'app arrivano le annotazioni senza il testo: vedi forAppOverlay).
 */
export class CommentBox {
  private readonly el = $('cbox');
  private readonly textarea = $('cbox-text') as HTMLTextAreaElement;
  private request: CommentBoxRequest | null = null;
  private rect: Rect | null = null;
  /** Converte una zona dalle coordinate dell'app (iframe, copia dal vivo, immagine) a quelle dello stage. */
  locate: (rect: Rect) => Rect = (rect) => rect;

  constructor() {
    $('cbox-save').addEventListener('click', () => this.save(false));
    $('cbox-cancel').addEventListener('click', () => this.cancel());
    $('cbox-delete').addEventListener('click', () => {
      const req = this.request;
      this.close();
      req?.onDelete?.();
    });
    this.el.querySelectorAll<HTMLButtonElement>('[data-adjust]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.request?.onAdjust?.(btn.dataset.adjust as 'parent' | 'child');
        this.textarea.focus();
      });
    });
    $('cbox-hint').textContent = t('cbox.hint', { mod: isMac ? '⌘' : 'Ctrl' });
    this.textarea.addEventListener('input', () => {
      this.textarea.classList.remove('invalid');
      this.textarea.style.height = 'auto';
      this.textarea.style.height = `${Math.min(220, this.textarea.scrollHeight + 2)}px`;
    });
    this.textarea.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Enter' && mod) {
        e.preventDefault();
        this.save(true);
      } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.save(false);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.cancel();
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && (e.altKey || !this.textarea.value) && this.request?.canAdjust) {
        e.preventDefault();
        this.request.onAdjust?.(e.key === 'ArrowUp' ? 'parent' : 'child');
      }
    });
    new ResizeObserver(() => this.place()).observe($('stage'));
  }

  get isOpen(): boolean {
    return this.request !== null;
  }

  get text(): string {
    return this.textarea.value.trim();
  }

  open(request: CommentBoxRequest): void {
    this.request = request;
    $('cbox-kind').textContent = t(`kind.${request.kind}`);
    $('cbox-target').textContent = request.label;
    $('cbox-nav').hidden = !request.canAdjust;
    $('cbox-delete').hidden = request.mode !== 'edit';
    this.textarea.value = request.comment;
    this.textarea.classList.remove('invalid');
    this.textarea.style.height = 'auto';
    this.el.hidden = false;
    this.update(request.label, request.rect);
    this.textarea.focus({ preventScroll: true });
  }

  /** Nuova posizione o etichetta della zona (scroll nell'app, genitore/figlio). */
  update(label: string, rect: Rect): void {
    if (!this.request) return;
    $('cbox-target').textContent = label;
    this.rect = rect;
    this.place();
  }

  close(): void {
    this.request = null;
    this.rect = null;
    this.el.hidden = true;
    // Il focus torna al pannello dell'app: S, R, D, Esc e Ctrl+Invio restano disponibili.
    $('pane-app').focus({ preventScroll: true });
  }

  /** Salva se c'è testo, altrimenti annulla (usato quando si passa ad altro). */
  resolve(): void {
    if (!this.request) return;
    if (this.text) this.save(false);
    else this.cancel();
  }

  private save(sendAfter: boolean): void {
    const req = this.request;
    if (!req) return;
    const text = this.text;
    if (!text) {
      if (sendAfter && req.mode === 'new') {
        this.cancel();
        req.onSave('', true);
        return;
      }
      this.textarea.classList.add('invalid');
      this.textarea.focus();
      return;
    }
    this.close();
    req.onSave(text, sendAfter);
  }

  private cancel(): void {
    const req = this.request;
    this.close();
    req?.onCancel();
  }

  /** Mette la casella accanto alla zona annotata (convertita nelle coordinate dello stage). */
  private place(): void {
    if (!this.request || !this.rect) return;
    const stage = $('stage').getBoundingClientRect();
    const r = this.locate(this.rect);
    const W = this.el.offsetWidth || 300;
    const H = this.el.offsetHeight || 190;
    const gap = 12;
    let x = r.x + r.width + gap;
    let y = r.y;
    if (x + W > stage.width - 8) {
      x = r.x - W - gap;
      if (x < 8) {
        x = Math.min(Math.max(8, r.x), stage.width - W - 8);
        y = r.y + r.height + gap + H <= stage.height - 8 ? r.y + r.height + gap : r.y - H - gap;
      }
    }
    x = Math.max(8, Math.min(stage.width - W - 8, x));
    y = Math.max(8, Math.min(stage.height - H - 8, y));
    this.el.style.left = `${x}px`;
    this.el.style.top = `${y}px`;
  }
}
