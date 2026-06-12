# SERVICES.md — service 層カタログ (実装ミラー)

本ドキュメントは `src/services/**` 配下の service 層を責務別に一覧化した **実装ミラー** である。「どのビジネスロジックがどこにあるか」を開発者が即座に把握するための索引であり、真実源は常に各 `*.ts` のコードとその冒頭コメントである。

- 対象: `src/services/**/*.ts` のうち `*.test.ts` / `*.e2e.test.ts` / `*.integration.test.ts` / `__tests__/` を除いた **78 ファイル** (Glob 実測, 2026-05-31 時点)。
- 各表の列: **ファイル** / **責務** / **主要 export** / **課金** (`withMeteredLLM` 経由で `ApiCallLog` を発生させるか) / **テナント分離** (`viewerTenantId` を引数に取り `where.tenantId` を強制するか)。
- ハルシネーション防止のため、関数名は `grep "^export"` で確認した実在 export のみ記載。全 export ではなく代表的なものを抜粋している場合がある。

---

## 0. 横断設計パターン (全 service 共通の土台)

service 層を読む前に、以下 3 つの横断的な約束事を理解しておくこと。これらは個々の service 表には毎回書かないが、ほぼ全 service に通底する。

### (a) テナント分離 — service 層が唯一の防御線

- マルチテナントのデータ越境防止は **DB 層の RLS ではなく service 層が担う**。実 DB の RLS は大半が「enabled だがポリシー 0 件」かつ Prisma が特権ロールで接続するため、**RLS は実効性がない**。`prisma.$use(...)` による自動テナント付与のミドルウェアも **実在しない** (`db.ts` に該当コードなし)。
- したがって一覧系・取得系 service は **`viewerTenantId: string` を必須引数で受け取り、`where.tenantId === viewerTenantId` を明示的にフィルタする**。これを忘れると即座にテナント越境 (severity-1 個人情報漏洩) になる。
- `viewerTenantId` を取る service は本ドキュメントで 24 ファイル (grep 実測)。super_admin 専用 service (全テナント横断が正当) や、認証前・cron・テナント単位確定済みの集計 service は `tenantId` を別経路で確定するため対象外。
- 不変条件テスト: `src/services/__tests__/tenant-isolation-invariants.test.ts`。

### (b) 課金 — `withMeteredLLM` で「1 業務操作 = 1 ApiCallLog」

- LLM / embedding を呼ぶ操作は **`src/lib/llm/metered.ts` の `withMeteredLLM(...)`** でラップする。これがレート制限・月次上限チェック・`ApiCallLog` 記録・カウンタ更新・縮退判定を一元化する。
- **請求 invariant**: `ApiCallLog` の SUM = 画面表示 = 請求金額 = Stripe usage。表示/請求書/CSV/Stripe の全経路で `ApiCallLog` SUM (真値) を使う。`Tenant.currentMonthApiCallCount` 等の counter はホットパスの上限チェック専用。
- bulk な LLM 操作は「1 業務操作 = 1 `ApiCallLog`」に集約する (例: 提案 1 回 = embedding 複数呼出を 1 ラップに束ねる)。
- featureUnit は 4 階層に分類 (LLM / EMBEDDING / STORAGE_OVERAGE / BACKFILL_FREE)。cron 起動の自動リカバリ (embedding backfill 等) は **不当請求にならないよう明示的に free 扱い**にする。
- `withMeteredLLM` を直接 import する service は 4 ファイル (grep 実測): `auto-tag` / `embedding` / `project` / `suggestion-explanation`。その他 (`chat-search` / `embedding-backfill` / `external-data-import` / `degraded-mode` / `fair-use-limit` / `stripe-usage-flush` / `stripe-billing` / `api-usage-recalc` / `attachment-embedding` 等) は `withMeteredLLM` を import せず、`embedding.service` 経由で間接的に課金するか、reason union / counter / queue を参照するのみ (コメント言及含む)。下表の「課金」列は「課金 ApiCallLog を発生させる業務操作か」で判定する (free 維持や上限チェックのみの参照は △ と記す)。

### (c) 共通土台 — 論理削除 / 監査ログ / 状態遷移

