/**
 * stripe-error-messages の単体テスト (PR-S2 / 2026-05-14)
 *
 * 検証観点:
 *   - 主要 decline_code が日本語メッセージを返す
 *   - severity が high/medium/low に分類されている
 *   - null / undefined / 未知の code はデフォルトメッセージ
 */

import { describe, it, expect } from 'vitest';
import {
  getDeclineMessage,
  STRIPE_DECLINE_CODE_MESSAGES,
} from './stripe-error-messages';

describe('getDeclineMessage', () => {
  it('insufficient_funds → severity=high + 日本語', () => {
    const msg = getDeclineMessage('insufficient_funds');
    expect(msg.severity).toBe('high');
    expect(msg.ja).toContain('残高');
  });

  it('expired_card → severity=high + 有効期限の言及', () => {
    const msg = getDeclineMessage('expired_card');
    expect(msg.severity).toBe('high');
    expect(msg.ja).toContain('有効期限');
  });

  it('fraudulent → severity=medium', () => {
    const msg = getDeclineMessage('fraudulent');
    expect(msg.severity).toBe('medium');
  });

  it('processing_error → severity=low (= 一時的、再試行可)', () => {
    const msg = getDeclineMessage('processing_error');
    expect(msg.severity).toBe('low');
    expect(msg.ja).toContain('再試行');
  });

  it('null → デフォルトメッセージ (medium)', () => {
    const msg = getDeclineMessage(null);
    expect(msg.severity).toBe('medium');
    expect(msg.ja).toContain('詳細不明');
  });

  it('undefined → デフォルトメッセージ', () => {
    const msg = getDeclineMessage(undefined);
    expect(msg.ja).toContain('詳細不明');
  });

  it('未知の decline_code → デフォルトメッセージ', () => {
    const msg = getDeclineMessage('totally_unknown_code_xyz_123');
    expect(msg.ja).toContain('詳細不明');
  });
});

describe('STRIPE_DECLINE_CODE_MESSAGES', () => {
  it('主要 high severity コードが含まれている', () => {
    const required = [
      'insufficient_funds',
      'expired_card',
      'incorrect_cvc',
      'incorrect_number',
      'lost_card',
      'stolen_card',
    ];
    for (const code of required) {
      expect(STRIPE_DECLINE_CODE_MESSAGES[code]).toBeDefined();
      expect(STRIPE_DECLINE_CODE_MESSAGES[code]!.severity).toBe('high');
    }
  });

  it('low severity コードは再試行を示唆', () => {
    expect(STRIPE_DECLINE_CODE_MESSAGES['issuer_not_available']!.severity).toBe('low');
    expect(STRIPE_DECLINE_CODE_MESSAGES['issuer_not_available']!.ja).toContain('時間');
  });

  it('全エントリで severity が high/medium/low のいずれか', () => {
    for (const [code, msg] of Object.entries(STRIPE_DECLINE_CODE_MESSAGES)) {
      expect(['high', 'medium', 'low'], `code=${code}`).toContain(msg.severity);
      expect(msg.ja.length, `code=${code}`).toBeGreaterThan(0);
    }
  });
});
