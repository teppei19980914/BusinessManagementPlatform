import { describe, it, expect } from 'vitest';
import { createRiskSchema, updateRiskSchema } from './risk';

describe('createRiskSchema', () => {
  const validRisk = {
    type: 'risk' as const,
    title: 'テストリスク',
    content: 'リスクの詳細内容',
    impact: 'high' as const,
    likelihood: 'medium' as const,
    priority: 'high' as const,
  };

  const validIssue = {
    type: 'issue' as const,
    title: 'テスト課題',
    content: '課題の詳細内容',
    impact: 'medium' as const,
    priority: 'medium' as const,
  };

  it('有効なリスクを受け入れる', () => {
    expect(createRiskSchema.safeParse(validRisk).success).toBe(true);
  });

  it('有効な課題を受け入れる', () => {
    expect(createRiskSchema.safeParse(validIssue).success).toBe(true);
  });

  it('件名が空の場合を拒否する', () => {
    expect(createRiskSchema.safeParse({ ...validRisk, title: '' }).success).toBe(false);
  });

  it('件名が101文字の場合を拒否する', () => {
    expect(createRiskSchema.safeParse({ ...validRisk, title: 'a'.repeat(101) }).success).toBe(false);
  });

  it('内容が空の場合を拒否する', () => {
    expect(createRiskSchema.safeParse({ ...validRisk, content: '' }).success).toBe(false);
  });

  it('内容が2001文字の場合を拒否する', () => {
    expect(createRiskSchema.safeParse({ ...validRisk, content: 'a'.repeat(2001) }).success).toBe(false);
  });

  it('無効な種別を拒否する', () => {
    expect(createRiskSchema.safeParse({ ...validRisk, type: 'bug' }).success).toBe(false);
  });

  it('有効な影響度を受け入れる', () => {
    for (const v of ['low', 'medium', 'high']) {
      expect(createRiskSchema.safeParse({ ...validRisk, impact: v }).success).toBe(true);
    }
  });

  it('担当者IDが有効なUUIDの場合を受け入れる', () => {
    expect(createRiskSchema.safeParse({
      ...validRisk,
      assigneeId: '550e8400-e29b-41d4-a716-446655440000',
    }).success).toBe(true);
  });

  it('担当者IDが無効なUUIDの場合を拒否する', () => {
    expect(createRiskSchema.safeParse({ ...validRisk, assigneeId: 'invalid' }).success).toBe(false);
  });

  it('期限が有効な日付形式の場合を受け入れる', () => {
    expect(createRiskSchema.safeParse({ ...validRisk, deadline: '2026-06-30' }).success).toBe(true);
  });

  // PR #60: 公開範囲とリスク脅威/好機分類
  it('有効な公開範囲を受け入れる', () => {
    for (const v of ['draft', 'public']) {
      expect(createRiskSchema.safeParse({ ...validRisk, visibility: v }).success).toBe(true);
    }
  });

  it('無効な公開範囲を拒否する', () => {
    expect(createRiskSchema.safeParse({ ...validRisk, visibility: 'private' }).success).toBe(false);
  });

  it('有効な riskNature (脅威/好機) を受け入れる', () => {
    for (const n of ['threat', 'opportunity']) {
      expect(createRiskSchema.safeParse({ ...validRisk, riskNature: n }).success).toBe(true);
    }
  });

  it('無効な riskNature を拒否する', () => {
    expect(createRiskSchema.safeParse({ ...validRisk, riskNature: 'neutral' }).success).toBe(false);
  });
});

describe('updateRiskSchema', () => {
  it('部分更新を受け入れる', () => {
    expect(updateRiskSchema.safeParse({ state: 'resolved' }).success).toBe(true);
    expect(updateRiskSchema.safeParse({ title: '更新タイトル' }).success).toBe(true);
  });

  it('有効な状態を受け入れる', () => {
    for (const s of ['open', 'in_progress', 'monitoring', 'resolved']) {
      expect(updateRiskSchema.safeParse({ state: s }).success).toBe(true);
    }
  });

  it('無効な状態を拒否する', () => {
    expect(updateRiskSchema.safeParse({ state: 'closed' }).success).toBe(false);
  });

  it('教訓を含む更新を受け入れる', () => {
    expect(updateRiskSchema.safeParse({
      state: 'resolved',
      result: '対応完了',
      lessonLearned: '早期検知が重要',
    }).success).toBe(true);
  });

  // §5.12 回帰防止: nullable 列に null を送ると 400 になっていた問題
  describe('§5.12: nullable 列は null を受理する (PR #138 後 hotfix の回帰防止)', () => {
    it('updateRiskSchema: assigneeId=null は受理する (担当者クリア)', () => {
      const r = updateRiskSchema.safeParse({ assigneeId: null });
      expect(r.success, JSON.stringify(r)).toBe(true);
    });

    it('updateRiskSchema: deadline=null は受理する (期日クリア)', () => {
      const r = updateRiskSchema.safeParse({ deadline: null });
      expect(r.success, JSON.stringify(r)).toBe(true);
    });

    it('updateRiskSchema: 全 nullable 列を null で送れる (visibility 編集時のフルペイロード相当)', () => {
      const r = updateRiskSchema.safeParse({
        title: 'テスト',
        content: '内容',
        impact: 'high',
        state: 'open',
        visibility: 'public',
        assigneeId: null,
        deadline: null,
        cause: null,
        likelihood: null,
        responsePolicy: null,
        responseDetail: null,
        riskNature: null,
        result: null,
        lessonLearned: null,
      });
      expect(r.success, JSON.stringify(r)).toBe(true);
    });

    it('updateRiskSchema: assigneeId=空文字 は拒否する (uuid バリデーション)', () => {
      // empty string は uuid format ではないので reject (期待動作)
      const r = updateRiskSchema.safeParse({ assigneeId: '' });
      expect(r.success).toBe(false);
    });
  });
});
