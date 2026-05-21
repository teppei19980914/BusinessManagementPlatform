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

/** 同意タイプ (TenantConsentLog.consentType と一致) */
export const CONSENT_TYPES = {
  TERMS: 'terms',
  PRIVACY: 'privacy',
} as const;

export type ConsentType = (typeof CONSENT_TYPES)[keyof typeof CONSENT_TYPES];
