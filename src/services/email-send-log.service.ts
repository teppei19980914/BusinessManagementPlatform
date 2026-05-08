/**
 * メール送信ログサービス (P-H / 2026-05-08)
 *
 * 役割:
 *   - 全メール送信を `email_send_logs` テーブルに 1 行 1 record で記録 (PII 抜き)
 *   - super_admin ダッシュボードで日次/月次の送信件数を集計
 *   - 送信前に日次上限超過判定 (= 超過時は send をブロック + ログ警告)
 *
 * 設計判断:
 *   - **本文・件名は保存しない**: PII / 機密情報の漏洩防止
 *   - **recipient hash + domain のみ保存**: 「同じ宛先に何度送ったか」「どのドメイン宛が多いか」
 *     の集計は可能、本文の中身までは追えない設計 (= 監査と運用のバランス)
 *   - **集計クエリは 1 SQL で完結**: COUNT + DATE_TRUNC で日次/月次集計を即時返す
 *
 * 関連:
 *   - 計画: docs/roadmap/V1_FINAL_TASKS.md P-H
 *   - 設定: src/config/email-limit.ts (上限閾値)
 *   - UI: super_admin ダッシュボード (EmailSendMonitorCard)
 *   - 利用箇所: src/lib/mail/index.ts (getMailProvider の wrapper で record + check)
 */

import { createHash } from 'crypto';
import { prisma } from '@/lib/db';
import {
  classifyEmailLimitStatus,
  getEmailDailyLimit,
  getEmailMonthlyLimit,
  type EmailLimitStatus,
} from '@/config/email-limit';

// ================================================================
// 型
// ================================================================

/**
 * メール送信種別。固定値は型で示すが、テスト・将来拡張用に文字列受け入れも可能。
 * 既知の type:
 *   - 'invitation'              : ユーザ招待 (パスワード設定リンク)
 *   - 'password_reset'          : パスワードリセット
 *   - 'usage_alert'             : 月次予算アラート (admin 宛)
 *   - 'beginner_warning_60'     : Beginner プラン Day 60 警告
 *   - 'beginner_warning_75'     : Beginner プラン Day 75 警告
 *   - 'beginner_expired'        : Beginner プラン 期限切れ通知
 *   - 'unknown'                 : 種別未指定 (= 既存の get-or-fall-through 経路)
 */
export type EmailSendType =
  | 'invitation'
  | 'password_reset'
  | 'usage_alert'
  | 'beginner_warning_60'
  | 'beginner_warning_75'
  | 'beginner_expired'
  | 'unknown';

export type EmailSendLogInput = {
  type: EmailSendType;
  recipientEmail: string;
  success: boolean;
  errorMessage?: string;
  providerName: string;
  tenantId?: string;
};

export type EmailSendStats = {
  /** 日次送信件数 (今日 = UTC 00:00 から現在まで、成功 + 失敗の合計) */
  dailySent: number;
  /** 月次送信件数 (= 当月 1 日 UTC から現在まで) */
  monthlySent: number;
  /** 日次送信件数のうち success=true の件数 */
  dailySuccessful: number;
  /** 失敗件数 (日次) */
  dailyFailed: number;
  /** 設定された日次上限 (env or default 300) */
  dailyLimit: number;
  /** 設定された月次上限 (env or null) */
  monthlyLimit: number | null;
  /** 日次使用率 (= dailySent / dailyLimit、0.0〜1.0+) */
  dailyUtilizationRatio: number;
  /** 月次使用率 (= monthlySent / monthlyLimit、null なら null) */
  monthlyUtilizationRatio: number | null;
  /** 日次ステータス (ok / warn 80%+ / alert 90%+) */
  dailyStatus: EmailLimitStatus;
  /** 月次ステータス (limit が null なら常に 'ok') */
  monthlyStatus: EmailLimitStatus;
  /** 集計時刻 */
  measuredAt: Date;
};

// ================================================================
// 公開関数: ログ記録
// ================================================================

/**
 * メール送信を 1 件記録する (= getMailProvider 内部の wrapper から呼ばれる)。
 *
 * - PII 漏洩防止のため recipient は SHA-256 hash + domain のみ保存
 * - DB 書込み失敗時はサイレントに無視 (= メール送信本体は止めない)
 *   (ログ記録の信頼性 < メール本体到達の信頼性、という優先順位)
 */
