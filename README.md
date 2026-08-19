# ehm-load-test

Load-testing and InfluxDB seeding tools for EHM/ECP container metrics. Kept
out of `ehm-api` deliberately — nothing here runs as part of the product, so
it doesn't belong in the app's dependency tree, build, or deploy path.

Full docs: see `eh-documentation` (Knowledge Base > Development > Load
Testing Tools).

## Contents

- **`simulate-container-load.sh`** — drives real CPU/memory/network load
  into a live ECP account container via `docker exec` + `stress-ng`, so the
  real metrics-collection pipeline (Docker stats -> InfluxDB -> EHM UI
  charts) and `resource-monitor` alert thresholds get exercised end to end
  with genuine data.
- **`seed-influx-monthly-metrics.js`** — backfills synthetic historical
  `container_stats` points directly into InfluxDB (bypassing Docker
  entirely) to test month-long views and quota behavior that would
  otherwise take a real month to observe.

## Setup

```bash
npm install
cp .env.sample .env   # fill in INFLUXDB_TOKEN from ehm-api's .env
```

## Usage

```bash
./simulate-container-load.sh <container_name> --cpu 85 --mem 512M --duration 300

node seed-influx-monthly-metrics.js --dry-run
node seed-influx-monthly-metrics.js
```

See each script's `--help` for full options.

## Important: don't run either tool while ehm-api's metrics cron is active

InfluxDB's file-backed WAL cannot tolerate two concurrent writers — a
second writer crashes it. Both tools write to the same `container_stats`
measurement that ehm-api's `DockerMetricsService` cron writes to every 30s.
Stop `ehm-api` (or set `INFLUX_METRICS_ENABLED=false` and restart it)
before running either tool.

## Don't point `simulate-container-load.sh` at a real customer's container

It installs `stress-ng` via `apt-get` inside the target container and pins
its CPU/memory for the run. Use a disposable/test account only.
