# E2E カバレッジ一覧 (PR #90 以降 継続更新)

> PR #92 で Steps 1-6 (admin セットアップ + 招待 + プロジェクト作成 + メンバー login) を追加。
> PR #93 で Step 7 の前半 (プロジェクト詳細タブ render + ロール別表示差分 + 全横断一覧 4 画面) を追加。WBS/Gantt/Estimates の複雑 UI と各 entity の CRUD 詳細は後続 PR。
> PR #94 で Step 8 (個人機能: /my-tasks / /memos / /all-memos / /settings テーマ変更) を追加。
> PR #95 で Steps 9-12 (ログアウト + 削除 + 残存検証) + ダッシュボード視覚回帰雛形 (baseline 未 commit) を追加。段階導入プラン完了。
> PR #96 で追加機能: WBS / Gantt / 見積の E2E + 視覚回帰有効化 (baseline 生成 workflow)。

> このファイルは **E2E テストでカバーする機能のマニフェスト**です。
>
> - 新しい画面 / API ルートを追加したら、**必ずこのファイルにエントリを追加**してください
> - カバレッジが不足していれば `pnpm e2e:coverage-check` で警告されます (CI で実行)
> - チェック状態:
>   - [x] 完全カバー済 (specs/ に対応テストあり)
>   - [ ] 未カバー (追加予定、ignore する場合は `skip: <理由>` を併記)

## 用途
- 機能追加時の E2E テストシナリオ横展開漏れ防止
- レビュー時のカバレッジ把握
- 将来の RTL 導入時の棚卸し根拠

---

## 画面 (pages)

