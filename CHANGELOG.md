# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/) (while in `0.x`, minor versions may contain breaking changes).

## [Unreleased]

### Added

- **No more `--mode`**: Studio detects the kind of app from the project (Electron or Tauri dependency, `package.json` scripts, .NET desktop project, Python GUI, Flutter) and how to start it, including the package manager from the lock file. Command-line options still win.

## [0.2.0] — 2026-10-02 — first public release

### Added

- **Three kinds of apps**: web apps through their dev server (`--mode web`, default), Electron and other Chromium-based desktop apps through the remote-debugging port (`--mode electron`), and any native window as a captured image (`--mode window`).
- **Annotations**: element, area and freehand drawing, with a comment, pasted into the same Claude Code session that runs in the page; optional auto-send.
- **Exact file and line** of annotated elements with the build plugins for Vite, Babel and Next.js (`withStudio`).
- **Restart on idle** for desktop apps: the app restarts when Claude Code finishes a turn that changed files (Claude Code hooks).
- **Undo / Redo** of the file changes made after each request, without touching the project's git repository.
- **Project suggestions**: Studio detects setup changes that would help (source-location plugin, hard-coded dev port, `.claude/studio/` not git-ignored) and asks Claude Code to make them with one click.
- **Multiple console tabs and projects** from the same page.
- **English and Italian** for the page, terminal messages and prompts (`--lang`, `RIVERLOOP_STUDIO_LANG`, or the selector in the page).
- **Claude bar**: model, effort, permission mode (instead of Shift+Tab), goal and plan usage of the active tab, read from Claude Code's status line (your own status line keeps working).
- **Renamable tabs**: double-click a tab to dedicate a session to a kind of task; the name follows the conversation when you resume it.
- **Projects reopen as they were started** (mode, app or dev-server command, port) from the Projects menu.
- **Native windows**: likely file and line of an annotated control (searched by `AutomationId` or text), and the list of controls inside an area.

### Security

- The "skip confirmations" choice and the launch options are stored per user, never in the project folder.
- Auto-send and the Claude bar act only when Claude Code's input box is certainly showing.
- `@file` mentions in app-provided text are neutralised; the app overlay never receives comment text.
- Studio page and app proxy ports never swap roles; the proxy refuses Service Workers.
- On Linux and macOS the session link is never put on the browser's command line.

### Known limits

- Desktop modes are verified on Windows 11 only; on macOS and Linux they are experimental.
- Auto-send reads Claude Code's screen; it was verified with Claude Code 2.1.286–2.1.287.
