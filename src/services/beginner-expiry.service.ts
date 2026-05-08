/**
 * Beginner プラン期限管理サービス (P-B / 2026-05-08)
 *
 * 役割:
 *   Beginner プランは「初回テナント作成から 90 日限定の試用プラン」として制御する。
 *   60/75 日経過時点で警告メールを送信し、90 日超過で read-only モードに移行する。
 *
 * 設計判断:
 *   - **計測起点**: `Tenant.createdAt` を一律使用 (= 上位プランに一度でも上がったテナントは
 *     Beginner に戻せないので、Beginner プラン期間 = 「初期作成から経過した日数」と一致)
 *   - **判定は純関数**: DB アクセスせず Tenant の plan + createdAt + beginnerEverUpgraded から
 *     決定。テスト容易性 + 大量バッチ処理時のパフォーマンス両立。
 *   - **state machine**:
 *     - state = 'active' (Day 0〜59): 通常稼働、警告なし
 *     - state = 'warning_60' (Day 60〜74): 1 回目警告
 *     - state = 'warning_75' (Day 75〜89): 2 回目警告
 *     - state = 'expired' (Day 90+): read-only モード
 *   - **plan != 'beginner' のテナント**: 制御対象外 (= state は常に 'active')
 *   - **beginnerEverUpgraded == true なテナント**: 制御対象外 (一度上位プランに上がっているため
 *     Beginner であっても期限切れの対象外。ただし現状はダウングレード禁止のため理論上は
 *     plan='beginner' AND beginnerEverUpgraded=true は発生しない。defensive な分岐として残す)
 *
 * 関連:
 *   - 計画: docs/roadmap/V1_FINAL_TASKS.md P-B
 *   - 警告メール送信: 日次 cron (/api/cron/daily-usage-aggregation) に統合
 *   - read-only 制御: middleware + jwt claim
 */

import { prisma } from '@/lib/db';
import { recordError } from '@/services/error-log.service';
import { getMailProvider } from '@/lib/mail';
import { MANAGEMENT_TENANT_ID } from '@/lib/tenant';

// ================================================================
// 公開定数
// ================================================================

export const BEGINNER_NOTICE_DAY_60 = 60;
export const BEGINNER_NOTICE_DAY_75 = 75;
export const BEGINNER_EXPIRY_DAYS = 90;

// ================================================================
// 型
// ================================================================

export type BeginnerExpiryState = 'active' | 'warning_60' | 'warning_75' | 'expired';

/** 判定対象に必要な最小フィールド (Tenant の他フィールドに依存しないため引数を絞る) */
export type BeginnerExpiryInput = {
  plan: string;
  createdAt: Date;
  beginnerEverUpgraded: boolean;
};

// ================================================================
// 公開関数: 判定ヘルパ
// ================================================================

/**
 * Beginner プラン期限の state を判定する (純関数)。
 *
 * - plan != 'beginner' / beginnerEverUpgraded=true / 管理テナント: 'active'
 * - それ以外: createdAt 起点の経過日数で 4 段階分類
 */
export function getBeginnerExpiryState(
  tenant: BeginnerExpiryInput,
  now: Date = new Date(),
): BeginnerExpiryState {
  if (tenant.plan !== 'beginner') return 'active';
  if (tenant.beginnerEverUpgraded) return 'active';

  const daysElapsed = Math.floor(
    (now.getTime() - tenant.createdAt.getTime()) / (24 * 60 * 60 * 1000),
  );

  if (daysElapsed >= BEGINNER_EXPIRY_DAYS) return 'expired';
  if (daysElapsed >= BEGINNER_NOTICE_DAY_75) return 'warning_75';
  if (daysElapsed >= BEGINNER_NOTICE_DAY_60) return 'warning_60';
  return 'active';
}

/**
 * 残り日数を返す (= 90 日まで何日)。expired なら負数。plan != beginner なら null。
 */
export function getBeginnerDaysRemaining(
  tenant: BeginnerExpiryInput,
  now: Date = new Date(),
): number | null {
  if (tenant.plan !== 'beginner') return null;
  if (tenant.beginnerEverUpgraded) return null;

  const daysElapsed = Math.floor(
    (now.getTime() - tenant.createdAt.getTime()) / (24 * 60 * 60 * 1000),
  );
  return BEGINNER_EXPIRY_DAYS - daysElapsed;
}

