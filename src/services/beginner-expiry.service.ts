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
// PR-4 (2026-05-15): テナント TZ ベースの日付計算ヘルパ
import { tenantCalendarDayDiff } from '@/lib/tenant-time';
import { DEFAULT_TIMEZONE } from '@/config/i18n';

// ================================================================
// 公開定数
// ================================================================

export const BEGINNER_NOTICE_DAY_60 = 60;
export const BEGINNER_NOTICE_DAY_75 = 75;
export const BEGINNER_EXPIRY_DAYS = 90;
/** 2026-05-11: 自動物理削除予告 — Day 150 で「あと 30 日で自動削除」を通知 */
export const BEGINNER_AUTO_DELETE_NOTICE_DAY_150 = 150;
/** 2026-05-11: 自動物理削除予告 — Day 170 で「あと 10 日で自動削除」を最終通知 */
export const BEGINNER_AUTO_DELETE_NOTICE_DAY_170 = 170;
/** 2026-05-11: 自動物理削除発火日。実装は src/services/super-admin.service.ts purgeExpiredBeginnerTenants */
export const BEGINNER_AUTO_DELETE_DAYS = 180;

// ================================================================
// 型
// ================================================================

export type BeginnerExpiryState = 'active' | 'warning_60' | 'warning_75' | 'expired';

/** 判定対象に必要な最小フィールド (Tenant の他フィールドに依存しないため引数を絞る) */
export type BeginnerExpiryInput = {
  plan: string;
  createdAt: Date;
  beginnerEverUpgraded: boolean;
  // PR-4 (2026-05-15): テナント TZ。未指定なら DEFAULT_TIMEZONE (= 'Asia/Tokyo')。
  //   middleware (JWT claim 経由) や cron (DB 直読) の両経路で渡せる optional。
  timezone?: string;
};

// ================================================================
// 公開関数: 判定ヘルパ
// ================================================================

/**
 * Beginner プラン期限の state を判定する (純関数、PR-4 でテナント TZ ベース化)。
 *
 * - plan != 'beginner' / beginnerEverUpgraded=true / 管理テナント: 'active'
 * - それ以外: createdAt 起点の **テナント TZ カレンダー日数** で 4 段階分類
 *   (旧仕様 = 絶対経過時間 / 24h、新仕様 = TZ ローカルでの YYYY-MM-DD 差)
 *
 * 例: 'Asia/Tokyo' で 2026-02-01 14:00 JST 作成 → 2026-05-02 09:00 JST 時点で
 *   絶対経過 89.98 日だが、TZ カレンダー差は (2026-05-02 - 2026-02-01) = 90 日 → expired
 *   (TZ 0:00 に切替わる挙動を実現)
 */
export function getBeginnerExpiryState(
  tenant: BeginnerExpiryInput,
  now: Date = new Date(),
): BeginnerExpiryState {
  if (tenant.plan !== 'beginner') return 'active';
  if (tenant.beginnerEverUpgraded) return 'active';

  // PR-4: テナント TZ カレンダー日差で判定
  const timeZone = tenant.timezone ?? DEFAULT_TIMEZONE;
  const daysElapsed = tenantCalendarDayDiff(tenant.createdAt, now, timeZone);

  if (daysElapsed >= BEGINNER_EXPIRY_DAYS) return 'expired';
  if (daysElapsed >= BEGINNER_NOTICE_DAY_75) return 'warning_75';
  if (daysElapsed >= BEGINNER_NOTICE_DAY_60) return 'warning_60';
  return 'active';
}

/**
 * 残り日数を返す (= 90 日まで何日、PR-4 でテナント TZ ベース)。expired なら負数。plan != beginner なら null。
 */
