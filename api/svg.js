const https = require('https');

const bundledUsage = require('../data/ai-usage.json');
const bundledCloudActivity = require('../data/codex-cloud-activity.json');

const GITHUB_RAW_URL = 'https://raw.githubusercontent.com';
const DEFAULT_REPO_OWNER = 'ZONGRUICHD';
const DEFAULT_REPO_NAME = 'codex-usage-bluewall-github';
const DEFAULT_BRANCH = 'main';
const DEFAULT_TIME_ZONE = 'Asia/Shanghai';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function normalizeTimeZone(value) {
  const timeZone = typeof value === 'string' && value.trim()
    ? value.trim()
    : DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
    return timeZone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function parseStaleAfterDays(value, fallback = 2) {
  const safeFallback = Number.isSafeInteger(fallback) && fallback >= 0 ? fallback : 2;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : safeFallback;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return safeFallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : safeFallback;
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function dateFromKey(value) {
  if (!ISO_DATE.test(value || '')) return null;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateKeyInTimeZone(value = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: normalizeTimeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return byType.year + '-' + byType.month + '-' + byType.day;
}

function snapshotDate(value, timeZone) {
  const generatedAt = new Date(value && value.generated_at);
  return Number.isNaN(generatedAt.getTime())
    ? null
    : dateKeyInTimeZone(generatedAt, timeZone);
}

function snapshotTimestamp(value) {
  const timestamp = Date.parse(value && value.generated_at);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function latestDate(...values) {
  return values.flat().filter(value => ISO_DATE.test(value || '')).sort().at(-1);
}

function daysBetween(earlier, later) {
  const earlierDate = dateFromKey(earlier);
  const laterDate = dateFromKey(later);
  if (!earlierDate || !laterDate) return 0;
  return Math.floor((laterDate - earlierDate) / DAY_MS);
}

function formatShortDate(value) {
  const date = dateFromKey(value);
  if (!date) return 'unknown';
  return date.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric'
  });
}

function displayToolName(tool) {
  return {
    claude_code: 'Claude Code',
    mimocode: 'MiMo Code',
    opencode: 'OpenCode',
    hermes: 'Hermes'
  }[tool] || tool.charAt(0).toUpperCase() + tool.slice(1);
}

function getColorIntensity(tokens, maxTokens, cloudUsagePercent = 0) {
  if (tokens === 0 && cloudUsagePercent <= 0) return '#161b22';

  const intensity = tokens > 0 && maxTokens > 0
    ? Math.max(0.12, Math.min(Math.sqrt(tokens / maxTokens), 1.0))
    : Math.max(0.12, Math.min(Math.sqrt(cloudUsagePercent / 100), 1.0));
  const colors = [
    [15, 50, 100],
    [25, 80, 160],
    [40, 120, 200],
    [66, 165, 245],
    [144, 202, 249]
  ];

  const idx = intensity * (colors.length - 1);
  const lowerIdx = Math.floor(idx);
  const upperIdx = Math.min(lowerIdx + 1, colors.length - 1);
  const fraction = idx - lowerIdx;

  const red = Math.round(colors[lowerIdx][0] + (colors[upperIdx][0] - colors[lowerIdx][0]) * fraction);
  const green = Math.round(colors[lowerIdx][1] + (colors[upperIdx][1] - colors[lowerIdx][1]) * fraction);
  const blue = Math.round(colors[lowerIdx][2] + (colors[upperIdx][2] - colors[lowerIdx][2]) * fraction);

  return '#' + red.toString(16).padStart(2, '0') + green.toString(16).padStart(2, '0') + blue.toString(16).padStart(2, '0');
}

function activeDateSet(data, cloudActivity) {
  const activeDates = new Set(
    Object.entries(data.daily_usage || {})
      .filter(([date, usage]) => ISO_DATE.test(date) && number(usage && usage.total_tokens) > 0)
      .map(([date]) => date)
  );
  for (const [date, usagePercent] of Object.entries(cloudActivity || {})) {
    if (ISO_DATE.test(date) && number(usagePercent) > 0) activeDates.add(date);
  }
  return activeDates;
}

function calculateActivityStatistics(data, cloudActivity = {}, referenceDate) {
  const activeDates = activeDateSet(data, cloudActivity);
  const dates = [...activeDates].sort();
  let longestStreak = 0;
  let streak = 0;
  let previous = null;
  for (const date of dates) {
    const current = dateFromKey(date);
    streak = previous && current - previous === DAY_MS ? streak + 1 : 1;
    longestStreak = Math.max(longestStreak, streak);
    previous = current;
  }

  const anchor = dateFromKey(referenceDate) || dateFromKey(dateKeyInTimeZone());
  let currentStreak = 0;
  while (anchor) {
    const date = new Date(anchor);
    date.setUTCDate(date.getUTCDate() - currentStreak);
    if (!activeDates.has(date.toISOString().slice(0, 10))) break;
    currentStreak++;
  }

  return {
    currentStreak,
    longestStreak,
    totalDaysActive: activeDates.size
  };
}

function calculateFreshness(data, cloudActivity, referenceDate, timeZone, staleAfterDays = 2, cloudData) {
  const safeTimeZone = normalizeTimeZone(timeZone);
  let syncedDate = snapshotDate(data, safeTimeZone);

  const activeDates = [...activeDateSet(data, cloudActivity)];
  const localDataDates = Object.keys(data.daily_usage || {}).filter(date => ISO_DATE.test(date));
  syncedDate = syncedDate || latestDate(localDataDates);
  const lastActiveDate = latestDate(activeDates);
  const ageDays = Math.max(0, daysBetween(syncedDate, referenceDate));

  return {
    syncedDate,
    cloudSyncedDate: snapshotDate(cloudData, safeTimeZone),
    lastActiveDate,
    ageDays,
    stale: !syncedDate || ageDays > parseStaleAfterDays(staleAfterDays)
  };
}

function calculateWindowSummary(data, startDate, endDate) {
  const tools = {};
  let totalTokens = 0;
  let peakTokens = 0;
  for (const [date, usage] of Object.entries(data.daily_usage || {})) {
    if (!ISO_DATE.test(date) || date < startDate || date > endDate) continue;
    const tokens = number(usage && usage.total_tokens);
    totalTokens += tokens;
    peakTokens = Math.max(peakTokens, tokens);
    for (const [tool, value] of Object.entries((usage && usage.tools) || {})) {
      tools[tool] = (tools[tool] || 0) + number(value);
    }
  }
  return { totalTokens, peakTokens, tools };
}

function entriesInWindow(values, startDate, endDate) {
  return Object.fromEntries(
    Object.entries(values || {}).filter(([date]) => (
      ISO_DATE.test(date) && date >= startDate && date <= endDate
    ))
  );
}

function generateSVG(data, days = 365, cloudActivity = {}, options = {}) {
  if (!data || typeof data !== 'object' || !data.daily_usage || typeof data.daily_usage !== 'object') {
    throw new TypeError('usage data must contain daily_usage');
  }

  const cellSize = 12;
  const cellPadding = 3;
  const headerHeight = 92;
  const footerHeight = 60;
  const sidePadding = 30;
  const safeDays = Math.max(7, Math.min(Number.parseInt(days, 10) || 365, 365));
  const timeZone = normalizeTimeZone(options.timeZone);
  const currentDate = ISO_DATE.test(options.referenceDate || '')
    ? options.referenceDate
    : dateKeyInTimeZone(options.now || new Date(), timeZone);
  const knownDates = [
    currentDate,
    ...Object.keys(data.daily_usage || {}),
    ...Object.keys(cloudActivity || {})
  ];
  const endDateKey = latestDate(knownDates) || currentDate;
  const endDate = dateFromKey(endDateKey);
  const startDate = new Date(endDate);
  startDate.setUTCDate(startDate.getUTCDate() - safeDays);
  while (startDate.getUTCDay() !== 0) startDate.setUTCDate(startDate.getUTCDate() - 1);
  const startDateKey = startDate.toISOString().slice(0, 10);

  const weeks = Math.min(Math.ceil(safeDays / 7) + 1, 53);
  const gridWidth = weeks * (cellSize + cellPadding);
  const gridHeight = 7 * (cellSize + cellPadding);
  // The header legend and footer metrics use the full profile-card layout even
  // for short ranges, so never let a 7/30/90-day canvas crop those elements.
  const totalWidth = Math.max(855, gridWidth + sidePadding * 2);
  const totalHeight = headerHeight + gridHeight + footerHeight;
  const windowSummary = calculateWindowSummary(data, startDateKey, endDateKey);
  const maxTokens = windowSummary.peakTokens;

  let cells = '';
  let monthLabels = '';
  let currentDateCursor = new Date(startDate);
  let week = 0;
  let lastMonthLabelX = -100;
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  while (currentDateCursor <= endDate) {
    const dayOfWeek = currentDateCursor.getUTCDay();
    const dateStr = currentDateCursor.toISOString().slice(0, 10);
    const usage = data.daily_usage[dateStr] || {};
    const tokens = number(usage.total_tokens);
    const cloudUsage = number(cloudActivity[dateStr]);
    const color = getColorIntensity(tokens, maxTokens, cloudUsage);
    const x = sidePadding + week * (cellSize + cellPadding);
    const y = headerHeight + dayOfWeek * (cellSize + cellPadding);

    if ((dateStr === startDateKey || currentDateCursor.getUTCDate() === 1) && x - lastMonthLabelX >= 42) {
      monthLabels += '<text x="' + x + '" y="84" fill="#8b949e" font-size="10">' + monthNames[currentDateCursor.getUTCMonth()] + '</text>';
      lastMonthLabelX = x;
    }

    const title = tokens > 0
      ? dateStr + ': ' + tokens.toLocaleString('en-US') + ' tokens'
      : cloudUsage > 0
        ? dateStr + ': Codex cloud usage ' + cloudUsage.toLocaleString('en-US') + '%'
        : dateStr + ': no activity';
    cells += '<rect x="' + x + '" y="' + y + '" width="' + cellSize + '" height="' + cellSize + '" fill="' + color + '" rx="2" ry="2"><title>' + escapeXml(title) + '</title></rect>';

    currentDateCursor.setUTCDate(currentDateCursor.getUTCDate() + 1);
    if (currentDateCursor.getUTCDay() === 0) week++;
  }

  const toolSource = Object.keys(windowSummary.tools).length > 0
    ? windowSummary.tools
    : data.per_tool_summary || {};
  const toolBreakdown = Object.entries(toolSource)
    .filter(([, tokens]) => number(tokens) > 0)
    .map(([tool, tokens]) => displayToolName(tool) + ': ' + number(tokens).toLocaleString('en-US'))
    .join(' | ');
  const activityStatistics = calculateActivityStatistics(
    { daily_usage: entriesInWindow(data.daily_usage, startDateKey, endDateKey) },
    entriesInWindow(cloudActivity, startDateKey, endDateKey),
    endDateKey
  );
  const freshness = calculateFreshness(
    data,
    cloudActivity,
    currentDate,
    timeZone,
    parseStaleAfterDays(options.staleAfterDays),
    options.cloudData
  );
  const streakText = freshness.stale ? '— (data stale)' : activityStatistics.currentStreak + ' days';
  const hasHistoricalGap = Boolean(data.data_quality && data.data_quality.complete === false);
  const freshnessText = (freshness.stale ? 'Local stale · synced ' : 'Local synced ') +
    formatShortDate(freshness.syncedDate) + ' · active ' + formatShortDate(freshness.lastActiveDate) +
    (freshness.cloudSyncedDate ? ' · cloud ' + formatShortDate(freshness.cloudSyncedDate) : '') +
    (hasHistoricalGap ? ' · history gap' : '');
  const freshnessColor = freshness.stale ? '#d29922' : '#8b949e';
  const qualityDescription = hasHistoricalGap ? ' Historical data is incomplete.' : '';

  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<svg width="' + totalWidth + '" height="' + totalHeight + '" viewBox="0 0 ' + totalWidth + ' ' + totalHeight + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title description" font-family="-apple-system, BlinkMacSystemFont, &apos;Segoe UI&apos;, Helvetica, Arial, sans-serif">' +
    '<title id="title">AI Coding Activity</title>' +
    '<desc id="description">Token activity from ' + startDateKey + ' through ' + endDateKey + '.' + qualityDescription + '</desc>' +
    '<rect width="' + totalWidth + '" height="' + totalHeight + '" fill="#0d1117" rx="6" ry="6"/>' +
    '<text x="' + sidePadding + '" y="25" fill="#e6edf3" font-size="16" font-weight="600">AI Coding Activity</text>' +
    '<text x="' + sidePadding + '" y="45" fill="#8b949e" font-size="12">Token usage across devices, tools, and agents</text>' +
    '<text x="' + sidePadding + '" y="65" fill="#58a6ff" font-size="11">' + escapeXml(toolBreakdown) + '</text>' +
    '<text x="650" y="45" fill="#8b949e" font-size="10">Less</text>' +
    '<rect x="680" y="36" width="10" height="10" fill="#161b22" rx="2" ry="2"/>' +
    '<rect x="695" y="36" width="10" height="10" fill="#0f3264" rx="2" ry="2"/>' +
    '<rect x="710" y="36" width="10" height="10" fill="#1976d2" rx="2" ry="2"/>' +
    '<rect x="725" y="36" width="10" height="10" fill="#2878c8" rx="2" ry="2"/>' +
    '<rect x="740" y="36" width="10" height="10" fill="#42a5f5" rx="2" ry="2"/>' +
    '<rect x="755" y="36" width="10" height="10" fill="#90caf9" rx="2" ry="2"/>' +
    '<text x="770" y="45" fill="#8b949e" font-size="10">More</text>' +
    monthLabels +
    '<text x="' + (sidePadding - 5) + '" y="' + (headerHeight + 10) + '" fill="#8b949e" font-size="10" text-anchor="end">Sun</text>' +
    '<text x="' + (sidePadding - 5) + '" y="' + (headerHeight + 10 + (cellSize + cellPadding) * 2) + '" fill="#8b949e" font-size="10" text-anchor="end">Tue</text>' +
    '<text x="' + (sidePadding - 5) + '" y="' + (headerHeight + 10 + (cellSize + cellPadding) * 4) + '" fill="#8b949e" font-size="10" text-anchor="end">Thu</text>' +
    '<text x="' + (sidePadding - 5) + '" y="' + (headerHeight + 10 + (cellSize + cellPadding) * 6) + '" fill="#8b949e" font-size="10" text-anchor="end">Sat</text>' +
    cells +
    '<text x="' + sidePadding + '" y="' + (headerHeight + gridHeight + 20) + '" fill="#8b949e" font-size="11">Total: <tspan fill="#e6edf3">' + windowSummary.totalTokens.toLocaleString('en-US') + '</tspan> tokens</text>' +
    '<text x="300" y="' + (headerHeight + gridHeight + 20) + '" fill="#8b949e" font-size="11">Peak: <tspan fill="#e6edf3">' + windowSummary.peakTokens.toLocaleString('en-US') + '</tspan> tokens</text>' +
    '<text x="570" y="' + (headerHeight + gridHeight + 20) + '" fill="#8b949e" font-size="11">Streak: <tspan fill="#58a6ff">' + streakText + '</tspan></text>' +
    '<text x="' + sidePadding + '" y="' + (headerHeight + gridHeight + 40) + '" fill="#8b949e" font-size="11">Active days: <tspan fill="#e6edf3">' + activityStatistics.totalDaysActive + '</tspan></text>' +
    '<text x="180" y="' + (headerHeight + gridHeight + 40) + '" fill="#8b949e" font-size="11">Longest streak: <tspan fill="#58a6ff">' + activityStatistics.longestStreak + ' days</tspan></text>' +
    '<text x="400" y="' + (headerHeight + gridHeight + 40) + '" fill="' + freshnessColor + '" font-size="10">' + escapeXml(freshnessText) + '</text>' +
    '</svg>';
}

function fetchJSON(url, options = {}) {
  const timeoutMs = options.timeoutMs || 5_000;
  const maxBytes = options.maxBytes || 1_000_000;
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'codex-usage-bluewall/2.0'
      }
    }, response => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error('HTTP ' + response.statusCode + ' for upstream data'));
        return;
      }

      let body = '';
      let bytes = 0;
      response.setEncoding('utf8');
      response.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) {
          request.destroy(new Error('upstream response exceeded size limit'));
          return;
        }
        body += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error('invalid upstream JSON: ' + error.message));
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('upstream request timed out')));
    request.on('error', reject);
  });
}

