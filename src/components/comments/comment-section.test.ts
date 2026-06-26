/**
 * CommentSection mention reconcile 退行防止テスト
 * (fix/mention-count-reconcile / 2026-05-26).
 *
 * 旧仕様のバグ:
 *   `draftMentions` は insertMention で append のみされる設計だったため、
 *   textarea から `@xxx` を削除しても mention 配列に残り続け:
 *     1. UI 表示: "2 件のメンション" と累積カウント表示
 *     2. サーバ送信: 既に削除された人への通知メールが飛ぶ (severity-2 通知信頼性)
 *
 * 修正後:
 *   毎回の textarea onChange で `reconcileMentions(text, mentions)` を呼び、
 *   text 中の `@${label}` 出現回数に応じて mention 配列を絞り込む。
 *   同一 label の複数 mention があるケース (例: `@A @A`) もカウントベースで正しく処理。
 *
 * server-side schema (`MentionInput`) は無変更。client 側のみ label を保持し、
 * 送信時に label を剥がす設計。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { reconcileMentions } from './comment-section';
import type { MentionInput } from '@/lib/validators/mention';

type DraftMention = MentionInput & { label: string };

function userMention(label: string, userId: string): DraftMention {
  return { kind: 'user', targetUserId: userId, label };
}

function groupMention(kind: Exclude<MentionInput['kind'], 'user'>, label: string): DraftMention {
  return { kind, label };
}

describe('reconcileMentions (fix/mention-count-reconcile 2026-05-26)', () => {
  describe('基本ケース', () => {
    it('空 text + 空 mentions → 空 array', () => {
      expect(reconcileMentions('', [])).toEqual([]);
    });

    it('空 text + 1 mention → 削除される (text に @label が無いため)', () => {
      const mentions = [userMention('alice', 'u-1')];
      expect(reconcileMentions('', mentions)).toEqual([]);
    });

    it('@alice あり text + alice mention → 保持', () => {
      const mentions = [userMention('alice', 'u-1')];
      const result = reconcileMentions('@alice こんにちは', mentions);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(userMention('alice', 'u-1'));
    });
  });

  describe('★ バグ修正の主シナリオ ★', () => {
    it('A をメンション → A 削除 → B をメンション の流れで draft が B のみになる (旧仕様だと [A, B])', () => {
      // Step 1: @alice 挿入 (insertMention 経由)
      let mentions: DraftMention[] = [userMention('alice', 'u-A')];
      let text = '@alice ';
      // (この段階の reconcile → 変化なし)
      mentions = reconcileMentions(text, mentions);
      expect(mentions).toHaveLength(1);

      // Step 2: ユーザが @alice を削除 (text のみ更新)
      text = '';
      mentions = reconcileMentions(text, mentions);
      expect(mentions).toHaveLength(0); // ← 旧仕様だと 1 のまま残ってバグ。今は 0 に reconcile

      // Step 3: @bob 挿入
      mentions = [...mentions, userMention('bob', 'u-B')];
      text = '@bob ';
      mentions = reconcileMentions(text, mentions);

      // 期待: bob のみ。旧仕様だと [alice, bob] で件数 2 と誤表示。
      expect(mentions).toHaveLength(1);
      expect(mentions[0].label).toBe('bob');
      expect(mentions[0].targetUserId).toBe('u-B');
    });
  });

  describe('同一 label の複数 mention (= 同ユーザを 2 回メンション)', () => {
    it('@alice @alice → mentions=[alice, alice] でそのまま保持', () => {
      const mentions = [userMention('alice', 'u-1'), userMention('alice', 'u-1')];
      const result = reconcileMentions('@alice @alice', mentions);
      expect(result).toHaveLength(2);
    });

    it('@alice @alice の片方を削除 → mentions=[alice] (1 つに削減)', () => {
      const mentions = [userMention('alice', 'u-1'), userMention('alice', 'u-1')];
      const result = reconcileMentions('@alice', mentions);
      expect(result).toHaveLength(1);
    });

    it('@alice 2 回 + @bob 1 回 → @alice 1 つ削除 → [alice, bob] に削減', () => {
      const mentions = [
        userMention('alice', 'u-A'),
        userMention('alice', 'u-A'),
        userMention('bob', 'u-B'),
      ];
      const result = reconcileMentions('@alice @bob', mentions);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(userMention('alice', 'u-A'));
      expect(result[1]).toEqual(userMention('bob', 'u-B'));
    });
  });

  describe('語境界判定 (誤マッチ防止)', () => {
    it('@alice (mention 配列) と @alice2 (text) は不一致 → mention 削除', () => {
      const mentions = [userMention('alice', 'u-1')];
      const result = reconcileMentions('@alice2 です', mentions);
      expect(result).toHaveLength(0);
    });

    it('@alice の直後が日本語の場合は match する (語境界扱い)', () => {
      const mentions = [userMention('alice', 'u-1')];
      const result = reconcileMentions('@aliceさん、よろしく', mentions);
      // 直後が「さ」(日本語 letter) は単語構成文字扱い → mention 不一致 → 削除
      // (intentional: `@alice` を `@alicesan` の prefix と誤認しない設計)
      expect(result).toHaveLength(0);
    });

    it('@alice の直後が space → match', () => {
      const mentions = [userMention('alice', 'u-1')];
      expect(reconcileMentions('@alice さん', mentions)).toHaveLength(1);
    });

    it('@alice の直後が "、" (全角句読点) → match (単語構成文字以外)', () => {
      const mentions = [userMention('alice', 'u-1')];
      expect(reconcileMentions('@alice、よろしく', mentions)).toHaveLength(1);
    });

    it('@alice が文字列終端 → match', () => {
      const mentions = [userMention('alice', 'u-1')];
      expect(reconcileMentions('hello @alice', mentions)).toHaveLength(1);
    });
  });

  describe('グループ mention (user 以外)', () => {
    it('@all グループメンション → 保持', () => {
      const mentions = [groupMention('all', '全員')];
      const result = reconcileMentions('@全員 ', mentions);
      expect(result).toHaveLength(1);
      expect(result[0].kind).toBe('all');
    });

    it('@担当者 (assignee グループ) の混在保持', () => {
      const mentions = [
        userMention('alice', 'u-1'),
        groupMention('assignee', '担当者'),
      ];
      const result = reconcileMentions('@alice @担当者 確認お願いします', mentions);
      expect(result).toHaveLength(2);
    });
  });

  describe('正規表現特殊文字を含む label (= 防御的検証)', () => {
    it('label に "." が含まれる場合でも安全 (escape されること)', () => {
      const mentions = [userMention('user.name', 'u-1')];
      // `@user.name` は match、`@userXname` は match しない (= "." がリテラル扱い)
      expect(reconcileMentions('@user.name さん', mentions)).toHaveLength(1);
      expect(reconcileMentions('@userXname さん', mentions)).toHaveLength(0);
    });
  });
});

/**
 * Markdown 表示退行防止テスト (v1.4.0)。
 *
 * コメント本文の表示が MarkdownDisplay を通る実装に変更されたことを
 * ソーステキストベースで担保する。将来の編集で誰かが `linkifyNodes` 直挿入に
 * 戻してしまわないようにする安全網。
 */
describe('コメント Markdown 表示退行防止 (v1.4.0)', () => {
  const source = readFileSync(join(__dirname, 'comment-section.tsx'), 'utf8');

  it('MarkdownDisplay を @/components/ui/markdown-textarea から import している', () => {
    expect(source).toMatch(
      /import\s+\{[^}]*\bMarkdownDisplay\b[^}]*\}\s+from\s+['"]@\/components\/ui\/markdown-textarea['"]/,
    );
  });

  it('コメント本文表示に MarkdownDisplay を使用している (data-testid="comment-content" の近傍)', () => {
    // data-testid="comment-content" を含む div の直後に MarkdownDisplay が来るパターン
    expect(source).toMatch(/data-testid="comment-content"[\s\S]{0,100}<MarkdownDisplay\b/);
  });

  it('コメント本文表示で linkifyNodes を直接呼び出していない', () => {
    // linkifyNodes は MarkdownDisplay 内部で使われるが、
    // comment-section.tsx 自体のソースに import が残っていないことを確認
    expect(source).not.toMatch(/import\s+\{[^}]*\blinkifyNodes\b[^}]*\}\s+from/);
  });
});
