# AI Call Center API

NestJS API for the AI Call Center admin platform. It authenticates administrators, manages members, and stores speech provider configuration. Provider API keys are encrypted before they are written to PostgreSQL.

## Architecture

- `auth` issues a 12-hour JWT in an httpOnly cookie. Production cookies are `Secure` and `SameSite=None` so the Vercel frontend can call this API. Bearer tokens are also accepted.
- `users` lists and creates `ADMIN` accounts. There is no public registration. The first admin is created at startup from environment variables only when that email does not already exist. An existing account is never overwritten.
- `speech-to-text` stores every provider in one `speech_to_text_models` table. Provider-specific fields live in a JSON config. `ProviderRegistry` selects an implementation such as `ElevenLabsProvider`.
- `text-to-speech` stores every provider in one `text_to_speech_models` table. ElevenLabs is the only provider. A model keeps the encrypted API key, the ElevenLabs model id, and the voice. The browser asks this API to speak; it never receives the key. The first time a saved model speaks a line, that audio is stored. The same model and the same line reuse it, even from two scenario steps. A new voice or provider model starts a new clip.
- `health` checks the process and runs `SELECT 1`.
- `organizations` stores a name and an optional description. Members, speech models, and playground data are not tied to an organization. Names are unique ignoring case and extra spaces.
- `scenarios` belong to an organization. Each one stores a name, an optional description, an icon, and a graph of Start, Text to speech, Conversational loop, Topic switch, Keypad menu, and End steps. Publishing checks that a call can run the graph from Start to End and renders every fixed line as a phone (μ-law) clip.
- `calls` runs a scenario. A call session walks the graph in this process, talks to the caller over a WebSocket in Twilio's media stream format, and records the run as a scenario execution: the events, a caller track, and a mix. The designer's Play button is a browser call: `POST /calls/browser` checks the graph and returns a one-time token, and the browser opens `/calls/browser/stream` with it. `GET /calls`, `GET /calls/callbacks`, and `POST /calls/:id/called-back` serve the Calls and Callbacks pages.
- `telephony` takes phone calls from Twilio. `POST /telephony/twilio/voice` checks `X-Twilio-Signature`, finds the scenario of the number called, and answers with TwiML that opens a media stream to `/telephony/twilio/stream`. That handshake is signed too. A number with no published scenario is hung up and stored as `NO_SCENARIO`.
- `phone-numbers` stores the numbers callers dial. Each runs exactly one published scenario, and that scenario cannot be unpublished while a number uses it.

Passwords are hashed with bcrypt. API keys use AES-256-GCM. List and detail responses return only the last four characters of a key.

## Local setup

```bash
npm install
cp .env.example .env
npm run dev
```

`dev` applies pending migrations, then rebuilds and restarts the API whenever a file changes. `npm run build && npm start` runs the built API, as production does. The API listens on `PORT` (default 3001).

## Environment variables

See `.env.example` for names. Do not commit real values.

- `DATABASE_URL` — PostgreSQL connection string
- `JWT_SECRET` — long random string
- `CREDENTIAL_ENCRYPTION_KEY` — 32 bytes, base64
- `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` — used only to create the first admin
- `FRONTEND_URL` — comma-separated allowed browser origins
- `PORT`
- `CALL_TOKEN_SECRET` — long random string that signs call tokens. Play does not start without it.
- `PUBLIC_BASE_URL` — the API's public `https` origin. Call stream URLs are built from it, and Twilio signatures are checked against it, so it must match the webhook URL set in Twilio. Defaults to `http://localhost:PORT`.
- `TWILIO_AUTH_TOKEN` — the Twilio account's auth token, used only to check Twilio's signatures. Phone calls are refused without it.

## Phone calls

1. In Twilio, open the number's **Voice configuration**. Set **A call comes in** to webhook `POST {PUBLIC_BASE_URL}/telephony/twilio/voice`.
2. Set `TWILIO_AUTH_TOKEN` and `PUBLIC_BASE_URL` on the API, then add the number on the Phone numbers page with a published scenario.
3. Set `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=900` on Railway. A deploy then lets live calls finish: on shutdown the API takes no new calls and waits for the live ones to end.

Twilio cannot reach `localhost`. Test phone calls against a deployed API, or through a tunnel whose URL is `PUBLIC_BASE_URL`.

Generate an encryption key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Database migrations

Schema changes belong in `prisma/migrations`. Production runs `npx prisma migrate deploy` before the server starts. Do not use `prisma db push` in production.

## Deployment

Railway builds with Nixpacks and starts with the command in `railway.toml`. Set the variables above in the Railway service. Point `DATABASE_URL` at the Railway PostgreSQL plugin. Set `FRONTEND_URL` to the deployed Vercel origin, without a trailing path.

## Adding a speech-to-text provider

1. Add the provider to the `SttProvider` enum in `prisma/schema.prisma` and create a migration.
2. Add a class that implements `SpeechToTextProvider` under `src/speech-to-text/providers`. Put validation, encryption of secrets, public redaction, and the connection test in that class.
3. Register the class in `ProviderRegistry` and in `SpeechToTextModule`.
4. Add the provider to the frontend provider list and its form fields.

ElevenLabs is validated with `GET https://api.elevenlabs.io/v1/user`. That confirms the API key. It does not run a billed transcription.