/**
 * read-only モードに該当するか (= write 系 API を弾くべきかの判定)。
 * middleware の jwt claim で参照される。
 */
export function isBeginnerExpired(
  tenant: BeginnerExpiryInput,
  now: Date = new Date(),
): boolean {
  return getBeginnerExpiryState(tenant, now) === 'expired';
}

// ================================================================
// 公開関数: 警告メール送信 (日次 cron から呼ばれる)
// ================================================================

export type SendBeginnerNoticesResult = {
  /** 60 日警告メール送信件数 */
  day60Sent: number;
  /** 75 日警告メール送信件数 */
  day75Sent: number;
  /** 90 日 expired 通知メール送信件数 */
  expiredSent: number;
  /** メール送信失敗件数 (recordError 記録済み) */
  failed: number;
};

/**
 * 全 Beginner テナントに対して 60/75/90 日警告メールを送信する。
 *
 * - 各 type は (tenantId, type) の状態フィールドで重複送信防止
 * - メール送信失敗は recordError でロギングして次のテナントへ進行 (1 件失敗で停止しない)
 * - 管理テナント / 上位プランは対象外 (getBeginnerExpiryState で 'active' になり該当条件無視)
 *
 * 想定呼出: 日次 cron (`/api/cron/daily-usage-aggregation`)。複数回実行されても冪等
 * (同 type を 2 度送らない)。
 */
export async function sendBeginnerExpiryNotices(
  baseUrl: string,
  now: Date = new Date(),
): Promise<SendBeginnerNoticesResult> {
  const result: SendBeginnerNoticesResult = {
    day60Sent: 0,
    day75Sent: 0,
    expiredSent: 0,
    failed: 0,
  };

  // 対象: plan='beginner' かつ beginnerEverUpgraded=false かつ deletedAt=null かつ管理テナント以外
  const candidates = await prisma.tenant.findMany({
    where: {
      plan: 'beginner',
      beginnerEverUpgraded: false,
      deletedAt: null,
      id: { not: MANAGEMENT_TENANT_ID },
    },
    select: {
      id: true,
      name: true,
      plan: true,
      createdAt: true,
      beginnerEverUpgraded: true,
      billingContactEmail: true,
      billingContactName: true,
      beginnerNoticeDay60SentAt: true,
      beginnerNoticeDay75SentAt: true,
      beginnerExpiredNoticeSentAt: true,
    },
  });

  for (const t of candidates) {
    const state = getBeginnerExpiryState(t, now);
    const daysRemaining = getBeginnerDaysRemaining(t, now);

    try {
      switch (state) {
        case 'warning_60':
          if (t.beginnerNoticeDay60SentAt == null) {
            await sendNoticeEmail(t, 'day_60', daysRemaining ?? 0, baseUrl);
            await prisma.tenant.update({
              where: { id: t.id },
              data: { beginnerNoticeDay60SentAt: now },
            });
            result.day60Sent += 1;
          }
          break;
        case 'warning_75':
          // 60 日通知も未送信なら同時送信 (= 後追いで Day 60 を飛ばさない)
          if (t.beginnerNoticeDay60SentAt == null) {
            await sendNoticeEmail(t, 'day_60', daysRemaining ?? 0, baseUrl);
            await prisma.tenant.update({
              where: { id: t.id },
              data: { beginnerNoticeDay60SentAt: now },
            });
            result.day60Sent += 1;
          }
          if (t.beginnerNoticeDay75SentAt == null) {
            await sendNoticeEmail(t, 'day_75', daysRemaining ?? 0, baseUrl);
            await prisma.tenant.update({
              where: { id: t.id },
              data: { beginnerNoticeDay75SentAt: now },
            });
            result.day75Sent += 1;
          }
          break;
        case 'expired':
          if (t.beginnerExpiredNoticeSentAt == null) {
            await sendNoticeEmail(t, 'expired', 0, baseUrl);
            await prisma.tenant.update({
              where: { id: t.id },
              data: { beginnerExpiredNoticeSentAt: now },
            });
            result.expiredSent += 1;
          }
          break;
        case 'active':
          // 何もしない
          break;
      }
    } catch (e) {
      result.failed += 1;
      await recordError({
        severity: 'warn',
        source: 'cron',
        message: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
        context: { kind: 'beginner_expiry_notice', tenantId: t.id, state },
      });
    }
  }

  return result;
}

