export type WidgetLoadState = 'loading' | 'ready' | 'empty' | 'error' | 'stale';
export function widgetLoadResult<T>(previous: T | null, next: T | null, failed: boolean) {
  if (failed) return previous === null ? { data: null, state: 'error' as const } : { data: previous, state: 'stale' as const };
  return next === null ? { data: null, state: 'empty' as const } : { data: next, state: 'ready' as const };
}
