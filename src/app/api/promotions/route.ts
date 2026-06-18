/**
 * GET /api/promotions - 昇華関係の取得 (v1.3.0 資産導線機能)
 *
 * クエリパラメータ (いずれか一方のペアを指定):
 *   - fromType=risk&fromId=<riskId>        → そのリスクから昇華された課題一覧 (昇華済みバッジ用)
 *   - fromType=issue&fromId=<issueId>      → その課題から昇華されたナレッジ一覧 (昇華済みバッジ用)
 *   - toType=issue&toId=<issueId>          → その課題の昇華元リスク一覧 (「元リスク」セクション用)
 *   - toType=knowledge&toId=<knowledgeId>  → そのナレッジの昇華元課題一覧 (「元課題」セクション用)
 *
 * 認可: 認証済みユーザなら可 (各 service 関数が tenantId で越境を防止、
 *   論理削除済み/他テナントの相手は結果から除外される)。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import {
  getPromotedIssues,
  getSourceRisks,
  getPromotedKnowledge,
  getSourceIssues,
} from '@/services/promotion.service';

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { searchParams } = req.nextUrl;
  const fromType = searchParams.get('fromType');
  const fromId = searchParams.get('fromId');
  const toType = searchParams.get('toType');
  const toId = searchParams.get('toId');

  if (fromType === 'risk' && fromId) {
    return NextResponse.json({ data: await getPromotedIssues(fromId, user.tenantId) });
  }
  if (fromType === 'issue' && fromId) {
    return NextResponse.json({ data: await getPromotedKnowledge(fromId, user.tenantId) });
  }
  if (toType === 'issue' && toId) {
    return NextResponse.json({ data: await getSourceRisks(toId, user.tenantId) });
  }
  if (toType === 'knowledge' && toId) {
    return NextResponse.json({ data: await getSourceIssues(toId, user.tenantId) });
  }

  return NextResponse.json(
    {
      error: {
        code: 'VALIDATION_ERROR',
        message:
          'fromType (risk|issue) + fromId、または toType (issue|knowledge) + toId を指定してください',
      },
    },
    { status: 400 },
  );
}
