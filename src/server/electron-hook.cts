// Caricato nel processo principale di Electron con NODE_OPTIONS=--require (modalità electron
// di Riverloop Studio). Fa tre cose, solo in sviluppo e solo se l'app è stata avviata da Studio:
// 1. apre la porta di debug (remote-debugging-port) scelta da Studio, così funziona con
//    qualunque comando di avvio (electron ., electron-vite, electron-forge, script npm);
// 2. tiene attivo il disegno delle finestre anche quando sono coperte o ridotte a icona,
//    altrimenti la copia mostrata nella pagina Studio si fermerebbe;
// 3. tiene le finestre dell'app ridotte a icona (a meno di --app-window normal): l'app si usa
//    dalla pagina Studio, e una finestra che compare sul desktop a ogni avvio e a ogni riavvio
//    ruberebbe il focus al browser.
// La stessa variabile NODE_OPTIONS arriva a tutti i processi Node avviati dal comando (npm,
// vite...): lì questo file non fa nulla. Non deve mai lanciare né rallentare l'avvio.

(function riverloopStudioElectronHook(): void {
  try {
    const versions = process.versions as Record<string, string | undefined>;
    const type = (process as unknown as { type?: string }).type;
    const port = process.env.RIVERLOOP_STUDIO_CDP_PORT;
    if (!versions.electron || type !== 'browser' || !port || !/^\d{2,5}$/.test(port)) return;

    interface CommandLine {
      hasSwitch(name: string): boolean;
      getSwitchValue(name: string): string;
      appendSwitch(name: string, value?: string): void;
    }
    interface ElectronApp {
      commandLine: CommandLine;
      on(event: string, listener: (...args: unknown[]) => void): void;
    }
    interface AppWindow {
      isDestroyed(): boolean;
      isMinimized(): boolean;
      isVisible(): boolean;
      minimize(): void;
      getOpacity?(): number;
      setOpacity?(opacity: number): void;
      show(): void;
      showInactive(): void;
      focus(): void;
      on(event: string, listener: (...args: unknown[]) => void): void;
    }
    type WindowClass = new (options?: Record<string, unknown>) => AppWindow;
    let switched = false;
    let wired = false;
    const background = process.env.RIVERLOOP_STUDIO_APP_WINDOW !== 'normal';
    /** Finestre create dall'app: true se le voleva visibili subito (show non false). */
    const wantedVisible = new WeakMap<object, boolean>();

    /**
     * Tiene una finestra ridotta a icona finché non è l'utente a riportarla su (dalla barra
     * delle applicazioni o con "primo piano" nella pagina Studio): da lì in poi è una finestra
     * normale. Le finestre che l'app tiene nascoste (show: false e mai mostrate) restano nascoste.
     */
    const tuck = (win: AppWindow): void => {
      let released = false;
      let opacity: number | null = null;
      const showInactive = win.showInactive.bind(win);
      const opaque = (): void => {
        if (opacity === null) return;
        const value = opacity;
        opacity = null;
        try {
          if (!win.isDestroyed()) win.setOpacity?.(value);
        } catch {
          /* finestra già chiusa */
        }
      };
      const down = (): void => {
        try {
          if (released || win.isDestroyed() || win.isMinimized()) return;
          if (process.platform === 'win32' && !win.isVisible() && win.setOpacity) {
            // Su Windows ridurre a icona una finestra ancora nascosta la attiva (SW_SHOWMINIMIZED):
            // diventa la finestra in primo piano, si prende la tastiera, e al primo gesto torna su.
            // La si mostra quindi senza attivarla e trasparente, e la si riduce da visibile.
            opacity ??= win.getOpacity?.() ?? 1;
            win.setOpacity(0);
            showInactive();
            win.minimize();
            // L'animazione della riduzione a icona dura un istante: finita quella torna opaca
            setTimeout(opaque, 600);
          } else {
            win.minimize();
          }
        } catch {
          /* finestra già chiusa */
        }
      };
      win.on('restore', () => {
        released = true;
        opaque();
      });
      for (const name of ['show', 'showInactive', 'focus'] as const) {
        const original = win[name].bind(win);
        win[name] = () => (released ? original() : down());
      }
      // Dopo la creazione, non durante: una finestra ridotta a icona prima di esistere resta di 0×0 pixel
      setImmediate(() => {
        try {
          const wanted = wantedVisible.get(win);
          if (wanted === true || (wanted === undefined && !win.isDestroyed() && win.isVisible())) down();
        } catch {
          /* finestra già chiusa */
        }
      });
    };

    /**
     * Il modulo "electron" visto dall'app, con BrowserWindow che crea le finestre senza
     * mostrarle: così non compaiono nemmeno per un istante prima di essere ridotte a icona.
     * (Con import ES il modulo non passa di qui: lì la finestra compare e viene ridotta subito.)
     */
    let wrapped: unknown = null;
    const wrapElectron = (electron: unknown): unknown => {
      if (!background || !electron || typeof electron !== 'object' || !('app' in electron)) return electron;
      if (wrapped) return wrapped;
      let Wrapper: WindowClass | null = null;
      const windowClass = (target: { BrowserWindow: WindowClass }): WindowClass => {
        if (Wrapper) return Wrapper;
        const Real = target.BrowserWindow;
        class StudioWindow extends Real {
          constructor(options?: Record<string, unknown>) {
            super(Object.assign({}, options, { show: false }));
            wantedVisible.set(this, !options || options.show !== false);
          }
          // Anche le finestre create da Electron stesso (window.open) sono BrowserWindow per l'app
          static override [Symbol.hasInstance](value: unknown): boolean {
            return Function.prototype[Symbol.hasInstance].call(Real, value);
          }
        }
        Object.defineProperty(StudioWindow, 'name', { value: 'BrowserWindow' });
        Wrapper = StudioWindow;
        return Wrapper;
      };
      wrapped = new Proxy(electron as object, {
        get(target, prop) {
          const value = Reflect.get(target, prop) as unknown;
          return prop === 'BrowserWindow' && typeof value === 'function' ? windowClass(target as { BrowserWindow: WindowClass }) : value;
        },
      });
      return wrapped;
    };

    const setSwitches = (cl: CommandLine | undefined): void => {
      if (switched || !cl) return;
      // Una porta già decisa dall'app o dal comando resta quella (Studio la trova con --cdp-port)
      if (!cl.hasSwitch('remote-debugging-port')) cl.appendSwitch('remote-debugging-port', port);
      const feature = 'CalculateNativeWinOcclusion';
      const disabled = cl.getSwitchValue('disable-features');
      if (!disabled.split(',').includes(feature)) cl.appendSwitch('disable-features', disabled ? `${disabled},${feature}` : feature);
      cl.appendSwitch('disable-backgrounding-occluded-windows');
      cl.appendSwitch('disable-renderer-backgrounding');
      switched = true;
    };

    const wire = (electron: { app?: ElectronApp } | undefined): void => {
      const app = electron?.app;
      if (wired || !app || typeof app.on !== 'function') return;
      wired = true;
      try {
        setSwitches(app.commandLine);
      } catch {
        /* l'app è già partita: restano gli interruttori messi prima */
      }
      app.on('web-contents-created', (_event: unknown, contents: unknown) => {
        try {
          (contents as { setBackgroundThrottling?: (allowed: boolean) => void }).setBackgroundThrottling?.(false);
        } catch {
          /* versione di Electron senza questa funzione */
        }
      });
      if (background) {
        app.on('browser-window-created', (_event: unknown, win: unknown) => {
          try {
            tuck(win as AppWindow);
          } catch {
            /* finestra senza questi metodi: resta com'è */
          }
        });
      }
    };

    // Prima dell'avvio di Electron il modulo "electron" non è ancora quello interno: richiederlo
    // qui caricherebbe il pacchetto npm (che esporta solo il percorso dell'eseguibile) e lo
    // lascerebbe nella cache al posto di quello vero. Gli interruttori si impostano quindi con
    // il binding interno, e il resto appena il modulo vero è disponibile.
    try {
      const binding = (process as unknown as { _linkedBinding?: (name: string) => CommandLine })._linkedBinding;
      if (binding) setSwitches(binding('electron_common_command_line'));
    } catch {
      /* binding non disponibile in questa versione: si ripiega sull'intercettazione qui sotto */
    }

    const Module = require('node:module') as {
      _load: (request: string, ...rest: unknown[]) => unknown;
      _resolveFilename: (request: string, parent: unknown) => string;
    };
    const originalLoad = Module._load;
    Module._load = function patchedLoad(this: unknown, request: string, ...rest: unknown[]): unknown {
      const result = originalLoad.apply(this, [request, ...rest] as [string, ...unknown[]]);
      if (request !== 'electron') return result;
      if (!wired) wire(result as { app?: ElectronApp });
      return wired ? wrapElectron(result) : result;
    };
    const builtinReady = (): boolean => {
      try {
        return Module._resolveFilename('electron', module) === 'electron';
      } catch {
        return false;
      }
    };
    let tries = 0;
    const poll = (): void => {
      if (wired) return;
      if (builtinReady()) {
        try {
          wire(require('electron') as { app?: ElectronApp });
        } catch {
          /* riproveremo al primo require dell'app */
        }
      } else if (++tries < 500) setImmediate(poll);
    };
    setImmediate(poll);
  } catch {
    /* mai bloccare l'avvio dell'app */
  }
})();