### 認証系
- [x] `/login` — e2e/specs/00-smoke.spec.ts + e2e/specs/01-admin-and-member-setup.spec.ts (MFA 有り/無しの両経路)
- [x] `/reset-password` — e2e/visual/auth-screens.spec.ts (視覚回帰のみ、機能は PR #E 以降)
- [x] `/login/mfa` — e2e/specs/01-admin-and-member-setup.spec.ts (PR #92 / Step 2b + Step 5)
- [x] `/setup-password` — e2e/specs/01-admin-and-member-setup.spec.ts (PR #92 / Step 4, general ユーザ招待経路)
- [x] `/signup` — e2e/specs/14-signup-3tier-eligibility.spec.ts (ADR-0016 Revised / 2026-05-22 / 3 層 eligibility 判定: 層 1 自前テナント保有 → フォーム disable + 問合せ動線 / 層 3 完全新規 → Beginner 活性 / フォーム render smoke)。送信完了まで踏み込まず UI 判定挙動のみを検証 (DB 汚染回避)。サインアップ完了動作は単体テスト src/app/api/auth/signup/route.test.ts (9 件) + src/services/tenant-onboarding.service.test.ts (3 層判定 + SA-2) で担保

### 公開ページ (未認証アクセス可)
- (2026-05-21 / feat/legal-pages-lp-integration): 利用規約・プライバシーポリシーは外部 LP
  (HomePage / tasukiba-user.md の #terms / #privacy アンカー) に集約済。本サービス内の
  /terms /privacy ページは廃止 (= E2E 対象外)。ログイン画面フッタの LP リンク href 値は
  e2e/specs/00-smoke.spec.ts で検証。
- [x] `/changelog` — e2e/specs/15-version-and-announcements.spec.ts (feat/app-version-changelog-footer / 2026-05-23 / CHANGELOG.md 読み出し + v1.0.0 エントリ render + ページ titleと intro 文言)
- [x] `/announcements` — e2e/specs/15-version-and-announcements.spec.ts (一覧 render + 2026-06-01 launch エントリの slug link + severity badge)
- [x] `/announcements/[slug]` — e2e/specs/15-version-and-announcements.spec.ts (slug=2026-06-01-launch の詳細 render + frontmatter から title 表示 + 一覧へ戻るリンク)

### ダッシュボード
- [x] `/projects` — e2e/specs/01-admin-and-member-setup.spec.ts (PR #92 / Step 5 作成 + Step 6b 一般ユーザ閲覧)
- [x] `/projects/[projectId]` — e2e/specs/02-project-detail-tabs.spec.ts (PR #93 / Step 7 タブ render + ロール差分)
- [x] `/projects/[projectId]/estimates` — e2e/specs/08-estimates.spec.ts (PR #96 / CRUD + 確定 + 削除)
- [x] `/projects/[projectId]/tasks` — e2e/specs/06-wbs-tasks.spec.ts (PR #96 / WP + ACT API 作成 + UI 表示 + 削除)
- [x] `/projects/[projectId]/gantt` — e2e/specs/07-gantt-timeline.spec.ts (PR #96 / 画面 render + ACT 表示 + フィルタ UI)
- [ ] `/projects/[projectId]/risks` — skip: CRUD 詳細は後続 PR (タブ表示は PR #93 で render smoke 済)
- [ ] `/projects/[projectId]/issues` — skip: CRUD 詳細は後続 PR (タブ表示は PR #93 で render smoke 済)
- [ ] `/projects/[projectId]/retrospectives` — skip: CRUD 詳細は後続 PR (タブ表示は PR #93 で render smoke 済)
- [ ] `/projects/[projectId]/knowledge` — skip: CRUD 詳細は後続 PR (タブ表示は PR #93 で render smoke 済)
- [ ] `/projects/[projectId]/stakeholders` — skip: feat/stakeholder-management で新設、CRUD 詳細 + PM/TL 限定タブ表示の E2E は後続 PR (タブ自体は project-detail-client 内でレンダリング、独立 page.tsx は持たない)
- [x] `/risks` (全リスク) — e2e/specs/03-global-entity-lists.spec.ts (PR #93) + e2e/specs/16-column-sort.spec.ts (PR fix/sortable-header-dropdown-portal / 2026-05-24 / SortableResizableHead パターンの sort dropdown 可視性)
- [x] `/issues` (全課題) — e2e/specs/03-global-entity-lists.spec.ts (PR #93)
- [x] `/retrospectives` (全振り返り) — e2e/specs/03-global-entity-lists.spec.ts (PR #93)
- [x] `/knowledge` (全ナレッジ) — e2e/specs/03-global-entity-lists.spec.ts (PR #93)
- [x] `/memos` — e2e/specs/04-personal-features.spec.ts (PR #94 / メモ作成 API + UI 一覧 + UI 削除)
- [x] `/all-memos` — e2e/specs/04-personal-features.spec.ts (PR #94 / 公開メモの一覧表示)
- [x] `/my-tasks` — e2e/specs/04-personal-features.spec.ts (PR #94 / 画面 render)
- [x] `/settings` — e2e/specs/01-admin-and-member-setup.spec.ts (PR #92 / パスワード変更 + MFA 有効化) + e2e/specs/04-personal-features.spec.ts (PR #94 / テーマ変更)
- [x] `/settings/about` — e2e/specs/15-version-and-announcements.spec.ts (feat/app-version-changelog-footer / 2026-05-23 / サービス情報セクション + バージョン表示 + 運営者名 + 法定リンク href 値)
- [ ] `/guide` — skip: PR I (2026-05-09 / #1) 静的 + tab 切替のみの使い方ガイド。auth リダイレクト + ロール別 initialTab は src/app/(dashboard)/guide/page.test.ts で担保。視覚回帰 + tab 切替の E2E は v1.x で検討
- [ ] `/help` — skip: PR I (2026-05-09 / #2) 静的 + accordion のみの FAQ。auth リダイレクト + tenant admin セクション条件分岐は src/app/(dashboard)/help/page.test.ts で担保。E2E は v1.x で検討

### admin 専用
- [x] `/admin/users` — e2e/specs/01-admin-and-member-setup.spec.ts (PR #92 / Step 3 招待)
- [ ] `/admin/audit-logs` — skip: 監査ログ閲覧、read-only で優先度低
- [ ] `/admin/role-changes` — skip: 権限変更履歴、read-only で優先度低
- [x] `/customers` — e2e/specs/09-customers.spec.ts (PR #111-2 / admin 専用画面の新規登録 + 一覧削除) + e2e/specs/16-column-sort.spec.ts (PR fix/sortable-header-dropdown-portal / 2026-05-24 / plain TableHead パターンの sort dropdown 可視性 + body Portal 検証)。視覚回帰は並列テストで tbody 行数が変動するため対象外 (LESSONS §4.15 / §4.31 / settings-themes でテーマ回帰はカバー)
- [x] `/customers/[customerId]` — e2e/specs/09-customers.spec.ts (PR #111-2 / 詳細画面編集 + active Project 紐付きカスケード削除) + e2e/visual/customers-screens.spec.ts (PR #111-2 / light テーマ詳細、単独スコープで決定化)
- [ ] `/settings/tenant` — skip: PR-X4 (テナント管理者プラン変更 UI、admin 限定)。CRUD 単体テストは src/services/tenant-self.service.test.ts で対応 (E2E は V1.x 多テナント対応時に追加検討)

### super_admin 専用 (PR-X2 / 2026-05-07)
- [x] `/admin/super` — e2e/specs/13-super-admin-dashboard.spec.ts (2026-05-11 / 顧客集計 + Default 別セクション表示)
- [x] `/admin/super/tenants` — e2e/specs/13-super-admin-dashboard.spec.ts (2026-05-11 / 顧客テナント一覧 + Default 別行 + 請求対象外ラベル)
- [ ] `/admin/super/tenants/[id]` — skip: PR-X2 (テナント詳細、運営者専用 read-only)。Default テナント表示時の「請求対象外」ラベル検証は src/services/super-admin.service.test.ts (getTenantDetail 系) で担保
- [ ] `/admin/super/tenants/new` — skip: P-G (2026-05-08) super_admin 専用テナント手動払い出し画面。フォーム + 作成 API 連携は src/services/tenant-onboarding.service.test.ts (11 件) で担保
- [x] `/admin/super/usage` — e2e/specs/13-super-admin-dashboard.spec.ts (2026-05-11 / 合計課金表示 + プラン別分布)
- [ ] `/admin/super/cron-history` — skip: PR feat/cron-execution-log (2026-05-18) super_admin 限定 cron 実行履歴ビュー。SSR + Prisma 直接読みのため、ロジック検証はサービス層 (src/lib/cron-execution-log.test.ts 6 件) で担保。実画面の表示確認は手動 (= 日次 cron が蓄積したレコードを目視確認)
- [ ] `/admin/super/stripe-dlq` — skip: PR-V7 #6 (2026-05-19) Stripe DLQ 監視 + 手動再投入。SSR + Prisma 直接読み + 再投入ボタンは client component で API 呼出。ロジック検証はサービス層 (src/services/stripe-dlq.service.test.ts 8 件) で担保。実画面 + 再投入挙動は手動確認 (= Stripe Test Mode で意図的に失敗させて DLQ に積み、再投入動作を確認)
- [ ] `/admin/super/billing` — skip: PR-V7 #8 (2026-05-19) 請求ダッシュボード (サマリ画面、当月 + 直近 6 ヶ月推移)。SSR + Prisma 集計のみ。ロジック検証はサービス層 (src/services/billing-dashboard.service.test.ts 16 件) で担保
- [ ] `/admin/super/billing/[yearMonth]` — skip: PR-V7 #8 (2026-05-19) 請求ダッシュボード月次詳細 (テナント別 BillingHistory 一覧 + status/paymentMethod フィルタ + Stripe Dashboard ディープリンク)。SSR + Prisma findMany のみ。同上のサービステストで担保
- [ ] `/admin/super/diagnostics` — skip: PR-V8 (2026-05-19) 診断ダッシュボード (= API drift / cron 健全性 / 縮退モード / メール失敗 / alert 機構を俯瞰 + 修復ボタン経由で `/api/admin/super/tenants/[id]/repair-api-usage` 呼出)。SSR + Server Component で集約サービス (diagnostics.service / cron-health.service) を呼ぶのみ。ロジック検証はサービステスト (cron-health.service.test.ts 12 件 + api-usage-recalc.service.test.ts 12 件 + 既存 mail/degraded テスト) で担保
- [ ] `/admin/super/tenants/[id]/diagnostics` — skip: PR-V8 (2026-05-19) 個別テナント診断 (counter vs SUM 整合性 + 直近 30 日 ApiCallLog 時系列 + counter 書き換え系 audit_log 抽出 + 月次履歴比較)。tenant-diagnostics.service.ts が集約、各個別ロジックは既存サービステストでカバー済 (api-usage-recalc / monthly-history-regenerate / audit)
- [ ] `/admin/super/email-failures` — skip: PR-V7a (2026-05-19) メール送付失敗一覧画面 (= 直近 N 時間の success=false な EmailSendLog を表示)。SSR + Prisma findMany。サービス層 (src/services/email-send-log.service.test.ts の getRecentFailedEmails 3 件) で担保
- [ ] `/settings/tenant/billing` — skip: PR-V7a (2026-05-19) テナント管理者向け請求履歴表示。自テナント直近 6 ヶ月の BillingHistory + 入金日/期日/次回引落 表示。tenant-scoped クエリ (= viewerTenantId 必須)。サービス層 (src/services/billing-management.service.test.ts の getTenantBillingHistory 2 件) で担保

### その他
- [ ] `/` (ルート) — skip: プロジェクト一覧へのリダイレクト、PR #B の /projects で間接カバー

---

## API Routes

### 認証
- [x] `/api/auth/signin` — e2e/specs/01-admin-and-member-setup.spec.ts (PR #92 / 複数ステップで使用)
- [x] `/api/auth/signout` — e2e/specs/05-teardown-and-residuals.spec.ts (PR #95 / Step 9 UI ログアウト経由)
- [ ] `/api/auth/explicit-signout` — skip: fix/session-clearance (2026-05-20) で導入。Netlify 固有の Set-Cookie 脱落対策のため E2E (Playwright) では再現不能。単体テスト (src/app/api/auth/explicit-signout/route.test.ts 5 ケース) + Netlify Deploy Preview の実機確認で担保 (KDD §5.X+84)
- [ ] `/api/auth/lock-status` — skip: PR #E (ロック誘発シナリオは非決定的で後回し)
- [ ] `/api/auth/check-tenant-eligibility` — skip: ADR-0016 Revised (2026-05-22) で 3 値返却 (signupAllowed / beginnerAvailable / reason) に拡張。UI ヒント専用 API (= bypass されても tenant-onboarding.service.ts の 3 層判定が defense-in-depth で動作)。単体テスト (src/app/api/auth/check-tenant-eligibility/route.test.ts 6 ケース) で担保。E2E /signup spec が間接的に API レスポンスを検証
- [ ] `/api/auth/current-tenant-info` — skip: PR #420 (2026-05-25) login 画面の localStorage 履歴用に slug + name を post-auth 返却 (列挙不可、認証必須)。tenant-history.ts (src/lib/tenant-history.test.ts 15 ケース) と組み合わせ UI 経由で挙動確認。専用 E2E は将来検討
- [x] `/api/auth/mfa/setup` — e2e/specs/01-admin-and-member-setup.spec.ts (PR #92 / Step 2)
- [x] `/api/auth/mfa/enable` — e2e/specs/01-admin-and-member-setup.spec.ts (PR #92 / Step 2)
- [ ] `/api/auth/mfa/disable` — skip: PR #D (admin は無効化不可 / 一般ユーザ経路は設定画面)
- [x] `/api/auth/mfa/verify` — e2e/specs/01-admin-and-member-setup.spec.ts (PR #92 / Step 2b + Step 5 再ログイン)
- [ ] `/api/auth/reset-password` — skip: PR #E (パスワードリセットフロー)
- [x] `/api/auth/setup-password` — e2e/specs/01-admin-and-member-setup.spec.ts (PR #92 / Step 4 general 経路)
- [x] `/api/auth/change-password` — e2e/specs/01-admin-and-member-setup.spec.ts (PR #92 / Step 1 設定画面経由)
- [ ] `/api/auth/delete-account` — skip: セルフ削除は UI 無く、テストには recoveryCode が必要 (招待フロー経由の general のみ保有)。PR #95 では admin による他ユーザ削除 (`/api/admin/users/[userId]` DELETE) で teardown 代替
- [x] `/api/auth/verify-email` — e2e/specs/01-admin-and-member-setup.spec.ts (PR #92 / 招待メール + setup-password で間接カバー)
- [ ] `/api/auth/setup-mfa-initial` — skip: PR #D (admin 招待 + 初期 MFA 経路、PR #91 追加)
- [ ] `/api/auth/resend-verification` — skip: Phase 1 (2026-05-23 / feat/signup-email-resend-ux) サインアップ成功画面からの招待メール再送 API。3 軸 Rate Limit (IP 3/h + tenant 3/h + email 5/day) + enumeration 防止 + zod 検証は src/app/api/auth/resend-verification/route.test.ts (10 ケース) + src/services/email-verification.service.test.ts の resendVerificationEmail 群 (6 ケース) で担保。E2E は V1.x で検討 (= signup E2E 自体が未対応のため間接カバー対象外)

### プロジェクト
- [x] `GET /api/projects` — e2e/specs/01-admin-and-member-setup.spec.ts (PR #92 / Step 5 + 6b 画面表示)
- [x] `POST /api/projects` — e2e/specs/01-admin-and-member-setup.spec.ts (PR #92 / Step 5 API 経由)
- [ ] `GET /api/projects/[projectId]` — skip: PR #C
- [ ] `PATCH /api/projects/[projectId]` — skip: PR #C
- [x] `DELETE /api/projects/[projectId]` — e2e/specs/05-teardown-and-residuals.spec.ts (PR #95 / Step 11 削除ダイアログ経由)
- [ ] `PATCH /api/projects/[projectId]/status` — skip: PR #C

### タスク (WBS) / ガント
- [x] `/api/projects/[projectId]/tasks/*` — e2e/specs/06-wbs-tasks.spec.ts (PR #96 / POST WP + ACT / DELETE は UI 経由) ※ bulk/progress/export/import/recalculate/tree は後続 PR
- [ ] `/api/projects/[projectId]/tasks/bulk-duplicate` — skip: PR #420 (2026-05-25) WBS タスク一括複製 API。階層保持 + 名称衝突自動リネーム + 実績リセットの service ロジックは src/services/task-duplicate.service.test.ts (17 ケース) で担保。専用 E2E は将来検討
- [ ] `/api/projects/[projectId]/tasks/sync-import` — skip: feat/wbs-overwrite-import で新設。CRUD 単体テストは src/services/task-sync-import.service.test.ts で対応 (E2E は後続 PR)
- [ ] `/api/projects/[projectId]/tasks/workload` — skip: PR H (#7 / 2026-05-09) で新設。担当者別日次工数集計を返す純関数 + Prisma findMany のみ。集計ロジックは src/services/task.service.test.ts の getAssigneeDailyWorkload で対応 (E2E は後続 PR)
- [ ] `/api/projects/[projectId]/tasks/workload/preview` (GET) — skip: PR #361 (2026-05-14) WBS ACT 編集中の日次工数プレビュー API。assigneeId + startDate + endDate + plannedEffort + excludeTaskId? を query で受け、現プロジェクト範囲で当該担当者の他タスクと合算した 1 日あたり最大工数を返す。**テナント越境防止**は service 層の `project.tenantId` フィルタ + route 層の `checkProjectPermission(task:read)` で二重防御。サービステスト 7 件 + route テスト 7 件で担保 (うち越境 invariant テスト 2 件)。UI 側は PM/TL ロール (`canEditPmTl`) のみで表示
- [x] `/api/projects/[projectId]/gantt` — e2e/specs/07-gantt-timeline.spec.ts (PR #96 / 画面経由で GET)

### ステークホルダー (PMBOK 13 / feat/stakeholder-management)
- [ ] `/api/projects/[projectId]/stakeholders/*` — skip: PM/TL + admin 限定。CRUD 単体テストは src/services/stakeholder.service.test.ts で対応 (E2E は後続 PR)

### リスク / 課題 / 振り返り / ナレッジ / サジェスト / メンバー
- [ ] `/api/projects/[projectId]/risks/*` — skip: PR #C
- [ ] `/api/projects/[projectId]/risks/[riskId]/link` (POST/DELETE) — skip: PR feat/asset-multi-linking-ui Phase 2 で追加。M:N 紐付けの link/unlink。unit test src/services/risk.service.test.ts で linkRiskToProject / unlinkRiskFromProject を担保
- [ ] `/api/projects/[projectId]/retrospectives/*` — skip: PR #C
- [ ] `/api/projects/[projectId]/retrospectives/[retroId]/link` (POST/DELETE) — skip: 同上 (retrospective)。unit test src/services/retrospective.service.test.ts で担保
- [ ] `/api/projects/[projectId]/knowledge/*` — skip: PR #C
- [ ] `/api/projects/[projectId]/suggestions/*` — skip: PR #C (提案型サービス、核心機能)
- [x] `/api/projects/[projectId]/members/*` — e2e/specs/01-admin-and-member-setup.spec.ts (PR #92 / Step 6a POST, GET は画面経由)
- [ ] `/api/projects/[projectId]/available-users` — skip: feat/crud-permission-redesign (2026-05-20) で新設。PM/TL のメンバー追加候補リスト取得用。単体テストで認可と tenantId 絞り込みを検証
- [ ] `/api/risks` (全リスク) — skip: PR #C
- [ ] `/api/risks/[riskId]` (横断 DELETE) — skip: feat/crud-permission-redesign (2026-05-20) で新設。admin のみの全リスク/課題画面モデレーション削除。単体テスト (service の context='global') で認可検証
- [ ] `/api/retrospectives` (全振り返り) — skip: PR #C
- [ ] `/api/retrospectives/[retroId]` (横断 DELETE) — skip: feat/crud-permission-redesign (2026-05-20) で新設。admin のみの全振り返り画面モデレーション削除。単体テスト (service の context='global') で認可検証
- [ ] `/api/knowledge` (全ナレッジ) — skip: PR #C
- [ ] `/api/knowledge/[knowledgeId]` — skip: PR #C
- [x] `/api/projects/[projectId]/risks/bulk` (PATCH 一括更新, PR #161 → PR #165 で project-scoped に移し替え) — e2e/specs/10-project-list-bulk-update.spec.ts (FILTER_REQUIRED 二重防御 + 200 構造検証)
- [x] `/api/projects/[projectId]/retrospectives/bulk` (PATCH 一括 visibility, PR #162 → PR #165) — e2e/specs/10-project-list-bulk-update.spec.ts
- [x] `/api/projects/[projectId]/knowledge/bulk` (PATCH 一括 visibility, PR #162 → PR #165) — e2e/specs/10-project-list-bulk-update.spec.ts

### チャット意味検索 (PR #373 仕様 / 本機能で新設)
- [ ] `/api/chat/search` (POST) — skip: PR feat/chat-semantic-search (2026-05-23) で新設。5 資産横断意味検索の API。認証・seedDataEnabled・縮退モード・visibility フィルタは単体テスト src/services/chat-search.service.test.ts + src/app/api/chat/search/route.test.ts で担保 (10 ケース)。E2E は FAB クリック → サイドパネル展開 → 検索結果 tier 表示の経路を後続 PR で追加検討 (UI 動作は src/components/chat-semantic-search/* で別途検証想定)

### メモ
- [x] `/api/memos` (GET/POST) — e2e/specs/04-personal-features.spec.ts (PR #94 / POST 作成 + GET は /memos と /all-memos の画面経由)
- [x] `/api/memos/[id]` (PATCH/DELETE) — e2e/specs/04-personal-features.spec.ts (PR #94 / DELETE のみ UI 経由でカバー、PATCH は後続 PR)
- [x] `/api/memos/bulk` (PATCH 一括 visibility, PR #162、PR #165 で /memos personal page から呼ぶよう変更) — e2e/specs/10-project-list-bulk-update.spec.ts
- [ ] `/api/memos/sync-import` — skip: T-22 Phase 22d で新設。CRUD 単体テストは src/services/memo-sync-import.service.test.ts を後続 PR で追加予定 (現状は parser/diff 共通パターンが Phase 22a の risk-sync-import.service.test.ts で検証済)
- [ ] `/api/memos/export` — skip: T-22 Phase 22d で新設、4 列 CSV 出力。E2E は sync-import と往復編集サイクルでまとめてカバー予定 (後続 PR)

### 添付
- [ ] `/api/attachments/*` — skip: 各親エンティティの spec 経由で間接カバー

### コメント (PR #199)
- [ ] `/api/comments` (GET/POST) — skip: MVP は単体テスト (`src/services/comment.service.test.ts` + `src/lib/validators/comment.test.ts`) でカバー、E2E は各 entity の編集 dialog spec 経由で後続 PR
- [ ] `/api/comments/[id]` (PATCH/DELETE) — skip: 同上 (投稿者本人/admin 認可は単体テストで担保)

### 通知 (PR feat/notifications-mvp)
- [ ] `/api/notifications` (GET) — skip: MVP は単体テスト (`src/services/notification.service.test.ts` + `src/app/api/notifications/route.test.ts`) でカバー
- [ ] `/api/notifications/[id]` (PATCH) — skip: 単体テストで認可マトリクス (本人/他人/admin/404) を網羅
- [ ] `/api/notifications/mark-all-read` (POST) — skip: service テストで一括既読を検証
- [ ] `/api/cron/daily-notifications` (POST) — skip: cron 認可 + dedupeKey + JST 境界の単体テストで担保

### Tenant 月次リセット (PR #2-d / T-03)
- [ ] `/api/cron/tenant-monthly-reset` (POST) — skip: cron 認可 + 月初リセット + scheduledPlanChangeAt 適用の単体テスト (`src/services/tenant-monthly-reset.service.test.ts` 11 件 + `src/app/api/cron/tenant-monthly-reset/route.test.ts` 5 件) で担保。E2E の対象外 (Vercel Cron 経由のみで UI 経路なし)

### 使用量監視 (PR #7 / T-03)
- [ ] `/api/cron/daily-usage-aggregation` (POST) — skip: cron 認可 + 集計 + 異常検知 + 予算アラート + admin メール通知の単体テスト (`src/services/usage-monitoring.service.test.ts` 12 件) で担保。E2E の対象外 (Vercel Cron 経由のみで UI 経路なし)
- [ ] `/api/cron/stripe-usage-flush` (POST) — skip: PR-S6 (2026-05-14) Stripe Usage Record queue flush cron (日次、05:00 UTC)。Vercel Hobby プランの cron 最小間隔制約「1 日 1 回」に合わせて日次運用。Stripe Usage Record の timestamp パラメタで実呼出時刻を送るため翌日送信でも月末請求の正確性は維持。cron 認可 + queue 処理 (成功/失敗/DLQ/subscriptionItemId 不整合) は src/services/stripe-usage-flush.service.test.ts (8 件) + src/app/api/cron/stripe-usage-flush/route.test.ts (5 件) で担保。Stripe Test Mode との結合テストは v2 で検討
- [ ] `/api/cron/stripe-auto-suspend` (POST) — skip: PR-S6 (2026-05-14) Stripe 引落失敗による自動 suspend cron (日次)。autoSuspendScheduledAt 到来テナントに `suspendTenant('payment_delinquent')` を呼出。cron 認可 + skip カウンタ (ALREADY_SUSPENDED 等) + errors 配列は src/services/stripe-auto-suspend.service.test.ts (7 件) + src/app/api/cron/stripe-auto-suspend/route.test.ts (5 件) で担保
- [ ] `/api/cron/stripe-reconcile` (POST) — skip: PR-V7 #5 (2026-05-19) Stripe ↔ DB 状態照合 cron (月初)。credit_card 払いテナント全件について Stripe Subscription 状態を取得し、DB の `tenant.stripeSubscriptionStatus` と乖離があれば Stripe 値で上書き + auditLog 記録 (= Webhook 配信遅延 / DLQ 永続失敗による DB-Stripe 乖離を自動補正)。cron 認可 + matched/corrected/lostAndCanceled/errors 集計は src/services/stripe-reconcile.service.test.ts (7 件) + src/app/api/cron/stripe-reconcile/route.test.ts (5 件) で担保
- [ ] `/api/admin/usage-summary` (GET) — skip: admin 認可 + JSON 集計返却の単体テストで担保。super_admin ダッシュボード UI (PR-X2) 実装時に E2E 化予定
- [x] `/api/admin/super/usage/export` (GET) — e2e/specs/13-super-admin-dashboard.spec.ts (2026-05-11 / 当月 CSV: Storage 合算 / Default 除外 / 認可 403) + src/app/api/admin/super/usage/export/route.test.ts (12 ユニット: 当月・過去月・BOM・エスケープ・yearMonth バリデーション)
- [ ] `/api/admin/super/cron-history` (GET) — skip: PR feat/cron-execution-log (2026-05-18) super_admin 限定 cron 実行履歴 JSON API。本 API は super_admin ページの代替アクセス手段 (主経路は SSR ページ)。認可ロジック (isSuperAdmin) は src/lib/permissions/role.test.ts で担保、prisma クエリ部分は単純な findMany のためサービステスト不要
- [ ] `/api/admin/super/stripe-dlq/webhook/[id]/retry` (POST) — skip: PR-V7 #6 (2026-05-19) Stripe Webhook DLQ 手動再投入。super_admin 認可 + 4xx エラーケース + retryCount リセット + auditLog 記録は src/services/stripe-dlq.service.test.ts + route.test.ts で担保
- [ ] `/api/admin/super/stripe-dlq/usage/[id]/retry` (POST) — skip: PR-V7 #6 (2026-05-19) Stripe Usage Queue DLQ 手動再投入。同上のテストカバー
- [ ] `/api/admin/super/billing/[id]/confirm-payment` (POST) — skip: PR-V7a (2026-05-19) 銀行振込手動消込。invoice/bank_transfer の pending → paid 遷移 + AuditLog 記録。credit_card は拒否。サービス層 (src/services/billing-management.service.test.ts 9 件) で担保
- [ ] `/api/admin/super/billing/export/[yearMonth]` (GET) — skip: PR-V7a (2026-05-19) 月次請求履歴 CSV エクスポート。getMonthlyBillingDetail 経由 + UTF-8 BOM + 14 列 + status/paymentMethod フィルタ。サービス層 (billing-dashboard.service.test.ts 既存 16 件) で照会ロジック担保。**path 構造**: Next.js dynamic slug 衝突 (`[id]` vs `[yearMonth]`) 回避のため `[yearMonth]/export` ではなく `export/[yearMonth]` 形式
- [ ] `/api/cron/billing-monthly-aggregation` (POST) — skip: PR-V7a (2026-05-19) invoice/bank_transfer 払いテナントの月次請求集計 cron。CRON_SECRET 認可 + per-tenant try/catch + status 別 upsert ガード。サービス層 (src/services/billing-aggregation.service.test.ts 10 件) で担保
- [ ] `/api/cron/billing-overdue-alert` (POST) — skip: PR-V7a (2026-05-19) 銀行振込期日超過 alert cron (日次)。期日 + 5 日超過 + 24h dedup + super_admin メール送信。サービス層 (src/services/admin-alert.service.test.ts の detectAndAlertOverdueInvoices 3 件) で担保
- [ ] `/api/cron/cron-failure-alert` (POST) — skip: PR-V7a (2026-05-19) cron 失敗 alert cron (日次)。直近 24h failure を cron 名別集約 + super_admin メール送信。サービス層 (src/services/admin-alert.service.test.ts の detectAndAlertCronFailures 2 件) で担保
- [ ] `/api/cron/diagnostics-daily-alert` (POST) — skip: PR-V8.4 (2026-05-19) 診断ダッシュボード anomalies 日次 push alert (日次)。getDiagnosticsSummary を実行し totalAnomalies > 0 なら super_admin にメール通知。ダッシュボード未閲覧期間の無音対策。サービス層 (src/services/admin-alert.service.ts:detectAndAlertDiagnosticsAnomalies) で担保。診断 9 検知の網羅性は src/services/diagnostics.service.test.ts 経由
- [ ] `/api/admin/super/tenants` (POST) — skip: P-G (2026-05-08) super_admin 専用テナント手動払い出し API。zod バリデーション + slug/email 重複検出 + compensating delete はサービステスト (tenant-onboarding.service.test.ts 11 件) で担保
- [ ] `/api/admin/super/tenants/[id]` (DELETE) — skip: P-A (2026-05-08) super_admin 限定テナント論理削除。MANAGEMENT_TENANT_FORBIDDEN / TENANT_NOT_FOUND / ALREADY_DELETED + カスケード (10 業務エンティティ + 監査ログ) は src/services/super-admin.service.test.ts (deleteTenant 6 テスト) で担保。E2E は V1.x で検討
- [ ] `/api/admin/super/tenants/[id]/suspend` (POST) — skip: PR #372 (2026-05-14) super_admin 限定テナント read-only 強制移行。MANAGEMENT_TENANT_FORBIDDEN / TENANT_NOT_FOUND / TENANT_DELETED / ALREADY_SUSPENDED / INVALID_REASON + tokenVersion increment による即時セッション失効は src/services/super-admin.service.test.ts (suspendTenant 7 テスト) + src/app/api/admin/super/tenants/[id]/suspend/route.test.ts (9 テスト) で担保。middleware 遮断は src/lib/auth.config.test.ts (TENANT_SUSPENDED 6 テスト) で担保。E2E は V1.x で検討 (= サブスクリプション中断の決定論性確保が難しい)
- [ ] `/api/admin/super/tenants/[id]/resume` (POST) — skip: PR #372 (2026-05-14) super_admin 限定テナント read-only 解除。TENANT_NOT_FOUND / TENANT_DELETED / NOT_SUSPENDED + suspendedBy 監査保持は src/services/super-admin.service.test.ts (resumeTenant 4 テスト) + src/app/api/admin/super/tenants/[id]/resume/route.test.ts (5 テスト) で担保
- [ ] `/api/auth/signup` (POST) — skip: 公開セルフサインアップ。IP-based rate limit (5/hour) + honeypot (hp_url) + ルート単体テスト src/app/api/auth/signup/route.test.ts (9 件: plan 上書き削除検証 + OWNED_TENANT_EXISTS / BEGINNER_REQUIRES_UPGRADE / SLUG_CONFLICT / EMAIL_SEND_FAILED ハンドリング) + サービステスト src/services/tenant-onboarding.service.test.ts (3 層判定 + SA-2 + createdByUserId 紐付け) で担保。完全送信動作は DB 汚染回避のため E2E 対象外、UI 挙動は 14-signup-3tier-eligibility.spec.ts で部分カバー
- [ ] `/api/tenants/me/billing` (PATCH) — skip: P-G (2026-05-08) テナント管理者の請求先情報編集。zod バリデーション + サービステスト (tenant-self.service.test.ts) で担保
- [ ] `/api/tenants/me/billing/stripe/setup` (POST) — skip: PR-S3 (2026-05-14) クレジットカード払い切替の Stripe Checkout Session 作成 API。認可 (admin → 通過、general → 403) + feature flag (STRIPE_ENABLED) + 既に credit_card で 409 + Stripe API エラー変換 は src/app/api/tenants/me/billing/stripe/setup/route.test.ts (10 ユニット) で担保。Stripe Test Mode 経由の E2E は v2 で検討
- [ ] `/api/tenants/me/billing/stripe/setup/complete` (GET) — skip: PR-S3 (2026-05-14) Stripe Checkout 完了後の Subscription 作成 + paymentMethod 切替ハンドラ。session_id 検証 / オープンリダイレクト対策 / failure reason マッピング は src/app/api/tenants/me/billing/stripe/setup/complete/route.test.ts (12 ユニット) で担保
- [ ] `/api/tenants/me/billing/stripe/portal` (POST) — skip: PR-S3 (2026-05-14) Stripe Customer Portal Session 作成 API。NO_STRIPE_CUSTOMER 409 + 認可 + feature flag は src/app/api/tenants/me/billing/stripe/portal/route.test.ts (6 ユニット) で担保。PR #425 (2026-05-22 / KDD §5.X+109) で UI 経路から撤去 (= 「クレジットカード情報更新」ボタンは常に Stripe Checkout setup に遷移する設計に統一)、本 endpoint は orphan として残置 (= 後続 PR で削除 or 410 化検討)
- [ ] `/api/tenants/me/billing/stripe/setup-with-existing-card` (POST) — skip: PR #425 (2026-05-22) 既存カード判定 + 自動 Subscription 作成 UX 改善 API。setupSubscriptionWithExistingCard service は src/services/stripe-billing.service.ts で実装、Stripe API モック + Customer.invoice_settings.default_payment_method 読み + 既存 active Subscription 全 cancel + 新規 Subscription 作成 + Customer デフォルト同期の一連は ユニットテストで担保。実 Stripe Test Mode 結合 + UI 経由動線 (= BillingContactSection の invoice→credit_card 切替で本 endpoint 自動呼出) は TC-1 で UAT 済。E2E 自動化は v2 で検討
- [ ] `/api/tenants/me/billing/stripe/verify` (POST) — skip: PR-S3 (2026-05-14) $0 SetupIntent によるカード検証 API。NO_CARD_REGISTERED 409 + valid/expired/declined 各状態の返却 は src/app/api/tenants/me/billing/stripe/verify/route.test.ts (6 ユニット) で担保
- [ ] `/api/tenants/me/i18n` (GET / PATCH) — skip: PR-1 (2026-05-15) テナント単位 timezone / locale 設定 API (admin 限定 / general & super_admin は 403)。zod バリデーション + 認可 + 部分更新 + DB 保存 + JWT 反映フローは `src/app/api/tenants/me/i18n/route.test.ts` (8 ケース) + `src/services/tenant-self.service.test.ts` で担保済。旧 `/api/settings/i18n` (ユーザ単位) を置き換え。UI 側の反映確認は visual regression (settings 画面) で担保
- [ ] `/api/tenants/me/storage-addon` (GET / PATCH / DELETE) — skip: Storage add-on (Phase 2 / 2026-05-08) テナント管理者のストレージプラン管理 (即時アップ / 翌月ダウン予約 / 使用量超過拒否 / Grace state)。サービステスト 22 件 (tenant-storage.service.test.ts) で担保。E2E は V1.x で検討
- [ ] `/api/tenants/me/self-delete` (POST) — skip: 2026-05-08 テナント管理者のセルフ解約 API。テナント名一致確認 + 既存 deleteTenant() (P-A) のカスケード論理削除を再利用。FORBIDDEN / NAME_MISMATCH / ALREADY_DELETED / TENANT_NOT_FOUND の認可・確認ロジックは super-admin.service.test.ts (deleteTenant) で間接担保。E2E は V1.x で検討 (= 自爆系テストのため決定論性確保が難しい)
- [ ] `/api/tenants/me/export` (GET) — skip: P-C (2026-05-08) テナント管理者の全データエクスポート ZIP ダウンロード。テナントスコープ + PII 除去 + ZIP 構造 + UTF-8 BOM 付き CSV は src/services/data-export.service.test.ts (8 件) で担保
- [ ] `/api/admin/super/tenants/[id]/export` (GET) — skip: P-C (2026-05-08) super_admin によるテナント代行エクスポート (顧客サポート用途、監査ログ記録)
- [ ] `/api/tenants/me/import` (POST) — skip: P-D (2026-05-08) テナント管理者の P-C 形式 ZIP 一括取り込み。INVALID_ZIP / INVALID_FORMAT / IMPORT_IN_PROGRESS / BEGINNER_SEAT_LIMIT / FK 書き換え / Email merge / Task 自己参照 / polymorphic entityId は src/services/data-import.service.test.ts (11 件) で担保。E2E は V1.x で検討
- [ ] `/api/tenants/me/external-import/preview` (POST) — skip: Phase 1 (2026-05-08) 外部システムからの初回データ移行 (Knowledge + RiskIssue) 2 段階フローの preview API。INVALID_FILE / FILE_TOO_LARGE / TOO_MANY_ROWS / TENANT_NOT_FOUND / バリデーションエラー / Beginner 月次上限超過 / Expert/Pro 予算上限超過 / RiskIssue projectId 整合性は src/services/external-data-import.service.test.ts (16 件) で担保
- [ ] `/api/tenants/me/external-import/apply` (POST) — skip: Phase 1 (2026-05-08) 外部 import の apply API (= ここで Voyage embedding 全件即時生成 + 課金)。PREVIEW_NOT_FOUND / PREVIEW_NOT_OWNED / PREVIEW_EXPIRED / 認可境界 / apply 直前の二重防御は同テストで担保。E2E は V1.x で検討
- [ ] `/api/tenants/me/external-import/template` (GET) — skip: Phase 1 (2026-05-08) Knowledge / RiskIssue の CSV テンプレートダウンロード。固定列 + サンプル行 + UTF-8 BOM の単純 CSV 生成のため単体テスト不要 (= 静的データ)
- [ ] `/settings/tenant/external-import` (page) — skip: Phase 1 (2026-05-08) 4 ステップウィザード (file→mapping→preview→result) 画面。ブラウザ側の xlsx パース + マッピング選択 UI が中心、E2E は V1.x で検討
- [ ] `/api/admin/super/recalculate-all` (POST) — skip: 2026-05-14 super_admin ダッシュボード遷移時 + 「全テナント再集計」ボタンで呼ぶ on-demand 再集計 API。認可 (super_admin 限定 401/403/200) + Promise.allSettled 部分失敗 + 監査ログ (entityType=system) は src/app/api/admin/super/recalculate-all/route.test.ts (5 ケース) で担保。E2E は V1.x で検討 (= 全テナント集計の決定論性確保が難しい)
- [ ] `/api/admin/super/tenants/[id]/recalculate` (POST) — skip: 2026-05-14 super_admin がテナント詳細画面 + ストレージ TOP10 から特定テナントを on-demand 再集計する代行操作 API。認可 (admin → 403) + テナント不在 404 + 監査ログ (target tenant で記録) は src/app/api/admin/super/tenants/[id]/recalculate/route.test.ts (4 ケース) で担保
- [ ] `/api/admin/super/tenants/[id]/repair-api-usage` (POST) — skip: PR-V8 (2026-05-19) super_admin が drift 検出テナントの counter を ApiCallLog SUM で破壊的上書き。reconciledCallCount で上書き + transaction 内 audit_log 記録 (operation='repair-api-usage') + race ガード方針はサービス層 (src/services/api-usage-recalc.service.test.ts repairTenantApiUsage 系) で担保
- [ ] `/api/admin/super/tenants/[id]/regenerate-monthly-history` (POST) — skip: PR-V8 (2026-05-19) ★請求重要★ 過去月の `tenant_monthly_usage_history` を ApiCallLog SUM (真値) から再生成。テナント TZ 月初範囲集計 + transaction 内 upsert + audit_log (operation='regenerate-monthly-history') はサービス層 (src/services/monthly-history-regenerate.service.test.ts 6 ケース、本件 drift 7/8 regression 含む) で担保
- [ ] `/api/tenants/me/recalculate` (POST) — skip: 2026-05-14 テナント管理者が `/settings/tenant` で自テナントを on-demand 再集計する API。**テナント越境防止 (severity-1)**: URL/Body の tenantId を一切受けず session.user.tenantId で固定する構造的境界。general → 403 / Body に他テナント id を渡しても無視 / 監査ログは自テナントで記録、は src/app/api/tenants/me/recalculate/route.test.ts (6 ケース、越境テスト 3 件含む) で担保
- [ ] `/api/tenants/me/repair-api-usage` (POST) — skip: PR-V8.1 (2026-05-19) ★請求重要★ テナント管理者が自テナントの counter を ApiCallLog SUM (真値) で破壊的上書き。**テナント越境防止 (severity-1)**: URL/Body の tenantId を受けず session.user.tenantId で固定。`repairTenantApiUsage(tenantId, user.id)` 経由で transaction 内 audit_log を自動記録。サービス層 (src/services/api-usage-recalc.service.test.ts repairTenantApiUsage 系) で担保

### メンション (PR feat/comment-mentions)
- [ ] `/api/mention-candidates` (GET) — skip: 単体テスト (`src/app/api/mention-candidates/route.test.ts`) で context (project_list / cross_list / wbs) 別の groups 絞り込み + entityType 別 user 抽出を網羅
- [ ] `/api/comments` (POST、mention 付き) — skip: 既存 `comment.service.test.ts` + 新 `mention.service.test.ts` で kind 展開 / 通知生成 / 自分宛除外 (Q5) / dedupe を網羅

### 見積
- [x] `/api/projects/[projectId]/estimates/*` — e2e/specs/08-estimates.spec.ts (PR #96 / POST 作成 + 確定 + DELETE)

### 顧客 (PR #111)
- [x] `/api/customers` (GET/POST) — e2e/specs/09-customers.spec.ts (PR #111-2 / admin ログイン + 新規登録の UI → API 往復)
- [x] `/api/customers/[customerId]` (GET/PATCH/DELETE) — e2e/specs/09-customers.spec.ts (PR #111-2 / 詳細取得 / 編集 PATCH / active 有無の両方の DELETE + ?cascade=true)

### 管理系
- [x] `/api/admin/users` — e2e/specs/01-admin-and-member-setup.spec.ts (PR #92 / Step 3 POST + Step 6a GET)
- [x] `/api/admin/users/[userId]` — e2e/specs/05-teardown-and-residuals.spec.ts (PR #95 / Step 10 DELETE) ※ PATCH は別 PR
- [ ] `/api/admin/users/[userId]/recovery-codes` — skip: PR #D (リカバリーコード再発行)
- [ ] `/api/admin/users/[userId]/unlock` — skip: ロック誘発が非決定的、手動テスト
- [ ] `/api/admin/users/lock-inactive` — skip: 時間経過 (30 日以上) が必要、手動テスト (旧 `/api/admin/users/cleanup-inactive`、feat/account-lock で改名 + 論理削除→ロック挙動変更)
- [ ] `/api/admin/audit-logs` — skip: read-only
- [ ] `/api/admin/role-change-logs` — skip: read-only
- [ ] `/api/tenants/me` — skip: PR-X4 (テナント管理者プラン変更 API、admin 限定 GET/PATCH/DELETE)。core ロジック (アップグレード即時 / **Expert↔Pro ダウングレード即時 / Beginner ダウングレード完全禁止** (2026-05-14 改修) / 予算上限更新) は src/services/tenant-self.service.ts に集約され、単体テスト + plan-change-flow.e2e.test.ts で網羅。E2E は V1.x 多テナント対応時に検討

### その他
- [x] `GET /api/health` — e2e/specs/00-smoke.spec.ts (副次的に起動確認)
- [x] `/api/my-tasks` — e2e/specs/04-personal-features.spec.ts (PR #94 / /my-tasks 画面経由で間接カバー)
- [x] `/api/settings/theme` — e2e/specs/04-personal-features.spec.ts (PR #94 / テーマ変更 UI から PATCH)
- [x] `/api/settings/i18n` — **削除済 (PR-1 / 2026-05-15)**。`User.timezone / locale` 廃止に伴い `/api/tenants/me/i18n` (テナント単位設定) に置換 (詳細は §テナント自身 セクション参照)
- [x] `/api/cron/cleanup-accounts` — **削除済 (PR #115)**。`/api/admin/users/lock-inactive` (旧名 cleanup-inactive) に一本化
- [ ] `/api/client-errors` — skip: クライアント error boundary 経由の log 送信エンドポイント (PR #115)。ログ送信の失敗はユーザ操作に影響しない (silent fail) 設計で、E2E で再現させる value が低い。単体テストで schema validation + DB 書込を担保

### Stripe 連携 (PR-S2 / PR-S3 / PR-S4 / 2026-05-14, feature flag STRIPE_ENABLED=false で当面無効)
- [ ] `/api/tenants/me/billing/stripe/setup` (POST) — skip: Stripe Test Mode との結合テスト必須、v2 で検討 (PR-S3)。単体テストで認可 + Stripe SDK モック網羅
- [ ] `/api/tenants/me/billing/stripe/setup/complete` (GET, redirect handler) — skip: Stripe Checkout を経由した戻り URL ハンドラ、v2 で検討 (PR-S3)。単体テストでサニタイズ + Phase 1-4 ロジック網羅
- [ ] `/api/tenants/me/billing/stripe/portal` (POST) — skip: Stripe Customer Portal リダイレクト経路、v2 で検討 (PR-S3)。単体テストで Customer 未登録時 + 認可を網羅
- [ ] `/api/tenants/me/billing/stripe/verify` (POST) — skip: Stripe SetupIntent ベースのカード検証、v2 で検討 (PR-S3)。単体テストで verifyTenantCard を網羅
- [ ] `/api/webhooks/stripe` (POST) — skip: Stripe からの外部 POST 受信のため E2E から起動できない (PR-S4)。**Stripe signature 検証が唯一の認可** (Cookie 認証を通さず PUBLIC_PATHS 経由)。単体テストで 503/400/200/500 + 冪等性 + retryCount + 全 event type ハンドラを網羅

---

## ★テナント分離 / 提案エンジン (severity-1 リグレッション防止) — PR feat/tenant-isolation-comprehensive-tests で追加 (2026-05-10)

**本セクションのテストは将来も絶対に通り続けることが前提**。1 件でも fail した場合は
個人情報漏洩リスクに直結するため、緊急対応必須。

### テナント越境遮断 (e2e/specs/11-tenant-isolation.spec.ts)
全 business entity API (project / task / risk / knowledge / retrospective / memo / customer
/ comment / attachment / stakeholder / estimate / member) について、テナント A の admin が
テナント B の各 ID を直接 URL/API で叩いた際に **GET → 404 / PATCH/POST/DELETE → 403 or 404**
が返ることを網羅検証。

- [x] **38 ケース** (entity × verb 組合せ + admin API 4 本 + sync-import) — PR feat/tenant-isolation-comprehensive-tests
  - 業務 entity (project/task/risk/knowledge/retrospective/memo/customer/comment/attachment/stakeholder/estimate)
  - admin API (`/api/admin/users` `/api/admin/audit-logs` `/api/admin/role-change-logs`)
  - sync-import の越境 import 試行
- [x] chromium project でのみ実行 (mobile viewport で重複実行しない、playwright.config.ts で `testIgnore`)

### 提案機能シードデータ参照 + テナント独立トグル (e2e/specs/12-suggestion-seed-data.spec.ts)
seedDataEnabled トグルが正しく動作し、他顧客テナントのデータが**toggle 値に関わらず混入しない**
ことを保証する。

- [x] **5 ケース** — PR feat/tenant-isolation-comprehensive-tests
  - seedDataEnabled=true で管理テナントのシードが提案候補に含まれる
  - seedDataEnabled=false で管理テナントのシードが消える
  - **どちらの場合もテナント B の data は混入しない**
  - adoptPastIssueAsTemplate でシード採用時、自テナントに新規 create + シード自体は不変
  - テナント B の toggle 変更がテナント A の挙動に影響しない (テナント独立性)

### Service 層 不変条件テスト (src/services/__tests__/tenant-isolation-invariants.test.ts)
全 service ファイルが tenant フィルタ (`viewerTenantId` / `tenantId` / `project: { tenantId }`)
を含むことを **静的解析** で確認。新規 service 追加時に tenant フィルタを忘れると即時 fail する。

- [x] 全 src/services/*.ts (許可リスト 25 件除く) で tenant フィルタ存在
- [x] suggestion.service.ts の MANAGEMENT_TENANT_ID 参照と tenantScopeFilter 構造の検証
- [x] MANAGEMENT_TENANT_ID 定数値が seed migration と一致

### 関連
- 仕様: docs/security/TENANT_ISOLATION_PHASE2_TODO.md (Phase 2-10 完了状態)
- 元 PR シリーズ: #297-#308 (Phase 1〜2-10 + UI 文言修正)

---

## 視覚回帰対象画面

ベースライン PNG は `e2e/**__screenshots__/` に commit される。
PR 中に baseline 更新したい場合は `pnpm test:e2e:update-snapshots` → git commit の通常フロー。

- [x] `/login` — e2e/visual/auth-screens.spec.ts (PR #96 有効化)
- [x] `/reset-password` — e2e/visual/auth-screens.spec.ts (同上)
- [x] `/projects` — e2e/visual/dashboard-screens.spec.ts (PR #96 有効化)
- [x] `/projects/[projectId]` 概要タブ — e2e/visual/dashboard-screens.spec.ts (PR #96)
- [x] `/settings` — e2e/visual/dashboard-screens.spec.ts (light 単体) + e2e/visual/settings-themes.spec.ts (10 テーマ マトリクス、PR #96)
- [ ] `/projects/[projectId]/tasks` WBS — 後続 PR (表形式なので差分検出の priority 低)
- [ ] `/projects/[projectId]/gantt` — 後続 PR (日付依存で決定性維持が難しい)

> **視覚回帰 baseline の生成**: `.github/workflows/e2e-visual-baseline.yml` の
> workflow_dispatch を GitHub Actions UI から対象ブランチで手動実行すると、
> Linux CI 環境で baseline PNG が生成され、自動 commit される。
> 詳細は [docs/DEVELOPER_GUIDE.md §9](./DEVELOPER_GUIDE.md) 参照。

---

## 運用ルール

1. 新機能追加時 (`src/app/(dashboard)/**/page.tsx` や `src/app/api/**/route.ts` を追加):
   - このファイルの該当セクションに行を追加
   - `[ ]` で記載し、後続 PR でカバーする旨の `skip: <理由>` を明記
   - 同一 PR 内で E2E カバーする場合は `[x]` + spec パスを記載

2. CI の `pnpm e2e:coverage-check` が以下を検出したら fail:
   - `src/app/api/**/route.ts` で新規追加されたが本ファイルに未記載の route
   - `src/app/(dashboard)/**/page.tsx` で新規追加されたが本ファイルに未記載の page

3. `skip:` 行は一時的な未実装を許容するが、CI 上は警告表示 (fail にはしない、段階的実装を許容)
