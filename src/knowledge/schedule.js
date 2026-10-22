'use strict';
// The nightly drift run.
//
// A timer inside the web process is a compromise: it only fires while the process is up, and a restart after a missed
// window waits for the next one. It is here because it makes the loop demonstrable without inventing a scheduler; a
// deployment with cron should call GET /knowledge/drift instead and leave this off.

/** Milliseconds from `now` until the next occurrence of hour:minute, in local time. */
function delayUntil(now, hour = 2, minute = 0) {
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/**
 * Start the nightly run. Returns a function that stops it.
 *
 * @param {{run: () => Promise<any>, hour?: number, minute?: number, onError?: (err: Error) => void}} options
 */
function startNightlyDrift({ run, hour = 2, minute = 0, onError = () => {} }) {
  let timer = null;
  let stopped = false;

  const arm = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      try { await run(); } catch (err) { onError(err); }
      arm();
    }, delayUntil(new Date(), hour, minute));
    if (timer.unref) timer.unref();
  };

  arm();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

module.exports = { startNightlyDrift, delayUntil };