- **論理削除 (`deleted_at`)**: 削除は物理削除ではなく `deletedAt` セットが基本。一覧クエリは `where.deletedAt: null` を付ける (これも `$use` 自動付与は無く、各 service が明示)。
- **監査ログ**: データ変更 (CREATE/UPDATE/DELETE) は `audit.service.ts` の `recordAuditLog` / `recordBulkAuditLogs` で記録。`entityId` は `@db.Uuid` 型厳守 (文字列識別子は production reject)。
- **認証イベント**: ログイン成否・パスワード変更等は `auth-event.service.ts` の `recordAuthEvent`。
- **状態遷移**: プロジェクトの 5 状態 (planning → estimating → scheduling → executing → closed、2026-06 簡素化で旧 completed/retrospected を廃止) は `state-machine.ts` の `canTransition` / `getNextStatuses` が順序検査を担う (順序のみ検査、ロック条件 enforce は別途)。

---

## 1. プロジェクト / タスク管理

| ファイル | 責務 | 主要 export | 課金 | テナント分離 |
|---|---|---|---|---|
| `project.service.ts` | プロダクトのトップエンティティ。プロジェクト CRUD + 状態遷移 + 自動タグ/embedding 連携 | `listProjects` / `createProject` / `getProject` / `updateProject` / `changeProjectStatus` / `deleteProjectCascade` / `extractTagsAndEmbedForProject` | ○ (タグ抽出/embedding) | ○ |
| `task.service.ts` | 最大・最複雑の service。WBS (WP→ACT 階層) と進捗・工数・ガント・CSV を担う | `listTasks` / `listTasksWithTree` / `createTask` / `updateTask` / `bulkUpdateTasks` / `bulkDeleteTasks` (ADR-0035) / `updateTaskProgress` / `recalculateAllProjectWps` / `getAssigneeDailyWorkload` / `exportWbs` | — | ○ |
| `task-duplicate.service.ts` | WBS タスクの一括複製 (最大 100 件、名前衝突回避) | `duplicateTasks` / `pickNonConflictingName` (`MAX_DUPLICATE_AT_ONCE=100`) | — | (project 経由) |
| `analytics.service.ts` | 分析タブ 5 パネルのデータソース (v1.2.0): (1) WBS 予実カーブ (ACT 件数累積の予定線/実績線 + 本日サマリ)、(2) 担当者別 週次消化工数 (完了 ACT の実績工数を週×担当者で SUM + 工数効率)、(3) 担当者別 予定 vs 実績工数 (完了+実工数入力済 ACT を担当者別に予定/実績 SUM)、(4) 担当者別 作業負担 (未完了 ACT の予定工数を担当者×状態で SUM + 個人ペース比=実績÷予定)、(5) 担当者別 日次工数 (未完了 ACT の予定工数を予定期間で均等按分し担当者×日付(本日以降)で SUM、`classifyWorkloadLevel` で 7h/8h 閾値判定するヒートマップ)。ドメイン数値のみ返し表示は持たない。本日/本日週はテナント TZ。**対象期間 (`AnalyticsRange`)** を任意で受け、(1) は points をクリップ、(2)(3) は実績完了日で対象 ACT を絞り再集計、(5) は未来の終端を絞る ((4) は現在スナップショットのため非対応)。 | `getWbsCompletionCurve` / `getAssigneeWeeklyEffort` / `getAssigneeEffortVariance` / `getAssigneeWorkload` / `getAssigneeDailyCapacity` (+ `AnalyticsRange`) | — | ○ (project 経由) |
| `estimate.service.ts` | プロジェクト工数見積もり明細の CRUD + 確定 | `listEstimates` / `createEstimate` / `confirmEstimate` / `deleteEstimate` | — | ○ |
| `member.service.ts` | プロジェクトメンバー (projectMember) の参加 CRUD | `listMembers` / `addMember` / `updateMemberRole` / `removeMember` | — | ○ |
| `state-machine.ts` | プロジェクト 7 状態の遷移可否・次状態列挙 (純関数) | `canTransition` / `getNextStatuses` | — | — |

## 2. 資産 (knowledge / risk / retrospective / memo / stakeholder / customer)

