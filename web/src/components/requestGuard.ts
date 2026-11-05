export function beginRequest(current: boolean, setBusy: (value: boolean) => void): boolean {
  if (current) return false;
  setBusy(true);
  return true;
}
