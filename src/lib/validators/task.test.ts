import { describe, it, expect } from 'vitest';
import { createTaskSchema, updateProgressSchema } from './task';

describe('createTaskSchema - アクティビティ', () => {
  const validActivity = {
    type: 'activity' as const,
    name: 'テストアクティビティ',
    category: 'development' as const,
    assigneeId: '550e8400-e29b-41d4-a716-446655440000',
    plannedStartDate: '2026-05-01',
    plannedEndDate: '2026-05-15',
    plannedEffort: 16,
  };

  it('有効なアクティビティを受け入れる', () => {
    expect(createTaskSchema.safeParse(validActivity).success).toBe(true);
  });

  it('名前が空の場合を拒否する', () => {
    expect(createTaskSchema.safeParse({ ...validActivity, name: '' }).success).toBe(false);
  });

  it('担当者が必須', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { assigneeId, ...noAssignee } = validActivity;
    expect(createTaskSchema.safeParse(noAssignee).success).toBe(false);
  });

  it('予定工数が0以下の場合を拒否する', () => {
    expect(createTaskSchema.safeParse({ ...validActivity, plannedEffort: 0 }).success).toBe(false);
  });

  it('有効な区分を全て受け入れる', () => {
    const categories = ['requirements', 'design', 'development', 'testing', 'review', 'management', 'other'];
    for (const c of categories) {
      expect(createTaskSchema.safeParse({ ...validActivity, category: c }).success).toBe(true);
    }
  });

  it('親タスクIDはオプション', () => {
    expect(createTaskSchema.safeParse({
      ...validActivity,
      parentTaskId: '550e8400-e29b-41d4-a716-446655440001',
    }).success).toBe(true);
  });
});

describe('createTaskSchema - ワークパッケージ', () => {
  const validWP = {
    type: 'work_package' as const,
    name: 'テストWP',
    category: 'development' as const,
  };

  it('有効なワークパッケージを受け入れる（担当者・日付・工数なし）', () => {
    expect(createTaskSchema.safeParse(validWP).success).toBe(true);
  });

  it('名前が空の場合を拒否する', () => {
    expect(createTaskSchema.safeParse({ ...validWP, name: '' }).success).toBe(false);
  });

  it('親タスクIDを指定できる', () => {
    expect(createTaskSchema.safeParse({
      ...validWP,
      parentTaskId: '550e8400-e29b-41d4-a716-446655440001',
    }).success).toBe(true);
  });
});

describe('createTaskSchema - type による分岐', () => {
  it('type 未指定の場合を拒否する', () => {
    const noType = { name: 'テスト', category: 'development' };
    expect(createTaskSchema.safeParse(noType).success).toBe(false);
  });

  it('無効な type を拒否する', () => {
    const invalid = { type: 'task', name: 'テスト', category: 'development' };
    expect(createTaskSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('updateProgressSchema', () => {
  const validInput = {
    progressRate: 50,
    actualEffort: 8,
    status: 'in_progress' as const,
  };

  it('有効な入力を受け入れる', () => {
    expect(updateProgressSchema.safeParse(validInput).success).toBe(true);
  });

  it('進捗率0を受け入れる', () => {
    expect(updateProgressSchema.safeParse({ ...validInput, progressRate: 0 }).success).toBe(true);
  });

  it('進捗率100を受け入れる', () => {
    expect(updateProgressSchema.safeParse({ ...validInput, progressRate: 100 }).success).toBe(true);
  });

  it('進捗率101を拒否する', () => {
    expect(updateProgressSchema.safeParse({ ...validInput, progressRate: 101 }).success).toBe(false);
  });

  it('有効なステータスを全て受け入れる', () => {
    for (const s of ['not_started', 'in_progress', 'completed', 'on_hold']) {
      expect(updateProgressSchema.safeParse({ ...validInput, status: s }).success).toBe(true);
    }
  });
});
