# Architecture

How Riverloop Studio is built: the pieces, how they talk to each other, and the pitfalls that are easy to get wrong. Read it before changing code; the user-facing documentation is in [guide.md](guide.md).

## What this is

Riverloop Studio is a CLI (`riverloop-studio`) launched from the folder of a project. It opens a local page with the app under development on one side and the real `claude` process (in a PTY) on the other. The user marks up the app (element, area, freehand drawing), writes a comment, and the annotation is pasted into the Claude Code session as a prompt.

The app can be of three kinds (`--mode`):

- `web` (default): the project's dev server, shown in an iframe through a local proxy;
- `electron`: an Electron app, or any Chromium-based desktop app (WebView2, so Tauri on Windows), mirrored live and driven through its remote-debugging port;
- `window`: any native window, shown as a captured image and annotated on that image.

`README.md` (English) is the public landing page: pitch, features, screenshots in `docs/images/`, installation. The full user guide is `docs/guide.md` (Italian: `docs/guida.md`): options, security model, known limits, what is verified on which OS, roadmap. Keep the two languages in sync.

Code comments and test names are in **Italian**. User-visible text (page, overlay, terminal messages, prompts sent to Claude Code) goes through `t()` with English and Italian dictionaries: `src/server/locales`, `src/web/locales`, `src/overlay/locales`, on top of `src/shared/i18n.ts`. Italian (`it.ts`) is the reference; `en.ts` is typed `Messages<typeof it>` so missing keys fail typecheck. Tests run with `RIVERLOOP_STUDIO_LANG=it` because assertions use the Italian texts.

## Commands

```bash
npm run build          # all three builds below, in order
npm run build:server   # scripts/clean.mjs + tsc -> dist/bin, dist/src
npm run build:web      # Vite -> dist/web (Studio page)
npm run build:overlay  # Vite lib/IIFE -> dist/overlay/overlay.js
npm run typecheck      # tsc --noEmit on tsconfig.json AND tsconfig.web.json
npm test               # vitest run (test/unit/**/*.test.ts)
npx vitest run test/unit/tui.test.ts          # one file
npx vitest run -t "non preme mai Invio"       # one test by name
```

There is no linter or formatter configured.

Unit tests import straight from `src/` and need no build, with one exception: the Babel-plugin test in `plugin.test.ts` loads `dist/src/plugin/babel.cjs`. Everything else runs from `dist/`: the bin entry is `dist/bin/cli.js`, the companion serves `dist/web` and injects `dist/overlay/overlay.js`. After changing source, rebuild before running the CLI or the e2e scripts (`npm install` also builds, via `prepare`).

To run it manually: build, then from the folder of a project run `node <path-to-this-repo>/dist/bin/cli.js` (or `npm link` once and use `riverloop-studio`). `--debug` prints ports and auto-send diagnostics; `--no-open` only prints the link.

End-to-end scripts are plain Node scripts (not vitest) that drive the built CLI with `playwright-core`, which ships no browser:

```bash
# web mode: needs an external Next.js app created with the default create-next-app template
npm run test:e2e -- --app ../a-next-project --chromium "<path to Chrome>"
node test/e2e/smoke.mjs --app ../a-vite-app --file src/App.tsx --find "Get started" --replace "Ciao" --target h1
node test/e2e/multi.mjs --app-a ../a --text-a "..." --app-b ../b --text-b "..."
node test/e2e/sessions.mjs --app-a ../a --app-b ../b --text-b "..."

# desktop modes: self-contained fixtures, Chrome/Edge found automatically (or --chromium)
npm run test:e2e:electron   # first: npm install inside test/fixtures/electron-app
npm run test:e2e:window     # Windows only (Windows Forms fixture, test/fixtures/native-app.ps1)
```

They replace `claude` with `test/fixtures/fake-claude.mjs` (via `--claude-bin`), which logs PTY input, simulates a slow paste and a permission dialog (`FAKE_CLAUDE_*` env vars), and runs the hooks of the `--settings` file like Claude Code does (a submitted message containing `MODIFICA` counts as a turn that wrote a file).

The desktop e2e tests open real windows. The fixtures honour `RLS_FIXTURE_QUIET=1` (set by the tests): they open on a secondary monitor without taking focus, and the Electron one starts minimized. Keep it that way — a test window on the primary screen gets real clicks from whoever is using the machine, which also corrupts the test.

