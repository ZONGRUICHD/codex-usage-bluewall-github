const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bundledUsage = require('../data/ai-usage.json');
const bundledCloudActivity = require('../data/codex-cloud-activity.json');
const handler = require('../api/svg');
const {
  calculateActivityStatistics,
  calculateFreshness,
  dateKeyInTimeZone,
  generateSVG,
  loadUsageData,
  normalizeTimeZone,
  parseDataCacheTtlMs,
  parseStaleAfterDays,
  resetUsageDataCache,
  repositoryCoordinates
} = handler;

async function withoutWarnings(callback) {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    return await callback();
  } finally {
    console.warn = originalWarn;
  }
}

function assertLayoutWithinBounds(svg, days) {
  const root = svg.match(/<svg width="(\d+)" height="(\d+)" viewBox="0 0 (\d+) (\d+)"/);
  assert.ok(root, days + '-day SVG must declare numeric canvas bounds');
  const width = Number(root[1]);
  const height = Number(root[2]);
  assert.equal(width, Number(root[3]));
  assert.equal(height, Number(root[4]));
  assert.ok(width >= 855, days + '-day SVG must preserve the full card width');

  for (const match of svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g)) {
    const [, x, y, rectWidth, rectHeight] = match.map(Number);
    assert.ok(x >= 0 && x + rectWidth <= width, days + '-day rect exceeds horizontal bounds');
    assert.ok(y >= 0 && y + rectHeight <= height, days + '-day rect exceeds vertical bounds');
  }
  for (const match of svg.matchAll(/<text x="(\d+)" y="(\d+)"/g)) {
    const x = Number(match[1]);
    const y = Number(match[2]);
    assert.ok(x >= 0 && x <= width, days + '-day text anchor exceeds horizontal bounds');
    assert.ok(y >= 0 && y <= height, days + '-day text anchor exceeds vertical bounds');
  }
}

function assertDeterministicRenderer() {
  const suffix = process.pid + '-' + Date.now();
  const dataPath = path.join(os.tmpdir(), 'bluewall-data-' + suffix + '.json');
  const outputPath = path.join(os.tmpdir(), 'bluewall-output-' + suffix + '.svg');
  const projectRoot = path.resolve(__dirname, '..');
  try {
    fs.writeFileSync(dataPath, JSON.stringify({
      generated_at: '2020-02-02T16:30:00Z',
      daily_usage: {},
      per_tool_summary: {}
    }));
    execFileSync(process.execPath, [
      'scripts/render_blue_wall.js',
      '--data', dataPath,
      '--cloud', path.join(os.tmpdir(), 'bluewall-cloud-missing-' + suffix + '.json'),
      '--output', outputPath,
      '--timezone', 'Invalid/Time_Zone'
    ], { cwd: projectRoot });
    const firstRender = fs.readFileSync(outputPath, 'utf8');
    assert.match(firstRender, /through 2020-02-03/);
    execFileSync(process.execPath, [
      'scripts/render_blue_wall.js',
      '--data', dataPath,
      '--cloud', path.join(os.tmpdir(), 'bluewall-cloud-missing-' + suffix + '.json'),
      '--output', outputPath,
      '--timezone', 'Invalid/Time_Zone',
      '--check'
    ], { cwd: projectRoot });
  } finally {
    fs.rmSync(dataPath, { force: true });
    fs.rmSync(outputPath, { force: true });
  }
}

function responseRecorder() {
  return {
    headers: {},
    statusCode: null,
    body: undefined,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    send(value) {
      this.body = value;
      return this;
    },
    end() {
      return this;
    }
  };
}

const data = {
  generated_at: '2026-07-17T00:15:00+08:00',
  daily_usage: {
    '2026-07-15': { total_tokens: 50, tools: { codex: 50 } },
    '2026-07-16': { total_tokens: 75, tools: { codex: 75 } },
    '2026-07-17': { total_tokens: 100, tools: { codex: 100 } }
  },
  per_tool_summary: {
    codex: 225
  },
  statistics: {
    total_tokens: 225,
    peak_tokens: 100
  }
};
const cloudActivity = {
  '2026-03-20': 25
};