| ファイル | 責務 | 主要 export | 課金 | テナント分離 |
|---|---|---|---|---|
| `knowledge.service.ts` | 中核資産。過去案件の知見蓄積。CRUD + 一括可視性変更 + embedding テキスト合成 | `listKnowledge` / `listAllKnowledgeForViewer` / `getKnowledge` / `createKnowledge` / `updateKnowledge` / `deleteKnowledge` / `composeKnowledgeText` / `bulkUpdateKnowledgeVisibilityFromList` | — (embedding は embedding.service 経由) | ○ |
| `risk.service.ts` | リスク・課題管理。優先度算出 + CRUD + プロジェクト link + CSV | `listRisks` / `listAllRisksForViewer` / `createRisk` / `updateRisk` / `deleteRisk` / `linkRiskToProject` / `unlinkRiskFromProject` / `computePriority` / `risksToCSV` | — | ○ |
| `retrospective.service.ts` | プロジェクト完了後の振り返り (KPT 風) CRUD + 確定 + link | `listRetrospectives` / `listAllRetrospectivesForViewer` / `createRetrospective` / `confirmRetrospective` / `updateRetrospective` / `linkRetrospectiveToProject` | — | ○ |
| `memo.service.ts` | プロジェクト非依存の個人メモ (既定 private)。CRUD + 公開メモ一覧 | `listMyMemos` / `listPublicMemos` / `getMemoForViewer` / `createMemo` / `updateMemo` / `deleteMemo` / `composeMemoText` | — | ○ |
| `stakeholder.service.ts` | PMBOK 13 のステークホルダー (内部+外部関係者) を 1 テーブルで管理 | `listStakeholders` / `getStakeholder` / `createStakeholder` / `updateStakeholder` / `deleteStakeholder` | — | ○ |
| `customer.service.ts` | 顧客 (Project の 1:N 親エンティティ) の CRUD + cascade 削除 | `listCustomers` / `getCustomer` / `createCustomer` / `updateCustomer` / `deleteCustomerCascade` | — | ○ |
| `attachment.service.ts` | 添付リンク (外部 URL のみ保持) の CRUD + エンティティ別認可解決 | `listAttachments` / `createAttachment` / `updateAttachment` / `deleteAttachment` / `authorizeForAttachmentEntity` / `getEntityVisibility` | — | (エンティティ経由) |
| `comment.service.ts` | ポリモーフィック (entity_type+entity_id) で 7 種エンティティへのコメント | `listComments` / `createComment` / `updateComment` / `deleteComment` / `resolveEntityForComment` / `softDeleteCommentsForEntity` | — | (エンティティ経由) |

## 3. 提案エンジン / embedding

| ファイル | 責務 | 主要 export | 課金 | テナント分離 |
|---|---|---|---|---|
| `suggestion.service.ts` | 核心機能。過去資産をスコア順に全網羅推薦 (3 軸合成) | `suggestForProject` / `suggestRelatedIssuesForText` / `adoptPastIssueAsTemplate` / `linkKnowledgeToProject` | ○ (embedding 検索) | ○ |
| `suggestion-explanation.service.ts` | 提案候補の人間ライクな説明文を LLM 生成・キャッシュ | `getOrGenerateSuggestionExplanation` | ○ | — |
| `embedding.service.ts` | Voyage AI (voyage-4-lite, 1024 次元) で embedding 生成・永続化・類似検索 | `generateEmbedding` / `persistEmbedding` / `searchSimilar` / `generateAndPersistEntityEmbedding` / `generateBatchEmbeddings` / `generateAndPersistBatchEmbeddings` (`MAX_INPUT_CHARS=8000`, `MAX_BATCH_SIZE=128`) | ○ | — |
| `embedding-backfill.service.ts` | 月初 `content_embedding=NULL` を補完する cron バッチ (BACKFILL_FREE) | `runMonthlyEmbeddingBackfill` / `backfillTenant` / `countNullEmbeddings` | △ (free 維持) | (全テナント) |
| `auto-tag.service.ts` | Project テキストから自動タグを LLM 抽出 (提案エンジン v2 Phase 1) | `extractAutoTags` / `callAnthropicForAutoTagsInner` | ○ | — |
| `attachment-embedding.service.ts` | テキスト抽出済み添付本文を Voyage で embedding 化 (ADR-0021) | `embedAttachment` / `getGlobalInFlightEmbedding` | ○ | — |
| `attachment-embedding-cron.service.ts` | `embeddingStatus='pending'` 添付を batch 処理 (ADR-0026 非同期) | `processAttachmentEmbeddingQueue` / `isReadyForRetry` (`BATCH_SIZE=20`) | ○ | (全テナント) |
| `file-text-extraction.service.ts` | 添付バイナリから本文テキスト抽出 (embedding 入力用) | `extractText` (`MAX_EXTRACTED_TEXT_CHARS=100000`) | — | — |

