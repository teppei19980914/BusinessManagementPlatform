/**
 * メッセージカタログ整合性テスト (PR #77 Phase A)。
 *
 * 目的:
 *   - ja.json から将来 en.json を追加したとき、両者で「キー集合が一致」していることを保証する
 *   - 1 ロケールしかない現状でも、JSON の構造が想定どおり (action 配下に 9 アクション語) を確認
 *   - 将来 t('action.X') のミスタイプを実行時より早く検出する基盤
 *
 * 設計書: DESIGN.md §21.4.5 / DESIGN.md §30 (i18n 導入)
 */

import { describe, it, expect } from 'vitest';
import jaMessages from './messages/ja.json';

/** Phase A で必須となる action キー (PR #77 で導入)。 */
const REQUIRED_ACTION_KEYS = [
  'save',
  'cancel',
  'delete',
  'edit',
  'create',
  'back',
  'close',
  'today',
  'clear',
] as const;

/** Phase B で必須となる field キー (PR #81 で導入)。 */
const REQUIRED_FIELD_KEYS = [
  'title',
  'content',
  'body',
  'name',
  'displayName',
  'purpose',
  'background',
  'result',
  'assignee',
  'deadline',
  'visibility',
  'kind',
  'impact',
  'likelihood',
  'riskNature',
  'conductedDate',
  'plannedEndDate',
  'currentPassword',
  'newPassword',
  'newPasswordConfirm',
] as const;

/** Phase C で必須となる message キー (PR #81 で導入、#82 で拡張)。 */
const REQUIRED_MESSAGE_KEYS = [
  'saveSuccess',
  'saveFailed',
  'createFailed',
  'updateFailed',
  'deleteSuccess',
  'deleteFailed',
  'deleteConfirm',
  'fetchFailed',
  'validationError',
  'passwordChangeFailed',
  'passwordChanged',
  'noData',
  'loading',
] as const;

describe('messages catalog (ja)', () => {
  it('action 配下に Phase A 必須キーがすべて存在する', () => {
    const action = (jaMessages as { action?: Record<string, string> }).action ?? {};
    for (const key of REQUIRED_ACTION_KEYS) {
      expect(action[key], `action.${key} must be defined`).toBeTruthy();
      expect(typeof action[key], `action.${key} must be string`).toBe('string');
    }
  });

  it('action 配下に余計なキーが混入していない (既知集合との一致)', () => {
    const action = (jaMessages as { action?: Record<string, string> }).action ?? {};
    const actualKeys = Object.keys(action).sort();
    const expectedKeys = [...REQUIRED_ACTION_KEYS].sort();
    expect(actualKeys).toEqual(expectedKeys);
  });

  it('action 配下のすべての値が空文字でない', () => {
    const action = (jaMessages as { action?: Record<string, string> }).action ?? {};
    for (const [key, value] of Object.entries(action)) {
      expect(value.length, `action.${key} must not be empty`).toBeGreaterThan(0);
    }
  });

  it('field 配下に Phase B 必須キーがすべて存在する (PR #81)', () => {
    const field = (jaMessages as { field?: Record<string, string> }).field ?? {};
    for (const key of REQUIRED_FIELD_KEYS) {
      expect(field[key], `field.${key} must be defined`).toBeTruthy();
      expect(typeof field[key], `field.${key} must be string`).toBe('string');
    }
  });

  it('message 配下に Phase C 必須キーがすべて存在する (PR #81)', () => {
    const message = (jaMessages as { message?: Record<string, string> }).message ?? {};
    for (const key of REQUIRED_MESSAGE_KEYS) {
      expect(message[key], `message.${key} must be defined`).toBeTruthy();
      expect(typeof message[key], `message.${key} must be string`).toBe('string');
    }
  });
});
