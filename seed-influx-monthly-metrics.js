// seed-influx-monthly-metrics.js
//
// Backfills a month (or any range) of synthetic `container_stats` points
// into InfluxDB so monthly-quota behavior (the 30-day chart range in EHM
// UI, and any bandwidth/quota logic built on top of it) can be exercised
// without waiting a real month or running real load that long.
//
// By default it seeds three preset containers that each land in a
// different quota state at month end — under, right at, and well past a
// simulated quota — so under/near/over-quota UI and alerting can all be
// tested in one run. Pass --container to seed a single custom one instead.
//
// cpu/memory get a diurnal (day/night) pattern with noise; net_in/net_out
// are monotonically increasing counters (matching how real Docker rx/tx
// stats behave) paced to approach a target quota by a target day.
//
// IMPORTANT: InfluxDB's file-backed WAL cannot tolerate two concurrent
// writers (see ehm-api's docker-metrics.service.ts). Don't run this while
// ehm-api's own metrics-collection cron is active — stop the app or set
// INFLUX_METRICS_ENABLED=false first.
//
// Usage:
//   node seed-influx-monthly-metrics.js [options]
//
// Options:
//   --container NAME     Seed only this container (skips the 3 presets)
//   --quota-bytes SIZE   Quota target for --container mode, e.g. 50GB (default: 50GB)
//   --breach-day N       Day of month the quota is reached, for --container
//                        mode (default: equal to --days, i.e. never breaches)
//   --days N             Days of history to backfill (default: 30)
//   --interval MINUTES   Sample spacing in minutes (default: 5)
//   --dry-run            Print the plan without writing to InfluxDB
//   --help                Show this help

require('dotenv').config();
const { InfluxDBClient, Point } = require('@influxdata/influxdb3-client');

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 2000;

function usage() {
  const lines = require('fs').readFileSync(__filename, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith('// Usage:'));
  const end = lines.findIndex((l, i) => i > start && !l.startsWith('//'));
  console.log(
    lines
      .slice(start, end)
      .map((l) => l.replace(/^\/\/ ?/, ''))
      .join('\n'),
  );
}

function parseSize(value) {
  const match = /^(\d+(?:\.\d+)?)\s*(K|M|G|T)?B?$/i.exec(String(value).trim());
  if (!match) throw new Error(`Invalid size: ${value}`);
  const n = parseFloat(match[1]);
  const unit = (match[2] || '').toUpperCase();
  const multiplier = { '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[unit];
  return Math.round(n * multiplier);
}

function parseArgs(argv) {
  const args = { days: 30, interval: 5, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--container':
        args.container = argv[++i];
        break;
      case '--quota-bytes':
        args.quotaBytes = parseSize(argv[++i]);
        break;
      case '--breach-day':
        args.breachDay = parseInt(argv[++i], 10);
        break;
      case '--days':
        args.days = parseInt(argv[++i], 10);
        break;
      case '--interval':
        args.interval = parseInt(argv[++i], 10);
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--help':
        usage();
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${argv[i]}`);
        usage();
        process.exit(1);
    }
  }
  return args;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

// Builds one container's worth of points. Network counters are paced so
// cumulative usage crosses `quotaBytes` on `breachDay` (if reachable within
// `days`), then keeps growing at the same daily pace afterward — so a
// breaching scenario stays visibly over quota for the rest of the window
// instead of flatlining right at the line.
function buildContainerPoints(name, { days, intervalMinutes, quotaBytes, breachDay }) {
  const samplesPerDay = Math.floor((24 * 60) / intervalMinutes);
  const totalSamples = days * samplesPerDay;
  const dailyBudget = quotaBytes / breachDay;
  const perSampleBudget = dailyBudget / samplesPerDay;

  const now = Date.now();
  const start = now - days * DAY_MS;

  let cumulativeIn = 0;
  let cumulativeOut = 0;
  const points = [];

  for (let i = 0; i < totalSamples; i++) {
    const time = new Date(start + i * intervalMinutes * 60 * 1000);
    const hourOfDay = time.getHours() + time.getMinutes() / 60;

    const cpu = clamp(20 + 15 * Math.sin(((hourOfDay - 8) / 24) * 2 * Math.PI) + rand(-5, 5), 0, 100);
    const memory = clamp(35 + 10 * Math.sin(((hourOfDay - 10) / 24) * 2 * Math.PI) + rand(-4, 4), 0, 100);

    // Hosting traffic is egress-heavy — most bytes are the site being
    // served out, not requests coming in.
    const delta = perSampleBudget * rand(0.4, 1.6);
    cumulativeOut += delta * 0.65;
    cumulativeIn += delta * 0.35;

    points.push(
      Point.measurement('container_stats')
        .setTag('container_id', name)
        .setTag('container_name', name)
        .setFloatField('cpu', cpu)
        .setFloatField('memory', memory)
        .setIntegerField('net_in', Math.round(cumulativeIn))
        .setIntegerField('net_out', Math.round(cumulativeOut))
        .setTimestamp(time),
    );
  }

  return { points, finalBytes: cumulativeIn + cumulativeOut };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const scenarios = args.container
    ? [
        {
          name: args.container,
          quotaBytes: args.quotaBytes ?? parseSize('50GB'),
          breachDay: args.breachDay ?? args.days,
        },
      ]
    : [
        { name: 'quotatest-normal_container', quotaBytes: parseSize('50GB'), breachDay: args.days },
        { name: 'quotatest-heavy_container', quotaBytes: parseSize('50GB'), breachDay: Math.max(1, Math.round(args.days * 0.7)) },
        { name: 'quotatest-critical_container', quotaBytes: parseSize('20GB'), breachDay: Math.max(1, Math.round(args.days * 0.15)) },
      ];

  console.log(`Backfilling ${args.days} day(s) at ${args.interval}-minute intervals for:`);
  for (const s of scenarios) {
    console.log(
      `  - ${s.name}: quota ${(s.quotaBytes / 1e9).toFixed(1)}GB, reached on day ${s.breachDay}` +
        (s.breachDay < args.days ? ' (breaches, stays over for the rest of the window)' : ' (never breaches)'),
    );
  }
  console.log();

  if (args.dryRun) {
    console.log('Dry run — nothing written.');
    return;
  }

  const client = new InfluxDBClient({
    host: process.env.INFLUXDB_HOST,
    token: process.env.INFLUXDB_TOKEN,
    database: process.env.INFLUXDB_DATABASE,
  });

  try {
    for (const scenario of scenarios) {
      const { points, finalBytes } = buildContainerPoints(scenario.name, {
        days: args.days,
        intervalMinutes: args.interval,
        quotaBytes: scenario.quotaBytes,
        breachDay: scenario.breachDay,
      });

      for (let i = 0; i < points.length; i += BATCH_SIZE) {
        const batch = points.slice(i, i + BATCH_SIZE);
        await client.write(batch);
        process.stdout.write(
          `\r${scenario.name}: wrote ${Math.min(i + BATCH_SIZE, points.length)}/${points.length} points`,
        );
      }
      console.log(
        `\n${scenario.name}: final cumulative usage ~${(finalBytes / 1e9).toFixed(2)}GB` +
          ` (${((finalBytes / scenario.quotaBytes) * 100).toFixed(0)}% of quota)`,
      );
    }
  } finally {
    await client.close();
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
