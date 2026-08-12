export function normalizeJapaneseText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .trim();
}

export function normalizeSearchKey(value: string) {
  return normalizeJapaneseText(value).toLowerCase();
}

export function normalizeJaMediumKey(value: string) {
  return normalizeJapaneseText(value)
    .replace(/ー/g, "")
    .toLowerCase();
}

export function toKatakana(value: string) {
  return value.replace(/[\u3041-\u3096]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0x60));
}

export function normalizeKanaMediumKey(value: string) {
  return normalizeJapaneseText(toKatakana(value))
    .replace(/ー/g, "")
    .toLowerCase();
}

export function buildLowercaseJaVariants(value: string) {
  const normalized = normalizeJapaneseText(value);
  const variants = new Set<string>();

  if (normalized) {
    variants.add(normalized.toLowerCase());
    variants.add(normalized.replace(/ー/g, "").toLowerCase());
  }

  return [...variants];
}

export function buildLowercaseKanaVariants(value: string) {
  const normalized = normalizeJapaneseText(value);
  const variants = new Set<string>();

  if (normalized) {
    const kata = toKatakana(normalized);
    const hira = kata.replace(/[\u30a1-\u30f6]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60));

    for (const candidate of [normalized, kata, hira]) {
      variants.add(candidate.toLowerCase());
      variants.add(candidate.replace(/ー/g, "").toLowerCase());
    }
  }

  return [...variants];
}
