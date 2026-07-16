#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  dateKeyInTimeZone,
  generateSVG,
  normalizeTimeZone
} = require('../api/svg');

function parseArgs(argv) {
  const options = {
    data: 'data/ai-usage.json',
    cloud: 'data/codex-cloud-activity.json',
    output: 'assets/ai-blue-wall.svg',
    days: 365,
    timeZone: process.env.TIME_ZONE || 'Asia/Shanghai',
    referenceDate: undefined,
    check: false
  };

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--check') {
      options.check = true;
      continue;
    }
    const key = {
      '--data': 'data',
      '--cloud': 'cloud',
      '--output': 'output',
      '--days': 'days',
      '--timezone': 'timeZone',
      '--reference-date': 'referenceDate'
    }[argument];
    if (!key || index + 1 >= argv.length) {
      throw new Error('Unknown or incomplete argument: ' + argument);
    }
    options[key] = argv[++index];
  }

  options.days = Number.parseInt(options.days, 10);
  if (!Number.isInteger(options.days) || options.days < 7 || options.days > 365) {
    throw new Error('--days must be an integer from 7 to 365');
  }
  return options;
}

function loadJSON(filePath, fallback = {}) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const data = loadJSON(options.data);
  const cloud = loadJSON(options.cloud, { daily_usage_percent: {} });
  const timeZone = normalizeTimeZone(options.timeZone);
  let referenceDate = options.referenceDate;
  if (!referenceDate && data.generated_at) {
    const generatedAt = new Date(data.generated_at);
    if (!Number.isNaN(generatedAt.getTime())) {
      referenceDate = dateKeyInTimeZone(generatedAt, timeZone);
    }
  }
  const svg = generateSVG(data, options.days, cloud.daily_usage_percent || {}, {
    timeZone,
    referenceDate,
    cloudData: cloud
  });
  const generated = svg + '\n';

  if (options.check) {
    const existing = fs.existsSync(options.output)
      ? fs.readFileSync(options.output, 'utf8')
      : '';
    if (existing !== generated) {
      throw new Error(options.output + ' is stale; run npm run render');
    }
    console.log('Verified generated SVG: ' + options.output);
    return;
  }

  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, generated, 'utf8');
  console.log('Saved SVG to: ' + options.output);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
