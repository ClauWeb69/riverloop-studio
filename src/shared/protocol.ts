// Tipi e messaggi condivisi tra companion (Node), pagina Studio e overlay.
// Questo file contiene solo tipi e costanti: viene compilato sia da tsc (server) sia da Vite.

import type { Locale } from './i18n.js';

/** Marcatore presente in ogni postMessage tra overlay e pagina Studio. */
export const MESSAGE_SOURCE = 'riverloop-studio';

/** Tipo di app annotata: pagina web nell'iframe, finestra nativa catturata, app Electron/Chromium via CDP. */
export type AppMode = 'web' | 'window' | 'electron';

export type ToolMode = 'navigate' | 'select' | 'area' | 'draw';
export type AnnotationKind = 'element' | 'area' | 'drawing';
export type AnnotationStatus = 'pending' | 'sending' | 'sent' | 'error';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewportInfo {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  dpr: number;
}

/** Riassunto di un elemento contenuto in una zona o toccato da un disegno. */
export interface ElementSummary {
  label: string;
  selector: string;
  text?: string;
}

/** Elemento dell'interfaccia di un'app nativa (accessibilità del sistema: UI Automation su Windows). */
export interface NativeElement {
  /** Tipo di controllo (Button, Edit, ListItem...). */
  role: string;
  name: string;
  automationId: string;
  className: string;
  /** Toolkit dichiarato dall'app (WPF, WinForm, Win32, XAML, Qt...). */
  framework: string;
  /** Catena dei contenitori, dal più esterno (es. ["Window «Clienti»", "ToolBar"]). */
  path: string[];
  /** Posizione nella finestra catturata, in pixel dell'immagine. */
  rect: Rect;
}

/** Controllo nativo in breve (elenco "Contiene" delle zone sulle finestre native). */
export interface NativeSummary {
  role: string;
  name: string;
  automationId: string;
}

/** Ancoraggio usato per ridisegnare un'annotazione dopo scroll, HMR o ricaricamento. */
export interface AnchorInfo {
  selector: string | null;
  /** Posizione della zona rispetto all'angolo in alto a sinistra dell'elemento di ancoraggio. */
  offsetX: number;
  offsetY: number;
}

/** Dati raccolti dall'overlay per ogni annotazione (senza screenshot). */
export interface AnnotationCapture {
  kind: AnnotationKind;
  comment: string;
  url: string;
  title: string;
  viewport: ViewportInfo;
  selector: string | null;
  label: string | null;
  html: string | null;
  text: string | null;
  styles: Record<string, string> | null;
  /** Posizione nel documento (px CSS, include lo scroll). */
  rect: Rect;
  /** Posizione nella viewport al momento dell'annotazione. */
  viewportRect: Rect;
  contains?: ElementSummary[];
  /** Zone e disegni: l'elemento più piccolo che contiene tutta la zona (null = la pagina intera). */
  container?: ElementSummary | null;
  /** Zone e disegni: il titolo (h1–h6) più vicino sopra la zona, per orientarsi nella pagina. */
  heading?: string | null;
  source?: string | null;
  components?: string[];
  /** Solo per i disegni: punti del tratto relativi a rect.x / rect.y. */
  path?: Array<[number, number]>;
  anchor: AnchorInfo;
  /**
   * Dove è stata fatta l'annotazione: 'page' (app web, default), 'electron' (pagina di un'app
   * desktop Chromium) oppure 'window' (immagine di una finestra nativa: le coordinate sono in
   * pixel della finestra, senza DOM).
   */
  surface?: 'page' | 'electron' | 'window';
  /** Modalità window: elemento dell'interfaccia nativa sotto l'annotazione, se riconosciuto. */
  native?: NativeElement | null;
}

export interface AnnotationData extends AnnotationCapture {
  /** Finestre native: righe del progetto dove compare il controllo ("file:riga"), trovate dal companion. */
  sources?: string[];
  id: number;
  /** data:image/png;base64,... oppure null se la cattura non è riuscita. */
  screenshot: string | null;
  screenshotError?: string | null;
  /** Modalità window: immagine della finestra intera a cui appartiene (vedi AnnotationRequest.contexts). */
  context?: string | null;
}

/** Immagine della finestra intera con le annotazioni evidenziate (modalità window). */
export interface AnnotationContext {
  id: string;
  /** data:image/png;base64,... */
  image: string;
}

/** Vista minima usata dall'overlay per ridisegnare badge e contorni. */
export interface AnnotationView {
  id: number;
  kind: AnnotationKind;
  status: AnnotationStatus;
  comment: string;
  url: string;
  selector: string | null;
  anchor: AnchorInfo;
  rect: Rect;
  path?: Array<[number, number]>;
}

