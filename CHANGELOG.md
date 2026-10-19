# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- UptimeRobot monitors through the official API (v2): one Gladys device per
  monitor with its online state, status, latest response time (ms) and uptime
  of the last 24 hours, 7 and 30 days; type and host in the device
  parameters (never the full URL).
- Scene triggers "Monitor down" and "Monitor back up", never on the first
  reading nor after a long gap.
- Optional Pause and Resume buttons, off by default (main API key needed).
- A request budget of 8 per minute (free plan: 10); HTTP 429 and 5xx pauses
  kept across restarts; a refused key is never retried alone.
- Button "Test the connection"; documentation in English and French.

[Unreleased]: https://github.com/LM1LC3N7/gladys-uptimerobot/commits/main
