# テナント越境バグ Phase 2 残課題 (severity-1)

## 概要

PR feat/issues-from-feedback-2026-05-09 (Phase 1) で **中核 + 最重要 PII 漏洩経路 + アカウント乗っ取り経路** を塞いだ。本ドキュメントは **残りの越境経路** を網羅し、v1.x マルチテナント解放前に必ず塞ぎ切るための作業 TODO。

詳細な発見経緯は `docs/knowledge/KDD_PATTERNS.md` §5.X+14 参照。

## Phase 1 完了済 (本 PR で対応)

- [x] `checkMembership` に `userTenantId` 必須化、admin 短絡をテナント一致時のみに限定
- [x] `checkProjectPermission` の `user.tenantId` 伝達 + 全呼び出し元修正
- [x] `listUsers` / `/api/admin/users` の自テナント限定
- [x] `listCustomers` / `getCustomer` / `createCustomer` / `updateCustomer` / `deleteCustomer` / `deleteCustomerCascade` の tenant フィルタ
- [x] `/api/mention-candidates` の自テナント限定
- [x] `/admin/audit-logs` / `/admin/role-changes` ページの自テナント限定
- [x] `requireSameTenantUser()` ヘルパー新設 + `/api/admin/users/[userId]/{PATCH,DELETE,recovery-codes,unlock}` で適用
- [x] `customer.service.test.ts` / `user.service.test.ts` / `membership.test.ts` の更新 + テナント越境ケース追加 (5 件)

## Phase 2 HIGH (越境読/書/削の直接経路)

各 service で `viewerTenantId: string` を必須引数化し、`where.tenantId = viewerTenantId` を Prisma findMany / findFirst / update / delete / updateMany / deleteMany に必ず付ける。create / createMany は `data.tenantId` を明示。

### project.service.ts ✅ 完了 (PR Phase 2-2, 2026-05-09)

- [x] `getProject(projectId, viewerTenantId, systemRole?)` — where に tenantId 必須化
- [x] `updateProject(projectId, input, userId, tenantId)` — findUnique → findFirst (tenantId 検証) + 不一致時 NOT_FOUND throw
- [x] `changeProjectStatus(projectId, newStatus, userId, viewerTenantId)`
- [x] `deleteProject(projectId, userId, viewerTenantId)` — 冒頭で project の所有確認
- [x] `deleteProjectCascade(projectId, viewerTenantId, options)` — 冒頭で所有確認 (越境カスケード破壊を遮断)
- [x] `createProject` — `data.tenantId` を明示化 (schema DB DEFAULT への暗黙依存を解消)

### risk.service.ts ✅ 完了 (PR Phase 2-3, 2026-05-09)

- [x] `listRisks(projectId, viewerUserId, viewerSystemRole, viewerTenantId)` — where に tenantId 必須化
- [x] `getRisk(riskId, viewerUserId?, viewerSystemRole?, viewerTenantId?)` — 内部 helper はオプショナル維持 (cascade 削除等の認可スキップ経路を維持)
- [x] `updateRisk(riskId, input, userId, tenantId)` — 既存 `tenantId` 引数を viewer 認可境界として再利用、findFirst の where に併記
- [x] `bulkUpdateRisksFromList(projectId, ids, patch, viewerUserId, viewerTenantId)` — findMany の where に tenantId 併記
- [x] `deleteRisk(riskId, userId, systemRole, viewerTenantId)` — findFirst の where に tenantId 必須化
- [x] `unlinkRiskFromProject(riskId, projectId, viewerTenantId)` — 冒頭で risk の tenant 一致確認 (越境紐付け解除を遮断)
- [x] `linkRiskToProject` は既存実装で risk.tenantId === project.tenantId を verify 済 (TENANT_MISMATCH throw) のため変更不要

### knowledge.service.ts ✅ 完了 (PR Phase 2-4, 2026-05-09)

- [x] `listKnowledge(params, userId, systemRole, viewerTenantId)`
- [x] `listKnowledgeByProject(projectId, viewerTenantId)`
- [x] `getKnowledge(knowledgeId, viewerUserId?, viewerSystemRole?, viewerTenantId?)` — 内部 helper オプショナル維持
- [x] `updateKnowledge(knowledgeId, input, userId, tenantId)` — 既存 `tenantId` を viewer 認可境界として再利用
- [x] `deleteKnowledge(knowledgeId, userId, systemRole, viewerTenantId)`
- [x] `bulkUpdateKnowledgeVisibilityFromList(projectId, ids, visibility, viewerUserId, viewerTenantId)`
- [x] `createKnowledge` — `data.tenantId` を明示化

### retrospective.service.ts ✅ 完了 (PR Phase 2-4, 2026-05-09)

