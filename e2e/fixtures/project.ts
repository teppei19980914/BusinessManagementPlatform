/**
 * プロジェクト関連 API ヘルパー (PR #93 / 段階導入 C)
 *
 * 役割:
 *   テストデータのセットアップ用に、認証済ブラウザセッションから直接 API を叩いて
 *   プロジェクト / メンバーを作成する。Playwright の page.request は同一 context の
 *   Cookie を共有するため、UI ログイン後ならそのまま使える。
 */

import type { Page } from '@playwright/test';

export type CreateProjectParams = {
  name: string;
  customerName?: string;
  purpose?: string;
  background?: string;
  scope?: string;
  devMethod?: 'scratch' | 'power_platform' | 'package' | 'other';
  plannedStartDate?: string;
  plannedEndDate?: string;
};

export async function createProjectViaApi(
  page: Page,
  params: CreateProjectParams,
): Promise<{ id: string }> {
  const today = new Date().toISOString().slice(0, 10);
  const in30 = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const res = await page.request.post('/api/projects', {
    data: {
      name: params.name,
      customerName: params.customerName ?? 'E2E 顧客',
      purpose: params.purpose ?? 'E2E テスト用プロジェクト',
      background: params.background ?? 'E2E',
      scope: params.scope ?? 'E2E',
      devMethod: params.devMethod ?? 'scratch',
      plannedStartDate: params.plannedStartDate ?? today,
      plannedEndDate: params.plannedEndDate ?? in30,
      businessDomainTags: [],
      techStackTags: [],
    },
  });
  if (!res.ok()) {
    throw new Error(`createProjectViaApi failed: ${res.status()} ${await res.text()}`);
  }
  const body = await res.json();
  return { id: body.data.id };
}

export async function addProjectMemberViaApi(
  page: Page,
  params: { projectId: string; userId: string; projectRole: 'pm_tl' | 'member' | 'viewer' },
): Promise<void> {
  const res = await page.request.post(`/api/projects/${params.projectId}/members`, {
    data: {
      userId: params.userId,
      projectRole: params.projectRole,
    },
  });
  if (!res.ok()) {
    throw new Error(`addProjectMemberViaApi failed: ${res.status()} ${await res.text()}`);
  }
}
