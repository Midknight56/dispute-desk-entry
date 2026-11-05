export function errorMessage(e: unknown): string {
  const failure = e && typeof e === 'object' ? (e as { status?: unknown; body?: unknown }) : null;
  if (e instanceof TypeError || !failure || failure.status == null) return 'Offline, retrying';

  const body = failure.body && typeof failure.body === 'object' ? (failure.body as { error?: unknown }) : null;
  const message = typeof body?.error === 'string' ? body.error.trim().slice(0, 120) : '';
  if (message) return message;
  if ([502, 503, 504].includes(Number(failure.status))) return 'PayPal did not answer. Try again.';
  return 'Something went wrong. Try again.';
}

export function firstLoadFinished(loaded: boolean): boolean {
  return loaded;
}