function repositoryCoordinates() {
  return {
    owner: process.env.GITHUB_USERNAME || process.env.VERCEL_GIT_REPO_OWNER || DEFAULT_REPO_OWNER,
    repository: process.env.GITHUB_REPO || process.env.VERCEL_GIT_REPO_SLUG || DEFAULT_REPO_NAME,
    branch: process.env.GITHUB_BRANCH || DEFAULT_BRANCH
  };
}

function isUsageData(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    value.daily_usage &&
    typeof value.daily_usage === 'object' &&
    !Array.isArray(value.daily_usage)
  );
}

function isCloudActivityData(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    value.daily_usage_percent &&
    typeof value.daily_usage_percent === 'object' &&
    !Array.isArray(value.daily_usage_percent)
  );
}

function newestSnapshot(bundled, fetched, validator) {
  if (!validator(fetched)) return { value: bundled, source: 'bundled' };
  if (!validator(bundled)) return { value: fetched, source: 'github' };

  const bundledTimestamp = snapshotTimestamp(bundled);
  const fetchedTimestamp = snapshotTimestamp(fetched);
  if (fetchedTimestamp == null) return { value: bundled, source: 'bundled' };
  if (bundledTimestamp == null || fetchedTimestamp >= bundledTimestamp) {
    return { value: fetched, source: 'github' };
  }
  return { value: bundled, source: 'bundled' };
}

