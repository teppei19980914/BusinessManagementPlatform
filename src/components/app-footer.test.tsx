/**
 * AppFooter のソースパターン回帰テスト
 * (初版 feat/app-version-changelog-footer / 2026-05-23,
 *  改 feat/app-header-footer-unification / 2026-05-24).
 *
 * 採用理由:
 *   vitest 設定が environment='node' で jsdom 非導入。同等方針で他 component test も
 *   source-pattern 検証している (KDD §5.X+114)。
 *
 * 2026-05-24 リライト方針:
 *   コンテンツ削減でリンク群と表示要素が大幅に変わったため、旧テストの「外部リンクは
 *   _blank + rel noopener」「version helper を参照」等は意味を失った。新仕様の
 *   invariant に書き換え、「画面圧迫を防ぐため何を削ったか」を明示的にテストで縛る。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FOOTER_FILE = join(__dirname, 'app-footer.tsx');
const source = readFileSync(FOOTER_FILE, 'utf8');

describe('AppFooter の構造 invariant (2026-05-24 改訂仕様)', () => {
  it('<footer> 要素を持つ (semantic HTML)', () => {
    expect(source).toMatch(/<footer\b/);
  });

  it('mt-auto クラスを持つ (root layout の flex-col で最下段に押し下げる)', () => {
    // body の `flex min-h-full flex-col` 構造に依存し children に flex-1 を要求しない
    // ことが本コンポーネントの設計上の前提。`mt-auto` が消えると children が短い画面で
    // footer が中央に浮く layout 不具合になる。
    expect(source).toMatch(/\bmt-auto\b/);
  });

  it('内部リンクは /settings/about と /announcements の 2 件のみ (削減仕様)', () => {
    expect(source).toMatch(/href="\/settings\/about"/);
    expect(source).toMatch(/href="\/announcements"/);
  });

  it('copyright + 最終更新日を残す (健全運営シグナルの最小単位)', () => {
    expect(source).toMatch(/copyright/);
    expect(source).toMatch(/lastUpdated/);
    expect(source).toMatch(/getReleaseDate/);
    expect(source).toMatch(/OPERATOR_LABEL/);
  });
});

describe('AppFooter から削減された要素 (退行防止)', () => {
  it('旧 1 段目 (サービス名 / バージョン / 運営者) が footer に再出現していない', () => {
    // ユーザ要望「画面上の表示項目を極力減らす」に従い 1 段目は完全削除済。
    // 「一貫性のため」「健全運営アピールのため」等の理由で誰かが復活させた場合に検知する。
    expect(source).not.toMatch(/formatVersionLabel/);
    expect(source).not.toMatch(/OPERATOR_NAME\b/); // OPERATOR_LABEL (copyright 用) は OK
    expect(source).not.toMatch(/operatorPrefix/);
  });

  it('旧 2 段目の外部リンク (TERMS / PRIVACY / CONTACT) が footer に再出現していない', () => {
    // これらは /settings/about (サービス情報) に集約されており、footer からは導線を提供
    // しないことが「玄関だけ提供」設計の核心。
    expect(source).not.toMatch(/TERMS_URL/);
    expect(source).not.toMatch(/PRIVACY_URL/);
    expect(source).not.toMatch(/CONTACT_FORM_URL/);
  });

  it('旧 2 段目の内部リンク /changelog が footer から消えている (about に集約済)', () => {
    expect(source).not.toMatch(/href="\/changelog"/);
  });

  it('外部リンク (target="_blank") が 1 つも残っていない', () => {
    // footer から外部リンクを全廃した結果、tabnabbing リスクの面でも安全になった。
    expect(source).not.toMatch(/target="_blank"/);
  });
});

describe('AppFooter の docblock 設計意図 (将来の drift 防止)', () => {
  it('auto-hide 対象外の理由を docblock に明記している', () => {
    // 「ヘッダと挙動が非対称」を理由に勝手に fixed-bottom + auto-hide 化されるのを防ぐ。
    // ChatFab / Toast との重なり対応が必須な点を明示している。
    expect(source).toMatch(/auto-hide 対象外/);
    expect(source).toMatch(/ChatSemanticSearchFab|fixed bottom/);
  });

  it('about ページへの集約意図を docblock に明記している', () => {
    expect(source).toMatch(/集約/);
  });
});