## 4. チャット / ヘルプ (RAG)

| ファイル | 責務 | 主要 export | 課金 | テナント分離 |
|---|---|---|---|---|
| `chat-search.service.ts` | 自然文クエリで 5 資産を横断意味検索 (pgvector + pg_trgm fallback) | `chatSemanticSearch` | ○ | ○ |
| `help-search.service.ts` | たすきフクロウ AI ヘルプの RAG 検索 (FaqEmbedding/GuideEmbedding, ADR-0028) | `searchHelpContent` / `composeFaqContentText` / `composeGuideContentText` / `computeContentHash` / `buildRagPromptSection` / `mapVisibleToFlags` | ○ (検索 embedding) | (visibleTo フラグ) |
| `guide-role.service.ts` | /guide でロールに合った使い方だけを提示するためのロール判定 | `resolveGuideRole` | — | (user 経由) |

## 5. 課金 / Stripe

| ファイル | 責務 | 主要 export | 課金 | テナント分離 |
|---|---|---|---|---|
| `stripe-billing.service.ts` | Stripe SDK の薄いラッパー + DB 整合性 (顧客/サブスク/カード/usage 報告) | `createOrGetStripeCustomer` / `createCheckoutSessionForCardSetup` / `setupSubscriptionWithExistingCard` / `createSubscriptionForTenant` / `reportUsage` / `cancelTenantStripeSubscription` / `getStripeCardSummary` | △ (usage 報告) | (tenantId 確定) |
| `stripe-webhook-handlers.service.ts` | `/api/webhooks/stripe` から type 分岐で個別ハンドラへ dispatch | `dispatchStripeWebhookEvent` | — | — |
| `stripe-usage-flush.service.ts` | `stripe_usage_record_queue` の未送信行を Stripe へ flush (cron) | `flushStripeUsageRecordQueue` | △ (queue flush) | (全テナント) |
| `stripe-reconcile.service.ts` | credit_card テナントの Stripe ↔ DB 月次照合・金額再照合 (cron) | `reconcileStripeSubscriptions` / `reconcileBillingHistoryAmounts` | — | (全テナント) |
| `stripe-auto-suspend.service.ts` | 引落失敗で `autoSuspendScheduledAt<=now` のテナントを自動 suspend (cron) | `autoSuspendDelinquentTenants` | — | (全テナント) |
| `stripe-dlq.service.ts` | Webhook/usage queue の DLQ 監視・手動再投入 (super_admin) | `listWebhookDlq` / `listUsageQueueDlq` / `retryWebhookEvent` / `retryUsageQueueRow` | — | — |
| `billing-aggregation.service.ts` | 請求書 (invoice/bank_transfer) 払いテナントの月次自社集計 | `aggregateInvoiceBillingForMonth` | — | (全テナント) |
| `billing-management.service.ts` | invoice テナントの手動消込・例外対応 (super_admin) | `getTenantBillingHistory` / `confirmInvoicePayment` / `markPendingInvoiceAsReplacedByStripe` | — | (super_admin) |
| `billing-dashboard.service.ts` | super_admin 請求ダッシュボード (BillingHistory 集計) | `getBillingSummary` / `getMonthlyBillingDetail` / `getRecentMonths` | — | (super_admin) |
| `billing-integrity.service.ts` | BillingHistory `totalAmountJpy` の整合性検証 (請求の最終防衛線) | `detectBillingHistoryIntegrityIssues` | — | (全テナント) |
| `monthly-history-regenerate.service.ts` | `tenant_monthly_usage_history` を ApiCallLog から再生成 (請求重要) | `regenerateMonthlyHistoryFromApiCallLog` | — | (tenantId 指定) |
| `api-usage-recalc.service.ts` | `currentMonthApiCallCount/CostJpy` を ApiCallLog で再集計・修復 | `reconcileTenantApiUsage` / `reconcileTenantEmbeddingUsage` / `reconcileAllTenantsApiUsage` / `repairTenantApiUsage` / `repairTenantEmbeddingUsage` | △ (counter 修復) | (tenantId 指定) |
| `degraded-mode.service.ts` | 月間 API/課金カウンタ + plan + 予算上限から縮退モード判定 | `getDegradedModeState` | △ (上限参照) | (tenantId 指定) |
| `fair-use-limit.service.ts` | Beginner 専用の試用上限 safety net (ADR-0019→0022→0030) | `checkFairUseLimit` / `listFairUseUsage` (`FAIR_USE_LIMIT`) | △ (上限チェック) | (tenantId 指定) |

