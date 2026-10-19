/** Thrown when whoever asked for a provider request stopped waiting for it. It is not a provider failure. */
export class RequestAborted extends Error {
  constructor() {
    super('The request was stopped.');
    this.name = 'AbortError';
  }
}

/** A provider's own timeout, combined with the caller's signal when there is one. */
export function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([AbortSignal.timeout(ms), signal]) : AbortSignal.timeout(ms);
}
