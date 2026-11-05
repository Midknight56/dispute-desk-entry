import type { Dispute } from './format';

export type JudgeRow = Dispute & { kind?: 'fight' | 'accept' | 'ship'; replay?: boolean };

export function sortRows(rows: JudgeRow[], mine: Set<string>): JudgeRow[] {
  return [...rows].sort((left, right) => {
    const owned = Number(mine.has(right.id)) - Number(mine.has(left.id));
    if (owned) return owned;
    const replay = Number(Boolean(right.replay)) - Number(Boolean(left.replay));
    if (replay) return replay;
    const status = Number(left.status === 'RESOLVED') - Number(right.status === 'RESOLVED');
    return status;
  });
}

export function selectedFirst<T extends Dispute>(rows: T[], tab: CaseTab, selected: string | null): T[] {
  if (!selected || tab === 'all') return rows;
  const index = rows.findIndex((row) => row.id === selected);
  if (index < 0 || tabOf(rows[index].status) === tab) return rows;
  return [rows[index], ...rows.slice(0, index), ...rows.slice(index + 1)];
}

export function firstSelection(rows: JudgeRow[], mine: Set<string>): string | null {
  for (const kind of ['fight', 'accept'] as const) {
    const row = rows.find((item) => mine.has(item.id) && item.kind === kind);
    if (row) return row.id;
  }
  return rows.find((item) => item.replay)?.id ?? rows.find((item) => item.status !== 'RESOLVED')?.id ?? null;
}

export function showsApprove(row: JudgeRow | undefined, mine: Set<string>, ownerKey: string | null): boolean {
  return Boolean(row && !row.replay && (mine.has(row.id) || ownerKey));
}

export type CaseTab = 'move' | 'waiting' | 'settled' | 'all';

export function tabOf(status: string): Exclude<CaseTab, 'all'> {
  return status === 'WAITING_FOR_SELLER_RESPONSE' ? 'move' : status === 'RESOLVED' ? 'settled' : 'waiting';
}

export function tabCounts(rows: Dispute[]): Record<CaseTab, number> {
  const counts = { move: 0, waiting: 0, settled: 0, all: rows.length };
  for (const row of rows) counts[tabOf(row.status)]++;
  return counts;
}

export function defaultTab(rows: Dispute[]): CaseTab {
  return rows.some((row) => tabOf(row.status) === 'move') ? 'move' : 'all';
}

export function rowsForTab<T extends Dispute>(
  rows: T[],
  tab: CaseTab,
  mine: Set<string>,
  selected: string | null,
): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.id) || !(tab === 'all' || tabOf(row.status) === tab || mine.has(row.id) || row.id === selected))
      return false;
    seen.add(row.id);
    return true;
  });
}

export function pageOfRow(index: number, pageSize: number): number {
  return Math.floor(index / pageSize);
}
