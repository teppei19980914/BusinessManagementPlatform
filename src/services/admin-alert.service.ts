/**
 * super_admin への運用 alert サービス (PR-V7a / 2026-05-19)
 *
 * 監査 B-G-2 (入金期日超過) + B-G-6 (cron 失敗通知) を実現するため、
 * 「super_admin に気付かせる」を担う薄い service。
 *
 * 設計:
 *   - 送信先: User.systemRole='super_admin' AND isActive=true の全 email
 *     (= 1 人脱退しても他の super_admin がカバーできるよう全員に通知)
 *   - DB に super_admin が 0 人なら env SUPER_ADMIN_INITIAL_EMAIL にフォールバック
 *   - 送信は getMailProvider() のラッパ経由 (= 既存 email_send_logs に自動記録)
 *
 * 関連:
 *   - mail provider: src/lib/mail/index.ts getMailProvider
 *   - 期日超過: src/services/billing-alert.service.ts detectAndAlertOverdueInvoices (本ファイルから呼出可)
 *   - cron 失敗: src/services/cron-failure-alert.service.ts detectAndAlertCronFailures
 */

import { prisma } from '@/lib/db';
import { getMailProvider } from '@/lib/mail';
import { calculateInvoiceDueDate, isOverdue } from '@/config/billing';
import { MANAGEMENT_TENANT_ID } from '@/lib/tenant';
import { recordError } from './error-log.service';

/** sendSuperAdminAlert の結果。noRecipientsWarning=true は穴 A 防止 (= silent fail 検知) */
export type SendSuperAdminAlertResult = {
  sentTo: string[];
  failures: string[];
  /** PR-V7a 穴 A 修正: 通知先が 1 人もいなかった (= alert 機構が機能していない警告) */
  noRecipientsWarning?: true;
};

/**
 * super_admin 全員に alert メールを送信する。
 * super_admin 0 人の場合は env SUPER_ADMIN_INITIAL_EMAIL にフォールバック。
 *
 * **PR-V7a 穴 A 修正 (2026-05-19)**: フォールバックも空の場合、これまでは silent pass
 * していたが、recordError(severity='error') で system_error_logs に痕跡を残すよう修正。
 * 戻り値に noRecipientsWarning=true を含めて呼出側でも検知可能にする。
 */
export async function sendSuperAdminAlert(
  subject: string,
  body: string,
): Promise<SendSuperAdminAlertResult> {
  const admins = await prisma.user.findMany({
    where: {
      systemRole: 'super_admin',
      isActive: true,
    },
    select: { email: true },
  });

  let recipients = admins.map((a) => a.email);
  if (recipients.length === 0) {
    const fallback = process.env['SUPER_ADMIN_INITIAL_EMAIL'];
    if (fallback) recipients = [fallback];
  }

  // PR-V7a 穴 A: recipients=0 を silent fail させない
  if (recipients.length === 0) {
    await recordError({
      severity: 'error',
      source: 'cron',
      message:
        '[admin-alert] 通知先 super_admin が 0 人 + env SUPER_ADMIN_INITIAL_EMAIL も未設定。'
        + ' alert メールが送信されないため、即座に super_admin を作成するか env を設定してください。',
      context: {
        kind: 'admin_alert_no_recipients',
        subject,
        bodyPreview: body.slice(0, 200),
      },
    });
    return { sentTo: [], failures: [], noRecipientsWarning: true };
  }

  const provider = getMailProvider();
  const sentTo: string[] = [];
  const failures: string[] = [];
  for (const to of recipients) {
    const result = await provider.send({
      to,
      subject,
      text: body,
      type: 'admin_alert',
    });
    if (result.success) sentTo.push(to);
    else failures.push(to);
  }
  return { sentTo, failures };
}

// ============================================================
// §B-3: 入金期日超過 alert
// ============================================================

export type OverdueAlertResult = {
  detectedCount: number;
  alertSent: boolean;
  recipientsCount: number;
  skippedDueToRecentAlert: number;
};

/**
 * BillingHistory で status='pending' AND payment_due_date + threshold 超過の行を検知し、
 * 24h 以内に alert 未送信なら super_admin にメール + overdueAlertSentAt を更新する。
 *
 * 日次 cron での実行を想定。
 */
