#!/usr/bin/env bash
#
# Generate real CPU, memory, and network load inside an ECP account container
# so the InfluxDB metrics pipeline (ehm-api's docker-metrics module ->
# container_stats -> the Resource Monitor / Dashboard charts in EHM UI) has
# genuine data to show, and so resource-monitor alert thresholds can be
# validated end to end.
#
# Requires: the `docker` CLI and `curl` on this host, and the target
# container running (its own container image needs curl/wget + apt, true
# for the default ecp-base image).
#
# Do NOT run this against a real customer's container — it installs
# stress-ng via apt inside it. Use a disposable/test account.
#
# Usage:
#   ./simulate-container-load.sh <container_name> [options]
#
# Options:
#   -c, --cpu PERCENT       Target CPU load percentage (default: 50)
#   -m, --mem SIZE          Memory to allocate, e.g. 512M, 1G (default: 256M)
#   -n, --net-workers N     Parallel curl workers hitting the container's own
#                           web server to generate egress load (default: 4,
#                           use 0 to disable network load)
#   -d, --duration SECONDS  How long to sustain the load (default: 60)
#   -h, --help              Show this help

set -euo pipefail

CPU_PERCENT=50
MEM_SIZE="256M"
NET_WORKERS=4
DURATION=60
CONTAINER=""

usage() {
  sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    -c|--cpu) CPU_PERCENT="$2"; shift 2 ;;
    -m|--mem) MEM_SIZE="$2"; shift 2 ;;
    -n|--net-workers) NET_WORKERS="$2"; shift 2 ;;
    -d|--duration) DURATION="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      if [ -n "$CONTAINER" ]; then
        echo "Unexpected argument: $1" >&2
        exit 1
      fi
      CONTAINER="$1"
      shift
      ;;
  esac
done

if [ -z "$CONTAINER" ]; then
  echo "Error: container name is required." >&2
  usage
  exit 1
fi

if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
  echo "Error: container '$CONTAINER' is not running (or doesn't exist)." >&2
  exit 1
fi

CONTAINER_IP=$(docker inspect \
  -f '{{ range .NetworkSettings.Networks }}{{ .IPAddress }}{{ end }}' \
  "$CONTAINER")
if [ -z "$CONTAINER_IP" ]; then
  echo "Error: could not determine an IP address for '$CONTAINER'." >&2
  exit 1
fi

CPU_CORES=$(docker exec "$CONTAINER" nproc)

echo "Target container : $CONTAINER ($CONTAINER_IP)"
echo "CPU load         : ${CPU_PERCENT}% across ${CPU_CORES} core(s)"
echo "Memory allocated  : $MEM_SIZE"
echo "Network workers   : $NET_WORKERS"
echo "Duration          : ${DURATION}s"
echo

if ! docker exec "$CONTAINER" sh -c 'command -v stress-ng >/dev/null 2>&1'; then
  echo "Installing stress-ng inside $CONTAINER..."
  docker exec "$CONTAINER" sh -c 'apt-get update -qq && apt-get install -y -qq stress-ng' \
    >/dev/null
fi

echo "Starting CPU + memory stress (stress-ng, detached, self-terminating)..."
docker exec -d "$CONTAINER" stress-ng \
  --cpu "$CPU_CORES" --cpu-load "$CPU_PERCENT" \
  --vm 1 --vm-bytes "$MEM_SIZE" --vm-keep \
  --timeout "${DURATION}s"

net_load_worker() {
  local end=$(( $(date +%s) + DURATION ))
  while [ "$(date +%s)" -lt "$end" ]; do
    curl -s -o /dev/null --max-time 5 "http://${CONTAINER_IP}/" || true
  done
}

if [ "$NET_WORKERS" -gt 0 ]; then
  echo "Starting $NET_WORKERS network workers against http://${CONTAINER_IP}/..."
  pids=()
  for _ in $(seq 1 "$NET_WORKERS"); do
    net_load_worker &
    pids+=("$!")
  done
  trap 'kill "${pids[@]}" 2>/dev/null || true' INT TERM
  wait "${pids[@]}"
else
  sleep "$DURATION"
fi

echo
echo "Done. Check the Resource Monitor > Metrics page, the Dashboard, or the" \
     "account's Resource History card in the EHM UI (metrics land in" \
     "InfluxDB on the next ~30s collection tick)."
