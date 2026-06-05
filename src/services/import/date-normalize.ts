/**
 * 外部移行インポート — 日付の正規化 (ADR-0034 §5)
 *
 * たすきば所定フォーマットは 'YYYY-MM-DD' (全 zod validator が `^\d{4}-\d{2}-\d{2}$` で統一)。
 * 崩れた入力をシステム側で 'YYYY-MM-DD' に正規化する。変換不能なら null を返す
 * (呼び出し側: 必須日付 → 既定値 or エラー / 任意日付 → 空)。
 *
 * 受理する形式 (いずれも年が先頭4桁):
 *   - 2026-06-04 / 2026/6/4 / 2026.6.4 / 2026 6 4 (区切りは - / . 空白)
 *   - 2026年6月4日 / 2026 年 6 月 4 日
 *   - 2026-06-04T10:20:00Z (ISO 日時 → 日付部のみ。Backlog/kintone/Pleasanter 由来)
 *   - 20260604 (8桁)
 *
 * 受理しない (曖昧なため null):
 *   - 3/1/2016 (月/日/年) や 1/3/2016 — 日本語製品で月日の順が確定できないため変換しない。
 *     ユーザは「既定値」設定で補うか元データを直す (ADR-0034 のマッピング3択)。
 *
 * 注: 実在しない日付 (2026-13-01, 2026-02-30 等) は null。
 */

/** 年月日から 'YYYY-MM-DD' を組み立てる。実在しない日付は null。 */
function buildDate(year: number, month: number, day: number): string | null {
  if (
    !Number.isInteger(year)
    || !Number.isInteger(month)
    || !Number.isInteger(day)
    || month < 1
    || month > 12
    || day < 1
    || day > 31
  ) {
    return null;
  }
  // 実在日チェック (2/30 等を弾く)。UTC で構築してロールオーバーを検知。
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year
    || dt.getUTCMonth() !== month - 1
    || dt.getUTCDate() !== day
  ) {
    return null;
  }
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/**
 * 任意の日付入力を 'YYYY-MM-DD' へ正規化する。変換不能なら null。
 */
export function normalizeDate(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;

  // ISO 日時 (先頭が日付部) → 日付部のみ採用
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})[T\s]/);
  if (iso) return buildDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // 和暦表記でない「YYYY年M月D日」
  const jp = s.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?\s*$/);
  if (jp) return buildDate(Number(jp[1]), Number(jp[2]), Number(jp[3]));

  // YYYY[区切り]M[区切り]D (区切り = - / . 空白、1つ以上)
  const ymd = s.match(/^(\d{4})[-/.\s]+(\d{1,2})[-/.\s]+(\d{1,2})$/);
  if (ymd) return buildDate(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));

  // 8桁連結 YYYYMMDD
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return buildDate(Number(compact[1]), Number(compact[2]), Number(compact[3]));

  return null;
}

/**
 * 入力が既に所定フォーマットだったか (正規化で変換が発生したか) を判定するヘルパ。
 * プレビューで「日付を YYYY-MM-DD に変換しました」と注意書きを出す用途。
 * @returns { normalized, converted } converted=true なら元の表記から変換された
 */
export function normalizeDateWithFlag(raw: unknown): { normalized: string | null; converted: boolean } {
  const normalized = normalizeDate(raw);
  if (normalized == null) return { normalized: null, converted: false };
  const original = String(raw ?? '').trim();
  return { normalized, converted: original !== normalized };
}
