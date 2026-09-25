# Nerditulos

Live captions and translation for events with simultaneous talks. One configured administrator prepares and supervises sessions per room from a browser console; attendees choose a room and an available language and read captions in their browser without an account.

## Project status

The application is implemented as a single Node service with a React front end and PostgreSQL, and is deployed behind an HTTPS tunnel on the demonstration server. Two rooms (`sala-1`, `sala-2`) are seeded at boot.

Verification status, stated plainly:

- Unit and integration tests with a fake provider and a fake store cover the audio contract, text reduction, persistence-before-publication, finalization and its deadline, crash recovery, room isolation, the public cursor contract, the sender socket authorization matrix, and both translation directions, including Spanish sessions without an English stream (`npm test`).
- On the deployed installation, with real audio: a 30-second English WAV sent at playback speed from the console reached Soniox and unauthenticated readers over HTTPS (HTTP clients and a browser tab on the server host; English original and Spanish translation), the session finished 0.19 s after the file ended, a reload showed no duplicates, a following Spanish session in the same room kept the previous text visible until it went live, and two rooms ran live at the same time with different content and no cross-room text. The two-room conclusion stays pending because two of its required checks were only partially exercised.
- Also verified on the installation: a microphone session with live speech, finished manually through the confirmation dialog. Not verified yet: reading from a phone (no log captured) and the 30-minute two-room run with provider renewal during speech. Every row of [core acceptance](docs/core-acceptance.md) stays pending until its full conditions are exercised; short samples do not establish production behavior.
- On the deployed installation, with real audio, Spanish-to-English: a Spanish microphone session started one minute after the deployment offered Spanish original and English translation to a reader, persisted 6 Spanish and 5 English finals in 4 segments each, showed the English text when the reader switched language after the finish, and finished complete 0.23 s after the end frame; each English final was received 22 to 32 ms after its Spanish final. Not verified: a WAV sample at playback speed in this direction, two rooms at once with one Spanish and one English session, continuity across a console reconnect with a translation pending, per-unit timing against acoustic ends, English speech inside a Spanish talk, and usage per generation.
- Planned provider renewal, corpus latency (C05), reader queue load limits, the full accessibility audit, and consumption and cost figures are pending core work.

See the [provider evaluation](docs/provider-evaluation.md) for the isolated Soniox measurements and their limits.

## How it works

- **Rooms and sessions.** Each room has at most one active session (`starting`, `live`, `interrupted`, or `finishing`) and any number of prepared ones. Starting a session records its effective configuration; the room's visible session switches only when the new session goes live, so attendees keep reading the previous text while the next talk is being prepared. A session's streams are fixed when it is prepared: a Spanish session gets Spanish original and English translation; an English session gets English original and Spanish translation. Readers are offered only the languages a session has streams for, so a Spanish session prepared before English translation was available offers Spanish only; prepare it again to add English.
- **Audio.** The console captures the microphone or a WAV file with an AudioWorklet at 16 kHz mono, sends PCM16 frames tagged with their sample position over a WebSocket, and the service forwards them to Soniox. Pauses freeze the position; congestion drops are reported as gaps with a known extent; provider reconnections and sender reconnections are reported as discontinuities with known or unknown extent. Before starting a session, the console can test the room's source: the level meter, signal and clipping checks run as soon as a source is chosen, and "Probar micrófono" opens a provider connection without a session, capped at 5 minutes, that echoes the recognized original text back to the console only; nothing is persisted or published, and attendees of that room see no change.
- **Text.** Original and translated tokens are routed to separate streams by `translation_status`. The provider translates into the language of the session's translated stream, including after provider reconnections and resumed senders. Finals are ordered, persisted, and only then published; partials replace the current hypothesis. Segments open at provider `<end>` markers, at provider reconnections, and when a segment exceeds `SEGMENT_MAX_CHARS`.
- **Delivery.** Attendees subscribe with Server-Sent Events to `/api/rooms/:slug/stream?lang=xx`. Event ids are cursors; a valid cursor resumes with a delta, anything else gets a fresh snapshot. The same `lang` can be original text in one session and a translation in the next; cursors carry the output type, so a cursor from the previous session receives a fresh snapshot. The window holds the last `PUBLIC_WINDOW_SEGMENTS` segments; there is no backward browsing. The whole interface (rooms list, reader, console and sign-in) follows one language, Spanish or English, chosen with the ES | EN switch in the header (on the reader, the caption language selector plays that role) and resolved from `?lang=es` or `?lang=en` in the URL, then the last choice saved in that browser, then the browser's language, and Spanish by default; on the reader that language also sets the caption stream, and on the console it sets the sign-in widget. When the session does not offer the reader's language, the reader shows the session's default stream (Spanish when present, otherwise the first one) with a notice, and returns to the reader's language as soon as a session offers it.
- **Finishing.** Manual finish, file end, or sender loss sends the end frame to the provider and waits up to `DRAIN_TIMEOUT_MS` for pending output. Output that misses the deadline is stored but never served, and the session is marked incomplete. A session found in `finishing` after a crash is recovered with the same watermark rule.
- **Authorization.** Clerk establishes identity; the service authorizes only the user whose id equals `ADMIN_USER_ID`. Session tokens are verified on every administrative request and on the audio socket, which renews its token before expiry and refuses audio while unauthorized.