export async function recordEmailSend(input: EmailSendLogInput): Promise<void> {
  const { recipientHash, recipientDomain } = hashRecipient(input.recipientEmail);

  try {
    await prisma.emailSendLog.create({
      data: {
        tenantId: input.tenantId ?? null,
        type: input.type,
        recipientHash,
        recipientDomain,
        success: input.success,
        errorMessage: input.errorMessage ?? null,
        providerName: input.providerName,
      },
    });
  } catch {
    // ログ記録失敗は無視 (本体送信のフローを止めない)
    // 必要なら recordError で system_error_logs に記録する選択肢もあるが、
    // mail_send_logs 自体が記録対象なので循環依存の懸念があり sky にする。
  }
}

// ================================================================
// 公開関数: 上限チェック (送信前ガード)
// ================================================================

/**
 * 当日 (UTC 00:00 起点) の送信件数が日次上限に達しているかをチェック。
 *
 * - 達している場合は true を返す → 呼出側 (= mail provider wrapper) は send を skip し
 *   `success=false, errorMessage='daily_limit_exceeded'` で recordEmailSend のみ実行する想定
 *
 * 注: 月次上限は集計表示のみで送信ブロックには使わない (= Brevo の月次上限はないため、
 * 月次オーバーは「複数日にわたる累積」の話で個別 send を止める判断は別途運用判断する)。
 */
export async function isDailyEmailLimitReached(): Promise<boolean> {
  const limit = getEmailDailyLimit();
  const todayStart = getTodayStartUtc();
  const count = await prisma.emailSendLog.count({
    where: { sentAt: { gte: todayStart } },
  });
  return count >= limit;
}

// ================================================================
// 公開関数: 集計 (super_admin ダッシュボード用)
// ================================================================

/**
 * 日次 / 月次の送信件数 + ステータス分類を計算する。
 *
 * 集計範囲:
 *   - 日次: 今日 00:00 UTC 〜 現在
 *   - 月次: 当月 1 日 00:00 UTC 〜 現在
 */
export async function getEmailSendStats(now: Date = new Date()): Promise<EmailSendStats> {
  const todayStart = getTodayStartUtc(now);
  const monthStart = getMonthStartUtc(now);

  // 並列実行で 1 ラウンドトリップに近づける
  const [dailyTotal, dailySuccessful, dailyFailed, monthlyTotal] = await Promise.all([
    prisma.emailSendLog.count({ where: { sentAt: { gte: todayStart } } }),
    prisma.emailSendLog.count({
      where: { sentAt: { gte: todayStart }, success: true },
    }),
    prisma.emailSendLog.count({
      where: { sentAt: { gte: todayStart }, success: false },
    }),
    prisma.emailSendLog.count({ where: { sentAt: { gte: monthStart } } }),
  ]);

  const dailyLimit = getEmailDailyLimit();
  const monthlyLimit = getEmailMonthlyLimit();

  return {
    dailySent: dailyTotal,
    monthlySent: monthlyTotal,
    dailySuccessful,
    dailyFailed,
    dailyLimit,
    monthlyLimit,
    dailyUtilizationRatio: dailyLimit > 0 ? dailyTotal / dailyLimit : 0,
    monthlyUtilizationRatio:
      monthlyLimit != null && monthlyLimit > 0 ? monthlyTotal / monthlyLimit : null,
    dailyStatus: classifyEmailLimitStatus(dailyTotal, dailyLimit),
    monthlyStatus: classifyEmailLimitStatus(monthlyTotal, monthlyLimit),
    measuredAt: now,
  };
}

// ================================================================
// 内部ユーティリティ
// ================================================================

/** SHA-256 でメールアドレスをハッシュ化 + ドメイン部だけ平文で抽出。 */
function hashRecipient(email: string): { recipientHash: string; recipientDomain: string } {
  const recipientHash = createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
  const at = email.indexOf('@');
  const recipientDomain = at >= 0 ? email.slice(at).toLowerCase() : '';
  return { recipientHash, recipientDomain };
}

/** UTC で「今日の 00:00」を返す */
function getTodayStartUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** UTC で「当月 1 日 00:00」を返す */
function getMonthStartUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
