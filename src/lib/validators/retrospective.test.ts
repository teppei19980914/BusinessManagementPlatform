import { describe, it, expect } from 'vitest';
import { createRetrospectiveSchema } from './retrospective';

describe('createRetrospectiveSchema', () => {
  const validInput = {
    conductedDate: '2026-04-15',
    planSummary: '計画通りに進行した',
    actualSummary: '概ね計画通りの実績',
    goodPoints: 'チームの連携が良かった',
    problems: '見積もりが甘かった',
    improvements: '次回はバッファを確保する',
  };

  it('有効な入力を受け入れる', () => {
    expect(createRetrospectiveSchema.safeParse(validInput).success).toBe(true);
  });

  it('実施日が不正な形式の場合を拒否する', () => {
    expect(createRetrospectiveSchema.safeParse({ ...validInput, conductedDate: '2026/04/15' }).success).toBe(false);
  });

  // refactor/list-create-content-optional (2026-04-27 #6): 5 セクションは任意化
  it('計画総括が空でも許容する (2026-04-27 仕様変更: セクションは任意)', () => {
    expect(createRetrospectiveSchema.safeParse({ ...validInput, planSummary: '' }).success).toBe(true);
  });

  it('良かった点が3001文字の場合を拒否する', () => {
    expect(createRetrospectiveSchema.safeParse({ ...validInput, goodPoints: 'a'.repeat(3001) }).success).toBe(false);
  });

  it('オプションフィールドを含む入力を受け入れる', () => {
    expect(createRetrospectiveSchema.safeParse({
      ...validInput,
      estimateGapFactors: '工数見積もりが不足',
      scheduleGapFactors: 'スケジュール遅延あり',
      qualityIssues: '品質問題なし',
      riskResponseEvaluation: 'リスク対応は適切',
      knowledgeToShare: '設計書の作り込みが重要',
    }).success).toBe(true);
  });

  // PR #60: 公開範囲フィールドを追加
  it('有効な公開範囲を受け入れる', () => {
    for (const v of ['draft', 'public']) {
      expect(createRetrospectiveSchema.safeParse({ ...validInput, visibility: v }).success).toBe(true);
    }
  });

  it('無効な公開範囲を拒否する', () => {
    expect(createRetrospectiveSchema.safeParse({ ...validInput, visibility: 'company' }).success).toBe(false);
  });

  // 2026-05-11: visibility 連動の必須チェック追加。
  //   - 「自分のみ」(draft) では conductedDate 未指定でも default で当日日付が補完される
  //   - 「全メンバー」(public) では conductedDate を明示入力する必要がある
  describe('visibility 連動の必須チェック (2026-05-11)', () => {
    it('visibility=draft (既定) + conductedDate 未指定なら default で当日日付が入る', () => {
      const { conductedDate: _, ...withoutDate } = validInput;
      const parsed = createRetrospectiveSchema.safeParse(withoutDate);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.conductedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });

    it('visibility=public + conductedDate が不正形式なら拒否', () => {
      expect(
        createRetrospectiveSchema.safeParse({
          ...validInput,
          visibility: 'public',
          conductedDate: 'invalid-date',
        }).success,
      ).toBe(false);
    });
  });
});

// PR #199: addCommentSchema は createCommentSchema (validators/comment.ts) に移行。
//   等価テストは src/lib/validators/comment.test.ts に新設。