## 6. テナント容量 / ストレージ課金

| ファイル | 責務 | 主要 export | 課金 | テナント分離 |
|---|---|---|---|---|
| `tenant-storage.service.ts` | テナント DB ストレージ使用量集計 + debounce 再集計 + drift 検知 (ADR-0020) | `calculateTenantStorageBytes` / `updateStorageBytesUsedForTenant` / `recalculateTenantStorageUsageWithDebounce` / `maybeRecalcAfterBeginnerDelete` / `updateAllStorageBytesUsed` / `detectDbCapacityDrift` (`BEGINNER_RECALC_DEBOUNCE_MS=30s`) | — | (tenantId 指定) |
| `tenant-storage-tables.service.ts` | テナント所属テーブルの動的列挙 + 安全な SQL 集計 (ADR-0020) | `getDirectTenantScopedTables` / `getAllTenantScopedTables` / `calculateTenantStorageBytesDynamic` / `getDbInstanceSizeBytes` | — | (tenantId 指定) |
| `db-capacity.service.ts` | `pg_database_size()` で DB 実容量を測定し Supabase 上限と比較 | `getDatabaseCapacityReport` / `getDatabaseSize` / `getTopTablesBySize` | — | (DB 全体) |
| `file-storage-bucket-usage.service.ts` | テナント別 Supabase Storage 使用量集計・キャッシュ更新・drift 検知 (ADR-0021) | `calculateTenantBucketBytes` / `calculateTenantAttachmentBytes` / `syncTenantFileStorageUsage` / `updateAllTenantFileStorageUsage` / `detectFileStorageDrift` | — | (tenantId 指定) |
| `storage-guard.service.ts` | 作成/更新/インポート時の容量 enforcement (DB + ファイル + Beginner write block, ADR-0020/0025) | `precheckStorageLimit` / `assertStorageLimitInTx` / `withStorageGuard` / `precheckFileStorageLimit` / `assertFileStorageLimitInTx` / 各 `map*ErrorToResponse` | — | (tenantId 経由) |
| `import-storage-precheck.service.ts` | 3 経路の CSV/ZIP インポート前の DB 容量事前判定 | `precheckImportStorage` / `runImportStoragePrecheck` / `estimateAddedBytes` | — | (tenantId 経由) |
| `tenant-withdrawal-billing.service.ts` | 退会テナントの即時請求集計 + DB 容量 backfill (ADR-0020) | `billTenantWithdrawal` / `backfillDeletedTenantDbCapacity` | — | (tenantId 指定) |

## 7. テナント / オンボーディング / メンバー

