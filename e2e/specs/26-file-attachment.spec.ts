/**
 * E2E: 添付ファイル CRUD — URL リンク型 (TC-RA-43/44 の 🤖 カバー)
 *
 * 位置づけ:
 *   CI エフェメラル環境では Supabase Storage 接続がないため、
 *   Supabase Storage を経由しない "URL リンク型" 添付で CRUD フローを検証する。
 *   実ファイルアップロード (upload → PUT to Storage → finalize) の
 *   end-to-end 検証は e2e/smoke/production-smoke.spec.ts (SMK-4) で実施。
 *
 * カバレッジ:
 *   - POST   /api/attachments           (URL リンク型作成)
 *   - GET    /api/attachments?entityType=memo&entityId=... (一覧取得)
 *   - DELETE /api/attachments/[id]      (削除)
 *   - 削除後の一覧不在確認
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { RUN_ID, withRunId } from '../fixtures/run-id';
import { signupTenantViaUi, type SignupResult } from '../fixtures/signup';
import { cleanupTenantByRunId, disconnectDb } from '../fixtures/db';

let context: BrowserContext;
let page: Page;
let tenant: SignupResult;
let memoId = '';
let attachmentId = '';

const MEMO_TITLE = withRunId('ATT-メモ');
const ATTACHMENT_NAME = withRunId('ATT-リンク');
const ATTACHMENT_URL = 'https://example.com/e2e-test-doc.pdf';

test.describe.configure({ mode: 'serial', retries: 0 });

test.describe('@feature:attachment URL リンク型添付 CRUD', () => {
  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    tenant = await signupTenantViaUi(page, { label: 'att', plan: 'beginner' });
  });

  test.afterAll(async () => {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await cleanupTenantByRunId(RUN_ID);
    await disconnectDb();
  });

  test('前提: メモを作成して entityId を取得する', async () => {
    const res = await page.request.post('/api/memos', {
      data: {
        title: MEMO_TITLE,
        content: 'E2E 添付テスト用メモ本文',
        visibility: 'public',
      },
    });
    expect(res.ok(), `POST /api/memos failed: ${res.status()} ${await res.text()}`).toBeTruthy();
    memoId = (await res.json()).data.id as string;
    expect(memoId).toBeTruthy();
  });

  test('URL リンク型添付を作成できる (storageProvider=url)', async () => {
    const res = await page.request.post('/api/attachments', {
      data: {
        entityType: 'memo',
        entityId: memoId,
        displayName: ATTACHMENT_NAME,
        url: ATTACHMENT_URL,
        mimeHint: 'application/pdf',
      },
    });
    expect(res.ok(), `POST /api/attachments failed: ${res.status()} ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    attachmentId = body.data.id as string;
    expect(attachmentId).toBeTruthy();
    expect(body.data.displayName).toBe(ATTACHMENT_NAME);
    expect(body.data.storageProvider).toBe('url');
  });

  test('GET /api/attachments で作成した添付が一覧に含まれる', async () => {
    const res = await page.request.get(
      `/api/attachments?entityType=memo&entityId=${memoId}`,
    );
    expect(res.ok()).toBeTruthy();
    const attachments = (await res.json()).data as Array<{ id: string; displayName: string }>;
    expect(attachments.some((a) => a.id === attachmentId)).toBeTruthy();
    expect(attachments.some((a) => a.displayName === ATTACHMENT_NAME)).toBeTruthy();
  });

  test('DELETE /api/attachments/[id] で添付を削除できる', async () => {
    const res = await page.request.delete(`/api/attachments/${attachmentId}`);
    expect(res.ok(), `DELETE /api/attachments/${attachmentId} failed: ${res.status()}`).toBeTruthy();
    const body = await res.json();
    expect(body.data.success).toBe(true);
  });

  test('削除後は GET 一覧から当該添付が消えている', async () => {
    const res = await page.request.get(
      `/api/attachments?entityType=memo&entityId=${memoId}`,
    );
    expect(res.ok()).toBeTruthy();
    const attachments = (await res.json()).data as Array<{ id: string }>;
    expect(attachments.some((a) => a.id === attachmentId)).toBeFalsy();
  });
});