async function loadUsageData(fetcher = fetchJSON) {
  const { owner, repository, branch } = repositoryCoordinates();
  const dataRoot = GITHUB_RAW_URL + '/' + [owner, repository, branch, 'data']
    .map(segment => encodeURIComponent(segment))
    .join('/') + '/';

  let data = bundledUsage;
  let cloudActivityData = bundledCloudActivity;
  let source = 'bundled';
  let cloudSource = 'bundled';
  const [usageResult, cloudResult] = await Promise.allSettled([
    fetcher(dataRoot + 'ai-usage.json'),
    fetcher(dataRoot + 'codex-cloud-activity.json')
  ]);
  if (usageResult.status === 'fulfilled' && isUsageData(usageResult.value)) {
    const selected = newestSnapshot(bundledUsage, usageResult.value, isUsageData);
    data = selected.value;
    source = selected.source;
    if (source === 'bundled') {
      console.warn('Using bundled usage snapshot because GitHub Raw is older or undated');
    }
  } else {
    const message = usageResult.status === 'rejected'
      ? usageResult.reason.message
      : 'upstream usage schema was invalid';
    console.warn('Using bundled usage fallback:', message);
  }
  if (cloudResult.status === 'fulfilled' && isCloudActivityData(cloudResult.value)) {
    const selected = newestSnapshot(
      bundledCloudActivity,
      cloudResult.value,
      isCloudActivityData
    );
    cloudActivityData = selected.value;
    cloudSource = selected.source;
    if (cloudSource === 'bundled') {
      console.warn('Using bundled cloud snapshot because GitHub Raw is older or undated');
    }
  } else {
    const message = cloudResult.status === 'rejected'
      ? cloudResult.reason.message
      : 'upstream cloud activity schema was invalid';
    console.warn('Using bundled cloud activity fallback:', message);
  }

  return { data, cloudActivityData, source, cloudSource, dataRoot };
}

