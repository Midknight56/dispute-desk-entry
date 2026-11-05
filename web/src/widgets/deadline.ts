export function windowLeft(
  created: string,
  due: string | null,
  now: number | string | Date,
): { share: number; days: number } | null {
  if (!due) return null;
  const start = Date.parse(created);
  const end = Date.parse(due);
  const current = typeof now === 'number' ? now : now instanceof Date ? now.getTime() : Date.parse(now);
  if (![start, end, current].every(Number.isFinite)) return { share: 0, days: 0 };
  const duration = end - start;
  const share = duration > 0 ? Math.max(0, Math.min(1, (end - current) / duration)) : 0;
  return { share, days: Math.max(0, Math.floor(Math.ceil((end - current) / 3600000) / 24)) };
}
