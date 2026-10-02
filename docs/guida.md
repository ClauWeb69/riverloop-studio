[English](guide.md) | Italiano

# Riverloop Studio

Lanciato dalla cartella di un progetto, apre una pagina locale con l'app in sviluppo da un lato e la **console originale di Claude Code** dall'altro. Segni sull'app cosa cambiare (un elemento, un riquadro o un disegno), scrivi un commento, e l'annotazione arriva a Claude Code come messaggio nella stessa sessione.

> Progetto indipendente, non affiliato né approvato da Anthropic. Claude e Claude Code sono marchi di Anthropic.

L'app può essere di tre tipi:

- **web** (default): il dev server del progetto, mostrato in un iframe;
- **electron**: un'app Electron, o un'altra app desktop basata su Chromium (WebView2, quindi anche Tauri su Windows), mostrata dal vivo e usabile dalla pagina;
- **window**: una finestra nativa qualunque (WPF, Windows Forms, Qt, Flutter…), di cui Studio mostra l'immagine.

Puoi tenere aperte più sessioni di Claude nello stesso progetto (schede della console, anche in finestre diverse) e aprire, passare e chiudere altri progetti dalla pagina.

## Indice

- [Sistemi supportati](#sistemi-supportati)
- [Requisiti](#requisiti)
- [Installazione](#installazione)
- [Uso](#uso)
- [La pagina Studio](#la-pagina-studio)
- [App desktop](#app-desktop)
- [File e riga esatti](#file-e-riga-esatti)
- [Lingua](#lingua)
- [Compatibilità con Claude Code](#compatibilità-con-claude-code)
- [Sicurezza](#sicurezza)
- [Come funziona](#come-funziona)
- [Note per sistema](#note-per-sistema)
- [Limiti noti](#limiti-noti)
- [Roadmap](#roadmap)
- [Sviluppo e test](#sviluppo-e-test)
- [Struttura del progetto](#struttura-del-progetto)
- [Licenza](#licenza)

## Sistemi supportati

| Modalità | Windows 11 | Linux | macOS |
|---|---|---|---|
| `web` | Verificata | Verificata | Non provata |
| `electron` | Verificata | **Sperimentale** | **Sperimentale** |
| `window` | Verificata | **Sperimentale** | **Sperimentale** |

Le modalità desktop (`electron`, `window`) sono verificate solo su Windows 11. Su macOS e Linux il codice per la cattura delle finestre, l'aggancio di Electron e la chiusura dell'app è scritto ma **non è mai stato eseguito**: aspettati problemi, e segnalali. La modalità web non è ancora stata provata su macOS.

## Requisiti

- Node.js 20 o successivo (consigliato 22 LTS).
- Claude Code installato e già autenticato (`claude --version` deve rispondere).
- Un browser basato su Chromium (Chrome, Edge) o Firefox. Le scorciatoie Ctrl+W, Ctrl+T e Ctrl+N arrivano a Claude solo in Chrome ed Edge, a schermo intero.
- `git` installato, per [Annulla e Ripeti](#annulla-e-ripeti-delle-modifiche) (il progetto non deve per forza essere un repository git).
- Per le app desktop non serve altro su Windows. Su macOS la modalità `window` usa `screencapture` (serve il permesso "Registrazione schermo" per il terminale); su Linux con X11 usa `wmctrl` e ImageMagick (`sudo apt install wmctrl imagemagick`). Dove la cattura non è possibile (Wayland) la finestra si condivide dal browser.

## Installazione

```bash
npm install -g riverloop-studio@latest
# oppure, senza installare
npx riverloop-studio@latest
```

Dal sorgente:

```bash
cd riverloop-studio
npm install        # installa le dipendenze e compila (script "prepare")
npm link           # rende disponibile il comando riverloop-studio
```

Su Windows esegui gli stessi comandi da PowerShell o dal Prompt dei comandi. Su WSL eseguili dentro WSL, dove gira anche il progetto.

**node-pty** è un modulo nativo. Se non c'è un binario precompilato adatto al tuo sistema, npm lo compila, e servono gli strumenti di build:

- Windows: Visual Studio Build Tools;
- macOS: Xcode Command Line Tools (`xcode-select --install`);
- Linux: `python3`, `make` e `g++` (es. `sudo apt install build-essential python3`).

Se `node-pty` non si carica, Studio ripiega sul fork `@lydell/node-pty`, che ha binari precompilati per più sistemi (Linux compreso). Se l'installazione segnala errori di compilazione e Studio non parte, installa gli strumenti di build e ripeti l'installazione.

Da npm 11 in poi può comparire l'avviso che `node-pty` ha script di installazione "not yet covered by allowScripts": si può ignorare. Senza il suo script `node-pty` usa i binari precompilati (Windows, macOS), e altrove Studio ripiega su `@lydell/node-pty`. Verificato su Windows 11 con npm 11.17.

## Uso

```bash
cd il-mio-progetto-next
riverloop-studio
```

Cosa succede:

1. Studio controlla i prerequisiti.
2. Al primo avvio propone di aggiungere `.claude/studio/` al `.gitignore`.
3. Avvia `npm run dev` sulla porta 3000. Se la porta è occupata (da un'altra app o da un'altra sessione di Studio), avvia comunque il dev server del progetto sulla prima porta libera successiva. Studio non si aggancia mai a un server che non ha avviato lui: per quello c'è `--no-dev`.
4. Apre il browser sul link con il token di sessione.
5. Claude Code parte quando la pagina si collega, già alla misura del pannello.

Ctrl+C nel terminale di avvio chiude, nell'ordine, Claude Code, il dev server e il companion, senza lasciare processi orfani.

### Più sessioni di Claude e più progetti

**Più sessioni nello stesso progetto**

- Il **+** nella testata della console apre un'altra sessione di Claude Code nella cartella del progetto: "Nuova sessione" oppure "Riprendi una conversazione…" (`claude --resume`). Fino a 8 sessioni per progetto.
- Ogni scheda è un processo `claude` separato, con la sua conversazione e i suoi permessi. Il pallino indica lo stato: verde attiva, giallo in avvio, grigio terminata. Il bordo arancione indica "senza conferme".
- Le annotazioni vanno alla scheda attiva; il suggerimento del pulsante Invia la indica.
- "Riprendi" dopo un'uscita e il cambio dei permessi riprendono la conversazione *di quella scheda* (`claude --resume <id>`), non l'ultima della cartella, che potrebbe essere di un'altra scheda. Studio la legge da `~/.claude/sessions/` (o da `CLAUDE_CONFIG_DIR`), dove Claude Code la tiene aggiornata anche dopo `/clear`.
- La **×** chiude la scheda (con un secondo clic di conferma) e ferma il suo processo. La conversazione resta tra quelle da riprendere.
- **Rinominare una scheda**: doppio clic sul nome (o F2), per esempio una sessione per i bug e una per l'interfaccia. Invio salva, Esc annulla, un nome vuoto torna a "Claude 2". Il nome è legato alla conversazione di Claude Code: riprendendola, in questo o in un altro avvio, la scheda ritrova il suo nome (salvato in `.claude/studio/state.json` del progetto).

**Una sessione per finestra**

- "Apri questa sessione in una nuova finestra" (menu del **+**) apre la stessa pagina con `?s=2`, per esempio su un secondo schermo.
- Ogni finestra mostra la sua sessione e la sua app. Tutte vedono le stesse schede e le stesse modifiche.
- Ricaricando, una finestra resta sulla sua scheda.

**Più progetti**

- Ogni progetto ha la sua istanza di Studio. Puoi lanciare `riverloop-studio` in ogni cartella oppure fare tutto dalla pagina.
- Il nome del progetto in alto a sinistra apre il menu **Progetti**:
  - elenca le istanze di Studio aperte su questo computer;
  - **Apri** la porta in una nuova scheda del browser;
  - **Chiudi** ferma Claude Code, il dev server e Studio di quel progetto, come Ctrl+C (secondo clic di conferma);
  - **Apri un altro progetto**: scrivi il percorso della cartella (o scegli tra i recenti). Studio parte in background in quella cartella, con il suo dev server e il suo Claude Code, e si apre in una nuova scheda. Se quel progetto è già aperto, si apre quello.
- Le istanze avviate dalla pagina non hanno un terminale: si chiudono dal menu Progetti. Il loro log è nella sottocartella `logs` della cartella di lavoro di Studio (vedi sotto).
- Ogni istanza usa porte proprie: pagina Studio (4700, 4702, …), proxy (la successiva) e dev server (3000, 3001, …). Una porta usata una volta per il proxy di un'app non viene mai usata per una pagina Studio, e viceversa (vedi Sicurezza).
- **Aprire un progetto dal menu lo riavvia come l'ultima volta**: modalità, comando dell'app o del dev server, porta, titolo della finestra. Un'app desktop si riapre come app desktop. I progetti recenti mostrano la modalità accanto al nome. Queste opzioni sono ricordate per l'utente (`recent.json` nella cartella di configurazione, vedi [Lingua](#lingua)), mai nel progetto.
- Le porte vengono prenotate con file di lock (sottocartella `ports`), così due sessioni avviate insieme non scelgono la stessa porta. I lock di sessioni chiuse vengono ignorati e rimossi.
- La cartella di lavoro di Studio è privata dell'utente: `%LOCALAPPDATA%\riverloop-studio` su Windows, `~/Library/Caches/riverloop-studio` su macOS, `$XDG_RUNTIME_DIR/riverloop-studio` (o `~/.cache/riverloop-studio`) su Linux. Contiene porte prenotate, progetti aperti e log.
- Se il dev server si ferma subito perché la porta è stata presa da altri nel frattempo (`EADDRINUSE`), Studio lo riavvia su un'altra porta libera e aggiorna l'iframe.
- Il dev server riceve la porta nella variabile `PORT`. Se lo script `dev` fissa la porta (es. `next dev -p 3000`) Studio non può spostarlo e lo segnala: togli `-p` dallo script o lancia Studio con `--port`.

Esempi:

```bash
riverloop-studio --port 5173                      # Vite (la porta viene comunque rilevata dall'output)
riverloop-studio --dev-cmd "pnpm dev" --port 3001
riverloop-studio --no-dev                         # il dev server di questo progetto è già avviato sulla 3000
riverloop-studio --resume --claude-args "--model sonnet"
riverloop-studio --permissions skip               # Claude Code senza richieste di permesso
riverloop-studio --lang it                        # interfaccia e messaggi in italiano per questo avvio

riverloop-studio --mode electron                  # app Electron: avvia "npm run dev" (o "npm start")
riverloop-studio --mode electron --app-cmd "npm run tauri dev"      # Tauri su Windows (WebView2)
riverloop-studio --mode window --app-cmd "dotnet run" --restart-on-idle
riverloop-studio --mode window --no-dev --window-title "Gestionale" # finestra già aperta
```

### Opzioni

| Opzione | Default | Effetto |
|---|---|---|
| `--mode <web\|window\|electron>` | `web` | Tipo di app: dev server web, finestra nativa, app Electron/Chromium. Vedi [App desktop](#app-desktop). |
| `--port <n>` | `3000` | Porta preferita del dev server. Se è occupata Studio usa la prima libera successiva; se il server ne annuncia un'altra all'avvio (Vite), Studio la adotta. |
| `--studio-port <n>` | `4700` | Porta della pagina Studio. Il proxy dell'app usa la successiva libera. |
| `--dev-cmd "<cmd>"` | `npm run dev` | Comando del dev server. Riceve `PORT` e `BROWSER=none`. |
| `--app-cmd "<cmd>"` | `electron`: lo script `dev` o `start` | Comando che avvia l'app desktop. In modalità `window` è obbligatorio (a meno di `--no-dev`). `{port}` nel comando diventa la porta di debug. |
| `--window-title "<testo>"` | – | Modalità `window`: testo contenuto nel titolo della finestra da mostrare. |
| `--cdp-port <n>` | `9222` | Modalità `electron`: porta di debug dell'app. Se è occupata Studio usa la prima libera successiva. |
| `--app-window <background\|normal>` | `background` | Modalità `electron`: finestra dell'app ridotta a icona (l'app si usa dalla pagina Studio) oppure lasciata sul desktop. Vale per le app Electron avviate da Studio. |
| `--restart-on-idle` | scelta salvata, altrimenti off | App desktop: riavvia l'app quando Claude Code finisce una risposta in cui ha modificato qualcosa. |
| `--no-dev` | off | Non avvia il dev server (o l'app desktop) e si aggancia a quello già attivo: sulla `--port`, sulla `--cdp-port` o alla finestra indicata. |
| `--resume` | off | Avvia `claude --resume` invece di una nuova sessione. |
| `--claude-args "<args>"` | – | Argomenti extra per `claude`. |
| `--claude-bin <path>` | `claude` | Eseguibile di Claude Code, se non è nel PATH. |
| `--auto-send` | off | Parte con "Invio automatico" attivo. |
| `--permissions <ask\|skip>` | scelta salvata, altrimenti `ask` | `ask`: permessi standard di Claude Code. `skip`: avvia `claude --dangerously-skip-permissions`. Vale per questo avvio. |
| `--dangerously-skip-permissions` | off | Come `--permissions skip`. |
| `--lang <en\|it>` | vedi [Lingua](#lingua) | Lingua di interfaccia, messaggi nel terminale e prompt, solo per questo avvio. |
| `--no-open` | off | Non apre il browser e stampa solo il link. |
| `--debug` | off | Stampa i dettagli tecnici (porte, invio automatico) utili per segnalare un problema. |

## La pagina Studio

- **Split view**: il divisore si trascina (doppio clic = 60/40) e la proporzione resta salvata. In alto ci sono i pulsanti per invertire i lati o mostrare un solo pannello.
- **Barra dell'URL**: indietro, avanti e ricarica, più un campo percorso (es. `/dashboard`). La barra segue anche la navigazione interna dell'app.
- **Viewport**: Desktop (larghezza piena), Tablet (768 px) e Mobile (390 px). Se il pannello è stretto, l'app viene scalata.
- **Console**: è il vero processo `claude` in uno pseudo-terminale, quindi menu, colori, richieste di permesso e comandi `/` sono identici al terminale.
  - Ricaricando la pagina lo schermo si ripristina e la sessione resta quella.
  - Più schede del browser vedono la stessa sessione.
  - Shift+Invio va a capo.
  - Ctrl+C copia se c'è una selezione, altrimenti interrompe Claude.
  - Ctrl+V incolla testo. Se negli appunti c'è un'immagine, la passa a Claude Code.
  - Il pallino indica la connessione: verde collegato, giallo in riconnessione, rosso disconnesso.
- **Banner del dev server**: se il server si ferma, compaiono le ultime righe di log e il pulsante "Riavvia dev server". La console resta attiva, così puoi chiedere a Claude di sistemare l'errore.
- **Permessi di Claude Code**: il pulsante in alto nella console mostra la modalità e la cambia.
  - **Permessi standard** (default): Claude Code chiede conferma secondo la sua modalità (auto, manuale, accetta modifiche…) e le tue impostazioni. Dentro la console la modalità si cambia come sempre con Maiusc+Tab.
  - **Salta tutte le conferme**: Claude Code viene riavviato con `--dangerously-skip-permissions` e riprende la stessa conversazione. Modifiche e comandi partono senza chiedere: usalo solo su progetti di cui ti fidi. Il pulsante diventa arancione.
  - La scelta resta ricordata per il progetto **solo per il tuo utente** (`projects.json` nella cartella di configurazione), mai nella cartella del progetto: un repository scaricato non può togliere le conferme. Le opzioni `--permissions` e `--dangerously-skip-permissions` valgono solo per l'avvio in cui le usi.
  - In alternativa, con `--claude-args "--allow-dangerously-skip-permissions"` la modalità senza conferme diventa solo disponibile nel ciclo di Maiusc+Tab, senza essere attiva all'avvio.

### La barra di Claude

Sotto le schede della console, una barra mostra e cambia le impostazioni di Claude Code della scheda attiva. Ogni controllo fa esattamente ciò che scriveresti nella console, quindi valgono le regole di Claude Code:

- **Modello**: `default`, `opus`, `sonnet`, `haiku`, `fable` (`/model <nome>`). Claude Code lo salva anche come predefinito per le nuove sessioni.
- **Effort**: automatico, low, medium, high, xhigh, max (`/effort <livello>`). Salvato anche come predefinito. In fondo allo stesso menu si accende o si spegne **ultracode** (`/effort ultracode on|off`): workflow dinamici su ogni attività, solo per questa sessione, con il livello di effort che resta quello scelto. Quando è attivo la barra lo mostra accanto al livello ("Effort: xhigh · ultracode").
- **Modalità**: manuale, accetta modifiche, piano, automatica, e salta permessi quando la scheda gira senza conferme. Studio preme Shift+Tab al posto tuo finché Claude Code non mostra la modalità scelta, e si ferma se non compare.
- **Goal…**: un obiettivo su cui Claude continua a lavorare, una risposta dopo l'altra, finché non è raggiunto (`/goal <condizione>`); "Togli goal" lo toglie.
- **Utilizzo**: quanto del piano è stato usato nelle ultime 5 ore e negli ultimi 7 giorni, e il contesto usato; il suggerimento dice quando i limiti si azzerano. Un clic apre `/usage` nella console. L'utilizzo compare dopo la prima risposta di Claude, e solo con un abbonamento Claude.

Come fa Studio a sapere i valori attuali: modello, effort e utilizzo arrivano dalla **status line** di Claude Code, un JSON che Claude Code passa a un comando a ogni cambiamento. Studio aggiunge il suo comando di status line con `--settings` (come gli hook, senza toccare le tue impostazioni). Se hai già una status line, Studio esegue la tua con gli stessi dati e ne mostra l'output: la tua status line continua a funzionare. La modalità si legge dal testo sotto il riquadro di input ("⏸ manual mode on", "⏵⏵ accept edits on"…), effort e ultracode anche dall'indicatore sopra il riquadro ("◉ xhigh · ultracode · /effort"; ultracode nella status line non c'è). Così la barra segue anche ciò che cambi direttamente nella console: Shift+Tab, `/effort …` e `/model …` scritti nella console compaiono subito nella barra.

I comandi partono solo quando Claude Code mostra il riquadro di input ed è vuoto: con una richiesta di permesso aperta, o con del testo non ancora inviato, la pagina spiega perché e non fa nulla.

### Annotare

| Strumento | Tasto | Come |
|---|---|---|
| Naviga | Esc | Uso normale dell'app. |
| Elemento | S | Passa sopra un elemento (↑ ↓ per genitore e figlio) e fai clic. |
| Riquadro | R | Trascina un rettangolo: vengono registrati posizione, contenitore, titolo più vicino e fino a 10 elementi contenuti. |
| Disegno | D | Traccia a mano libera (sottolinea, cerchia, barra): vengono registrati gli elementi su cui passa. |
| Invia | Ctrl+Invio | Invia le annotazioni in sospeso. |
| Annulla ultima | Ctrl+Z | Rimuove l'ultima annotazione non inviata. |

**Commento**

- Dopo la selezione si apre la casella del commento: Invio salva, Shift+Invio va a capo, Ctrl+Invio salva e invia, Esc annulla.
- Le annotazioni ricevono un numero (badge sulla pagina) e restano ancorate agli elementi durante lo scroll, anche nei contenitori interni.
- Per modificare o eliminare un'annotazione, clicca il suo badge.

**Scorciatoie**

- Valgono quando il focus è sul pannello dell'app.
- Dentro l'app, in modalità Naviga, i tasti restano all'app. Per scegliere lo strumento usa la barra o fai prima clic sulla barra del pannello.

**Il vassoio in basso**

- Elenca le annotazioni con miniatura, stato (in sospeso, inviata) ed eliminazione.
- Mostra l'ultimo messaggio incollato nella console, utile perché Claude Code compatta i testi lunghi in "[Pasted text]".

### Annulla e Ripeti delle modifiche

In alto nella pagina, **Annulla** riporta i file del progetto a com'erano prima dell'ultima richiesta inviata da Studio; **Ripeti** rimette le modifiche. Si può tornare indietro di più richieste, un passo alla volta. Nelle app web l'aggiornamento a caldo mostra subito il risultato; un'app desktop con "Riavvia a fine risposta" attivo viene riavviata.

- **Non serve git nel progetto, e il tuo repository non viene toccato.** Prima di ogni richiesta Studio fotografa i file in un archivio suo, fuori dal progetto (nella cartella di lavoro di Studio): niente commit, niente rami, niente staging. Sul computer deve solo esserci `git` installato, che Studio usa come magazzino.
- Vengono fotografati i file che git seguirebbe: quelli ignorati dal `.gitignore` del progetto (`node_modules`, build, `.env`…) non vengono né salvati né ripristinati.
- Annulla toglie tutto ciò che è cambiato da quel punto in poi, comprese le modifiche fatte a mano o chieste a Claude scrivendo direttamente nella console.
- Dopo un Annulla, se i file vengono modificati di nuovo (da te o da Claude), Ripeti non è più disponibile: rimettere il vecchio stato cancellerebbe quel lavoro.
- Mentre Claude Code sta lavorando, Annulla e Ripeti aspettano: riportare indietro i file a metà di una modifica darebbe un risultato incoerente.
- Alla richiesta successiva Studio avvisa Claude che i file sono cambiati sotto di lui, così li rilegge prima di modificarli.
- La cronologia vale finché Studio resta aperto: alla chiusura l'archivio viene eliminato.

### Suggerimenti per il progetto

Studio non modifica mai i file del progetto per funzionare. Quando vede che una modifica alla configurazione lo farebbe funzionare meglio, la **propone** in un riquadro nell'angolo del pannello dell'app:

- il riquadro dice cosa cambierebbe e perché, e sotto "Cosa verrà chiesto a Claude" mostra il messaggio esatto;
- **Chiedi a Claude Code** manda quel messaggio alla scheda attiva della console, già inviato. La modifica la fa Claude Code, con i suoi permessi (se sono quelli standard, chiede conferma come sempre);
- **Non ora** lo rimanda: resta disponibile dal pulsante con la lampadina in alto;
- **Non chiedere più** lo toglie per questo progetto (la scelta è in `.claude/studio/state.json`).

I suggerimenti di oggi:

| Suggerimento | Quando compare |
|---|---|
| File e riga esatti per ogni elemento | Progetto React con Next.js, Vite o electron-vite senza il plugin nella configurazione (vedi [File e riga esatti](#file-e-riga-esatti)). |
| Lo script `dev` fissa la porta | Next.js con `-p`/`--port` nello script: Studio non può spostare il dev server se la porta è occupata. |
| Annotazioni fuori dal repository | Repository git che non ignora `.claude/studio/` (se non hai già detto di no all'avvio). |

Un suggerimento sparisce da solo quando la modifica è stata fatta. Se Claude Code sta aspettando una tua risposta (richiesta di permesso, menu) la richiesta non viene incollata: prima rispondi nella console.

### Cosa riceve Claude

Studio salva tutto in `.claude/studio/annotations/` e incolla nella console un messaggio breve, con bracketed paste, così gli a capo non lo inviano a metà. Per esempio (il testo esatto dipende dalla [lingua](#lingua)):

```
Modifiche richieste sulla pagina /dashboard (viewport 1440×900):

1. Elemento `main > section.hero > h1` — testo "Benvenuti in AgendaCura"
   Richiesta: rendi il titolo più piccolo e allinealo a sinistra
   Componente React: Hero (dentro HomePage)
   Screenshot: @.claude/studio/annotations/20261001-143512-1.png

2. Zona di 320×180 px (sullo schermo: in basso a destra)
   Posizione nella pagina: x 1000–1320, y 1500–1680 px (sullo schermo x 1050–1370, y 650–830, con la pagina scorsa di 850 px in verticale)
   Si trova: dentro `#prezzi`, sotto il titolo "I nostri prezzi"
   Contiene: `button.cta` "Prenota ora", `p.note`
   Richiesta: il pulsante deve essere verde come quello dell'header
   Screenshot: @.claude/studio/annotations/20261001-143512-2.png

Dettagli completi (HTML, stili, posizione): @.claude/studio/annotations/20261001-143512.json
Negli screenshot ogni annotazione è evidenziata con il suo numero.
```

Per zone e disegni il messaggio dice sempre dove si trovano: coordinate in px CSS dall'angolo in alto a sinistra della pagina (e sullo schermo, se la pagina era scorsa), l'elemento più piccolo che contiene la zona e il titolo più vicino sopra di essa. Se la zona non contiene elementi interi (copre parte di un'immagine o di una sezione), il messaggio lo dice. L'ultima riga è sempre testo semplice: un messaggio che finisce con un percorso `@…` farebbe aprire a Claude Code i suggerimenti dei file.

**Invio**

- Con "Invio automatico" spento (default) il messaggio resta modificabile nella console e premi Invio tu. Dopo l'invio dalla pagina il focus passa alla console.
- Con "Invio automatico" acceso Studio incolla il messaggio, aspetta che Claude Code abbia finito di elaborare l'incolla (su Windows ConPTY consegna l'input a pezzi e un Invio troppo rapido finirebbe dentro il testo) e preme Invio.
  - Poi controlla lo schermo: se il testo è ancora nel riquadro di input (segnaposto `[Pasted text #N]` o prima riga del messaggio) ripete Invio, al massimo due volte.
  - Non ripete mai Invio se sullo schermo c'è una richiesta di permesso o un menu: lì un Invio approverebbe la richiesta. Nel dubbio non fa nulla.
  - Se il messaggio non risulta partito, la pagina mostra un avviso: basta premere Invio nella console.
- Se Claude Code sta aspettando una tua risposta (richiesta di permesso, domanda di fiducia sulla cartella, menu), Studio non incolla nulla: il testo finirebbe nella richiesta. La pagina lo segnala, porta il focus sulla console e le annotazioni restano da inviare.
- Se Claude sta lavorando, il messaggio va nella sua coda come quando scrivi a mano.

**Contenuto del JSON e degli screenshot**

- Il JSON contiene, per ogni annotazione: selettore stabile, HTML ridotto, testo visibile, stili calcolati, posizione, viewport e scroll, elementi contenuti o toccati, e componenti React.
- I componenti React vengono ricavati in sviluppo dalla catena degli "owner", Server Components inclusi. Con React 18 (`_debugSource`) o con un attributo `data-studio-src` c'è anche file:riga.
- Gli screenshot (zona più 40 px di margine, con i segni disegnati sopra) si catturano con `html-to-image`. Se la cattura non riesce (canvas protetti, immagini di altri domini), l'annotazione parte comunque e il messaggio lo segnala.
- All'avvio vengono cancellati i file più vecchi di 7 giorni.

## App desktop

Con `--mode electron` o `--mode window` il pannello di sinistra mostra un'app desktop al posto dell'iframe. La console, le schede, il vassoio e l'invio a Claude sono gli stessi. Al posto della barra dell'URL ci sono il titolo della finestra (e l'elenco, se l'app ne ha più di una), il pulsante per portarla in primo piano e **Riavvia app**.

### Modalità electron (Electron, WebView2, app Chromium)

```bash
cd la-mia-app-electron
riverloop-studio --mode electron
```

- Studio avvia l'app (lo script `dev` del progetto, altrimenti `start`, oppure `--app-cmd`) e si collega alla sua pagina tramite la **porta di debug** di Chromium.
- Non serve cambiare il comando né il codice dell'app:
  - per Electron, Studio carica nel processo principale un piccolo aggancio (`NODE_OPTIONS=--require`) che apre la porta. Vale con `electron .`, electron-vite, Electron Forge e gli script npm, solo in sviluppo;
  - per WebView2 (Tauri su Windows, app .NET) imposta `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`;
  - per altre app Chromium metti la porta nel comando: `--app-cmd "mia-app --remote-debugging-port={port}"`.
- La pagina dell'app compare nel pannello **dal vivo** e si usa da lì: clic, trascinamenti, rotella e tastiera arrivano all'app.
- La finestra vera di un'app Electron avviata da Studio resta **ridotta a icona**: non compare sul desktop né all'avvio né a ogni riavvio, e non toglie il focus al browser. Per vederla, il pulsante "primo piano" nella barra o la barra delle applicazioni; da lì in poi si comporta come una finestra normale. Con `--app-window normal` resta sul desktop come sempre. (Per WebView2 e le altre app Chromium la finestra resta dov'è: Studio non entra nel loro processo.)
- La vista resta viva anche con la finestra coperta o ridotta a icona, anche per un'app già aperta (`--no-dev`). Se la pagina dell'app smette comunque di disegnare (finestra mai mostrata, pagina bloccata da una finestra di dialogo), Studio lo dice e offre **Mostra la finestra**.
- Gli strumenti sono quelli delle app web: **Elemento**, **Riquadro**, **Disegno**, con selettore, HTML, stili e componenti React. Lo screenshot lo fa il motore dell'app, quindi è fedele anche per canvas e video.
- Menu nativi, finestre di dialogo e tendine dei `<select>` non fanno parte della pagina: si vedono solo nella finestra vera.

```
Modifiche richieste sulla finestra «Gestionale» dell'app desktop, pagina /index.html#/clienti (viewport 1184×720):

1. Elemento `#title` — testo "Clienti"
   Richiesta: rendi il titolo blu
   Screenshot: @.claude/studio/annotations/20261001-212433-1.png
```

### Modalità window (finestra nativa)

```bash
riverloop-studio --mode window --app-cmd "dotnet run"
```

- Studio avvia l'app, trova le finestre dei suoi processi e ne mostra **l'immagine**, aggiornata un paio di volte al secondo anche se la finestra è coperta. L'app si usa nella sua finestra: nel pannello la si guarda e la si annota.
- Con `--no-dev` non avvia nulla: mostra la finestra il cui titolo contiene `--window-title`, oppure fa scegliere la finestra da un elenco.
- **Riquadro** e **Disegno** si tracciano sull'immagine. Al primo gesto l'immagine si ferma (fermo immagine a piena risoluzione), così i segni corrispondono a ciò che vedi; torna dal vivo quando le annotazioni fatte lì sono state inviate o tolte, oppure dal pulsante **torna dal vivo**.
- **Elemento** (su Windows) riconosce i controlli dell'interfaccia con UI Automation: tipo, nome, `AutomationId`, classe e toolkit. Sono i nomi che Claude ritrova nel codice (`x:Name`, `Name` del controllo).
- **Sorgente probabile**: all'invio Studio cerca nei file sorgente del progetto l'`AutomationId` del controllo (o, se manca, il suo testo tra virgolette) e aggiunge le righe trovate ("Probabile codice del controllo: `Form1.Designer.cs:42`"). È un indizio per Claude, con un limite di 1,5 secondi e 5.000 file, saltando `bin`, `obj`, `node_modules` e simili.
- **Riquadro** (su Windows) elenca anche i controlli che stanno nella zona ("Contiene: `Edit «Nome»` (AutomationId `txtNome`), …").
- Le misure sono nei pixel dell'app. Un'app che non gestisce il DPI su uno schermo ingrandito viene catturata alla sua misura vera, non a quella ingrandita da Windows.
- Finestra ridotta a icona: non si può catturare. La pagina lo dice e offre **Mostra la finestra**, che la riporta visibile senza darle il focus.
- Se il sistema non permette la cattura (Wayland, permessi mancanti, PowerShell bloccato) la pagina propone **Condividi la finestra dal browser**: scegli la finestra nel selettore del browser e la annoti allo stesso modo, senza lo strumento Elemento. `RIVERLOOP_STUDIO_NO_CAPTURE=1` forza questa strada.

Claude riceve, per ogni annotazione, il ritaglio della zona e, una volta per gruppo, la finestra intera con tutti i segni (esempio; testo e nomi dei file dipendono dalla lingua):

```
Modifiche richieste sulla finestra «Clienti» dell'app desktop (522×392 px):

1. Elemento `Button «Salva»` (AutomationId `btnSalva`, classe `WindowsForms10.BUTTON`, WinForm)
   Posizione nella finestra: x 281–391, y 103–135 px (in alto al centro)
   Si trova: dentro Window «Clienti»
   Richiesta: pulsante più largo
   Screenshot: @.claude/studio/annotations/20261001-213512-1.png

2. Zona di 220×64 px (nella finestra: a sinistra, a metà altezza)
   Posizione nella finestra: x 27–247, y 153–217 px (dall'angolo in alto a sinistra)
   Richiesta: righe più alte
   Screenshot: @.claude/studio/annotations/20261001-213512-2.png

Finestra intera con le annotazioni 1, 2: @.claude/studio/annotations/20261001-213512-finestra-1.png

Dettagli completi (posizione, elementi dell'interfaccia): @.claude/studio/annotations/20261001-213512.json
Negli screenshot ogni annotazione è evidenziata con il suo numero.
```

### Riavvio a fine risposta

Un'app nativa non ha l'aggiornamento a caldo: per vedere le modifiche va riavviata.

- Con `--restart-on-idle`, o con l'interruttore **Riavvia a fine risposta** nella barra, Studio riavvia l'app quando Claude Code finisce una risposta **in cui ha modificato qualcosa** (ha usato Edit, Write, MultiEdit, NotebookEdit o Bash). Una risposta di sole parole non riavvia nulla.
- La scelta fatta dall'interruttore resta salvata per il progetto in `.claude/studio/state.json`.
- Vale per le app avviate da Studio. Il riavvio prima chiede all'app di chiudersi (come chiudendo la finestra), poi la chiude a forza se non esce in 4 secondi.
- Per sapere quando Claude finisce, Studio non legge lo schermo: avvia `claude` con un file di impostazioni aggiuntive (`--settings`) che registra due hook, `PostToolUse` e `Stop`. Le tue impostazioni di Claude Code non vengono toccate; un `--settings` passato con `--claude-args` viene unito, non sostituito.
- **Riavvia app** nella barra lo fa a mano in qualunque momento.

## File e riga esatti

Senza configurare nulla, Claude riceve selettore, testo, classi e componente React, e trova il codice cercandoli. Con il plugin di build ogni elemento porta con sé file e riga (`data-studio-src="app/page.tsx:16:11"`) e il messaggio li riporta:

```
1. Elemento `main > section.hero > h1` — testo "Benvenuti in AgendaCura"
   Richiesta: rendi il titolo più piccolo
   Componente React: Hero (dentro HomePage)
   Sorgente: app/page.tsx:16:11
```

Il modo più semplice: quando il plugin manca, la pagina Studio lo propone e con un clic chiede a Claude Code di configurarlo (vedi [Suggerimenti per il progetto](#suggerimenti-per-il-progetto)). A mano si fa così.

Il plugin agisce solo in sviluppo: le build di produzione restano identiche. Rendi il pacchetto disponibile al progetto (`npm i -D riverloop-studio`, oppure `npm link riverloop-studio` per una copia locale) e aggiungi una riga alla configurazione.

**Next.js** (Turbopack e webpack):

```ts
// next.config.ts
import { withStudio } from 'riverloop-studio/next';

export default withStudio({ /* la tua configurazione */ });
```

**Vite** (prima del plugin di React):

```ts
// vite.config.ts
import studio from 'riverloop-studio/vite';

export default defineConfig({ plugins: [studio(), react()] });
```

**Babel** (qualunque progetto che compila il JSX con Babel):

```json
{ "plugins": ["riverloop-studio/babel"] }
```

- Vengono marcati gli elementi HTML, SVG e i custom element; i componenti (`<Card>`, `<motion.div>`) restano intatti, perché un attributo in più potrebbe finire nelle loro props.
- I file di renderer che non producono elementi del DOM (React Three Fiber, React Native, react-pdf…) vengono lasciati come sono.
- Sotto i test del progetto (Vitest, Jest, `NODE_ENV=test`) il plugin resta spento, così gli snapshot non cambiano.
- Vale anche per i Server Components e per le app Electron il cui renderer usa Vite o Next.js.
- Per altri strumenti con loader in stile webpack c'è `riverloop-studio/loader`.

## Lingua

L'interfaccia, i messaggi nel terminale e i prompt inviati a Claude Code sono disponibili in **inglese** e **italiano**. La lingua si sceglie in quest'ordine:

1. `--lang en|it` (solo per questo avvio);
2. la variabile d'ambiente `RIVERLOOP_STUDIO_LANG`;
3. la lingua scelta nelle impostazioni della pagina Studio, salvata per utente in `settings.json` nella cartella di configurazione di Studio: `%APPDATA%\riverloop-studio` su Windows, `~/Library/Application Support/riverloop-studio` su macOS, `$XDG_CONFIG_HOME/riverloop-studio` o `~/.config/riverloop-studio` su Linux;
4. la lingua del sistema;
5. l'inglese.

## Compatibilità con Claude Code

L'invio automatico legge lo schermo del terminale di Claude Code in modo euristico, per capire se è visibile il riquadro di input e se il testo incollato è ancora lì. Le schermate registrate usate dai test vengono da Claude Code 2.1.286; gli hook di fine risposta, la status line e la barra di Claude sono stati provati con Claude Code 2.1.287 vero.

Se un aggiornamento di Claude Code cambia l'aspetto dello schermo, l'invio automatico può smettere di premere Invio. Per scelta non preme mai Invio quando non è sicuro, quindi nel caso peggiore premi Invio tu. Gli hook di fine risposta usano l'interfaccia delle impostazioni di Claude Code, non lo schermo.

Se succede, apri una issue con l'output di `claude --version` e di un avvio con `--debug`.

## Sicurezza

La console equivale a una shell sul tuo computer, quindi Studio accetta solo connessioni locali e autenticate.

> **Solo per lo sviluppo.** Per mostrare l'app in un iframe, il proxy **rimuove `Content-Security-Policy` e `X-Frame-Options`** dalle risposte dell'app (e toglie `Domain`/`Secure` dai suoi cookie per farli funzionare su `127.0.0.1`). Non puntare mai Studio a un server di produzione o a un sito che non controlli. Per collaudare la CSP vera, apri l'app direttamente su `localhost`.

Per segnalare una vulnerabilità in privato, vedi [SECURITY.md](../SECURITY.md).

- **Solo loopback**: pagina e proxy ascoltano su `127.0.0.1`.
- **Token di sessione** (32 byte casuali, nuovo a ogni avvio):
  - arriva nel *frammento* del link (`#t=…`), che il browser non invia mai al server;
  - la pagina lo sposta nel `localStorage` della propria origine e lo toglie dalla barra degli indirizzi;
  - lo presenta alle API nell'header `X-Studio-Token` e ai WebSocket come sottoprotocollo.
- **Nessun cookie per la console.** I cookie valgono per tutte le porte di `127.0.0.1`, quindi un cookie con il token arriverebbe a qualunque altro servizio locale. L'iframe dell'app usa un cookie separato (HttpOnly, SameSite=Strict) valido solo per il proxy: se trapelasse, darebbe accesso all'app (già raggiungibile in locale), non alla console.
- **Controllo Origin**: i WebSocket della console accettano solo l'origine della pagina Studio, non quella del proxy né pagine esterne. Le API in POST controllano anche Origin e Content-Type.
- **Controllo Host**: richieste con Host diverso da `127.0.0.1:<porta>` o `localhost:<porta>` vengono rifiutate (difesa dal DNS rebinding).
- **L'app non può pilotare Claude.**
  - L'overlay vive nell'origine dell'app e parla solo con la pagina Studio, via `postMessage` con controllo di origine e sorgente.
  - Il commento si scrive nella pagina Studio, e l'invio parte solo da un gesto fatto lì (pulsante, Ctrl+Invio nella casella o nel pannello).
  - Uno script dell'app (o di terze parti caricato dall'app) non può quindi creare annotazioni né inviarle. Ctrl+Invio premuto dentro l'app chiede una conferma (Invio sul pulsante "Invia").
  - I dati letti dalla pagina (testo, HTML, selettori) arrivano comunque a Claude: sono contenuto dell'app, trattalo come tale.
- **Escape nel PTY**: dai testi scritti nel PTY vengono rimosse sequenze di escape e caratteri di controllo.
- **File**: Studio scrive solo in `.claude/studio/` del progetto, con nomi generati dal companion. L'unica eccezione è Annulla/Ripeti, che ripristina file del progetto da fotografie fatte da Studio stesso, e solo su un clic nella pagina.
- **Suggerimenti**: il testo della richiesta per Claude lo scrive il companion (dalla pagina arriva solo quale suggerimento), parte solo con un clic nella pagina Studio e non mentre Claude Code aspetta una risposta.
- **Progetti aperti**: ogni istanza si annuncia nella cartella di lavoro privata dell'utente (sottocartella `instances`, permessi 0700 sui sistemi Unix, mai nella `/tmp` condivisa). Il file contiene il link con il token, leggibile solo dall'utente, che ha già accesso a quelle console. Anche i log delle istanze avviate dalla pagina, che contengono il link, stanno lì (0600). Prima di elencare un'istanza, Studio verifica che risponda davvero al suo token; le voci rimaste da istanze chiuse male vengono tolte. Avviare o chiudere un progetto dalla pagina richiede il token, come la console.
- **App desktop**:
  - il canale `/ws/app` (immagini dell'app, mouse e tastiera) richiede token e Origin come la console;
  - in modalità `electron` l'overlay vive nella pagina dell'app, come nelle app web: i suoi messaggi passano dal companion alla pagina Studio, che li valida, e uno script dell'app non può creare né inviare annotazioni;
  - la porta di debug dell'app ascolta solo su `127.0.0.1` (lo garantisce Chromium) e la usa solo il companion. Chi può aprire connessioni locali sul tuo computer può però raggiungerla finché l'app è aperta: è la stessa esposizione di `electron --remote-debugging-port`, e vale solo in sviluppo;
  - in modalità `window` Studio cattura solo la finestra scelta, e solo su richiesta della pagina Studio autenticata;
  - gli hook di fine risposta chiamano `/api/hook` con un token a parte, che non apre né la console né le API: se trapelasse potrebbe solo far riavviare l'app. L'endpoint rifiuta le richieste con Origin (cioè quelle dei browser).
- **Permessi di Claude Code**: di default restano quelli standard e Studio non modifica le impostazioni di Claude Code. `--dangerously-skip-permissions` si attiva solo per scelta esplicita (pulsante nella console o opzione da riga di comando) e il terminale di avvio lo segnala. L'invio automatico non preme mai Invio su una richiesta di permesso, né su una schermata che non riconosce: incolla e preme Invio solo quando il riquadro di input di Claude Code è visibile con certezza. La stessa regola vale per la barra di Claude.
- **Scelte salvate fuori dal progetto**: la scelta dei permessi e le opzioni di avvio di ogni progetto stanno nella cartella di configurazione dell'utente. I file del progetto (`.claude/studio/`) non possono togliere le conferme né cambiare come Studio avvia l'app. Studio rifiuta cartelle `.claude/studio` che sono link simbolici o che portano fuori dal progetto.
- **Origini separate nel tempo**: pagina Studio e proxy dell'app sono entrambi su `127.0.0.1`, quindi Studio ricorda quali porte hanno avuto quale ruolo e non le scambia mai. Il proxy rifiuta anche gli script dei Service Worker dell'app, che altrimenti resterebbero nel browser dopo la chiusura di Studio.
- **L'app non vede i tuoi commenti**: l'overlay dentro l'app riceve i segni delle annotazioni senza il loro testo. Non può nemmeno aprire la casella del commento o cancellare annotazioni se nella pagina non hai scelto uno strumento di annotazione.
- **Testi dell'app nei prompt**: le menzioni `@percorso` nei testi che vengono dall'app (etichette, testi, percorsi sorgente) sono neutralizzate con un carattere invisibile, così una pagina non può far allegare file a Claude Code. I tuoi commenti mantengono le loro `@`.
- **Token nel link**: un token nel link sostituisce quello salvato solo dopo che il server lo ha accettato, così una pagina che apre Studio con un link falso non può scollegarti. Su Linux e macOS il browser si apre tramite un file locale privato invece di mettere il link sulla sua riga di comando, dove altri utenti potrebbero leggerlo.

## Come funziona

- **CLI** (`bin/cli.ts`): verifica i prerequisiti e i token, poi gestisce il dev server (o l'app desktop), le sessioni `claude`, il companion e la chiusura ordinata.
- **Companion** (`src/server/index.ts`): pagina Studio, API, WebSocket `/ws/term` (PTY), `/ws/overlay` (canale di controllo della pagina: stato del dev server, esito dell'invio automatico) e, nelle modalità desktop, `/ws/app`.
- **PTY** (`src/server/pty.ts`): `claude` in `node-pty`, con un terminale "specchio" `@xterm/headless`. A ogni collegamento la scheda riceve lo schermo esatto, modalità comprese, e poi l'output dal vivo, senza buchi né duplicati. Lo stesso specchio serve all'invio automatico per leggere il riquadro di input (`src/server/tui.ts`).
- **Porte** (`src/server/portlock.ts`): prenotazione delle porte tra più sessioni con file di lock.
- **Sessioni** (`src/server/sessions.ts`): le schede della console, una `ClaudeSession` per processo `claude`, con la conversazione seguita in `~/.claude/sessions/<pid>.json`.
- **Progetti** (`src/server/projects.ts`): registro delle istanze aperte, progetti recenti, avvio in background e chiusura delle altre istanze.
- **Proxy** (`src/server/proxy.ts`): porta dedicata (studio-port + 1) alla radice, così i percorsi assoluti di Next.js (`/_next/...`) funzionano.
  - Inietta lo script dell'overlay prima di `</body>`, in streaming per le pagine di Next.js che arrivano a pezzi.
  - Inoltra gli upgrade WebSocket dell'HMR (Next.js con Turbopack e webpack, Vite).
  - Riscrive i `Location` e presenta `localhost` come Origin agli endpoint di sviluppo di Next.js (`allowedDevOrigins`). Le Server Actions continuano a funzionare.
- **Overlay** (`src/overlay/`): script vanilla in uno Shadow DOM chiuso, agganciato fuori dal `<body>` dopo il caricamento per non disturbare l'idratazione di React. Gestisce le modalità, i segni ancorati, la raccolta dei dati e gli screenshot. Parla con Studio attraverso un canale intercambiabile (`transport.ts`): `postMessage` nell'iframe delle app web, la porta di debug nelle app Chromium.
- **App desktop**:
  - `src/server/desktop.ts` gestisce il processo dell'app (avvio, log, riavvio, chiusura dell'albero di processi), con la stessa superficie del dev server.
  - `src/server/bridge.ts` è il canale `/ws/app` con la pagina; lo estendono i due ponti.
  - **electron** (`electron.ts`, `cdp.ts`, `electron-hook.cts`): screencast della pagina, mouse e tastiera con i comandi `Input.*` del protocollo DevTools, overlay iniettato a ogni nuovo documento.
  - **window** (`window.ts`, `wincapture.ts`): elenco delle finestre dell'albero di processi, anteprima, fermi immagine, elementi dell'interfaccia. Su Windows lavora un aiutante PowerShell che resta in esecuzione (`PrintWindow`, UI Automation), eseguito in memoria senza file `.ps1`.
  - Nella pagina, `src/web/appPanel.ts` ospita una "superficie" per tipo di app: `frameSurface.ts` (iframe), `remoteSurface.ts` (electron), `imageSurface.ts` (window, con l'annotatore sull'immagine). Tutte parlano con il resto della pagina con gli stessi messaggi dell'overlay.
- **Hook** (`src/server/hooks.ts`, `bin/hook.ts`): fine risposta di Claude Code per il riavvio automatico delle app desktop.
- **Plugin** (`src/plugin/`): file e riga degli elementi per Vite, Babel, Next.js e loader webpack.

## Note per sistema

- **Windows (PowerShell, cmd)**:
  - ConPTY tramite `node-pty`.
  - Trova `claude.exe` (installer nativo) e gli shim `claude.cmd` di npm, che vengono avviati direttamente con node, senza passare da cmd.exe.
  - La chiusura usa `taskkill /T /F` sull'intero albero di processi. Un'app desktop riceve prima una richiesta di chiusura (come chiudendo la sua finestra), mandata solo al processo principale di ogni programma dell'albero: con `taskkill /T` senza `/F` si chiuderebbero i processi ausiliari di Electron (grafica, rete) ma non quello principale, e la finestra tornerebbe in primo piano fino alla chiusura forzata.
  - Se un testo incollato su più righe viene inviato riga per riga, avvia con `set RIVERLOOP_STUDIO_CONPTY_DLL=1` (PowerShell: `$env:RIVERLOOP_STUDIO_CONPTY_DLL=1`): userà il ConPTY più recente incluso in node-pty.
  - Se l'invio automatico non parte, avvia con `--debug`: il terminale di avvio mostra come è stato incollato il messaggio e cosa ha visto Studio nel riquadro di input dopo ogni Invio.
  - Porte prenotate, progetti aperti e log stanno in `%LOCALAPPDATA%\riverloop-studio`.
  - Modalità `window`: la cattura usa `PrintWindow` e funziona con finestre coperte, su schermi secondari e con scale diverse; non con finestre ridotte a icona o fuori da ogni schermo (Windows non le disegna).
- **WSL**:
  - Studio apre il browser di Windows, che raggiunge `127.0.0.1` grazie all'inoltro delle porte di WSL.
  - Tieni il progetto nel filesystem Linux (`~/…`), non in `/mnt/c/…`: lì l'HMR di Next.js e Vite è lento o non vede le modifiche.
- **macOS e Linux**: il dev server, l'app desktop e `claude` vengono chiusi insieme a tutti i processi dei loro gruppi.
  - Modalità `window` su macOS: `screencapture` e l'elenco delle finestre di CoreGraphics; senza il permesso "Registrazione schermo" i titoli delle finestre mancano e la cattura fallisce. Su Linux: `wmctrl` e `import` (ImageMagick) con X11. In entrambi manca lo strumento Elemento. (Sperimentale, vedi [Sistemi supportati](#sistemi-supportati).)
  - Tauri fuori da Windows usa WebKit, che non ha la porta di debug di Chromium: lì si usa `--mode window`.

## Limiti noti

- Dev server in HTTPS (`next dev --experimental-https`) non ancora supportati: il proxy parla HTTP.
- Il login con provider OAuth esterni dentro l'iframe spesso non funziona: molti provider vietano di essere incorniciati e registrano come callback `localhost:3000`. Fai il login aprendo l'app direttamente.
- File e riga esatti richiedono il plugin nella configurazione del progetto (vedi [File e riga esatti](#file-e-riga-esatti)). Senza, Claude riceve componente React, selettore, testo e classi, e trova il codice cercandoli.
- Modalità `electron`: menu nativi, finestre di dialogo e tendine dei `<select>` non compaiono nella copia; una finestra di dialogo aperta (`alert`) blocca la pagina finché non le si risponde nella finestra vera. L'input con IME passa come testo, senza l'anteprima della composizione.
- Modalità `window`: l'app non si usa dalla pagina (si guarda e si annota), e lo strumento Elemento c'è solo su Windows. Le app che disegnano tutto da sole (giochi, Flutter, molte app Qt) espongono pochi elementi o nessuno: lì si usano Riquadro e Disegno.
- I progetti aperti dal menu **Progetti** partono in modalità web: per un'app desktop lancia `riverloop-studio --mode …` dalla sua cartella.
- Le scorciatoie Ctrl+W, Ctrl+T e Ctrl+N arrivano a Claude solo a schermo intero (pulsante ⛶ nella console, API Keyboard Lock di Chrome ed Edge). Fuori dallo schermo intero le gestisce il browser.
- Con un dev server già attivo (`--no-dev`), se la porta è sbagliata Studio non può rilevarla dall'output: usa `--port`.
- L'invio automatico dipende dall'aspetto dello schermo di Claude Code (vedi [Compatibilità con Claude Code](#compatibilità-con-claude-code)).
- Su Linux e macOS, se Studio gira come root, Claude Code rifiuta `--dangerously-skip-permissions`: la sessione si chiude subito con il messaggio di Claude Code.
- Con versioni di Claude Code che non scrivono `~/.claude/sessions/<pid>.json`, "Riprendi" usa `--continue`, cioè l'ultima conversazione della cartella.
- Gli screenshot di pagine web pesanti con `html-to-image` possono richiedere secondi (timeout 12 s). Nelle app desktop Chromium lo screenshot lo fa il motore.

## Roadmap

- Collaudo delle modalità desktop (`electron`, `window`) su macOS e Linux, e della modalità web su macOS.
- Elementi dell'interfaccia nativa (strumento Elemento, "Contiene" per le zone) su macOS (Accessibility) e Linux (AT-SPI); uso dell'app nativa dalla pagina (oggi solo per le app Chromium).
- Prove delle due modalità desktop su più progetti reali (Electron con electron-vite e Forge, Tauri, WPF, Qt).
- Dev server in HTTPS e login OAuth nell'iframe.
- Diagnostica: un file di log e un comando `riverloop-studio doctor` che verifichi node-pty, claude, porte, browser e cattura delle finestre.
- Sostituire `http-proxy`, non aggiornato dal 2020.
- Plugin di file e riga per Vue e Svelte.
- Altre lingue dell'interfaccia.
- Avviso di nuova versione disponibile.

## Sviluppo e test

I contributi sono benvenuti: vedi [CONTRIBUTING.md](../CONTRIBUTING.md).

```bash
npm run build          # server (tsc), pagina Studio e overlay (Vite)
npm run typecheck
npm run lint           # ESLint
npm run format         # Prettier, scrive le modifiche
npm run format:check   # Prettier, solo controllo
npm test               # test unitari (vitest)
```

I test girano con `RIVERLOOP_STUDIO_LANG=it`, perché le verifiche usano i testi italiani.

**Test end-to-end**: sono script Node che pilotano la CLI compilata con `playwright-core`, che non include un browser (passa `--chromium`; per i test desktop Chrome/Edge viene trovato da solo).

```bash
# modalità web: crea l'app di prova (default ../riverloop-e2e-app, modello di create-next-app 16)
node scripts/create-e2e-app.mjs [cartella]
npm run test:e2e -- --app <cartella> --chromium "<percorso di Chrome>"

node test/e2e/smoke.mjs --app ../app-vite --file src/App.tsx --find "Get started" --replace "Ciao" --target h1
node test/e2e/multi.mjs --app-a ../progetto-a --text-a "testo di A" --app-b ../progetto-b --text-b "testo di B"
node test/e2e/sessions.mjs --app-a ../progetto-a --app-b ../progetto-b --text-b "testo di B"

# modalità desktop: app di prova incluse
npm run test:e2e:electron   # app Electron vera (prima: npm install in test/fixtures/electron-app)
npm run test:e2e:window     # finestra nativa vera (solo Windows)
```

- Gli script sostituiscono `claude` con un finto (`test/fixtures/fake-claude.mjs`) che registra l'input ricevuto dal PTY. Imita un Claude Code lento (un Invio entro 700 ms dall'incolla finisce nel testo), dopo l'invio apre una richiesta di permesso ed esegue gli hook del file `--settings` come Claude Code (un messaggio con la parola `MODIFICA` conta come una risposta che ha scritto un file).
- `run.mjs` verifica token, console e ripristino dopo il ricaricamento, più schede, HMR senza ricaricare, i tre strumenti, prompt (posizione delle zone compresa) e file, invio automatico (Invio ripetuto se assorbito, mai sulla richiesta di permesso, niente incolla mentre Claude aspetta una risposta), viewport, rifiuti dei WebSocket e delle API, tentativi dell'app di iniettare annotazioni, riavvio di Claude, permessi, suggerimenti per il progetto, Annulla/Ripeti e chiusura senza orfani.
- `multi.mjs` avvia due sessioni insieme con la porta 3000 occupata da un altro server: porte tutte diverse, nessun aggancio al server estraneo, ogni iframe mostra la propria app.
- `sessions.mjs` verifica schede e progetti: seconda sessione con il suo processo, input e console separati; annotazioni alla scheda attiva; "Riprendi" con `--resume` della propria conversazione; sessione in un'altra finestra; chiusura di una scheda; avvio di un altro progetto dal menu, senza doppioni, e sua chiusura; chiusura del progetto corrente dalla pagina.
- `electron.mjs` avvia Studio su un'app Electron vera (`test/fixtures/electron-app`): porta di debug aperta senza toccare il comando, copia dal vivo anche a finestra ridotta a icona, mouse, tastiera e rotella, più finestre, i tre strumenti, messaggio e screenshot, tentativi dell'app di iniettare annotazioni, accessi rifiutati al canale dell'app e agli hook, "Riavvia app", riavvio a fine risposta solo dopo una modifica, chiusura senza processi rimasti, aggancio a un'app già aperta (`--no-dev --cdp-port`) che resta viva e usabile e che Studio non chiude.
- `window.mjs` (Windows) fa lo stesso su una finestra Windows Forms (`test/fixtures/native-app.ps1`): finestra trovata e aggiornata dal vivo, Elemento con UI Automation, Riquadro e Disegno sul fermo immagine, ritorno dal vivo, messaggio con elemento nativo e finestra intera, finestra ridotta a icona, riavvii, aggancio con `--no-dev --window-title`, condivisione dal browser.
- Le app di prova leggono `RLS_FIXTURE_QUIET=1` (lo impostano i test): si aprono su uno schermo secondario e senza prendere il focus, per non disturbare chi usa il computer. Il browser dei test è headless.
- I test unitari dell'invio automatico usano schermate vere di Claude Code (`test/fixtures/claude-screens/`): testo incollato, testo digitato, elaborazione in corso, messaggio inviato, richiesta di permesso.

Cosa è stato verificato finora:

- Modalità web: `run.mjs` su Linux e Windows 11 con Next.js 16 (Turbopack e webpack); `smoke.mjs` su Next.js 14 (React 18) e Vite 8 + React 19.
- I plugin di file e riga su Next.js 16.3 (Turbopack e webpack, React 19) e Vite 8 con `@vitejs/plugin-react` 6.
- Modalità desktop su Windows 11: Electron 44, un'app WebView2, Windows Forms.
- Con Claude Code vero: "Riprendi" sulla prima di due schede torna alla sua conversazione (2.1.286); gli hook di fine risposta riavviano l'app solo dopo una risposta che ha scritto un file, e il suggerimento "file e riga" fa modificare a Claude `next.config.ts`, poi sparisce (2.1.287).

**CI** (GitHub Actions): build, lint e test unitari su Windows, macOS e Linux; installazione pulita dal tarball del pacchetto; test end-to-end web su Linux e Windows.

## Struttura del progetto

```
riverloop-studio/
├─ bin/
│  ├─ cli.ts               # entry point, opzioni, ciclo di vita
│  ├─ hook.ts              # hook di Claude Code: avvisa Studio a fine risposta
│  └─ statusline.ts        # status line di Claude Code: modello, effort, utilizzo (esegue anche la tua)
├─ src/server/
│  ├─ index.ts             # companion: pagina, API, WebSocket
│  ├─ pty.ts               # processo claude, terminale specchio, schede collegate
│  ├─ proxy.ts             # reverse proxy, iniezione dell'overlay, HMR
│  ├─ annotations.ts       # validazione, salvataggio, composizione del prompt
│  ├─ security.ts          # token, Host, Origin, cookie del proxy
│  ├─ sessions.ts          # schede della console: più processi claude per progetto
│  ├─ projects.ts          # progetti aperti su questo computer, avvio e chiusura
│  ├─ tui.ts               # lettura dello schermo di Claude Code per l'invio automatico
│  ├─ devserver.ts         # avvio, attesa, log, riavvio e chiusura del dev server
│  ├─ desktop.ts           # processo dell'app desktop
│  ├─ bridge.ts            # canale /ws/app tra pagina e app desktop
│  ├─ electron.ts          # modalità electron: screencast, input, overlay via porta di debug
│  ├─ cdp.ts               # client minimo del protocollo DevTools
│  ├─ electron-hook.cts    # caricato in Electron: apre la porta di debug
│  ├─ window.ts            # modalità window: finestre, anteprima, fermi immagine
│  ├─ wincapture.ts        # cattura delle finestre (Windows, macOS, Linux X11)
│  ├─ wincapture-win32.ts  # aiutante PowerShell: PrintWindow e UI Automation
│  ├─ hooks.ts             # hook di fine risposta e riavvio automatico
│  ├─ suggestions.ts       # suggerimenti per il progetto (e il testo delle richieste a Claude)
│  ├─ history.ts           # Annulla e Ripeti: fotografie dei file in un archivio fuori dal progetto
│  ├─ overlay-source.ts    # sorgente dell'overlay con la sua configurazione
│  ├─ portlock.ts          # porte prenotate tra più sessioni
│  ├─ state.ts             # preferenze del progetto (.claude/studio/state.json)
│  ├─ userState.ts         # scelte dell'utente per un progetto (permessi), fuori dal progetto
│  ├─ nativeSource.ts      # file e riga probabili di un controllo nativo
│  ├─ i18n.ts, locales/    # lingue del server (inglese, italiano)
│  ├─ paths.ts             # cartella di configurazione dell'utente
│  ├─ gitignore.ts         # proposta per .gitignore
│  └─ util.ts              # processi, eseguibili, terminale
├─ src/shared/            # protocol.ts (messaggi), i18n.ts (traduzioni)
├─ src/web/                # pagina Studio (vanilla TS + Vite, xterm.js)
├─ src/overlay/            # overlay iniettato nell'app (IIFE)
├─ src/plugin/             # file e riga: Vite, Babel, Next.js, loader webpack
├─ scripts/                # script di build, creazione dell'app per i test e2e
└─ test/                   # unitari, end-to-end, finto claude, app di prova
```

## Licenza

Copyright Riverloop SRLS. Distribuito con [Licenza Apache 2.0](../LICENSE); vedi anche [NOTICE](../NOTICE).
