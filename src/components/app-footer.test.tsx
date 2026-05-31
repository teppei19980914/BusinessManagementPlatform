/**
 * AppFooter のソースパターン回帰テスト
 * (初版 feat/app-version-changelog-footer / 2026-05-23,
 *  改 feat/app-header-footer-unification / 2026-05-24,
 *  改 feat/footer-auth-aware-links / 2026-05-31).
 *
 * 採用理由:
 *   vitest 設定が environment='node' で jsdom 非導入。同等方針で他 component test も
 *   source-pattern 検証している (KDD §5.X+114)。Server Component (async) かつ props 分岐の
 *   ため DOM レンダリングはせず、ソース文字列上の invariant で「何を表示し / 何を削ったか」を縛る。
 *
 * 2026-05-31 リライト方針 (認証状態で出し分け):
 *   - 共通情報 (常時表示): 製品ページ / 利用規約 / プライバシーポリシー / 運営者情報 / 特商法
 *     → すべて外部 LP アンカー (@/config/legal-versions の定数経由)。
 *   - ログイン後限定 (isAuthenticated): お知らせ (アプリ内 /announcements) / セキュリティ報告 (LP #security)。
 *   - 旧仕様で表示していた copyright / 最終更新日 / サービス情報 (/settings/about) は全廃。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FOOTER_FILE = join(__dirname, 'app-footer.tsx');
const source = readFileSync(FOOTER_FILE, 'utf8');

describe('AppFooter の構造 invariant (2026-05-31 認証出し分け仕様)', () => {
  it('<footer> 要素を持つ (semantic HTML)', () => {
    expect(source).toMatch(/<footer\b/);
  });

  it('mt-auto クラスを持つ (root layout の flex-col で最下段に押し下げる)', () => {
    expect(source).toMatch(/\bmt-auto\b/);
  });

  it('isAuthenticated prop を受け取り、データ属性に反映する', () => {
    expect(source).toMatch(/isAuthenticated/);
    expect(source).toMatch(/data-authenticated/);
  });
});

describe('AppFooter 共通情報リンク (ログイン前後で常時表示)', () => {
  it('LP アンカー定数を legal-versions から import している (二重管理防止)', () => {
    expect(source).toMatch(/from '@\/config\/legal-versions'/);
    expect(source).toMatch(/PRODUCT_USER_PAGE_URL/);
    expect(source).toMatch(/TERMS_URL/);
    expect(source).toMatch(/PRIVACY_URL/);
    expect(source).toMatch(/OPERATOR_INFO_URL/);
    expect(source).toMatch(/TOKUSHOHO_URL/);
  });

  it('共通情報の 5 ラベルを i18n キー経由で表示する', () => {
    expect(source).toMatch(/t\('productPage'\)/);
    expect(source).toMatch(/t\('terms'\)/);
    expect(source).toMatch(/t\('privacy'\)/);
    expect(source).toMatch(/t\('operatorInfo'\)/);
    expect(source).toMatch(/t\('tokushoho'\)/);
  });

  it('共通情報は外部 LP リンク (target=_blank + rel noopener noreferrer)', () => {
    expect(source).toMatch(/target="_blank"/);
    expect(source).toMatch(/rel="noopener noreferrer"/);
  });
});

describe('AppFooter ログイン後限定情報 (isAuthenticated 分岐内)', () => {
  it('isAuthenticated のときだけ お知らせ / セキュリティ報告 を出す条件分岐がある', () => {
    expect(source).toMatch(/\{isAuthenticated\s*&&/);
  });

  it('お知らせはアプリ内遷移 (next/link で /announcements)', () => {
    expect(source).toMatch(/from 'next\/link'/);
    expect(source).toMatch(/href="\/announcements"/);
    expect(source).toMatch(/t\('announcements'\)/);
  });

  it('セキュリティ報告は LP #security (SECURITY_REPORT_URL) へ外部遷移', () => {
    expect(source).toMatch(/SECURITY_REPORT_URL/);
    expect(source).toMatch(/t\('securityReport'\)/);
  });
});

describe('AppFooter から削減された要素 (退行防止)', () => {
  it('copyright / 最終更新日 (lastUpdated) を表示しない', () => {
    expect(source).not.toMatch(/copyright/);
    expect(source).not.toMatch(/lastUpdated/);
    expect(source).not.toMatch(/getReleaseDate/);
    expect(source).not.toMatch(/OPERATOR_LABEL/);
  });

  it('サービス情報リンク (/settings/about) への遷移が消えている (ページごと廃止)', () => {
    // docblock 内の廃止経緯コメントとしての言及は許容し、href / Link 属性としての
    // 実リンクが無いことだけを縛る (経緯説明まで消すと将来 drift の理由が失われるため)。
    expect(source).not.toMatch(/href="\/settings\/about"/);
    expect(source).not.toMatch(/href={['"`]\/settings\/about/);
    expect(source).not.toMatch(/t\('about'\)/);
  });

  it('バージョン / 更新履歴 (/changelog) は footer に持たない (AccountMenu へ移設)', () => {
    expect(source).not.toMatch(/href="\/changelog"/);
  });
});
