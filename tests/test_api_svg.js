const assert = require('node:assert/strict');

const {
  calculateActivityStatistics,
  generateSVG
} = require('../api/svg');

const data = {
  daily_usage: {
    '2026-06-12': { total_tokens: 100 }
  },
  per_tool_summary: {
    codex: 100
  },
  statistics: {
    total_tokens: 100,
    peak_tokens: 100
  }
};
const cloudActivity = {
  '2026-03-20': 25
};

const statistics = calculateActivityStatistics(data, cloudActivity);
assert.equal(statistics.totalDaysActive, 2);

const svg = generateSVG(data, 365, cloudActivity);
assert.match(svg, /2026-03-20: Codex cloud usage 25%/);
assert.match(svg, /Total: <tspan fill="#e6edf3">100<\/tspan> tokens/);
assert.match(svg, /: no activity<\/title>/);

console.log('API SVG tests passed');
