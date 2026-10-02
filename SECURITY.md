# Security policy

Riverloop Studio runs a real Claude Code session in a terminal and serves it to your browser from `127.0.0.1`. The console is equivalent to a local shell, so we treat any way for another website, another local user, or the app under development to reach the console or the Studio APIs as a critical issue.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report them privately through GitHub's **"Report a vulnerability"** button in the repository's *Security* tab (private vulnerability reporting). Include:

- the Riverloop Studio version (`riverloop-studio --version`), your OS, Node.js version and `claude --version`;
- the mode you used (`web`, `electron`, `window`) and the command line;
- what an attacker needs (a website you visit, a malicious dev server, another account on the same machine, …) and the steps to reproduce.

We aim to acknowledge reports within 5 working days and to agree on a disclosure date with you once a fix is available.

## Supported versions

Only the latest released version receives security fixes while the project is in `0.x`.

## Scope and design notes

The security model is described in the [user guide](docs/guide.md#security). In short:

- Studio listens on `127.0.0.1` only; every request is checked for `Host` (DNS rebinding) and state-changing requests and WebSockets for `Origin`.
- The session token travels in the URL fragment and is presented as a header or WebSocket subprotocol, never as a cookie.
- The overlay injected into your app runs in the app's origin and is untrusted: it cannot send annotations or keystrokes to Claude Code by itself.
- The app proxy removes `Content-Security-Policy` and `X-Frame-Options` from your app's responses so it can be shown in a frame. **Use Studio with development servers only, never with production sites.**

Out of scope: issues that require an attacker who already runs code as your user, and the behaviour of Claude Code itself (report those to Anthropic).
