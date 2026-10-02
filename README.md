<h1 align="center">Riverloop Studio</h1>

<p align="center">
  <b>Point at your app. Tell Claude what to change.</b><br />
  Your app and a real Claude Code session side by side: click an element, draw on the screen, write a comment —<br />
  Claude gets the exact file and line, the styles and a screenshot, and you watch the change land.
</p>

<p align="center">
  <a href="https://github.com/ClauWeb69/riverloop-studio/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/ClauWeb69/riverloop-studio?style=social" /></a>
  <a href="https://github.com/ClauWeb69/riverloop-studio/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ClauWeb69/riverloop-studio/actions/workflows/ci.yml/badge.svg" /></a>
  <img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue" />
  <img alt="Node.js 20+" src="https://img.shields.io/badge/node-%3E%3D20-339933" />
  <img alt="Web, Electron, native windows" src="https://img.shields.io/badge/apps-web%20%7C%20electron%20%7C%20native-b12584" />
  <img alt="English and Italian" src="https://img.shields.io/badge/UI-English%20%7C%20Italiano-555" />
</p>

![Riverloop Studio: a web app with three annotations on the left, Claude Code on the right](https://raw.githubusercontent.com/ClauWeb69/riverloop-studio/main/docs/images/hero.png)

<sub>Independent open-source project, not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic. The screenshots use a demo app and a simulated Claude Code session.</sub>

---

## Why Riverloop Studio

Describing a UI change in words is slow and ambiguous: *"the second button in the card on the right, a bit lower, no, the other one"*. With Riverloop Studio you show it.

- **Show, don't describe.** Click an element, drag a rectangle or draw a freehand mark. Claude receives the CSS selector, the **exact file and line** of the component, the computed styles, the surrounding layout and a screenshot with your mark highlighted.
- **It is your real Claude Code.** Studio runs the actual `claude` CLI in a terminal inside the page — not an API wrapper. Your subscription, model, settings, permissions, `CLAUDE.md`, MCP servers and slash commands all work exactly as in your terminal.
- **See the result immediately.** The app reloads with hot module replacement next to the console, so the loop is: point → comment → watch it change.
- **Not only web apps.** Electron and other Chromium desktop apps (Tauri on Windows) are mirrored live and fully usable from the page; any native window (WPF, WinForms, Qt…) can be captured and annotated, with UI Automation names and the likely source line of each control.
- **Undo what Claude did.** One click puts the project files back to how they were before your last request — no commits, no git required.
- **Control Claude from the page.** Change model, effort (ultracode included) and permission mode, set a goal, keep an eye on your plan usage; everything stays in sync with what you type in the console.
- **Safe by design.** Everything stays on `127.0.0.1`, behind a per-run token; the app under development cannot drive Claude or read your comments; nothing is sent anywhere except by Claude Code itself. No telemetry.
- **Free and open source** under the Apache 2.0 license.

## Features

| | |
|---|---|
| **Three annotation tools** — Element (hover, ↑/↓ for parent and child, click), Area and freehand Draw, each with its own comment and numbered badge. Batch them and send with Ctrl+Enter, or turn on auto-send. | **Exact file and line** — optional build plugins for Next.js (webpack and Turbopack), Vite and Babel add `data-studio-src` to your JSX in development, so Claude opens the right file at the right line. |
| **Hot reload in place** — web apps run through a local proxy in an iframe; Next.js, Vite and friends update without losing state. | **Desktop apps** — `--mode electron` mirrors an Electron/WebView2 app with mouse, keyboard and scrolling; `--mode window` captures any native window. Optional automatic restart after each reply that changed files. |
| **Undo / Redo of file changes** — snapshots before every request, stored outside your project. | **Claude bar** — model, effort, ultracode, permission mode (no more cycling Shift+Tab), goal and usage of the 5-hour and 7-day limits. |
| **Several sessions** — up to 8 Claude Code tabs per project, renamable (*bugs*, *UI*, *refactor*…); names follow the conversation when you resume it. | **Several projects** — open, switch and close Studio instances for other folders from the page; each reopens the way it was started. |
| **Project suggestions** — Studio spots setup improvements (missing source plugin, hard-coded dev port…) and asks Claude to apply them with one click. | **Responsive and bilingual** — works from a phone-sized window up; English and Italian, for the page, the terminal and the prompts. |

<table>
  <tr>
    <td width="50%"><img src="https://raw.githubusercontent.com/ClauWeb69/riverloop-studio/main/docs/images/sent.png" alt="Annotations sent: Claude Code applies the changes" /><br /><sub><b>Send</b>: the annotations reach Claude Code as one message with screenshots; the tray shows what was sent.</sub></td>
    <td width="50%"><img src="https://raw.githubusercontent.com/ClauWeb69/riverloop-studio/main/docs/images/desktop.png" alt="An Electron app mirrored live and annotated" /><br /><sub><b>Desktop apps</b>: an Electron app mirrored live, with an Area annotation. The real window stays minimized.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="https://raw.githubusercontent.com/ClauWeb69/riverloop-studio/main/docs/images/claude-bar.png" alt="The Claude bar with the Goal dialog" /><br /><sub><b>Claude bar</b>: model, effort, mode, goal and usage of the active tab.</sub></td>
    <td width="50%" align="center"><img src="https://raw.githubusercontent.com/ClauWeb69/riverloop-studio/main/docs/images/mobile.png" alt="Studio on a narrow screen" width="260" /><br /><sub><b>Narrow screens</b>: app and console stack vertically.</sub></td>
  </tr>
</table>

## Installation

### 1. Node.js

Install [Node.js](https://nodejs.org/) **20 or later** (22 or later if you also install Claude Code through npm). Check with `node --version`.

### 2. Claude Code

Riverloop Studio drives the Claude Code CLI you already use. If you do not have it yet, install it with the official installer ([setup guide](https://code.claude.com/docs/en/setup)):

```bash
# macOS, Linux, WSL
curl -fsSL https://claude.ai/install.sh | bash
```

```powershell
# Windows PowerShell
irm https://claude.ai/install.ps1 | iex
```

```bat
:: Windows CMD
curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd
```

Alternatively, with npm (Node.js 22+): `npm install -g @anthropic-ai/claude-code`.

On Windows, [Git for Windows](https://git-scm.com/downloads/win) is recommended: Claude Code then uses Git Bash for its shell commands.

Then open a new terminal, run `claude` once and log in. You need a **Claude Pro, Max, Team or Enterprise** plan or a **Claude Console** account (the free claude.ai plan does not include Claude Code); Amazon Bedrock, Google Cloud and Microsoft Foundry are supported too ([authentication](https://code.claude.com/docs/en/authentication)). Check the installation:

```bash
claude --version   # e.g. 2.1.287 (Claude Code)
claude doctor      # optional: detailed health check
```

### 3. Riverloop Studio

```bash
npm install -g riverloop-studio
```

Or from source:

```bash
git clone https://github.com/ClauWeb69/riverloop-studio.git
cd riverloop-studio
npm install        # also builds
npm link           # makes the riverloop-studio command available
```

Studio uses `node-pty` for the terminal. Prebuilt binaries cover Windows, macOS and (through the `@lydell/node-pty` fallback) Linux; npm 11 may warn about install scripts not allowed — you can ignore it.

### 4. Start it in your project

```bash
cd my-app
riverloop-studio
```

Studio starts your dev server (`npm run dev`, or `--dev-cmd "…"`), starts Claude Code in the same folder and opens the page in your browser. That's it: pick a tool, mark something, write what you want, press **Send**.

```bash
riverloop-studio --port 5173                         # your dev server's port
riverloop-studio --no-dev                            # attach to a dev server that is already running
riverloop-studio --mode electron                     # an Electron app ("npm run dev" or "npm start")
riverloop-studio --mode electron --app-cmd "npm run tauri dev"   # Tauri on Windows (WebView2)
riverloop-studio --mode window --app-cmd "dotnet run"            # any native window
riverloop-studio --lang en                           # English UI and prompts for this run
```

### 5. Optional: exact file and line

Add the plugin for your toolchain so Claude knows which file and line rendered each element (development only; production builds are untouched):

```ts
// next.config.ts
import { withStudio } from 'riverloop-studio/next';
export default withStudio({ /* your config */ });
```

```ts
// vite.config.ts
import studio from 'riverloop-studio/vite';
export default { plugins: [studio()] };
```

Studio can also do this for you: it shows a suggestion and, with one click, asks Claude Code to make the change.

## How it works

```
 your browser (Studio page)                    127.0.0.1, behind a per-run token
 ┌─────────────────────────┬───────────────┐   ┌───────────────────────────────┐
 │ your app (iframe / live │  Claude Code  │◀─▶│ companion: proxy, PTY, API    │
 │ mirror / window capture)│  terminal     │   │  ├─ your dev server / app      │
 │  + annotation overlay   │  + Claude bar │   │  └─ claude (the real CLI)      │
 └─────────────────────────┴───────────────┘   └───────────────────────────────┘
```

The annotation is turned into a plain-text message (with `@` references to the screenshots saved in `.claude/studio/`) and pasted into the Claude Code session, exactly as if you had typed it. Details in the [user guide](docs/guide.md#how-it-works).

## Platform support

| | Windows 11 | macOS | Linux |
|---|---|---|---|
| Web apps | ✅ verified | not yet tested | ✅ verified |
| Electron / Chromium apps | ✅ verified | experimental | experimental |
| Native windows | ✅ verified | experimental | experimental (X11) |

## Documentation

- **[User guide](docs/guide.md)** ([italiano](docs/guida.md)) — every option, desktop apps, the Claude bar, undo/redo, security model, known limits, roadmap.
- **[Security policy](SECURITY.md)** — how to report a vulnerability privately.
- **[Contributing](CONTRIBUTING.md)** and **[changelog](CHANGELOG.md)**.

## Star history

If Riverloop Studio saves you time, a ⭐ helps other people find it.

[![Star History Chart](https://api.star-history.com/svg?repos=ClauWeb69/riverloop-studio&type=Date)](https://star-history.com/#ClauWeb69/riverloop-studio&Date)

## License

Copyright Riverloop SRLS. Licensed under the [Apache License 2.0](LICENSE); see also [NOTICE](NOTICE).
