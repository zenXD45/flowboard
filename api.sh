#!/usr/bin/env bash
# Dev helper: start / stop / restart the FlowBoard API without pkill -f,
# whose pattern also matches the shell that runs it.
set -uo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/backend" && pwd)"
PIDFILE="/tmp/opencode/flowboard-api.pid"
LOGFILE="/tmp/opencode/flowboard-api.log"
PORT="${PORT:-5002}"

stop() {
  if [[ -f "$PIDFILE" ]]; then
    local pid
    pid="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null
      for _ in $(seq 1 20); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.2
      done
    fi
    rm -f "$PIDFILE"
  fi
}

start() {
  cd "$BACKEND_DIR" || exit 1
  setsid nohup node server.js > "$LOGFILE" 2>&1 < /dev/null &
  echo $! > "$PIDFILE"
  for _ in $(seq 1 40); do
    if curl -fsS -m 2 "http://localhost:${PORT}/health" > /dev/null 2>&1; then
      echo "api up on :${PORT}  (pid $(cat "$PIDFILE"))"
      return 0
    fi
    sleep 0.25
  done
  echo "api failed to become healthy; last log lines:"
  tail -20 "$LOGFILE"
  return 1
}

case "${1:-restart}" in
  start)   start ;;
  stop)    stop; echo "stopped" ;;
  restart) stop; start ;;
  log)     tail -n "${2:-40}" "$LOGFILE" ;;
  *)       echo "usage: $0 {start|stop|restart|log [n]}" ; exit 1 ;;
esac