| ファイル | 責務 | 主要 export | 課金 | テナント分離 |
|---|---|---|---|---|
| `tenant-onboarding.service.ts` | 新規テナント作成の単一エントリ (super_admin 手動 + signup)。signup は組織 ID (slug) を入力させずサーバが数字連番を自動採番 (`pickNextNumericSlug`、衝突時リトライ)。super_admin は slug 手入力 (feat/signup-friction-reduction 2026-06-12) | `createTenantBySuperAdmin` / `createTenantBySignup` / `TenantOnboardingInputSchema` / `pickNextNumericSlug` | — | (作成) |
| `tenant-self.service.ts` | admin が自テナントのプラン/予算/i18n/請求先を self-service 変更。**有料化 (Expert/Pro) 時は請求先住所完備を必須 (`BILLING_INFO_INCOMPLETE`)** | `getTenantSelfInfo` / `updateTenantI18n` / `updateBillingContact` / `updateTenantSelf` / `cancelScheduledPlanChange` | — | (tenantId 指定) |
| `sample-clone.service.ts` | スターターデータ取込/削除 (feat/starter-data-import 2026-06-05)。管理テナントの `isSampleData=true` を自テナントへ `is_seed_sample=true` で複製 (embedding は raw SQL コピー=課金ゼロ)、容量 precheck、`is_seed_sample=true` のみ依存順に物理削除 | `importSampleData` / `deleteSampleData` | — | ○ (越境読込元=管理テナント限定、書込=自テナント) |
| `sample-curation.service.ts` | super_admin が取込元 (管理テナント) の Project/Knowledge の `isSampleData` を切替。**更新は MANAGEMENT_TENANT_ID 限定 (越境防御)** | `listManagementSeedCandidates` / `setManagementSampleFlag` | — | ○ (管理テナント限定) |
| `tenant-monthly-reset.service.ts` | 月初カウンタリセット + plan 変更適用 + DB/ファイル容量超過課金 (cron) | `runTenantMonthlyReset` / `resetTenantMonthlyCounters` / `saveMonthlyUsageSnapshots` / `applyScheduledPlanChanges` / `processTenantDbCapacityOverage` / `processTenantFileStorageOverage` | ○ (超過課金) | (全テナント) |
| `beginner-expiry.service.ts` | Beginner プラン 90 日試用の期限管理・通知 (60/75/150/170/180 日) | `getBeginnerExpiryState` / `getBeginnerDaysRemaining` / `isBeginnerExpired` / `sendBeginnerExpiryNotices` | — | (全テナント) |
| `super-admin.service.ts` | 全テナント横断の監視・集計・suspend/resume/delete/purge (super_admin 専用) | `listAllTenants` / `getTenantDetail` / `getCrossTenantUsageSummary` / `getVoyageUsageSummary` / `getAnthropicUsageSummary` / `suspendTenant` / `resumeTenant` / `deleteTenant` / `purgeExpiredBeginnerTenants` / `listDormantTenants` | — | (横断, 正当) |
| `user.service.ts` | システム管理者画面 (/admin/users) からのユーザ CRUD + 座席数 + 非活性ロック + 招待管理 + アカウント状態導出 | `listUsers` / `createUser` / `updateUser` / `updateUserStatus` / `updateUserRole` / `deleteUser` / `resendInvitationByAdmin` / `cancelInvitation` / `assertSeatAvailableForTenant` / `lockInactiveUsers` / `deriveAccountStatus` | — | ○ |
| `user-self.service.ts` | ログイン中ユーザが /settings で参照する自己アカウント情報 | `getUserSelfAccountInfo` | — | (user 経由) |

## 8. 認証 / MFA / パスワード

| ファイル | 責務 | 主要 export | 課金 | テナント分離 |
|---|---|---|---|---|
| `mfa.service.ts` | MFA (TOTP) の発行/有効化/無効化/検証/ロック解除 | `generateMfaSecret` / `enableMfa` / `disableMfa` / `verifyTotp` / `verifyInitialTotpSecret` / `resetMfaLockOnRecoveryCodeUse` / `unlockMfaByAdmin` (`MFA_FAIL_LIMIT=3`) | — | (user 経由) |
| `password.service.ts` | パスワード変更・アカウントロック解除 (履歴照合) | `changePassword` / `unlockAccount` | — | (user 経由) |
| `password-reset.service.ts` | メール + リカバリーコード本人確認によるパスワードリセット | `verifyAndIssueResetToken` / `resetPassword` | — | — |
| `email-verification.service.ts` | メール検証 + 初期パスワード/MFA セットアップフロー | `sendVerificationEmail` / `resendVerificationEmail` / `validateToken` / `setupPassword` / `setupInitialMfa` / `verifyEmail` | — | — |

