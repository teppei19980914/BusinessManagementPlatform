# i18n ゼロハードコード化 — 進捗ハンドオフ

> **作成日**: 2026-06-12 / **最終更新**: 2026-06-19 (v1.3.0 リリース前)
> **対象ブランチ**: `week/2026-w25` (v1.3.0 リリースブランチ)
>
> Phase 1 (v1.2.0 同梱) で i18n の **基盤** (AppError / toast wrapper / カタログ分割 / CI gate) と **主要な dialogs / 共通 components / projects 画面群** を投入。
> Phase 2 (v1.3.0 同梱) で **設定画面・admin/super 画面群・customers/memos/my-tasks** など UI 層の大部分を i18n 化。
> 残作業 (help/guide/auth/global-error/サーバ層/メール/データ層/test 整備など) は **v1.4.0 以降** で段階対応。
>
> 関連:
> - [GLOSSARY.md](./GLOSSARY.md) — 訳語正本
> - [CONVENTIONS.md](./CONVENTIONS.md) — key 命名規約
> - [ADD_NEW_LOCALE.md](./ADD_NEW_LOCALE.md) — 新規言語追加手順 (中国語・ベトナム語等の拡張時に参照)

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

## Phase 2 完了範囲 (v1.3.0 リリースで同梱予定)

### 新規 sub-file: `messages/<locale>/superAdmin.json`
- admin/super 画面群が大規模なため、専用 sub-file として分離 (~250 key、両 locale)
- `load-messages.ts` の `MESSAGE_SUBFILES` に `'superAdmin'` を追加
- 主カタログ 1 ファイルへの集中を避け、merge conflict 耐性を向上

### UI 移行
- **P3-4 tasks-client.tsx**: WBS 系 15+ toast + 19 JP 行を t() 化
- **P3-5 entity 横断**:
  - `customers-client` / `[customerId]/customer-detail-client`
  - `memos-client`
  - `my-tasks-client` (load failed banner)
  - `knowledge/admin-delete-button` / `retrospectives/admin-delete-button` / `risks/admin-delete-button`
  - `knowledge-client` (linkedMoreSuffix)
  - `all-retrospectives-table` / `all-risks-table` (linkedProjectsTitle ×2)
- **P3-6 settings**:
  - `settings-client.tsx` (テーマ / MFA / パスワード / load failed banner)
  - `tenant/page.tsx` (load failed) + `tenant/loading.tsx` (集計中表示)
  - `tenant/repair-own-drift-button.tsx` (counter 修復確認)
  - `tenant/stripe-payment-method-section.tsx` (~38 key、Stripe Checkout 動線 + カード状態表示)
  - `tenant/db-capacity-section.tsx` (DB 容量プラン詳細 ~30 key)
  - `tenant/file-storage-section.tsx` (添付容量 ~25 key、db-capacity と同型構造)
  - `tenant/billing/page.tsx` (請求履歴 ~20 key)
  - `tenant/migration-import/page.tsx` (移行ガイド)
- **P3-7 admin/super (14 file)**:
  - `db-capacity-alerts-card` / `file-storage-alerts-card` (drift/anomaly/Level table)
  - `banners/{banner-form, banners-list-client, page}` (システムバナー管理)
  - `tenants/page` (一覧 + Default テナント)
  - `tenants/[id]/{tenant-delete-button, tenant-suspend-button}` (削除/停止/再開ダイアログ)
  - `tenants/[id]/diagnostics/page` (個別テナント診断 ~45 key)
  - `tenants/new/tenant-create-form` (~50 key、新規テナント払い出しフォーム)
  - `billing/page` + `billing/[yearMonth]/page` + `billing/[yearMonth]/confirm-payment-button` (請求ダッシュボード)
  - `stripe-dlq/page` + `stripe-dlq/retry-button` (DLQ 監視 + 再投入)
  - `email-failures/page` + `cron-history/page` (運用監視)
  - `seed-data/{page, seed-data-client}` (スターターデータ管理)
  - `layout.tsx` (super_admin ナビゲーション)
  - `diagnostics/repair-drift-button` (counter drift 修復)
- **admin (テナント管理)**:
  - `admin/users/users-client.tsx` の super_admin 系 toast 2 件

### 定量効果 (Phase 2 単体)
- JP 行数: **5103 → 4449** (-654 行、-12.8%)
- 対象 file 数: **266 → 218** (-48 file)
- 新規カタログ key 追加: ~500 key (両 locale)
- 累計 (Phase 1+2): **5242 → 4449** (-793 行、-15.1%)
- カタログ parity test: 18 tests pass、catalog 同期維持

### CI / 退行防止
- `pnpm check:no-hardcoded-jp` を CI 必須ジョブで baseline 比較 (退行検知 = 即 fail)
- baseline は Phase 2 完了時点で 4449 行 / 218 ファイルでロック
- 新規 PR でハードコード JP を導入すると即時検出される

---

## v1.4.0 以降の残作業 (順序付き)

