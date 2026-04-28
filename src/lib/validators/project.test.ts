import { describe, it, expect } from 'vitest';
import { createProjectSchema, changeStatusSchema } from './project';

describe('createProjectSchema', () => {
  const validInput = {
    name: 'テストプロジェクト',
    customerId: '00000000-0000-4000-a000-000000000001',
    purpose: 'テスト目的',
    background: 'テスト背景',
    scope: 'テストスコープ',
    devMethod: 'scratch' as const,
    plannedStartDate: '2026-05-01',
    plannedEndDate: '2026-06-30',
  };

  it('有効な入力を受け入れる', () => {
    expect(createProjectSchema.safeParse(validInput).success).toBe(true);
  });

  it('プロジェクト名が空の場合を拒否する', () => {
    expect(createProjectSchema.safeParse({ ...validInput, name: '' }).success).toBe(false);
  });

  it('customerId が UUID でない場合を拒否する (PR #111-2)', () => {
    expect(
      createProjectSchema.safeParse({ ...validInput, customerId: 'not-a-uuid' }).success,
    ).toBe(false);
    expect(createProjectSchema.safeParse({ ...validInput, customerId: '' }).success).toBe(
      false,
    );
  });

  it('プロジェクト名が101文字の場合を拒否する', () => {
    expect(createProjectSchema.safeParse({ ...validInput, name: 'a'.repeat(101) }).success).toBe(false);
  });

  it('目的が2001文字の場合を拒否する', () => {
    expect(createProjectSchema.safeParse({ ...validInput, purpose: 'a'.repeat(2001) }).success).toBe(false);
  });

  it('無効な開発方式を拒否する', () => {
    expect(createProjectSchema.safeParse({ ...validInput, devMethod: 'agile' }).success).toBe(false);
  });

  it('有効な開発方式を全て受け入れる (PR-β: power_platform → low_code_no_code リネーム)', () => {
    for (const method of ['scratch', 'low_code_no_code', 'package', 'other']) {
      expect(createProjectSchema.safeParse({ ...validInput, devMethod: method }).success).toBe(true);
    }
  });

  it('PR-β / 項目 14: 有効な契約形態を全て受け入れる (null/undefined もOK)', () => {
    for (const contractType of ['quasi_mandate', 'lump_sum', 'ses', 'other']) {
      expect(createProjectSchema.safeParse({ ...validInput, contractType }).success).toBe(true);
    }
    expect(createProjectSchema.safeParse({ ...validInput, contractType: null }).success).toBe(true);
    expect(createProjectSchema.safeParse({ ...validInput }).success).toBe(true); // undefined
  });

  it('PR-β / 項目 14: 無効な契約形態を拒否する', () => {
    expect(createProjectSchema.safeParse({ ...validInput, contractType: 'unknown' }).success).toBe(false);
  });

  it('不正な日付形式を拒否する', () => {
    expect(createProjectSchema.safeParse({ ...validInput, plannedStartDate: '2026/05/01' }).success).toBe(false);
    expect(createProjectSchema.safeParse({ ...validInput, plannedStartDate: '20260501' }).success).toBe(false);
  });

  it('オプションフィールドは省略可能', () => {
    expect(createProjectSchema.safeParse(validInput).success).toBe(true);
  });

  it('タグ配列が50件を超える場合を拒否する', () => {
    const tags = Array.from({ length: 51 }, (_, i) => `tag${i}`);
    expect(createProjectSchema.safeParse({ ...validInput, techStackTags: tags }).success).toBe(false);
  });

  // PR #65 核心機能: processTags (工程タグ) 受入 + 上限検証
  it('processTags を受け入れる', () => {
    expect(
      createProjectSchema.safeParse({ ...validInput, processTags: ['要件定義', '設計'] }).success,
    ).toBe(true);
  });

  it('processTags が 51 件の場合を拒否する', () => {
    const tags = Array.from({ length: 51 }, (_, i) => `tag${i}`);
    expect(createProjectSchema.safeParse({ ...validInput, processTags: tags }).success).toBe(false);
  });
});

describe('changeStatusSchema', () => {
  it('有効なステータスを受け入れる', () => {
    const statuses = ['planning', 'estimating', 'scheduling', 'executing', 'completed', 'retrospected', 'closed'];
    for (const status of statuses) {
      expect(changeStatusSchema.safeParse({ status }).success).toBe(true);
    }
  });

  it('無効なステータスを拒否する', () => {
    expect(changeStatusSchema.safeParse({ status: 'draft' }).success).toBe(false);
    expect(changeStatusSchema.safeParse({ status: '' }).success).toBe(false);
  });
});
