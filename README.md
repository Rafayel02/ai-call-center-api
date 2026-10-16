# AI Call Center API

NestJS API for the AI Call Center admin platform. It authenticates administrators, manages members, and stores speech provider configuration. Provider API keys are encrypted before they are written to PostgreSQL.

## Architecture

- `auth` issues a 12-hour JWT in an httpOnly cookie. Production cookies are `Secure` and `SameSite=None` so the Vercel frontend can call this API. Bearer tokens are also accepted.
- `users` lists and creates `ADMIN` accounts. There is no public registration. The first admin is created at startup from environment variables only when that email does not already exist. An existing account is never overwritten.
- `speech-to-text` stores every provider in one `speech_to_text_models` table. Provider-specific fields live in a JSON config. `ProviderRegistry` selects an implementation such as `ElevenLabsProvider`.
- `text-to-speech` stores every provider in one `text_to_speech_models` table. ElevenLabs is the only provider. A model keeps the encrypted API key, the ElevenLabs model id, and the voice. The browser asks this API to speak; it never receives the key.
- `health` checks the process and runs `SELECT 1`.
- `organizations` stores a name and an optional description. Members, speech models, and playground data are not tied to an organization. Names are unique ignoring case and extra spaces.
- `scenarios` belong to an organization. Each one stores a name, an optional description, an icon, and a graph of Start, Text to speech, and End steps. Text to speech keeps the line to say and an optional text-to-speech model. The browser can play that path for testing. The API does not run a scenario or a phone call.

Passwords are hashed with bcrypt. API keys use AES-256-GCM. List and detail responses return only the last four characters of a key.

## Local setup

```bash
npm install
cp .env.example .env
npx prisma migrate deploy
npm run start
```

The API listens on `PORT` (default 3001).

## Environment variables

See `.env.example` for names. Do not commit real values.

- `DATABASE_URL` — PostgreSQL connection string
- `JWT_SECRET` — long random string
- `CREDENTIAL_ENCRYPTION_KEY` — 32 bytes, base64
- `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` — used only to create the first admin
- `FRONTEND_URL` — comma-separated allowed browser origins
- `PORT`

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