// ---------------------------------------------------------------------------
// Overlay (iframe dell'app) → pagina Studio
//
// L'overlay vive nell'origine dell'app, quindi i suoi messaggi non sono fidati: il commento
// si scrive nella pagina Studio e l'invio parte solo da un gesto fatto nella pagina Studio.
// ---------------------------------------------------------------------------
export interface DraftInfo {
  localId: string;
  kind: AnnotationKind;
  /** Descrizione breve del bersaglio (es. "h1.hero 640×72"). */
  label: string;
  /** Zona in coordinate della viewport dell'iframe. */
  rect: Rect;
  /** Per gli elementi: si può passare al genitore o al figlio. */
  canAdjust: boolean;
}

export type OverlayToPage =
  | { type: 'ready'; url: string; title: string }
  | { type: 'location'; url: string; title: string }
  | { type: 'mode'; mode: ToolMode }
  | ({ type: 'draft:open' } & DraftInfo)
  | ({ type: 'draft:update' } & DraftInfo)
  | { type: 'draft:closed'; localId: string }
  | { type: 'annotation:create'; localId: string; data: AnnotationCapture }
  /** context (finestre native): immagine della finestra intera su cui è stata fatta l'annotazione. */
  | { type: 'annotation:screenshot'; id: number; screenshot: string | null; error?: string | null; context?: string }
  | { type: 'annotation:edit'; id: number; rect: Rect }
  | { type: 'send' }
  | { type: 'undo' };

// ---------------------------------------------------------------------------
// Pagina Studio → overlay
// ---------------------------------------------------------------------------
export type PageToOverlay =
  | { type: 'hello'; mode: ToolMode; annotations: AnnotationView[]; locale?: Locale }
  | { type: 'mode'; mode: ToolMode }
  | { type: 'draft:commit'; localId: string }
  | { type: 'draft:cancel'; localId: string }
  | { type: 'draft:adjust'; localId: string; dir: 'parent' | 'child' }
  | { type: 'annotation:assigned'; localId: string; id: number }
  | { type: 'annotation:update'; id: number; comment: string }
  | { type: 'annotations:sync'; annotations: AnnotationView[] }
  | { type: 'annotation:remove'; id: number }
  | { type: 'annotation:status'; ids: number[]; status: AnnotationStatus }
  | { type: 'annotation:focus'; id: number }
  | { type: 'nav'; action: 'back' | 'forward' | 'reload' };

export type Envelope<T> = T & { source: typeof MESSAGE_SOURCE };

// ---------------------------------------------------------------------------
// Pagina Studio ↔ companion
// ---------------------------------------------------------------------------
export interface AnnotationRequest {
  autoSend: boolean;
  /** Sessione di Claude Code che riceve le annotazioni (scheda attiva della console). */
  session?: string;
  annotations: AnnotationData[];
  contexts?: AnnotationContext[];
}

export interface AnnotationResponse {
  ok: boolean;
  error?: string;
  /** awaiting-answer: Claude Code mostra una richiesta di permesso o un menu e aspetta l'utente. */
  code?: 'awaiting-answer' | 'not-running';
  prompt?: string;
  json?: string;
  files?: string[];
}

export type DevServerState = 'starting' | 'running' | 'exited' | 'external' | 'unreachable' | 'disabled';

export interface DevServerStatus {
  state: DevServerState;
  port: number;
  managed: boolean;
  command: string | null;
  exitCode?: number | null;
  log: string[];
}

export type ClaudeState = 'idle' | 'running' | 'exited';

export interface StudioConfig {
  /** Tipo di app: decide il pannello di sinistra (iframe, finestra catturata, app via CDP). */
  mode: AppMode;
  /** Modalità desktop: riavvia l'app quando Claude Code finisce una risposta con modifiche. */
  restartOnIdle: boolean;
  version: string;
  project: string;
  platform: string;
  studioPort: number;
  proxyPort: number;
  devPort: number;
  autoSend: boolean;
  /** Primo numero libero per le annotazioni di questa sessione. */
  nextAnnotationId: number;
  /** Build di Windows (per xterm.js con ConPTY), null sugli altri sistemi. */
  windowsBuild: number | null;
  devServer: DevServerStatus;
  /** Sessioni di Claude Code aperte in questo progetto (schede della console). */
  sessions: SessionInfo[];
  /** Permessi con cui partono le nuove sessioni. */
  permissions: PermissionsMode;
  /** Studio gira come root (Linux/macOS): Claude Code rifiuta --dangerously-skip-permissions. */
  runningAsRoot: boolean;
  history: HistoryState;
  /** Lingua dell'interfaccia e delle richieste a Claude Code. */
  locale: Locale;
  /** true se la lingua è stata scelta (pagina, --lang, variabile d'ambiente); false se è quella del sistema. */
  localeChosen: boolean;
}

/** Modalità dei permessi di Claude Code (quelle che si scorrono con Shift+Tab). */
export type PermissionModeName = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions' | 'dontAsk';

