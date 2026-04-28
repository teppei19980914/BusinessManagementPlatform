import { describe, it, expect } from 'vitest';
import { createTaskSchema, updateTaskSchema, updateProgressSchema, bulkUpdateTaskSchema } from './task';

describe('createTaskSchema - アクティビティ', () => {
  const validActivity = {
    type: 'activity' as const,
    name: 'テストアクティビティ',
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
  };

  it('有効なワークパッケージを受け入れる（名前のみ）', () => {
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
    expect(createTaskSchema.safeParse({ name: 'テスト' }).success).toBe(false);
  });

  it('無効な type を拒否する', () => {
    expect(createTaskSchema.safeParse({ type: 'task', name: 'テスト' }).success).toBe(false);
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

describe('bulkUpdateTaskSchema', () => {
  const validUUID = '550e8400-e29b-41d4-a716-446655440000';

  it('担当者のみの一括更新を受け入れる', () => {
    const input = { taskIds: [validUUID], assigneeId: validUUID };
    expect(bulkUpdateTaskSchema.safeParse(input).success).toBe(true);
  });

  it('優先度のみの一括更新を受け入れる', () => {
    const input = { taskIds: [validUUID], priority: 'high' as const };
    expect(bulkUpdateTaskSchema.safeParse(input).success).toBe(true);
  });

  it('担当者と優先度の同時更新を受け入れる', () => {
    const input = { taskIds: [validUUID, '550e8400-e29b-41d4-a716-446655440001'], assigneeId: validUUID, priority: 'low' as const };
    expect(bulkUpdateTaskSchema.safeParse(input).success).toBe(true);
  });

  it('空のtaskIdsを拒否する', () => {
    expect(bulkUpdateTaskSchema.safeParse({ taskIds: [], assigneeId: validUUID }).success).toBe(false);
  });

  it('無効なUUIDを拒否する', () => {
    expect(bulkUpdateTaskSchema.safeParse({ taskIds: ['not-a-uuid'], assigneeId: validUUID }).success).toBe(false);
  });

  it('無効な優先度を拒否する', () => {
    expect(bulkUpdateTaskSchema.safeParse({ taskIds: [validUUID], priority: 'urgent' }).success).toBe(false);
  });

  it('assigneeIdをnullにできる（担当者解除）', () => {
    const input = { taskIds: [validUUID], assigneeId: null };
    expect(bulkUpdateTaskSchema.safeParse(input).success).toBe(true);
  });

  it('101件以上のtaskIdsを拒否する', () => {
    const ids = Array.from({ length: 101 }, (_, i) =>
      `550e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}`);
    expect(bulkUpdateTaskSchema.safeParse({ taskIds: ids, priority: 'high' }).success).toBe(false);
  });

  it('100件のtaskIdsを受け入れる', () => {
    const ids = Array.from({ length: 100 }, (_, i) =>
      `550e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}`);
    expect(bulkUpdateTaskSchema.safeParse({ taskIds: ids, priority: 'high' }).success).toBe(true);
  });

  // --- 拡張: 編集系 / 実績系フィールドの一括更新 ---
  it('予定開始日・予定終了日の一括更新を受け入れる', () => {
    const input = {
      taskIds: [validUUID],
      plannedStartDate: '2026-05-01',
      plannedEndDate: '2026-05-31',
    };
    expect(bulkUpdateTaskSchema.safeParse(input).success).toBe(true);
  });

  it('予定工数の一括更新を受け入れる', () => {
    const input = { taskIds: [validUUID], plannedEffort: 8 };
    expect(bulkUpdateTaskSchema.safeParse(input).success).toBe(true);
  });

  it('ステータス・進捗率・実績開始日・実績終了日の一括更新を受け入れる', () => {
    const input = {
      taskIds: [validUUID],
      status: 'in_progress' as const,
      progressRate: 50,
      actualStartDate: '2026-05-01',
      actualEndDate: '2026-05-15',
    };
    expect(bulkUpdateTaskSchema.safeParse(input).success).toBe(true);
  });

  it('進捗率が 0-100 の範囲外を拒否する', () => {
    expect(
      bulkUpdateTaskSchema.safeParse({ taskIds: [validUUID], progressRate: 150 }).success,
    ).toBe(false);
    expect(
      bulkUpdateTaskSchema.safeParse({ taskIds: [validUUID], progressRate: -1 }).success,
    ).toBe(false);
  });

  it('無効なステータスを拒否する', () => {
    expect(
      bulkUpdateTaskSchema.safeParse({ taskIds: [validUUID], status: 'invalid_status' }).success,
    ).toBe(false);
  });

  it('無効な日付形式を拒否する', () => {
    expect(
      bulkUpdateTaskSchema.safeParse({ taskIds: [validUUID], plannedStartDate: '2026/05/01' })
        .success,
    ).toBe(false);
  });

  it('更新項目が一つも指定されていない場合を拒否する', () => {
    expect(bulkUpdateTaskSchema.safeParse({ taskIds: [validUUID] }).success).toBe(false);
  });

  it('実績開始日・終了日を null にできる（実績解除）', () => {
    const input = {
      taskIds: [validUUID],
      actualStartDate: null,
      actualEndDate: null,
    };
    expect(bulkUpdateTaskSchema.safeParse(input).success).toBe(true);
  });
});

describe('updateTaskSchema', () => {
  it('実績開始日・終了日を受け入れる', () => {
    const input = { actualStartDate: '2026-05-01', actualEndDate: '2026-05-15' };
    expect(updateTaskSchema.safeParse(input).success).toBe(true);
  });

  it('ステータスと進捗率を受け入れる', () => {
    const input = { status: 'in_progress' as const, progressRate: 50 };
    expect(updateTaskSchema.safeParse(input).success).toBe(true);
  });

  it('進捗率101を拒否する', () => {
    expect(updateTaskSchema.safeParse({ progressRate: 101 }).success).toBe(false);
  });

  it('無効なステータスを拒否する', () => {
    expect(updateTaskSchema.safeParse({ status: 'invalid' }).success).toBe(false);
  });

  it('不正な日付形式を拒否する', () => {
    expect(updateTaskSchema.safeParse({ actualStartDate: '2026/05/01' }).success).toBe(false);
  });

  it('種別をwork_packageに変更できる', () => {
    expect(updateTaskSchema.safeParse({ type: 'work_package' }).success).toBe(true);
  });

  it('種別をactivityに変更できる', () => {
    expect(updateTaskSchema.safeParse({ type: 'activity' }).success).toBe(true);
  });

  it('無効な種別を拒否する', () => {
    expect(updateTaskSchema.safeParse({ type: 'task' }).success).toBe(false);
  });
});

// (T-19 で削除) wbsTemplateSchema は旧 10 列テンプレートインポート用の schema。
// sync-import (7 列) に一本化したため、関連テストは task-sync-import.service.test.ts に集約。
