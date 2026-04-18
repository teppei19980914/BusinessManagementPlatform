import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { listAllRisksForViewer } from '@/services/risk.service';

/**
 * 全プロジェクト横断のリスク/課題ビュー用エンドポイント。
 *
 * 認可:
 *   - 認証済みユーザなら閲覧可 (プロジェクトメンバーシップは不問)
 *   - サービス層で非メンバー向けにプロジェクト名・顧客名・氏名等をマスクする
 *
 * 作成/更新/削除は従来通りプロジェクト個別ルート (checkProjectPermission 経由) のみで、
 * 本エンドポイントは read-only。
 */
export async function GET() {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const risks = await listAllRisksForViewer(user.id);
  return NextResponse.json({ data: risks });
}