## 9. 監査 / ログ / 診断

| ファイル | 責務 | 主要 export | 課金 | テナント分離 |
|---|---|---|---|---|
| `audit.service.ts` | 全データ変更 (CREATE/UPDATE/DELETE) の監査ログ記録 (entityId は UUID 厳守) | `recordAuditLog` / `recordBulkAuditLogs` / `sanitizeForAudit` | — | (tenantId 引数) |
| `auth-event.service.ts` | ログイン成否・ログアウト・パスワード変更等の認証イベント記録 | `recordAuthEvent` | — | (tenantId 引数) |
| `error-log.service.ts` | 内部例外・未捕捉 reject を `system_error_logs` に記録 | `recordError` / `logUnknownError` | — | — |
| `email-send-log.service.ts` | 全メール送信を PII 抜きで記録 + 日次上限チェック | `recordEmailSend` / `isDailyEmailLimitReached` / `getEmailSendStats` / `getRecentFailedEmails` | — | — |
| `diagnostics.service.ts` | super_admin 診断ダッシュボードの集約 (停滞 plan 変更・縮退テナント・queue 異常等) | `getDiagnosticsSummary` / `listStalledPlanChanges` / `checkSuperAdminCount` / `listDegradedTenants` / `listStripeUsageQueueIssues` / `listAlertNoRecipientWarnings` | — | (横断) |
| `tenant-diagnostics.service.ts` | 個別テナント診断ページ用の詳細データ集約 | `getTenantDiagnostics` | — | (tenantId 指定) |
| `cron-history.service.ts` | `cron_execution_logs` から super_admin UI 表示用に履歴抽出 | `fetchCronHistoryView` (`STALE_RUNNING_THRESHOLD_MS=30s`) | — | — |
| `cron-health.service.ts` | 最終成功 vs `expectedMaxGapHours` で cron 健全性検知 | `checkCronHealth` / `checkAllCronHealth` / `listUnhealthyCrons` | — | — |
| `netlify-metrics.service.ts` | super_admin ダッシュボードに Netlify ビルド消費量を可視化 | `getNetlifyMetrics` | — | — |
| `usage-monitoring.service.ts` | ApiCallLog をテナント別・日次集計 + 異常/予算アラート検知 (cron) | `getDailyUsageByTenant` / `detectAnomalies` / `detectBudgetAlerts` / `getAdminUsageSummary` / `runDailyUsageAggregation` | — | (横断) |
| `admin-alert.service.ts` | super_admin への運用 alert (入金期日超過 / cron 失敗 / 診断異常) | `sendSuperAdminAlert` / `detectAndAlertOverdueInvoices` / `detectAndAlertDiagnosticsAnomalies` / `detectAndAlertCronFailures` | — | — |

## 10. cron / 集計 (定期実行サービスの再掲・横断)

cron から呼ばれる主要 service は他カテゴリに分散している。代表: `tenant-monthly-reset` (月次リセット/超過課金, §7) / `embedding-backfill` (月初補完, §3) / `attachment-embedding-cron` (非同期 embedding, §3) / `usage-monitoring` (日次集計, §9) / `cron-health`・`admin-alert` (死活/通知, §9) / `stripe-usage-flush`・`stripe-reconcile`・`stripe-auto-suspend` (Stripe 系, §5) / `beginner-expiry` (期限通知, §7) / `file-storage-bucket-usage`・`tenant-storage` (容量 drift, §6)。真実源のスケジュール/閾値は `src/config/cron-jobs.ts` および [CRON_JOBS.md](./CRON_JOBS.md)。

## 11. インポート / エクスポート

