export function toJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

export function safeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ value: String(value) });
  }
}
