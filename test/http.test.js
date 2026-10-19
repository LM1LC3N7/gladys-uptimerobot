// -----------------------------------------------------------------------------
// The transport (src/uptimerobot/http.js) against loopback HTTP servers: the
// key in the body only, no redirect followed, size cap, deadline, "not sent"
// only when nothing left.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { httpRequest } from '../src/uptimerobot/http.js';
import { CODES } from '../src/uptimerobot/errors.js';

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const OPTIONS = { timeout: 2_000, maxBytes: 1024 };

test('a POST: form body, any status resolves', async () => {
  let seen;
  const server = await serve((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen = { method: req.method, url: req.url, type: req.headers['content-type'], body };
      res.writeHead(429, { 'retry-after': '60' });
      res.end('{}');
    });
  });
  let sent = false;
  const response = await httpRequest(`${server.url}/v2/getMonitors`, {
    ...OPTIONS,
    body: 'api_key=k&format=json',
    onSent: () => {
      sent = true;
    },
  });
  await server.close();
  assert.equal(response.status, 429);
  assert.equal(response.headers['retry-after'], '60');
  assert.deepEqual(seen, {
    method: 'POST',
    url: '/v2/getMonitors',
    type: 'application/x-www-form-urlencoded',
    body: 'api_key=k&format=json',
  });
  assert.ok(sent);
});

test('a redirect is not followed', async () => {
  let hits = 0;
  const server = await serve((req, res) => {
    hits += 1;
    res.writeHead(302, { location: 'http://example.org/steal' });
    res.end();
  });
  const response = await httpRequest(`${server.url}/v2/getMonitors`, OPTIONS);
  await server.close();
  assert.equal(response.status, 302);
  assert.equal(hits, 1);
});

test('an answer above the cap is refused', async () => {
  const server = await serve((req, res) => {
    res.end('x'.repeat(5000));
  });
  await assert.rejects(httpRequest(`${server.url}/`, OPTIONS), { code: CODES.TOO_LARGE });
  await server.close();
});

test('no answer in time: a timeout, sent (the connection was up)', async () => {
  const server = await serve(() => {});
  const err = await httpRequest(`${server.url}/`, { ...OPTIONS, timeout: 200 }).catch((e) => e);
  assert.equal(err.code, CODES.TIMEOUT);
  assert.notEqual(err.notSent, true, 'it may have left');
  await server.close();
});

test('no connection: unreachable, not sent', async () => {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const err = await httpRequest(`http://127.0.0.1:${port}/`, OPTIONS).catch((e) => e);
  assert.equal(err.code, CODES.UNREACHABLE);
  assert.equal(err.notSent, true);
});
