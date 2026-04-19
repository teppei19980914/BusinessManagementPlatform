import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { MfaForm } from './mfa-form';

/**
 * MFA 検証ページ (PR #67): Server Component でセッション判定 + クライアント TOTP フォーム。
 *
 * フロー:
 *   1. /login でパスワード認証 → セッション確立 (mfaVerified=false)
 *   2. middleware (authorized callback) がここへ誘導
 *   3. このページでセッションを検査し、MFA 未有効 or 既検証なら callbackUrl へ redirect
 *   4. それ以外は MfaForm をレンダ → TOTP を送信 → 検証成功で JWT を update
 *   5. ダッシュボードへ遷移
 */

type Props = {
  searchParams: Promise<{ callbackUrl?: string }>;
};

export default async function MfaPage({ searchParams }: Props) {
  const { callbackUrl = '/' } = await searchParams;
  const session = await auth();

  // 未ログインは /login へ
  if (!session?.user) {
    redirect(`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  }

  // MFA 未有効 or 既検証の場合は元の遷移先へ
  if (!session.user.mfaEnabled || session.user.mfaVerified) {
    redirect(callbackUrl);
  }

  return <MfaForm userId={session.user.id} callbackUrl={callbackUrl} />;
}
