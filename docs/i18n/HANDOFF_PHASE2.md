# i18n ゼロハードコード化 — Phase 2 引き継ぎ

> **作成日**: 2026-06-12
> **前提リリース**: v1.2.x (Phase 1 同梱)
> **対象ブランチ**: 次リリース用 (`week/2026-w25` 等)
>
> Phase 1 では i18n の **基盤** (AppError / toast wrapper / カタログ分割 / CI gate) と **主要な dialogs / 共通 components / projects 画面群** を移行しました。Phase 2 以降で **残りの全画面・サーバ・外部出力・データ層** を網羅的に対応します。

---

## Phase 1 完了範囲 (本リリース同梱)

### 基盤 (P0)
- `docs/i18n/GLOSSARY.md` — 訳語正本
- `docs/i18n/CONVENTIONS.md` — key 命名・分割方針
- `src/i18n/load-messages.ts` — 主カタログ + サブカタログ (admin/help/guide/email/faq) の shallow merge + 衝突検出
- `src/i18n/messages/ja/{email,help,guide,faq}.json` (+ en-US 並列、空 placeholder)
- `scripts/check-no-hardcoded-jp.ts` + `scripts/i18n-baseline.json` (CI gate)
- `src/i18n/messages.test.ts` 拡張 (key parity + ICU placeholder consistency + 衝突検出器テスト、17 テスト)
- `.github/workflows/ci.yml` に `pnpm check:no-hardcoded-jp` を必須化
- `eslint.config.mjs` に `playwright-report/` `test-results/` ignore 追加

### 基盤コード (P1)
- `src/lib/errors/app-error.ts` (AppError class + ErrorCode union 60 codes + デフォルト httpStatus + 7 テスト)
- `src/lib/api-error-handler.ts` 拡張 (AppError catch + `getTranslations` 経由、TenantBoundaryError 互換、11 テスト追加で計 11)
- `src/components/toast-provider.tsx` 拡張 (`showSuccessKey(key, params)` / `showErrorKey(key, params)` 追加、aria-label を `t()` 化)
- `src/lib/validators/zod-i18n.ts` (translateZodIssues / parseOrThrowAppError + 6 テスト)
- `src/lib/logger.ts` (operator-facing 英語構造化ログ + 5 テスト)
- 既存 `showSuccess` / `showError` は後方互換維持 (Phase 2 で段階移行)

### UI 移行 (P3-1, P3-2, P3-3)
- **Dialogs 7 file**: `knowledge-edit-dialog` / `retrospective-edit-dialog` / `risk-edit-dialog` / `stakeholder-edit-dialog` / `wbs-sync-import-dialog` / `entity-sync-import-dialog` / `user-edit-dialog`
- **共通 components 4 file**: `attachment-list` / `single-url-field` / `cross-list-bulk-visibility-toolbar` / `recalculate-button`
- **Projects 配下 9 file**: `projects-client` / `project-detail-client` / `members-client` / `estimates-client` / `risks-client` / `retrospectives-client` / `project-knowledge-client` / `stakeholders-client` / `suggestions-panel`

### 定量効果
- JP 行数: **5242 → 5103** (-139 行、-2.7%)
- 対象 file 数: **281 → 266** (-15 file)
- カタログ key 追加: ~110 key (両 locale)
- 新規ユニットテスト: +46 (4380 → 4426)
- 全品質ゲート (lint/tsc/test/build/JP gate): 緑

---

## Phase 2 残作業 (順序付き)

### P3-4: WBS 系 client (大物単独)
- `src/app/(dashboard)/projects/[projectId]/tasks/tasks-client.tsx`
  - 15+ toast literals (WP 削除 / ACT 削除 / タスク更新 / 一括更新計画 等)
  - WBS 名・ハードコード 19 JP 行
  - 推定 1-2 h

