// 登录陆协是可变的独立事实。日期是资料对应赛事日（日本时间），绝非导入时间。
const prefectures = "北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県".split(" ");
const labels = new Map(prefectures.flatMap(full => {
  const short = full === "北海道" ? full : full.slice(0, -1);
  return [[full, short], [short, short]];
}));
labels.set("学連", "学連");

/** 只转换已知陆协；未知标签交给 unresolved，禁止泛用删尾或推断出身地。 */
export function canonicalAssociation(value: string): string | undefined {
  return labels.get(value.normalize("NFKC").trim());
}
export function validAssociationDate(value?: string): value is string {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function japanRaceDate(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  return new Date(date.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}
export type AssociationEvidence = { value: string; asOf: string; sourceId?: string };
export function associationAsOf(value: string, evidence: AssociationEvidence[] = []): string | undefined {
  return evidence.filter(e => canonicalAssociation(e.value) === canonicalAssociation(value) && validAssociationDate(e.asOf))
    .map(e => e.asOf).sort().at(-1);
}
export function decideAssociation(old: string | null | undefined, value: string, asOf: string | undefined,
  evidence: AssociationEvidence[], reliability: number): { action: "write" | "keep" | "unresolved"; reason: string } {
  if (!canonicalAssociation(value) || (old && !canonicalAssociation(old)))
    return { action: "unresolved", reason: "登录陆协标签不在支持列表中，不能猜测转换。" };
  if (reliability < 3) return { action: "unresolved", reason: "登录陆协来源可靠度不足 3。" };
  if (!validAssociationDate(asOf)) return { action: "unresolved", reason: "登录陆协缺少有效资料日期，不能使用导入时间。" };
  if (!old) return { action: "write", reason: "可靠来源补空登录陆协并记录资料日期" };
  const oldDate = associationAsOf(old, evidence);
  const same = canonicalAssociation(old) === canonicalAssociation(value);
  if (oldDate && asOf < oldDate) return { action: "keep", reason: "旧资料不覆盖较新登录陆协" };
  if (same) return old !== value || !oldDate || asOf > oldDate
    ? { action: "write", reason: "统一登录陆协格式并更新同值的较新资料日期" }
    : { action: "keep", reason: "登录陆协与资料日期相同" };
  if (!oldDate) return { action: "unresolved", reason: "既有登录陆协缺少资料日期，不能判定不同值的新旧。" };
  if (asOf === oldDate) return { action: "unresolved", reason: "同一资料日期出现不同登录陆协。" };
  return { action: "write", reason: "较新资料更新登录陆协；与出身地无关" };
}
