# gladys-uptimerobot

[Gladys Assistant](https://gladysassistant.com) external integration for
**UptimeRobot**: each monitor becomes a Gladys device with its online state,
status, latest response time (ms) and uptime of the last 24 hours, 7 and 30
days; two scene triggers, "Monitor down" and "Monitor back up"; optional Pause
and Resume buttons, off by default. A read-only API key is recommended.
**Unofficial integration, not affiliated with UptimeRobot. Never tested with a
real UptimeRobot account yet.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/app.js (UptimeRobotApp)
                 ├─ src/uptimerobot/client.js  official API v2 (api.uptimerobot.com, key in the body)
                 ├─ src/uptimerobot/http.js    the only network access (node:https, POST)
                 ├─ src/uptimerobot/parse.js   answers checked field by field, capped
                 ├─ src/uptimerobot/errors.js  error codes, key refusal
                 ├─ src/budget.js              requests per minute, states per minute
                 ├─ src/store.js               /data: refusal, pause (never the key)
                 └─ src/devices.js             one device per monitor (pure)
```

- **Authentication**: the API key in the form body of each POST (never in a
  URL), only to `https://api.uptimerobot.com` (fixed in the code). A
  `stat: fail` with `not_authorized` or `invalid_parameter` on `api_key`, or
  HTTP 401, on `getMonitors` is final: a salted HMAC of the key is kept in
  `/data`, nothing is sent again until the configuration is saved or "Test the
  connection" is pressed. Only the error `type` is kept from an API error: its
  `passed_value` echoes the key.
- **Reading** (every 5 min by default): `getMonitors` with
  `custom_uptime_ratios=1-7-30` and the latest response time, 50 monitors per
  request, 200 at most. Every request (readings and buttons) counts in one
  budget of 8 per minute (free plan: 10). HTTP 429 and 5xx pause every path
  (kept in `/data`, capped when read back); a failure is never read again
  faster than the interval.
- **Scene triggers**: fired on a confirmed transition (`up` ⇄ `down`) between
  two readings at most two intervals (plus a minute) apart; never on the first
  reading, for a new monitor, after a long gap, on "seems down", nor after a
  pause or resume.
- **Pause and resume**: two push buttons (never a switch), refused unless
  `allow_pause_resume` is on (checked on arrival and before sending); nothing
  is sent past 3.5 s; a command that may have left is never said "not sent".
  Buttons, once created, are never dropped from a device.

## Development

```bash
npm install
npm test                                        # node --test, no network (loopback only)
npm run lint && npm run format:check
npm run audit                                   # production dependencies
npm run cover                                   # regenerate cover.png
npx github:GladysAssistant/integration-store .  # store admission checks
```

The tests run against the SDK's fake Gladys and a fake UptimeRobot
(`test/helpers/fakeUptimeRobot.js`), plus loopback HTTP servers for the
transport. No test touches the real API or the Internet.

## Credits

- The official [UptimeRobot API documentation](https://uptimerobot.com/api/)
  (v2, "legacy"): methods, parameters, statuses, types, rate limits.
- [ludeeus/pyuptimerobot](https://github.com/ludeeus/pyuptimerobot) (MIT), the
  library of the Home Assistant integration: consulted for the key handling
  and the pause / start operations (see
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
- [gladys-nextdns](https://github.com/LM1LC3N7/gladys-nextdns) and
  [gladys-portainer](https://github.com/LM1LC3N7/gladys-portainer): the
  structure of the app, the retry policy and the scene triggers.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0.
