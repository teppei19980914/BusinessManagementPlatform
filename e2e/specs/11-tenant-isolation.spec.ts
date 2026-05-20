/**
 * E2E: テナント越境遮断テスト (PR feat/tenant-isolation-comprehensive-tests / 2026-05-10)
 *
 * 役割:
 *   テナント A の admin が テナント B の各エンティティ ID を直接 URL / API で叩いた際に、
 *   GET → 404, PATCH/PUT/POST/DELETE → 404 または 403 が返ることを **API 経由で網羅検証** する。
 *
 *   Phase 1〜2-10 (PR #297-#308) で構造的にテナント越境を遮断したため、本 spec は
 *   **将来の改修でも仕様が維持されることを保証する CI gate** として機能する。
 *
 * 設計判断:
 *   - 本 spec が **絶対に通り続ける** ことが、テナント分離仕様の生命線。
 *   - admin (systemRole='admin') 視点で全パスをチェック (general より権限が広い admin が
 *     塞がっていれば一般ユーザは追って塞がる、という上位互換チェック)。
 *   - 検証は API レイヤ (`fetch` 経由) で行う。UI 経由だとボタン非表示で気付けない経路を
 *     直接 URL で叩く攻撃シナリオを再現するため。
 *   - `request` 機能 (Playwright の APIRequestContext) を session cookie 込みで再利用。
 *
 * カバレッジ:
 *   テナント B の以下を テナント A admin が叩く:
 *     - GET    /api/projects/[id]                    → 404
 *     - PATCH  /api/projects/[id]                    → 404
 *     - DELETE /api/projects/[id]                    → 404
 *     - GET    /api/projects/[id]/tasks              → empty array (member 不一致 + tenant 不一致)
 *     - POST   /api/projects/[id]/tasks              → 404 (project tenant 検証で reject)
 *     - PATCH  /api/projects/[id]/tasks/[taskId]     → 404
 *     - DELETE /api/projects/[id]/tasks/[taskId]     → 404
 *     - GET    /api/projects/[id]/risks              → 404 (or empty)
 *     - GET    /api/projects/[id]/estimates          → 404 (or empty)
 *     - GET    /api/projects/[id]/stakeholders       → 404 (or empty)
 *     - GET    /api/projects/[id]/members            → 404 (or empty)
 *     - GET    /api/projects/[id]/retrospectives     → 404 (or empty)
 *     - GET    /api/projects/[id]/knowledge          → 404 (or empty)
 *     - GET    /api/customers/[id]                   → 404
 *     - GET    /api/memos/[id]                       → 404
 *     - GET    /api/admin/users                      → テナント B の user 不在
 *     - GET    /api/admin/audit-logs                 → テナント B の log 不在
 *     - GET    /api/admin/role-change-logs           → テナント B の log 不在
 *     - PATCH  /api/admin/users/[userId]             → 404 (越境 user 編集)
 *     - DELETE /api/admin/users/[userId]             → 404
 *     - GET    /api/attachments?entityType=task&entityId=<B's task> → 403 / 空
 *
 * 関連:
 *   - Phase 2 シリーズ: docs/security/TENANT_ISOLATION_PHASE2_TODO.md
 *   - 設計仕様: 「シードデータ以外、別テナントのデータは参照/更新/削除不可」
 */

