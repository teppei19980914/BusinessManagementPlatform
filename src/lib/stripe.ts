/**
 * Stripe SDK 初期化 + feature flag + 環境変数ヘルパ (PR-S2 / 2026-05-14)
 *
 * 役割:
 *   - Stripe SDK の singleton 初期化 (= 全サービス層から共通利用)
 *   - feature flag (STRIPE_ENABLED) で機能の有効/無効を一元制御
 *   - 環境変数 (Price ID 群、Webhook secret) の取得ヘルパ
 *
 * 設計方針:
 *   - **環境変数未設定でもエラーにしない**: 起動失敗を防ぐため、`getStripe()` 等は
 *     未設定時に null / throw する設計。STRIPE_ENABLED=false のときは呼ばれない前提
 *   - **API バージョン固定**: `2024-12-18.acacia` を固定参照 (= ADR-0006 で確定)
 *   - **Test / Production の自動切替**: `STRIPE_SECRET_KEY` の値 (sk_test_xxx / sk_live_xxx)
 *     で自動的に環境が切り替わる (Stripe SDK の標準挙動)
 *
 * 関連:
 *   - 仕様: docs/business/STRIPE_BILLING.md §7.2 (環境変数)
 *   - 詳細設計: docs/design/STRIPE_TECHNICAL_DESIGN.md §E-3
 *   - 設定手順: docs/operations/STRIPE_SETUP.md
 */

import Stripe from 'stripe';

/**
 * Stripe Metered Billing 機能の有効/無効を制御する feature flag。
 *
 * - `STRIPE_ENABLED=true`: クレジットカード払い機能を完全有効化 (= UI 表示、API 受付、Webhook 処理)
 * - それ以外 (= 未設定 / 'false' 等): 全機能を無効化 (UI 非表示、API は 503 返却、Webhook は 503)
 *
 * 設計:
 *   - 環境変数の文字列値で判定 ('true' のみ true、他はすべて false)
 *   - PR-S5 マージ後も `STRIPE_ENABLED=false` が default なので顧客には見えない
 *   - Stripe Dashboard 設定 + 動作確認後に Vercel で `STRIPE_ENABLED=true` を設定して公開
 */
export function isStripeEnabled(): boolean {
  return process.env['STRIPE_ENABLED'] === 'true';
}

/**
 * Stripe API バージョン (= ADR-0006 / PR-V8 で更新)。
 *
 * 2026-05-19 (PR-V8): 旧 `2024-12-18.acacia` から `2026-04-22.dahlia` に更新。
 *   理由: 2025+ の Stripe Sandbox / Live 新規アカウントでは旧 API バージョンが選択不可。
 *   合わせて Usage Record API を `subscriptionItems.createUsageRecord` (= legacy) から
 *   `billing.meterEvents.create` (= Meter API) に移行 (reportUsage 関数を参照)。
 */
export const STRIPE_API_VERSION = '2026-04-22.dahlia' as const;

/**
 * Stripe Meter event 名 (= Stripe Dashboard で Meter 作成時に設定した event_name と完全一致必須)。
 *
 * 旧 Subscription Item ID ベースの Usage Record API から、Meter API (= billing.meterEvents.create)
 * への移行に伴い導入 (PR-V8 / 2026-05-19)。
 *
 * 設計:
 *   - Stripe Dashboard 設定: 商品カタログ → メーター → 「イベント名」フィールド
 *   - Haiku per-call (Expert / Beginner plan の billable call) → 'tasukiba_haiku_api_call'
 *   - Sonnet per-call (Pro plan の billable call) → 'tasukiba_sonnet_api_call'
 *   - Storage プランは定額なので Meter 不要
 *
 *   ADR-0019 (2026-05-24): Meter event 名は据置 (= 既存 Stripe Dashboard 設定そのまま)。
 *     billable な featureUnit (= project-upsert / suggestion-explanation / auto-tag-extract) のみが
 *     本 Meter に投入される。無料 featureUnit (knowledge-embedding / chat-semantic-search 等) は
 *     withMeteredLLM 側で Stripe queue 投入をスキップする。
 *
 * 関連:
 *   - 設定手順: docs/operations/STRIPE_SETUP.md §2 (Meter 作成)
 *   - 送信側: src/services/stripe-billing.service.ts reportUsage()
 *   - キュー: src/services/stripe-usage-flush.service.ts
 */
export const STRIPE_METER_EVENT_NAMES = {
  haiku: 'tasukiba_haiku_api_call',
  sonnet: 'tasukiba_sonnet_api_call',
  // ADR-0020 (2026-05-25): DB 容量従量課金。
  //   R6 案 A: Meter unit = ¥1 (= quantity に円整数を送る、Stripe Price は ¥1/unit)。
  //   これにより ApiCallLog.costJpy = Stripe Meter quantity = 請求金額の完全一致を保証。
  //   月額固定 SKU と異なり Meter Event なので「使用量に応じた請求」が請求書に反映される。
  db_capacity_overage: 'tasukiba_db_capacity_overage_jpy',
} as const;

export type StripeMeterCallType = keyof typeof STRIPE_METER_EVENT_NAMES;

/**
 * Stripe SDK の singleton インスタンス。
 *
 * - 初回呼出時に lazy 初期化
 * - `STRIPE_SECRET_KEY` 未設定なら throw (= 呼出側で feature flag チェック済の前提)
 * - Test mode (sk_test_xxx) と Live mode (sk_live_xxx) は環境変数の値で自動切替
 */
