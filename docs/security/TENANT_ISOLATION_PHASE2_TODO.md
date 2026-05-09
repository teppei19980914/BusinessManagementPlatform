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

### knowledge.service.ts ✅ 完了 (PR #301 Phase 2-4)

- [x] `listKnowledge(params, userId, systemRole, viewerTenantId)`
- [x] `listKnowledgeByProject(projectId, viewerTenantId)`
- [x] `getKnowledge(knowledgeId, ..., viewerTenantId)`
- [x] `updateKnowledge(knowledgeId, input, userId, viewerTenantId)` — 既存 `tenantId` 引数同上
- [x] `deleteKnowledge(knowledgeId, userId, systemRole, viewerTenantId)`
- [x] `bulkUpdateKnowledgeVisibilityFromList(projectId, ids, visibility, viewerUserId, viewerTenantId)`

### retrospective.service.ts ✅ 完了 (PR #301 Phase 2-4)

- [x] 全 7 関数 (`listRetrospectives` / `getRetrospective` / `confirmRetrospective` / `updateRetrospective` / `deleteRetrospective` / `bulkUpdateRetrospectivesVisibilityFromList` / `unlinkRetrospectiveFromProject`)

### memo.service.ts ✅ 完了 (PR #301 Phase 2-4)

- [x] `getMemoForViewer(memoId, viewerUserId, viewerTenantId)`
- [x] `updateMemo(memoId, input, userId, viewerTenantId)`
- [x] `deleteMemo(memoId, userId, viewerTenantId)`
- [x] `bulkUpdateMemosVisibilityFromList(ids, visibility, viewerUserId, viewerTenantId)`

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

### comment.service.ts ✅ 完了 (PR #302 Phase 2-5)

- [x] 全 7 関数 (`listComments` / `getComment` / `createComment` (data.tenantId 明示) / `updateComment` / `deleteComment` / `resolveEntityForComment` / `softDeleteCommentsForEntity`)
- [x] `mention.createMany` (createComment 内) も `data.tenantId` 明示

### stakeholder.service.ts ✅ 完了 (PR #302 Phase 2-5)

- [x] 全 5 関数 (`listStakeholders` / `getStakeholder` / `createStakeholder` (data.tenantId 明示) / `updateStakeholder` / `deleteStakeholder`)

### attachment.service.ts ✅ 完了 (PR #302 Phase 2-5)

- [x] 全 8 関数 (`listAttachments` / `getAttachment` / `createAttachment` (data.tenantId 明示) / `updateAttachment` / `deleteAttachment` / `getEntityVisibility` / `resolveProjectIds` / `authorizeMemoAttachment`)

### estimate.service.ts ✅ 完了 (PR #303 Phase 2-6)

- [x] 全 6 関数

### member.service.ts ✅ 完了 (PR #303 Phase 2-6)

- [x] `listMembers(projectId, viewerTenantId)`
- [x] `addMember(projectId, userId, projectRole, viewerTenantId)` — **User と Project の tenantId 一致を verify** (権限昇格攻撃防止)
- [x] `updateMemberRole(memberId, ..., viewerTenantId)`
- [x] `removeMember(memberId, viewerTenantId)`

### user.service.ts (B 拡張) ✅ 完了 (PR #303 Phase 2-6)

- [x] `createUser(input, creatorId, options, viewerTenantId)` — `data.tenantId` を引数の tenantId と一致確認
- [x] `updateUserStatus(userId, isActive, updaterId, viewerTenantId)`
- [x] `updateUser(userId, input, updaterId, viewerTenantId)`
- [x] `updateUserRole(userId, newRole, updaterId, viewerTenantId)`
- [x] `deleteUser(userId, deleterId, viewerTenantId)` — 内部の projectMember カスケードも tenantId 条件併記
- [x] `lockInactiveUsers(systemTriggerId, viewerTenantId?)` — cron 経路は意図的全テナント横断、手動経路のみ tenantId 限定

