// Every timing and threshold the call runtime uses. Expect to tune these after test calls.

/** Every transport carries 8 kHz mono audio in 20 ms frames. */
export const SAMPLE_RATE = 8000;
export const FRAME_MS = 20;
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000;

/** Speech detection, the same values the browser loop used. */
export const SPEECH_RMS = 0.025;
export const SPEECH_HOLD_MS = 320;
export const BLIP_MS = 250;

/** How long after a clip should have finished the session waits for its mark before counting it as played. */
export const MARK_GRACE_MS = 5_000;

/** Outbound audio goes out in pieces of at most one second. */
export const MEDIA_CHUNK_BYTES = SAMPLE_RATE;

/** How often the session refreshes its execution so the 2-minute rule leaves it alone. */
export const HEARTBEAT_MS = 15_000;

/** A phone call whose media stream has not started by then is ended. */
export const STREAM_START_LIMIT_MS = 60_000;

/** How long a closing step waits for an answer before it counts silence as no more questions. */
export const CLOSING_NO_INPUT_SECONDS = 15;

/** Pauses on Start and End, as in the browser. */
export const START_PAUSE_MS = 650;
export const END_PAUSE_MS = 900;
