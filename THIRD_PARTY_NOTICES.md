# Third-party notices

This integration is written from the official documentation of the
UptimeRobot API. The project below was consulted for how a Home Assistant
integration reads UptimeRobot (the key handling, the monitor states, the pause
and start operations). Nothing of it is installed at runtime, and no line of
it is copied: it is Python, this integration is JavaScript
(`src/uptimerobot/`).

## ludeeus/pyuptimerobot

<https://github.com/ludeeus/pyuptimerobot>, licensed under the MIT License:

```
MIT License

Copyright (c) 2021 Joakim Sørensen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## The UptimeRobot API documentation

<https://uptimerobot.com/api/> and the v2 reference
(<https://uptimerobot.com/api/legacy/>): `getMonitors` and `editMonitor`,
their parameters, the monitor statuses and types, the key types and the rate
limits. Only the documented behaviour is reproduced.

## LM1LC3N7/gladys-nextdns and gladys-portainer

The structure of the app, the handler wiring, the retry and pause policy and
the scene triggers follow integrations of the same author, under the Apache
License 2.0 of this repository.