### P3-5: 全画面ルート + 個別 entity 画面
- `src/app/(dashboard)/customers/` (customers-client / [customerId]/customer-detail-client)
- `src/app/(dashboard)/memos/memos-client.tsx` (6 toast)
- `src/app/(dashboard)/my-tasks/my-tasks-client.tsx`
- `src/app/(dashboard)/knowledge/admin-delete-button.tsx`
- `src/app/(dashboard)/retrospectives/admin-delete-button.tsx`
- `src/app/(dashboard)/risks/admin-delete-button.tsx`
- 推定 2-3 h

### P3-6: Settings (8 file)
- `settings-client.tsx`
- `tenant-settings-client.tsx` (285 JP 行、最大物の一つ)
- `stripe-payment-method-section.tsx`
- `file-storage-section.tsx` / `db-capacity-section.tsx`
- `migration-import/wizard-client.tsx` / `api-import/api-import-wizard-client.tsx` / `external-import/wizard-client.tsx`
- 推定 6-8 h

### P3-7: Admin / Super (14 file)
- `admin/super/page.tsx` (175 JP 行)
- `admin/super/diagnostics/page.tsx` (95 行)
- `admin/super/tenants/[id]/page.tsx` (79 行)
- `tenants/new/tenant-create-form.tsx`
- `tenants/[id]/tenant-suspend-button.tsx` / `tenant-delete-button.tsx`
- `usage/page.tsx`, `banners/`, `billing/`, `email-failures/`, `cron-history/`, `stripe-dlq/`, `seed-data/`
- `admin/users/users-client.tsx`
- 推定 8-10 h

### P3-8: Help / Guide (336 JP 行、大物)
- `src/app/(dashboard)/help/help-client.tsx` (341 行)
- `src/app/(dashboard)/guide/guide-client.tsx` (125 行)
- カタログは `messages/ja/help.json` `messages/ja/guide.json` (Phase 1 で空 placeholder 作成済)
- 推定 4-6 h (キー設計含む)

### P3-9: Auth + Public
- `(auth)/login/page.tsx` / `signup/page.tsx` (87 行: placeholder 例)
- `login/mfa/mfa-form.tsx`, `reset-password/page.tsx`
- `(public)/announcements/`, `changelog/`
- 推定 2-3 h

### P3-10: global-error (特別対応)
- `src/app/global-error.tsx` は `NextIntlClientProvider` の外側で動くため `useTranslations` 使用不可
- 案: cookie/JWT から locale を自前読出し、`src/lib/i18n/static-messages.ts` に静的サブセットを持ち参照
- 推定 1-2 h

### P3-11: loading / not-found 群
- `super/loading.tsx`, `tenants/[id]/loading.tsx`, `settings/tenant/loading.tsx` 等
- 推定 1 h

### P4: Server 層 (推定 12-16 h)
- **P4-1**: `lib/api-helpers.ts` + `api-error-handler.ts` の JP 残骸排除
- **P4-2**: `api/admin/super/*` 71 route → AppError 移行
- **P4-3**: `api/tenants/me/*` (billing / migration-import / external-import / 等) → AppError 移行
- **P4-4**: 残り `api/*` (auth/projects/attachments/comments/memos/knowledge) → AppError 移行
- **P4-5**: `services/` 57 file (data-import / external-data-import / tenant-onboarding / tenant-storage / embedding / 等) を `throw new Error('JP')` → `throw new AppError(code, params)` に統一
- **P4-6**: `lib/validators/` 17 file を `zod-i18n.ts` の `parseOrThrowAppError` 経由に統一 + route 内 inline zod 削除
- **P4-7**: `lib/permissions/check-permission.ts` の 6 メッセージを ErrorCode 化

