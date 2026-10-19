// -----------------------------------------------------------------------------
// UptimeRobotError: every failure of a request to the UptimeRobot API, with a
// code the app maps to a status, a retry policy or a message. Messages never
// carry the API key: the `error` object of the API may echo it
// (`passed_value`), so only its `type` (and `parameter_name`) are kept.
// -----------------------------------------------------------------------------

export const CODES = Object.freeze({
  UNREACHABLE: 'unreachable', // no connection
  TIMEOUT: 'timeout', // no answer in time
  HTTP: 'http', // an HTTP status other than 2xx (see `status`)
  API: 'api', // a `{ "stat": "fail" }` answer (see `apiType`)
  BAD_ANSWER: 'bad_answer', // not the JSON expected
  TOO_LARGE: 'too_large', // answer above the size cap
  CLOSED: 'closed', // the client was replaced (new configuration)
  NO_TIME: 'no_time', // a command had no time left: not sent
  LIMITED: 'limited', // the integration's own request budget is spent: not sent
});

export class UptimeRobotError extends Error {
  constructor(code, message, { status, retryAfterMs, method, apiType, apiParameter } = {}) {
    super(message);
    this.name = 'UptimeRobotError';
    this.code = code;
    if (status !== undefined) this.status = status;
    if (retryAfterMs !== undefined && retryAfterMs !== null) this.retryAfterMs = retryAfterMs;
    if (method !== undefined) this.method = method;
    if (apiType !== undefined) this.apiType = apiType;
    if (apiParameter !== undefined) this.apiParameter = apiParameter;
  }
}

/**
 * The API key refused, on getMonitors (the one method every key may call):
 * `stat: fail` with `not_authorized`, or `invalid_parameter` on `api_key`;
 * HTTP 401 too. A 403 (often a page of a proxy or CDN in front of the API)
 * is a passing failure. Final: never retried without a user action
 * (configuration saved, "Test the connection").
 */
export const isKeyRefused = (err) =>
  err?.method === 'getMonitors' &&
  ((err.code === CODES.API &&
    (err.apiType === 'not_authorized' ||
      (err.apiType === 'invalid_parameter' && err.apiParameter === 'api_key'))) ||
    (err.code === CODES.HTTP && err.status === 401));

/** Too many requests: a pause kept across restarts. */
export const isBusy = (err) => err?.code === CODES.HTTP && err.status === 429;
export const isServerError = (err) => err?.code === CODES.HTTP && err.status >= 500;