/** Modelli proposti nella pagina (alias di Claude Code per /model). */
export const CLAUDE_MODELS = ['default', 'opus', 'sonnet', 'haiku', 'fable'] as const;
/** Livelli di effort proposti nella pagina (valori di /effort). */
export const CLAUDE_EFFORTS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
/** Modalità che la pagina può chiedere (dontAsk si sceglie solo all'avvio di Claude Code). */
export const CLAUDE_MODES: readonly PermissionModeName[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];

/** Utilizzo del piano in una finestra di tempo (status line di Claude Code). */
export interface UsageWindow {
  /** Percentuale usata, 0-100. */
  used: number;
  /** Quando si azzera (secondi Unix), se noto. */
  resetsAt: number | null;
}

/**
 * Stato di una sessione di Claude Code: modello, effort e utilizzo arrivano dalla status line
 * (il JSON che Claude Code passa al suo comando), la modalità dal testo in fondo allo schermo,
 * effort e ultracode anche dall'indicatore sopra il riquadro di input (subito, a ogni modifica).
 * null = non ancora noto.
 */
export interface ClaudeStatus {
  model: string | null;
  modelId: string | null;
  effort: string | null;
  /**
   * Ultracode (/effort ultracode on|off, solo per la sessione): non è nel JSON della status line,
   * si legge dall'indicatore dell'effort sopra il riquadro di input.
   */
  ultracode: boolean | null;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  /** Contesto usato, percentuale. */
  context: number | null;
  costUsd: number | null;
  mode: PermissionModeName | null;
}

/** Azione chiesta dalla pagina su una sessione di Claude Code (POST /api/claude). */
export type ClaudeAction =
  | { action: 'model'; value: (typeof CLAUDE_MODELS)[number] }
  | { action: 'effort'; value: (typeof CLAUDE_EFFORTS)[number] }
  | { action: 'ultracode'; value: boolean }
  | { action: 'goal'; value: string }
  | { action: 'usage' }
  | { action: 'mode'; value: PermissionModeName };

/** Una sessione di Claude Code: un processo claude nella cartella del progetto. */
export interface SessionInfo {
  id: string;
  name: string;
  /** Nome scelto dall'utente (altrimenti è "Claude <n>"). */
  renamed: boolean;
  /** Modello, effort, utilizzo e modalità, per quanto noti. */
  claude: ClaudeStatus;
  state: ClaudeState;
  exitCode: number | null;
  permissions: PermissionsMode;
}

/** Un'istanza di Studio in esecuzione su questo computer (un progetto). */
export interface ProjectInstance {
  pid: number;
  project: string;
  cwd: string;
  /** Link con il token di sessione di quell'istanza. */
  url: string;
  startedAt: number;
  current: boolean;
}

export interface ProjectsResponse {
  ok: boolean;
  error?: string;
  instances?: ProjectInstance[];
  recent?: Array<{ cwd: string; project: string; launch?: { mode?: AppMode } }>;
  /** Separatore dei percorsi sul computer di Studio (per i suggerimenti). */
  sep?: string;
  url?: string;
}

/** Annulla e Ripeti per le modifiche ai file del progetto (pulsanti in alto nella pagina Studio). */
export interface HistoryState {
  /** false se manca git su questo computer (reason dice perché). */
  available: boolean;
  reason: string;
  canUndo: boolean;
  canRedo: boolean;
  /** La richiesta le cui modifiche verrebbero tolte, e quella che verrebbe rimessa. */
  undoLabel: string;
  redoLabel: string;
}

export interface HistoryResponse {
  ok: boolean;
  /** Esito da mostrare all'utente. */
  message?: string;
  error?: string;
  history?: HistoryState;
}

/**
 * Suggerimento per il progetto: una modifica alla sua configurazione che fa funzionare meglio
 * Studio. Studio non la fa da sé: la propone, e con un clic la chiede a Claude Code.
 */
export interface SuggestionInfo {
  id: string;
  title: string;
  detail: string;
  /** Il messaggio che verrà mandato a Claude Code (mostrato prima del clic). */
  prompt: string;
  /** Rimandato con "Non ora": resta disponibile dal pulsante, ma non si ripropone da solo. */
  snoozed?: boolean;
}

export interface SuggestionsResponse {
  ok: boolean;
  error?: string;
  code?: 'awaiting-answer' | 'not-running';
  suggestions?: SuggestionInfo[];
}

