'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');

const { createServer } = require('../server');

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return 'http://127.0.0.1:' + port;
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeIdleConnections?.();
  });
}

async function rawStatus(baseUrl, requestPath) {
  const origin = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: origin.hostname,
      port: origin.port,
      method: 'GET',
      path: requestPath
    }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end();
  });
}

async function main() {
  const observed = [];
  const svgHandler = async (req, res) => {
    observed.push({ method: req.method, path: req.path, query: req.query });
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.status(200).send('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  };
  const server = createServer({
    svgHandler,
    appCommit: '0123456789abcdef',
    readinessCheck: () => ({ data_generated_at: '2026-07-17T00:15:00+08:00' })
  });
  assert.equal(server.headersTimeout, 10_000);
  assert.equal(server.requestTimeout, 15_000);
  assert.equal(server.keepAliveTimeout, 5_000);
  assert.equal(server.maxHeadersCount, 50);
  assert.equal(server.maxRequestsPerSocket, 100);
  const baseUrl = await listen(server);

  try {
    const index = await fetch(baseUrl + '/');
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /^text\/html/);
    assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(index.headers.get('referrer-policy'), 'no-referrer');
    assert.match(index.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(await index.text(), /AI Coding Blue Wall/);

    const indexHead = await fetch(baseUrl + '/index.html', { method: 'HEAD' });
    assert.equal(indexHead.status, 200);
    assert.ok(Number(indexHead.headers.get('content-length')) > 0);
    assert.equal(await indexHead.text(), '');

    const indexPost = await fetch(baseUrl + '/', { method: 'POST' });
    assert.equal(indexPost.status, 405);
    assert.equal(indexPost.headers.get('allow'), 'GET, HEAD');

    const health = await fetch(baseUrl + '/healthz');
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('cache-control'), 'no-store');
    const healthBody = await health.json();
    assert.equal(healthBody.status, 'ok');
    assert.equal(healthBody.service, 'codex-usage-bluewall');
    assert.equal(healthBody.commit, '0123456789abcdef');
    assert.ok(!Number.isNaN(Date.parse(healthBody.generated_at)));

    const ready = await fetch(baseUrl + '/readyz');
    assert.equal(ready.status, 200);
    const readyBody = await ready.json();
    assert.equal(readyBody.status, 'ready');
    assert.equal(readyBody.data_generated_at, '2026-07-17T00:15:00+08:00');

    const readyHead = await fetch(baseUrl + '/readyz', { method: 'HEAD' });
    assert.equal(readyHead.status, 200);
    assert.ok(Number(readyHead.headers.get('content-length')) > 0);
    assert.equal(await readyHead.text(), '');

    const svg = await fetch(baseUrl + '/api/svg?days=7');
    assert.equal(svg.status, 200);
    assert.match(svg.headers.get('content-type'), /^image\/svg\+xml/);
    assert.equal(svg.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.match(await svg.text(), /^<svg/);
    assert.deepEqual(observed.at(-1), {
      method: 'GET',
      path: '/api/svg',
      query: { days: '7' }
    });

    const svgHead = await fetch(baseUrl + '/api/svg?days=30', { method: 'HEAD' });
    assert.equal(svgHead.status, 200);
    assert.ok(Number(svgHead.headers.get('content-length')) > 0);
    assert.equal(await svgHead.text(), '');
    assert.deepEqual(observed.at(-1), {
      method: 'HEAD',
      path: '/api/svg',
      query: { days: '30' }
    });

    const missing = await fetch(baseUrl + '/missing');
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('cache-control'), 'no-store');
    assert.equal((await missing.json()).error, 'Not found');

    const tooLong = await fetch(baseUrl + '/' + 'a'.repeat(4_096));
    assert.equal(tooLong.status, 414);

    assert.equal(await rawStatus(baseUrl, '//attacker.example/api/svg?days=7'), 400);
    assert.equal(await rawStatus(baseUrl, '/ignored/../api/svg?days=7'), 400);
    assert.equal(await rawStatus(baseUrl, '/ignored\\..\\api\\svg?days=7'), 400);
  } finally {
    await close(server);
  }

  // These requests fail before the production handler performs an upstream
  // fetch, proving that the native URL adapter preserves Vercel query/method
  // semantics without making the test suite network-dependent.
  const productionServer = createServer();
  const productionBaseUrl = await listen(productionServer);
  try {
    const productionReady = await fetch(productionBaseUrl + '/readyz');
    assert.equal(productionReady.status, 200);
    assert.equal((await productionReady.json()).status, 'ready');

    const duplicateDays = await fetch(productionBaseUrl + '/api/svg?days=7&days=30');
    assert.equal(duplicateDays.status, 400);
    assert.equal((await duplicateDays.json()).error, 'days must be an integer from 7 to 365');

    const unknownQuery = await fetch(productionBaseUrl + '/api/svg?unexpected=1');
    assert.equal(unknownQuery.status, 400);
    assert.equal((await unknownQuery.json()).error, 'Unsupported query parameter');

    const prototypeQuery = await fetch(productionBaseUrl + '/api/svg?__proto__=x');
    assert.equal(prototypeQuery.status, 400);
    assert.equal((await prototypeQuery.json()).error, 'Unsupported query parameter');

    const wrongMethod = await fetch(productionBaseUrl + '/api/svg', { method: 'POST' });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'GET, HEAD');
  } finally {
    await close(productionServer);
  }

  const failingReadyServer = createServer({
    readinessCheck: () => {
      throw new Error('test readiness failure');
    }
  });
  const failingReadyBaseUrl = await listen(failingReadyServer);
  const originalError = console.error;
  console.error = () => {};
  try {
    const notReady = await fetch(failingReadyBaseUrl + '/readyz');
    assert.equal(notReady.status, 503);
    assert.equal((await notReady.json()).status, 'not_ready');
  } finally {
    console.error = originalError;
    await close(failingReadyServer);
  }

  console.log('Standalone server tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
