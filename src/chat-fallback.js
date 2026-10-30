// Only explicit provider quota/balance rejection can switch a chat model.
// Network errors and rate limits must not be mistaken for used-up trial credit.
export function confirmedChatQuotaFailure(message, provider) {
  const text = String(message ?? '');
  if (/AllocationQuota\.FreeTierOnly/.test(text)) return true;
  if (/QuotaExceeded/.test(text) && /free (?:trial )?quota.{0,40}exhausted|exhausted.{0,40}free (?:trial )?quota|免费.{0,12}额度.{0,12}(耗尽|用完)/i.test(text)) return true;
  return provider === 'baishan' && /InsufficientBalance|insufficient (?:account )?balance|余额不足/i.test(text);
}

export function nextFreeChatModel(queue, exhausted, current) {
  const entries = Array.isArray(queue) ? queue : [];
  const index = entries.findIndex(e => e?.route === current?.provider && e?.model === current?.model);
  if (index < 0) return null;
  // The administrator's order is stable; never jump backwards into a paid or
  // already exhausted model merely because another conversation failed later.
  return entries.slice(Math.max(0, index)).find(e => e?.capability === 'chat' && e.enabled === true
    && e.freeEligible === true && typeof e.route === 'string' && e.route && e.provider && e.model
    && !exhausted[`${e.provider}/${e.model}`]
    && (!e.freeExpiresAt || Date.parse(e.freeExpiresAt) > Date.now())) ?? null;
}