// ================================================================
// 内部
// ================================================================

type NoticeType = 'day_60' | 'day_75' | 'expired';

async function sendNoticeEmail(
  tenant: { id: string; name: string; billingContactEmail: string | null; billingContactName: string | null },
  type: NoticeType,
  daysRemaining: number,
  baseUrl: string,
): Promise<void> {
  if (tenant.billingContactEmail == null || tenant.billingContactEmail === '') {
    // 請求先メール未設定のテナント (= 旧 default-tenant 等) は通知できないので skip
    throw new Error('billing_contact_email_missing');
  }

  const upgradeUrl = `${baseUrl}/settings/tenant`;
  const greeting = tenant.billingContactName
    ? `${tenant.billingContactName} 様`
    : 'お客様';

  let subject: string;
  let body: string;

  if (type === 'day_60') {
    subject = `【たすきば】Beginner プラン期限まで残り ${daysRemaining} 日`;
    body = `${greeting}

たすきば Knowledge Relay をご利用いただきありがとうございます。

ご利用中の Beginner プラン (無料試用期間 90 日) の期限まで、あと ${daysRemaining} 日となりました。
期限を過ぎますと **読み取り専用モード** となり、データの作成・更新・削除・エクスポートができなくなります。

**重要**: 期限後はエクスポート機能も停止するため、データを保全したい場合は期限内のエクスポートをお勧めします。

引き続きご利用いただく場合は、Expert または Pro プランへのアップグレードをお願いいたします:
${upgradeUrl}

ご不明な点は本メールへの返信でお問い合わせください。

— たすきば 運営チーム`;
  } else if (type === 'day_75') {
    subject = `【たすきば】Beginner プラン期限まで残り ${daysRemaining} 日 (再通知)`;
    body = `${greeting}

たすきば Knowledge Relay をご利用いただきありがとうございます。

Beginner プラン (無料試用期間 90 日) の期限まで、あと ${daysRemaining} 日となりました。

**期限後の挙動 (再掲)**:
- 読み取り専用モードに切り替わります
- データの作成・更新・削除・**エクスポート** が利用できなくなります
- ログインと既存データの閲覧は継続して可能です

データ保全のためエクスポートは期限前に実施することを強くお勧めします。
プランアップグレード: ${upgradeUrl}

— たすきば 運営チーム`;
  } else {
    subject = '【たすきば】Beginner プラン期限切れ — 読み取り専用モードに移行しました';
    body = `${greeting}

Beginner プランの利用期間 90 日が経過したため、ご利用テナントは **読み取り専用モード** に移行しました。

**現在の制限**:
- データの作成・更新・削除はできません
- エクスポート機能は停止しています
- ログインと既存データの閲覧は引き続き可能です

書き込み・エクスポート機能を再開するには Expert または Pro プランへのアップグレードが必要です:
${upgradeUrl}

ご解約をご希望の場合はお手数ですが本メールへご返信ください。

— たすきば 運営チーム`;
  }

  const provider = getMailProvider();
  // P-H (2026-05-08): 送信種別ラベル (ログ集計用)。Day 60/75/期限切れで type を分けて記録。
  const mailType =
    type === 'day_60'
      ? 'beginner_warning_60'
      : type === 'day_75'
        ? 'beginner_warning_75'
        : 'beginner_expired';
  const sendResult = await provider.send({
    to: tenant.billingContactEmail,
    subject,
    text: body,
    html: `<pre style="font-family: sans-serif; white-space: pre-wrap;">${escapeHtml(body)}</pre>`,
    type: mailType,
    tenantId: tenant.id,
  });

  if (!sendResult.success) {
    throw new Error(`mail_send_failed: ${sendResult.error ?? 'unknown'}`);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
