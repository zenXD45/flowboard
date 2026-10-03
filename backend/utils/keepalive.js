/**
 * Render's free web services spin down after ~15 minutes without inbound
 * traffic and only wake when a request arrives from outside. A board with
 * someone watching it is already held open by the Socket.io ping, but a
 * deployment nobody has visited still goes to sleep — and the first person
 * back pays a 30-60 second cold start while Render boots the instance.
 *
 * So in production the server pings its own health endpoint on a timer. Three
 * details make that safe:
 *
 *   1. It targets 127.0.0.1, not the public hostname — no DNS lookup, no TLS
 *      handshake, and it keeps working if the public URL ever changes.
 *   2. It re-arms with setTimeout rather than setInterval, so a slow response
 *      can never stack requests up behind each other.
 *   3. The timer is unref'd, so it never holds the process open on shutdown or
 *      during `node --test`.
 *
 * A failed ping is logged only when the outcome *changes*, because otherwise a
 * ten-minute timer turns a long outage into thousands of identical log lines.
 */

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Render sleeps after 15 minutes, so anything above ~10 minutes is pointless
 * and anything below a minute is a self-inflicted denial of service. Clamping
 * protects against a typo in SELF_PING_INTERVAL_MS turning into a hot loop.
 */
const MIN_INTERVAL_MS = 60 * 1000;

const DEFAULT_TIMEOUT_MS = 5000;

export function startKeepAlive({
  port,
  path = '/health',
  intervalMs = DEFAULT_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  log = console.log
}) {
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('startKeepAlive requires a valid port');
  }

  const every = Math.max(MIN_INTERVAL_MS, Number(intervalMs) || DEFAULT_INTERVAL_MS);
  const url = `http://127.0.0.1:${port}${path}`;

  let timer = null;
  let stopped = false;
  let lastOutcome = null;

  const arm = () => {
    if (stopped) return;
    timer = setTimeout(ping, every);
    timer.unref?.();
  };

  async function ping() {
    if (stopped) return;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`responded ${res.status}`);
      if (lastOutcome !== 'ok') log(`[keepalive] ${url} responding`);
      lastOutcome = 'ok';
    } catch (err) {
      if (lastOutcome !== 'fail') log(`[keepalive] ${url} unreachable — ${err.message}`);
      lastOutcome = 'fail';
    } finally {
      arm();
    }
  }

  log(`[keepalive] pinging ${url} every ${Math.round(every / 60000)} min`);

  const handle = {
    url,
    intervalMs: every,
    ping,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };

  arm();
  return handle;
}
