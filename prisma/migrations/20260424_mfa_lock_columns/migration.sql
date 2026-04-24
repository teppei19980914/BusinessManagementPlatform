-- PR #116 (2026-04-24): MFA verify 専用のロックカラムを users テーブルに追加
--
-- 目的:
--   既存の failed_login_count / locked_until は「パスワード認証」失敗専用。
--   MFA verify (TOTP コード入力) にも同等のレート制限が必要だが、ロック原因と
--   解除経路 (MFA は recovery code で解除可、パスワードは不可) が異なるため
--   カラムを分離する。
--
-- 追加カラム:
--   - mfa_failed_count   INTEGER NOT NULL DEFAULT 0
--   - mfa_locked_until   TIMESTAMPTZ NULL
--
-- 仕様 (SPECIFICATION §13.8):
--   - 3 回連続失敗で mfa_locked_until = now() + 30 min
--   - 正解入力で mfa_failed_count = 0 + mfa_locked_until = NULL
--   - 恒久ロックは設けない (recovery code で解除可能)
--
-- 既存データへの影響:
--   - 全ユーザの mfa_failed_count = 0 / mfa_locked_until = NULL で初期化される
--   - ロック状態に入っていたユーザは居ないので動作影響なし

ALTER TABLE users
  ADD COLUMN mfa_failed_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN mfa_locked_until TIMESTAMPTZ;
