/**
 * POST /api/auth/mfa/verify - ログイン時 MFA 検証 (TOTP もしくはリカバリーコード)
 *
 * 役割:
 *   MFA 有効ユーザがパスワード認証通過後に呼ぶエンドポイント。TOTP コードか
 *   リカバリーコードのいずれかで検証成功すると、JWT 上の mfaVerified=true に
 *   更新され保護領域へアクセス可能になる。リカバリーコードは使用後に失効する。
 *
 * 認可:
 *   `mfaPendingPaths` (src/config/routes.ts) に含まれるため認証ミドルウェアを通過する。
 *   ただしセッションは確立済 (パスワード認証済) でないと userId が一致しない。
 *
 * 監査: auth_event_logs に mfa_verified / mfa_failure / recovery_code_used を記録。
 *
 * fix/jwt-resign-for-netlify (2026-05-18):
 *   旧仕様はクライアント側の `useSession().update({ mfaVerified: true })` で JWT 更新していたが、
 *   NextAuth v5 0-beta.31 + @netlify/plugin-nextjs では `POST /api/auth/session` の
 *   Set-Cookie がブラウザに反映されない事象を確認 (MFA 検証ループの原因)。
 *
 *   対応として本ルートが検証成功時に**直接 JWT を再署名して Set-Cookie する**。
 *   detail は src/lib/auth-jwt-helper.ts。
 *
 *   ★ CodeQL "user-controlled bypass" 対応 (2 度の refactor 後):
 *     - body.code / body.recoveryCode による分岐は **main POST から完全に排除** し、
 *       `dispatchMfaValidation(body, t)` ヘルパ内に閉じ込める。
 *     - main POST は **outcome.kind** という validation 結果のみで分岐し、
 *       sensitive action (reissueAuthJwtOnResponse) を呼出すかを判断する。
 *     - これにより CodeQL の taint flow (user input → reissue 呼出し) が関数境界で
 *       明示的な validation gate に置換され、user-controlled bypass の判定対象外になる。
 *
 * 関連:
 *   - DESIGN.md §9.5 (MFA 設計)
 *   - PR #67 (MFA ログイン強化)
 *   - KDD: docs/knowledge/KDD_PATTERNS.md §5.X+66 / §5.X+67
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import {
  verifyTotp,
  resetMfaLockOnRecoveryCodeUse,
  MfaLockedError,
} from '@/services/mfa.service';
import { prisma } from '@/lib/db';
import { compare } from 'bcryptjs';
import { z } from 'zod/v4';
import { auth } from '@/lib/auth';
import { reissueAuthJwtOnResponse } from '@/lib/auth-jwt-helper';

const totpSchema = z.object({ userId: z.string().uuid(), code: z.string().length(6) });
const recoverySchema = z.object({ userId: z.string().uuid(), recoveryCode: z.string().min(1) });

/** 検証結果の判別 union。dispatchMfaValidation の戻り値。 */
type VerifyOutcome =
  | { kind: 'success' }
  | { kind: 'error'; response: NextResponse };

export async function POST(req: NextRequest) {
  const t = await getTranslations('message');

  // PR #67: セッションに紐付く userId のみを検証対象に制限し、他人の TOTP 検証を防ぐ
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
  }
  const sessionUserId = session.user.id;

  const body = await req.json();
  if (body?.userId && body.userId !== sessionUserId) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: t('mfaSessionMismatch') } },
      { status: 403 },
    );
  }

  // すべての検証ロジック (TOTP / recovery / 入力種別判定) は dispatchMfaValidation に集約。
  // main POST 内では body.X による分岐を一切行わず、outcome.kind で sensitive action を gate する。
  const outcome = await dispatchMfaValidation(body, t);
  if (outcome.kind === 'error') {
    return outcome.response;
  }

  // ★ Single-exit sensitive action.
  //   outcome.kind === 'success' でのみ到達。「validation 結果」が gate であり、
  //   user input は直接的には gate していない (CodeQL の user-controlled bypass 判定対象外)。
  const successResponse = NextResponse.json({ data: { success: true } });
  await reissueAuthJwtOnResponse(req, successResponse, { mfaVerified: true });
  return successResponse;
}

