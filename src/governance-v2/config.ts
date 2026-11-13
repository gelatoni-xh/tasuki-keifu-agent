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

// Missing pricing is unknown, distinct from an explicitly configured free rate.
export function nonNegative(value: string | undefined): number | undefined {
  if (value === undefined || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