- [x] `listRetrospectives(projectId, viewerUserId, viewerSystemRole, viewerTenantId)`
- [x] `getRetrospective(retroId, viewerUserId?, viewerSystemRole?, viewerTenantId?)`
- [x] `confirmRetrospective(retroId, userId, viewerTenantId)` — 冒頭で findFirst 所有確認
- [x] `updateRetrospective(retroId, input, userId, tenantId)` — 既存 tenantId を認可境界として再利用
- [x] `deleteRetrospective(retroId, userId, systemRole, viewerTenantId)`
- [x] `bulkUpdateRetrospectivesVisibilityFromList(projectId, ids, visibility, viewerUserId, viewerTenantId)`
- [x] `unlinkRetrospectiveFromProject(retroId, projectId, viewerTenantId)`

### memo.service.ts ✅ 完了 (PR Phase 2-4, 2026-05-09)

- [x] `getMemoForViewer(memoId, viewerUserId, viewerTenantId)`
- [x] `updateMemo(memoId, input, userId, viewerTenantId)`
- [x] `deleteMemo(memoId, userId, viewerTenantId)`
- [x] `bulkUpdateMemosVisibilityFromList(ids, visibility, viewerUserId, viewerTenantId)`
- [x] `createMemo` — `data.tenantId` を明示化

### task.service.ts (最大の盲点 — tenantId フィルタ皆無) ✅ 完了 (PR Phase 2-1, 2026-05-09)

- [x] `listMyTaskProjects(userId, viewerTenantId)`
- [x] `listTasks(projectId, viewerTenantId)` / `listTasksFlat` / `listTasksWithTree`
- [x] `getAssigneeDailyWorkload(projectId, viewerTenantId)`
- [x] `getTask(taskId, viewerTenantId)`
- [x] `createTask(projectId, input, userId, viewerTenantId)` — project の tenant 検証で越境 create 遮断
- [x] `updateTask(taskId, input, userId, viewerTenantId)`
- [x] `deleteTask(taskId, userId, viewerTenantId)`
- [x] `bulkUpdateTasks(projectId, taskIds, ..., viewerTenantId)`
- [x] `updateTaskProgress(taskId, input, userId, viewerTenantId)`
- [x] `recalculateAllProjectWps(projectId, viewerTenantId)`
- [x] `exportWbs(projectId, viewerTenantId, taskIds?)` — viewerTenantId は taskIds 前 (シグネチャ整合)
- [x] `getProgressLogs(taskId, viewerTenantId)` — 当初 TODO 漏れ、本 PR で塞いだ
- [x] `recalculateAncestorsPublic` / `recalculateAncestors` / `recalculateWp` / `recalculateWpOnly` — 内部 helper、上位関数で tenant 検証された taskId しか流れないため変更不要

### comment.service.ts ✅ 完了 (PR Phase 2-5, 2026-05-10)

- [x] `listComments(entityType, entityId, viewerTenantId)`
- [x] `getComment(commentId, viewerTenantId)`
- [x] `createComment(input, userId, tenantId, mentions?, mentionerName?)` — `data.tenantId` 明示 + `mention.createMany` にも tenantId 明示
- [x] `updateComment(commentId, content, viewerTenantId, mentions?, mentionerName?)` — 冒頭で findFirst 所有確認
- [x] `deleteComment(commentId, viewerTenantId)` — updateMany で tenantId 検証 (越境誤削除遮断)
- [x] `resolveEntityForComment(entityType, entityId, viewerTenantId)` — 全 entity 検索に tenantId 必須化
- [x] `softDeleteCommentsForEntity(entityType, entityId, viewerTenantId)` — 越境 cascade 削除遮断

### stakeholder.service.ts ✅ 完了 (PR Phase 2-5, 2026-05-10)

- [x] `listStakeholders(projectId, viewerTenantId)`
- [x] `getStakeholder(stakeholderId, viewerTenantId)`
- [x] `createStakeholder(projectId, input, userId, tenantId)` — project 所有確認 + `data.tenantId` 明示
- [x] `updateStakeholder(stakeholderId, input, userId, viewerTenantId)`
- [x] `deleteStakeholder(stakeholderId, userId, viewerTenantId)`

### attachment.service.ts (添付ファイル URL 漏洩は機密情報直結) ✅ 完了 (PR Phase 2-5, 2026-05-10)

