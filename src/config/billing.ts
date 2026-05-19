/**
 * 請求業務関連の定数 (PR-V7a / 2026-05-19)
 *
 * 関連: docs/business/STRIPE_BILLING.md / docs/operations/STRIPE_SETUP.md
 *
 * 設計判断:
 *   - 消費税端数処理は四捨五入 (= Stripe Tax の挙動と整合)
 *   - 銀行振込の支払期日は「翌月 25 日」固定 (= LP FAQ Q8 に明記)
 *   - 期日超過 alert 閾値は +5 日 (= 顧客の銀行振込タイミング誤差を吸収)
 *   - 失敗 alert 閾値は受信後即時 (= 督促判断は人間に委ねる)
 */

/** 消費税率 (= 10%、軽減税率非対象 SaaS) */
export const TAX_RATE = 0.10;

/** 消費税端数処理モード。Math.round で四捨五入 (Stripe Tax 整合) */
export const TAX_ROUNDING_MODE = 'round' as const;

/**
 * 税抜金額から消費税額を計算する (= 整数円返却)。
 * 例: ¥1,234 → ¥123 (= 123.4 四捨五入)
 */
export function calculateTaxJpy(amountJpy: number): number {
  return Math.round(amountJpy * TAX_RATE);
}

/** 銀行振込の支払期日 (= 翌月の日にち、固定 25 日) */
export const INVOICE_PAYMENT_DUE_DAY = 25;

/**
 * 請求対象月 (yearMonth='YYYY-MM') から支払期日を算出する。
 * 例: '2026-05' → 2026-06-25 23:59:59 JST
 *
 * 土日祝の翌営業日繰延は未対応 (= 運用で吸収)。LP FAQ Q8 では明記しているが
 * 業務カレンダー実装は MVP 外。
 */
export function calculateInvoiceDueDate(yearMonth: string): Date {
  const [yearStr, monthStr] = yearMonth.split('-');
  const year = Number.parseInt(yearStr ?? '', 10);
  const month = Number.parseInt(monthStr ?? '', 10);
  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    throw new Error(`Invalid yearMonth: ${yearMonth}`);
  }
  // month は 1-12、翌月 = month + 1 (12 → 翌年 1 月)
  const dueYear = month === 12 ? year + 1 : year;
  const dueMonth = month === 12 ? 1 : month + 1;
  // JST 23:59:59 = UTC 14:59:59 の前日
  // Date は UTC ベースなので JST 23:59:59 を表現するには -9h
  // JST: dueYear-dueMonth-25 23:59:59 = UTC: dueYear-dueMonth-25 14:59:59
  return new Date(Date.UTC(dueYear, dueMonth - 1, INVOICE_PAYMENT_DUE_DAY, 14, 59, 59, 999));
}

/** 期日超過 alert を発火する閾値 (= 期日 + N 日) */
export const OVERDUE_ALERT_THRESHOLD_DAYS = 5;

/**
 * 期日超過判定。期日 + OVERDUE_ALERT_THRESHOLD_DAYS を過ぎていれば true。
 */
export function isOverdue(dueDate: Date, now: Date = new Date()): boolean {
  const overdueThresholdMs = dueDate.getTime() + OVERDUE_ALERT_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
  return now.getTime() > overdueThresholdMs;
}

/**
 * メール送付失敗 alert を発火する閾値件数 (= 直近 24h での集計、N 件以上で alert)。
 */
export const EMAIL_FAILURE_ALERT_THRESHOLD = 1;

/**
 * Stripe ↔ DB 金額照合の許容差分 (円)。
 * Stripe Tax / 為替丸めで最大数円のズレが発生する可能性、超えたら alert。
 */
export const AMOUNT_RECONCILE_TOLERANCE_JPY = 1;
