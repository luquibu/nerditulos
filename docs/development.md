# Local development

This guide runs the application on your machine from a clone of the repository: the server as a Node process, the web app through Vite with hot reload, and PostgreSQL in Docker. It also covers breakpoints in the backend and the frontend, and the tests. Deployment for an event is described in the [README](../README.md).

## Prerequisites

- Node.js 24 with npm (tested with 24.14.1; the container image uses `node:24-alpine`). The repository is an npm workspace: one `npm ci` at the root installs `shared/`, `server/`, and `web/`.
- Docker with Linux containers and Docker Compose v2, for PostgreSQL. The server itself runs on the host.
- Git.
- A Clerk application (development instance) and a Soniox API key, to use the console with audio. Without them the public pages and the API still run; see [Accounts](../README.md#accounts-clerk-and-soniox) in the README.

## Install and build

```sh
git clone https://github.com/luquibu/nerditulos.git
cd nerditulos
npm ci
npm run build
```

`npm run build` compiles `shared/` and `server/` to their `dist/` directories, copies the SQL migrations next to the compiled migration module, copies the fonts into `web/public/fonts/`, and builds `web/dist`. Run it once before `npm run dev` or `npm run typecheck`: the server entry point is `server/dist/main.js`, and `@nerditulos/shared` resolves to `shared/dist` from the other workspaces.

## Database

The `db` service in `compose.yaml` publishes no port, so a server running on the host cannot reach it. The example override publishes it on the loopback interface only:

```sh
cp compose.override.example.yaml compose.override.yaml
cp .env.example .env
docker compose up -d db
```

On Windows without a POSIX shell, use `copy` instead of `cp`. Docker Compose merges `compose.override.yaml` automatically; Git ignores it. Compose reads `.env` for the whole file, so it needs `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `APP_ORIGIN` even when only `db` starts; for local development `APP_ORIGIN` can keep the example value. Put a password that contains `$`, spaces, or `#` in single quotes (`POSTGRES_PASSWORD='x$y z'`). The password is written into the volume on the first start; changing it in `.env` later does not change it in the database.

Data lives in the volume `<project>_postgres-data`, where `<project>` is the name of the repository directory. `docker compose down` keeps it; `docker compose down -v` deletes it.

## Server configuration: `.env.local`

The host-run server reads `.env.local` in the repository root (Node's `--env-file-if-exists`), and Vite reads `PORT` from the same file for its proxy. Git ignores it. Compose does not read it. Use the `PG*` names here, with the same values as `POSTGRES_*` in `.env`:

```sh
# Server on the host and Vite proxy target. Change it if 3000 is busy.
PORT=3000
# Origin of the console and the reader during development: the Vite dev server.
APP_ORIGIN=http://localhost:5173
EVENT_NAME=

PGHOST=127.0.0.1
PGPORT=5432
PGUSER=app
PGPASSWORD=
PGDATABASE=app

# Clerk development instance (API keys page). They start with pk_test_ and sk_test_.
CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
# Filled in after the first sign-in (see "Use the application").
ADMIN_USER_ID=

SONIOX_API_KEY=
```

Leave `NODE_ENV` unset. In development the server accepts three origins: `APP_ORIGIN` (the Vite dev server) plus `http://localhost:<PORT>` and `http://127.0.0.1:<PORT>` for the built web app served by the server itself. Sign-in tokens and the audio socket are checked against those origins, so the console must be opened from one of them. A value that contains `$` goes in single quotes, as in `.env`; Node strips the quotes and does not expand anything.

Variables already present in your shell take precedence over the file. The file is read at start only: after editing it, restart `npm run dev`.

## Run

```sh
npm run dev
```

This starts four processes with prefixed output and stops all of them together with Ctrl+C:

| Prefix | Command | What it does |
| --- | --- | --- |
| `shared` | `tsc --watch` in `shared/` | Recompiles the wire contracts to `shared/dist` |
| `server` | `tsc --watch` in `server/` | Recompiles the server to `server/dist` |
| `node` | `node --watch --inspect --env-file-if-exists=.env.local --enable-source-maps server/dist/main.js` | Runs the server on `PORT` (default 3000) with the inspector on `127.0.0.1:9229`, and restarts it when a compiled file changes |
| `web` | `vite` in `web/` | Serves the web app on `http://localhost:5173` and proxies `/api` and `/ws` to `127.0.0.1:<PORT>` |

Each is also available alone: `npm run watch:shared`, `npm run watch:server`, `npm run dev:server`, `npm run dev:web`. Both compilers re-emit when they start, so the server restarts once or twice right after launch. While the server restarts, Vite logs a proxy error for any open reader stream; the reader reconnects by itself. The server applies the migrations and seeds the two rooms at start; its log is one JSON object per line, and the `listening` line reports `adminConfigured` and `providerConfigured`. A configuration error is logged as a `fatal` line and the process exits; `node --watch` waits for the next file change.

If port 3000 is taken, change `PORT` in `.env.local`: the server and the Vite proxy both read it.

## Use the application

- `http://localhost:5173/` lists the rooms; `http://localhost:5173/r/sala-1` is a room's reader, and `http://localhost:5173/r/sala-1?lang=en` opens it in English (the reader language otherwise follows the choice saved in the browser, then the browser's language, then Spanish).
- `http://localhost:5173/admin` is the console. Sign in with your Clerk development instance. The console shows "Administración no configurada" until `ADMIN_USER_ID` is set: open the Clerk Dashboard, Users, select your user, copy the User ID (`user_...`), put it in `.env.local`, and restart `npm run dev`.
- In the console, prepare a session (title and source language), choose "Usar micrófono" or a WAV file, and press "Iniciar". Open the room's reader in another window to follow the captions; a private window shows what an attendee without an account sees. The session offers its source language and the configured translation; the reader's menu lists what the session offers.
- `http://localhost:<PORT>/` serves the last `npm run build` output from `web/dist` through the server itself, without Vite. Use it to check the production bundle.

Microphone capture needs a secure context: `http://localhost` and `http://127.0.0.1` qualify, other hosts need HTTPS. Opening the console from another device on the LAN over plain HTTP gives no microphone; the WAV source still works there, provided the origin the browser uses is one of the accepted origins.

Add `?debug=1` to the console URL to log every audio chunk, pause, resume, and discontinuity to the browser console as `[sender]` JSON lines, and to a reader URL to log each received event with its display time as `[reader]` lines.

## How changes propagate

| You change | What happens |
| --- | --- |
| `server/src/**/*.ts` | The server `tsc` emits to `server/dist`; `node --watch` restarts the server |
| `shared/src/**/*.ts` | The shared `tsc` emits to `shared/dist`; the server restarts (it imports `shared/dist`); the server `tsc` re-checks when the declarations change; Vite hot-updates the web modules that import the package |
| `web/src/**` | Vite hot module replacement |
| `server/src/db/migrations/*.sql` | Copied by `npm run build -w server`, not by the watcher; run it and the server restarts and applies the new migration |
| `.env.local` | Not watched; restart `npm run dev` |
| `web/vite.config.ts` | Vite restarts itself |
| Dependencies in a `package.json` | `npm install` at the root, then restart `npm run dev` |

## Breakpoints

Source maps are emitted by `tsc` (`sourceMap` in `tsconfig.base.json`) and `--enable-source-maps` makes the server's stack traces point at the TypeScript files.

**Backend, VS Code.** With `npm run dev` running, open Run and Debug and start "Server: attach" (`.vscode/launch.json`). It connects to the inspector on 127.0.0.1:9229 and reconnects after each restart. Set a breakpoint in a TypeScript file, for example on the `/config` handler in `server/src/routes/public.ts`, and request `curl http://localhost:3000/api/config`: execution pauses on the TypeScript line. "Server: launch" runs the server under the debugger instead of the `node` process: stop `npm run dev`, start `npm run watch:shared`, `npm run watch:server`, and `npm run dev:web` in terminals, then launch it; it does not restart on file changes by itself.

**Backend, Chrome DevTools.** Open `chrome://inspect`, and under Remote Target pick the Node process; Sources shows the TypeScript files through the source maps.

**Frontend, VS Code.** Start "Web: Chrome": it opens `http://localhost:5173` in a Chrome instance controlled by the debugger. Breakpoints in `web/src/**`, for example in `web/src/attendee/RoomPage.tsx`, bind through Vite's development source maps and pause when the room page loads. The browser's own DevTools work the same way: the files appear under `src/` in the Sources panel.

**Tests.** With `npm run dev` stopped (the inspector port would be busy), run `npx vitest --inspect-brk --no-file-parallelism <test file>`; vitest waits before running until a debugger attaches, so start "Server: attach", then continue. Breakpoints in the test and in the code under test bind.

## Tests

```sh
npm test                                            # whole suite, no database or provider needed
npx vitest run server/src/public/streamHub.test.ts  # one file
npx vitest                                          # watch mode
npm run typecheck                                   # after npm run build
```

The suite uses a fake provider and a fake store. One test replays local provider recordings that are not distributed with the repository; it is skipped when they are absent.

## Docker for parity

To run what the container image runs, use the Compose loop from the README, with `APP_ORIGIN` in `.env` set to the origin you will open:

```sh
docker compose up -d --build app
docker compose logs -f app
```

The container binds `127.0.0.1:3000` on the host. It does not read `.env.local`. With `compose.override.yaml` present, the database also stays published on the loopback interface.
