// -----------------------------------------------------------------------------
// The only network access of the integration: one POST on node:https. A
// deadline for the whole exchange, a size cap on the body, no redirect
// followed, the certificate always checked. Resolves { status, headers, body }
// for any status; rejects an UptimeRobotError for the transport failures,
// with `notSent` when nothing left for sure.
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';
import { CODES, UptimeRobotError } from './errors.js';

function transportError(err) {
  // Only the system code (ECONNRESET...): never a message that could quote the body.
  const code = String(err?.code ?? '').slice(0, 40);
  return new UptimeRobotError(CODES.UNREACHABLE, code || 'Connection failed');
}

/**
 * @param {string} url absolute https URL (http only for loopback tests)
 * @param {object} options
 * @param {string} options.body form-encoded body (holds the API key: never logged)
 * @param {number} options.timeout ms for the whole exchange
 * @param {number} options.maxBytes body size cap
 * @param {() => void} [options.onSent] called once the connection is up (the request may leave)
 */
export function httpRequest(url, { body, timeout, maxBytes, onSent } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    let settled = false;
    let req = null;
    // Until the connection (TLS included) is up, nothing of the request has
    // left: a failure then is "not sent" for sure (see the commands).
    let connected = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        if (!connected) error.notSent = true;
        req?.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(
      () =>
        finish(
          new UptimeRobotError(CODES.TIMEOUT, `No answer within ${Math.round(timeout / 1000)} s`),
        ),
      timeout,
    );

    const markSent = () => {
      if (connected || settled) return;
      connected = true;
      onSent?.();
    };

    try {
      const payload = Buffer.from(body ?? '', 'utf8');
      req = lib.request(
        {
          method: 'POST',
          hostname: target.hostname,
          port: target.port || undefined,
          path: `${target.pathname}${target.search}`,
          headers: {
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
            'cache-control': 'no-cache',
            'content-length': payload.length,
          },
          // The certificate of api.uptimerobot.com is always checked.
          rejectUnauthorized: true,
          agent: false,
        },
        (res) => {
          markSent();
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
              finish(new UptimeRobotError(CODES.TOO_LARGE, `Answer above ${maxBytes} bytes`));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () =>
            finish(null, {
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          );
          res.on('error', (err) => finish(transportError(err)));
        },
      );
      req.on('socket', (socket) => {
        if (!socket.connecting) {
          markSent();
          return;
        }
        socket.once(lib === https ? 'secureConnect' : 'connect', markSent);
      });
      req.on('error', (err) => finish(transportError(err)));
      req.write(payload);
      req.end();
    } catch (err) {
      finish(transportError(err));
    }
  });
}