### P3-6 残: Settings (3 file)
- `tenant-settings-client.tsx` (~280 JP 行、最大物の一つ)
- `migration-import/migration-wizard-client.tsx` (~80 行)
- `api-import/api-import-wizard-client.tsx` (~50 行)
- 推定 4-6 h

### P3-7 残: Admin / Super (大物 page)
- `admin/super/page.tsx` (172 行 — super_admin ダッシュボードのトップ)
- `admin/super/diagnostics/page.tsx` (95 行)
- `admin/super/tenants/[id]/page.tsx` (79 行)
- `admin/super/usage/page.tsx` (60 行)
- 関連 API route (export/route.ts 等)
- 推定 4-6 h

### P3-8: Help / Guide (466 JP 行、大物)
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

### P9: 退行防止 ✅ **v1.3.0 完了 (2026-06-19)**

- **P9-1** ✅: `pnpm check:no-hardcoded-jp` は v1.2.0 で CI 必須ジョブとして昇格済み。`--strict` モードへの昇格は P3-6 以降の i18n 化完了後 (v1.4.0 以降) に実施予定。
- **P9-2** ✅: `.husky/pre-commit` hook を追加。`pnpm check:no-hardcoded-jp` + `pnpm check:banned-i18n-patterns` を全 git コミット（IDE/ターミナルからの人手コミット含む）で自動実行。`.claude/settings.json` hooks は Claude Code ツール呼出時のみ発火するため、git 層の pre-commit が唯一の全経路カバー手段（詳細: [KDD §5.X+212](../../docs/knowledge/KDD_PATTERNS.md)）。
- **P9-3** ✅: `scripts/check-banned-i18n-patterns.ts` + `scripts/i18n-banned-patterns-baseline.json` を追加。`throw new Error('<JP>')` / `showError('<JP>')` / `showSuccess('<JP>')` の構文的禁止パターンを検知。既存 9 ファイル（throwError=6、legacyToast=32 箇所）はベースラインで許容し増加のみ fail。CI にも追加済み (`ci.yml` の "Banned i18n patterns check (P9 退行防止)" ステップ)。テスト 15 件 (`scripts/check-banned-i18n-patterns.test.ts`) 全 PASS。
- **P9-4** ✅: `docs/knowledge/KDD_PATTERNS.md §5.X+212` に「ハードコード復活防止」セクション追加。`.claude/settings.json` hooks と git-level hooks の違い、zero-tolerance vs baseline-tolerance の設計判断、新環境での `pnpm install` 必須ルールを記録。

### P10: 最終検証 (推定 2-4 h)
- **P10-1**: フルスキャン再実行 (期待: src/+prisma/seed* の JP 0、tests は data-testid 化、scripts は英語化)
- **P10-2**: 品質ゲートフル走行 (lint+tsc+test+coverage+build+e2e で 2 locale 両系統)
- **P10-3**: `docs/adr/00XX-i18n-zero-hardcode-completion.md` 起草
- **P10-4**: CHANGELOG / docs/business / docs/public 英語版整合 + SELECTABLE_LOCALES 検証 + 手動 smoke を `docs/test/RELEASE_ACCEPTANCE_TEST.md §9` に両 locale 版追加

---

## v1.4.0 開始手順

1. main 最新化後、新規ブランチを切る (週次ブランチ命名)
   ```powershell
   git checkout main; git pull
   git checkout -b week/2026-w26  # 例
   ```
2. JP gate baseline を最新化 (現状 4449 で固定済)
   ```powershell
   pnpm check:no-hardcoded-jp:update-baseline
   ```
3. 残作業の小物から順次実施 (上記 P3-6 残 / P3-7 残 → P3-8 → ... の順を推奨)
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
- 現状 (v1.3.0 時点): `ja.json` + `ja/{email,help,guide,faq,superAdmin}.json` の 6 ファイル (en-US も同じ)
- v1.3.0 で `superAdmin` sub-file を新規追加 (admin/super 画面群が 700+ 行と大規模だったため分離)
- 必要に応じてさらに分割追加可 (例: `ja/help.json` に help-client の翻訳を移動)
- 追加時は `src/i18n/load-messages.ts` の `MESSAGE_SUBFILES` 配列に追記 + 両 locale で対称作成 + messages.test.ts の `cases` 配列にも追加

### 新規言語の追加 (中国語・ベトナム語等)
- 詳細は **[ADD_NEW_LOCALE.md](./ADD_NEW_LOCALE.md)** を参照
- 基盤が整っているため、コード変更は 3 ファイルのみ:
  - `src/config/i18n.ts` (SUPPORTED_LOCALES / SELECTABLE_LOCALES に追加)
  - `src/i18n/request.ts` (toMessagesFilename にマッピング)
  - `src/i18n/messages.test.ts` (parity test を 3 言語対応に拡張)
- 残りは **メッセージカタログの翻訳作業 (~2000 key)** のみ
- 機械翻訳 (Claude API / DeepL 等) でドラフトを一括生成可。ICU placeholder と `<strong>` タグの保持に注意

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
