# TODO — UptimeRobot v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm audit --omit=dev`,
  `npx github:GladysAssistant/integration-store .`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No forum topic of its own: the claim is in /t/10385 (post #275, lot 8).

## Status

- [x] **Milestone 1 — core** (2026-10-19): official UptimeRobot API v2 client
      (`getMonitors`, `editMonitor`; key in the POST body, only to
      api.uptimerobot.com); one device per monitor (online, status, response
      time, uptime 24 h / 7 d / 30 d, type and host as params); scene
      triggers down / back up; Pause / Resume buttons off by default; request
      budget 8/min; key refusal final and remembered (HMAC); 429 / 5xx pauses
      persisted and capped; button "Test the connection"; docs en/fr; cover.
      Tested with unit tests against the SDK's fake Gladys, a fake UptimeRobot
      in memory and loopback HTTP servers. **Never tested with a real
      UptimeRobot account.** No Docker on this PC: no e2e test in a container.
- [x] **Review corrections** (2026-10-19), one non-regression test each in
      `test/review.test.js` (virtual time, the reviewer's scenarios S1-S9):
      one timer for the reading chain, set before any await (B1); the ack of
      a command never waits for Gladys, a 429 pauses synchronously (I1); a
      5xx on `editMonitor` pauses like a reading, persisted, "not confirmed"
      (I2); a reconnection keeps the planned reading time (I3); the budget
      spent between two pages waits a minute, still online (M1); a status and
      a button message of their own when the budget is spent (M2); a 429 on
      a command says "not done" with the pause (M3); invalid entries of
      "Monitors" are counted, never quoted (M4); `nextReadAt` persisted,
      bounded, kept at a restart unless forced (M5); the reason of a pause
      persisted (M6); docs quote the real texts (M7); a reading begun before
      a command keeps the command's state (M8); 404 / 410 on v2 give "API v2
      may have been retired, update the integration" (M9).
- [x] **Approval corrections** (2026-10-19): `nextReadAt` is persisted only
      after a failure, a pause or a spent budget, and cleared by a successful
      reading: a restart after a success reads at once (connected, Discovery),
      at least a minute after the last request (`meta.lastRequestAt`) against
      a crash loop (R1); a reconnection lets a reading in flight finish and
      plan the next one (R2). Tests in `test/review.test.js`.
- [ ] **Milestone 2 — real account** (a tester with UptimeRobot): record real
      answers as fixtures (key removed), fix what differs. To check first:
  - the answer to a wrong key (`stat: fail`, which `error.type`? HTTP 200 or
    401?) and to `editMonitor` with a read-only key (`not_authorized`?);
  - the order of `response_times` and whether `response_times_limit=1`
    gives the latest one; `custom_uptime_ratio` format (`a-b-c`) for a new
    or paused monitor;
  - the 429 headers (`Retry-After`, `X-RateLimit-Reset`), and whether a
    proxy in front of the API ever answers 403 / 5xx in HTML;
  - the exact label of the read-only key in the dashboard ("Read-only API
    key", Integrations & API, API), quoted in the docs;
  - the Pause / Resume buttons in the dashboard, and the scene triggers with a
    monitor selected.
- [ ] **Milestone 3 — API v3**: move to `https://api.uptimerobot.com/v3`
      (Bearer key, `GET /monitors`, `POST /monitors/{id}/pause` and
      `/start`) once its reference shows how to read the 24 h / 7 d / 30 d
      uptimes and the response time in one request (see "Decisions"). Keep
      the external ids (`monitor:<id>`: the same numeric ids?).
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, GHCR package public (the main session publishes),
      then the store validator once the image is published.

## Decisions

- **Duplicate check**: done by the main session before the batch (post #275
  of /t/10385); not repeated by the development agent.
- **API v2, not v3**: v3 (2025, REST, Bearer token) is presented as the
  current API and v2 as "legacy" (still available, no more updates, no end
  date announced). The v3 reference could not be read in full here
  (rendered by script): its monitor fields for the uptime ratios and the
  response times are unknown, and reading them per monitor would cost one
  request each against 10 per minute. v2 `getMonitors` gives, for 50
  monitors in one request, the status, the 1-7-30 days ratios and the latest
  response time, all documented. Migration noted as milestone 3.
- **Reuse**: ludeeus/pyuptimerobot (MIT, used by Home Assistant) checked:
  license MIT (Copyright (c) 2021 Joakim Sørensen); its current version talks
  to v3 (Bearer, `/monitors`, `/pause`, `/start`), reads only the status, and
  is Python: consulted, nothing ported; credited in `THIRD_PARTY_NOTICES.md`
  (full MIT notice, copied into the image). No runtime dependency besides the
  SDK.
- **Version**: 0.1.0 set by hand in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag; the first patch release gives 0.1.1.
- **External ids**: `monitor:<UptimeRobot monitor id>` (digits, stable; the
  name may change). Features `online`, `status`, `response_time`,
  `uptime_24h`, `uptime_7d`, `uptime_30d`, `pause`, `resume`.
- **Feature types and units** (only the core's,
  `DEVICE_FEATURE_UNITS_BY_CATEGORY`): online `unknown`/`binary` read only
  (1 up, 0 down: published only for statuses 2 and 9); status `text`/`text`;
  response time `duration`/`integer` in `milliseconds`; uptimes
  `unknown`/`unknown` without unit (no core category lists a percent for an
  availability, named "(%)"); buttons `button`/`push`.
- **No switch** (lesson of lot 6): "Online" is a reading; pause and resume
  are push buttons, never a switch nor a binary command.
- **No feature lost** (lesson of lot 6): a republished device starts from the
  features of the created device (`gladys.devices`): the buttons stay once
  created even if the option is turned off (refused then), and a feature
  this version does not know is copied as it is.
- **Target shown**: params `MONITOR_ID`, `MONITOR_TYPE`, `MONITOR_TARGET`;
  the target is the scheme and host of an HTTP(s) / keyword URL (never the
  path, query or userinfo, where a token may hide), the host of a ping,
  host:port of a port monitor, nothing for a heartbeat (its URL is the
  secret push URL). The name is the friendly name, cleaned and capped.
- **Scene triggers**: the reference is the last confirmed state per monitor
  (`up` for 2, `down` for 9; 8 "seems down" keeps the previous reference;
  0 paused / 1 not checked / unknown clear it). An event fires on a change of
  reference only when the previous reading succeeded at most
  `2 × interval + 1 min` before; the first reading, a new monitor, a long gap
  (outage, pause 429, restart: references live in memory) fire nothing. A
  pause or resume by Gladys clears the reference. 50 events per round at
  most. Data: `monitor` (device external id, the trigger field),
  `monitor_name`, `monitor_type`.
- **Rate limits**: free plan 10 requests/min (documentation, v2 and v3
  pages; Pro: 2 × monitor limit, max 5000). One budget of 8 requests per
  sliding minute for every path and every client (kept across a new
  configuration); a reading waits a minute when there is not room for all
  its pages; a command beyond is refused, not sent. Default interval 5 min
  (the free plan's check interval); 1 and 2 min offered for paid plans.
  200 monitors at most (4 pages).
- **Key refusal**: on `getMonitors` only, `stat: fail` with `not_authorized`
  or `invalid_parameter` on `api_key`, or HTTP 401 (a 403, possibly a proxy
  page, is passing: lesson of wave 1). HMAC-SHA-256 of the key, keyed with a
  random salt in `/data` (never the key); a restart or a reconnection does
  not send it again; saving the configuration or "Test the connection" tries
  once. `editMonitor` refused with a read-only key is a command error ("use
  the main key"), never a key refusal.
- **Secrets**: the API key is a `secret` field (kept in clear in the Gladys
  database, masked in the UI: never "encrypted"); sent in the form body to
  the fixed origin, never in a URL (v2 also accepts it as a query parameter:
  not used), a log, a status, an error or `/data`. From an API error only
  `type` and `parameter_name` are kept, checked against `[a-z_]`:
  `passed_value` and `message` may quote the key (tested).
- **Hostile answers**: 512 KB per answer at most, no redirect, certificate
  checked, 10 s; JSON fields read one by one with `Object.hasOwn` into fresh
  objects (no spread of the answer: no prototype pollution, tested); ids,
  statuses, types, ratios, response times and names checked and capped.
- **Retries and pauses**: a failure is never read again faster than the
  reading interval; transient failures double up to 1 h. HTTP 429 on any
  path (reading or command) pauses every path for Retry-After (else
  `X-RateLimit-Reset`) bounded 1 min to 6 h, and at least the interval; 5xx
  pauses too. Both are kept in `/data`, capped at 6 h when read back; only
  the user lifts them.
- **Reconnection to Gladys** (`connected`): same configuration, nothing is
  read again: the client, the pause, the refusal and the trigger references
  stay; the caches that mirror Gladys (status, Discovery key, badges,
  published values) are emptied, and the status, the Discovery and the
  states are sent again.
- **Commands**: allowed only with `allow_pause_resume` (off), checked on
  arrival and before sending; a new configuration narrows it at once
  (generation bump). Value must be exactly `1`. Chained per monitor. Nothing
  sent after 3.5 s; the whole exchange ends by 4.3 s after the command
  arrived; a failure once connected is "sent but not confirmed", never "not
  sent". Not a physical risk: no fresh read before acting (it would cost a
  request of the 10 per minute); pause and resume are idempotent. After
  success the status shows `paused` / `not_checked` until the next reading.
- **Scheduling** (review B1, I3, M5): the reading chain has one timer,
  `loopHandle`, replaced by `plan()`; `failed()` halts and plans before its
  first await; a run whose epoch moved only records its pause. `nextRunAt`
  survives a reconnection (`resume()` plans `max(0, nextRunAt - now)`) and is
  persisted as `meta.nextReadAt` only after a failure, a pause or a spent
  budget (cleared by a successful reading), capped at one interval when read
  back; a non-forced start waits for it, and in any case until a minute after
  `meta.lastRequestAt` (status "Restarted: ... Reading in N min"). A
  reconnection during a reading of the same generation leaves it alone.
- **Pause reason** (M6): `meta.pauseReason` = `busy` or `server:<status>`,
  so a restart during a pause shows the right status.
- **Rate of states**: change-only (own cache + `publishChangedStates`), a
  sliding window under 250/min; what does not fit is sent again a minute
  later (no extra request). Badges `cloud` / `unreachable`.
- `gladys_version >=5.1.0` (scene triggers), transports `["cloud"]`,
  categories `network`, `services`. Single container.
