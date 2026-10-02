English | [Italiano](guida.md)

# Riverloop Studio

Run it from a project folder and it opens a local page with your app under development on one side and the **real Claude Code console** on the other. Mark up what to change on the app (an element, an area or a freehand drawing), write a comment, and the annotation reaches Claude Code as a message in the same session.

> Independent project, not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.

The app can be of three kinds:

- **web** (default): the project's dev server, shown in an iframe;
- **electron**: an Electron app, or another Chromium-based desktop app (WebView2, so Tauri on Windows too), mirrored live and usable from the page;
- **window**: any native window (WPF, Windows Forms, Qt, Flutter…), shown as a captured image.

You can keep several Claude sessions open on the same project (console tabs, even in separate windows) and open, switch and close other projects from the page.

## Contents

- [Platform support](#platform-support)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [The Studio page](#the-studio-page)
- [Desktop apps](#desktop-apps)
- [Exact file and line](#exact-file-and-line)
- [Language](#language)
- [Claude Code compatibility](#claude-code-compatibility)
- [Security](#security)
- [How it works](#how-it-works)
- [Platform notes](#platform-notes)
- [Known limits](#known-limits)
- [Roadmap](#roadmap)
- [Development and tests](#development-and-tests)
- [Project structure](#project-structure)
- [License](#license)

## Platform support

| Mode | Windows 11 | Linux | macOS |
|---|---|---|---|
| `web` | Verified | Verified | Untested |
| `electron` | Verified | **Experimental** | **Experimental** |
| `window` | Verified | **Experimental** | **Experimental** |

The desktop modes (`electron`, `window`) have been verified on Windows 11 only. On macOS and Linux the code for window capture, the Electron hook and app shutdown is written but **has never been run**: expect problems, and please report them. Web mode has not been tried on macOS yet.

## Requirements

- Node.js 20 or later (22 LTS recommended).
- Claude Code installed and already signed in (`claude --version` must answer).
- A Chromium-based browser (Chrome, Edge) or Firefox. The Ctrl+W, Ctrl+T and Ctrl+N shortcuts reach Claude only in Chrome and Edge, in full screen.
- `git` installed, for [Undo and Redo](#undo-and-redo-of-file-changes) (the project itself does not need to be a git repository).
- Desktop apps need nothing else on Windows. On macOS `window` mode uses `screencapture` (the terminal needs the "Screen Recording" permission); on Linux with X11 it uses `wmctrl` and ImageMagick (`sudo apt install wmctrl imagemagick`). Where capture is not possible (Wayland), the window is shared from the browser instead.

## Installation

```bash
npm install -g riverloop-studio@latest
# or, without installing
npx riverloop-studio@latest
```

From source:

```bash
cd riverloop-studio
npm install        # installs dependencies and builds (the "prepare" script)
npm link           # makes the riverloop-studio command available
```

On Windows run the same commands from PowerShell or Command Prompt. On WSL run them inside WSL, where the project runs too.

**node-pty** is a native module. If no prebuilt binary matches your platform, npm compiles it, which needs build tools:

- Windows: Visual Studio Build Tools;
- macOS: Xcode Command Line Tools (`xcode-select --install`);
- Linux: `python3`, `make` and `g++` (e.g. `sudo apt install build-essential python3`).

When `node-pty` cannot be loaded, Studio falls back to the `@lydell/node-pty` fork, which ships prebuilt binaries for more platforms (Linux included). If installation reports compile errors and Studio does not start, install the build tools and run the install again.

npm 11 and later may warn that `node-pty` has install scripts "not yet covered by allowScripts": you can ignore it. Without its script `node-pty` uses its prebuilt binaries (Windows, macOS), and Studio falls back to `@lydell/node-pty` elsewhere. Verified on Windows 11 with npm 11.17.

## Usage

```bash
cd my-next-project
riverloop-studio
```

What happens:

1. Studio checks the prerequisites.
2. On first run it offers to add `.claude/studio/` to `.gitignore`.
3. It starts `npm run dev` on port 3000. If the port is busy (another app, or another Studio session), it still starts this project's dev server, on the next free port. Studio never attaches to a server it did not start; use `--no-dev` for that.
4. It opens the browser on the link carrying the session token.
5. Claude Code starts when the page connects, already sized to the panel.

Ctrl+C in the launching terminal stops Claude Code, the dev server and the companion, in that order, without leaving orphan processes.

### Multiple Claude sessions and projects

**Several sessions on the same project**

- The **+** in the console header opens another Claude Code session in the project folder: "New session" or "Resume a conversation…" (`claude --resume`). Up to 8 sessions per project.
- Each tab is a separate `claude` process with its own conversation and permissions. The dot shows its state: green running, yellow starting, grey exited. An orange border means "no confirmations".
- Annotations go to the active tab; the Send button's tooltip names it.
- "Resume" after an exit, and changing permissions, resume *that tab's* conversation (`claude --resume <id>`), not the folder's latest one, which could belong to another tab. Studio reads it from `~/.claude/sessions/` (or `CLAUDE_CONFIG_DIR`), which Claude Code keeps up to date even after `/clear`.
- The **×** closes the tab (with a second confirmation click) and stops its process. The conversation stays available to resume.
- **Rename a tab** with a double click on its name (or F2): for example one session for bugs, one for the UI. Enter saves, Esc cancels, an empty name goes back to "Claude 2". The name is tied to the Claude Code conversation: when you resume that conversation, in this or a later run, the tab gets its name back (saved in the project's `.claude/studio/state.json`).

**One session per window**

- "Open this session in a new window" (in the **+** menu) opens the same page with `?s=2`, for example on a second screen.
- Each window shows its own session and app. All of them see the same tabs and the same changes.
- On reload, a window stays on its tab.

**Several projects**

- Each project has its own Studio instance. Run `riverloop-studio` in each folder, or do everything from the page.
- The project name at the top left opens the **Projects** menu:
  - it lists the Studio instances open on this computer;
  - **Open** brings one up in a new browser tab;
  - **Close** stops that project's Claude Code, dev server and Studio, like Ctrl+C (second click to confirm);
  - **Open another project**: type the folder path (or pick a recent one). Studio starts in the background in that folder, with its own dev server and Claude Code, and opens in a new tab. If the project is already open, that instance is opened.
- Instances started from the page have no terminal: close them from the Projects menu. Their log is in the `logs` subfolder of Studio's run directory (see below).
- Each instance uses its own ports: Studio page (4700, 4702, …), proxy (the next one) and dev server (3000, 3001, …). A port used once for an app's proxy is never used for a Studio page, and vice versa (see Security).
- **Opening a project from the menu reuses how it was last started**: mode, app or dev-server command, port, window title. A desktop app reopens as a desktop app. Recent projects show their mode next to the name. These options are remembered per user (`recent.json` in the config directory, see [Language](#language)), never in the project.
- Ports are reserved with lock files (`ports` subfolder), so two sessions started together never pick the same port. Locks left by closed sessions are ignored and removed.
- Studio's run directory is private to the user: `%LOCALAPPDATA%\riverloop-studio` on Windows, `~/Library/Caches/riverloop-studio` on macOS, `$XDG_RUNTIME_DIR/riverloop-studio` (or `~/.cache/riverloop-studio`) on Linux. It holds reserved ports, open instances and logs.
- If the dev server exits at once because someone took its port in the meantime (`EADDRINUSE`), Studio restarts it on another free port and updates the iframe.
- The dev server receives its port in the `PORT` variable. If the `dev` script hard-codes the port (e.g. `next dev -p 3000`), Studio cannot move it and says so: remove `-p` from the script or start Studio with `--port`.

Examples:

```bash
riverloop-studio --port 5173                      # Vite (the port is detected from the output anyway)
riverloop-studio --dev-cmd "pnpm dev" --port 3001
riverloop-studio --no-dev                         # this project's dev server is already running on 3000
riverloop-studio --resume --claude-args "--model sonnet"
riverloop-studio --permissions skip               # Claude Code without permission prompts
riverloop-studio --lang en                        # English UI and prompts for this run

riverloop-studio --mode electron                  # Electron app: runs "npm run dev" (or "npm start")
riverloop-studio --mode electron --app-cmd "npm run tauri dev"      # Tauri on Windows (WebView2)
riverloop-studio --mode window --app-cmd "dotnet run" --restart-on-idle
riverloop-studio --mode window --no-dev --window-title "Inventory" # window already open
```

### Options

| Option | Default | Effect |
|---|---|---|
| `--mode <web\|window\|electron>` | `web` | Kind of app: web dev server, native window, Electron/Chromium app. See [Desktop apps](#desktop-apps). |
| `--port <n>` | `3000` | Preferred dev server port. If busy, Studio uses the next free one; if the server announces a different one at startup (Vite), Studio adopts it. |
| `--studio-port <n>` | `4700` | Port of the Studio page. The app proxy uses the next free one. |
| `--dev-cmd "<cmd>"` | `npm run dev` | Dev server command. It receives `PORT` and `BROWSER=none`. |
| `--app-cmd "<cmd>"` | `electron`: the `dev` or `start` script | Command that starts the desktop app. Required in `window` mode (unless `--no-dev`). `{port}` in the command becomes the debugging port. |
| `--window-title "<text>"` | – | `window` mode: text contained in the title of the window to show. |
| `--cdp-port <n>` | `9222` | `electron` mode: the app's debugging port. If busy, Studio uses the next free one. |
| `--app-window <background\|normal>` | `background` | `electron` mode: keep the app window minimized (you use the app from the Studio page) or leave it on the desktop. Applies to Electron apps started by Studio. |
| `--restart-on-idle` | saved choice, else off | Desktop apps: restart the app when Claude Code finishes a reply in which it changed something. |
| `--no-dev` | off | Do not start the dev server (or desktop app); attach to the one already running on `--port`, on `--cdp-port`, or to the given window. |
| `--resume` | off | Start `claude --resume` instead of a new session. |
| `--claude-args "<args>"` | – | Extra arguments for `claude`. |
| `--claude-bin <path>` | `claude` | Claude Code executable, if it is not on the PATH. |
| `--auto-send` | off | Start with "Auto-send" on. |
| `--permissions <ask\|skip>` | saved choice, else `ask` | `ask`: Claude Code's standard permissions. `skip`: start `claude --dangerously-skip-permissions`. Applies to this run. |
| `--dangerously-skip-permissions` | off | Same as `--permissions skip`. |
| `--lang <en\|it>` | see [Language](#language) | Language of the UI, terminal messages and prompts, for this run only. |
| `--no-open` | off | Do not open the browser; only print the link. |
| `--debug` | off | Print technical details (ports, auto-send) useful when reporting a problem. |

## The Studio page

- **Split view**: drag the divider (double-click = 60/40); the ratio is remembered. Buttons at the top swap the sides or show a single panel.
- **URL bar**: back, forward and reload, plus a path field (e.g. `/dashboard`). The bar follows the app's own navigation too.
- **Viewport**: Desktop (full width), Tablet (768 px) and Mobile (390 px). If the panel is narrower, the app is scaled.
- **Console**: the real `claude` process in a pseudo-terminal, so menus, colours, permission prompts and `/` commands are exactly as in the terminal.
  - Reloading the page restores the screen and keeps the session.
  - Several browser tabs see the same session.
  - Shift+Enter inserts a newline.
  - Ctrl+C copies if there is a selection, otherwise interrupts Claude.
  - Ctrl+V pastes text. If the clipboard holds an image, it is passed to Claude Code.
  - The dot shows the connection: green connected, yellow reconnecting, red disconnected.
- **Dev server banner**: if the server stops, the last log lines appear with a "Restart dev server" button. The console stays live, so you can ask Claude to fix the error.
- **Claude Code permissions**: the button at the top of the console shows the mode and switches it.
  - **Standard permissions** (default): Claude Code asks according to its own mode (auto, manual, accept edits…) and your settings. Inside the console you switch modes with Shift+Tab as usual.
  - **Skip all confirmations**: Claude Code restarts with `--dangerously-skip-permissions` and resumes the same conversation. Edits and commands run without asking: use it only on projects you trust. The button turns orange.
  - The choice is remembered per project **for your user only** (`projects.json` in the config directory), never in the project folder: a cloned repository cannot turn confirmations off. `--permissions` and `--dangerously-skip-permissions` apply only to the run where you pass them.
  - Alternatively, with `--claude-args "--allow-dangerously-skip-permissions"` the no-confirmation mode is only made available in the Shift+Tab cycle, without being active at startup.

### The Claude bar

Under the console tabs, a bar shows and changes the active tab's Claude Code settings. Each control does exactly what you would type in the console, so Claude Code's own rules apply:

- **Model**: `default`, `opus`, `sonnet`, `haiku`, `fable` (`/model <name>`). Claude Code also saves it as the default for new sessions.
- **Effort**: auto, low, medium, high, xhigh, max (`/effort <level>`). Also saved as the default. At the bottom of the same menu, **ultracode** turns on or off (`/effort ultracode on|off`): dynamic workflows on every task, for this session only, with the effort level unchanged. When it is on the bar shows it next to the level ("Effort: xhigh · ultracode").
- **Mode**: manual, accept edits, plan, auto, and bypass permissions when the tab runs without confirmations. Studio presses Shift+Tab for you until Claude Code shows the chosen mode, and stops if it never appears.
- **Goal…**: a goal Claude keeps working on, answer after answer, until it is met (`/goal <condition>`); "Clear goal" removes it.
- **Usage**: plan usage in the last 5 hours and 7 days, and context used; the tooltip says when the limits reset. A click opens `/usage` in the console. Usage appears after Claude's first answer, and only with a Claude subscription.

How Studio knows the current values: model, effort and usage come from Claude Code's **status line**, a JSON that Claude Code passes to a command on every change. Studio adds its own status line command through `--settings` (like the hooks, without touching your settings). If you already have a status line, Studio runs yours with the same data and shows its output, so your status line keeps working. The mode is read from the text under the input box ("⏸ manual mode on", "⏵⏵ accept edits on"…), effort and ultracode also from the indicator above it ("◉ xhigh · ultracode · /effort"; ultracode is not in the status line). So the bar follows changes you make directly in the console too: Shift+Tab, `/effort …` and `/model …` typed in the console show up in the bar right away.

Commands are sent only when Claude Code shows its input box and the box is empty: with a permission prompt open, or text you have not sent yet, the page tells you why and does nothing.

### Annotating

| Tool | Key | How |
|---|---|---|
| Browse | Esc | Normal use of the app. |
| Element | S | Hover an element (↑ ↓ for parent and child) and click. |
| Area | R | Drag a rectangle: position, container, nearest heading and up to 10 contained elements are recorded. |
| Draw | D | Freehand (underline, circle, strike out): the elements it passes over are recorded. |
| Send | Ctrl+Enter | Send the pending annotations. |
| Undo last | Ctrl+Z | Remove the last unsent annotation. |

**Comment**

- After a selection the comment box opens: Enter saves, Shift+Enter inserts a newline, Ctrl+Enter saves and sends, Esc cancels.
- Annotations get a number (a badge on the page) and stay anchored to their elements while scrolling, inner scroll containers included.
- Click a badge to edit or delete its annotation.

**Shortcuts**

- They work when focus is on the app panel.
- Inside the app, in Browse mode, keys go to the app. To pick a tool use the toolbar, or click the panel's toolbar first.

**The tray at the bottom**

- Lists the annotations with thumbnail, state (pending, sent) and delete.
- Shows the last message pasted into the console, useful because Claude Code collapses long pastes into "[Pasted text]".

### Undo and Redo of file changes

At the top of the page, **Undo** puts the project's files back as they were before the last request Studio sent; **Redo** reapplies the changes. You can go back several requests, one step at a time. In web apps hot reload shows the result immediately; a desktop app with "Restart on idle" on is restarted.

- **The project does not need git, and your repository is never touched.** Before each request Studio snapshots the files into its own archive outside the project (in Studio's run directory): no commits, no branches, no staging. The computer only needs `git` installed, which Studio uses as a content store.
- Snapshots cover the files git would track: files ignored by the project's `.gitignore` (`node_modules`, builds, `.env`…) are neither saved nor restored.
- Undo removes everything that changed since that point, including edits made by hand or asked of Claude directly in the console.
- After an Undo, if the files change again (by you or by Claude), Redo is no longer available: restoring the old state would erase that work.
- While Claude Code is working, Undo and Redo wait: rolling back files in the middle of an edit would leave them inconsistent.
- On the next request Studio tells Claude that the files changed under it, so it re-reads them before editing.
- The history lasts while Studio is open: the archive is deleted on exit.

### Project suggestions

Studio never edits your project's files in order to work. When it sees a configuration change that would make it work better, it **suggests** it in a box in the corner of the app panel:

- the box says what would change and why, and "What will be asked of Claude" shows the exact message;
- **Ask Claude Code** sends that message, already submitted, to the active console tab. Claude Code makes the change under its own permissions (with standard permissions it asks as usual);
- **Not now** postpones it: it stays available from the light-bulb button at the top;
- **Don't ask again** dismisses it for this project (saved in `.claude/studio/state.json`).

Current suggestions:

| Suggestion | When it appears |
|---|---|
| Exact file and line for every element | React project with Next.js, Vite or electron-vite without the plugin in its configuration (see [Exact file and line](#exact-file-and-line)). |
| The `dev` script hard-codes the port | Next.js with `-p`/`--port` in the script: Studio cannot move the dev server if the port is busy. |
| Keep annotations out of the repository | A git repository that does not ignore `.claude/studio/` (unless you already declined at startup). |

A suggestion disappears by itself once the change is made. If Claude Code is waiting for your answer (permission prompt, menu), the request is not pasted: answer in the console first.

### What Claude receives

Studio saves everything under `.claude/studio/annotations/` and pastes a short message into the console using bracketed paste, so newlines do not submit it halfway. For example (the exact wording depends on the [language](#language)):

```
Requested changes on page /dashboard (viewport 1440×900):

1. Element `main > section.hero > h1` — text "Welcome to AgendaCura"
   Request: make the title smaller and left-align it
   React component: Hero (inside HomePage)
   Screenshot: @.claude/studio/annotations/20261001-143512-1.png

2. Area of 320×180 px (on screen: bottom right)
   Position in the page: x 1000–1320, y 1500–1680 px (on screen x 1050–1370, y 650–830, page scrolled 850 px vertically)
   Located: inside `#pricing`, below the heading "Our prices"
   Contains: `button.cta` "Book now", `p.note`
   Request: the button should be green like the one in the header
   Screenshot: @.claude/studio/annotations/20261001-143512-2.png

Full details (HTML, styles, position): @.claude/studio/annotations/20261001-143512.json
In the screenshots each annotation is highlighted with its number.
```

For areas and drawings the message always says where they are: coordinates in CSS px from the top-left corner of the page (and on screen, if the page was scrolled), the smallest element containing the area and the nearest heading above it. If the area contains no whole element (it covers part of an image or a section), the message says so. The last line is always plain text: a message ending with an `@…` path would open Claude Code's file suggestions.

**Sending**

- With "Auto-send" off (default) the message stays editable in the console and you press Enter yourself. After sending from the page, focus moves to the console.
- With "Auto-send" on, Studio pastes the message, waits for Claude Code to finish processing the paste (on Windows ConPTY delivers input in chunks, and an Enter sent too early would land inside the text) and presses Enter.
  - It then checks the screen: if the text is still in the input box (`[Pasted text #N]` placeholder or the message's first line), it presses Enter again, at most twice.
  - It never repeats Enter while a permission prompt or a menu is on screen: there an Enter would approve the request. When in doubt it does nothing.
  - If the message does not appear to have gone out, the page shows a notice: just press Enter in the console.
- If Claude Code is waiting for your answer (permission prompt, folder trust question, menu), Studio pastes nothing: the text would end up in the prompt. The page says so, moves focus to the console, and the annotations stay pending.
- If Claude is working, the message joins its queue, as when you type by hand.

**JSON and screenshots**

- For each annotation the JSON holds: a stable selector, trimmed HTML, visible text, computed styles, position, viewport and scroll, contained or touched elements, and React components.
- React components are derived in development from the "owner" chain, Server Components included. With React 18 (`_debugSource`) or a `data-studio-src` attribute, file:line is included too.
- Screenshots (the area plus a 40 px margin, with the marks drawn on top) are taken with `html-to-image`. If capture fails (tainted canvases, cross-origin images), the annotation is sent anyway and the message says so.
- Files older than 7 days are deleted at startup.

## Desktop apps

With `--mode electron` or `--mode window` the left panel shows a desktop app instead of the iframe. The console, tabs, tray and sending to Claude are the same. Instead of the URL bar there is the window title (and a list, if the app has several windows), a button to bring it to the front, and **Restart app**.

### electron mode (Electron, WebView2, Chromium apps)

```bash
cd my-electron-app
riverloop-studio --mode electron
```

- Studio starts the app (the project's `dev` script, else `start`, or `--app-cmd`) and connects to its page through Chromium's **remote debugging port**.
- No change to the app's command or code is needed:
  - for Electron, Studio loads a small hook into the main process (`NODE_OPTIONS=--require`) that opens the port. It works with `electron .`, electron-vite, Electron Forge and npm scripts, in development only;
  - for WebView2 (Tauri on Windows, .NET apps) it sets `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`;
  - for other Chromium apps put the port in the command: `--app-cmd "my-app --remote-debugging-port={port}"`.
- The app's page appears in the panel **live** and is used from there: clicks, drags, wheel and keyboard reach the app.
- The real window of an Electron app started by Studio stays **minimized**: it does not pop up at startup or on every restart, and does not steal focus from the browser. To see it, use the "bring to front" button or the taskbar; from then on it behaves like a normal window. With `--app-window normal` it stays on the desktop as usual. (WebView2 and other Chromium apps keep their window where it is: Studio does not enter their process.)
- The mirror stays live even when the window is covered or minimized, also for an app that was already open (`--no-dev`). If the app's page stops painting anyway (window never shown, page blocked by a dialog), Studio says so and offers **Show the window**.
- The tools are those of web apps: **Element**, **Area**, **Draw**, with selector, HTML, styles and React components. The screenshot is taken by the app's engine, so it is faithful for canvases and video too.
- Native menus, dialogs and `<select>` dropdowns are not part of the page: they are visible only in the real window.

```
Requested changes on window «Inventory» of the desktop app, page /index.html#/customers (viewport 1184×720):

1. Element `#title` — text "Customers"
   Request: make the title blue
   Screenshot: @.claude/studio/annotations/20261001-212433-1.png
```

### window mode (native window)

```bash
riverloop-studio --mode window --app-cmd "dotnet run"
```

- Studio starts the app, finds the windows of its processes and shows **an image** of them, refreshed a couple of times per second even when the window is covered. You use the app in its own window; in the panel you look at it and annotate it.
- With `--no-dev` nothing is started: Studio shows the window whose title contains `--window-title`, or lets you pick one from a list.
- **Area** and **Draw** are drawn on the image. On the first gesture the image freezes (a full-resolution still), so the marks match what you see; it goes live again once the annotations made on it are sent or removed, or with the **back to live** button.
- **Element** (on Windows) recognises UI controls through UI Automation: type, name, `AutomationId`, class and toolkit. These are the names Claude finds in the code (`x:Name`, a control's `Name`).
- **Likely source**: when you send, Studio searches the project's source files for the control's `AutomationId` (or, without one, its text in quotes) and adds the lines it finds ("Likely source of the control: `Form1.Designer.cs:42`"). It is a hint for Claude, limited to 1.5 seconds and 5,000 files, skipping `bin`, `obj`, `node_modules` and similar folders.
- **Area** (on Windows) also lists the controls inside the rectangle ("Contains: `Edit «Name»` (AutomationId `txtName`), …").
- Measurements are in app pixels. A DPI-unaware app on a scaled screen is captured at its real size, not the size Windows scales it to.
- A minimized window cannot be captured. The page says so and offers **Show the window**, which makes it visible again without giving it focus.
- If the system does not allow capture (Wayland, missing permissions, PowerShell blocked) the page offers **Share the window from the browser**: pick the window in the browser's picker and annotate it the same way, without the Element tool. `RIVERLOOP_STUDIO_NO_CAPTURE=1` forces this path.

For each annotation Claude receives a crop of the area and, once per batch, the whole window with all the marks (example; wording and file names depend on the language):

```
Requested changes on window «Customers» of the desktop app (522×392 px):

1. Element `Button «Save»` (AutomationId `btnSave`, class `WindowsForms10.BUTTON`, WinForm)
   Position in the window: x 281–391, y 103–135 px (top centre)
   Located: inside Window «Customers»
   Request: make the button wider
   Screenshot: @.claude/studio/annotations/20261001-213512-1.png

2. Area of 220×64 px (in the window: left, middle)
   Position in the window: x 27–247, y 153–217 px (from the top-left corner)
   Request: taller rows
   Screenshot: @.claude/studio/annotations/20261001-213512-2.png

Whole window with annotations 1, 2: @.claude/studio/annotations/20261001-213512-window-1.png

Full details (position, UI elements): @.claude/studio/annotations/20261001-213512.json
In the screenshots each annotation is highlighted with its number.
```

### Restart on idle

A native app has no hot reload: it must be restarted to show changes.

- With `--restart-on-idle`, or the **Restart on idle** switch in the toolbar, Studio restarts the app when Claude Code finishes a reply **in which it changed something** (it used Edit, Write, MultiEdit, NotebookEdit or Bash). A reply made only of words restarts nothing.
- The switch's choice is saved per project in `.claude/studio/state.json`.
- It applies to apps started by Studio. A restart first asks the app to close (as when closing its window), then forces it if it has not exited within 4 seconds.
- To know when Claude finishes, Studio does not read the screen: it starts `claude` with an extra settings file (`--settings`) that registers two hooks, `PostToolUse` and `Stop`. Your Claude Code settings are not touched; a `--settings` passed through `--claude-args` is merged, not replaced.
- **Restart app** in the toolbar does it by hand at any time.

## Exact file and line

Without any setup, Claude receives selector, text, classes and React component, and finds the code by searching for them. With the build plugin every element carries its file and line (`data-studio-src="app/page.tsx:16:11"`) and the message includes them:

```
1. Element `main > section.hero > h1` — text "Welcome to AgendaCura"
   Request: make the title smaller
   React component: Hero (inside HomePage)
   Source: app/page.tsx:16:11
```

The easiest way: when the plugin is missing, the Studio page suggests it and, with one click, asks Claude Code to set it up (see [Project suggestions](#project-suggestions)). By hand:

The plugin is active only in development: production builds are unchanged. Make the package available to the project (`npm i -D riverloop-studio`, or `npm link riverloop-studio` for a local checkout) and add one line to the configuration.

**Next.js** (Turbopack and webpack):

```ts
// next.config.ts
import { withStudio } from 'riverloop-studio/next';

export default withStudio({ /* your configuration */ });
```

**Vite** (before the React plugin):

```ts
// vite.config.ts
import studio from 'riverloop-studio/vite';

export default defineConfig({ plugins: [studio(), react()] });
```

**Babel** (any project that compiles JSX with Babel):

```json
{ "plugins": ["riverloop-studio/babel"] }
```

- HTML elements, SVG elements and custom elements are marked; components (`<Card>`, `<motion.div>`) are left alone, because an extra attribute could end up in their props.
- Renderer files that produce no DOM elements (React Three Fiber, React Native, react-pdf…) are left as they are.
- Under the project's tests (Vitest, Jest, `NODE_ENV=test`) the plugin stays off, so snapshots do not change.
- It works for Server Components too, and for Electron apps whose renderer uses Vite or Next.js.
- For other tools with webpack-style loaders there is `riverloop-studio/loader`.

## Language

The UI, the terminal messages and the prompts sent to Claude Code are available in **English** and **Italian**. The language is chosen in this order:

1. `--lang en|it` (this run only);
2. the `RIVERLOOP_STUDIO_LANG` environment variable;
3. the language picked in the Studio page settings, saved per user in `settings.json` in Studio's config directory: `%APPDATA%\riverloop-studio` on Windows, `~/Library/Application Support/riverloop-studio` on macOS, `$XDG_CONFIG_HOME/riverloop-studio` or `~/.config/riverloop-studio` on Linux;
4. the system language;
5. English.

## Claude Code compatibility

Auto-send reads Claude Code's terminal screen heuristically, to tell whether the input box is showing and whether the pasted text is still in it. The recorded screens used by the tests come from Claude Code 2.1.286; the end-of-turn hooks, the status line and the Claude bar were tested with a real Claude Code 2.1.287.

If a Claude Code update changes how the screen looks, auto-send may stop pressing Enter. By design it never presses Enter when it is unsure, so the worst case is that you press Enter yourself. The end-of-turn hooks use Claude Code's settings interface rather than the screen.

If this happens, please open an issue with the output of `claude --version` and of a run with `--debug`.

## Security

The console is equivalent to a shell on your computer, so Studio accepts only local, authenticated connections.

> **Development use only.** To show your app in an iframe, the app proxy **removes `Content-Security-Policy` and `X-Frame-Options`** from the app's responses (and drops `Domain`/`Secure` from its cookies so they work on `127.0.0.1`). Never point Studio at a production server or at a site you do not control. To test your real CSP, open the app directly on `localhost`.

To report a vulnerability privately, see [SECURITY.md](../SECURITY.md).

- **Loopback only**: page and proxy listen on `127.0.0.1`.
- **Session token** (32 random bytes, new on every run):
  - it arrives in the link's *fragment* (`#t=…`), which the browser never sends to the server;
  - the page moves it into its own origin's `localStorage` and removes it from the address bar;
  - it is presented to the API in the `X-Studio-Token` header and to WebSockets as a subprotocol.
- **No cookie for the console.** Cookies apply to every port of `127.0.0.1`, so a cookie holding the token would reach any other local service. The app iframe uses a separate cookie (HttpOnly, SameSite=Strict) valid only for the proxy: if it leaked, it would give access to the app (already reachable locally), not to the console.
- **Origin check**: the console WebSockets accept only the Studio page's origin, not the proxy's nor external pages. POST APIs also check Origin and Content-Type.
- **Host check**: requests with a Host other than `127.0.0.1:<port>` or `localhost:<port>` are rejected (DNS rebinding defence).
- **The app cannot drive Claude.**
  - The overlay lives in the app's origin and talks only to the Studio page, via `postMessage` with origin and source checks.
  - Comments are typed in the Studio page, and sending starts only from a gesture there (button, Ctrl+Enter in the comment box or the panel).
  - A script of the app (or a third-party script it loads) therefore cannot create or send annotations. Ctrl+Enter pressed inside the app asks for confirmation (Enter on the "Send" button).
  - Data read from the page (text, HTML, selectors) still reaches Claude: it is the app's content, treat it as such.
- **PTY escaping**: escape sequences and control characters are stripped from text written to the PTY.
- **Files**: Studio writes only under the project's `.claude/studio/`, with names generated by the companion. The one exception is Undo/Redo, which restores project files from Studio's own snapshots, and only on a click in the page.
- **Suggestions**: the request text for Claude is written by the companion (the page only sends which suggestion), starts only with a click in the Studio page, and never while Claude Code is waiting for an answer.
- **Open projects**: each instance registers itself in the user's private run directory (`instances` subfolder, mode 0700 on Unix systems, never in the shared `/tmp`). The file contains the link with the token, readable only by the user, who already has access to those consoles. Logs of instances started from the page, which contain the link, are there too (0600). Before listing an instance Studio checks that it really answers to its token; entries left by instances that died are removed. Starting or closing a project from the page requires the token, like the console.
- **Desktop apps**:
  - the `/ws/app` channel (app images, mouse and keyboard) requires the token and Origin, like the console;
  - in `electron` mode the overlay lives in the app's page, as with web apps: its messages go through the companion to the Studio page, which validates them, and an app script cannot create or send annotations;
  - the app's debugging port listens only on `127.0.0.1` (Chromium guarantees it) and only the companion uses it. Anyone who can open local connections on your computer can reach it while the app is open, though: it is the same exposure as `electron --remote-debugging-port`, and only in development;
  - in `window` mode Studio captures only the chosen window, and only when the authenticated Studio page asks;
  - the end-of-turn hooks call `/api/hook` with a separate token that opens neither the console nor the API: if it leaked it could only restart the app. The endpoint rejects requests that carry an Origin (i.e. browser requests).
- **Claude Code permissions**: by default they stay standard and Studio does not change Claude Code's settings. `--dangerously-skip-permissions` is enabled only by explicit choice (console button or command-line option) and the launching terminal flags it. Auto-send never presses Enter on a permission prompt, nor on a screen it does not recognise: it pastes and presses Enter only when Claude Code's input box is certainly showing. The same rule applies to the Claude bar.
- **Saved choices outside the project**: the permissions choice and the launch options of each project are stored in your user config directory. Files in the project (`.claude/studio/`) cannot turn confirmations off or change how Studio starts the app. Studio refuses `.claude/studio` folders that are symbolic links or point outside the project.
- **Separate origins over time**: the Studio page and the app proxy are both on `127.0.0.1`, so Studio remembers which ports served which role and never swaps them. The proxy also refuses Service Worker scripts from the app, which would otherwise outlive Studio in the browser.
- **The app does not see your comments**: the overlay inside the app receives the annotation marks without their text. It also cannot open the comment box or delete annotations unless you picked an annotation tool in the page.
- **App text in prompts**: `@path` mentions in text that comes from the app (labels, texts, source paths) are neutralised with an invisible character, so a page cannot make Claude Code attach files. Your own comments keep their `@` mentions.
- **Token in the link**: a token in the link replaces the saved one only after the server accepts it, so a page that opens Studio with a fake link cannot log you out. On Linux and macOS the browser is opened through a private local file instead of putting the link on its command line, where other users could read it.

## How it works

- **CLI** (`bin/cli.ts`): checks prerequisites and tokens, then manages the dev server (or desktop app), the `claude` sessions, the companion and orderly shutdown.
- **Companion** (`src/server/index.ts`): Studio page, API, WebSockets `/ws/term` (PTY), `/ws/overlay` (the page's control channel: dev server status, auto-send outcome) and, in desktop modes, `/ws/app`.
- **PTY** (`src/server/pty.ts`): `claude` in `node-pty`, with an `@xterm/headless` "mirror" terminal. On every connection a tab receives the exact screen, modes included, then the live output, with no gaps or duplicates. The same mirror lets auto-send read the input box (`src/server/tui.ts`).
- **Ports** (`src/server/portlock.ts`): port reservation across sessions with lock files.
- **Sessions** (`src/server/sessions.ts`): the console tabs, one `ClaudeSession` per `claude` process, with the conversation tracked in `~/.claude/sessions/<pid>.json`.
- **Projects** (`src/server/projects.ts`): registry of open instances, recent projects, background launch and closing of other instances.
- **Proxy** (`src/server/proxy.ts`): a dedicated port (studio-port + 1) at the root, so Next.js absolute paths (`/_next/...`) work.
  - Injects the overlay script before `</body>`, streaming, for Next.js pages that arrive in chunks.
  - Forwards HMR WebSocket upgrades (Next.js with Turbopack and webpack, Vite).
  - Rewrites `Location` and presents `localhost` as Origin to Next.js dev endpoints (`allowedDevOrigins`). Server Actions keep working.
- **Overlay** (`src/overlay/`): a vanilla script in a closed Shadow DOM, attached outside `<body>` after load so it does not disturb React hydration. It handles modes, anchored marks, data collection and screenshots. It talks to Studio through an interchangeable channel (`transport.ts`): `postMessage` in the web app iframe, the debugging port in Chromium apps.
- **Desktop apps**:
  - `src/server/desktop.ts` manages the app process (start, log, restart, killing the process tree), with the same surface as the dev server.
  - `src/server/bridge.ts` is the `/ws/app` channel with the page; both bridges extend it.
  - **electron** (`electron.ts`, `cdp.ts`, `electron-hook.cts`): page screencast, mouse and keyboard through the DevTools protocol's `Input.*` commands, overlay injected into every new document.
  - **window** (`window.ts`, `wincapture.ts`): list of the process tree's windows, preview, stills, UI elements. On Windows a long-running PowerShell helper does the work (`PrintWindow`, UI Automation), run in memory without a `.ps1` file.
  - In the page, `src/web/appPanel.ts` hosts one "surface" per kind of app: `frameSurface.ts` (iframe), `remoteSurface.ts` (electron), `imageSurface.ts` (window, with the annotator on the image). All of them talk to the rest of the page with the overlay's messages.
- **Hooks** (`src/server/hooks.ts`, `bin/hook.ts`): Claude Code's end of turn, for restarting desktop apps.
- **Plugins** (`src/plugin/`): file and line of elements for Vite, Babel, Next.js and webpack loaders.

## Platform notes

- **Windows (PowerShell, cmd)**:
  - ConPTY through `node-pty`.
  - Finds `claude.exe` (native installer) and npm's `claude.cmd` shims, which are started directly with node, without going through cmd.exe.
  - Shutdown uses `taskkill /T /F` on the whole process tree. A desktop app first receives a close request (as when closing its window), sent only to the main process of each program in the tree: `taskkill /T` without `/F` would close Electron's helper processes (GPU, network) but not the main one, and the window would come back to the front until the forced kill.
  - If multi-line pasted text gets submitted line by line, start with `set RIVERLOOP_STUDIO_CONPTY_DLL=1` (PowerShell: `$env:RIVERLOOP_STUDIO_CONPTY_DLL=1`): it uses the newer ConPTY bundled with node-pty.
  - If auto-send does not go through, start with `--debug`: the launching terminal shows how the message was pasted and what Studio saw in the input box after each Enter.
  - Reserved ports, open instances and logs are in `%LOCALAPPDATA%\riverloop-studio`.
  - `window` mode: capture uses `PrintWindow` and works with covered windows, on secondary screens and with different scalings; not with minimized windows or windows outside every screen (Windows does not paint them).
- **WSL**:
  - Studio opens the Windows browser, which reaches `127.0.0.1` through WSL's port forwarding.
  - Keep the project on the Linux filesystem (`~/…`), not in `/mnt/c/…`: there Next.js and Vite HMR is slow or misses changes.
- **macOS and Linux**: the dev server, the desktop app and `claude` are stopped together with every process in their groups.
  - `window` mode on macOS: `screencapture` and the CoreGraphics window list; without the "Screen Recording" permission window titles are missing and capture fails. On Linux: `wmctrl` and `import` (ImageMagick) with X11. Neither has the Element tool. (Experimental, see [Platform support](#platform-support).)
  - Tauri outside Windows uses WebKit, which has no Chromium debugging port: use `--mode window` there.

## Known limits

- HTTPS dev servers (`next dev --experimental-https`) are not supported yet: the proxy speaks HTTP.
- Login with external OAuth providers inside the iframe often fails: many providers refuse to be framed and register `localhost:3000` as callback. Log in by opening the app directly.
- Exact file and line need the plugin in the project's configuration (see [Exact file and line](#exact-file-and-line)). Without it, Claude receives React component, selector, text and classes, and finds the code by searching for them.
- `electron` mode: native menus, dialogs and `<select>` dropdowns do not appear in the mirror; an open dialog (`alert`) blocks the page until answered in the real window. IME input arrives as text, without the composition preview.
- `window` mode: the app is not used from the page (you look at it and annotate it), and the Element tool exists only on Windows. Apps that draw everything themselves (games, Flutter, many Qt apps) expose few or no elements: use Area and Draw there.
- Projects opened from the **Projects** menu start in web mode: for a desktop app, run `riverloop-studio --mode …` from its folder.
- Ctrl+W, Ctrl+T and Ctrl+N reach Claude only in full screen (⛶ button in the console, Keyboard Lock API of Chrome and Edge). Outside full screen the browser handles them.
- With a dev server already running (`--no-dev`), Studio cannot detect a wrong port from the output: use `--port`.
- Auto-send depends on how Claude Code's screen looks (see [Claude Code compatibility](#claude-code-compatibility)).
- On Linux and macOS, if Studio runs as root, Claude Code refuses `--dangerously-skip-permissions`: the session closes at once with Claude Code's message.
- With Claude Code versions that do not write `~/.claude/sessions/<pid>.json`, "Resume" uses `--continue`, i.e. the folder's latest conversation.
- Screenshots of heavy web pages with `html-to-image` can take seconds (12 s timeout). In Chromium desktop apps the engine takes the screenshot.

## Roadmap

- Validate the desktop modes (`electron`, `window`) on macOS and Linux, and web mode on macOS.
- Native UI elements (the Element tool, "Contains" for areas) on macOS (Accessibility) and Linux (AT-SPI); using a native app from the page (today only Chromium apps).
- Try both desktop modes on more real projects (Electron with electron-vite and Forge, Tauri, WPF, Qt).
- HTTPS dev servers and OAuth login inside the iframe.
- Diagnostics: a log file and a `riverloop-studio doctor` command that checks node-pty, claude, ports, browser and window capture.
- Replace `http-proxy`, which has not been updated since 2020.
- File-and-line plugins for Vue and Svelte.
- More UI languages.
- New-version notice.

## Development and tests

Contributions are welcome: see [CONTRIBUTING.md](../CONTRIBUTING.md).

```bash
npm run build          # server (tsc), Studio page and overlay (Vite)
npm run typecheck
npm run lint           # ESLint
npm run format         # Prettier, writes changes
npm run format:check   # Prettier, check only
npm test               # unit tests (vitest)
```

Tests run with `RIVERLOOP_STUDIO_LANG=it`, because assertions use the Italian texts.

**End-to-end tests** are plain Node scripts that drive the built CLI with `playwright-core`, which ships no browser (pass `--chromium`, or for the desktop tests Chrome/Edge is found automatically).

```bash
# web mode: create the test app (default ../riverloop-e2e-app, create-next-app 16 template)
node scripts/create-e2e-app.mjs [dir]
npm run test:e2e -- --app <dir> --chromium "<path to Chrome>"

node test/e2e/smoke.mjs --app ../a-vite-app --file src/App.tsx --find "Get started" --replace "Hello" --target h1
node test/e2e/multi.mjs --app-a ../project-a --text-a "text of A" --app-b ../project-b --text-b "text of B"
node test/e2e/sessions.mjs --app-a ../project-a --app-b ../project-b --text-b "text of B"

# desktop modes: self-contained fixtures
npm run test:e2e:electron   # real Electron app (first: npm install in test/fixtures/electron-app)
npm run test:e2e:window     # real native window (Windows only)
```

- The scripts replace `claude` with a fake (`test/fixtures/fake-claude.mjs`) that records the input it receives from the PTY. It imitates a slow Claude Code (an Enter within 700 ms of a paste lands in the text), opens a permission prompt after a submit, and runs the hooks of the `--settings` file like Claude Code (a message containing the word `MODIFICA` counts as a reply that wrote a file).
- `run.mjs` covers token, console and restore after reload, several tabs, HMR without reload, the three tools, prompt (area positions included) and files, auto-send (Enter repeated if swallowed, never on a permission prompt, no paste while Claude awaits an answer), viewports, rejected WebSockets and API calls, app attempts to inject annotations, Claude restart, permissions, project suggestions, Undo/Redo and shutdown without orphans.
- `multi.mjs` starts two sessions together with port 3000 held by another server: all ports differ, no attaching to the foreign server, each iframe shows its own app.
- `sessions.mjs` covers tabs and projects: a second session with its own process, input and console; annotations to the active tab; "Resume" with `--resume` of its own conversation; a session in another window; closing a tab; starting another project from the menu (no duplicates) and closing it; closing the current project from the page.
- `electron.mjs` runs Studio on a real Electron app (`test/fixtures/electron-app`): debugging port opened without touching the command, live mirror even when minimized, mouse, keyboard and wheel, multiple windows, the three tools, message and screenshots, app attempts to inject annotations, rejected access to the app channel and hooks, "Restart app", restart on idle only after a change, shutdown with no leftover processes, and attaching to an already-open app (`--no-dev --cdp-port`) that stays alive and usable and that Studio does not close.
- `window.mjs` (Windows) does the same on a Windows Forms window (`test/fixtures/native-app.ps1`): window found and refreshed live, Element via UI Automation, Area and Draw on the still, back to live, message with native element and whole window, minimized window, restarts, attaching with `--no-dev --window-title`, sharing from the browser.
- The test apps honour `RLS_FIXTURE_QUIET=1` (set by the tests): they open on a secondary screen without taking focus, so they do not disturb whoever is using the computer. The tests' browser is headless.
- The auto-send unit tests use real Claude Code screens (`test/fixtures/claude-screens/`): pasted text, typed text, processing, message submitted, permission prompt.

What has been verified so far:

- Web mode: `run.mjs` on Linux and Windows 11 with Next.js 16 (Turbopack and webpack); `smoke.mjs` on Next.js 14 (React 18) and Vite 8 + React 19.
- The file-and-line plugins on Next.js 16.3 (Turbopack and webpack, React 19) and Vite 8 with `@vitejs/plugin-react` 6.
- Desktop modes on Windows 11: Electron 44, a WebView2 app, Windows Forms.
- With a real Claude Code: "Resume" on the first of two tabs returns to its own conversation (2.1.286); the end-of-turn hooks restart the app only after a reply that wrote a file, and the "file and line" suggestion makes Claude edit `next.config.ts` and then disappears (2.1.287).

**CI** (GitHub Actions): build, lint and unit tests on Windows, macOS and Linux; a clean install from the packed tarball; web end-to-end tests on Linux and Windows.

## Project structure

```
riverloop-studio/
├─ bin/
│  ├─ cli.ts               # entry point, options, lifecycle
│  ├─ hook.ts              # Claude Code hook: tells Studio a reply ended
│  └─ statusline.ts        # Claude Code status line: model, effort, usage (runs yours too)
├─ src/server/
│  ├─ index.ts             # companion: page, API, WebSockets
│  ├─ pty.ts               # claude process, mirror terminal, attached tabs
│  ├─ proxy.ts             # reverse proxy, overlay injection, HMR
│  ├─ annotations.ts       # validation, storage, prompt composition
│  ├─ security.ts          # token, Host, Origin, proxy cookie
│  ├─ sessions.ts          # console tabs: several claude processes per project
│  ├─ projects.ts          # projects open on this computer, launch and close
│  ├─ tui.ts               # reads Claude Code's screen for auto-send
│  ├─ devserver.ts         # start, wait, log, restart and stop of the dev server
│  ├─ desktop.ts           # desktop app process
│  ├─ bridge.ts            # /ws/app channel between page and desktop app
│  ├─ electron.ts          # electron mode: screencast, input, overlay via debugging port
│  ├─ cdp.ts               # minimal DevTools protocol client
│  ├─ electron-hook.cts    # loaded into Electron: opens the debugging port
│  ├─ window.ts            # window mode: windows, preview, stills
│  ├─ wincapture.ts        # window capture (Windows, macOS, Linux X11)
│  ├─ wincapture-win32.ts  # PowerShell helper: PrintWindow and UI Automation
│  ├─ hooks.ts             # end-of-turn hooks and restart on idle
│  ├─ suggestions.ts       # project suggestions (and their requests to Claude)
│  ├─ history.ts           # Undo and Redo: file snapshots outside the project
│  ├─ overlay-source.ts    # overlay source with its configuration
│  ├─ portlock.ts          # ports reserved across sessions
│  ├─ state.ts             # project preferences (.claude/studio/state.json)
│  ├─ userState.ts         # per-user choices for a project (permissions), outside the project
│  ├─ nativeSource.ts      # likely file and line of a native control
│  ├─ i18n.ts, locales/    # server languages (English, Italian)
│  ├─ paths.ts             # user config directory
│  ├─ gitignore.ts         # .gitignore proposal
│  └─ util.ts              # processes, executables, terminal
├─ src/shared/            # protocol.ts (messages), i18n.ts (translation helpers)
├─ src/web/                # Studio page (vanilla TS + Vite, xterm.js)
├─ src/overlay/            # overlay injected into the app (IIFE)
├─ src/plugin/             # file and line: Vite, Babel, Next.js, webpack loader
├─ scripts/                # build helpers, e2e test app creation
└─ test/                   # unit, end-to-end, fake claude, test apps
```

## License

Copyright Riverloop SRLS. Licensed under the [Apache License 2.0](../LICENSE); see also [NOTICE](../NOTICE).