let stripeClient: Stripe | null = null;

export function getStripe(): Stripe {
  if (stripeClient != null) return stripeClient;
  const secretKey = process.env['STRIPE_SECRET_KEY'];
  if (secretKey == null || secretKey.length === 0) {
    throw new Error(
      'STRIPE_SECRET_KEY is not configured. Stripe API calls are disabled. ' +
        'Check feature flag (isStripeEnabled()) before invoking Stripe operations.',
    );
  }
  stripeClient = new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION as unknown as Stripe.LatestApiVersion,
    typescript: true,
    maxNetworkRetries: 2,
    timeout: 20_000, // 20 秒 (= 顧客同期 API の応答性確保)
    appInfo: {
      name: 'tasukiba-knowledge-relay',
      version: '1.x',
    },
  });
  return stripeClient;
}

/**
 * テスト時にクライアントをリセットするためのヘルパ (= 環境変数を変えてから再初期化する場合)。
 * production コードからは呼ばないこと。
 */
export function resetStripeClient(): void {
  stripeClient = null;
}

// ============================================================
// 環境変数ヘルパ (= Price ID / Webhook Secret / 他)
// ============================================================

/**
 * Stripe Webhook の署名検証用 secret。
 * - Stripe Dashboard → Webhooks → 各エンドポイント → "Signing secret"
 * - `whsec_xxx` 形式
 */
export function getStripeWebhookSecret(): string {
  const secret = process.env['STRIPE_WEBHOOK_SECRET'];
  if (secret == null || secret.length === 0) {
    throw new Error(
      'STRIPE_WEBHOOK_SECRET is not configured. Webhook signature verification cannot proceed.',
    );
  }
  return secret;
}

/**
 * Price ID 群 (= Stripe Dashboard で事前に作成、環境変数で参照する)。
 *
 * 単価表 (ADR-0019 / 2026-05-24 改定後):
 *   - Haiku per-call (Expert plan): **¥10/call**、Metered (ADR-0019 改定: ¥5 → ¥10)
 *   - Sonnet per-call (Pro plan): ¥15/call、Metered (据置)
 *   - Storage Plus: ¥500/月、Recurring 固定額
 *   - Storage Pro: ¥1,500/月、Recurring 固定額
 *
 * 価格改定の運用作業 (ADR-0019 反映時):
 *   1. Stripe Dashboard で新 Haiku Price (¥10/call) を発行 (既存 Meter 'tasukiba_haiku_api_call' 紐付け)
 *   2. 旧 Price (¥5/call) は archive する (削除はしない、過去 Invoice 参照保持のため)
 *   3. Netlify env settings の `STRIPE_PRICE_HAIKU` を新 Price ID に切替
 *   4. 既存 active Subscription があれば Subscription Item の Price 差し替え
 *   (詳細手順は docs/operations/STRIPE_SETUP.md を参照)
 *
 * テスト/本番で異なる ID を持つため、環境ごとに Netlify で別途登録する。
 */
export type StripePriceConfig = {
  haiku: string;
  sonnet: string;
  storagePlus: string;
  storagePro: string;
};

export function getStripePriceConfig(): StripePriceConfig {
  const haiku = process.env['STRIPE_PRICE_HAIKU'];
  const sonnet = process.env['STRIPE_PRICE_SONNET'];
  const storagePlus = process.env['STRIPE_PRICE_STORAGE_PLUS'];
  const storagePro = process.env['STRIPE_PRICE_STORAGE_PRO'];

  if (haiku == null || sonnet == null || storagePlus == null || storagePro == null) {
    throw new Error(
      'STRIPE_PRICE_* environment variables are not all configured. ' +
        'Required: STRIPE_PRICE_HAIKU, STRIPE_PRICE_SONNET, STRIPE_PRICE_STORAGE_PLUS, STRIPE_PRICE_STORAGE_PRO',
    );
  }

  return { haiku, sonnet, storagePlus, storagePro };
}

/**
 * Storage add-on plan 名から対応する Stripe Price ID を解決。
 *
 * - 'standard' = ¥0 (= Stripe Subscription Item を作らない)
 * - 'plus' = STRIPE_PRICE_STORAGE_PLUS
 * - 'pro_storage' = STRIPE_PRICE_STORAGE_PRO
 *
 * @returns Price ID または null (= standard は Stripe 不要)
 */
export function getStoragePriceId(storageAddonPlan: string): string | null {
  if (storageAddonPlan === 'standard') return null;
  const config = getStripePriceConfig();
  if (storageAddonPlan === 'plus') return config.storagePlus;
  if (storageAddonPlan === 'pro_storage') return config.storagePro;
  // 想定外値は null (= Subscription Item を作らない、安全側)
  return null;
}

/**
 * 自動操作 (cron / Webhook ハンドラ) で監査ログに記録する `userId`。
 *
 * - 専用の `system` ユーザを seed で作成し、その UUID を環境変数 `SYSTEM_USER_ID` に登録
 * - 通常のログイン経路を持たない (= isActive=false で seed)
 * - 詳細: docs/design/STRIPE_TECHNICAL_DESIGN.md §D-2
 */
export function getSystemUserId(): string {
  const id = process.env['SYSTEM_USER_ID'];
  if (id == null || id.length === 0) {
    throw new Error(
      'SYSTEM_USER_ID is not configured. Required for Stripe Webhook / cron auditLog entries.',
    );
  }
  return id;
}
