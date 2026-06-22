/**
 * readOnly モードで Markdown プレビューが効かない回帰バグの予防テスト。
 *
 * 背景:
 *   3 つの編集ダイアログ (knowledge / risk / retrospective) は、参照専用モード時に
 *   `<fieldset disabled={readOnly}>` の中に `<MarkdownTextarea>` を配置していた。
 *   HTML 仕様 (https://html.spec.whatwg.org/multipage/form-elements.html#the-fieldset-element)
 *   により `<fieldset disabled>` 配下の `<button>` はネイティブ disabled となるため、
 *   `<MarkdownTextarea>` 内の「プレビュー / 差分」トグルが効かず、ユーザは Markdown
 *   ソースを生で見ることになっていた。
 *
 *   報告経路: 全ナレッジ画面で「Azure DevOps における $ 文字の表示崩れ」ナレッジを
 *   開いたとき、`### 問題点` などが Markdown レンダリングされず textarea に生で
 *   表示されていた (2026-05-23 報告)。
 *
 * 修正方針 (AllMemosClient の見本パターン):
 *   readOnly 時は `<MarkdownTextarea>` ではなく `<MarkdownDisplay>` を直接配置する。
 *   `<MarkdownDisplay>` は単なる div 描画のため、親 `<fieldset disabled>` の影響を
 *   受けず、Markdown 構文が常に整形表示される。
 *   参考: src/app/(dashboard)/all-memos/all-memos-client.tsx 225-243
 *
 * 本テストの役割:
 *   - 3 dialog のソースに `readOnly ? <MarkdownDisplay` 分岐があることを source-text
 *     ベースで担保 (= 将来の編集で誤って <MarkdownTextarea> 単独に戻されない)
 *   - import 文に `MarkdownDisplay` が含まれることを担保
 *   - `<fieldset disabled={readOnly}>` の構造が維持されていることを担保 (これを外す
 *     場合は別途、保存ボタン非表示・入力禁止の代替策を要するため、撤去時は明示的に
 *     本テストを更新するレビュー機会を強制する)
 *
 * 失敗時の対応:
 *   このテストが落ちたら、3 dialog のうちいずれかで readOnly モードの Markdown 表示が
 *   壊れている可能性が高い。実画面 (`/knowledge`、`/risks`、`/issues`、
 *   `/retrospectives` の他者作成行クリック) で目視確認してから対応すること。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const DIALOG_DIR = __dirname;

type DialogSpec = {
  filename: string;
  /** dialog 内で readOnly 分岐すべき Markdown フィールド数 */
  expectedFieldCount: number;
  /** dialog の論理名 (失敗時のメッセージ用) */
  label: string;
};

const TARGET_DIALOGS: DialogSpec[] = [
  {
    filename: 'knowledge-edit-dialog.tsx',
    expectedFieldCount: 3, // 背景 / 内容 / 結果
    label: 'KnowledgeEditDialog (全ナレッジ readOnly)',
  },
  {
    filename: 'risk-edit-dialog.tsx',
    expectedFieldCount: 1, // 内容
    label: 'RiskEditDialog (全リスク/全課題 readOnly)',
  },
  {
    filename: 'retrospective-edit-dialog.tsx',
    expectedFieldCount: 5, // 計画 / 実績 / Good / 問題 / 改善 (ループで 1 箇所だがレンダ 5 回)
    label: 'RetrospectiveEditDialog (全振り返り readOnly)',
  },
];

