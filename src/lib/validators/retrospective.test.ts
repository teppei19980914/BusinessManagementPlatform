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

  // v1.3.0 軽量入力 (2026-06-19): visibility 連動の必須チェックを刷新。
  //   - 実施日 (conductedDate) は常に任意 (draft は default 補完、public でも必須化しない)
  //   - public では 5 セクション (計画総括/実績総括/良かった点/課題/改善事項) を必須化
  describe('visibility 連動の必須チェック (v1.3.0)', () => {
    it('visibility=draft (既定) + conductedDate 未指定なら default で当日日付が入る', () => {
      const withoutDate = { ...validInput };
      delete (withoutDate as { conductedDate?: string }).conductedDate;
      const parsed = createRetrospectiveSchema.safeParse(withoutDate);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.conductedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });

    it('conductedDate が不正形式なら拒否 (field レベルの形式検証は維持)', () => {
      expect(
        createRetrospectiveSchema.safeParse({ ...validInput, conductedDate: 'invalid-date' }).success,
      ).toBe(false);
    });

    it('visibility=public + conductedDate 未指定でも 5 セクションがあれば受入れ (v1.3.0: 実施日は常に任意)', () => {
      const withoutDate = { ...validInput, visibility: 'public' as const };
      delete (withoutDate as { conductedDate?: string }).conductedDate;
      expect(createRetrospectiveSchema.safeParse(withoutDate).success).toBe(true);
    });

    it('visibility=public で 5 セクションのいずれかが空なら拒否 (v1.3.0)', () => {
      for (const key of ['planSummary', 'actualSummary', 'goodPoints', 'problems', 'improvements'] as const) {
        expect(
          createRetrospectiveSchema.safeParse({ ...validInput, visibility: 'public', [key]: '' }).success,
        ).toBe(false);
      }
    });
  });
});

// PR #199: addCommentSchema は createCommentSchema (validators/comment.ts) に移行。
//   等価テストは src/lib/validators/comment.test.ts に新設。