### P5: 外部出力 (推定 10-14 h、最も慎重)
- **P5-1**: Prisma migration — `Notification.title` を nullable + `titleKey` / `paramsJson` カラム追加 (両併存)
- **P5-2**: `services/notification.service.ts` を `titleKey + params` に切替 (line 219, 252)
- **P5-3**: `scripts/backfill-notification-title-keys.ts` 作成、ステージング dry-run、本番手順を `docs/operations/` に追加
- **P5-4**: `services/email-verification.service.ts` (件名・HTML body・text body) を `messages/<locale>/email.json` 参照に
- **P5-5**: `services/beginner-expiry.service.ts` の Day 60/75/90/150/170 メール 5 種を多言語化 (本文量最大、翻訳品質レビュー必須)
- **P5-6**: `services/password-reset.service.ts` 多言語化
- **P5-7**: `lib/mail/index.ts` の日次送信上限エラー (L130/L144) + `brevo-provider.ts` の From 名
- **P5-8**: `services/data-export.service.ts` の README ビルダー (件数サマリ全 15 行) を locale 引数化

### P6: Data 層 (推定 10-14 h)
- **P6-1**: `src/config/master-data.ts` のラベルを翻訳キー参照に変更
- **P6-2**: `prisma/seed.ts` + `seed-suggestion.ts` の JP ラベル insert をキー化
- **P6-3**: `src/config/faq-content.en-US.ts` 新規作成 (faq-content.ts 1747 行の英訳)
- **P6-4**: `src/config/guide-content.en-US.ts` 新規作成 (guide-content.ts 425 行の英訳)
- **P6-5**: `scripts/generate-faq-embeddings.ts` を locale 対応 (両言語 embedding 化、SHA-256 差分検知は言語ごと)
- **P6-6**: `api/help/chat/route.ts` (30 行) + `api/chat/search/route.ts` を locale 連動 (Owl chat が `user.locale` に追従)

### P7: Scripts (推定 2-3 h)
- **P7-1**: `scripts/` 19 file の `console.log/error` 全英語化 + `opLog` に逓次差し替え
- **P7-2**: 既存 `scripts/i18n-extract-hardcoded-ja.ts` 廃止 (`check-no-hardcoded-jp.ts` に統合済)

### P8: Test / E2E (推定 8-10 h)
- **P8-1**: UI 主要 element に `data-testid` を体系的に付与 (テスト assertion を JP 文字列から ID/role 主体へ移行する基盤)
- **P8-2**: `tests/ui/` + `tests/components/` 36 file の `toContainText('JP')` を testid + role assertion に置換
- **P8-3**: `tests/services/` + `tests/lib/` + `tests/api/` 232 file の JP fixture/assertion を ErrorCode/key 主体に置換 (テスト fixture の意味的 JP は許容)
- **P8-4**: E2E に `loginAs(user, {locale})` helper + `e2e/specs/{i18n-locale-switch,i18n-en-smoke,i18n-ja-smoke}.spec.ts` 新規
- **P8-5**: `e2e/visual/` baseline を ja/en-US 両系統で再生成 (`[gen-visual]` 空 commit ルール準拠、settings/dashboard/customers/auth 4 ドメイン × 2 locale)

### P9: 退行防止 (推定 2 h)
- **P9-1**: `pnpm check:no-hardcoded-jp` を CI の必須ジョブに昇格 (現在は実行のみ、`--strict` モードへ切替)
- **P9-2**: pre-commit hook 追加 (`.claude/settings.json` または `.husky`)
- **P9-3**: `scripts/check-banned-i18n-patterns.ts` 追加 (`throw new Error('JP')` / `toast(literal)` を AST level で禁止)
- **P9-4**: `docs/knowledge/KDD_PATTERNS.md` に「ハードコード復活防止」セクション追加

### P10: 最終検証 (推定 2-4 h)
- **P10-1**: フルスキャン再実行 (期待: src/+prisma/seed* の JP 0、tests は data-testid 化、scripts は英語化)
- **P10-2**: 品質ゲートフル走行 (lint+tsc+test+coverage+build+e2e で 2 locale 両系統)
- **P10-3**: `docs/adr/00XX-i18n-zero-hardcode-completion.md` 起草
- **P10-4**: CHANGELOG / docs/business / docs/public 英語版整合 + SELECTABLE_LOCALES 検証 + 手動 smoke を `docs/test/RELEASE_ACCEPTANCE_TEST.md §9` に両 locale 版追加

