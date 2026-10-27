# AI Call Center API

NestJS API for the AI Call Center admin platform. It authenticates administrators, manages members, and stores speech provider configuration. Provider API keys are encrypted before they are written to PostgreSQL.

## Architecture

- `auth` issues a 12-hour JWT in an httpOnly cookie. Production cookies are `Secure` and `SameSite=None` so the Vercel frontend can call this API. Bearer tokens are also accepted.
- `users` lists and creates `ADMIN` accounts. There is no public registration. The first admin is created at startup from environment variables only when that email does not already exist. An existing account is never overwritten.
- `speech-to-text` stores every provider in one `speech_to_text_models` table. Provider-specific fields live in a JSON config. `ProviderRegistry` selects an implementation such as `ElevenLabsProvider`.
- `text-to-speech` stores every provider in one `text_to_speech_models` table. ElevenLabs is the only provider. A model keeps the encrypted API key, the ElevenLabs model id, and the voice. The browser asks this API to speak; it never receives the key. The first time a saved model speaks a line, that audio is stored. The same model and the same line reuse it, even from two scenario steps. A new voice or provider model starts a new clip.
- `health` checks the process and runs `SELECT 1`.
- `organizations` stores a name and an optional description. Members, speech models, and playground data are not tied to an organization. Names are unique ignoring case and extra spaces.
- `scenarios` belong to an organization. Each one stores a name, an optional description, an icon, and a graph of Start, Text to speech, and End steps. Text to speech keeps the line to say and an optional text-to-speech model. The browser can play that path for testing.
- `phone-streaming` stores a Twilio account. The auth token is encrypted. `phone-numbers` stores a number on that account. A scenario chooses one number, and no other scenario can use it. `POST /telephony/twilio/voice` is the voice webhook: Twilio's signature is checked, and a published scenario opens a media stream so the API can hear the caller and speak the scenario. The host is the one the request already arrived on.

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

## Scenario-controlled realtime voice

Scenario mode now executes the connected graph on the server instead of flattening it into a voice briefing. The realtime model asks questions, speaks configured lines, and requests tools; `ScenarioVoice` owns the current node, revision, connected routes, and operation limits. Both browser Play/replay and Twilio use this controller. Browser Play passes the validated draft graph; phone and public demo sessions use saved settings. Public demo talk tokens are bound to their assigned scenario.

Each conversational loop supports:

- `instructions` (up to 4000 characters): what to collect, how to handle the request, and when to continue.
- `knowledgeSearch`: `off` (default for existing graphs), `optional`, or `required`. Required searches run in the backend even when the voice requests no search.
- `replyMode`: `realtime` (default) or `llm`. The latter calls the scenario language's configured LLM with the question, step instructions, and successful retrieved passages, then gives its draft to the voice model.

A loop calls `run_step` for each factual response. Search results are limited passages from this scenario's learned knowledge. Empty results and failed operations have distinct statuses. `advance_scenario` can follow only a configured outgoing edge, with matching node ID and revision; topic switches and closing steps require a valid route. Search and LLM calls time out after 15 seconds. Concurrent, stale, and out-of-step requests cannot move the graph. Limits are 100 transitions per session and the configured max step requests per loop visit. A short configured delay line may be spoken while work runs. Reaching End finishes after a goodbye.

Add and Learn sources using the scenario's Knowledge panel, select Required on the support loop, and start a new conversation. For a separate drafting model, choose Language LLM in the step and configure the language model under Models. No database migration is needed: step policy is stored in the graph JSON. Existing scenarios keep search off until explicitly enabled; existing Context mode remains available and now uses a knowledge tool on OpenAI as well as Gemini, without the transcription timeout path.

Example: Start → greeting → conversational loop (ask destination; required search; answer roaming questions until satisfied) → Closing. Connect Still has questions back to the loop and No more questions to End. Topic switches can route to different loops with different instructions and search policies. No account mutation, booking, payment, or live transfer integrations are added by this change; do not describe those actions as completed.

Workflow node, search-result, and operation events are recorded with browser executions and phone calls. Search events include the query and returned passages. Runtime logs include event type and node ID without document contents. Review Executions to distinguish missing information from failed retrieval. The voice model follows step instructions and factual-grounding rules; server enforcement covers tools and graph transitions, not a guarantee about every spoken word.

Validation uses deterministic provider doubles for tool protocol, interruption, graph routing, required retrieval, separate drafting, missing facts, and operation errors. Real provider voice and Twilio calls still require a deployment and a live acceptance call.
