/**
 * TOTP コード生成ヘルパー (PR #92)
 *
 * 役割:
 *   MFA 有効化フローで、設定画面に表示された「手動入力用のシークレットキー」を
 *   読み取り、現在時刻に対する 6 桁コードを生成する。
 *   MFA 付きログインの /login/mfa 画面でも同じシークレットから再生成する。
 *
 * 実装:
 *   アプリ本体で使用している otplib と同じライブラリ/設定を使用。
 *   時刻を跨ぐ 6 桁コードの境界問題を避けるため、呼び出し直前の「今」で生成する。
 */

import { generateSync } from 'otplib';

export function generateTotpCode(secret: string): string {
  return generateSync({ secret });
}