- [x] `listAttachments(entityType, entityId, viewerTenantId, slot?)`
- [x] `getAttachment(id, viewerTenantId)`
- [x] `createAttachment(input, userId, tenantId)` — `data.tenantId` 明示
- [x] `updateAttachment(id, input, viewerTenantId)` — 冒頭で findFirst 所有確認
- [x] `deleteAttachment(id, viewerTenantId)` — updateMany で tenantId 検証
- [x] `getEntityVisibility(entityType, entityId, viewerTenantId)` — 全 entity 検索に tenantId 必須化
- [x] `resolveProjectIds(entityType, entityId, viewerTenantId)` — task / estimate は project 経由で絞り込み
- [x] `authorizeMemoAttachment(memoId, viewerUserId, mode, viewerTenantId)`

### estimate.service.ts (契約金額 / 見積根拠の漏洩は致命的) ✅ 完了 (PR Phase 2-6, 2026-05-10)

- [x] `listEstimates(projectId, viewerTenantId)` — project 経由で絞り込み
- [x] `getEstimate(estimateId, viewerTenantId)`
- [x] `createEstimate(projectId, input, userId, viewerTenantId)` — 冒頭で project tenant 検証
- [x] `updateEstimate(estimateId, input, userId, viewerTenantId)` — 冒頭で findFirst 所有確認
- [x] `confirmEstimate(estimateId, userId, viewerTenantId)`
- [x] `deleteEstimate(estimateId, userId, viewerTenantId)`

### member.service.ts ✅ 完了 (PR Phase 2-6, 2026-05-10)

- [x] `listMembers(projectId, viewerTenantId)` — project 経由で絞り込み
- [x] `addMember(projectId, userId, projectRole, assignedBy, viewerTenantId)` — **User と Project の tenantId 一致を verify** (権限昇格攻撃防止)
- [x] `updateMemberRole(memberId, newRole, changedBy, viewerTenantId)` — findUnique → findFirst (project tenant 検証)
- [x] `removeMember(memberId, changedBy, viewerTenantId)`

### user.service.ts (B 拡張) ✅ 完了 (PR Phase 2-6, 2026-05-10)

- [x] `createUser(input, creatorId, options)` — メール重複チェックを tenant scope で実施 + `data.tenantId` を明示
- [x] `updateUserStatus(userId, isActive, updaterId, viewerTenantId)` — 冒頭で findFirst 所有確認
- [x] `updateUser(userId, input, updaterId, viewerTenantId)` — 冒頭で findFirst 所有確認 (内部 dispatch も tenant 検証)
- [x] `updateUserRole(userId, newRole, updaterId, viewerTenantId)` — findUnique → findFirst (tenantId 検証)
- [x] `deleteUser(userId, deleterId, viewerTenantId)` — findFirst の where に tenantId 必須化
- [ ] `lockInactiveUsers(systemTriggerId, viewerTenantId?)` — cron 経路は意図的全テナント横断、手動経路のみ tenantId 限定 (Phase 2-9 で対応予定)

### suggestion.service.ts

- [ ] `loadProjectContext(projectId, viewerTenantId)`
- [ ] `suggestForProject(projectId, options, viewerTenantId)` — knowledge / issue / risk / retrospective の findMany **すべて** に `tenantId: ctx.tenantId` 必須。`excludeManagementTenant` を「追加許可」に書き換え (`tenantId: { in: [ctx.tenantId, MANAGEMENT_TENANT_ID] }` when seedDataEnabled)
- [ ] `adoptPastIssueAsTemplate(sourceIssueId, targetProjectId, userId)` — sourceIssue.tenantId === targetProject.tenantId を verify
- [ ] `linkKnowledgeToProject(knowledgeId, projectId, viewerTenantId)`
- [ ] `suggestRelatedIssuesForText(inputText, currentProjectId, viewerTenantId)`

### mention.service.ts

- [ ] `getMentionContext(entityType, entityId, viewerTenantId)`
- [ ] `expandMention(kind, ...)` — kind='all' の `user.findMany` に tenantId フィルタ
- [ ] `generateMentionNotifications(...)` — `notification.createMany` の data に tenantId 明示

### notification.service.ts (二重防御)

- [ ] `setNotificationRead(notificationId, read, viewerUserId, viewerTenantId)` — where に userId + tenantId 併記
- [ ] `getNotification(notificationId, viewerTenantId)`

### sync-import 系 5 ファイル

- [ ] `task-sync-import.service.ts` / `knowledge-sync-import.service.ts` / `risk-sync-import.service.ts` / `retrospective-sync-import.service.ts` / `memo-sync-import.service.ts`
- [ ] 全 `applySyncImport` / `computeSyncDiff` に `viewerTenantId` 必須引数 + projectId の tenant 検証

### API ルート (Server Component を Phase 1 で塞いだが API は未対応)