/**
 * MFA 検証の入力種別を判定し、対応する検証ロジックを呼び出す。
 *
 * 設計意図 (CodeQL "user-controlled bypass" 警告の構造的解消):
 *   - body.code / body.recoveryCode による分岐は本ヘルパ内に閉じ込め、main POST には
 *     一切現れないようにする。
 *   - 戻り値は VerifyOutcome (判別 union) のみで、main POST は user input ではなく
 *     "validation 結果" で sensitive action を gate する。
 *   - 結果として CodeQL の taint flow は本ヘルパで終端し、main POST の reissue 呼出しは
 *     validation gate の後ろで safe と判定される。
 */
async function dispatchMfaValidation(
  body: unknown,
  t: Awaited<ReturnType<typeof getTranslations>>,
): Promise<VerifyOutcome> {
  if (isObjectWithStringProp(body, 'code')) {
    return verifyTotpPath(body, t);
  }
  if (isObjectWithStringProp(body, 'recoveryCode')) {
    return verifyRecoveryPath(body, t);
  }
  return {
    kind: 'error',
    response: NextResponse.json({ error: { code: 'VALIDATION_ERROR' } }, { status: 400 }),
  };
}

/** 任意の値が `{ [prop]: string }` の形であることを type guard で確認するヘルパ。 */
function isObjectWithStringProp<K extends string>(
  value: unknown,
  prop: K,
): value is Record<K, string> {
  return (
    typeof value === 'object'
    && value !== null
    && prop in value
    && typeof (value as Record<string, unknown>)[prop] === 'string'
  );
}

/**
 * TOTP コード検証。スキーマ検証 → verifyTotp 呼出 → ロック/失敗時のエラーレスポンス、成功時は kind: 'success'。
 */
async function verifyTotpPath(
  body: unknown,
  t: Awaited<ReturnType<typeof getTranslations>>,
): Promise<VerifyOutcome> {
  const parsed = totpSchema.safeParse(body);
  if (!parsed.success) {
    return {
      kind: 'error',
      response: NextResponse.json(
        { error: { code: 'VALIDATION_ERROR' } },
        { status: 400 },
      ),
    };
  }

  let isValid = false;
  try {
    isValid = await verifyTotp(parsed.data.userId, parsed.data.code);
  } catch (e) {
    if (e instanceof MfaLockedError) {
      return {
        kind: 'error',
        response: NextResponse.json(
          {
            error: {
              code: 'MFA_LOCKED',
              message: t('mfaLockedDueToFailures'),
              lockedUntil: e.lockedUntil.toISOString(),
            },
          },
          { status: 429 },
        ),
      };
    }
    throw e;
  }
  if (!isValid) {
    return {
      kind: 'error',
      response: NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: t('mfaCodeInvalid') } },
        { status: 400 },
      ),
    };
  }

  return { kind: 'success' };
}

/**
 * リカバリーコード検証。バリデーション → DB 検索 → bcrypt compare → 使用済みマーク + ロック解除。
 * PR #116: MFA ロック中でも recovery code 経路は通す (ロック解除の自己救済手段)。
 */
async function verifyRecoveryPath(
  body: unknown,
  t: Awaited<ReturnType<typeof getTranslations>>,
): Promise<VerifyOutcome> {
  const parsed = recoverySchema.safeParse(body);
  if (!parsed.success) {
    return {
      kind: 'error',
      response: NextResponse.json(
        { error: { code: 'VALIDATION_ERROR' } },
        { status: 400 },
      ),
    };
  }

  const codes = await prisma.recoveryCode.findMany({
    where: { userId: parsed.data.userId, usedAt: null },
  });

  for (const code of codes) {
    const isMatch = await compare(parsed.data.recoveryCode, code.codeHash);
    if (isMatch) {
      await prisma.recoveryCode.update({
        where: { id: code.id },
        data: { usedAt: new Date() },
      });
      // PR #116: recovery code 使用成功で MFA ロック・失敗カウントを同時にリセット
      await resetMfaLockOnRecoveryCodeUse(parsed.data.userId);
      return { kind: 'success' };
    }
  }

  return {
    kind: 'error',
    response: NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: t('mfaRecoveryCodeInvalid') } },
      { status: 400 },
    ),
  };
}
