/**
 * 利用規約・プライバシーポリシーのバージョン管理
 *
 * 規約・プラポリの本文は外部 LP (HomePage / tasukiba-user.md) に集約されている。
 * 本ファイルでは「現在有効なバージョン番号」と「LP の URL」のみを定数として持つ。
 *
 * バージョン更新時の手順:
 *   1. HomePage repo の tasukiba-user.md に新バージョンの本文と改定履歴を追記
 *   2. 本ファイルの CURRENT_TERMS_VERSION / CURRENT_PRIVACY_VERSION を更新
 *   3. (将来) 既存テナントへの再同意要求フローをトリガする通知システムを呼び出す
 *
 * 法的根拠:
 *   民法 548 条の 2 (定型約款の組入合意) を満たすため、サインアップ時に
 *   利用者がどのバージョンに同意したかを TenantConsentLog テーブルに不可変ログとして保存する。
 *
 * feat/legal-pages-lp-integration (2026-05-21)
 * feat/footer-auth-aware-links (2026-05-31): フッタ集約用の LP セクション URL を追加。
 */

/** 現在有効な利用規約のバージョン */
export const CURRENT_TERMS_VERSION = '1.0';

/** 現在有効なプライバシーポリシーのバージョン */
export const CURRENT_PRIVACY_VERSION = '1.0';

/** LP のベース URL (規約・プラポリの掲示先) */
export const LEGAL_DOC_BASE_URL =
  'https://teppei19980914.github.io/HomePage/ja/product/tasukiba-user/';

/** 利用規約セクションへのアンカー URL */
export const TERMS_URL = `${LEGAL_DOC_BASE_URL}#terms`;

/** プライバシーポリシーセクションへのアンカー URL */
export const PRIVACY_URL = `${LEGAL_DOC_BASE_URL}#privacy`;

/**
 * 製品ページ (利用者向け詳細ページ tasukiba-user) の URL。
 *
 * feat/footer-auth-aware-links (2026-05-31):
 *   フッタの「共通情報」(製品ページ / 規約 / プラポリ / 運営者情報 / 特商法) と
 *   「ログイン後限定情報」(セキュリティ報告) は、すべて本 LP ページの各セクション
 *   アンカーへ集約する (= サービス内に二重に持たず LP を単一真値にする方針)。
 *   `LEGAL_DOC_BASE_URL` (= tasukiba-user ページ) と同一実体だが、用途が「製品紹介」で
 *   「法務文書」ではないため別名で公開し、参照側の意図を明確にする。
 *
 * 注意: `community.ts` の `PRODUCT_LP_URL` は親ページ (tasukiba/) を指す別物。
 *   本定数は利用者向け詳細ページ (tasukiba-user/) で、規約等のアンカーを持つ側。
 */
export const PRODUCT_USER_PAGE_URL = LEGAL_DOC_BASE_URL;

/** 運営者情報セクションへのアンカー URL */
export const OPERATOR_INFO_URL = `${LEGAL_DOC_BASE_URL}#operator-info`;

/** 特定商取引法に基づく表記セクションへのアンカー URL */
export const TOKUSHOHO_URL = `${LEGAL_DOC_BASE_URL}#tokushoho`;

/**
 * セキュリティ報告 (脆弱性報告) セクションへのアンカー URL。
 *
 * feat/footer-auth-aware-links (2026-05-31):
 *   ログイン後フッタの「セキュリティ報告」リンク先。LP `#security` セクションに
 *   GitHub Security Advisory への導線を集約する (HomePage repo 側で同 PR にて新設)。
 *   実体は `@/config/operator` の `SECURITY_ADVISORY_URL` (advisories 直リンク) と
 *   重複しうるが、ユーザ向けには「説明文付きの LP セクション」を見せる方が親切なため
 *   フッタからは本アンカー経由とする。
 */
export const SECURITY_REPORT_URL = `${LEGAL_DOC_BASE_URL}#security`;

/** 同意タイプ (TenantConsentLog.consentType と一致) */
export const CONSENT_TYPES = {
  TERMS: 'terms',
  PRIVACY: 'privacy',
} as const;

export type ConsentType = (typeof CONSENT_TYPES)[keyof typeof CONSENT_TYPES];
