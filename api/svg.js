const https = require('https');

const GITHUB_RAW_URL = 'https://raw.githubusercontent.com';
const REPO_OWNER = 'zong1024';
const REPO_NAME = 'codex-usage-bluewall-github';

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
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

  const r = Math.round(colors[lowerIdx][0] + (colors[upperIdx][0] - colors[lowerIdx][0]) * fraction);
  const g = Math.round(colors[lowerIdx][1] + (colors[upperIdx][1] - colors[lowerIdx][1]) * fraction);
  const b = Math.round(colors[lowerIdx][2] + (colors[upperIdx][2] - colors[lowerIdx][2]) * fraction);

  return '#' + r.toString(16).padStart(2, '0') + g.toString(16).padStart(2, '0') + b.toString(16).padStart(2, '0');
}

function calculateActivityStatistics(data, cloudActivity) {
  const activeDates = new Set(
    Object.entries(data.daily_usage || {})
      .filter(([, usage]) => usage.total_tokens > 0)
      .map(([date]) => date)
  );
  for (const [date, usagePercent] of Object.entries(cloudActivity || {})) {
    if (usagePercent > 0) activeDates.add(date);
  }

  const dates = [...activeDates].sort();
  let longestStreak = 0;
  let streak = 0;
  let previous = null;
  for (const date of dates) {
    const current = new Date(date + 'T00:00:00Z');
    streak = previous && current - previous === 86400000 ? streak + 1 : 1;
    longestStreak = Math.max(longestStreak, streak);
    previous = current;
  }

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  let currentStreak = 0;
  while (true) {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() - currentStreak);
    if (!activeDates.has(date.toISOString().split('T')[0])) break;
    currentStreak++;
  }

  return {
    currentStreak,
    longestStreak,
    totalDaysActive: activeDates.size
  };
}