/** Messaggi del companion sul canale di controllo /ws/overlay. */
export type ControlMessage =
  /** Stato del dev server (web) o del processo dell'app desktop (window, electron). */
  | { type: 'devserver'; status: DevServerStatus }
  /** Claude Code ha finito una risposta: con restarted=true l'app desktop è stata riavviata. */
  | { type: 'idle'; session: string; restarted: boolean }
  | { type: 'restart-on-idle'; value: boolean }
  | { type: 'history'; history: HistoryState }
  | { type: 'sessions'; sessions: SessionInfo[] }
  /** Invio automatico non confermato: il testo è rimasto nel riquadro di input di Claude Code. */
  | { type: 'autosend'; ok: boolean; session: string; name: string }
  /** Lingua cambiata (da questa o da un'altra pagina Studio): la pagina si ricarica. */
  | { type: 'locale'; locale: Locale }
  /** Studio si sta chiudendo (dalla pagina o dal terminale). */
  | { type: 'shutdown' };

/** Messaggi JSON su /ws/term (l'output del PTY viaggia in frame binari). */
export type PermissionsMode = 'ask' | 'skip';

export type TermClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'restart'; mode: 'continue' | 'resume' | 'new' }
  | { type: 'permissions'; value: PermissionsMode };

export type TermServerMessage =
  | { type: 'hello'; cols: number; rows: number; state: ClaudeState; exitCode: number | null; permissions: PermissionsMode }
  | { type: 'started' }
  | { type: 'size'; cols: number; rows: number }
  | { type: 'permissions'; value: PermissionsMode }
  | { type: 'exit'; code: number | null };

// ---------------------------------------------------------------------------
// App desktop (modalità window ed electron): canale /ws/app tra pagina Studio e companion.
// I fotogrammi viaggiano in frame binari, ognuno preceduto dal messaggio 'frame' con i dati.
// ---------------------------------------------------------------------------
export interface AppWindowInfo {
  id: string;
  title: string;
  /** Electron: URL della pagina mostrata dalla finestra. */
  url?: string;
}

export type AppViewState =
  /** L'app non è ancora pronta (in avvio, nessuna finestra trovata). */
  | 'waiting'
  | 'live'
  /** La finestra esiste ma non è visibile (ridotta a icona, nascosta): niente fotogrammi. */
  | 'hidden'
  /** La cattura dal sistema non è disponibile: la finestra va condivisa dal browser. */
  | 'unsupported';

export interface AppView {
  state: AppViewState;
  /** Spiegazione per l'utente quando lo stato non è 'live'. */
  message: string;
  windows: AppWindowInfo[];
  current: string | null;
  title: string;
  url: string;
  /** Dimensione logica della vista: px CSS della pagina (electron) o px della finestra (window). */
  width: number;
  height: number;
  /** Pixel dell'immagine per ogni px logico. */
  scale: number;
  /** L'overlay è attivo nella pagina dell'app (electron). */
  overlay: boolean;
  /** Modalità window: Studio riconosce gli elementi dell'interfaccia nativa (strumento Elemento). */
  elements: boolean;
}

export interface FrameMeta {
  seq: number;
  format: 'jpeg' | 'png';
  /** Fermo immagine a piena risoluzione chiesto dalla pagina (modalità window). */
  still?: number;
  width: number;
  height: number;
}

/** Bit dei tasti modificatori, come nel protocollo DevTools. */
export const MOD_ALT = 1;
export const MOD_CTRL = 2;
export const MOD_META = 4;
export const MOD_SHIFT = 8;

export type AppClientMessage =
  /** Dimensione del pannello in pixel fisici: i fotogrammi non servono più grandi. */
  | { type: 'viewport'; width: number; height: number }
  | { type: 'select'; id: string }
  /** Riporta visibile una finestra ridotta a icona, senza darle il focus. */
  | { type: 'show' }
  /** Porta la finestra dell'app in primo piano. */
  | { type: 'activate' }
  | { type: 'restart' }
  // --- electron ---
  | { type: 'overlay'; msg: PageToOverlay }
  | { type: 'mouse'; action: 'move' | 'down' | 'up'; x: number; y: number; button: number; buttons: number; clicks: number; mods: number }
  | { type: 'wheel'; x: number; y: number; dx: number; dy: number; mods: number }
  | { type: 'key'; action: 'down' | 'up'; key: string; code: string; keyCode: number; mods: number; repeat: boolean; location: number }
  | { type: 'text'; text: string }
  | { type: 'nav'; action: 'back' | 'forward' | 'reload' }
  // --- window ---
  /** Anteprima dal vivo attiva (pannello visibile) o in pausa. */
  | { type: 'live'; on: boolean }
  | { type: 'still'; req: number }
  | { type: 'element'; req: number; x: number; y: number }
  | { type: 'elementsIn'; req: number; rect: Rect };

export type AppServerMessage =
  | { type: 'view'; view: AppView }
  | { type: 'frame'; meta: FrameMeta }
  | { type: 'overlay'; msg: OverlayToPage }
  | { type: 'still'; req: number; ok: boolean; error?: string }
  | { type: 'element'; req: number; element: NativeElement | null }
  | { type: 'elementsIn'; req: number; items: NativeSummary[] };
