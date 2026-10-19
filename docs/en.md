# UptimeRobot

Your [UptimeRobot](https://uptimerobot.com) monitors in Gladys, through the
official UptimeRobot API and an API key of your account. Each monitor becomes
a Gladys device:

- **Online**: 1 up, 0 down (confirmed by UptimeRobot); nothing while the
  monitor is paused or not checked yet;
- **Status**: `up`, `seems_down` (looks down, not confirmed yet), `down`,
  `paused` or `not_checked`;
- **Response time**: the latest response time measured, in milliseconds;
- **Uptime 24 h (%)**, **Uptime 7 days (%)** and **Uptime 30 days (%)**: the
  availability of the last 24 hours, 7 and 30 days;
- the **Pause monitoring** and **Resume monitoring** buttons, only when you
  allow them (see Pause and resume).

The type of the monitor (HTTP(s), Keyword, Ping, Port, Heartbeat) and its
target show in the parameters of the device: only the scheme and the host
(e.g. `https://example.com`), never the path, the query nor credentials of the
address, and never the secret address of a Heartbeat monitor.

> **This integration has never been tested with a real UptimeRobot account.**
> This first version was written from the official documentation of the
> UptimeRobot API, and only tested against a fake UptimeRobot. Tell on the
> Gladys forum what works and what does not.

Unofficial integration, not affiliated with UptimeRobot.

## Create a read-only key (recommended)

Gladys only needs to read: use the **read-only API key**, which can neither
change nor delete your monitors.

1. Sign in on [uptimerobot.com](https://dashboard.uptimerobot.com).
2. Open **Integrations & API**, then the **API** section.
3. On the **Read-only API key** line, click **Create** (or show the existing
   key) and copy it.
4. Paste it in the **API key** field of the integration and save.

The main API key works too, but it can change anything in the account: give
it only if you want pause and resume. A monitor-specific API key reads that
monitor only.

The key is kept by Gladys in its database, never shown again, sent only to
`api.uptimerobot.com`, in the body of the requests (never in an address, never
in a log, never in the `/data` volume).

## Configuration

- **API key**: see above.
- **Monitors** (optional): the ids of the monitors to follow (the digits at
  the end of the address of a monitor on the dashboard), separated by commas,
  50 at most. Empty: every monitor of the account, 200 at most.
- **Refresh**: every 5 minutes by default (from every minute to every hour).
  Each reading makes one request per 50 monitors. The free plan checks your
  sites every 5 minutes: reading more often only helps on a paid plan.
- **Allow pausing and resuming monitors**: off by default.

Then open the **Discovery** tab and create the monitors to follow.

## Scene triggers

- **Monitor down**: UptimeRobot confirmed a monitor down (`down`) while it was
  up at the previous reading.
- **Monitor back up**: a monitor confirmed down at the previous reading is up
  again.

Both can target one monitor (empty: any) and give the scene the name and the
type of the monitor. They never fire:

- on the first reading (start, restart, new configuration) nor for a monitor
  that just appeared;
- after a long gap: when the previous reading is more than two intervals old
  (plus a minute), the change only becomes the new reference;
- on "seems down" (`seems_down`): UptimeRobot has not confirmed it yet;
- after a pause or a resume.

The scene starts up to one refresh interval after the change.

## Pause and resume

By default Gladys only reads. Once **Allow pausing and resuming monitors** is
ticked, each monitor gets two buttons, **Pause monitoring** and **Resume
monitoring** (press **Update** in Discovery to add them to a device already
created). They are never switches: no voice assistant nor "turn everything
off" can pause your monitors.

- It needs the **main API key**: UptimeRobot refuses a pause with a read-only
  key, and Gladys says so.
- A paused monitor no longer alerts you.
- Unticking the option takes effect at once; the buttons stay on the devices
  (never breaking the history) but are refused.
- When the command cannot leave within 3.5 s, nothing is sent. A command sent
  without an answer in time shows "sent, not confirmed" (never "not sent"):
  the next reading shows the result.

## Usage limits and connection problems

- The free plan of UptimeRobot admits **10 requests per minute** (API
  documentation). Gladys sends **8 at most** per minute, every request counted
  (readings and buttons): beyond, a button is refused without sending
  anything, and the reading waits a minute.
- **Key refused**: Gladys does not try again by itself, even after a restart.
  Paste the key and save, or press **Test the connection**.
- **UptimeRobot overloaded** (HTTP 429) or **server error** (HTTP 5xx): every
  request stops, for the chosen interval at least (429: from 1 minute to 6
  hours, what UptimeRobot asks for), even after a restart; saving the
  configuration or pressing **Test the connection** lifts the pause.
- **UptimeRobot unreachable**: retried at the chosen interval, then less and
  less often up to one hour. The devices show unreachable meanwhile.

## Limits

- One UptimeRobot account per integration, 200 monitors at most (the monitors
  already created come first; the connection status says how many are left
  out).
- Gladys admits 300 states per minute: with many monitors, the first
  publication can take a few minutes.
- The uptimes in % have no unit in Gladys (the core has no "availability"
  category): 99.95 means 99.95 %.
- The response time is published only when less than 2 hours old.
- Status pages, maintenance windows and alert contacts are not followed.
