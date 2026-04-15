import { describe, it, expect } from 'vitest';
import { createTaskSchema, updateProgressSchema } from './task';

describe('createTaskSchema', () => {
  const validInput = {
    name: 'テストタスク',
    category: 'development' as const,
    assigneeId: '550e8400-e29b-41d4-a716-446655440000',
    plannedStartDate: '2026-05-01',
    plannedEndDate: '2026-05-15',
    plannedEffort: 16,
  };

  it('有効な入力を受け入れる', () => {
    expect(createTaskSchema.safeParse(validInput).success).toBe(true);
  });

  it('タスク名が空の場合を拒否する', () => {
    expect(createTaskSchema.safeParse({ ...validInput, name: '' }).success).toBe(false);
  });

  it('タスク名が101文字の場合を拒否する', () => {
    expect(createTaskSchema.safeParse({ ...validInput, name: 'a'.repeat(101) }).success).toBe(false);
  });

  it('有効な区分を全て受け入れる', () => {
    const categories = ['requirements', 'design', 'development', 'testing', 'review', 'management', 'other'];
    for (const c of categories) {
      expect(createTaskSchema.safeParse({ ...validInput, category: c }).success).toBe(true);
    }
  });

  it('無効な区分を拒否する', () => {
    expect(createTaskSchema.safeParse({ ...validInput, category: 'coding' }).success).toBe(false);
  });

  it('予定工数が0以下の場合を拒否する', () => {
    expect(createTaskSchema.safeParse({ ...validInput, plannedEffort: 0 }).success).toBe(false);
    expect(createTaskSchema.safeParse({ ...validInput, plannedEffort: -1 }).success).toBe(false);
  });

  it('担当者IDが無効なUUIDの場合を拒否する', () => {
    expect(createTaskSchema.safeParse({ ...validInput, assigneeId: 'not-a-uuid' }).success).toBe(false);
  });

  it('有効な優先度を受け入れる', () => {
    for (const p of ['low', 'medium', 'high']) {
      expect(createTaskSchema.safeParse({ ...validInput, priority: p }).success).toBe(true);
    }
  });

  it('親タスクIDはオプション', () => {
    expect(createTaskSchema.safeParse(validInput).success).toBe(true);
    expect(createTaskSchema.safeParse({
      ...validInput,
      parentTaskId: '550e8400-e29b-41d4-a716-446655440001',
    }).success).toBe(true);
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

  it('進捗率-1を拒否する', () => {
    expect(updateProgressSchema.safeParse({ ...validInput, progressRate: -1 }).success).toBe(false);
  });

  it('実績工数が負の場合を拒否する', () => {
    expect(updateProgressSchema.safeParse({ ...validInput, actualEffort: -1 }).success).toBe(false);
  });

  it('有効なステータスを全て受け入れる', () => {
    for (const s of ['not_started', 'in_progress', 'completed', 'on_hold']) {
      expect(updateProgressSchema.safeParse({ ...validInput, status: s }).success).toBe(true);
    }
  });

  it('オプションフィールドを含む入力を受け入れる', () => {
    const result = updateProgressSchema.safeParse({
      ...validInput,
      remainingEffort: 8,
      isDelayed: true,
      delayReason: '仕様変更のため',
      workMemo: '途中まで完了',
      hasIssue: false,
      nextAction: '残りの実装',
    });
    expect(result.success).toBe(true);
  });
});