| ファイル | 責務 | 主要 export | 課金 | テナント分離 |
|---|---|---|---|---|
| `data-export.service.ts` | テナント全業務データを ZIP (JSON+CSV) でエクスポート | `exportTenantData` / `csvEscape` (`USER_EXPORT_FIELDS` / `USER_PII_FIELDS`) | — | (tenantId 指定) |
| `data-import.service.ts` | エクスポート ZIP を現テナントに全件新規作成で取込 | `importTenantData` | — | (tenantId 指定) |
| `import/migration-import.service.ts` | 手動 CSV / API 連携の 7 種 (顧客・プロジェクト・WBS・リスク課題・ナレッジ・振り返り) 一括取込を preview → apply で実行 (ADR-0034) | `previewMigrationFromCsv` / `previewMigrationFromSources` / `applyMigration` | ○ (embedding) | (tenantId 経由) |
| `import/tenant-import-preview.service.ts` | 取込プレビュー (`tenantImportPreview`) の TTL GC。cron から全テナント横断で expiresAt 期限切れを物理削除 | `deleteExpiredPreviews` | — | (system-wide cleanup) |
| `task-sync-import.service.ts` | WBS の export → 編集 → re-import (Sync by ID) | `parseSyncImportCsv` / `computeSyncDiff` / `applySyncImport` (`WBS_SYNC_CSV_HEADERS`) | — | (project 経由) |
| `knowledge-sync-import.service.ts` | ナレッジの Sync by ID 往復編集 | `parseKnowledgeSyncImportCsv` / `computeKnowledgeSyncDiff` / `applyKnowledgeSyncImport` / `exportKnowledgeSync` | — | ○ |
| `risk-sync-import.service.ts` | リスク/課題の Sync by ID 往復編集 | `parseRiskSyncImportCsv` / `computeRiskSyncDiff` / `applyRiskSyncImport` / `exportRisksSync` | — | ○ |
| `retrospective-sync-import.service.ts` | 振り返りの Sync by ID 往復編集 | `parseRetrospectiveSyncImportCsv` / `computeRetrospectiveSyncDiff` / `applyRetrospectiveSyncImport` / `exportRetrospectivesSync` | — | ○ |
| `memo-sync-import.service.ts` | メモの Sync by ID 往復編集 | `parseMemoSyncImportCsv` / `computeMemoSyncDiff` / `applyMemoSyncImport` / `exportMemosSync` | — | ○ |

## 12. 通知 / メンション

| ファイル | 責務 | 主要 export | 課金 | テナント分離 |
|---|---|---|---|---|
| `notification.service.ts` | 通知 CRUD + 日次通知生成 (タスク期日等) + 既読クリーンアップ | `listNotificationsForUser` / `setNotificationRead` / `markAllNotificationsRead` / `generateDailyNotifications` / `cleanupReadNotifications` / `buildTaskNotificationTitle` | — | (userId 経由) |
| `mention.service.ts` | コメント内メンションの検証・展開・通知生成 | `validateMentionsForEntity` / `getMentionContext` / `expandMention` / `expandMentionsToRecipients` / `diffMentions` / `generateMentionNotifications` / `buildMentionNotificationTitle` | — | (エンティティ経由) |
| `system-banner.service.ts` | システム周知バナー (画面上部の帯、ADR-0036)。**グローバル** (全テナント共通)・期間指定・緊急度色分け・1 本制約 (期間重複禁止)。super_admin 専用管理 | `getActiveBanner` / `listBanners` / `getBanner` / `createBanner` / `updateBanner` / `setBannerEnabled` / `deleteBanner` | — | (横断, 正当: グローバル運用周知) |

---

## 集計

- service 総数: **79** ファイル (`src/services/**/*.ts`, テスト除外, Glob 実測)。
- `viewerTenantId` を取りテナント分離を強制する service: 24 ファイル (grep 実測)。
- `withMeteredLLM` を直接 import する service: 4 ファイル (grep 実測; `auto-tag` / `embedding` / `project` / `suggestion-explanation`)。

## 関連ドキュメント

- テナント分離の脅威モデル: [SECURITY.md](./SECURITY.md)
- 課金 invariant とフロー: [../business/TENANT_AND_BILLING.md](../business/TENANT_AND_BILLING.md) / [STRIPE_TECHNICAL_DESIGN.md](./STRIPE_TECHNICAL_DESIGN.md)
- cron スケジュール: [CRON_JOBS.md](./CRON_JOBS.md) (`src/config/cron-jobs.ts`)
- 提案/embedding 設計: [SUGGESTION_ENGINE.md](./SUGGESTION_ENGINE.md)
- データモデル: [DATA_MODEL.md](./DATA_MODEL.md)