import { test, expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { RUN_ID } from '../fixtures/run-id';
import { waitForProjectsReady } from '../fixtures/auth';
import {
  createTenantPair,
  cleanupTenants,
  disconnectMultiTenantDb,
  type TenantFixture,
} from '../fixtures/multi-tenant';

let tenantA: TenantFixture;
let tenantB: TenantFixture;

let adminAContext: BrowserContext;
let adminAPage: Page;
let adminARequest: APIRequestContext;

test.describe.configure({ mode: 'serial', retries: 0 });

test.describe('@feature:security:tenant-isolation テナント越境遮断 (Phase 2 リグレッション防止)', () => {
  test.beforeAll(async ({ browser }) => {
    // 2 テナント分のフルセット (admin/general + customer + project + 全 entity) を作成
    const pair = await createTenantPair(RUN_ID);
    tenantA = pair.tenantA;
    tenantB = pair.tenantB;

    // テナント A admin としてログイン (session cookie 取得)
    adminAContext = await browser.newContext();
    adminAPage = await adminAContext.newPage();
    await adminAPage.goto('/login');
    // ADR-0016 (2026-05-20): 組織 ID 必須化 (multi-tenant fixture から slug 取得)
    await adminAPage.getByLabel('組織 ID').fill(tenantA.tenantSlug);
    await adminAPage.getByLabel('メールアドレス').fill(tenantA.adminEmail);
    await adminAPage.getByLabel('パスワード').fill(tenantA.adminPassword);
    await adminAPage.getByRole('button', { name: 'ログイン' }).click();
    // 2026-05-13 (PR #345): redirect chain (login → / → /projects) の完全完了を待つ。
    //   旧実装の `/login` でない判定だけだと redirect 途中で抜けて後続 goto と race する。
    //   詳細: docs/test/E2E_LESSONS.md §4.55
    await waitForProjectsReady(adminAPage);

    // 同 cookie を持つ APIRequestContext を作成 (fetch ベースの検証で使う)
    adminARequest = adminAContext.request;
  });

  test.afterAll(async () => {
    // beforeAll が fixture 作成中に throw した場合、adminAPage / adminAContext が未初期化となる。
    // 二次エラーで根本原因がログから埋もれるのを避けるため optional chaining + try で防御する。
    await adminAPage?.close().catch(() => undefined);
    await adminAContext?.close().catch(() => undefined);
    // tenant A / B のフルクリーンアップ (Phase 2 後の DB は schema 上 tenant_id 列が
    // 全 monitoring/audit table に居るため、テナント単位の一括削除が成立する)
    await cleanupTenants([tenantA?.tenantId, tenantB?.tenantId].filter(Boolean));
    await disconnectMultiTenantDb();
  });

  // ==========================================================================
  // Project 系 (越境 ID 直叩き)
  // ==========================================================================

  test('GET /api/projects/[B-id] → 404 (テナント B の project は A admin に見えない)', async () => {
    const res = await adminARequest.get(`/api/projects/${tenantB.projectId}`);
    expect([403, 404]).toContain(res.status());
  });

  test('PATCH /api/projects/[B-id] → 404 (テナント B の project は A admin が更新不可)', async () => {
    const res = await adminARequest.patch(`/api/projects/${tenantB.projectId}`, {
      data: { name: 'attacked' },
    });
    expect([403, 404]).toContain(res.status());
  });

  test('DELETE /api/projects/[B-id] → 404 (テナント B の project は A admin が削除不可)', async () => {
    const res = await adminARequest.delete(`/api/projects/${tenantB.projectId}`);
    expect([403, 404]).toContain(res.status());
  });

  // ==========================================================================
  // Task 系 (Task は tenantId 列なし、project 経由で隔離)
  // ==========================================================================

  test('GET /api/projects/[B-pid]/tasks → 404 (越境 project 配下の task は見えない)', async () => {
    const res = await adminARequest.get(`/api/projects/${tenantB.projectId}/tasks`);
    if (res.status() === 200) {
      // 仕様: 200 で空配列を返す経路もあり得るが、その場合 B の task は混入していないこと
      const json = (await res.json()) as { data?: Array<{ id: string }> };
      const ids = (json.data ?? []).map((t) => t.id);
      expect(ids).not.toContain(tenantB.taskId);
    } else {
      expect([403, 404]).toContain(res.status());
    }
  });

  test('POST /api/projects/[B-pid]/tasks → 404 (越境 project に task を作れない)', async () => {
    const res = await adminARequest.post(`/api/projects/${tenantB.projectId}/tasks`, {
      data: {
        type: 'activity',
        name: 'Cross tenant attack task',
        category: 'other',
      },
    });
    expect([400, 403, 404]).toContain(res.status());
  });

  test('PATCH /api/projects/[A-pid]/tasks/[B-tid] → 404 (URL は A だが task は B のもの)', async () => {
    // Note: URL は A の project / B の task を組み合わせた攻撃シナリオ。
    //   service 層は taskId を tenantId 経由で findFirst するため、B の task は見つからない。
    const res = await adminARequest.patch(
      `/api/projects/${tenantA.projectId}/tasks/${tenantB.taskId}`,
      { data: { name: 'attacked' } },
    );
    expect([400, 403, 404]).toContain(res.status());
  });

  test('DELETE /api/projects/[A-pid]/tasks/[B-tid] → 404', async () => {
    const res = await adminARequest.delete(
      `/api/projects/${tenantA.projectId}/tasks/${tenantB.taskId}`,
    );
    expect([400, 403, 404]).toContain(res.status());
  });

  // ==========================================================================
  // Risk / Issue 系
  // ==========================================================================

  test('GET /api/projects/[B-pid]/risks → 越境 risk は混入しない', async () => {
    const res = await adminARequest.get(`/api/projects/${tenantB.projectId}/risks`);
    if (res.status() === 200) {
      const json = (await res.json()) as { data?: Array<{ id: string }> };
      const ids = (json.data ?? []).map((r) => r.id);
      expect(ids).not.toContain(tenantB.riskId);
    } else {
      expect([403, 404]).toContain(res.status());
    }
  });

  test('PATCH /api/projects/[A-pid]/risks/[B-rid] → 404', async () => {
    const res = await adminARequest.patch(
      `/api/projects/${tenantA.projectId}/risks/${tenantB.riskId}`,
      { data: { title: 'attacked' } },
    );
    expect([400, 403, 404]).toContain(res.status());
  });

  // ==========================================================================
  // Knowledge 系
  // ==========================================================================

  test('GET /api/knowledge/[B-id] → 404 (越境 knowledge 個別取得不可)', async () => {
    const res = await adminARequest.get(`/api/knowledge/${tenantB.knowledgeId}`);
    expect([403, 404]).toContain(res.status());
  });

  test('PATCH /api/knowledge/[B-id] → 405 (越境 knowledge 更新経路は構造的に閉鎖)', async () => {
    // feat/crud-permission-redesign (2026-05-20, PR #416): 横断 `/api/knowledge/[knowledgeId]` の
    //   PATCH ハンドラを「UI=API 一致原則」に従い削除済み。プロジェクト内更新は
    //   `/api/projects/[pid]/knowledge/[kid]` PATCH 経由 (service 層で作成者本人のみ enforce)。
    //   そのため越境攻撃ベクトルとしては PATCH 405 (Method Not Allowed) が期待される。
    //   旧 200/400/403/404 期待値はハンドラ削除前の挙動で、新仕様では **構造的に到達不能**。
    //   後続の DELETE は ハンドラ存続 (admin global delete) なので 403/404 系。
    const res = await adminARequest.patch(`/api/knowledge/${tenantB.knowledgeId}`, {
      data: { title: 'attacked' },
    });
    expect([400, 403, 404, 405]).toContain(res.status());
  });

  test('DELETE /api/knowledge/[B-id] → 404', async () => {
    const res = await adminARequest.delete(`/api/knowledge/${tenantB.knowledgeId}`);
    expect([403, 404]).toContain(res.status());
  });

  // ==========================================================================
  // Retrospective 系
  // ==========================================================================

  // NOTE: retrospective endpoint (`/api/projects/[pid]/retrospectives/[rid]`) は GET ハンドラを
  //   持たず PATCH / DELETE のみ提供される (一覧は親 `/retrospectives` で取得する設計)。
  //   GET を投げると 405 Method Not Allowed が返るため、cross-tenant attack vector としては
  //   PATCH (越境更新試行) を検証する。
  test('PATCH /api/projects/[A-pid]/retrospectives/[B-rid] → 404 (越境 retrospective 更新不可)', async () => {
    const res = await adminARequest.patch(
      `/api/projects/${tenantA.projectId}/retrospectives/${tenantB.retrospectiveId}`,
      { data: { planSummary: 'attacked' } },
    );
    expect([400, 403, 404]).toContain(res.status());
  });

  test('DELETE /api/projects/[A-pid]/retrospectives/[B-rid] → 404 (越境 retrospective 削除不可)', async () => {
    const res = await adminARequest.delete(
      `/api/projects/${tenantA.projectId}/retrospectives/${tenantB.retrospectiveId}`,
    );
    expect([403, 404]).toContain(res.status());
  });

  // ==========================================================================
  // Memo 系 (user-scoped でもテナント越境は遮断)
  // ==========================================================================

  test('GET /api/memos/[B-id] → 404 (B admin の memo は A admin に見えない)', async () => {
    const res = await adminARequest.get(`/api/memos/${tenantB.memoId}`);
    expect([403, 404]).toContain(res.status());
  });

  test('PATCH /api/memos/[B-id] → 404', async () => {
    const res = await adminARequest.patch(`/api/memos/${tenantB.memoId}`, {
      data: { title: 'attacked' },
    });
    expect([400, 403, 404]).toContain(res.status());
  });

  test('DELETE /api/memos/[B-id] → 404', async () => {
    const res = await adminARequest.delete(`/api/memos/${tenantB.memoId}`);
    expect([403, 404]).toContain(res.status());
  });

  // ==========================================================================
  // Customer 系
  // ==========================================================================

  test('GET /api/customers/[B-id] → 404 (越境 customer 取得不可)', async () => {
    const res = await adminARequest.get(`/api/customers/${tenantB.customerId}`);
    expect([403, 404]).toContain(res.status());
  });

  test('PATCH /api/customers/[B-id] → 404', async () => {
    const res = await adminARequest.patch(`/api/customers/${tenantB.customerId}`, {
      data: { name: 'attacked' },
    });
    expect([400, 403, 404]).toContain(res.status());
  });

  // ==========================================================================
  // Stakeholder / Estimate / Member 系 (project 経由で隔離)
  // ==========================================================================

  test('GET /api/projects/[A-pid]/stakeholders/[B-sid] → 404', async () => {
    const res = await adminARequest.get(
      `/api/projects/${tenantA.projectId}/stakeholders/${tenantB.stakeholderId}`,
    );
    expect([403, 404]).toContain(res.status());
  });

  test('GET /api/projects/[A-pid]/estimates/[B-eid] → 404', async () => {
    const res = await adminARequest.get(
      `/api/projects/${tenantA.projectId}/estimates/${tenantB.estimateId}`,
    );
    expect([403, 404]).toContain(res.status());
  });

  // ==========================================================================
  // Comment / Attachment 系 (polymorphic、parent entity 経由で隔離)
  // ==========================================================================

  test('GET /api/comments?entityType=task&entityId=[B-tid] → 越境 comment 不在', async () => {
    const res = await adminARequest.get(
      `/api/comments?entityType=task&entityId=${tenantB.taskId}`,
    );
    if (res.status() === 200) {
      const json = (await res.json()) as { data?: Array<{ id: string }> };
      const ids = (json.data ?? []).map((c) => c.id);
      expect(ids).not.toContain(tenantB.commentId);
    } else {
      expect([403, 404]).toContain(res.status());
    }
  });

  test('PATCH /api/comments/[B-cid] → 404', async () => {
    const res = await adminARequest.patch(`/api/comments/${tenantB.commentId}`, {
      data: { content: 'attacked' },
    });
    expect([400, 403, 404]).toContain(res.status());
  });

  test('DELETE /api/comments/[B-cid] → 404', async () => {
    const res = await adminARequest.delete(`/api/comments/${tenantB.commentId}`);
    expect([403, 404]).toContain(res.status());
  });

  test('GET /api/attachments?entityType=task&entityId=[B-tid] → 越境 attachment 不在', async () => {
    const res = await adminARequest.get(
      `/api/attachments?entityType=task&entityId=${tenantB.taskId}`,
    );
    if (res.status() === 200) {
      const json = (await res.json()) as { data?: Array<{ id: string }> };
      const ids = (json.data ?? []).map((a) => a.id);
      expect(ids).not.toContain(tenantB.attachmentId);
    } else {
      expect([403, 404]).toContain(res.status());
    }
  });

  test('PATCH /api/attachments/[B-aid] → 404', async () => {
    const res = await adminARequest.patch(`/api/attachments/${tenantB.attachmentId}`, {
      data: { displayName: 'attacked' },
    });
    expect([400, 403, 404]).toContain(res.status());
  });

  // ==========================================================================
  // Admin 画面 / API (admin が他テナントの管理ログを見れない)
  // ==========================================================================

  test('GET /api/admin/users → A admin にテナント B の user は見えない', async () => {
    const res = await adminARequest.get('/api/admin/users');
    expect(res.status()).toBe(200);
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    const userIds = (json.data ?? []).map((u) => u.id);
    expect(userIds).not.toContain(tenantB.adminId);
    expect(userIds).not.toContain(tenantB.generalId);
  });

  test('PATCH /api/admin/users/[B-userId] → 404 (越境 user 編集不可)', async () => {
    const res = await adminARequest.patch(`/api/admin/users/${tenantB.generalId}`, {
      data: { isActive: false },
    });
    expect([400, 403, 404]).toContain(res.status());
  });

  test('DELETE /api/admin/users/[B-userId] → 404 (越境 user 削除不可)', async () => {
    const res = await adminARequest.delete(`/api/admin/users/${tenantB.generalId}`);
    expect([403, 404]).toContain(res.status());
  });

  test('POST /api/admin/users/[B-userId]/recovery-codes → 404 (越境リカバリーコード再発行不可)', async () => {
    const res = await adminARequest.post(
      `/api/admin/users/${tenantB.generalId}/recovery-codes`,
      { data: {} },
    );
    expect([403, 404]).toContain(res.status());
  });

  test('POST /api/admin/users/[B-userId]/unlock → 404 (越境ロック解除不可)', async () => {
    const res = await adminARequest.post(
      `/api/admin/users/${tenantB.generalId}/unlock`,
      { data: {} },
    );
    expect([403, 404]).toContain(res.status());
  });

  test('GET /api/admin/audit-logs → A admin にテナント B の audit log は混入しない (Phase 2-10)', async () => {
    const res = await adminARequest.get('/api/admin/audit-logs?limit=100');
    expect(res.status()).toBe(200);
    const json = (await res.json()) as { data?: Array<{ id: string; entityId: string }> };
    // B の特定 entity (project / customer 等) を entityId に持つ log が混入していないこと
    const bEntityIds = [
      tenantB.projectId,
      tenantB.customerId,
      tenantB.taskId,
      tenantB.riskId,
      tenantB.knowledgeId,
      tenantB.adminId,
      tenantB.generalId,
    ];
    for (const log of json.data ?? []) {
      expect(bEntityIds).not.toContain(log.entityId);
    }
  });

  test('GET /api/admin/role-change-logs → A admin にテナント B のログは混入しない (Phase 2-10)', async () => {
    const res = await adminARequest.get('/api/admin/role-change-logs?limit=100');
    expect(res.status()).toBe(200);
    const json = (await res.json()) as { data?: Array<{ targetUserEmail: string }> };
    for (const log of json.data ?? []) {
      expect(log.targetUserEmail).not.toBe(tenantB.adminEmail);
      expect(log.targetUserEmail).not.toBe(tenantB.generalEmail);
    }
  });

  // ==========================================================================
  // sync-import 系 (Phase 2-8)
  // ==========================================================================

  test('POST /api/projects/[B-pid]/tasks/sync-import?dryRun=1 → 越境プロジェクトのインポート不可', async () => {
    // multipart/form-data で空 CSV を投げ、project 検証で reject されるかを確認
    const formData = new FormData();
    const blob = new Blob(
      ['ID,種別,名称,レベル,予定開始日,予定終了日,予定工数\n'],
      { type: 'text/csv' },
    );
    formData.append('file', blob, 'wbs.csv');
    formData.append('removeMode', 'keep');

    const res = await adminARequest.post(
      `/api/projects/${tenantB.projectId}/tasks/sync-import?dryRun=1`,
      { multipart: { file: { name: 'wbs.csv', mimeType: 'text/csv', buffer: Buffer.from('ID,種別,名称,レベル,予定開始日,予定終了日,予定工数\n') }, removeMode: 'keep' } },
    );
    if (res.status() === 200) {
      // 200 でも globalErrors にプロジェクト不在が出ているはず
      const json = (await res.json()) as { data?: { globalErrors?: string[]; canExecute?: boolean } };
      expect(json.data?.canExecute).toBe(false);
      const errors = json.data?.globalErrors ?? [];
      expect(errors.some((e) => e.includes('プロジェクト') || e.includes('not found'))).toBe(true);
    } else {
      expect([400, 403, 404]).toContain(res.status());
    }
  });
});