async function main() {
  assertDeterministicRenderer();
  assert.equal(normalizeTimeZone('Invalid/Time_Zone'), 'Asia/Shanghai');
  assert.equal(normalizeTimeZone(' UTC '), 'UTC');
  assert.equal(parseStaleAfterDays('0'), 0);
  assert.equal(parseStaleAfterDays(0), 0);
  assert.equal(parseStaleAfterDays('7'), 7);
  assert.equal(parseStaleAfterDays('-1'), 2);
  assert.equal(parseStaleAfterDays('3days'), 2);
  assert.equal(parseStaleAfterDays(''), 2);
  assert.equal(parseDataCacheTtlMs('0'), 0);
  assert.equal(parseDataCacheTtlMs('300000'), 300000);
  assert.equal(parseDataCacheTtlMs('9999999'), 3600000);
  assert.equal(parseDataCacheTtlMs('-1'), 300000);

  assert.equal(
    dateKeyInTimeZone(new Date('2026-07-16T16:25:00Z'), 'Asia/Shanghai'),
    '2026-07-17'
  );
  assert.equal(
    dateKeyInTimeZone(new Date('2026-07-16T16:25:00Z'), 'UTC'),
    '2026-07-16'
  );

  const statistics = calculateActivityStatistics(data, cloudActivity, '2026-07-17');
  assert.equal(statistics.totalDaysActive, 4);
  assert.equal(statistics.currentStreak, 3);
  assert.equal(statistics.longestStreak, 3);

  const freshness = calculateFreshness(
    data,
    cloudActivity,
    '2026-07-17',
    'Asia/Shanghai',
    2,
    { generated_at: '2026-06-13T02:40:00+08:00' }
  );
  assert.equal(freshness.stale, false);
  assert.equal(freshness.syncedDate, '2026-07-17');
  assert.equal(freshness.lastActiveDate, '2026-07-17');
  assert.equal(freshness.cloudSyncedDate, '2026-06-13');

  const svg = generateSVG(data, 365, cloudActivity, {
    referenceDate: '2026-07-17',
    timeZone: 'Asia/Shanghai',
    cloudData: { generated_at: '2026-06-13T02:40:00+08:00' }
  });
  assert.match(svg, /2026-03-20: Codex cloud usage 25%/);
  assert.match(svg, /Total: <tspan fill="#e6edf3">225<\/tspan> tokens/);
  assert.match(svg, /Streak: <tspan fill="#58a6ff">3 days<\/tspan>/);
  assert.match(svg, /Local synced Jul 17 · active Jul 17 · cloud Jun 13/);
  assert.match(svg, /Token activity from \d{4}-\d{2}-\d{2} through 2026-07-17/);
  assert.match(svg, /: no activity<\/title>/);
  assert.match(svg, />Jul<\/text>/);

  const cells = [...svg.matchAll(/<rect x="(\d+)" y="(\d+)"[^>]*><title>(\d{4}-\d{2}-\d{2}):/g)];
  assert.ok(cells.length >= 365 && cells.length <= 371, 'calendar should contain a full aligned year');
  assert.equal(cells.at(-1)[3], '2026-07-17');
  assert.equal(new Set(cells.map(match => match[1] + ':' + match[2])).size, cells.length);

  for (const days of [7, 30, 90, 365]) {
    const layoutSvg = generateSVG(data, days, cloudActivity, {
      referenceDate: '2026-07-17',
      timeZone: 'Asia/Shanghai'
    });
    assertLayoutWithinBounds(layoutSvg, days);
  }

  const shortSvg = generateSVG(data, 7, cloudActivity, {
    referenceDate: '2026-07-17',
    timeZone: 'Asia/Shanghai'
  });
  assert.match(shortSvg, /Active days: <tspan fill="#e6edf3">3<\/tspan>/);
  assert.doesNotMatch(shortSvg, /2026-03-20: Codex cloud usage/);

  const staleData = {
    ...data,
    generated_at: '2026-07-08T01:16:13+08:00',
    daily_usage: {
      '2026-07-08': { total_tokens: 100, tools: { '<codex>': 100 } }
    }
  };
  const staleSvg = generateSVG(staleData, 365, {}, {
    referenceDate: '2026-07-17',
    timeZone: 'Asia/Shanghai'
  });
  assert.match(staleSvg, /Streak: <tspan fill="#58a6ff">— \(data stale\)<\/tspan>/);
  assert.match(staleSvg, /Local stale · synced Jul 8 · active Jul 8/);
  assert.match(staleSvg, /&lt;codex&gt;/);
  assert.doesNotMatch(staleSvg, /<codex>/);

  const zeroThresholdSvg = generateSVG(
    { ...data, generated_at: '2026-07-16T00:15:00+08:00' },
    7,
    {},
    {
      referenceDate: '2026-07-17',
      timeZone: 'Invalid/Time_Zone',
      staleAfterDays: 0
    }
  );
  assert.match(zeroThresholdSvg, /Local stale/);

  const gapSvg = generateSVG(
    { ...data, data_quality: { complete: false, notes: ['retired device history omitted'] } },
    30,
    {},
    { referenceDate: '2026-07-17', timeZone: 'Asia/Shanghai' }
  );
  assert.match(gapSvg, /· history gap/);
  assert.match(gapSvg, /Historical data is incomplete\.<\/desc>/);

  const originalOwner = process.env.GITHUB_USERNAME;
  const originalRepository = process.env.GITHUB_REPO;
  process.env.GITHUB_USERNAME = 'ZONGRUICHD';
  process.env.GITHUB_REPO = 'codex-usage-bluewall-github';
  assert.deepEqual(repositoryCoordinates(), {
    owner: 'ZONGRUICHD',
    repository: 'codex-usage-bluewall-github',
    branch: 'main'
  });
  if (originalOwner == null) delete process.env.GITHUB_USERNAME;
  else process.env.GITHUB_USERNAME = originalOwner;
  if (originalRepository == null) delete process.env.GITHUB_REPO;
  else process.env.GITHUB_REPO = originalRepository;

  const fallback = await withoutWarnings(() => loadUsageData(async () => {
    throw new Error('offline');
  }));
  assert.equal(fallback.source, 'bundled');
  assert.ok(fallback.data.daily_usage);

  const malformedFallback = await withoutWarnings(() => loadUsageData(async url => (
    url.endsWith('ai-usage.json') ? {} : { daily_usage_percent: {} }
  )));
  assert.equal(malformedFallback.source, 'bundled');
  assert.ok(malformedFallback.data.daily_usage);

  const olderSelection = await withoutWarnings(() => loadUsageData(async url => (
    url.endsWith('ai-usage.json')
      ? { generated_at: '2000-01-01T00:00:00Z', daily_usage: { '2000-01-01': { total_tokens: 1 } } }
      : { generated_at: '2000-01-01T00:00:00Z', daily_usage_percent: { '2000-01-01': 1 } }
  )));
  assert.equal(olderSelection.source, 'bundled');
  assert.equal(olderSelection.cloudSource, 'bundled');
  assert.equal(olderSelection.data.generated_at, bundledUsage.generated_at);
  assert.equal(olderSelection.cloudActivityData.generated_at, bundledCloudActivity.generated_at);

  const newerSelection = await withoutWarnings(() => loadUsageData(async url => (
    url.endsWith('ai-usage.json')
      ? { generated_at: '2999-01-01T00:00:00Z', daily_usage: { '2999-01-01': { total_tokens: 1 } } }
      : { generated_at: '2999-01-01T00:00:00Z', daily_usage_percent: { '2999-01-01': 1 } }
  )));
  assert.equal(newerSelection.source, 'github');
  assert.equal(newerSelection.cloudSource, 'github');
  assert.equal(newerSelection.data.generated_at, '2999-01-01T00:00:00Z');
  assert.equal(newerSelection.cloudActivityData.generated_at, '2999-01-01T00:00:00Z');

  resetUsageDataCache();
  let cachedFetchCount = 0;
  let releaseCachedFetch;
  const cachedFetchGate = new Promise(resolve => {
    releaseCachedFetch = resolve;
  });
  const cachedFetcher = async url => {
    cachedFetchCount++;
    await cachedFetchGate;
    return url.endsWith('ai-usage.json')
      ? { generated_at: '2999-01-01T00:00:00Z', daily_usage: {} }
      : { generated_at: '2999-01-01T00:00:00Z', daily_usage_percent: {} };
  };
  const firstCachedLoad = loadUsageData(cachedFetcher, { cache: true, ttlMs: 60_000 });
  const secondCachedLoad = loadUsageData(cachedFetcher, { cache: true, ttlMs: 60_000 });
  releaseCachedFetch();
  const [firstCachedValue, secondCachedValue] = await Promise.all([
    firstCachedLoad,
    secondCachedLoad
  ]);
  assert.equal(cachedFetchCount, 2, 'concurrent loads should share one pair of upstream requests');
  assert.strictEqual(firstCachedValue, secondCachedValue);
  const thirdCachedValue = await loadUsageData(cachedFetcher, { cache: true, ttlMs: 60_000 });
  assert.equal(cachedFetchCount, 2, 'warm cache should avoid repeated upstream requests');
  assert.strictEqual(firstCachedValue, thirdCachedValue);
  resetUsageDataCache();

  const methodResponse = responseRecorder();
  await handler({ method: 'POST', query: {} }, methodResponse);
  assert.equal(methodResponse.statusCode, 405);
  assert.equal(methodResponse.headers.Allow, 'GET, HEAD');

  const queryResponse = responseRecorder();
  await handler({ method: 'GET', query: { unexpected: '1' } }, queryResponse);
  assert.equal(queryResponse.statusCode, 400);

  const daysResponse = responseRecorder();
  await handler({ method: 'GET', query: { days: '999' } }, daysResponse);
  assert.equal(daysResponse.statusCode, 400);

  const redirectResponse = responseRecorder();
  await handler({ method: 'GET', query: { profile: 'ZONGRUICHD', v: 'old' } }, redirectResponse);
  assert.equal(redirectResponse.statusCode, 308);
  assert.equal(redirectResponse.headers.Location, '/api/svg');

  console.log('API SVG tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