describe('readOnly モードで Markdown プレビューが効かない回帰バグの予防', () => {
  for (const { filename, expectedFieldCount, label } of TARGET_DIALOGS) {
    describe(`${label}: ${filename}`, () => {
      const source = readFileSync(join(DIALOG_DIR, filename), 'utf8');

      it('MarkdownDisplay を import している', () => {
        // import 文は 1 行または複数行になりうるが、いずれにせよ
        // `MarkdownDisplay` と `markdown-textarea` の両方が同一 import 句に含まれること。
        expect(source).toMatch(
          /import\s+\{[^}]*\bMarkdownDisplay\b[^}]*\}\s+from\s+['"]@\/components\/ui\/markdown-textarea['"]/,
        );
      });

      it('readOnly ? <MarkdownDisplay 分岐パターンを持つ', () => {
        // readOnly 時に MarkdownDisplay を返す三項演算子の出現回数で判定。
        // (loop 内で 1 箇所のみ書かれる retrospective は出現が 1 回でも 5 フィールドを
        //  カバーする。よって最低 1 箇所以上を担保し、knowledge/risk は分岐回数も検証する。)
        const branches = source.match(/readOnly\s*\?\s*\([\s\S]{0,300}?<MarkdownDisplay\b/g) ?? [];
        expect(
          branches.length,
          `readOnly ? <MarkdownDisplay 分岐が見つからない (${label})。<fieldset disabled> 配下の <MarkdownTextarea> は readOnly 時にプレビューが効かないため、分岐が必要。`,
        ).toBeGreaterThanOrEqual(1);

        // フィールド数と分岐回数の整合チェック (loop で 1 箇所表記の場合は 1 でも OK)。
        // 「分岐回数 1 (loop 内) or 分岐回数 = フィールド数」のいずれかを許容。
        const ok = branches.length === 1 || branches.length === expectedFieldCount;
        expect(
          ok,
          `分岐回数 ${branches.length} は想定 (1 loop or ${expectedFieldCount} field) と一致しない。フィールド追加・削除があった可能性。`,
        ).toBe(true);
      });

      it('<fieldset disabled={readOnly}> 構造を維持している (撤去時はレビュー強制)', () => {
        // この fieldset を外すと「入力禁止 / 保存ボタン非表示」の責務が壊れる。
        // 撤去するには本テストを明示的に更新する必要がある (= レビュー機会の強制)。
        expect(source).toMatch(/<fieldset\s+disabled=\{readOnly\}/);
      });

      it('生の <MarkdownTextarea> が readOnly 分岐なしで残っていない', () => {
        // 「<MarkdownTextarea> の直前に readOnly 三項演算子があるか」を見るのではなく、
        // 「<MarkdownTextarea> の出現箇所がすべて readOnly 分岐の falsy 側に位置するか」を
        // 簡易判定する: 「`: (` の直後数行以内にある <MarkdownTextarea」が、ファイル中の
        // 全 <MarkdownTextarea> 出現数と一致すること。
        const allUsages = source.match(/<MarkdownTextarea\b/g) ?? [];
        const inFalsyBranch = source.match(/:\s*\(\s*<MarkdownTextarea\b/g) ?? [];
        expect(
          inFalsyBranch.length,
          `<MarkdownTextarea> が readOnly 分岐の falsy 側 (: (...)) 外で使われている。fieldset disabled 配下では readOnly 時にプレビューボタンが効かなくなる。`,
        ).toBe(allUsages.length);
      });
    });
  }

  it('MemoViewDialog (見本実装) が同様のパターンを維持している (横展開元の保護)', () => {
    // 修正の見本にした全メモ画面の参照ダイアログが将来書き換えられて見本パターンが失われていない
    // ことを確認。失われた場合、本テストが落ちて修正方針の根拠が消えたことに気付ける。
    //
    // 2026-05-24 (feat/all-list-section-unification): all-memos-client.tsx 内の `<Dialog>` 直書きを
    // 専用 component (MemoViewDialog) に抽出した。本テストの参照先もそれに追随。
    const memoSource = readFileSync(
      join(DIALOG_DIR, '../../app/(dashboard)/all-memos/memo-view-dialog.tsx'),
      'utf8',
    );
    expect(memoSource).toMatch(/<fieldset\s+disabled\b/);
    expect(memoSource).toMatch(/<MarkdownDisplay\b/);
    expect(memoSource).toMatch(
      /import\s+\{[^}]*\bMarkdownDisplay\b[^}]*\}\s+from\s+['"]@\/components\/ui\/markdown-textarea['"]/,
    );
  });
});

/**
 * v1.4.0 横展開 Markdown 表示退行防止テスト。
 *
 * コメント以外で MarkdownDisplay を導入した箇所が
 * 将来の編集で linkifyNodes 直挿入に戻らないことを担保する。
 */
describe('v1.4.0 横展開 Markdown 表示退行防止', () => {
  it('SystemBannerBar が MarkdownDisplay を import して使用している', () => {
    const src = readFileSync(
      join(DIALOG_DIR, '../../components/system-banner-bar.tsx'),
      'utf8',
    );
    expect(src).toMatch(
      /import\s+\{[^}]*\bMarkdownDisplay\b[^}]*\}\s+from\s+['"]@\/components\/ui\/markdown-textarea['"]/,
    );
    expect(src).toMatch(/<MarkdownDisplay\b/);
    // linkifyNodes を直接 import していないこと (MarkdownDisplay 内部経路のみで使う)
    expect(src).not.toMatch(/import\s+\{[^}]*\blinkifyNodes\b[^}]*\}\s+from/);
  });

  it('CustomerDetailClient が MarkdownDisplay と MarkdownTextarea を import して使用している', () => {
    const src = readFileSync(
      join(DIALOG_DIR, '../../app/(dashboard)/customers/[customerId]/customer-detail-client.tsx'),
      'utf8',
    );
    expect(src).toMatch(
      /import\s+\{[^}]*\bMarkdownDisplay\b[^}]*\}\s+from\s+['"]@\/components\/ui\/markdown-textarea['"]/,
    );
    expect(src).toMatch(/<MarkdownDisplay\b/);
    expect(src).toMatch(/<MarkdownTextarea\b/);
    // linkifyNodes を直接 import していないこと
    expect(src).not.toMatch(/import\s+\{[^}]*\blinkifyNodes\b[^}]*\}\s+from/);
  });

  it('BannersListClient が MarkdownDisplay を import して使用している', () => {
    const src = readFileSync(
      join(DIALOG_DIR, '../../app/(dashboard)/admin/super/banners/banners-list-client.tsx'),
      'utf8',
    );
    expect(src).toMatch(
      /import\s+\{[^}]*\bMarkdownDisplay\b[^}]*\}\s+from\s+['"]@\/components\/ui\/markdown-textarea['"]/,
    );
    expect(src).toMatch(/<MarkdownDisplay\b/);
  });
});
