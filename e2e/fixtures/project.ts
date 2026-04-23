/**
 * プロジェクト関連 API ヘルパー (PR #93 / 段階導入 C → PR #97 で retry 追加)
 *
 * 役割:
 *   テストデータのセットアップ用に、認証済ブラウザセッションから直接 API を叩いて
 *   プロジェクト / メンバーを作成する。Playwright の page.request は同一 context の
 *   Cookie を共有するため、UI ログイン後ならそのまま使える。
 *
 * retry 方針 (LESSONS §4.21):
 *   CI で ECONNRESET 等の transient network error が観測されたため、全 API ヘルパーに
 *   retry (1s 間隔 x 最大 3 回) を組み込む。非 transient エラー (4xx/5xx の response) は
 *   retry せず即 throw。
 */

import type { APIResponse, Page } from '@playwright/test';

type RequestFn = () => Promise<APIResponse>;

/**
 * transient network error を吸収する retry ラッパ。
 * ECONNRESET / ECONNREFUSED / socket hang up を検知して 1s 間隔で最大 3 回試行。
 * 非 transient (4xx/5xx レスポンスや他の例外) は即 throw。
 */
async function postWithRetry(page: Page, fn: RequestFn, label: string): Promise<APIResponse> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient = /ECONNRESET|ECONNREFUSED|socket hang up/i.test(msg);
      if (!isTransient || attempt === 3) break;
      await page.waitForTimeout(1000);
    }
  }
  throw new Error(
    `${label} failed after retries: ${lastError instanceof Error ? lastError.message : lastError}`,
  );
}

export type CreateProjectParams = {
  name: string;
  /** 明示的な FK を使いたい場合。未指定なら内部で顧客を自動作成する。 */
  customerId?: string;
  /** customerId 未指定時に新規作成する顧客の名前。未指定なら 'E2E 顧客'。 */
  customerName?: string;
  purpose?: string;
  background?: string;
  scope?: string;
  devMethod?: 'scratch' | 'power_platform' | 'package' | 'other';
  plannedStartDate?: string;
  plannedEndDate?: string;
};

/**
 * 顧客を API 経由で作成する (PR #111-2)。
 * admin ログイン済の page を前提とする。
 */
export async function createCustomerViaApi(
  page: Page,
  params: { name: string; department?: string },
): Promise<{ id: string }> {
  const res = await postWithRetry(
    page,
    () =>
      page.request.post('/api/customers', {
        data: {
          name: params.name,
          department: params.department ?? null,
        },
      }),
    'createCustomerViaApi',
  );
  if (!res.ok()) {
    throw new Error(`createCustomerViaApi failed: ${res.status()} ${await res.text()}`);
  }
  const body = await res.json();
  return { id: body.data.id };
}

export async function createProjectViaApi(
  page: Page,
  params: CreateProjectParams,
): Promise<{ id: string }> {
  const today = new Date().toISOString().slice(0, 10);
  const in30 = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // PR #111-2: Project.customerId が NOT NULL になったので、明示指定がなければ先に顧客作成する。
  // 同一 run 内で複数 Project を作る場合、customerId 未指定なら毎回新規顧客になるが
  // E2E テスト用には問題なし (cleanupByRunId で一括削除されるため)。
  const customerId =
    params.customerId ??
    (await createCustomerViaApi(page, {
      name: params.customerName ?? `E2E 顧客 ${params.name}`,
    })).id;

  const res = await postWithRetry(
    page,
    () =>
      page.request.post('/api/projects', {
        data: {
          name: params.name,
          customerId,
          purpose: params.purpose ?? 'E2E テスト用プロジェクト',
          background: params.background ?? 'E2E',
          scope: params.scope ?? 'E2E',
          devMethod: params.devMethod ?? 'scratch',
          plannedStartDate: params.plannedStartDate ?? today,
          plannedEndDate: params.plannedEndDate ?? in30,
          businessDomainTags: [],
          techStackTags: [],
        },
      }),
    'createProjectViaApi',
  );
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
  const res = await postWithRetry(
    page,
    () =>
      page.request.post(`/api/projects/${params.projectId}/members`, {
        data: {
          userId: params.userId,
          projectRole: params.projectRole,
        },
      }),
    'addProjectMemberViaApi',
  );
  if (!res.ok()) {
    throw new Error(`addProjectMemberViaApi failed: ${res.status()} ${await res.text()}`);
  }
}
