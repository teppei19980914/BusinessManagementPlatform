import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { listAllRetrospectivesForViewer } from '@/services/retrospective.service';

/**
 * 全プロジェクト横断の振り返りビュー用エンドポイント。
 *
 * 認可:
 *   - 認証済みユーザなら閲覧可 (プロジェクトメンバーシップは不問)
 *   - サービス層で非メンバー向けにプロジェクト名・コメント投稿者氏名等をマスクする
 */
export async function GET() {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const retros = await listAllRetrospectivesForViewer(user.id);
  return NextResponse.json({ data: retros });
}
