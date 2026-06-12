import { NextApiRequest, NextApiResponse } from 'next';

const GITHUB_RAW_URL = 'https://raw.githubusercontent.com';
const REPO_OWNER = process.env.GITHUB_USERNAME || 'zongrui';
const REPO_NAME = process.env.GITHUB_REPO || 'codex-usage-bluewall-github';

interface DailyUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  tools?: Record<string, number>;
}

interface UsageData {
  generated_at: string;
  tools_scanned: string[];
  per_tool_summary: Record<string, number>;
  statistics: {
    total_tokens: number;
    peak_day: string;
    peak_tokens: number;
    current_streak: number;
    longest_streak: number;
    total_days_active: number;
  };
  daily_usage: Record<string, DailyUsage>;
}

function getColorIntensity(tokens: number, maxTokens: number): string {
  if (tokens === 0) return '#161b22';
  if (maxTokens === 0) return '#0f3264';

  const intensity = Math.min(tokens / maxTokens, 1.0);
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

  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function generateSVG(data: UsageData, days: number = 365): string {
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
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - days);
  while (startDate.getDay() !== 0) startDate.setDate(startDate.getDate() - 1);

  let currentDate = new Date(startDate);
  let week = 0;

  while (currentDate <= today) {
    const dayOfWeek = currentDate.getDay();
    const dateStr = currentDate.toISOString().split('T')[0];
    const tokens = data.daily_usage[dateStr]?.total_tokens || 0;
    const color = getColorIntensity(tokens, maxTokens);
    const tools = data.daily_usage[dateStr]?.tools || {};
    const toolInfo = Object.entries(tools).map(([t, v]) => `${t}: ${v.toLocaleString()}`).join('\\n');

    const x = SIDE_PADDING + week * (CELL_SIZE + CELL_PADDING);
    const y = HEADER_HEIGHT + dayOfWeek * (CELL_SIZE + CELL_PADDING);

    cells += `<rect x="${x}" y="${y}" width="${CELL_SIZE}" height="${CELL_SIZE}" fill="${color}" rx="2" ry="2"><title>${dateStr}: ${tokens.toLocaleString()} tokens${toolInfo ? '\\n' + toolInfo : ''}</title></rect>`;

    currentDate.setDate(currentDate.getDate() + 1);
    if (currentDate.getDay() === 0) week++;
  }

  // Tool breakdown
  const toolBreakdown = Object.entries(data.per_tool_summary || {})
    .map(([tool, tokens]) => `${tool}: ${tokens.toLocaleString()}`)
    .join(' | ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${totalWidth}" height="${totalHeight}" viewBox="0 0 ${totalWidth} ${totalHeight}" 
     xmlns="http://www.w3.org/2000/svg" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">
  
  <rect width="${totalWidth}" height="${totalHeight}" fill="#0d1117" rx="6" ry="6"/>
  
  <text x="${SIDE_PADDING}" y="25" fill="#e6edf3" font-size="16" font-weight="600">AI Coding Activity</text>
  <text x="${SIDE_PADDING}" y="45" fill="#8b949e" font-size="12">Token usage across Codex, Claude Code, MimoCode</text>
  <text x="${SIDE_PADDING}" y="65" fill="#58a6ff" font-size="11">${toolBreakdown}</text>
  
  <text x="${SIDE_PADDING - 5}" y="${HEADER_HEIGHT + 10}" fill="#8b949e" font-size="10" text-anchor="end">Sun</text>
  <text x="${SIDE_PADDING - 5}" y="${HEADER_HEIGHT + 10 + (CELL_SIZE + CELL_PADDING) * 2}" fill="#8b949e" font-size="10" text-anchor="end">Tue</text>
  <text x="${SIDE_PADDING - 5}" y="${HEADER_HEIGHT + 10 + (CELL_SIZE + CELL_PADDING) * 4}" fill="#8b949e" font-size="10" text-anchor="end">Thu</text>
  <text x="${SIDE_PADDING - 5}" y="${HEADER_HEIGHT + 10 + (CELL_SIZE + CELL_PADDING) * 6}" fill="#8b949e" font-size="10" text-anchor="end">Sat</text>
  
  ${cells}
  
  <text x="${SIDE_PADDING}" y="${HEADER_HEIGHT + gridHeight + 20}" fill="#8b949e" font-size="11">Total: <tspan fill="#e6edf3">${data.statistics.total_tokens.toLocaleString()}</tspan> tokens</text>
  <text x="${SIDE_PADDING + 250}" y="${HEADER_HEIGHT + gridHeight + 20}" fill="#8b949e" font-size="11">Peak: <tspan fill="#e6edf3">${data.statistics.peak_tokens.toLocaleString()}</tspan> tokens</text>
  <text x="${SIDE_PADDING + 500}" y="${HEADER_HEIGHT + gridHeight + 20}" fill="#8b949e" font-size="11">Streak: <tspan fill="#58a6ff">${data.statistics.current_streak}</tspan> days</text>
  <text x="${SIDE_PADDING}" y="${HEADER_HEIGHT + gridHeight + 40}" fill="#8b949e" font-size="11">Active days: <tspan fill="#e6edf3">${data.statistics.total_days_active}</tspan></text>
  <text x="${SIDE_PADDING + 250}" y="${HEADER_HEIGHT + gridHeight + 40}" fill="#8b949e" font-size="11">Longest streak: <tspan fill="#58a6ff">${data.statistics.longest_streak}</tspan> days</text>
  
  <text x="${totalWidth - SIDE_PADDING - 200}" y="${HEADER_HEIGHT + gridHeight + 20}" fill="#8b949e" font-size="10">Less</text>
  <rect x="${totalWidth - SIDE_PADDING - 170}" y="${HEADER_HEIGHT + gridHeight + 10}" width="10" height="10" fill="#161b22" rx="2" ry="2"/>
  <rect x="${totalWidth - SIDE_PADDING - 155}" y="${HEADER_HEIGHT + gridHeight + 10}" width="10" height="10" fill="#0f3264" rx="2" ry="2"/>
  <rect x="${totalWidth - SIDE_PADDING - 140}" y="${HEADER_HEIGHT + gridHeight + 10}" width="10" height="10" fill="#1976d2" rx="2" ry="2"/>
  <rect x="${totalWidth - SIDE_PADDING - 125}" y="${HEADER_HEIGHT + gridHeight + 10}" width="10" height="10" fill="#2878c8" rx="2" ry="2"/>
  <rect x="${totalWidth - SIDE_PADDING - 110}" y="${HEADER_HEIGHT + gridHeight + 10}" width="10" height="10" fill="#42a5f5" rx="2" ry="2"/>
  <rect x="${totalWidth - SIDE_PADDING - 95}" y="${HEADER_HEIGHT + gridHeight + 10}" width="10" height="10" fill="#90caf9" rx="2" ry="2"/>
  <text x="${totalWidth - SIDE_PADDING - 80}" y="${HEADER_HEIGHT + gridHeight + 20}" fill="#8b949e" font-size="10">More</text>
  
</svg>`;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const days = parseInt(req.query.days as string) || 365;
    
    // Fetch usage data from GitHub
    const response = await fetch(`${GITHUB_RAW_URL}/${REPO_OWNER}/${REPO_NAME}/main/data/ai-usage.json`);
    
    if (!response.ok) {
      throw new Error('Failed to fetch usage data');
    }
    
    const data: UsageData = await response.json();
    const svg = generateSVG(data, days);
    
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
    res.status(200).send(svg);
  } catch (error) {
    console.error('Error generating SVG:', error);
    res.status(500).json({ error: 'Failed to generate SVG' });
  }
}