### suggestion.service.ts ✅ 完了 (PR #304 Phase 2-7)

- [x] `loadProjectContext(projectId, viewerTenantId)`
- [x] `suggestForProject(projectId, options, viewerTenantId)` — knowledge / issue / risk / retrospective の findMany **すべて** に `tenantId: ctx.tenantId` 必須。`excludeManagementTenant` を「追加許可」に書き換え (`tenantId: { in: [ctx.tenantId, MANAGEMENT_TENANT_ID] }` when seedDataEnabled)
- [x] `adoptPastIssueAsTemplate(sourceIssueId, targetProjectId, userId)` — sourceIssue.tenantId === targetProject.tenantId を verify
- [x] `linkKnowledgeToProject(knowledgeId, projectId, viewerTenantId)`
- [x] `suggestRelatedIssuesForText(inputText, currentProjectId, viewerTenantId)`

### mention.service.ts ✅ 完了 (PR #304 Phase 2-7)

- [x] `getMentionContext(entityType, entityId, viewerTenantId)`
- [x] `expandMention(kind, ...)` — kind='all' の `user.findMany` に tenantId フィルタ
- [x] `generateMentionNotifications(...)` — `notification.createMany` の data に tenantId 明示

### notification.service.ts (二重防御) ✅ 完了 (PR #304 Phase 2-7)

- [x] `setNotificationRead(notificationId, read, viewerUserId, viewerTenantId)` — where に userId + tenantId 併記
- [x] `getNotification(notificationId, viewerTenantId)`

### sync-import 系 5 ファイル ✅ 完了 (PR #305 Phase 2-8)

- [x] `task-sync-import.service.ts` / `knowledge-sync-import.service.ts` / `risk-sync-import.service.ts` / `retrospective-sync-import.service.ts` / `memo-sync-import.service.ts`
- [x] 全 `applySyncImport` / `computeSyncDiff` に `viewerTenantId` 必須引数 + projectId の tenant 検証
- [x] export 系 (`exportKnowledgeSync` / `exportRisksSync` / `exportRetrospectivesSync` / `exportMemosSync`) も合わせて引数追加

### API ルート (Server Component を Phase 1 で塞いだが API は未対応) ✅ 完了 (Phase 2-9)

- [x] `GET /api/admin/audit-logs/route.ts` — 自テナント限定 (User リレーション経由)
- [x] `GET /api/admin/role-change-logs/route.ts` — 自テナント限定 (User リレーション経由)
- [x] `GET /api/admin/usage-summary/route.ts` — 自テナント分のみ返す (将来 super_admin 導入時にロール分岐)
- [x] `POST /api/attachments/batch` の admin 分岐: 親 entity の tenantId 検証 (severity-1 IDOR を遮断)

## Phase 2 MEDIUM (構造的脆弱性 — 監査ログ / トークンの tenant 帰属明示化)

> **現状の制約**: 以下のモデルは schema にまだ tenantId 列が存在しない (`AuditLog` / `RoleChangeLog` / `EmailVerificationToken` / `RecoveryCode` / `PasswordResetToken` / `PasswordHistory`)。
>   `recordAuditLog` 等の `data.tenantId` 明示には schema migration が前提となる。
> **暫定対応 (Phase 2-9)**: API 側 (admin/audit-logs, admin/role-change-logs) で User リレーション経由で `where.user.tenantId = viewerTenantId` を強制し、テナント越境取得を遮断済。
> **後続 Phase 2-10 (要 DB 列追加)**:

- [ ] `AuditLog` / `RoleChangeLog` / `EmailVerificationToken` / `RecoveryCode` / `PasswordResetToken` / `PasswordHistory` に `tenantId` 列追加 (Prisma migration)
- [ ] `audit.service.ts`: `recordAuditLog` / `recordAuditLogBulk` の data に `tenantId` 明示
- [ ] `email-verification.service.ts`: `EmailVerificationToken.create` / `RecoveryCode.createMany` の data に `tenantId` 明示

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
