/**
 * POST /api/auth/mfa/setup - MFA セットアップ開始 (QR コード生成)
 *
 * 役割:
 *   ユーザが MFA を有効化する第 1 段階。TOTP 秘密鍵を生成し QR コード画像 (data URL)
 *   と平文シークレットを返却する。この時点では mfaEnabled=false のままで、
 *   /api/auth/mfa/enable で TOTP 検証成功後に有効化される。
 *
 * 認可: getAuthenticatedUser (ログイン中ユーザ本人)
 *
 * 関連:
 *   - DESIGN.md §9.5 (MFA 設計 / TOTP / RFC 6238)
 *   - PR #67 (MFA ログイン強化)
 */

import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { generateMfaSecret } from '@/services/mfa.service';
import * as QRCode from 'qrcode';

export async function POST() {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { secret, otpauthUri } = await generateMfaSecret(user.id);
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUri);

  return NextResponse.json({
    data: { secret, qrCodeDataUrl },
  });
}
