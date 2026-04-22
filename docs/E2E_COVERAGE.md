# E2E カバレッジ一覧 (PR #90 以降 継続更新)

> PR #92 で Steps 1-6 (admin セットアップ + 招待 + プロジェクト作成 + メンバー login) を追加。
> PR #93 で Step 7 の前半 (プロジェクト詳細タブ render + ロール別表示差分 + 全横断一覧 4 画面) を追加。WBS/Gantt/Estimates の複雑 UI と各 entity の CRUD 詳細は後続 PR。
> PR #94 で Step 8 (個人機能: /my-tasks / /memos / /all-memos / /settings テーマ変更) を追加。
> PR #95 で Steps 9-12 (ログアウト + 削除 + 残存検証) + ダッシュボード視覚回帰雛形 (baseline 未 commit) を追加。段階導入プラン完了。

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

### ダッシュボード
- [x] `/projects` — e2e/specs/01-admin-and-member-setup.spec.ts (PR #92 / Step 5 作成 + Step 6b 一般ユーザ閲覧)
- [x] `/projects/[projectId]` — e2e/specs/02-project-detail-tabs.spec.ts (PR #93 / Step 7 タブ render + ロール差分)
- [ ] `/projects/[projectId]/estimates` — skip: 詳細 CRUD は後続 PR (タブ表示は PR #93 で render smoke 済)
- [ ] `/projects/[projectId]/tasks` — skip: WBS ツリー CRUD は後続 PR (タブ表示は PR #93 で render smoke 済)
- [ ] `/projects/[projectId]/gantt` — skip: ガント表示の詳細検証は後続 PR (タブ表示は PR #93 で render smoke 済)
- [ ] `/projects/[projectId]/risks` — skip: CRUD 詳細は後続 PR (タブ表示は PR #93 で render smoke 済)
- [ ] `/projects/[projectId]/issues` — skip: CRUD 詳細は後続 PR (タブ表示は PR #93 で render smoke 済)
- [ ] `/projects/[projectId]/retrospectives` — skip: CRUD 詳細は後続 PR (タブ表示は PR #93 で render smoke 済)
- [ ] `/projects/[projectId]/knowledge` — skip: CRUD 詳細は後続 PR (タブ表示は PR #93 で render smoke 済)
- [x] `/risks` (全リスク) — e2e/specs/03-global-entity-lists.spec.ts (PR #93)
- [x] `/issues` (全課題) — e2e/specs/03-global-entity-lists.spec.ts (PR #93)
- [x] `/retrospectives` (全振り返り) — e2e/specs/03-global-entity-lists.spec.ts (PR #93)
- [x] `/knowledge` (全ナレッジ) — e2e/specs/03-global-entity-lists.spec.ts (PR #93)
- [x] `/memos` — e2e/specs/04-personal-features.spec.ts (PR #94 / メモ作成 API + UI 一覧 + UI 削除)
- [x] `/all-memos` — e2e/specs/04-personal-features.spec.ts (PR #94 / 公開メモの一覧表示)
- [x] `/my-tasks` — e2e/specs/04-personal-features.spec.ts (PR #94 / 画面 render)
- [x] `/settings` — e2e/specs/01-admin-and-member-setup.spec.ts (PR #92 / パスワード変更 + MFA 有効化) + e2e/specs/04-personal-features.spec.ts (PR #94 / テーマ変更)

### admin 専用
- [x] `/admin/users` — e2e/specs/01-admin-and-member-setup.spec.ts (PR #92 / Step 3 招待)
- [ ] `/admin/audit-logs` — skip: 監査ログ閲覧、read-only で優先度低
- [ ] `/admin/role-changes` — skip: 権限変更履歴、read-only で優先度低

### その他
- [ ] `/` (ルート) — skip: プロジェクト一覧へのリダイレクト、PR #B の /projects で間接カバー

---

## API Routes

### 認証
- [x] `/api/auth/signin` — e2e/specs/01-admin-and-member-setup.spec.ts (PR #92 / 複数ステップで使用)
- [x] `/api/auth/signout` — e2e/specs/05-teardown-and-residuals.spec.ts (PR #95 / Step 9 UI ログアウト経由)
- [ ] `/api/auth/lock-status` — skip: PR #E (ロック誘発シナリオは非決定的で後回し)
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

### プロジェクト
- [x] `GET /api/projects` — e2e/specs/01-admin-and-member-setup.spec.ts (PR #92 / Step 5 + 6b 画面表示)
- [x] `POST /api/projects` — e2e/specs/01-admin-and-member-setup.spec.ts (PR #92 / Step 5 API 経由)
- [ ] `GET /api/projects/[projectId]` — skip: PR #C
- [ ] `PATCH /api/projects/[projectId]` — skip: PR #C
- [x] `DELETE /api/projects/[projectId]` — e2e/specs/05-teardown-and-residuals.spec.ts (PR #95 / Step 11 削除ダイアログ経由)
- [ ] `PATCH /api/projects/[projectId]/status` — skip: PR #C

### タスク (WBS) / ガント
- [ ] `/api/projects/[projectId]/tasks/*` — skip: PR #C で網羅 (CRUD + bulk + progress + export/import/recalculate/tree 全て包含)
- [ ] `/api/projects/[projectId]/gantt` — skip: PR #C

### リスク / 課題 / 振り返り / ナレッジ / サジェスト / メンバー
- [ ] `/api/projects/[projectId]/risks/*` — skip: PR #C
- [ ] `/api/projects/[projectId]/retrospectives/*` — skip: PR #C
- [ ] `/api/projects/[projectId]/knowledge/*` — skip: PR #C
- [ ] `/api/projects/[projectId]/suggestions/*` — skip: PR #C (提案型サービス、核心機能)
- [x] `/api/projects/[projectId]/members/*` — e2e/specs/01-admin-and-member-setup.spec.ts (PR #92 / Step 6a POST, GET は画面経由)
- [ ] `/api/risks` (全リスク) — skip: PR #C
- [ ] `/api/retrospectives` (全振り返り) — skip: PR #C
- [ ] `/api/knowledge` (全ナレッジ) — skip: PR #C
- [ ] `/api/knowledge/[knowledgeId]` — skip: PR #C

### メモ
- [x] `/api/memos` (GET/POST) — e2e/specs/04-personal-features.spec.ts (PR #94 / POST 作成 + GET は /memos と /all-memos の画面経由)
- [x] `/api/memos/[id]` (PATCH/DELETE) — e2e/specs/04-personal-features.spec.ts (PR #94 / DELETE のみ UI 経由でカバー、PATCH は後続 PR)

### 添付
- [ ] `/api/attachments/*` — skip: 各親エンティティの spec 経由で間接カバー

### 見積
- [ ] `/api/projects/[projectId]/estimates/*` — skip: PR #C

### 管理系
- [x] `/api/admin/users` — e2e/specs/01-admin-and-member-setup.spec.ts (PR #92 / Step 3 POST + Step 6a GET)
- [x] `/api/admin/users/[userId]` — e2e/specs/05-teardown-and-residuals.spec.ts (PR #95 / Step 10 DELETE) ※ PATCH は別 PR
- [ ] `/api/admin/users/[userId]/recovery-codes` — skip: PR #D (リカバリーコード再発行)
- [ ] `/api/admin/users/[userId]/unlock` — skip: ロック誘発が非決定的、手動テスト
- [ ] `/api/admin/users/cleanup-inactive` — skip: 時間経過が必要、手動テスト
- [ ] `/api/admin/audit-logs` — skip: read-only
- [ ] `/api/admin/role-change-logs` — skip: read-only

### その他
- [x] `GET /api/health` — e2e/specs/00-smoke.spec.ts (副次的に起動確認)
- [x] `/api/my-tasks` — e2e/specs/04-personal-features.spec.ts (PR #94 / /my-tasks 画面経由で間接カバー)
- [x] `/api/settings/theme` — e2e/specs/04-personal-features.spec.ts (PR #94 / テーマ変更 UI から PATCH)
- [ ] `/api/cron/cleanup-accounts` — skip: 時間経過が必要、手動テスト

---

## 視覚回帰対象画面

ベースライン PNG は `e2e/**__screenshots__/` に commit される。
PR 中に baseline 更新したい場合は `pnpm test:e2e:update-snapshots` → git commit の通常フロー。

- [x] `/login` — e2e/visual/auth-screens.spec.ts (baseline 未 commit、skipped)
- [x] `/reset-password` — e2e/visual/auth-screens.spec.ts (同上)
- [x] `/projects` — e2e/visual/dashboard-screens.spec.ts (PR #95 雛形、baseline 未 commit で skipped)
- [x] `/settings` — e2e/visual/dashboard-screens.spec.ts (PR #95 雛形、同上)
- [ ] `/projects/[projectId]` 概要タブ — 後続 PR (dashboard-screens 拡張)
- [ ] `/projects/[projectId]/tasks` WBS — 後続 PR
- [ ] `/projects/[projectId]/gantt` — 後続 PR
- [ ] `/settings` 10 テーマ切替 — 後続 PR (10 テーマ × 主要画面のマトリクス化予定)

> **視覚回帰 baseline の有効化手順**: baseline PNG はフォント/アンチエイリアス差異を
> 避けるため Linux CI 環境で生成する必要がある (開発者の Windows / macOS ローカルでは NG)。
> 次担当者向け手順は各 `e2e/visual/*.spec.ts` 冒頭コメントに記載。

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