## Try it on Railway (generated domain)

Railway builds the repository's Dockerfile and gives the service an HTTPS domain under `up.railway.app`, so you can try the application from a phone before buying a domain. Railway deploys repositories your GitHub account can access, so start from your own copy.

1. Fork the repository on GitHub (or push a copy to your account).
2. Get the two accounts described in [Accounts](#accounts-clerk-and-soniox): a Clerk application (development instance keys, `pk_test_...` and `sk_test_...`) and a Soniox API key.
3. In Railway, create a project with New Project, Deploy from GitHub repo, and pick your copy (Railway asks for access to the repository the first time). Choose "Add variables" instead of deploying right away: a deployment without `APP_ORIGIN` exits at start with `Missing required environment variable APP_ORIGIN` in its logs.
4. Add the database with + New, Database, PostgreSQL. The service is named `Postgres`; the variables below refer to it by that name.
5. In the application service, open Settings, Networking, Generate Domain, and enter port 3000. Railway assigns a domain such as `<name>.up.railway.app` and exposes it in `RAILWAY_PUBLIC_DOMAIN`.
6. In the application service, open Variables, Raw Editor, and paste this block with your values:

   ```sh
   NODE_ENV=production
   PORT=3000
   APP_ORIGIN=https://${{RAILWAY_PUBLIC_DOMAIN}}
   EVENT_NAME=
   SONIOX_API_KEY=
   CLERK_PUBLISHABLE_KEY=pk_test_...
   CLERK_SECRET_KEY=sk_test_...
   ADMIN_USER_ID=
   PGHOST=${{Postgres.PGHOST}}
   PGPORT=${{Postgres.PGPORT}}
   PGUSER=${{Postgres.PGUSER}}
   PGPASSWORD=${{Postgres.PGPASSWORD}}
   PGDATABASE=${{Postgres.PGDATABASE}}
   ```

   Railway resolves the `${{...}}` references: the origin follows the generated domain, and the database values point at the Postgres service over Railway's private network (`postgres.railway.internal`), which needs no TLS; leave `PGSSLMODE` unset. Leave `ADMIN_USER_ID` empty for now. Deploy the staged changes.
7. [railway.json](railway.json) selects the Dockerfile builder, one replica, the health check on `/api/rooms`, and restart on failure. When the deployment is active, `https://<domain>/api/rooms` returns both rooms as JSON. If a deployment fails at start, the service logs show the missing variable.
8. Open `https://<domain>/admin`. The Clerk form shows its development-mode badge and offers sign-in and, while sign-ups are enabled, sign-up; create the administrator account with an email code or link. Then in the Clerk Dashboard, Users, open that user and copy the User ID (`user_...`), set `ADMIN_USER_ID` in Railway, and deploy the change. Until then the console shows "Administración no configurada".
9. In the console, prepare a session (an English talk, for example), choose "Usar micrófono" or a WAV file, and press "Iniciar". On a phone, open `https://<domain>/r/sala-1`: the reader shows "En vivo" and the captions appear while the talk continues, in the languages the session offers. Attendees choose the room from `https://<domain>/`; a link such as `https://<domain>/r/sala-1?lang=en` opens the reader in English.

Every variable change on Railway is a new deployment; see [Testing limitations of the trial setup](#testing-limitations-of-the-trial-setup) before using this setup for an audience.

## Accounts: Clerk and Soniox

**Clerk** establishes the administrator's identity. Create an application in the [Clerk Dashboard](https://dashboard.clerk.com). Each application has a development instance: its keys start with `pk_test_` and `sk_test_`, it works on any domain, its sign-in form carries a development-mode badge, and it is limited to 100 users. Under User & authentication, Email, enable the email verification code or the email link so the administrator can sign in by email. Anyone who reaches `/admin` can sign up while sign-ups are open; only the user whose id equals `ADMIN_USER_ID` gets administrative access, and once that account exists you can set the sign-up mode to Restricted under Restrictions. The keys are on the API keys page; the User ID (`user_...`) is on each user's page under Users. A production instance requires your own domain; see [Production requirements](#production-requirements).

**Soniox** provides recognition and translation. Create an account at [console.soniox.com](https://console.soniox.com) and create a key under API keys. Billing is pay-as-you-go by audio time; new accounts may include trial credit, which the console shows. The key stays on the backend as `SONIOX_API_KEY`; the browser never receives it.

## Self-hosted installation

Requirements: Docker with Linux containers and Docker Compose v2, a Soniox API key, a Clerk application, and an HTTPS origin that reaches the service on port 3000 of the host (a reverse proxy or tunnel running on the same host; the container binds `127.0.0.1:3000`).

1. Clone the repository and check out the revision you want to run (a tag, or the default branch):

   ```sh
   git clone https://github.com/luquibu/nerditulos.git
   cd nerditulos
   ```

2. Copy [.env.example](.env.example) to `.env` and fill it in: `APP_ORIGIN` (your public origin), PostgreSQL values, `SONIOX_API_KEY`, and the Clerk publishable and secret keys. Leave `ADMIN_USER_ID` empty for now. Put a value that contains `$`, spaces, or `#` in single quotes.
3. Build and start everything:

   ```sh
   docker compose config --quiet
   docker compose up -d --build app
   docker compose ps
   ```

   The `app` service waits for the database, applies migrations once, seeds the rooms, and serves the web app and the API. Health: `curl http://127.0.0.1:3000/api/rooms`. A configuration error is logged by `docker compose logs app` as a `fatal` line and the container restarts until it is fixed.
4. Open `https://<your origin>/admin` and sign up or sign in with the account that will administer the event. In the Clerk dashboard, open Users, copy that user's id (`user_...`), set `ADMIN_USER_ID` in `.env`, and recreate the container so it reads the new value:

   ```sh
   docker compose up -d app
   ```

   Until then the console shows "Administración no configurada" and every administrative request answers 503. A request without a valid token answers 401, and other signed-in accounts get 403.
5. In the console, prepare a session (title and source language; Spanish sessions add English translation and English sessions add Spanish translation), choose a source ("Usar micrófono" or a WAV file), and start it. Attendees open `https://<your origin>/` and pick the room; a link such as `https://<your origin>/r/sala-1?lang=en` opens the reader in English.

To replace the administrator, change `ADMIN_USER_ID` and recreate the container; previous sender connections are closed and the old account gets 403.

Clerk note: a development instance is fine for testing. For an event, use a production Clerk instance with your domain configured, since development tokens and the sign-in UI carry development-mode behavior.

### End-to-end check

After the installation, this sequence exercises the whole path with expected results:

1. `curl https://<your origin>/api/rooms` returns JSON with `sala-1` and `sala-2`; `curl https://<your origin>/api/config` returns `"adminConfigured":true` and a publishable key, and no secret.
2. `curl -N "https://<your origin>/api/rooms/sala-1/stream?lang=es"` prints `retry: 2000`, a `session` event, and a `: ping` comment at most every 15 seconds while it stays open.
3. In the console, start a session from a WAV file. `https://<your origin>/api/rooms/sala-1` shows `"state":"live"`, and a phone on another network shows "En vivo" on `https://<your origin>/r/sala-1` with the captions appearing while the file plays.
4. When the file ends, the room shows `"state":"finished"` and the reader shows "Finalizada" with the text kept; reloading the reader shows the same text without duplicates.

### Reverse proxy

The proxy or tunnel in front of port 3000 must:

- forward WebSocket upgrades on `/ws/sender` and keep the `Origin` header, which the service compares with `APP_ORIGIN` (a socket without a matching origin gets 403);
- pass `/api/rooms/*/stream` responses through without buffering or compression, as they are `text/event-stream` (the service sets `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`);
- allow idle connections longer than 25 seconds: the reader stream sends a comment every 15 seconds and the audio socket pings every 25 seconds, and the service keeps HTTP connections alive for 65 seconds;
- terminate HTTPS. The service does not serve TLS and trusts `X-Forwarded-*` headers from the loopback interface only.

### Operations

- **Update.** Tag the running image, then rebuild:

  ```sh
  docker tag nerditulos-app:latest nerditulos-app:previous
  docker compose up -d --build app
  ```

  Recreating the container ends live sessions: sessions found `starting` or `live` at boot are marked interrupted, and their finals stay readable. Do not redeploy during a talk.
- **Rollback.** `compose.rollback.yaml` runs the previously tagged image: `docker compose -f compose.yaml -f compose.rollback.yaml up -d app`. After rolling back to an image without Spanish-to-English support, finish any Spanish session started by the newer image before rolling back, and do not start Spanish sessions it prepared: the older image would request Spanish translation and store it in their English stream. Prepare them again instead.
- **Data.** PostgreSQL data lives in the volume `<project>_postgres-data`, where `<project>` is the name of the directory holding `compose.yaml`. `docker compose down` and `docker compose up -d` keep it; never use `docker compose down -v` as routine cleanup, it deletes the volume. The database password is written into the volume on the first start; changing `POSTGRES_PASSWORD` afterwards requires changing it in the database too.
- **Backup.** `docker compose exec db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > backup.sql` writes a dump; restore it into an empty database with `docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB"' < backup.sql`.
- **Logs.** `docker compose logs -f app` shows one JSON object per line. The `listening` line reports `adminConfigured` and `providerConfigured`; `token verification failed` lines carry Clerk's reason and never the token.

### Adapting to your event

- **Rooms.** The seed list `ROOM_SEED` in `server/src/main.ts` defines the rooms (slug and name); slugs are lowercase letters, digits, and hyphens, and appear in the URLs (`/r/<slug>`). Edit it and rebuild the image; existing rooms keep their sessions.
- **Name.** `EVENT_NAME` appears in the rooms page heading and in browser tab titles.
- **Branding.** The web app is themed for Nerdearla: `data-theme` in `web/index.html`, colors in `web/src/styles/tokens.css`, and the logo `web/public/brand/nerdearla-simplified.svg` referenced from `web/src/RoomsPage.tsx`, `web/src/attendee/RoomPage.tsx`, `web/src/admin/AdminShell.tsx`, and `web/src/admin/ConsolePage.tsx`. Replace them for any other event and rebuild; the logos are not distributed under MIT (see [NOTICE](NOTICE)).

## Testing limitations of the trial setup

The Railway trial with a Clerk development instance is for trying the application, not for serving an audience:

- The Clerk development instance shows its badge in the sign-in form, synchronizes sessions through the URL, and is limited to 100 users; anyone can sign up while sign-ups are open, although only `ADMIN_USER_ID` gets administrative access.
- Railway closes HTTP responses after 15 minutes, and after 5 minutes without data. A reader whose stream is closed reconnects with its cursor and continues from where it was; the audio socket is not subject to this limit.
- Every variable change or push to the deployed branch is a new deployment, which ends live sessions.
- Trial credit is limited and the service stops when it runs out; memory and CPU follow the plan.
- Database backups are off unless enabled on the Postgres service; the trial runs in one region with one replica.

## Production requirements

- **Domain.** A production Clerk instance needs your own domain: Clerk asks for DNS records for its Frontend API and account pages, and issues `pk_live_` and `sk_live_` keys. Configure that domain as the site's origin, over HTTPS.
- **Origin.** `APP_ORIGIN` is exactly the origin the browser uses (scheme and host, no path). A mismatch rejects sign-in tokens and audio sockets.
- **One replica.** Session state, provider connections, and the reading window live in the process; see [Limits and scaling](#limits-and-scaling).
- **Hosting.** Either Railway with the custom domain attached to the service, or a self-hosted proxy that meets the [reverse proxy](#reverse-proxy) requirements.
- **Operations.** Backups, a rollback path, rooms and branding adapted before the event, and no redeployment during talks; see [Operations](#operations).
- **Database TLS.** `compose.yaml` connects to its own database over the Compose network without TLS, and Railway's private network is encrypted by itself. A database that enforces TLS needs the connection to verify its certificate: set `PGSSLMODE=require`, which node-postgres reads directly and turns into a TLS connection verified against the system certificate authorities, with the certificate naming `PGHOST`. For a private or self-signed authority add `NODE_EXTRA_CA_CERTS=<PEM file>` where the server process runs (under Compose, add the variable and a bind mount for the file to the `app` service in a `compose.override.yaml`). The error text in the logs points at the setting: `no pg_hba.conf entry ... no encryption` (or `... SSL off`) needs `PGSSLMODE=require`; `self-signed certificate` or `unable to get local issuer certificate` needs `NODE_EXTRA_CA_CERTS`; `Hostname/IP does not match certificate's altnames` means the certificate does not name `PGHOST`.

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `APP_ORIGIN` | yes | | Public origin; authorized party for tokens and the socket origin check |
| `NODE_ENV` | no | `development` | `production` accepts only `APP_ORIGIN`; any other value also accepts `http://localhost:<PORT>` and `http://127.0.0.1:<PORT>` |
| `EVENT_NAME` | no | empty | Name shown in the rooms page heading and browser tab titles |
| `PORT` | no | 3000 | Listening port. `compose.yaml` fixes it to 3000 inside the container; on Railway set it to the port of the generated domain; for a host-run server see [docs/development.md](docs/development.md) |
| `SONIOX_API_KEY` | yes for audio | empty | Provider key, backend only |
| `SONIOX_MODEL` | no | `stt-rt-v5` | Provider real-time model |
| `CLERK_PUBLISHABLE_KEY` | yes for admin | empty | Delivered to the browser through `/api/config` |
| `CLERK_SECRET_KEY` | yes for admin | empty | Token verification, backend only |
| `ADMIN_USER_ID` | yes for admin | empty | The only authorized administrator |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | yes under Compose | | Database created by the `db` service; `compose.yaml` passes them to the app as the `PG*` fields below |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` | yes | `PGPORT` 5432 | Database connection as discrete fields, never a URL. Set directly on Railway and in `.env.local`; under Compose they come from `POSTGRES_*` |
| `PGSSLMODE` | no | unset | Read by node-postgres directly, not passed by `compose.yaml`; `require` makes the connection TLS with certificate verification (see [Production requirements](#production-requirements)) |
| `NODE_EXTRA_CA_CERTS` | no | unset | Read by Node at start, not passed by `compose.yaml`; PEM file with extra certificate authorities for database TLS |
| `DRAIN_TIMEOUT_MS` | no | 15000 | Pending output allowance when finishing |
| `PUBLIC_WINDOW_SEGMENTS` | no | 20 | Public reading window per stream |
| `SEGMENT_MAX_CHARS` | no | 400 | Segment length before a new one opens at a word boundary |

The container receives an explicit environment map from `compose.yaml`; no `.env` file is copied into the image.

## Development

[docs/development.md](docs/development.md) covers running the server and the web app on your machine with live reload, breakpoints in the backend and the frontend, and the tests. The commands are `npm ci`, `npm run build`, `npm run dev`, `npm test`, and `npm run typecheck`.

Workspaces: `shared/` (wire contracts, cursor and frame codecs, chunker), `server/` (Express 5, ws, pg, @clerk/backend), `web/` (Vite, React, @clerk/react).

## Limits and scaling

Tested versus estimated, kept apart on purpose:

- **Tested:** the automated suite (fake provider and store), the deployed public pages and API over HTTPS, and SSE heartbeats through the tunnel. Nothing about real-audio capacity has been measured in the application yet.
- **Estimated, not tested:** one Node process handles two rooms with one provider connection each and the attendee fan-out. Fan-out is in memory and never awaits a reader; a reader whose socket stays backpressured for 5 s or holds more than 256 KB pending is disconnected and gets a fresh snapshot on reconnect. Every session requests translation from the provider (English to Spanish or Spanish to English), so provider output includes translated text for every room. Costs per room-hour and the number of concurrent readers per room have not been measured.
- **Single replica.** Session state, provider connections, and the reading window live in the process. Running more than one replica is not supported: the database schema serializes migrations and enforces one active session per room, but a second process would not share provider connections or fan-out.
- **Provider caps.** Soniox limits a real-time stream to 300 minutes and the account to a number of concurrent connections (10 at the time of writing); a session longer than the cap needs the planned renewal, which is not implemented. Keepalives are sent during pauses and count as stream time.
- **Reconnection.** An unexpected provider close is retried with backoff (1, 2, 5, 10 s) for up to 60 s while the sender stays connected; audio captured meanwhile is dropped and reported as a discontinuity. An unexpected sender loss interrupts the session; the console can reconnect with the same session identity.

To scale to more rooms on one host, add rooms to the seed list in `server/src/main.ts`, raise the provider concurrency quota, and measure: provider latency per room, Node CPU under fan-out, and the tunnel's behavior under many SSE connections. Separate hosting cost from provider cost when reporting.

## Contributing

- [Contribution guide](CONTRIBUTING.md)
- [Local development](docs/development.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Security reporting status and policy](SECURITY.md)
- [Development instructions](AGENTS.md)

## License and notices

Project code is licensed under [MIT](LICENSE). Third-party material retains its own terms: see [NOTICE](NOTICE) for the Nerdearla logo files, the OFL-licensed fonts, and the Lucide icons. License texts are served at `/fonts/OFL-*.txt` and `/licenses/LICENSE-lucide.txt`. Conference recordings and private diagnostic evidence are not distributed with this repository.
