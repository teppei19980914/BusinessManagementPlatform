/**
 * POST /api/projects/:projectId/suggestions/explain (P-3 / 2026-05-08)
 *
 * 役割:
 *   提案候補 (knowledge / issue / retrospective) に対する「なぜこのプロジェクトに
 *   関連するのか」の説明文を、Lazy 生成 + DB キャッシュで返す。
 *
 * 認可:
 *   プロジェクトの read 権限が必要 (メンバー or admin)。
 *   service 側でも tenantId を見て候補本体のテナント境界を再検証する (二重防御)。
 *
 * 入力 (JSON Body):
 *   { candidateKind: 'knowledge' | 'issue' | 'retrospective', candidateId: string }
 *
 * 出力:
 *   - 200: { data: { explanation, fromCache, modelName, generatedAt } }
 *   - 400: VALIDATION_ERROR
 *   - 401/403: 認証 / 認可エラー
 *   - 404: PROJECT_NOT_FOUND / CANDIDATE_NOT_FOUND
 *   - 429: RATE_LIMITED (短期 rate limit), BEGINNER_LIMIT_EXCEEDED (月間), BUDGET_EXCEEDED
 *   - 502: LLM_ERROR (Anthropic 側エラー、再試行可)
 *   - 503: TENANT_INACTIVE (テナント停止中)
 *
 * 関連:
 *   - 計画: docs/roadmap/V1_FINAL_TASKS.md P-3
 *   - サービス: src/services/suggestion-explanation.service.ts
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import {
  getOrGenerateSuggestionExplanation,
  type ExplainSuggestionDegraded,
} from '@/services/suggestion-explanation.service';
// Q1 (2026-05-14): 縮退モード時のエラーメッセージをロール別に出し分け
import { getDegradedMessage, type DegradedReason } from '@/lib/degraded-error-messages';
import type { SystemRole } from '@/config/master-data';

const ExplainBodySchema = z.object({
  // 2026-05-09 (PR D / #21): 過去リスク 'risk' を追加
  candidateKind: z.enum(['knowledge', 'issue', 'risk', 'retrospective']),
  candidateId: z.string().uuid(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'project:read');
  if (forbidden) return forbidden;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'リクエスト JSON が不正です' } },
      { status: 400 },
    );
  }

  const parsed = ExplainBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const result = await getOrGenerateSuggestionExplanation({
    projectId,
    tenantId: user.tenantId,
    userId: user.id,
    candidateKind: parsed.data.candidateKind,
    candidateId: parsed.data.candidateId,
  });

  if (result.ok) {
    return NextResponse.json({
      data: {
        explanation: result.explanation,
        fromCache: result.fromCache,
        modelName: result.modelName,
        generatedAt: result.generatedAt.toISOString(),
      },
    });
  }

  return mapDegradedToHttp(result, user.systemRole);
}

function mapDegradedToHttp(
  result: ExplainSuggestionDegraded,
  role: SystemRole,
): NextResponse {
  switch (result.reason) {
    case 'project_not_found':
      return NextResponse.json(
        { error: { code: 'PROJECT_NOT_FOUND', message: result.message } },
        { status: 404 },
      );
    case 'candidate_not_found':
      return NextResponse.json(
        { error: { code: 'CANDIDATE_NOT_FOUND', message: result.message } },
        { status: 404 },
      );
    case 'cross_tenant_forbidden':
      return NextResponse.json(
        { error: { code: 'CROSS_TENANT_FORBIDDEN', message: result.message } },
        { status: 403 },
      );
    // 課金 / プラン系: ロール別メッセージに差し替える (Q1 / 2026-05-14)。
    //   一般ユーザは「テナント管理者へ相談」、admin/super_admin は具体的対処手順を案内する。
    case 'rate_limited':
    case 'beginner_limit_exceeded':
    case 'budget_exceeded':
    case 'tenant_inactive':
    case 'plan_invalid':
    case 'plan_forbidden':
    case 'llm_error':
      return NextResponse.json(
        {
          error: {
            code: degradedReasonToCode(result.reason),
            message: getDegradedMessage(result.reason, role),
          },
        },
        { status: degradedReasonToHttpStatus(result.reason) },
      );
  }
}

function degradedReasonToCode(reason: DegradedReason): string {
  switch (reason) {
    case 'rate_limited':
      return 'RATE_LIMITED';
    case 'beginner_limit_exceeded':
      return 'BEGINNER_LIMIT_EXCEEDED';
    case 'budget_exceeded':
      return 'BUDGET_EXCEEDED';
    case 'tenant_inactive':
      return 'TENANT_INACTIVE';
    case 'plan_invalid':
      return 'PLAN_INVALID';
    case 'plan_forbidden':
      return 'PLAN_FORBIDDEN';
    case 'llm_error':
      return 'LLM_ERROR';
  }
}

function degradedReasonToHttpStatus(reason: DegradedReason): number {
  switch (reason) {
    case 'rate_limited':
    case 'beginner_limit_exceeded':
    case 'budget_exceeded':
      return 429;
    case 'tenant_inactive':
      return 503;
    case 'plan_invalid':
      return 500;
    case 'plan_forbidden':
      return 403;
    case 'llm_error':
      return 502;
  }
}