- [ ] `GET /api/admin/audit-logs/route.ts` — 自テナント限定
- [ ] `GET /api/admin/role-change-logs/route.ts` — 同上
- [ ] `GET /api/admin/usage-summary/route.ts` — 同上
- [ ] `POST /api/attachments/batch` の admin 分岐 (`filteredIds = entityIds`): 親 entity の tenantId 検証

## Phase 2-10 (旧 MEDIUM) ✅ 完了 (PR feat/tenant-isolation-phase2-audit-tokens, 2026-05-10)

監査ログ / 認証トークン / 認証イベント全 7 model に `tenantId` 列追加 + 全 service / route の caller 伝播。

- [x] **schema.prisma 7 model に tenantId 列追加 + Tenant FK + index** (`AuditLog` / `RoleChangeLog` / `AuthEventLog` (NULL 許容) / `EmailVerificationToken` / `PasswordResetToken` / `RecoveryCode` / `PasswordHistory`)
- [x] **migration `20260514_phase2_10_audit_token_tenant_id`**: ADD COLUMN + UPDATE backfill (users.tenant_id JOIN) + ALTER NOT NULL + ADD CONSTRAINT (DO ブロックで idempotent) + CREATE INDEX
- [x] `audit.service.ts`: `recordAuditLog` / `recordBulkAuditLogs` に `tenantId` 必須引数化 + `data.tenantId` 明示
- [x] `auth-event.service.ts`: `recordAuthEvent` に `tenantId` (NULL 許容) 追加 + `data.tenantId` 明示
- [x] `email-verification.service.ts`: `sendVerificationEmail` に `tenantId` 必須化 + `EmailVerificationToken.create` / `RecoveryCode.createMany` の data に明示
- [x] `password-reset.service.ts`: `PasswordResetToken.create` / `PasswordHistory.create` の data に `tenantId` 明示 + `RecoveryCode.updateMany` `findMany` `PasswordHistory.findMany` の where に併記 (二重防御)
- [x] `password.service.ts`: `PasswordHistory.findMany` `create` に tenantId 明示 + `unlockAccount` を `viewerTenantId` 必須化 (越境 unlock 遮断 = `updateMany` で `where.tenantId` 併記)
- [x] `error-log.service.ts`: `RecordErrorInput.tenantId` 追加 + 呼出元で明示伝播 (DB DEFAULT 暗黙依存を解消)
- [x] **全 caller 伝播**: 50 ファイル中 46 ファイルは python script で `recordAuditLog` 呼出に `tenantId: user.tenantId,` 一括追加。残り 4 ファイル (super_admin export / tenant create / lockInactiveUsers / super-admin tenant DELETE) は **target tenant** を渡す特殊ケースとして手動修正
- [x] **`/admin/audit-logs` / `/admin/role-changes` page + API**: User/targetUser リレーション経由フィルタから **直接 `where.tenantId` フィルタ** に移行 (より高速、User 物理削除後も追従可能)
- [x] **`tenant-onboarding.service.ts`**: Tenant + 初期 admin 作成時の RoleChangeLog / sendVerificationEmail に新規 tenant.id を伝播
- [x] **`prisma/seed.ts`**: 初期 admin (default-tenant) / super_admin (management-tenant) の RecoveryCode 生成に tenantId 明示

### 検証
- ✅ `pnpm test` 全 1750 件 pass
- ✅ `pnpm build` 成功
- ✅ TypeScript 全 production code 型エラーなし

## E2E テスト追加 (CI gate 化必須)

- [ ] テナント A の admin が テナント B の {project, user, risk, knowledge, retrospective, memo, customer, task, comment, attachment, estimate, stakeholder} の各 ID で各 API を叩いた際:
  - GET → 404
  - PATCH/PUT/POST → 404 または 403
  - DELETE → 404 または 403
- [ ] テナント A の認証ユーザが `/api/mention-candidates?entityType=...&entityId=...` で他テナント user を取得できないこと
- [ ] テナント A の admin が `/admin/users` `/admin/audit-logs` `/admin/role-changes` で他テナントの情報を取得できないこと

## 進捗管理

- 各 service の修正は **個別 PR** に分割を推奨 (リグレッションリスク管理)
- 修正順は HIGH → MEDIUM の順
- 全完了後、本ファイルを `docs/security/TENANT_ISOLATION_HISTORY.md` にリネームしてアーカイブ

## 参照

- KDD ナレッジ §5.X+13 / §5.X+14 (本件の根本原因と監査結果)
- `src/lib/permissions/tenant.ts` (`requireSameTenant` / `tenantScope` ヘルパー)
- `src/lib/api-helpers.ts` (`requireSameTenantUser` ヘルパー — Phase 1 で新設)
- 公式 OWASP IDOR: <https://owasp.org/www-community/attacks/Indirect_Object_Reference>