function generateSVG(data, days, cloudActivity = {}) {
  const CELL_SIZE = 12;
  const CELL_PADDING = 3;
  const HEADER_HEIGHT = 80;
  const FOOTER_HEIGHT = 60;
  const SIDE_PADDING = 30;

  const maxTokens = Math.max(...Object.values(data.daily_usage).map(d => d.total_tokens), 0);
  const weeks = Math.min(Math.ceil(days / 7) + 1, 53);
  const gridWidth = weeks * (CELL_SIZE + CELL_PADDING);
  const gridHeight = 7 * (CELL_SIZE + CELL_PADDING);
  const totalWidth = gridWidth + SIDE_PADDING * 2;
  const totalHeight = HEADER_HEIGHT + gridHeight + FOOTER_HEIGHT;

  let cells = '';
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const startDate = new Date(today);
  startDate.setUTCDate(startDate.getUTCDate() - days);
  while (startDate.getUTCDay() !== 0) startDate.setUTCDate(startDate.getUTCDate() - 1);

  let currentDate = new Date(startDate);
  let week = 0;

  while (currentDate <= today) {
    const dayOfWeek = currentDate.getUTCDay();
    const dateStr = currentDate.toISOString().split('T')[0];
    const tokens = data.daily_usage[dateStr] ? data.daily_usage[dateStr].total_tokens : 0;
    const cloudUsage = cloudActivity[dateStr] || 0;
    const color = getColorIntensity(tokens, maxTokens, cloudUsage);

    const x = SIDE_PADDING + week * (CELL_SIZE + CELL_PADDING);
    const y = HEADER_HEIGHT + dayOfWeek * (CELL_SIZE + CELL_PADDING);

    const title = tokens > 0
      ? dateStr + ': ' + tokens.toLocaleString() + ' tokens'
      : cloudUsage > 0
        ? dateStr + ': Codex cloud usage ' + cloudUsage.toLocaleString() + '%'
        : dateStr + ': no activity';
    cells += '<rect x="' + x + '" y="' + y + '" width="' + CELL_SIZE + '" height="' + CELL_SIZE + '" fill="' + color + '" rx="2" ry="2"><title>' + title + '</title></rect>';

    currentDate.setUTCDate(currentDate.getUTCDate() + 1);
    if (currentDate.getUTCDay() === 0) week++;
  }

  const toolBreakdown = Object.entries(data.per_tool_summary || {})
    .filter(([, tokens]) => tokens > 0)
    .map(([tool, tokens]) => displayToolName(tool) + ': ' + tokens.toLocaleString())
    .join(' | ');
  const activityStatistics = calculateActivityStatistics(data, cloudActivity);

  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<svg width="' + totalWidth + '" height="' + totalHeight + '" viewBox="0 0 ' + totalWidth + ' ' + totalHeight + '" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system, BlinkMacSystemFont, \'Segoe UI\', Helvetica, Arial, sans-serif">' +
    '<rect width="' + totalWidth + '" height="' + totalHeight + '" fill="#0d1117" rx="6" ry="6"/>' +
    '<text x="' + SIDE_PADDING + '" y="25" fill="#e6edf3" font-size="16" font-weight="600">AI Coding Activity</text>' +
    '<text x="' + SIDE_PADDING + '" y="45" fill="#8b949e" font-size="12">Token usage across devices, tools, and agents</text>' +
    '<text x="' + SIDE_PADDING + '" y="65" fill="#58a6ff" font-size="11">' + escapeXml(toolBreakdown) + '</text>' +
    '<text x="' + (SIDE_PADDING - 5) + '" y="' + (HEADER_HEIGHT + 10) + '" fill="#8b949e" font-size="10" text-anchor="end">Sun</text>' +
    '<text x="' + (SIDE_PADDING - 5) + '" y="' + (HEADER_HEIGHT + 10 + (CELL_SIZE + CELL_PADDING) * 2) + '" fill="#8b949e" font-size="10" text-anchor="end">Tue</text>' +
    '<text x="' + (SIDE_PADDING - 5) + '" y="' + (HEADER_HEIGHT + 10 + (CELL_SIZE + CELL_PADDING) * 4) + '" fill="#8b949e" font-size="10" text-anchor="end">Thu</text>' +
    '<text x="' + (SIDE_PADDING - 5) + '" y="' + (HEADER_HEIGHT + 10 + (CELL_SIZE + CELL_PADDING) * 6) + '" fill="#8b949e" font-size="10" text-anchor="end">Sat</text>' +
    cells +
    '<text x="' + SIDE_PADDING + '" y="' + (HEADER_HEIGHT + gridHeight + 20) + '" fill="#8b949e" font-size="11">Total: <tspan fill="#e6edf3">' + data.statistics.total_tokens.toLocaleString() + '</tspan> tokens</text>' +
    '<text x="' + (SIDE_PADDING + 250) + '" y="' + (HEADER_HEIGHT + gridHeight + 20) + '" fill="#8b949e" font-size="11">Peak: <tspan fill="#e6edf3">' + data.statistics.peak_tokens.toLocaleString() + '</tspan> tokens</text>' +
    '<text x="' + (SIDE_PADDING + 500) + '" y="' + (HEADER_HEIGHT + gridHeight + 20) + '" fill="#8b949e" font-size="11">Streak: <tspan fill="#58a6ff">' + activityStatistics.currentStreak + '</tspan> days</text>' +
    '<text x="' + SIDE_PADDING + '" y="' + (HEADER_HEIGHT + gridHeight + 40) + '" fill="#8b949e" font-size="11">Active days: <tspan fill="#e6edf3">' + activityStatistics.totalDaysActive + '</tspan></text>' +
    '<text x="' + (SIDE_PADDING + 250) + '" y="' + (HEADER_HEIGHT + gridHeight + 40) + '" fill="#8b949e" font-size="11">Longest streak: <tspan fill="#58a6ff">' + activityStatistics.longestStreak + '</tspan> days</text>' +
    '<text x="' + (totalWidth - SIDE_PADDING - 200) + '" y="' + (HEADER_HEIGHT + gridHeight + 20) + '" fill="#8b949e" font-size="10">Less</text>' +
    '<rect x="' + (totalWidth - SIDE_PADDING - 170) + '" y="' + (HEADER_HEIGHT + gridHeight + 10) + '" width="10" height="10" fill="#161b22" rx="2" ry="2"/>' +
    '<rect x="' + (totalWidth - SIDE_PADDING - 155) + '" y="' + (HEADER_HEIGHT + gridHeight + 10) + '" width="10" height="10" fill="#0f3264" rx="2" ry="2"/>' +
    '<rect x="' + (totalWidth - SIDE_PADDING - 140) + '" y="' + (HEADER_HEIGHT + gridHeight + 10) + '" width="10" height="10" fill="#1976d2" rx="2" ry="2"/>' +
    '<rect x="' + (totalWidth - SIDE_PADDING - 125) + '" y="' + (HEADER_HEIGHT + gridHeight + 10) + '" width="10" height="10" fill="#2878c8" rx="2" ry="2"/>' +
    '<rect x="' + (totalWidth - SIDE_PADDING - 110) + '" y="' + (HEADER_HEIGHT + gridHeight + 10) + '" width="10" height="10" fill="#42a5f5" rx="2" ry="2"/>' +
    '<rect x="' + (totalWidth - SIDE_PADDING - 95) + '" y="' + (HEADER_HEIGHT + gridHeight + 10) + '" width="10" height="10" fill="#90caf9" rx="2" ry="2"/>' +
    '<text x="' + (totalWidth - SIDE_PADDING - 80) + '" y="' + (HEADER_HEIGHT + gridHeight + 20) + '" fill="#8b949e" font-size="10">More</text>' +
    '</svg>';
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function handler(req, res) {
  try {
    const requestedDays = parseInt(req.query.days, 10) || 365;
    const days = Math.max(7, Math.min(requestedDays, 365));
    const dataRoot = GITHUB_RAW_URL + '/' + REPO_OWNER + '/' + REPO_NAME + '/main/data/';
    
    const [data, cloudActivityData] = await Promise.all([
      fetchJSON(dataRoot + 'ai-usage.json'),
      fetchJSON(dataRoot + 'codex-cloud-activity.json').catch(() => ({}))
    ]);
    const svg = generateSVG(
      data,
      days,
      cloudActivityData.daily_usage_percent || {}
    );
    
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
    res.status(200).send(svg);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Failed to generate SVG' });
  }
}

module.exports = handler;
module.exports.generateSVG = generateSVG;
