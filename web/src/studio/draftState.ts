import type { CheckedDraft } from './draftWidget';

export type DraftLoadState = 'loading' | 'empty' | 'error' | 'ready' | 'stale';

export function draftRefreshResult(
  previous: CheckedDraft | null,
  next: CheckedDraft | null,
  failed: boolean,
): { draft: CheckedDraft | null; state: DraftLoadState } {
  if (failed) return previous ? { draft: previous, state: 'stale' } : { draft: null, state: 'error' };
  return next ? { draft: next, state: 'ready' } : { draft: null, state: 'empty' };
}

export function draftLoadState(draft: CheckedDraft | null, loaded: boolean, failed: boolean, stale = false): DraftLoadState {
  if (draft) return stale ? 'stale' : 'ready';
  if (failed) return 'error';
  return loaded ? 'empty' : 'loading';
}
