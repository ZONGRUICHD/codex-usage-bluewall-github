'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const defaultSvgHandler = require('./api/svg');
const bundledUsage = require('./data/ai-usage.json');
const bundledCloudActivity = require('./data/codex-cloud-activity.json');

const SERVICE_NAME = 'codex-usage-bluewall';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const MAX_URL_LENGTH = 4_096;
const INDEX_PATH = path.join(__dirname, 'public', 'index.html');
const INDEX_CSP = "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const LOCKED_DOWN_CSP = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'";

function queryFrom(searchParams) {
  const query = {};
  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key);
    Object.defineProperty(query, key, {
      configurable: true,
      enumerable: true,
      value: values.length === 1 ? values[0] : values,
      writable: true
    });
  }
  return query;
}

function applyCommonHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
}

function sendPayload(req, res, statusCode, payload, contentType, headers = {}) {
  if (res.writableEnded) return;
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  res.statusCode = statusCode;
  if (contentType) res.setHeader('Content-Type', contentType);
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.setHeader('Content-Length', body.byteLength);
  res.end(req.method === 'HEAD' ? undefined : body);
}

function sendJson(req, res, statusCode, value, headers = {}) {
  sendPayload(
    req,
    res,
    statusCode,
    JSON.stringify(value) + '\n',
    'application/json; charset=utf-8',
    headers
  );
}

function sendMethodNotAllowed(req, res) {
  sendJson(req, res, 405, { error: 'Method not allowed' }, {
    Allow: 'GET, HEAD',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': LOCKED_DOWN_CSP
  });
}

function expressCompatibleResponse(req, res) {
  const facade = {
    setHeader(name, value) {
      res.setHeader(name, value);
      return facade;
    },
    getHeader(name) {
      return res.getHeader(name);
    },
    removeHeader(name) {
      res.removeHeader(name);
      return facade;
    },
    status(statusCode) {
      res.statusCode = statusCode;
      return facade;
    },
    json(value) {
      if (!res.hasHeader('Content-Type')) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
      const body = Buffer.from(JSON.stringify(value) + '\n');
      res.setHeader('Content-Length', body.byteLength);
      res.end(req.method === 'HEAD' ? undefined : body);
      return facade;
    },
    send(value) {
      if (value != null && typeof value === 'object' && !Buffer.isBuffer(value)) {
        return facade.json(value);
      }
      const body = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ''));
      res.setHeader('Content-Length', body.byteLength);
      res.end(req.method === 'HEAD' ? undefined : body);
      return facade;
    },
    end(value) {
      if (value == null) {
        res.end();
        return facade;
      }
      const body = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
      res.setHeader('Content-Length', body.byteLength);
      res.end(req.method === 'HEAD' ? undefined : body);
      return facade;
    }
  };
  return facade;
}

function verifyBundledReadiness() {
  const svg = defaultSvgHandler.generateSVG(
    bundledUsage,
    7,
    bundledCloudActivity.daily_usage_percent || {},
    {
      timeZone: process.env.TIME_ZONE,
      staleAfterDays: process.env.STALE_AFTER_DAYS,
      cloudData: bundledCloudActivity
    }
  );
  if (!/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/.test(svg)) {
    throw new Error('bundled renderer did not produce an SVG document');
  }
  return {
    data_generated_at: bundledUsage.generated_at || null,
    cloud_data_generated_at: bundledCloudActivity.generated_at || null
  };
}