export async function detectAndAlertOverdueInvoices(
  now: Date = new Date(),
): Promise<OverdueAlertResult> {
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // payment_due_date が null の古いレコードは対象外 (PR-V7a 以前の invoice)
  const candidates = await prisma.billingHistory.findMany({
    where: {
      status: 'pending',
      paymentMethod: { in: ['invoice', 'bank_transfer'] },
      paymentDueDate: { not: null },
      tenantId: { not: MANAGEMENT_TENANT_ID },
      // dedup: 24h 以内に alert 済はスキップ
      OR: [
        { overdueAlertSentAt: null },
        { overdueAlertSentAt: { lt: twentyFourHoursAgo } },
      ],
    },
    select: {
      id: true,
      tenantId: true,
      yearMonth: true,
      totalAmountJpy: true,
      paymentDueDate: true,
      tenant: { select: { name: true } },
    },
  });

  // 期日 + 閾値超過のみ抽出
  const overdue = candidates.filter(
    (c) => c.paymentDueDate != null && isOverdue(c.paymentDueDate, now),
  );

  const result: OverdueAlertResult = {
    detectedCount: overdue.length,
    alertSent: false,
    recipientsCount: 0,
    skippedDueToRecentAlert: candidates.length - overdue.length,
  };

  if (overdue.length === 0) return result;

  const lines = overdue.map((o) => {
    const due = o.paymentDueDate
      ? new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo' }).format(o.paymentDueDate)
      : '(unknown)';
    return `- ${o.tenant.name} (${o.yearMonth}): ¥${o.totalAmountJpy.toLocaleString()} / 期日: ${due}`;
  });

  const subject = `[たすきば] 入金期日超過 ${overdue.length} 件 (= 督促対応要)`;
  const body
    = `銀行振込テナントで支払期日 (+ ${calculateInvoiceDueDate('2026-05').toISOString().slice(0, 10)} 形式の翌月25日) 超過の請求書を検知しました。\n\n`
    + `件数: ${overdue.length}\n\n`
    + `詳細:\n${lines.join('\n')}\n\n`
    + `対応: super_admin → /admin/super/billing/[yearMonth] で該当行を確認、入金消込 or 督促 を実施してください。\n`
    + `本メールは 24h 以内の重複送信を抑制しています (overdueAlertSentAt で dedup)。`;

  const { sentTo } = await sendSuperAdminAlert(subject, body);
  result.alertSent = sentTo.length > 0;
  result.recipientsCount = sentTo.length;

  // dedup: overdueAlertSentAt を更新 (= 該当した全行に対して)
  await prisma.billingHistory.updateMany({
    where: { id: { in: overdue.map((o) => o.id) } },
    data: { overdueAlertSentAt: now },
  });

  return result;
}

// ============================================================
// §B-4: cron 失敗 alert
// ============================================================

export type CronFailureAlertResult = {
  failedCount: number;
  alertSent: boolean;
  recipientsCount: number;
  /** PR-V7a 穴 C 修正: 自身 (cron-failure-alert) の前回成功が 25h 以上前 = alert 連鎖が破綻している警告 */
  selfDeliveryGapWarning?: { lastSuccessAt: Date | null; hoursSince: number | null };
};

/**
 * 直近 24h で status='failure' な cron 実行を検知し、super_admin にメール通知する。
 *
 * 日次 cron での実行を想定。
 * 同じ cron の連続失敗は body 内で件数表示されるだけで、毎日 1 通の集約メールになる
 * (= cron 失敗の頻度が高くても super_admin の inbox 爆破しない設計)。
 *
 * **PR-V7a 穴 C 修正 (2026-05-19) — alert 連鎖の watchdog**:
 *   自身 (cron-failure-alert) の前回成功実行が 25h 以上前 = 「日次なはずなのに 1 日以上動いていない」状態。
 *   この場合、alert 機構自体が破綻しているため、復活した今回の実行で「自分が長期サイレント停止していた」
 *   ことを最優先 alert として通知する。cron-job.org の built-in 失敗通知 (= 5xx 検知メール) も併用前提。
 */
