// The timed sync. PayPal retries a webhook, but a lost one would leave the desk with an old status. Every 15 minutes
// the Worker compares PayPal's dispute list with its own copy and reads again only what is new or changed.

export interface ListItem {
  dispute_id: string;
  status?: string;
  update_time?: string;
}

export interface Stored {
  status?: string | null;
  updated?: string | null; // when the desk last stored the dispute
}

export function needsSync(item: ListItem, stored: Stored | undefined): boolean {
  if (!stored) return true;
  if ((item.status ?? null) !== (stored.status ?? null)) return true;
  const changed = Date.parse(item.update_time ?? "");
  const saved = Date.parse(stored.updated ?? "");
  return Number.isFinite(changed) && Number.isFinite(saved) && changed > saved;
}
