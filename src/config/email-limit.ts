/**
 * メール送信上限の閾値定義 (P-H / 2026-05-08)
 *
 * 役割:
 *   外部メールプロバイダ (Brevo / Resend 等) の無料プラン上限超過事故を未然に
 *   検知するための閾値。super_admin ダッシュボードのメール送信モニタカードで使用。
 *
 * 設計判断:
 *   - **Brevo 無料 (300 通/日) をデフォルト**: コスト最適化中の現運用前提
 *   - **環境変数で上書き可能**: 有料プランへ移行 / プロバイダ変更時に再デプロイ不要
 *   - **monthly limit はオプショナル**: Brevo は日次上限のみで月次なし。Resend / SES 等で
 *     月次上限のあるプロバイダ向けに env で指定可能 (未設定なら null = 制限なし)
 *
 * 関連:
 *   - サービス: src/services/email-send-log.service.ts
 *   - UI: src/app/(dashboard)/admin/super/page.tsx (EmailSendMonitorCard)
 */

/** デフォルト日次上限: Brevo 無料プラン 300 通/日 */
export const EMAIL_DAILY_LIMIT_DEFAULT = 300;

/**
 * 日次メール送信上限 (件)。env 上書き可。
 *
 * 環境変数 `EMAIL_DAILY_LIMIT` で指定。未設定時は 300 (Brevo 無料)。
 */
export function getEmailDailyLimit(): number {
  const env = process.env.EMAIL_DAILY_LIMIT;
  if (env != null && env !== '') {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return EMAIL_DAILY_LIMIT_DEFAULT;
}

/**
 * 月次メール送信上限 (件)。env 上書きで指定された場合のみ集計・警告対象になる。
 *
 * 環境変数 `EMAIL_MONTHLY_LIMIT` で指定。未設定時は null = 月次制限なし。
 *
 * 例:
 *   - Brevo 無料: 日次のみ → 未設定 (null)
 *   - Resend 無料: 3000 通/月 → `EMAIL_MONTHLY_LIMIT=3000`
 */
export function getEmailMonthlyLimit(): number | null {
  const env = process.env.EMAIL_MONTHLY_LIMIT;
  if (env != null && env !== '') {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

/** 警告しきい値 (使用率 80%)。これ以上で「黄色 (要注意)」表示。 */
export const EMAIL_WARN_THRESHOLD = 0.8;

/** アラートしきい値 (使用率 90%)。これ以上で「赤色 (緊急)」表示。 */
export const EMAIL_ALERT_THRESHOLD = 0.9;

/** 送信容量ステータス (P-5a の DB 容量モニタと同じ 3 段階分類) */
export type EmailLimitStatus = 'ok' | 'warn' | 'alert';

/**
 * 使用率からステータスを判定する純関数。
 *
 * - ratio < WARN (80%): 'ok'
 * - WARN <= ratio < ALERT (90%): 'warn'
 * - ratio >= ALERT (90%): 'alert'
 * - limit が null (= 制限なし): 'ok'
 */
export function classifyEmailLimitStatus(used: number, limit: number | null): EmailLimitStatus {
  if (limit == null || limit <= 0) return 'ok';
  const ratio = used / limit;
  if (ratio >= EMAIL_ALERT_THRESHOLD) return 'alert';
  if (ratio >= EMAIL_WARN_THRESHOLD) return 'warn';
  return 'ok';
}
