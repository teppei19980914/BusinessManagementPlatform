import { describe, it, expect } from 'vitest';
import { createKnowledgeSchema } from './knowledge';

describe('createKnowledgeSchema', () => {
  const validInput = {
    title: 'テストナレッジ',
    knowledgeType: 'research' as const,
    background: 'テスト背景',
    content: 'テスト内容',
    result: 'テスト結果',
    visibility: 'draft' as const,
  };

  it('有効な入力を受け入れる', () => {
    expect(createKnowledgeSchema.safeParse(validInput).success).toBe(true);
  });

  // v1.3.0 軽量入力 (2026-06-19): 必須チェックを刷新。
  //   - draft / public とも title は常に必須
  //   - public では title + 背景 / 内容 / 結果 (Embedding 対象 ∩ UI 入力欄あり) を必須化
  it('visibility=draft でも空タイトルを拒否 (v1.3.0: title は常に必須)', () => {
    expect(
      createKnowledgeSchema.safeParse({ ...validInput, title: '', visibility: 'draft' }).success,
    ).toBe(false);
  });

  it('visibility=public で空タイトルを拒否', () => {
    expect(
      createKnowledgeSchema.safeParse({ ...validInput, title: '', visibility: 'public' }).success,
    ).toBe(false);
  });

  it('visibility=public で背景 / 内容 / 結果のいずれかが空なら拒否 (v1.3.0)', () => {
    expect(
      createKnowledgeSchema.safeParse({ ...validInput, visibility: 'public', background: '' }).success,
    ).toBe(false);
    expect(
      createKnowledgeSchema.safeParse({ ...validInput, visibility: 'public', content: '' }).success,
    ).toBe(false);
    expect(
      createKnowledgeSchema.safeParse({ ...validInput, visibility: 'public', result: '' }).success,
    ).toBe(false);
  });

  it('visibility=public で title + 背景 / 内容 / 結果がすべて揃えば受入れ (v1.3.0)', () => {
    expect(createKnowledgeSchema.safeParse({ ...validInput, visibility: 'public' }).success).toBe(true);
  });

  it('タイトルが151文字の場合を拒否する', () => {
    expect(createKnowledgeSchema.safeParse({ ...validInput, title: 'a'.repeat(151) }).success).toBe(false);
  });

  it('有効なナレッジ種別を全て受け入れる', () => {
    const types = ['research', 'verification', 'incident', 'decision', 'lesson', 'best_practice', 'other'];
    for (const t of types) {
      expect(createKnowledgeSchema.safeParse({ ...validInput, knowledgeType: t }).success).toBe(true);
    }
  });

  // PR #60: 公開範囲を 2 値体系 (draft/public) に統合。project/company は migration で public に集約済。
  it('有効な公開範囲を全て受け入れる', () => {
    for (const v of ['draft', 'public']) {
      expect(createKnowledgeSchema.safeParse({ ...validInput, visibility: v }).success).toBe(true);
    }
  });

  it('無効な公開範囲を拒否する', () => {
    // 旧値 (project/company) は PR #60 以降受け付けない
    expect(createKnowledgeSchema.safeParse({ ...validInput, visibility: 'project' }).success).toBe(false);
    expect(createKnowledgeSchema.safeParse({ ...validInput, visibility: 'company' }).success).toBe(false);
    expect(createKnowledgeSchema.safeParse({ ...validInput, visibility: 'invalid' }).success).toBe(false);
  });

  it('内容が5001文字の場合を拒否する', () => {
    expect(createKnowledgeSchema.safeParse({ ...validInput, content: 'a'.repeat(5001) }).success).toBe(false);
  });

  it('結果が3001文字の場合を拒否する', () => {
    expect(createKnowledgeSchema.safeParse({ ...validInput, result: 'a'.repeat(3001) }).success).toBe(false);
  });

  it('オプションフィールドを含む入力を受け入れる', () => {
    const result = createKnowledgeSchema.safeParse({
      ...validInput,
      conclusion: 'テスト結論',
      recommendation: 'テスト推奨',
      reusability: 'high',
      techTags: ['Next.js', 'TypeScript'],
      devMethod: 'scratch',
      processTags: ['design', 'development'],
      projectIds: ['550e8400-e29b-41d4-a716-446655440000'],
    });
    expect(result.success).toBe(true);
  });

  it('タグ配列が50件を超える場合を拒否する', () => {
    const tags = Array.from({ length: 51 }, (_, i) => `tag${i}`);
    expect(createKnowledgeSchema.safeParse({ ...validInput, techTags: tags }).success).toBe(false);
  });
});
