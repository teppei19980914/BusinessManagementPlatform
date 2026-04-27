import { describe, it, expect } from 'vitest';
import { createRetrospectiveSchema, addCommentSchema } from './retrospective';

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
});

describe('addCommentSchema', () => {
  it('有効なコメントを受け入れる', () => {
    expect(addCommentSchema.safeParse({ content: 'コメント内容' }).success).toBe(true);
  });

  it('空のコメントを拒否する', () => {
    expect(addCommentSchema.safeParse({ content: '' }).success).toBe(false);
  });

  it('2001文字のコメントを拒否する', () => {
    expect(addCommentSchema.safeParse({ content: 'a'.repeat(2001) }).success).toBe(false);
  });
});