function queryKeys(query) {
  return Object.keys(query || {}).filter(key => query[key] != null);
}

async function handler(req, res) {
  const method = String(req.method || 'GET').toUpperCase();
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");

  if (method !== 'GET' && method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const keys = queryKeys(req.query);
  const unknownKeys = keys.filter(key => !['days', 'profile', 'v'].includes(key));
  if (unknownKeys.length > 0) {
    res.status(400).json({ error: 'Unsupported query parameter' });
    return;
  }

  const rawDays = req.query && req.query.days;
  if (Array.isArray(rawDays) || (rawDays != null && !/^\d{1,3}$/.test(String(rawDays)))) {
    res.status(400).json({ error: 'days must be an integer from 7 to 365' });
    return;
  }
  const days = rawDays == null ? 365 : Number.parseInt(rawDays, 10);
  if (days < 7 || days > 365) {
    res.status(400).json({ error: 'days must be an integer from 7 to 365' });
    return;
  }

  // Older README embeds used cache-busting/profile parameters that never
  // affected rendering. Redirect them before touching GitHub so arbitrary
  // variants cannot fan out upstream requests.
  if (keys.includes('profile') || keys.includes('v')) {
    const location = '/api/svg' + (rawDays == null ? '' : '?days=' + days);
    res.setHeader('Location', location);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.status(308).end();
    return;
  }

  try {
    const { data, cloudActivityData, source, cloudSource } = await loadUsageData();
    const svg = generateSVG(
      data,
      days,
      cloudActivityData.daily_usage_percent || {},
      {
        timeZone: normalizeTimeZone(process.env.TIME_ZONE),
        staleAfterDays: parseStaleAfterDays(process.env.STALE_AFTER_DAYS),
        cloudData: cloudActivityData
      }
    );

    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400');
    res.setHeader('X-Data-Source', source);
    res.setHeader('X-Cloud-Data-Source', cloudSource);
    if (method === 'HEAD') {
      res.status(200).end();
      return;
    }
    res.status(200).send(svg);
  } catch (error) {
    console.error('SVG generation failed:', error);
    res.status(500).json({ error: 'Failed to generate SVG' });
  }
}

module.exports = handler;
module.exports.calculateActivityStatistics = calculateActivityStatistics;
module.exports.calculateFreshness = calculateFreshness;
module.exports.dateKeyInTimeZone = dateKeyInTimeZone;
module.exports.fetchJSON = fetchJSON;
module.exports.generateSVG = generateSVG;
module.exports.loadUsageData = loadUsageData;
module.exports.normalizeTimeZone = normalizeTimeZone;
module.exports.parseStaleAfterDays = parseStaleAfterDays;
module.exports.repositoryCoordinates = repositoryCoordinates;
