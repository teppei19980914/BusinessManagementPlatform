/**
 * degraded-error-messages.ts の単体テスト (Q1 / 2026-05-14)
 *
 * 検証項目:
 *   - 一般ユーザは「テナント管理者へ相談」案内を含む
 *   - admin / super_admin は「設定 → テナント」など具体的対処手順を含む
 *   - rate_limited / llm_error はロール非依存 (個人ごとの待機 / 一時障害)
 */

import { describe, it, expect } from 'vitest';
import { getDegradedMessage } from './degraded-error-messages';

describe('getDegradedMessage', () => {
  describe('beginner_limit_exceeded', () => {
    it('admin 向けには「設定 → テナント」リンクを案内する', () => {
      const msg = getDegradedMessage('beginner_limit_exceeded', 'admin');
      expect(msg).toContain('設定');
      expect(msg).toContain('テナント');
      expect(msg).toMatch(/アップグレード|Expert|Pro/);
    });
    it('super_admin にも同じ admin 系メッセージを返す', () => {
      const adminMsg = getDegradedMessage('beginner_limit_exceeded', 'admin');
      const superMsg = getDegradedMessage('beginner_limit_exceeded', 'super_admin');
      expect(superMsg).toBe(adminMsg);
    });
    it('一般ユーザにはテナント管理者への相談導線を案内する', () => {
      const msg = getDegradedMessage('beginner_limit_exceeded', 'general');
      expect(msg).toContain('テナント管理者');
      expect(msg).not.toContain('設定 → テナント');
    });
  });

  describe('budget_exceeded', () => {
    it('admin 向けには月次予算上限引き上げの導線を案内する', () => {
      const msg = getDegradedMessage('budget_exceeded', 'admin');
      expect(msg).toContain('月次予算');
      expect(msg).toContain('引き上げる');
    });
    it('一般ユーザにはテナント管理者への相談導線を案内する', () => {
      const msg = getDegradedMessage('budget_exceeded', 'general');
      expect(msg).toContain('テナント管理者');
    });
  });

  describe('rate_limited / llm_error はロール非依存', () => {
    it('rate_limited は admin / general で同じメッセージ', () => {
      expect(getDegradedMessage('rate_limited', 'admin')).toBe(
        getDegradedMessage('rate_limited', 'general'),
      );
    });
    it('llm_error は admin / general で同じメッセージ', () => {
      expect(getDegradedMessage('llm_error', 'admin')).toBe(
        getDegradedMessage('llm_error', 'general'),
      );
    });
  });

  describe('plan_forbidden (Pro 限定機能)', () => {
    it('admin 向けには Pro へのアップグレード手順を案内する', () => {
      const msg = getDegradedMessage('plan_forbidden', 'admin');
      expect(msg).toContain('Pro');
      expect(msg).toContain('アップグレード');
    });
    it('一般ユーザには相談導線を案内する', () => {
      const msg = getDegradedMessage('plan_forbidden', 'general');
      expect(msg).toContain('テナント管理者');
    });
  });
});
