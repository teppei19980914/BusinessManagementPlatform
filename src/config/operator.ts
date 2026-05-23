/**
 * 運営者情報の単一真値 (feat/app-version-changelog-footer / 2026-05-23)。
 *
 * フッター / /settings/about / /changelog / /announcements など、
 * 「このサービスを誰が運営しているか」を表示する全箇所からここを参照する。
 *
 * 法的位置付け:
 *   個人事業者 (適格請求書発行事業者非登録 = LP の tasukiba-user.md 記載)。
 *   契約形態は「オンライン申し込み + 利用規約同意ベース」(同 LP §契約形態)。
 *
 * 連絡経路:
 *   - 一般問い合わせ: LP contact form (種別「たすきばに関するお問い合わせ」)
 *   - セキュリティ報告: GitHub Security Advisory (推奨) または下記 email
 *
 * 既存設定との関係:
 *   - 利用規約 / プラポリ本文 URL は {@link './legal-versions'} の `TERMS_URL` / `PRIVACY_URL`
 *   - LP プロダクトページ URL は {@link './community'} の `PRODUCT_LP_URL`
 *   - 本ファイルは「人 (運営主体)」、上記は「文書」を扱う関心の分離
 */

/** 運営者氏名 (個人事業) */
export const OPERATOR_NAME = '須山 哲平';

/** 表示用の運営主体ラベル (フッタ等で「運営: たすきば運営」のように使う) */
export const OPERATOR_LABEL = 'たすきば運営';

/**
 * 一般問い合わせ窓口 (LP の contact form)。
 * 種別「たすきばに関するお問い合わせ」を選択することで本サービス関連として確実に受け取られる。
 */
export const CONTACT_FORM_URL = 'https://teppei19980914.github.io/HomePage/ja/contact/';

/**
 * セキュリティ報告先 email。GitHub Security Advisory が推奨経路だが、
 * email でも受付可能と LP に明記済 (tasukiba-user.md L277)。
 */
export const SECURITY_CONTACT_EMAIL = 'teppei09141998@gmail.com';

/**
 * GitHub Security Advisory 受付ページ (推奨経路)。
 * 本サービスのリポジトリは非公開のため、受付は LP repo 経由 (= 公開 repo)。
 */
export const SECURITY_ADVISORY_URL =
  'https://github.com/teppei19980914/HomePage/security/advisories';