export async function detectAndAlertCronFailures(
  now: Date = new Date(),
): Promise<CronFailureAlertResult> {
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const twentyFiveHoursAgo = new Date(now.getTime() - 25 * 60 * 60 * 1000);

  const [failures, lastSelfSuccess] = await Promise.all([
    prisma.cronExecutionLog.findMany({
      where: {
        status: 'failure',
        startedAt: { gte: twentyFourHoursAgo },
      },
      select: {
        cronName: true,
        startedAt: true,
        errorMessage: true,
      },
      orderBy: { startedAt: 'desc' },
      take: 100,
    }),
    // PR-V7a 穴 C: 自身の前回成功実行 (= 今回より前) を取得
    prisma.cronExecutionLog.findFirst({
      where: {
        cronName: 'cron-failure-alert',
        status: 'success',
        startedAt: { lt: now },
      },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    }),
  ]);

  const result: CronFailureAlertResult = {
    failedCount: failures.length,
    alertSent: false,
    recipientsCount: 0,
  };

  // PR-V7a 穴 C: 自身の前回成功 > 25h 前 = alert 連鎖の watchdog 警告
  const selfDeliveryGap
    = lastSelfSuccess == null
      ? { lastSuccessAt: null, hoursSince: null as number | null }
      : lastSelfSuccess.startedAt < twentyFiveHoursAgo
        ? {
            lastSuccessAt: lastSelfSuccess.startedAt,
            hoursSince:
              Math.round(
                (now.getTime() - lastSelfSuccess.startedAt.getTime()) / (60 * 60 * 1000) * 10,
              ) / 10,
          }
        : null;

  if (failures.length === 0 && selfDeliveryGap == null) return result;

  // cron 名で集約
  const byCron = new Map<string, { count: number; latestError: string | null; latestAt: Date }>();
  for (const f of failures) {
    const existing = byCron.get(f.cronName);
    if (existing) {
      existing.count += 1;
      if (f.startedAt > existing.latestAt) {
        existing.latestAt = f.startedAt;
        existing.latestError = f.errorMessage;
      }
    } else {
      byCron.set(f.cronName, {
        count: 1,
        latestError: f.errorMessage,
        latestAt: f.startedAt,
      });
    }
  }

  const lines = Array.from(byCron.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, info]) => {
      const at = new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo',
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(info.latestAt);
      return `- ${name}: ${info.count} 回失敗 / 最新 ${at}\n  └ エラー: ${info.latestError ?? '(messageなし)'}`;
    });

  // PR-V7a 穴 C: 自身が長期サイレントだった場合は最優先警告として subject 先頭に
  const selfGapPrefix
    = selfDeliveryGap != null
      ? selfDeliveryGap.lastSuccessAt == null
        ? '[‼️ alert 機構初回 or 履歴消失] '
        : `[‼️ alert 機構 ${selfDeliveryGap.hoursSince}h サイレント停止していました] `
      : '';

  const subject
    = selfGapPrefix
    + (failures.length > 0
      ? `[たすきば] cron 実行失敗 ${failures.length} 件 (直近 24h)`
      : `[たすきば] alert 機構復旧通知`);

  const selfGapBody
    = selfDeliveryGap != null
      ? `\n\n⚠️ **alert 連鎖 watchdog 警告**:\n`
        + `cron-failure-alert の前回成功実行は ${
          selfDeliveryGap.lastSuccessAt == null
            ? '記録なし (初回 or DB 消失)'
            : `${selfDeliveryGap.lastSuccessAt.toISOString()} (= ${selfDeliveryGap.hoursSince}h 前)`
        }。\n`
        + `この期間内に発生した cron 失敗 / 期日超過 alert が **送付されていない可能性が高い** です。\n`
        + `/admin/super/cron-history と /admin/super/billing で見落としを確認してください。\n`
      : '';

  const body
    = `直近 24 時間で失敗した cron を検知しました。\n\n`
    + `合計件数: ${failures.length}\n\n`
    + (failures.length > 0 ? `cron 別:\n${lines.join('\n')}\n\n` : '失敗 cron はありませんでした。\n\n')
    + `対応: /admin/super/cron-history で詳細 + stack trace を確認。\n`
    + `特に stripe-reconcile / billing-monthly-aggregation の失敗は請求業務に直結するため最優先で調査してください。`
    + selfGapBody;

  const { sentTo, noRecipientsWarning } = await sendSuperAdminAlert(subject, body);
  result.alertSent = sentTo.length > 0;
  result.recipientsCount = sentTo.length;
  if (selfDeliveryGap != null) {
    result.selfDeliveryGapWarning = selfDeliveryGap;
  }
  // noRecipientsWarning は sendSuperAdminAlert 内で recordError 済 (= silent fail 防止)
  void noRecipientsWarning;

  return result;
}
