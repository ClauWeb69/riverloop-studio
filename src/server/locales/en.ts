import type { Messages } from '../../shared/i18n.js';
import type { it } from './it.js';

// Server messages in English.
export const en: Messages<typeof it> = {
  'lang.changed': 'Studio language: {name}.',
  'lang.invalid': 'Unsupported language: "{value}". Use en or it.',
  'lang.missing': '--lang needs a language: en or it.',

  // -------------------------------------------------------------------------
  // Command line: help and options
  // -------------------------------------------------------------------------
  'cli.description': 'Annotate the app you are developing and send the changes to Claude Code, in the same session.',
  'cli.opt.version': 'Show the version',
  'cli.opt.help': 'Show this help',
  'cli.opt.mode': 'Kind of app to annotate: web (dev server), electron (Electron and Chromium apps, via the debugging port), window (native window)',
  'cli.opt.port': "Port of the app's dev server (web mode)",
  'cli.opt.studioPort': 'Port of the Studio page',
  'cli.opt.devCmd': 'Command that starts the dev server (web mode)',
  'cli.opt.appCmd': 'Command that starts the desktop app (window and electron modes)',
  'cli.opt.windowTitle': 'Window mode: text contained in the title of the window to show',
  'cli.opt.cdpPort': "Electron mode: the app's debugging port",
  'cli.opt.appWindow': 'Electron mode: app window minimized (background, the app is used from the Studio page) or left as is (normal)',
  'cli.opt.restartOnIdle': 'Restart the desktop app when Claude Code finishes a reply that changed something',
  'cli.opt.noDev': "Don't start the dev server or the app, attach to the one already running",
  'cli.opt.resume': 'Start claude --resume instead of a new session',
  'cli.opt.claudeArgs': 'Extra arguments passed to claude',
  'cli.opt.claudeBin': 'Claude Code executable, if it is not in the PATH',
  'cli.opt.autoSend': 'Start with "Auto-send" on',
  'cli.opt.permissions': "Claude Code permissions: ask (Claude Code's own modes and settings) or skip (--dangerously-skip-permissions)",
  'cli.opt.skipPermissions': 'Start Claude Code without permission prompts (same as --permissions skip)',
  'cli.opt.noOpen': "Don't open the browser automatically",
  'cli.opt.debug': 'Show technical details (ports, auto-send) for reporting a problem',
  'cli.opt.lang': 'Language of Studio and of the requests to Claude Code: en or it (this run only; the RIVERLOOP_STUDIO_LANG variable works too)',
  'cli.port.invalid': 'must be a port between 1 and 65535',

  // -------------------------------------------------------------------------
  // Command line: startup and shutdown
  // -------------------------------------------------------------------------
  'cli.banner.mode': ' — {mode} mode',
  'cli.node.old': 'Node.js 20 or later is required (found {version}).',
  'cli.claude.notFound': 'Can\'t find Claude Code ("{bin}"). Install it (https://docs.claude.com/en/docs/claude-code) or give its path with --claude-bin.',
  'cli.claude.noVersion': '"{path} --version" does not respond: {output}',
  'cli.claude.noOutput': 'no output',
  'cli.pty': 'Terminal: {name}',
  'cli.noPackageJson': 'No package.json in this folder: are you in the root of the project?',
  'cli.webIgnored': '{options}: only apply with --mode window or --mode electron.',
  'cli.webIgnored_one': '{options}: only applies with --mode window or --mode electron.',
  'cli.gitignore.failed': "Couldn't update .gitignore: {message}",
  'cli.cleanup': 'Removed {count} annotation files older than 7 days.',
  'cli.cleanup_one': 'Removed {count} annotation file older than 7 days.',
  'cli.dev.portBusy': "Port {port} is already in use (another app or another Studio session): starting this project's dev server on {next}.",
  'cli.dev.portBusyHint': '  If the server on {port} belongs to this project, run again with --no-dev to attach to it.',
  'cli.dev.starting': 'Starting the dev server: {command}',
  'cli.portNote': '(port {port})',
  'cli.debugPortNote': '(debugging port {port})',
  'cli.electron.noCommand':
    'Tell Studio how to start the app with --app-cmd "<command>" (e.g. "npm start"), or use --no-dev if it is already open with the debugging port.',
  'cli.app.starting': 'Starting the app: {command}',
  'cli.electron.background': '  The app window stays minimized: the app is used from the Studio page (--app-window normal to leave it on the desktop).',
  'cli.electron.attach': 'Attaching to the app already open on debugging port {port}.',
  'cli.window.noCommand':
    'Tell Studio how to start the app with --app-cmd "<command>", or use --no-dev to pick a window that is already open (also with --window-title).',
  'cli.window.searching': 'Looking for a window with "{title}" in its title.',
  'cli.window.choose': "Pick the app's window from the list in the Studio page.",
  'cli.studioPortBusy': 'Port {port} is in use: Studio uses {next}.',
  'cli.skipPermissions': "Claude Code starts {bold} (--dangerously-skip-permissions): changes and commands won't ask for confirmation.",
  'cli.skipPermissions.bold': 'without permission prompts',
  'cli.hooks.unavailable': 'Claude Code hooks not available: {message}',
  'cli.restartOnIdle.unmanaged': '--restart-on-idle only applies to apps started by Studio (with --app-cmd).',
  'cli.restartOnIdle.on': 'The app will be restarted when Claude Code finishes a reply that changed something.',
  'cli.restartOnIdle.enabled': 'Restart the app at the end of a reply: on.',
  'cli.restartOnIdle.disabled': 'Restart the app at the end of a reply: off.',
  'cli.permissions.skip': 'Permissions: {who} now starts without confirmations.',
  'cli.permissions.ask': 'Permissions: {who} now uses the standard permissions (its own modes and settings).',
  'cli.what.app': 'app',
  'cli.what.devServer': 'dev server',
  'cli.forceQuit': 'Forced shutdown.',
  'cli.closing': 'Closing: Claude Code, {what}, companion…',
  'cli.closed': 'Closed.',
  'cli.closeError': 'Error while closing: {message}',
  'cli.unexpected': 'Unexpected error: {message}',
  'cli.claude.exited': '{who} has exited: you can restart it from the Studio console.',
  'cli.claude.exitedCode': '{who} has exited (code {code}): you can restart it from the Studio console.',
  'cli.dev.port': 'The dev server uses port {port}.',
  'cli.dev.exited': 'The dev server has exited: the last lines are in the Studio page.',
  'cli.dev.exitedCode': 'The dev server has exited (code {code}): the last lines are in the Studio page.',
  'cli.dev.fixedPort':
    '  The dev script uses a fixed port that is already in use. Remove the port from the script (e.g. "-p 3000") so Studio can assign a free one, or give the command with --dev-cmd.',
  'cli.app.exited': 'The app has exited: you can restart it from the Studio page.',
  'cli.app.exitedCode': 'The app has exited (code {code}): you can restart it from the Studio page.',
  'cli.companion.failed': "Couldn't start the companion: {message}",
  'cli.registry.failed': 'Project registry not available: {message}',
  'cli.dev.ready': 'App reachable at localhost:{port}',
  'cli.dev.stoppedStarting': 'The dev server stopped while starting: check the log above (also in the Studio page).',
  'cli.dev.timeout': 'The dev server is not responding on port {port} after 60 s: the page will refresh when it is ready.',
  'cli.dev.none': 'No server is responding on localhost:{port}: start it, the page will refresh on its own.',
  'cli.proxyNote': '(proxy on 127.0.0.1:{port})',
  'cli.electron.connected': 'App connected on debugging port {port}',
  'cli.electron.connectedTitle': 'App connected on debugging port {port} ({title})',
  'cli.window.found': 'App window found',
  'cli.window.foundTitle': 'App window found: {title}',
  'cli.app.stoppedStarting': 'The app stopped while starting: check the log above (also in the Studio page).',
  'cli.electron.timeout': "The app didn't open debugging port {port} within 60 s: the page will refresh when it is ready.",
  // {port} is literal text here: it's the placeholder Studio replaces in the --app-cmd command
  'cli.electron.timeoutHint': '  If the app is not Electron in development, add "--remote-debugging-port={port}" to the command in --app-cmd.',
  'cli.window.timeout': 'No app window after 60 s: the page will refresh when it appears.',
  'cli.appLine.electron': 'desktop app on debugging port {port}',
  'cli.appLine.window': 'native window',
  'cli.appLine.windowTitle': 'native window "{title}"',
  'cli.tokenWarning': "The link contains the session token: don't share it. Ctrl+C closes everything.",
  'cli.openFailed': "Couldn't open the browser ({message}): open the link above.",

  // -------------------------------------------------------------------------
  // The project's .gitignore
  // -------------------------------------------------------------------------
  'gitignore.comment': '# Riverloop Studio: local annotations and screenshots',
  'gitignore.addHint': 'Add {entry} to .gitignore: Studio saves annotations and screenshots there.',
  'gitignore.ask': "Add {entry} to the project's .gitignore?",
  'gitignore.askChoices': '[Y/n]',
  'gitignore.added': '{entry} added to .gitignore',
  'gitignore.declined': "OK, I won't ask again for this project.",

  // -------------------------------------------------------------------------
  // Companion: API and page errors
  // -------------------------------------------------------------------------
  'http.tooLarge': 'Request too large',
  'http.methodNotAllowed': 'Method not allowed',
  'http.originDenied': 'Origin not allowed',
  'http.jsonRequired': 'application/json required',
  'http.invalidJson': 'Invalid JSON',
  'http.hostDenied': 'Host not allowed',
  'http.notFound': 'Not found',
  'http.internalError': 'Internal error: {message}',
  'http.unauthorized': 'Studio session not authorized: open the link shown in the terminal.',
  'http.pageNotBuilt': 'Studio page not built: run "npm run build" in the riverloop-studio folder.',
  'companion.noApp': 'No app to show',
  'companion.idleRestart': 'Claude Code finished with changes: restarting the app.',
  'api.sessionClosed': 'This Claude session has been closed: pick a console tab and send again.',
  'api.notRunning': '{who} is not running: restart it from the console and try again.',
  'api.awaitingSend': '{who} is waiting for your answer in the console (permission request or menu): answer there, then send again.',
  'api.awaitingRetry': '{who} is waiting for your answer in the console (permission request or menu): answer there, then try again.',
  'api.annotationsLabel': 'annotations',
  'api.claudeBusy': 'Claude Code is working: wait for it to finish (or interrupt it with Esc in the console) and try again.',
  'api.suggestionInvalid': 'This suggestion is no longer valid.',
  'api.lastSession': "The last session can't be closed.",
  'api.sessionNotFound': 'Session not found.',
  'api.localeInvalid': 'Unsupported language: use en, it or null (system language).',

  // -------------------------------------------------------------------------
  // Annotations: validation
  // -------------------------------------------------------------------------
  'annotation.invalidKind': 'Invalid annotation type',
  'annotation.invalidId': 'Invalid annotation number',
  'annotation.none': 'No annotations to send',
  'annotation.tooMany': 'Too many annotations (at most {max})',
  'annotation.invalidImage': 'invalid image',

  // -------------------------------------------------------------------------
  // Request for Claude Code (composePrompt)
  // -------------------------------------------------------------------------
  'prompt.pos.center': 'in the center',
  'prompt.pos.top': 'top center',
  'prompt.pos.bottom': 'bottom center',
  'prompt.pos.left': 'middle left',
  'prompt.pos.right': 'middle right',
  'prompt.pos.topLeft': 'top left',
  'prompt.pos.topRight': 'top right',
  'prompt.pos.bottomLeft': 'bottom left',
  'prompt.pos.bottomRight': 'bottom right',
  'prompt.noComment': '(no comment)',
  'prompt.place.window': 'window{title} of the desktop app ({size} px)',
  'prompt.place.electron': 'window{title} of the desktop app, page {url} (viewport {size})',
  'prompt.place.page': 'page {url} (viewport {size})',
  'prompt.header.single': 'Requested changes on the {where}:',
  'prompt.header.multiWindows': 'Requested changes on several windows.',
  'prompt.header.multiPages': 'Requested changes on several pages.',
  'prompt.header.group': 'On the {where}:',
  'prompt.item.request': 'Request: {text}',
  'prompt.item.component': 'React component: {name}',
  'prompt.item.componentInside': 'React component: {name} (inside {parents})',
  'prompt.item.source': 'Source: {source}',
  'prompt.item.screenshot': 'Screenshot: @{path}',
  'prompt.item.noScreenshot': 'Screenshot: not available',
  'prompt.item.noScreenshotReason': 'Screenshot: not available ({reason})',
  'prompt.context': 'Whole window with annotations {ids}: @{path}',
  'prompt.context_one': 'Whole window with annotation {ids}: @{path}',
  'prompt.details.native': 'Full details (position, interface elements): @{path}',
  'prompt.details.web': 'Full details (HTML, styles, position): @{path}',
  'prompt.footer.screenshots': 'In the screenshots each annotation is highlighted with its number.',
  'prompt.footer.noScreenshots': 'Screenshots are not available: use the JSON file for the details.',
  'prompt.native.class': 'class {name}',
  'prompt.target.element': 'Element {target}',
  'prompt.target.elementWithText': 'Element {target} — text {text}',
  'prompt.target.elementFallback': 'element',
  'prompt.target.area': 'Area of {size} px',
  'prompt.target.drawing': 'Drawing over an area of {size} px',
  'prompt.target.inWindow': '(in the window: {pos})',
  'prompt.target.onScreen': '(on screen: {pos})',
  'prompt.loc.window': 'Position in the window: x {x}, y {y} px ({pos})',
  'prompt.loc.fromTopLeft': 'from the top left corner',
  'prompt.loc.over': 'Over the element: {element}',
  'prompt.loc.where': 'Located: {where}',
  'prompt.loc.inside': 'inside {name}',
  'prompt.loc.insideWithText': 'inside {name} with the text {text}',
  'prompt.loc.underHeading': 'under the heading {heading}',
  'prompt.loc.page': 'Position in the page: x {x}, y {y} px ({detail})',
  'prompt.loc.scrolled': 'on screen x {x}, y {y}, with the page scrolled by {scroll}',
  'prompt.loc.scrollY': '{n} px vertically',
  'prompt.loc.scrollX': '{n} px horizontally',
  'prompt.loc.scrollBoth': '{vertical} and {horizontal}',
  'prompt.loc.contains': 'Contains: {items}',
  'prompt.loc.crosses': 'Passes over: {items}',
  'prompt.loc.containsNone': 'Contains: no whole element (the area covers parts of larger elements)',

  // -------------------------------------------------------------------------
  // Undo and Redo
  // -------------------------------------------------------------------------
  'history.gitMissing': 'Undo and Redo need git installed on this computer.',
  'history.unavailable': 'Undo and Redo not available: {message}',
  'history.defaultLabel': 'request',
  'history.nothingToUndo': 'Nothing to undo: no request has been sent from Studio yet.',
  'history.alreadyFirst': 'Nothing to undo: the files are already as they were before the first request.',
  'history.undone': 'Undone: the files are back to before «{label}».',
  'history.undoFailed': 'Undo failed: {message}',
  'history.nothingToRedo': 'Nothing to redo.',
  'history.redoChanged': 'Nothing to redo: the files were changed again after the Undo.',
  'history.redone': 'Redone: the changes of «{label}» are back.',
  'history.redoFailed': 'Redo failed: {message}',
  'history.notice':
    "Note: after your last reply the project files were brought back to a different state with Riverloop Studio's Undo/Redo. Read the files again before changing them.",

  // -------------------------------------------------------------------------
  // Project suggestions
  // -------------------------------------------------------------------------
  'suggest.onlyThis': "Don't change anything else. When you're done, tell me in one line what you changed.",
  'suggest.source.title': 'Exact file and line for every element',
  'suggest.source.detail':
    'With one line in {file} every annotation tells Claude the file and line of the element, instead of making it search by selector and text.',
  'suggest.source.detailInstall': ' riverloop-studio also needs to be installed as a dev dependency of the project (from the local folder).',
  'suggest.source.intro':
    'Set up the Riverloop Studio «file and line» plugin in this project. In development it adds a data-studio-src attribute with file and line to every element, so annotations point to the exact place in the code; production builds do not change.',
  'suggest.source.installed': '1. The riverloop-studio package is already installed in the project: no need to install it.',
  'suggest.source.install': '1. Install the package as a dev dependency from the local folder: {command}',
  'suggest.source.next': 'In {config} import withStudio from "riverloop-studio/next" and wrap the exported configuration with withStudio(...).',
  'suggest.source.nextCreate': 'Create next.config.mjs with: import { withStudio } from "riverloop-studio/next"; export default withStudio({});',
  'suggest.source.electronVite':
    'In {config} import the plugin (import studio from "riverloop-studio/vite") and add it to the plugins of the renderer section, before the React plugin: plugins: [studio(), react()].',
  'suggest.source.vite':
    'In {config} import the plugin (import studio from "riverloop-studio/vite") and put it first in plugins, before the React plugin: plugins: [studio(), react()].',
  'suggest.devPort.title': 'The "dev" script fixes port {port}',
  'suggest.devPort.detail':
    "If {port} is in use (another app, another Studio session) the dev server doesn't start: Studio can't move it to a free port while the script forces it.",
  'suggest.devPort.intro': 'In the package.json of this project the "dev" script fixes the port of the dev server: {script}',
  'suggest.devPort.fix':
    'Remove the port option (-p or --port with its number) from the script and leave the rest as it is. Next.js takes the port from the PORT variable, which Riverloop Studio sets on its own when the default one is in use.',
  'suggest.gitignore.title': 'Annotations and screenshots out of the repository',
  'suggest.gitignore.detail':
    "Studio saves annotations and screenshots in .claude/studio/, which git doesn't ignore yet: they would end up among the files to commit.",
  'suggest.gitignore.prompt':
    'Add the line .claude/studio/ to the .gitignore of this project, with the comment "{comment}" above it. That is where Riverloop Studio saves annotations and screenshots, which do not belong in the repository. If there is no .gitignore, create it in the project folder.',

  // -------------------------------------------------------------------------
  // Dev server, desktop app and proxy
  // -------------------------------------------------------------------------
  'process.startFailed': 'Couldn\'t start "{command}": {message}',
  'devserver.retryPort': 'Port {port} in use: trying again on {next}.',
  'proxy.waiting.title': 'Waiting for the dev server on localhost:{port}',
  'proxy.waiting.text': 'The page reloads on its own as soon as the server responds.',
  'proxy.exited.title': 'The dev server has stopped',
  'proxy.exited.text': 'The command {command} has exited. You can restart it from the bar at the top or ask Claude to fix the error.',
  'proxy.exited.textCode': 'The command {command} has exited with code {code}. You can restart it from the bar at the top or ask Claude to fix the error.',
  'proxy.external.text':
    'Studio attached to a server that was already running, but nothing responds on {address}. Start the dev server or run Studio again with {option}.',
  'proxy.denied.title': 'Access not authorized',
  'proxy.denied.text': 'This port serves the app inside Riverloop Studio. Open Studio from the link shown in the terminal where you ran {command}.',
  'proxy.unreachable': 'Dev server not reachable on localhost:{port} ({reason})',
  'proxy.overlayMissing': 'overlay not built: run "npm run build" in riverloop-studio',
  'overlay.notBuilt': 'Overlay not built: run "npm run build" in the riverloop-studio folder.',

  // -------------------------------------------------------------------------
  // Electron and window modes: app status in the page
  // -------------------------------------------------------------------------
  'app.stopped': 'The app has stopped: restart it with the button at the top.',
  'electron.note.webview': 'This also works for WebView2 apps (Tauri on Windows) and any Chromium app with the debugging port.',
  'electron.note.chromium': 'This works for Electron and any Chromium-based app with the debugging port.',
  'electron.noApp': 'No app is responding on debugging port {port}: start it with --remote-debugging-port={port}.',
  'electron.waiting': 'Waiting for the app…',
  'electron.noWindow': "The app is running but hasn't opened a window yet.",
  'electron.hidden': "The app window is minimized or hidden: it can't be shown here until it is visible again.",
  'electron.neverShown': "The app window hasn't been shown yet (its page measures 0×0): show it to see it here.",
  'electron.notResponding': "The app page isn't responding: check its window (an open dialog blocks it).",
  'window.waiting': 'Waiting for the app window…',
  'window.noTitleMatch': 'No open window with "{title}" in its title: start the app.',
  'window.choose': "Pick the app's window from the list at the top.",
  'window.shareFromBrowser': '{reason} You can share the window from the browser.',
  'window.untitled': '(untitled)',
  'window.minimized': "The app window is minimized: it can't be captured until it is visible again.",
  'window.noWindow': 'No window to capture.',
  'window.stillMinimized': 'The window is minimized.',
  'window.stillGone': 'The window is no longer available.',

  // -------------------------------------------------------------------------
  // Native window capture
  // -------------------------------------------------------------------------
  'capture.win.noStart': "The Windows capture helper doesn't start (PowerShell not available or blocked).",
  'capture.win.blocked': "The Windows capture helper doesn't start (PowerShell blocked?).",
  'capture.win.noPowershell': 'PowerShell not available: {message}',
  'capture.win.helperUnavailable': 'Capture helper not available: {message}',
  'capture.win.unknownError': 'unknown error',
  'capture.win.helperExited': 'capture helper exited',
  'capture.win.notStarted': "the capture helper didn't start",
  'capture.win.notActive': 'capture helper not running',
  'capture.win.timeout': 'the capture is not responding',
  'capture.closed': 'capture closed',
  'capture.mac.list': "On macOS I can't read the list of windows (osascript).",
  'capture.mac.permission':
    'On macOS the window capture fails: give the terminal the "Screen Recording" permission (System Settings → Privacy & Security) and run Studio again.',
  'capture.x11.list': "Can't read the list of windows (wmctrl): the window manager doesn't allow it.",
  'capture.x11.capture': 'The window capture fails (ImageMagick import).',
  'capture.x11.missing':
    'Capturing windows needs wmctrl and ImageMagick (missing: {missing}). Install them with "sudo apt install wmctrl imagemagick" or share the window from the browser.',
  'capture.disabled': 'System capture is turned off (RIVERLOOP_STUDIO_NO_CAPTURE): share the window from the browser.',
  'capture.wayland': "Wayland doesn't allow capturing windows directly: share the window from the browser.",
  'capture.noDisplay': 'No graphical display in this session (DISPLAY not set): share the window from the browser.',
  'cdp.error': 'CDP error',
  'cdp.closed': 'connection closed',
  'cdp.noResponse': '{method}: no response',

  // -------------------------------------------------------------------------
  // Claude Code sessions
  // -------------------------------------------------------------------------
  'pty.noSpawn': '{name}: module without spawn()',
  'pty.unavailable':
    'node-pty is not available ({errors}).\nRun "npm install" again in the riverloop-studio folder. On Linux/WSL, if the build fails, install the build tools (sudo apt install build-essential python3).',
  'pty.restart.banner': '── Restarting Claude Code ({label}) ──',
  'pty.restart.skip': '{label}, without confirmations',
  'pty.restart.same': 'same conversation',
  'pty.restart.new': 'new conversation',
  'pty.startFailed': "Couldn't start Claude Code:",
  'sessions.max': 'You can open at most {max} Claude Code sessions per project.',

  // -------------------------------------------------------------------------
  // Other projects, ports, folders
  // -------------------------------------------------------------------------
  'projects.missingDir': 'Enter the project folder.',
  'projects.absolute': 'The full path of the folder is required (e.g. C:\\Projects\\my-app or /home/user/my-app).',
  'projects.notFound': 'The folder "{path}" does not exist.',
  'projects.startFailed': 'Studio did not start for "{project}".',
  'projects.startFailedLog': 'Studio did not start for "{project}":\n{log}',
  'projects.timeout': 'Studio did not respond within {seconds} seconds for "{project}". Log: {log}',
  'projects.notOpen': 'This project is no longer open.',
  'projects.refused': 'Close refused (HTTP {status}).',
  'projects.noResponse': 'The project is not responding.',
  'projects.noResponseDetail': 'The project is not responding: {message}',
  'ports.none': 'No free port starting from {port}',
  'util.dirNotOwned': 'The folder {dir} does not belong to this user.',
  'proxy.serviceWorker': 'Riverloop Studio does not let the app register Service Workers through the proxy.',
  'studioDir.missing': 'Folder {dir} is missing.',
  'studioDir.notPlain': '{dir} is not a regular project folder (symbolic link or outside the project): Studio does not use it.',
  'claude.error.invalid': 'Invalid request.',
  'claude.error.not-running': 'Claude Code is not running in this tab.',
  'claude.error.awaiting-answer': 'Claude Code is waiting for an answer in the console (permission or menu): answer there, then try again.',
  'claude.error.input-not-empty': "There is unsent text in Claude Code's input box: send or clear it, then try again.",
  'claude.error.unknown-mode': 'Studio does not recognise the mode shown by Claude Code: change it from the console with Shift+Tab.',
  'claude.error.unavailable': 'This mode is not available in this Claude Code session.',
  'claude.error.ultracode-unconfirmed':
    'Claude Code did not change ultracode (it may not be available for this model or plan): see the message in the console.',
  'prompt.loc.sources': 'Likely source of the control (found by searching the project for its AutomationId or text, please verify): {list}',
};
