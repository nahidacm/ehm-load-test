# Load Testing Tools (ehm-load-test)

Tools for generating real and synthetic container-metrics load, used to test
the InfluxDB metrics pipeline (`ehm-api`'s `docker-metrics` module) and the
charts it feeds in EHM UI (Dashboard, Account Detail > Resource History,
Resource Monitor > Metrics), plus `resource-monitor` alert thresholds.

Kept separate from `ehm-api`
deliberately. Nothing in it runs as part of the product, so it doesn't
belong in the app's dependency tree, build, or deploy path.

## Setup

```bash
cd /epiclabs23/eh/ehm-load-test
npm install
cp .env.sample .env
```

Fill `INFLUXDB_TOKEN` in `.env` with the same token EHM API uses (copy it
from `ehm-api/.env`). `INFLUXDB_HOST`/`INFLUXDB_DATABASE` should already
match the defaults.

> **Don't run either tool while ehm-api's metrics cron is active.**
InfluxDB's file-backed WAL cannot tolerate two concurrent writers — a
second writer crashes it. Both tools write to the same `container_stats`
measurement that `DockerMetricsService`'s cron writes to every 30s in
`ehm-api`. Stop `ehm-api`, or set `INFLUX_METRICS_ENABLED=false` and
restart it, before running either tool. See
[Install InfluxDB](https://docs.ecpanel.io/eh-services/install-influxdb) if you need to
recover from a crash-looping instance afterward.

## `simulate-container-load.sh` — real load against a live container

Drives real CPU, memory, and network consumption into a **live, running**
ECP account container, so the actual collection pipeline (Docker stats API
-> `collectAndPushStats` cron -> InfluxDB -> the charts) gets exercised end
to end with genuine data — not fabricated numbers.

```bash
./simulate-container-load.sh <container_name> --cpu 85 --mem 512M --net-workers 4 --duration 300
```

| Option | Meaning | Default |
| --- | --- | --- |
| `-c, --cpu PERCENT` | Target CPU load percentage | `50` |
| `-m, --mem SIZE` | Memory to allocate, e.g. `512M`, `1G` | `256M` |
| `-n, --net-workers N` | Parallel `curl` workers generating egress load (`0` disables) | `4` |
| `-d, --duration SECONDS` | How long to sustain the load | `60` |

How it works:

- Resolves the container's IP on its Docker network, installs `stress-ng`
  inside it via `apt-get` if it isn't already present.
- Runs `stress-ng --cpu-load <percent>` **inside** the container so you can
  drive it to an exact target percentage — useful for validating the
  `resource-monitor` module's notify -> throttle -> suspend thresholds at a
  specific value, not just "some load."
- Runs N parallel `curl` loops **from the host** against the container's
  own nginx to generate real egress (`net_out`) traffic, without touching
  any files inside the container.
- Everything self-terminates after `--duration` (`stress-ng`'s own
  `--timeout`, and the curl loops exit on their own); Ctrl-C also cleans up
  the curl workers.

> **Test accounts only.**
This installs a package into the target container and pins its CPU/memory
for the run. Never point it at a real customer's container — use a
disposable/test account.

## `seed-influx-monthly-metrics.js` — synthetic historical backfill

Backfills a month (or any range) of synthetic `container_stats` points
directly into InfluxDB, bypassing Docker entirely. Use this when you need
to see a **month-long view** (the 30-day chart range in EHM UI) or test
quota behavior that would otherwise take a real month to observe — running
real load for 30 days straight isn't practical.

```bash
node seed-influx-monthly-metrics.js --dry-run   # preview first
node seed-influx-monthly-metrics.js             # actually write
```

By default it seeds three preset containers that each land in a different
quota state at month end, so under/near/over-quota UI and alerting can all
be checked in one run:

| Container | Quota | Reaches quota | End state |
| --- | --- | --- | --- |
| `quotatest-normal_container` | 50GB | never | under quota all month |
| `quotatest-heavy_container` | 50GB | ~day 21 of 30 | over quota for the last third of the month |
| `quotatest-critical_container` | 20GB | ~day 5 of 30 | well over quota almost the whole month |

To seed one custom container instead of the three presets:

```bash
node seed-influx-monthly-metrics.js --container myacct_container --quota-bytes 10GB --breach-day 12
```

| Option | Meaning | Default |
| --- | --- | --- |
| `--container NAME` | Seed only this container (skips the 3 presets) | — |
| `--quota-bytes SIZE` | Quota target for `--container` mode, e.g. `50GB` | `50GB` |
| `--breach-day N` | Day of the month the quota is reached, for `--container` mode | equal to `--days` (never breaches) |
| `--days N` | Days of history to backfill | `30` |
| `--interval MINUTES` | Sample spacing in minutes | `5` |
| `--dry-run` | Print the plan without writing to InfluxDB | off |

Data shape:

- `cpu` / `memory` — a diurnal (day/night) sine wave plus noise, clamped to
  0–100%, so the chart isn't a flat line.
- `net_in` / `net_out` — monotonically increasing counters, matching how
  real Docker `rx_bytes`/`tx_bytes` behave (never reset or dip). Paced so
  cumulative usage crosses the target quota on the target day, then keeps
  growing afterward at the same pace — a breaching scenario stays visibly
  over quota for the rest of the window instead of flatlining right at the
  line. Traffic is weighted egress-heavy (65% out / 35% in), matching
  typical hosting traffic.
- Timestamps are explicitly backdated (`Point.setTimestamp()`), since this
  is a historical backfill rather than live collection.

Writes are batched (2,000 points per `client.write()` call) rather than one
write per point.
