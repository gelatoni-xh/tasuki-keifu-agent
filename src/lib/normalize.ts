export function normalizeJapaneseText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .trim();
}

export function normalizeSearchKey(value: string) {
  return normalizeJapaneseText(value).toLowerCase();
}
