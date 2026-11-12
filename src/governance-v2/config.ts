export function positiveInteger(
  value: string | undefined,
  fallback: number,
  max = 100_000,
) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max)
    return fallback;
  return parsed;
}