function createServer(options = {}) {
  const svgHandler = options.svgHandler || defaultSvgHandler;
  const readinessCheck = options.readinessCheck || verifyBundledReadiness;
  const indexHtml = options.indexHtml == null
    ? fs.readFileSync(INDEX_PATH)
    : Buffer.from(options.indexHtml);
  const appCommit = String(options.appCommit || process.env.APP_COMMIT || 'unknown').slice(0, 64);

  const server = http.createServer(async (req, res) => {
    // No endpoint accepts a request body. Draining it keeps rejected requests
    // from poisoning a keep-alive connection without buffering it in memory.
    req.resume();
    applyCommonHeaders(res);

    const rawUrl = req.url || '/';
    const rawPath = rawUrl.split('?', 1)[0];
    if (
      !rawUrl.startsWith('/') ||
      rawUrl.startsWith('//') ||
      rawUrl.includes('\\') ||
      rawUrl.includes('#') ||
      rawUrl.length > MAX_URL_LENGTH
    ) {
      sendJson(req, res, rawUrl.length > MAX_URL_LENGTH ? 414 : 400, {
        error: rawUrl.length > MAX_URL_LENGTH ? 'URI too long' : 'Invalid request target'
      }, {
        'Cache-Control': 'no-store',
        'Content-Security-Policy': LOCKED_DOWN_CSP
      });
      return;
    }

    let url;
    try {
      url = new URL(rawUrl, 'http://localhost');
    } catch {
      sendJson(req, res, 400, { error: 'Invalid request target' }, {
        'Cache-Control': 'no-store',
        'Content-Security-Policy': LOCKED_DOWN_CSP
      });
      return;
    }
    if (url.origin !== 'http://localhost' || url.pathname !== rawPath) {
      sendJson(req, res, 400, { error: 'Invalid request target' }, {
        'Cache-Control': 'no-store',
        'Content-Security-Policy': LOCKED_DOWN_CSP
      });
      return;
    }

    const method = String(req.method || 'GET').toUpperCase();
    req.query = queryFrom(url.searchParams);
    req.path = url.pathname;

    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (method !== 'GET' && method !== 'HEAD') {
        sendMethodNotAllowed(req, res);
        return;
      }
      sendPayload(req, res, 200, indexHtml, 'text/html; charset=utf-8', {
        'Cache-Control': 'public, max-age=300',
        'Content-Security-Policy': INDEX_CSP
      });
      return;
    }

    if (url.pathname === '/healthz') {
      if (method !== 'GET' && method !== 'HEAD') {
        sendMethodNotAllowed(req, res);
        return;
      }
      sendJson(req, res, 200, {
        status: 'ok',
        service: SERVICE_NAME,
        commit: appCommit,
        generated_at: new Date().toISOString()
      }, {
        'Cache-Control': 'no-store',
        'Content-Security-Policy': LOCKED_DOWN_CSP
      });
      return;
    }

    if (url.pathname === '/readyz') {
      if (method !== 'GET' && method !== 'HEAD') {
        sendMethodNotAllowed(req, res);
        return;
      }
      try {
        const details = await readinessCheck();
        sendJson(req, res, 200, {
          status: 'ready',
          service: SERVICE_NAME,
          commit: appCommit,
          generated_at: new Date().toISOString(),
          ...details
        }, {
          'Cache-Control': 'no-store',
          'Content-Security-Policy': LOCKED_DOWN_CSP
        });
      } catch (error) {
        console.error('Readiness check failed:', error);
        sendJson(req, res, 503, {
          status: 'not_ready',
          service: SERVICE_NAME,
          commit: appCommit
        }, {
          'Cache-Control': 'no-store',
          'Content-Security-Policy': LOCKED_DOWN_CSP
        });
      }
      return;
    }

    if (url.pathname === '/api/svg') {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      try {
        await svgHandler(req, expressCompatibleResponse(req, res));
      } catch (error) {
        console.error('Unhandled SVG request failure:', error);
        if (!res.headersSent) {
          sendJson(req, res, 500, { error: 'Failed to generate SVG' }, {
            'Cache-Control': 'no-store',
            'Content-Security-Policy': LOCKED_DOWN_CSP
          });
        } else if (!res.writableEnded) {
          res.destroy(error);
        }
      }
      return;
    }

    sendJson(req, res, 404, { error: 'Not found' }, {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': LOCKED_DOWN_CSP
    });
  });

  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.timeout = 20_000;
  server.maxHeadersCount = 50;
  server.maxRequestsPerSocket = 100;
  server.on('clientError', (error, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    } else {
      socket.destroy(error);
    }
  });

  return server;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError('PORT must be an integer from 0 to 65535');
  }
  return port;
}

function start(options = {}) {
  const host = options.host || process.env.HOST || DEFAULT_HOST;
  const port = parsePort(options.port ?? process.env.PORT ?? DEFAULT_PORT);
  const shutdownGraceMs = Number(options.shutdownGraceMs || 10_000);
  const server = createServer(options);
  let shuttingDown = false;

  const shutdown = signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Received ' + signal + '; stopping HTTP server');
    const forceClose = setTimeout(() => {
      console.error('Graceful shutdown deadline exceeded; closing active connections');
      server.closeAllConnections?.();
      process.exitCode = 1;
    }, shutdownGraceMs);
    forceClose.unref();
    server.close(error => {
      clearTimeout(forceClose);
      if (error) {
        console.error('HTTP server shutdown failed:', error);
        process.exitCode = 1;
      }
    });
    server.closeIdleConnections?.();
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  server.listen(port, host, () => {
    const address = server.address();
    const boundPort = address && typeof address === 'object' ? address.port : port;
    console.log(SERVICE_NAME + ' listening on http://' + host + ':' + boundPort);
  });
  return server;
}

if (require.main === module) start();

module.exports = {
  createServer,
  queryFrom,
  start,
  verifyBundledReadiness
};
