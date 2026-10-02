# Contributing to Riverloop Studio

Thanks for your interest! Bug reports, fixes and improvements are welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Security problems: see [SECURITY.md](SECURITY.md) — please don't report them in public issues.
- Read [docs/architecture.md](docs/architecture.md): how the pieces fit together, and the pitfalls that are easy to get wrong.

## Setup

```bash
npm install          # also builds everything (prepare)
npm run build        # server (tsc) + Studio page + overlay (Vite)
npm test             # unit tests (vitest)
npm run typecheck
npm run lint
npm run format       # Prettier
```

Requirements: Node.js 20+, and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) if you want to run Studio for real (tests use a fake `claude`).

Run your build from any project folder with `node <path-to-this-repo>/dist/bin/cli.js` (or `npm link` once and use `riverloop-studio`).

## Tests

- Unit tests: `npm test`. They need no build, except the Babel plugin test, which loads `dist/`.
- Web end-to-end test (needs Chrome or Edge):
  ```bash
  node scripts/create-e2e-app.mjs ../riverloop-e2e-app
  npm run test:e2e -- --app ../riverloop-e2e-app --chromium "<path to Chrome>"
  ```
- Desktop end-to-end tests: `npm run test:e2e:electron` (run `npm install` in `test/fixtures/electron-app` first) and `npm run test:e2e:window` (Windows only). They open real windows; the fixtures try to stay on a secondary monitor and out of focus.

Tests run with `RIVERLOOP_STUDIO_LANG=it`: assertions use the Italian texts, which are the reference dictionary.

## Conventions

- **Translations**: every user-visible string goes through `t()`. Italian (`locales/it.ts`) is the reference dictionary and English (`locales/en.ts`) must have the same keys — TypeScript checks it. There are separate dictionaries for the server (`src/server/locales`), the Studio page (`src/web/locales`) and the overlay (`src/overlay/locales`).
- Code comments are mostly in Italian; English comments are welcome in new code.
- Keep `src/shared/protocol.ts` types and constants only.
- Server imports use `.js` extensions (NodeNext); web and overlay imports are extensionless.
- Formatting is Prettier's; linting is ESLint (`npm run lint`). CI runs both.

## Pull requests

- One topic per PR, with tests when behaviour changes.
- Make sure `npm run lint`, `npm run format:check`, `npm run typecheck` and `npm test` pass.
- Describe what you verified and on which OS — desktop modes behave differently on Windows, macOS and Linux.

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