## Architecture

Separately compiled pieces that run in different trust contexts:

| Piece | Source | Build | Runs in |
|---|---|---|---|
| CLI + companion | `bin/`, `src/server/` | `tsc` (`tsconfig.json`, NodeNext) | Node |
| Studio page | `src/web/` | Vite (`vite.web.config.ts`) | browser, origin `127.0.0.1:<studioPort>` |
| Overlay | `src/overlay/` | Vite IIFE (`vite.overlay.config.ts`) | inside the user's app (web iframe, or the page of a Chromium desktop app) |
| Build plugins | `src/plugin/` | `tsc` | the user's dev toolchain (Vite, Babel, Next.js) |

`src/shared/protocol.ts` is compiled by both toolchains and defines every message between the pieces (`OverlayToPage`, `PageToOverlay`, `ControlMessage`, `TermClientMessage`/`TermServerMessage`, `AppClientMessage`/`AppServerMessage`, `StudioConfig`). It must stay types and constants only. Server code imports with `.js` extensions (NodeNext); web/overlay imports are extensionless (Bundler resolution, checked by `tsconfig.web.json`).

Files with a `.cts` extension are deliberately CommonJS: `src/plugin/*.cts` (webpack/Turbopack loaders and Babel plugins are loaded with `require`) and `src/server/electron-hook.cts` (loaded into Electron's main process with `NODE_OPTIONS=--require`).

### Process lifecycle (`bin/cli.ts`)

Checks prerequisites (Node, `claude --version`, node-pty), claims ports through lock files (`portlock.ts`), starts what is being annotated (a `DevServer` in web mode, a `DesktopApp` plus its bridge in desktop modes), creates the `SessionManager`, starts the companion, registers the instance in the per-user registry (`projects.ts`), then opens the browser. Shutdown (signals, `/api/shutdown`, uncaught exception) stops Claude sessions, the app and the companion in order; `hardKill` on `exit` is the last defence against orphan processes and must never throw.

`DesktopApp` (`desktop.ts`) deliberately has the same surface as `DevServer` (status, log, restart, stop) so the page shows both the same way; the companion only sees the common `AppRunner` shape.

### Companion (`src/server/index.ts`)

- **Studio server** on `127.0.0.1`: static page, JSON API (`/api/config`, `/api/annotation`, `/api/sessions[...]`, `/api/projects[...]`, `/api/shutdown`, `/api/hook`) and three WebSockets. `/ws/term?s=<id>` is a console tab attached to a `ClaudeSession`. `/ws/overlay` is, despite the name, the Studio page's control channel (app status, session list, auto-send outcome, end-of-turn). `/ws/app` exists only in desktop modes and carries frames, input and overlay messages.
- **App proxy** (`proxy.ts`, web mode only): reverse proxy to the dev server on its own port at root, so absolute paths like `/_next/...` work. It injects the overlay script before `</body>` (streaming, `InjectTransform`), forwards HMR WebSocket upgrades, rewrites `Location` and cookie attributes, and strips `X-Frame-Options`/CSP.

### The three surfaces

The Studio page's `AppPanel` hosts one `Surface` (`src/web/surface.ts`) per mode. All three speak the overlay message vocabulary to the rest of the page, so `AnnotationManager`, the comment box and the tray are mode-agnostic:

- `FrameSurface`: the iframe; the overlay inside talks via `postMessage`.
- `RemoteSurface` (electron): a canvas fed by a CDP screencast; pointer and keyboard events are forwarded to the app (`Input.*`). The same overlay bundle is injected into the app's page over the debugging port and talks through a CDP binding (`src/overlay/transport.ts` abstracts the two channels). Server side: `ElectronBridge` (`electron.ts`) on top of `cdp.ts`.
- `ImageSurface` (window): a canvas showing captured images of a native window. There is no page to inject into, so this class *is* the annotator: it draws marks, freezes the image on the first gesture, and emits the same messages an overlay would. Server side: `WindowBridge` (`window.ts`) on top of a per-OS `WindowCapturer` (`wincapture.ts`).

Both bridges extend `AppBridge` (`bridge.ts`), which owns the `/ws/app` clients, frame fan-out and the `AppView` state the page renders.

Things that are easy to get wrong here:

- **CDP capture must not use `clip`.** `Page.captureScreenshot` with a clip makes Chromium briefly offset and scale the app's viewport: the real window and the mirror jump, and gestures made in that instant land in the wrong place. The bridge captures the whole viewport and the overlay crops it.
- **A second CDP client detaching cancels in-flight synthetic input** from every session. Tests keep one persistent debugging connection for that reason (`cdpEval` in `test/e2e/desktop-lib.mjs`).
- **Electron windows start minimized under Studio** (`--app-window background`, the default): otherwise the real window pops up over the browser on every launch and every restart-on-idle. The hook wraps `BrowserWindow` (through the `Module._load` patch) to create windows with `show: false`, then minimizes them one tick *after* creation — minimizing during creation leaves a 0×0 page — and turns the app's own `show()`/`focus()` calls into no-ops until the user restores the window. On Windows, minimizing a still-hidden window uses `SW_SHOWMINIMIZED`, which *activates* it (it becomes the foreground window and comes back up at the next gesture): the hook first shows it inactive at opacity 0, minimizes it, then restores the opacity.
- **Graceful stop on Windows must not use `taskkill /T` without `/F`.** It posts `WM_CLOSE` to Electron's helper processes (GPU, network), which exit, while refusing the main process because it still has children: the app stays open and Chromium re-shows the window in the foreground until the forced kill. `DesktopApp.stop()` sends the close request only to the top process of each program in the tree (`closeTargets`), then forces the whole tree after the timeout.
- **The Electron hook must not `require('electron')` at preload time**: before Electron's own init runs, that resolves to the npm package (a path string) and poisons the module cache for the app. The hook sets switches through the internal command-line binding and only touches `app` once the built-in module resolves. It also disables background throttling so the mirror keeps painting when the window is covered or minimized; for apps Studio did not launch, the same effect comes from `Emulation.setFocusEmulationEnabled`, which the bridge always turns on (and which is why `document.visibilityState` cannot be used to detect a hidden window — the bridge asks the page for an animation frame instead).
- **Windows capture works in app pixels.** `PrintWindow` renders a DPI-unaware app at its own size in the top-left of a physical-size bitmap; the helper crops to that and scales UI Automation coordinates by the same ratio (`RlsWin.Ratio`). The helper is a long-lived PowerShell process whose script is sent as the first stdin line and run in memory.
- **While the overlay hides its marks for a capture, its (transparent) shield stays active**, so an annotation gesture started in that window is not lost.

### Claude sessions (`pty.ts`, `sessions.ts`, `tui.ts`)

`SessionManager` holds up to 8 `ClaudeSession`s (console tabs), each a `claude` process in node-pty (falling back to `@lydell/node-pty`).

- The process does **not** start at session creation: it starts on the first `resize` from an attached client, so the TUI's first paint has the panel's real size.
- Every PTY byte is also written to a headless xterm "mirror". A client that attaches gets a serialized snapshot of the mirror, then queued and live output — this is what makes reloads and multiple tabs show the exact same screen.
- The same mirror is the input for auto-send. `tui.ts` reads the rendered screen heuristically to tell whether Claude Code shows its input box or is awaiting an answer (permission dialog, menu). The rule is "when in doubt, no": Studio never pastes while an answer is pending and never repeats Enter unless the pasted text is provably still in the input box, because a stray Enter could approve a permission request. Changes here must be checked against the recorded real screens in `test/fixtures/claude-screens/` (tied to a Claude Code version).
- Restarts and permission toggles resume the tab's own conversation (`--resume <id>` read from `<claude config>/sessions/<pid>.json`) rather than `--continue`, which would pick the folder's latest conversation, possibly another tab's.

### Hooks and status line (all modes)

Studio talks to Claude Code without reading the screen wherever it can. `hooks.ts` writes a settings file and passes it with `--settings` (merging any `--settings` the user gave in `--claude-args`), in every mode:

- `PostToolUse` and `Stop` hooks run `dist/bin/hook.js`, which posts to `/api/hook` with a dedicated token. `IdleTracker` turns the events into "turn ended, with or without changes"; in desktop modes only a turn that used a file-writing or command-running tool restarts the app.
- A `statusLine` command runs `dist/bin/statusline.js`: Claude Code passes it a JSON (model, effort, `rate_limits` five_hour/seven_day, context, cost) on every change; the script posts the essentials as a `status` event and `parseStatus` (index.ts) validates them into the session's `ClaudeStatus`. The user's own status line (found with Claude Code's precedence in `findUserStatusLine`) is passed in `RIVERLOOP_STUDIO_USER_STATUSLINE` and executed by the script with the same stdin, so its output still shows.

### Claude bar (`src/web/claudeBar.ts`, `/api/claude`)

Model, effort (plus ultracode), permission mode, goal and usage of the active tab. Actions map to what a user would type: `ClaudeSession.runCommand` types `/model`, `/effort` (also `/effort ultracode on|off`, session only), `/goal`, `/usage` (short commands character by character, long ones as a bracketed paste) and submits through `submitPasted`, the same Enter logic as auto-send. It refuses unless the input box is recognised **and empty**; Claude Code draws an empty-box suggestion ("Try …") dimmed, or plain with `NO_COLOR` — `typedInput` ignores dim cells and a `Try "…"` with the cursor right after the prompt. `cycleMode` presses Shift+Tab (`ESC [ Z`) until `permissionMode` (tui.ts, footer text such as "⏵⏵ accept edits on") shows the target, at most one full cycle. Values follow changes made directly in the console: `scheduleModeCheck` re-reads the screen 250 ms after output for the mode and for `effortIndicator` (tui.ts: the right-aligned "◉ xhigh · ultracode · /effort" line just above the input box's top rule — the only source for ultracode, which the status line JSON lacks; with ultracode the box's TOP rule ends with a "ultracode ─" label (seen on a real 2.1.287 screen); `SOLID_RULE` accepts a label, the bottom rule must stay plain (`PLAIN_RULE`). The status line is re-run after `/model` and `/effort` typed in the console; for effort, whichever source changes last wins, and a missing value never clears a known one. `/model` and `/effort` also save the choice as the user's default in `~/.claude/settings.json` — that is Claude Code's behaviour; the tooltips say so. Verify changes here against a real Claude Code: the fake one only imitates it.

### Tab names

`SessionManager.rename` sets a tab name; names are remembered per Claude Code conversation id (`sessionNames` in the project's `state.json`) and restored when a tab resumes that conversation (the session emits `conversation` when `readConversationId` sees a new id). On the page, a double click on the tab arrives as a second `click` with `detail === 2`: the first click re-renders the tabs, so the browser never fires `dblclick`.

### Annotation flow

Overlay (or `ImageSurface`) collects the data and screenshot → Studio page owns the comment box, numbering and tray (`src/web/annotations.ts`) → `POST /api/annotation` → `annotations.ts` validates, writes PNG/JSON under the target project's `.claude/studio/annotations/`, composes the prompt → `ClaudeSession.paste()` writes it to the PTY with bracketed paste (and optionally submits). `composePrompt` has three wordings, chosen by `annotation.surface` (web page, Chromium desktop app, native window); the last line of the prompt must stay plain text, never an `@path`.

### Undo/redo of file changes (`history.ts`)

`ProjectHistory` snapshots the project's files before every request Studio sends to Claude (annotations, suggestions) and restores them on the page's Annulla/Ripeti buttons. It uses git purely as a content store: a private repository under Studio's run directory with `GIT_DIR`/`GIT_WORK_TREE` pointing at the project, so the project's own `.git` (if any) is never read or written and non-git projects work too. A snapshot is `git add -A` + `write-tree`; a restore is `read-tree --reset -u`, always preceded by a fresh snapshot so the index matches the working tree. Files ignored by the project's `.gitignore` are neither saved nor restored. The history is a linear list with a pointer; a redo is refused when the files changed after the undo, and undo/redo are refused while a Claude session is producing output. The archive is per run and deleted on exit.

### Project suggestions (`suggestions.ts`)

Studio never edits the target project's files to make itself work. `detectSuggestions` looks at the project (package.json, config files, git) for changes that would help — the source-location plugin missing, a Next.js `dev` script with a hard-coded port, `.claude/studio/` not git-ignored — and the page shows them in a popup (`src/web/suggestions.ts`). One click posts the suggestion **id** to `/api/suggestions/apply`; the companion writes the prompt and pastes it, submitted, into the active Claude session, so Claude Code makes the change under its own permissions. A suggestion is "done" when its condition no longer holds; "asked" and "not now" are per-run memory, "never" goes to `state.json`. New suggestions belong in `detectSuggestions`, each with its own prompt ending in a plain-text line.

### Source locations (`src/plugin/`)

`transform.cts` parses a file with `@babel/parser` and inserts `data-studio-src="rel/path:line:col"` on host JSX elements (never on components), keeping line numbers intact. `vite.ts`, `babel.cts`, `loader.cts` and `next.cts` (`withStudio`) are thin adapters, all inactive in production builds. The overlay reads the attribute in `collect.ts`.

### Security invariants

The console is equivalent to a shell, so these are load-bearing (details in the "Security" section of docs/guide.md; `security.ts` implements them):

- The session token is never put in a cookie (cookies are shared across ports on `127.0.0.1`). It arrives in the URL fragment, lives in the Studio origin's `localStorage`, and is presented as the `X-Studio-Token` header or as a WebSocket subprotocol. The iframe uses a separate low-privilege cookie valid only for the proxy.
- Every request is checked for `Host` (DNS rebinding); WebSockets and POST APIs also for `Origin` — only the Studio origin, never the proxy origin. `/api/hook` is the one exception by design: it is called by a script, so it requires its own token and rejects any request that has an `Origin`.
- The overlay runs in the app's origin (iframe or desktop app page) and is untrusted: it cannot create or send annotations on its own. Comments are typed in the Studio page and sending requires a gesture there. The page, not the message, decides an annotation's `surface`.
- Text written to the PTY goes through `sanitizeForTerminal`; files are written only under `.claude/studio/` with names generated by the companion. The one exception is undo/redo, which restores project files from Studio's own snapshots, only on a click in the Studio page.
- Nothing is pasted or submitted unless `screenState` is `'input'` — an unrecognised screen counts as "no".
- App-derived text in prompts goes through annotations.ts's `sanitizeInline`, which also turns `@` into `@\u200b` so a page cannot add `@file` mentions; the user's comment keeps its `@`.
- The overlay (iframe or Electron page) never receives comment text (`forAppOverlay`), and drafts/undo/tool changes from it are ignored while the page is in Navigate mode.
- Studio page and app proxy are both `127.0.0.1:<port>`: `claimPort` with a `role` never reuses a port for the other role (browser-side storage and Service Workers outlive a run), and the proxy rejects `Service-Worker: script` requests.
- The token from the link replaces the stored one only after the server accepts it; on Linux and macOS the browser is opened through a 0600 launcher file so the link never appears on a command line.

### State on disk

- Target project: `.claude/studio/` (annotations, `state.json` with restart-on-idle, dismissed suggestions and tab names). Never anything that changes what Studio runs or how much Claude Code may do: a cloned repository controls these files. `studioDir()` refuses symlinked or escaping `.claude/studio` folders.
- Per-user run dir (port locks and `ports/roles.json`, open instances, logs, hook settings files) and config dir (`recent.json` with each project's launch options, `projects.json` with the permissions choice, `settings.json` with the language), resolved in `util.ts` `runDir()` and `paths.ts` `studioConfigDir()`. Tests redirect them with `RIVERLOOP_STUDIO_RUN_DIR` and `RIVERLOOP_STUDIO_CONFIG_DIR`; `CLAUDE_CONFIG_DIR` redirects where conversation ids are read from.
- Other env switches: `RIVERLOOP_STUDIO_DEBUG` (set by `--debug`), `RIVERLOOP_STUDIO_CONPTY_DLL=1` (Windows: bundled ConPTY), `RIVERLOOP_STUDIO_NO_CAPTURE=1` (window mode: skip OS capture and use browser sharing), `RIVERLOOP_STUDIO_DETACHED` / `RIVERLOOP_STUDIO_LOG` (set for instances launched in the background from another project's page).

## Platform notes

Process handling differs per OS and is centralised in `src/server/util.ts` (`resolveExecutable`, `commandLine`, `killTree`): Windows resolves `claude.exe` or npm `.cmd` shims and kills trees with `taskkill /T /F`; Unix kills process groups. `DesktopApp.stop()` first asks the app to close (so it can save state), then forces.

On Windows, ConPTY delivers pasted input in chunks, so nothing may assume a bracketed paste arrives in one read (the fake Claude reassembles it and records a `paste` event).

What is verified where: web mode on Linux and Windows; phases 3–5 (plugins, electron and window modes, hooks with a real Claude Code) on Windows 11 only. The macOS and Linux window capturers in `wincapture.ts` are written but have never been run.
