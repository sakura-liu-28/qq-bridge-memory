const PROBABILITY_STEP = 0.2;

export function isProactiveAccount(key, account) {
  const qq = String(account ?? '').trim();
  return /^[1-9]\d*$/.test(qq) && key === `private:${qq}`;
}

export function normalizeProactiveMisses(value) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.min(5, Math.max(0, Math.floor(count))) : 0;
}

// Only eligible probability misses advance the streak. Successful delivery is
// acknowledged by the bridge, after DSH accepts the wake, rather than here.
export function checkProactiveOpportunity({
  probability, misses = 0, eligible = true, pendingThoughts = 0,
  recentReply = false, frequentReplies = false,
  random = Math.random,
}) {
  const count = normalizeProactiveMisses(misses);
  const configured = Number(probability);
  const base = Math.min(1, Math.max(0, Number.isFinite(configured) ? configured : 0.4));
  let effective = base === 0 ? 0 : Math.min(1, base + count * PROBABILITY_STEP);
  const increased = effective;
  if (pendingThoughts > 0) effective = Math.min(1, effective * 1.4);
  if (recentReply) effective *= 0.5;
  if (frequentReplies) effective *= 0.3;
  const attempted = eligible && effective > 0;
  const triggered = attempted && random() < effective;
  return {
    attempted, triggered, probability: effective, baseProbability: increased,
    misses: attempted && !triggered
      ? Math.min(Math.ceil((1 - base) / PROBABILITY_STEP), count + 1)
      : count,
  };
}

// Sleep is a separate quiet window, evaluated in the configured timezone.
// Skipping it must neither draw a probability nor change the miss streak.
export function isProactiveSleepTime(now = new Date(), sleep = {}) {
  if (sleep?.enabled === false) return false;
  const minutes = (value, fallback) => {
    const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? fallback));
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return minutes(fallback, fallback);
    return Number(match[1]) * 60 + Number(match[2]);
  };
  const start = minutes(sleep?.start, '23:00');
  const end = minutes(sleep?.end, '08:00');
  if (start === end) return false;
  let parts;
  const options = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  try {
    parts = new Intl.DateTimeFormat('en-GB', { ...options, timeZone: sleep?.timeZone || 'Asia/Shanghai' }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'Asia/Shanghai' }).formatToParts(now);
  }
  const clock = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const current = Number(clock.hour) * 60 + Number(clock.minute);
  return start > end ? current >= start || current < end : current >= start && current < end;
}
