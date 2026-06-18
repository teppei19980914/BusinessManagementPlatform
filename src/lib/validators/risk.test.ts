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

  // v1.3.0 軽量入力 (2026-06-19): 必須チェックを刷新。
  //   - draft / public とも件名 (title) は常に必須
  //   - public では title + occurrence / cause / responsePolicy / content を必須化
  it('visibility=draft でも空件名を拒否 (v1.3.0: 件名は常に必須)', () => {
    expect(createRiskSchema.safeParse({ ...validRisk, title: '' }).success).toBe(false);
  });

  it('visibility=public で空件名を拒否', () => {
    expect(
      createRiskSchema.safeParse({ ...validRisk, title: '', visibility: 'public' }).success,
    ).toBe(false);
  });

  it('件名が101文字の場合を拒否する', () => {
    expect(createRiskSchema.safeParse({ ...validRisk, title: 'a'.repeat(101) }).success).toBe(false);
  });

  // refactor/list-create-content-optional (2026-04-27 #6): 内容は任意化
  it('内容が空でも許容する (2026-04-27 仕様変更: 件名は必須、内容は任意)', () => {
    expect(createRiskSchema.safeParse({ ...validRisk, content: '' }).success).toBe(true);
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
    // v1.3.0: public 時は occurrence / cause / responsePolicy / content (Embedding 対象 ∩ UI 入力欄あり)
    //   を必須化したため、public ケースにはこれらを明示する (validRisk.content は既に非空)。
    const publicFields = { occurrence: 'サンプル事象', cause: 'サンプル原因', responsePolicy: 'サンプル対応策' };
    for (const v of ['draft', 'public']) {
      expect(
        createRiskSchema.safeParse({ ...validRisk, visibility: v, ...publicFields }).success,
      ).toBe(true);
    }
  });

  // feat/risk-issue-4-section (2026-05-26): occurrence の必須化テスト
  it('visibility=public で空 occurrence を拒否', () => {
    expect(
      createRiskSchema.safeParse({ ...validRisk, visibility: 'public', occurrence: '' }).success,
    ).toBe(false);
  });

  it('visibility=public で occurrence 指定なし (undefined) も拒否', () => {
    expect(
      createRiskSchema.safeParse({ ...validRisk, visibility: 'public' }).success,
    ).toBe(false);
  });

  it('visibility=draft なら空 occurrence を許容', () => {
    expect(
      createRiskSchema.safeParse({ ...validRisk, visibility: 'draft', occurrence: '' }).success,
    ).toBe(true);
  });

  it('visibility=public で cause / responsePolicy / content のいずれかが空なら拒否 (v1.3.0)', () => {
    const base = {
      ...validRisk,
      visibility: 'public' as const,
      occurrence: '事象',
      cause: '原因',
      responsePolicy: '対応策',
      content: 'メモ',
    };
    expect(createRiskSchema.safeParse({ ...base, cause: '' }).success).toBe(false);
    expect(createRiskSchema.safeParse({ ...base, responsePolicy: '' }).success).toBe(false);
    expect(createRiskSchema.safeParse({ ...base, content: '' }).success).toBe(false);
  });

  it('visibility=public + 必須項目 (件名/事象/原因/対応策/メモ) すべてあり → 受入れ (v1.3.0)', () => {
    expect(
      createRiskSchema.safeParse({
        ...validRisk,
        visibility: 'public',
        title: '件名',
        occurrence: '発生した事象',
        cause: '原因',
        responsePolicy: '対応策',
        content: 'メモ',
      }).success,
    ).toBe(true);
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