---

## Phase 2 開始手順

1. main 最新化後、新規ブランチを切る
   ```powershell
   git checkout main; git pull
   git checkout -b week/2026-w25
   ```
2. JP gate baseline を最新化
   ```powershell
   pnpm check:no-hardcoded-jp:update-baseline
   ```
3. 上記 P3-4 から順次実施
4. 各 chunk 完了時に `pnpm test src/i18n/messages.test.ts` でカタログ parity 確認 (両 locale で key 集合・ICU placeholder が一致しているか)

---

## 重要な前提・注意

### 翻訳品質
- **glossary 厳守**: 訳語は [`GLOSSARY.md`](./GLOSSARY.md) に従う。新規訳語は表に追加してから使用。
- **EN ネイティブレビュー推奨**: 特に P5-5 (Beginner プラン期限メール) と P6-3/4 (FAQ/Guide 1747+425 行) は本番ユーザに直接届く。Phase 2 中盤までにネイティブ確認を組み込むこと。

### Notification schema migration (P5-1〜3)
- 既存 Notification 行は title 文字列のみ。新カラム追加後、UI は `title ?? t(titleKey, params)` で fallback。
- backfill script は dry-run 必須 ([`feedback_migration_workflow_no_migrate_dev`](../../knowledge/KDD_PATTERNS.md))。
- cron `daily-notifications` との順序: schema migration → service refactor → backfill → cron 更新の順で段階デプロイ。

### Beginner Plan 期限メール (P5-5)
- Day 60/75/90/150/170 の 5 種類 × 2 locale = 10 テンプレート
- 「【たすきば】重要：あと {days} 日でテナントが自動削除されます」など緊急度の高い文面 — 翻訳品質要件高

### CI gate の strict 化タイミング (P9-1)
- すべての chunk 完了 (P3-11 / P4-7 / P5-8 / P6-6 / P7-2) で JP gate を `--baseline` → `--strict` に切替
- P10-1 のフルスキャンで 0 を確認してから

### messages/ 構造
- 現状: `ja.json` + `ja/{email,help,guide,faq}.json` の 5 ファイル
- 必要に応じて分割追加可 (例: `ja/admin.json` を新設して admin/super namespace を移動)
- 追加時は `src/i18n/load-messages.ts` の `MESSAGE_SUBFILES` 配列に追記 + 両 locale で対称作成 + messages.test.ts の `cases` 配列にも追加

---

## 参考: 完了済みパターン (再利用推奨)

### Toast 移行パターン (Phase 1 で確立)
```tsx
// Before
const { showSuccess, showError } = useToast();
showError('プロジェクトの作成に失敗しました');
showSuccess('プロジェクトを作成しました');

// After
const { showSuccessKey, showErrorKey } = useToast();
showErrorKey('project.toastCreateFailed');
showSuccessKey('project.toastCreateSuccess');
```

### ICU placeholder 付き
```tsx
showErrorKey('bulkVisibility.toastBulkUpdateFailed', { entityLabel });
showSuccessKey('bulkVisibility.toastBulkUpdateSuccess', { count: total, entityLabel });
```

### Service 層 (Phase 2 で確立予定)
```ts
// Before
throw new Error('テナントが見つかりません');

// After (Phase 2)
throw new AppError('TENANT_NOT_FOUND', { tenantId });
```
カタログ: `error.TENANT_NOT_FOUND` (P1 で `error.*` namespace 雛形済、新コードを追加するごとに `app-error.ts` の `ErrorCode` union 拡張 + 両 locale 追加)

### Provider 不在経路 (global-error 等)
```tsx
// Phase 2 で新設予定: src/lib/i18n/static-messages.ts
import { getStaticMessage } from '@/lib/i18n/static-messages';
const message = getStaticMessage(locale, 'error.UNEXPECTED');
```
