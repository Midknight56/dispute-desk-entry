import type { Dispute } from '../format';

const records = [
  ['payment', 'capture'],
  ['order', 'order'],
  ['tracking', 'tracking'],
] as const;

export function readiness(row: Dispute): { held: string[]; missing: string[]; filled: boolean[] } {
  const held = records.filter(([, kind]) => row.kinds?.includes(kind)).map(([name]) => name);
  const missing = records.filter(([, kind]) => !row.kinds?.includes(kind)).map(([name]) => name);
  const filed = Boolean(row.filed_at);
  return {
    held,
    missing: [...missing, ...(!filed ? ['response'] : [])],
    filled: [...records.map(([, kind]) => row.kinds?.includes(kind) ?? false), filed],
  };
}