export function getBeginnerDaysRemaining(
  tenant: BeginnerExpiryInput,
  now: Date = new Date(),
): number | null {
  if (tenant.plan !== 'beginner') return null;
  if (tenant.beginnerEverUpgraded) return null;

  // PR-4: テナント TZ カレンダー日差
  const timeZone = tenant.timezone ?? DEFAULT_TIMEZONE;
  const daysElapsed = tenantCalendarDayDiff(tenant.createdAt, now, timeZone);
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
  /** 2026-05-11: 自動削除 30 日前予告 (Day 150) 送信件数 */
  autoDeleteDay150Sent: number;
  /** 2026-05-11: 自動削除 10 日前最終警告 (Day 170) 送信件数 */
  autoDeleteDay170Sent: number;
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
    autoDeleteDay150Sent: 0,
    autoDeleteDay170Sent: 0,
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
      // PR-4 (2026-05-15): テナント TZ も取得し、各テナントのローカル日付で判定
      timezone: true,
      billingContactEmail: true,
      billingContactName: true,
      beginnerNoticeDay60SentAt: true,
      beginnerNoticeDay75SentAt: true,
      beginnerExpiredNoticeSentAt: true,
      // 2026-05-11: 自動削除 30 日前 / 10 日前の予告メール用フラグ
      beginnerAutoDeleteNoticeDay150SentAt: true,
      beginnerAutoDeleteNoticeDay170SentAt: true,
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
          // 2026-05-11: Day 180 自動物理削除に向けた中間警告メール。
          // 'expired' state でも継続して経過日数を見て Day 150 / Day 170 で追加通知する。
          // 冪等性: 各 type 固有のフラグで重複送信防止。
          {
            const daysElapsedNow = Math.floor(
              (now.getTime() - t.createdAt.getTime()) / (24 * 60 * 60 * 1000),
            );
            if (
              daysElapsedNow >= BEGINNER_AUTO_DELETE_NOTICE_DAY_150 &&
              t.beginnerAutoDeleteNoticeDay150SentAt == null
            ) {
              const daysUntilDelete = BEGINNER_AUTO_DELETE_DAYS - daysElapsedNow;
              await sendNoticeEmail(t, 'auto_delete_day_150', daysUntilDelete, baseUrl);
              await prisma.tenant.update({
                where: { id: t.id },
                data: { beginnerAutoDeleteNoticeDay150SentAt: now },
              });
              result.autoDeleteDay150Sent += 1;
            }
            if (
              daysElapsedNow >= BEGINNER_AUTO_DELETE_NOTICE_DAY_170 &&
              t.beginnerAutoDeleteNoticeDay170SentAt == null
            ) {
              const daysUntilDelete = BEGINNER_AUTO_DELETE_DAYS - daysElapsedNow;
              await sendNoticeEmail(t, 'auto_delete_day_170', daysUntilDelete, baseUrl);
              await prisma.tenant.update({
                where: { id: t.id },
                data: { beginnerAutoDeleteNoticeDay170SentAt: now },
              });
              result.autoDeleteDay170Sent += 1;
            }
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

type NoticeType =
  | 'day_60'
  | 'day_75'
  | 'expired'
  // 2026-05-11: 自動物理削除予告 (Day 150 = 30 日前 / Day 170 = 10 日前)
  | 'auto_delete_day_150'
  | 'auto_delete_day_170';

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
期限を過ぎますと **読み取り専用モード** となり、データの作成・更新・削除ができなくなります。

**ご安心ください**: データのエクスポート機能は期限後も引き続きご利用いただけます (顧客のデータ持ち出しを保証する設計です)。

引き続きアクティブにご利用いただく場合は、Expert または Pro プランへのアップグレードをお願いいたします:
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
- データの作成・更新・削除が利用できなくなります
- ログインと既存データの閲覧は継続して可能です
- **データのエクスポート機能は引き続きご利用いただけます** (顧客のデータ救済保証)

引き続きアクティブにご利用いただく場合はプランアップグレードをお願いします:
${upgradeUrl}

— たすきば 運営チーム`;
  } else if (type === 'auto_delete_day_150') {
    subject = `【たすきば】重要：あと ${daysRemaining} 日でテナントが自動削除されます`;
    body = `${greeting}

ご利用中のテナントは Beginner プランの試用期間 (90 日) を超過し、現在 **読み取り専用モード** で稼働しています。

⚠ **重要なご連絡**: テナント作成から 180 日経過時点で、業務データは **自動的に物理削除** されます。
本日時点で削除実行まで **あと ${daysRemaining} 日** となっています。

**現在ご選択いただける選択肢**:

1. **継続利用 (推奨)**: Expert または Pro プランへアップグレードすると、即時に通常運用へ復帰します。データは失われません。
   ${upgradeUrl}

2. **データ退避のみ**: テナント設定画面の「データエクスポート」機能で全データを取得できます。

3. **セルフ解約**: テナント設定画面の「テナント解約」機能で能動的に解約できます (この場合も解約から 90 日後に物理削除)。

何もしない場合、上記期日に業務データが **不可逆的に削除** されますのでご注意ください。

ご不明点は本メールへご返信ください。

— たすきば 運営チーム`;
  } else if (type === 'auto_delete_day_170') {
    subject = `【たすきば】最終警告：あと ${daysRemaining} 日でテナント自動削除`;
    body = `${greeting}

🚨 **最終警告 (再送)**

ご利用中のテナントは Beginner プランの試用期間 (90 日) を超過した状態で読み取り専用モードに留まっており、本日時点で自動削除まで **あと ${daysRemaining} 日** となっています。

**${daysRemaining} 日後にすべての業務データが自動的に物理削除されます (復旧不可)。**

データを失わないために、以下のいずれかを必ず実施してください:

1. **アップグレード (推奨)**: Expert または Pro プランへ即時切替えで通常運用に復帰します。
   ${upgradeUrl}

2. **エクスポート**: テナント設定画面からデータをダウンロードして退避してください。

ご質問・ご相談は本メールへご返信いただくか、Discord コミュニティへお気軽にお問い合わせください。

— たすきば 運営チーム`;
  } else {
    subject = '【たすきば】Beginner プラン期限切れ — 読み取り専用モードに移行しました';
    body = `${greeting}

Beginner プランの利用期間 90 日が経過したため、ご利用テナントは **読み取り専用モード** に移行しました。

**現在の制限**:
- データの作成・更新・削除はできません
- ログインと既存データの閲覧は引き続き可能です
- **データのエクスポートは引き続きご利用いただけます** (テナント設定画面からダウンロード可能)
- **プランのアップグレードとセルフ解約は引き続き可能です** (テナント設定画面から実行可能)

書き込み機能を再開するには Expert または Pro プランへのアップグレードが必要です:
${upgradeUrl}

⚠ **重要なお知らせ**: 本日から **90 日後 (テナント作成から合計 180 日経過時点)** にアップグレードされていないテナントは、業務データを **自動的に物理削除** いたします。継続してご利用の場合は猶予期間中にアップグレードをお願いいたします。データのみ退避したい場合はエクスポート機能で取得可能です。

ご解約をご希望の場合はテナント設定画面のセルフ解約機能をご利用いただくか、お手数ですが本メールへご返信ください (運営側でデータエクスポート代行も承ります)。

— たすきば 運営チーム`;
  }

  const provider = getMailProvider();
  // P-H (2026-05-08): 送信種別ラベル (ログ集計用)。
  // 2026-05-11: 自動削除予告 (Day 150 / Day 170) のラベルを追加。
  const mailType =
    type === 'day_60'
      ? 'beginner_warning_60'
      : type === 'day_75'
        ? 'beginner_warning_75'
        : type === 'auto_delete_day_150'
          ? 'beginner_auto_delete_warning_150'
          : type === 'auto_delete_day_170'
            ? 'beginner_auto_delete_warning_170'
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
