# API 設計 — 全 route 網羅リファレンス (Program Design)

本ドキュメントは **実装 (`src/app/api/**/route.ts`) の完全ミラー** であり、開発者がこの 1 ファイルで全 API を把握できることを目的とする。route の実在とメソッドは全て一次ソース (route handler の `export` 宣言) で確認済 (2026-05-31 時点 / 全 **143 route**)。

データモデルは [DATA_MODEL.md](./DATA_MODEL.md)、認可・セキュリティ設計の根拠は [SECURITY.md](./SECURITY.md)、cron スケジュール詳細は [CRON_JOBS.md](./CRON_JOBS.md) を参照。

> **注記**: 旧版に記載されていたが **実装が存在しない** route は本版で削除した。詳細は末尾「§7.6 旧版からの是正」を参照。

---

## §7. API 設計

### 7.1 設計方針 (実装準拠)

- Next.js App Router の **Route Handlers** (`route.ts`) で実装。ファイルパス = URL パス。
- レスポンスは JSON。成功は `{ data, meta? }`、エラーは `{ error: { code, message?, details? } }`。
- **認証**: NextAuth v5 (Auth.js)、**JWT セッション戦略** (`auth.config.ts` `strategy:'jwt'`)。API route は共通ヘルパ `getAuthenticatedUser()` (`src/lib/api-helpers.ts`) で `auth()` 検証 + `tokenVersion` DB 照合による失効ガードを行う。未認証は `401 { error: { code: 'UNAUTHORIZED' } }`、失効は `401 SESSION_INVALIDATED`。
- **認可ヘルパ** (全て `src/lib/api-helpers.ts`):
  - `getAuthenticatedUser()` — 認証必須。戻り値が `NextResponse` なら未認証として即 return。
  - `requireAdmin(user)` — `isAdminOrAbove` (admin または super_admin) を許可、それ以外 403。
  - `requireSameTenantUser(user, targetUserId)` — テナント越境防止 (super_admin は bypass)。
  - `checkProjectPermission(user, projectId, action, ownerId?)` — メンバーシップ + ロール×状態の統合チェック。非メンバーは 404、権限不足は 403。
  - `requireActualProjectMember(user, projectId)` — admin 短絡を行わず実 ProjectMember row を要求。
  - `requireStorageQuotaForWrite(tenantId, bytes)` — write 入口の pre-check。**1 操作ペイロードが 5MB (`DB_WRITE_PAYLOAD_MAX_BYTES`) を超えると 413 `PAYLOAD_TOO_LARGE`、Beginner 無料枠 (DB 50MB) 超過で 403 `BEGINNER_DB_QUOTA_EXCEEDED`**。累積 50GB ハードキャップ判定は撤廃 (ADR-0030 / 2026-05-31、青天井従量化)。
  - super_admin 専用 route は `isSuperAdmin(user)` (`src/lib/permissions/role.ts`) で判定。
- **cron 認可**: `checkCronAuthorization(req)` / `isCronAuthorized(req)` (`src/lib/cron-auth.ts`)。`Authorization: Bearer <CRON_SECRET>` を `timingSafeEqual` で定数時間比較 (CRON_SECRET 最小 32 文字)。全 cron route の **GET は 405 METHOD_NOT_ALLOWED** を返し、実処理は POST のみ。
- **webhook 認可**: `/api/webhooks/stripe` は Stripe signature 検証 (`constructEvent`) が唯一の認可。生 body (`req.text()`) を使用。
- **バリデーション**: Zod スキーマ。失敗時は `400 { error: { code: 'VALIDATION_ERROR', details: <ZodIssue[]> } }`。
- **ページネーション**: `?page=&limit=` (デフォルト page=1 / limit=20、最大 100)。ただし下記「横断一覧」は **全件返却でページング無し**。

### 7.2 全エンドポイント一覧 (ドメイン別 / 143 route)

凡例 — 認可列: 「認証」=ログイン必須 / 「admin」=admin・super_admin / 「super_admin」=super_admin のみ / 「PM」=`checkProjectPermission` / 「member」=実 ProjectMember / 「cron」=Bearer CRON_SECRET / 「token」=メール等のトークン / 「不要」=未認証可。

#### 認証 (auth) — 17 route

| パス | メソッド | 認可 | 概要 |
|---|---|---|---|
| /api/auth/[...nextauth] | GET, POST | NextAuth | NextAuth.js ハンドラ (signin/signout/session/callback)。`export const { GET, POST } = handlers` |
| /api/auth/signup | POST | 不要 | テナント新規サインアップ (テナント + 初期 admin 作成 + メール検証トークン発行) |
| /api/auth/verify-email | GET | token | メール検証トークン照合 |
| /api/auth/resend-verification | POST | 不要 | 検証メール再送 |
| /api/auth/check-tenant-eligibility | POST | 不要 | サインアップ前のテナント slug 等の利用可否判定 |
| /api/auth/setup-password | GET, POST | token | 初回パスワード設定 (GET=トークン検証 / POST=設定。admin は MFA シークレットも生成) |
| /api/auth/setup-mfa-initial | POST | token | admin 初期セットアップの MFA 最終登録 |
| /api/auth/change-password | POST | 認証 | ログイン済ユーザのパスワード変更 |
| /api/auth/reset-password | POST | 不要/token | パスワードリセット (トークン経由) |
| /api/auth/delete-account | POST | 認証 | 本人アカウント削除 |
| /api/auth/lock-status | POST | 不要 | アカウントロック状態参照 (enumeration 防止済) |
| /api/auth/current-tenant-info | GET | 認証 | 自テナントの { slug, name } のみ返却 (組織履歴記録用の軽量 endpoint) |
| /api/auth/explicit-signout | POST | 認証 | tokenVersion increment による明示的サインアウト (Netlify Set-Cookie 脱落対策) |
| /api/auth/mfa/setup | POST | 認証 | MFA シークレット生成 (任意有効化) |
| /api/auth/mfa/enable | POST | 認証 | MFA 有効化 (TOTP 検証) |
| /api/auth/mfa/disable | POST | 認証 | MFA 無効化 (admin は 403) |
| /api/auth/mfa/verify | POST | MFA pending | ログイン中の TOTP 検証 |

#### プロジェクト (projects) — 6 route

| パス | メソッド | 認可 | 概要 |
|---|---|---|---|
| /api/projects | GET | 認証 | プロジェクト一覧 (keyword/customerName/status フィルタ + ページング)。`meta: { total, page, limit }` |
| /api/projects | POST | admin | 新規作成 (作成者を PM/TL に自動登録) |
| /api/projects/[projectId] | GET | PM | 詳細取得 |
| /api/projects/[projectId] | PATCH | PM | 更新 |
| /api/projects/[projectId] | DELETE | PM | 論理削除 (`?cascade=true` で関連リスク/振り返り/ナレッジを物理削除) |
| /api/projects/[projectId]/status | PATCH | PM | 状態変更 (7 状態遷移) |

#### プロジェクトメンバー / 候補 — 4 route

| パス | メソッド | 認可 | 概要 |
|---|---|---|---|
| /api/projects/[projectId]/members | GET | PM | メンバー一覧 |
| /api/projects/[projectId]/members | POST | PM | メンバー追加 (PM/TL ロール付与は service 層で admin only) |
| /api/projects/[projectId]/members/[memberId] | PATCH | PM | ロール変更 (自己ロール変更は CANNOT_CHANGE_OWN_PROJECT_ROLE) |
| /api/projects/[projectId]/members/[memberId] | DELETE | PM | メンバー解除 |
| /api/projects/[projectId]/available-users | GET | PM | 追加候補ユーザ一覧 (同テナント isActive 未参加者、機微情報除外) |

#### タスク / WBS (tasks) — 12 route

| パス | メソッド | 認可 | 概要 |
|---|---|---|---|
| /api/projects/[projectId]/tasks | GET | PM | タスク一覧 (ツリー) |
| /api/projects/[projectId]/tasks | POST | PM | 新規作成 |
| /api/projects/[projectId]/tasks/[taskId] | GET | PM | 詳細取得 |
| /api/projects/[projectId]/tasks/[taskId] | PATCH | PM | 更新 |
| /api/projects/[projectId]/tasks/[taskId] | DELETE | PM | 論理削除 |
| /api/projects/[projectId]/tasks/[taskId]/progress | GET | PM | 進捗履歴取得 |
| /api/projects/[projectId]/tasks/[taskId]/progress | POST | PM/担当 | 進捗更新 |
| /api/projects/[projectId]/tasks/bulk-update | PATCH | PM/担当 | 一括更新 (計画系=PM、実績系=担当 member も可) |
| /api/projects/[projectId]/tasks/bulk-duplicate | POST | PM | WBS 一括複製 (階層保持、上限 100 件) |
| /api/projects/[projectId]/tasks/tree | GET | PM | ツリー構造取得 |
| /api/projects/[projectId]/tasks/export | POST | PM | WBS CSV エクスポート (`mode='sync'` で ID + 進捗列込み) |
| /api/projects/[projectId]/tasks/sync-import | POST | PM | WBS 上書きインポート (Sync by ID、`?dryRun=1` でプレビュー、OCC 並行編集検出) |
| /api/projects/[projectId]/tasks/recalculate | POST | PM | 全 WP 集計再計算 (修復ツール) |
| /api/projects/[projectId]/tasks/workload | GET | PM | 工数負荷集計 |
| /api/projects/[projectId]/tasks/workload/preview | GET | PM | 工数負荷プレビュー |

#### ガント / マイタスク — 2 route

| パス | メソッド | 認可 | 概要 |
|---|---|---|---|
| /api/projects/[projectId]/gantt | GET | PM | ガント用データ取得 |
| /api/my-tasks | GET | 認証 | 自分の担当タスク一覧 |

#### リスク・課題 (risks) — 8 route

| パス | メソッド | 認可 | 概要 |
|---|---|---|---|
| /api/projects/[projectId]/risks | GET | PM | プロジェクト内リスク/課題一覧 |
| /api/projects/[projectId]/risks | POST | PM/member | 新規起票 |
| /api/projects/[projectId]/risks/[riskId] | GET | PM | 詳細取得 |
| /api/projects/[projectId]/risks/[riskId] | PATCH | PM/担当 | 更新 |
| /api/projects/[projectId]/risks/[riskId] | DELETE | PM/作成者 | 論理削除 (`context:'project'`、作成者本人のみ) |
| /api/projects/[projectId]/risks/[riskId]/link | POST | PM | 別プロジェクトへの紐付け追加 (M2M) |
| /api/projects/[projectId]/risks/[riskId]/link | DELETE | PM | 紐付け解除 |
| /api/projects/[projectId]/risks/bulk | PATCH | PM | 一括更新 |
| /api/projects/[projectId]/risks/export | POST | PM | CSV エクスポート |
| /api/projects/[projectId]/risks/sync-import | POST | PM | CSV 上書きインポート |
| /api/risks | GET | 認証 | **全プロジェクト横断一覧 (ページング無し / 全件)**。非メンバーは機微項目マスク |
| /api/risks/[riskId] | DELETE | admin | 横断画面からの admin 削除専用 (`context:'global'`) |

#### ナレッジ (knowledge) — 8 route

| パス | メソッド | 認可 | 概要 |
|---|---|---|---|
| /api/knowledge | GET | 認証 | 横断ナレッジ一覧 (公開範囲制御あり) |
| /api/knowledge | POST | 認証/member | 新規作成 (プロジェクト紐付けなし) |
| /api/knowledge/[knowledgeId] | GET | 認証 | 詳細取得 (公開範囲に応じる) |
| /api/knowledge/[knowledgeId] | DELETE | admin | 横断画面からの admin 削除専用 (`context:'global'`) |
| /api/projects/[projectId]/knowledge | GET | member | プロジェクト紐付けナレッジ一覧 |
| /api/projects/[projectId]/knowledge | POST | member | 作成 (当該 projectId を自動紐付け) |
| /api/projects/[projectId]/knowledge/[knowledgeId] | PATCH | member | プロジェクト scoped 更新 (creator-only) |
| /api/projects/[projectId]/knowledge/[knowledgeId] | DELETE | member | プロジェクト scoped 論理削除 |
| /api/projects/[projectId]/knowledge/bulk | PATCH | PM | 一括更新 |
| /api/projects/[projectId]/knowledge/export | POST | PM | CSV エクスポート |
| /api/projects/[projectId]/knowledge/sync-import | POST | PM | CSV 上書きインポート |

#### 振り返り (retrospectives) — 8 route

| パス | メソッド | 認可 | 概要 |
|---|---|---|---|
| /api/projects/[projectId]/retrospectives | GET | PM | プロジェクト内振り返り一覧 |
| /api/projects/[projectId]/retrospectives | POST | PM | 新規作成 |
| /api/projects/[projectId]/retrospectives/[retroId] | PATCH | member | 更新 (行クリック編集ダイアログ経由) |
| /api/projects/[projectId]/retrospectives/[retroId] | DELETE | PM/作成者 | 論理削除 (`context:'project'`、作成者本人のみ) |
| /api/projects/[projectId]/retrospectives/[retroId]/link | POST | PM | 別プロジェクトへの紐付け追加 (M2M) |
| /api/projects/[projectId]/retrospectives/[retroId]/link | DELETE | PM | 紐付け解除 |
| /api/projects/[projectId]/retrospectives/bulk | PATCH | PM | 一括更新 |
| /api/projects/[projectId]/retrospectives/export | POST | PM | CSV エクスポート |
| /api/projects/[projectId]/retrospectives/sync-import | POST | PM | CSV 上書きインポート |
| /api/retrospectives | GET | 認証 | **全プロジェクト横断一覧 (ページング無し / 全件)**。非メンバーは機微項目マスク |
| /api/retrospectives/[retroId] | DELETE | admin | 横断画面からの admin 削除専用 (`context:'global'`) |

#### ステークホルダー (stakeholders) — 5 route

| パス | メソッド | 認可 | 概要 |
|---|---|---|---|
| /api/projects/[projectId]/stakeholders | GET | PM | ステークホルダー一覧 |
| /api/projects/[projectId]/stakeholders | POST | PM | 新規追加 |
| /api/projects/[projectId]/stakeholders/[stakeholderId] | GET | PM | 詳細取得 |
| /api/projects/[projectId]/stakeholders/[stakeholderId] | PATCH | PM | 更新 |
| /api/projects/[projectId]/stakeholders/[stakeholderId] | DELETE | PM | 削除 |

#### 見積もり (estimates) — 5 route

| パス | メソッド | 認可 | 概要 |
|---|---|---|---|
| /api/projects/[projectId]/estimates | GET | PM | 一覧取得 |
| /api/projects/[projectId]/estimates | POST | PM | 新規作成 |
| /api/projects/[projectId]/estimates/[estimateId] | GET | PM | 詳細取得 |
| /api/projects/[projectId]/estimates/[estimateId] | PATCH | PM | 更新 / 確定 (body `action='confirm'` で確定) |
| /api/projects/[projectId]/estimates/[estimateId] | DELETE | PM | 論理削除 |

#### 顧客 (customers) — 4 route

| パス | メソッド | 認可 | 概要 |
|---|---|---|---|
| /api/customers | GET | admin | 顧客一覧 |
| /api/customers | POST | admin | 新規作成 |
| /api/customers/[customerId] | GET | admin | 詳細取得 |
| /api/customers/[customerId] | PATCH | admin | 更新 |
| /api/customers/[customerId] | DELETE | admin | 削除 |

#### コメント / メンション候補 — 3 route

| パス | メソッド | 認可 | 概要 |
|---|---|---|---|
| /api/comments | GET | 認証 | コメント一覧 (entityType/entityId スコープ) |
| /api/comments | POST | 認証 | コメント投稿 (容量 pre-check あり) |
| /api/comments/[id] | PATCH | 認証 | コメント編集 (本人) |
| /api/comments/[id] | DELETE | 認証/admin | 削除 (自分 / 他人 public は admin モデレーション) |
| /api/mention-candidates | GET | 認証 | メンション候補ユーザ一覧 |

#### 通知 (notifications) — 3 route

| パス | メソッド | 認可 | 概要 |
|---|---|---|---|
| /api/notifications | GET | 認証 | 自分宛通知一覧 |
| /api/notifications/[id] | PATCH | 認証 | 既読化 (本人) |
| /api/notifications/mark-all-read | POST | 認証 | 全件既読化 |

#### メモ (memos) — 6 route

| パス | メソッド | 認可 | 概要 |
|---|---|---|---|
| /api/memos | GET | 認証 | メモ一覧 (自分 + public) |
| /api/memos | POST | 認証 | 新規作成 (容量 pre-check あり) |
| /api/memos/[id] | GET | 認証 | 詳細取得 |
| /api/memos/[id] | PATCH | 認証 | 更新 (本人) |
| /api/memos/[id] | DELETE | 認証/admin | 削除 (自分 / 他人 public は admin モデレーション) |
| /api/memos/bulk | PATCH | 認証 | 一括更新 |
| /api/memos/export | POST | 認証 | CSV エクスポート |
| /api/memos/sync-import | POST | 認証 | CSV 上書きインポート |

#### 添付ファイル (attachments) — 6 route

| パス | メソッド | 認可 | 概要 |
|---|---|---|---|
| /api/attachments | GET | 親 entity read | 添付一覧 (`?entityType=&entityId=`) |
| /api/attachments | POST | 親 entity write | URL 参照型添付の追加 |
| /api/attachments/[id] | PATCH | 親 entity write | 添付更新 (displayName / url / mimeHint) |
| /api/attachments/[id] | DELETE | 親 entity write | 論理削除 + Storage cascade + 容量減算 (per-tenant 100/min) |
| /api/attachments/[id]/download | GET | 親 entity read | Pre-signed Download URL 発行 → 302 redirect (TTL 60s) |
| /api/attachments/upload | POST | 親 entity write | Pre-signed Upload URL 発行 (TTL 60s / 50MB / 危険拡張子拒否 / 10req/min) |
| /api/attachments/finalize | POST | 親 entity write | アップロード完了確定 (実サイズ検証 + Beginner 無料枠ガード。累積 50GB ハードキャップは撤廃 ADR-0030、50GB は監視アラート閾値のみ) |
| /api/attachments/batch | GET | 親 entity read | 複数 entity の添付一括取得 |

#### 提案エンジン (suggestions) — 4 route

| パス | メソッド | 認可 | 概要 |
|---|---|---|---|
| /api/projects/[projectId]/suggestions | GET | PM | 提案一覧 (全網羅 + 分位 tier) |
| /api/projects/[projectId]/suggestions/adopt | POST | PM | 提案採用 |
| /api/projects/[projectId]/suggestions/related-issues | **POST** | PM | 関連 risk/issue 取得 (※旧版 GET は誤り) |
| /api/projects/[projectId]/suggestions/explain | **POST** | PM | 採用根拠 (explainability) 生成 (※旧版 GET は誤り) |

#### チャット意味検索 / AI ヘルプ — 2 route

| パス | メソッド | 認可 | 概要 |
|---|---|---|---|
| /api/chat/search | POST | 認証 | 5 資産横断の意味検索 (embedding cosine + keyword filter)。§16 参照 |
| /api/help/chat | POST | 認証 | たすきフクロウ AI ヘルプチャット (FaqEmbedding/GuideEmbedding RAG、ADR-0028)。viewer の systemRole から isTenantAdmin 判定 |

#### テナント (自己, tenants/me) — 11 route

| パス | メソッド | 認可 | 概要 |
|---|---|---|---|
| /api/tenants/me | GET | 認証 | 自テナント情報取得 |
| /api/tenants/me | PATCH | admin | 自テナント更新 |
| /api/tenants/me | DELETE | admin | 自テナント削除 |
| /api/tenants/me/i18n | PATCH | 認証 | locale/timezone 設定 |
| /api/tenants/me/export | GET | 認証 | テナントデータ一括エクスポート |
| /api/tenants/me/import | POST | admin | テナントデータインポート |
| /api/tenants/me/self-delete | POST | admin | 自テナント自己削除 (退会フロー) |
| /api/tenants/me/recalculate | POST | admin | 利用量/容量の再集計 |
| /api/tenants/me/repair-api-usage | POST | admin | ApiCallLog ↔ counter drift 修復 |
| /api/tenants/me/external-import/template | GET | admin | 外部インポート用テンプレート取得 |
| /api/tenants/me/external-import/preview | POST | admin | 外部インポートのプレビュー (precheck) |
| /api/tenants/me/external-import/apply | POST | admin | 外部インポート適用 (withStorageGuard) |

#### テナント課金 (Stripe, tenants/me/billing) — 7 route

| パス | メソッド | 認可 | 概要 |
|---|---|---|---|
| /api/tenants/me/billing | PATCH | admin | 課金設定更新 (プラン / 月次予算上限等) |
| /api/tenants/me/billing/stripe/setup | POST | admin | Stripe Checkout/SetupIntent 開始 |
| /api/tenants/me/billing/stripe/setup/complete | GET | admin | Setup 完了コールバック |
| /api/tenants/me/billing/stripe/setup-with-existing-card | POST | admin | 既存カードで Subscription 設定 |
| /api/tenants/me/billing/stripe/portal | POST | admin | Stripe Customer Portal セッション発行 |
| /api/tenants/me/billing/stripe/verify | POST | admin | カード/支払い状態の検証 |

#### システム管理 (admin) — 9 route

| パス | メソッド | 認可 | 概要 |
|---|---|---|---|
| /api/admin/users | GET | admin | ユーザ一覧 |
| /api/admin/users | POST | admin | ユーザ登録 |
| /api/admin/users/[userId] | PATCH | admin | ユーザ更新 (ロール/有効無効含む。自己ロール変更は CANNOT_CHANGE_OWN_ROLE) |
| /api/admin/users/[userId] | DELETE | admin | ユーザ削除 (論理削除 + ProjectMember 物理カスケード) |
| /api/admin/users/[userId]/unlock | POST | admin | ロック解除 |
| /api/admin/users/[userId]/recovery-codes | POST | admin | リカバリコード再発行 |
| /api/admin/users/lock-inactive | POST | admin/cron | 非アクティブユーザ一括ロック (日次 cron + 手動) |
| /api/admin/audit-logs | GET | admin | 監査ログ一覧 |
| /api/admin/role-change-logs | GET | admin | 権限変更履歴 |
| /api/admin/usage-summary | GET | admin | 利用量サマリ |

#### super-admin (admin/super) — 17 route

| パス | メソッド | 認可 | 概要 |
|---|---|---|---|
| /api/admin/super/tenants | POST | super_admin | テナント手動払い出し |
| /api/admin/super/tenants/[id] | DELETE | super_admin | テナント削除 |
| /api/admin/super/tenants/[id]/export | GET | super_admin | テナントデータエクスポート |
| /api/admin/super/tenants/[id]/suspend | POST | super_admin | テナント停止 |
| /api/admin/super/tenants/[id]/resume | POST | super_admin | テナント再開 |
| /api/admin/super/tenants/[id]/recalculate | POST | super_admin | 単一テナント再集計 |
| /api/admin/super/tenants/[id]/repair-api-usage | POST | super_admin | API 利用量 drift 修復 |
| /api/admin/super/tenants/[id]/regenerate-monthly-history | POST | super_admin | 月次履歴再生成 |
| /api/admin/super/tenants/[id]/storage-guard-reset | POST | super_admin | ストレージガードのリセット |
| /api/admin/super/recalculate-all | POST | super_admin | 全テナント横断再集計 |
| /api/admin/super/cron-history | GET | super_admin | cron 実行履歴 |
| /api/admin/super/usage/export | GET | super_admin | 月次利用量 CSV エクスポート |
| /api/admin/super/billing/export/[yearMonth] | GET | super_admin | 月次請求 CSV エクスポート |
| /api/admin/super/billing/[id]/confirm-payment | POST | super_admin | 入金確認 (請求ステータス更新) |
| /api/admin/super/stripe-dlq/webhook/[id]/retry | POST | super_admin | Stripe webhook DLQ 手動再送 |
| /api/admin/super/stripe-dlq/usage/[id]/retry | POST | super_admin | Stripe usage record DLQ 手動再送 |

#### cron (定期処理) — 11 route

全 route 共通: 実処理は **POST + Bearer CRON_SECRET**、**GET は 405 METHOD_NOT_ALLOWED**。

| パス | メソッド | 認可 | 概要 |
|---|---|---|---|
| /api/cron/daily-notifications | POST / GET(405) | cron | 日次通知 + DB 容量集計 + ファイルストレージ集計 + drift/anomaly 検知 |
| /api/cron/daily-usage-aggregation | POST / GET(405) | cron | 日次利用量集計 |
| /api/cron/tenant-monthly-reset | POST / GET(405) | cron | 月初リセット + plan 適用 + 容量超過請求 + snapshot + 90 日経過テナント物理削除 |
| /api/cron/billing-monthly-aggregation | POST / GET(405) | cron | 月次請求集計 |
| /api/cron/billing-overdue-alert | POST / GET(405) | cron | 支払遅延アラート |
| /api/cron/cron-failure-alert | POST / GET(405) | cron | cron 失敗 / 記録欠落の watchdog アラート |
| /api/cron/diagnostics-daily-alert | POST / GET(405) | cron | 日次診断アラート |
| /api/cron/attachment-embedding | POST / GET(405) | cron | 添付本文 embedding 背景処理 (指数 backoff + 3 retry + throttle、ADR-0026) |
| /api/cron/stripe-usage-flush | POST / GET(405) | cron | StripeUsageRecordQueue 送信 (Haiku/Sonnet/Embedding/DBCap/Storage) |
| /api/cron/stripe-reconcile | POST / GET(405) | cron | Stripe 使用量の整合リコンサイル |
| /api/cron/stripe-auto-suspend | POST / GET(405) | cron | 支払滞納テナントの自動停止 |

#### webhook / health / 設定 — 3 route

| パス | メソッド | 認可 | 概要 |
|---|---|---|---|
| /api/webhooks/stripe | POST | Stripe signature | Stripe webhook 受信 (生 body + 署名検証) |
| /api/health | GET | 不要 | ヘルスチェック |
| /api/settings/theme | PATCH | 認証 | テーマ設定 (専用 cookie 方式) |
| /api/client-errors | POST | 認証(任意) | クライアントエラー収集 (認証済なら userId 記録) |

### 7.3 ドメイン別 route 件数

「件数」は **URL パス (= `route.ts` ファイル) 単位**。各ドメイン表は path × method 行で展開しているため、表の行数は下記件数を上回る。

| ドメイン | route 数 |
|---|---|
| 認証 (auth) | 17 |
| プロジェクト (一覧/詳細/status) | 3 |
| メンバー / 候補 | 3 |
| タスク / WBS | 11 |
| ガント / マイタスク | 2 |
| リスク・課題 | 8 |
| ナレッジ | 7 |
| 振り返り | 8 |
| ステークホルダー | 2 |
| 見積もり | 2 |
| 顧客 | 2 |
| コメント / メンション候補 | 3 |
| 通知 | 3 |
| メモ | 5 |
| 添付ファイル | 6 |
| 提案エンジン | 4 |
| チャット検索 / AI ヘルプ | 2 |
| テナント (自己, billing 除く) | 10 |
| テナント課金 (Stripe) | 6 |
| システム管理 (admin, super 除く) | 8 |
| super-admin | 16 |
| cron | 11 |
| webhook / health / 設定 / client-errors | 4 |
| **合計** | **143** |

### 7.4 レスポンス共通形式 (実装準拠)

```jsonc
// 成功 (一覧)
{
  "data": [ /* ... */ ],
  "meta": { "total": 100, "page": 1, "limit": 20 }   // ← totalPages は無い
}

// 成功 (単一)
{ "data": { /* ... */ } }

// 横断一覧 (/api/risks, /api/retrospectives) — meta 無し / 全件
{ "data": [ /* 全件 */ ] }

// エラー (Zod バリデーション)
{
  "error": {
    "code": "VALIDATION_ERROR",
    "details": [ /* ZodIssue[] : { code, path, message, ... } */ ]
  }
}

// エラー (一般)
{ "error": { "code": "FORBIDDEN", "message": "..." } }
```

> **重要 (旧版との差異)**:
> - `meta.totalPages` は **実装に存在しない** (旧版の記載は誤り)。クライアントは `Math.ceil(total/limit)` で算出。
> - バリデーションエラーの `details` は **Zod の `error.issues` 配列 (`ZodIssue[]`)** であり、旧版の `[{ field, message }]` 形式ではない。

### 7.5 エラーコード一覧

| コード | HTTP | 説明 |
|---|---|---|
| VALIDATION_ERROR | 400 | 入力バリデーション失敗 (`details` = ZodIssue[]) |
| **UNAUTHENTICATED / UNAUTHORIZED** | **401** | 未認証 (`getAuthenticatedUser` は `UNAUTHORIZED`、cron は `UNAUTHORIZED`) |
| SESSION_INVALIDATED | 401 | tokenVersion 不一致 / 無効化 / 削除済 (JWT 失効) |
| FORBIDDEN | 403 | 権限不足 |
| BEGINNER_DB_QUOTA_EXCEEDED | 403 | Beginner プラン DB 無料枠 (50MB) 超過 (write 拒否、overage 課金なし) |
| BEGINNER_STORAGE_QUOTA_EXCEEDED | 403 | Beginner プラン File Storage 無料枠 (100MB) 超過 (upload 拒否、overage 課金なし) |
| PAYLOAD_TOO_LARGE | 413 | 1 操作の DB ペイロードが上限 (`DB_WRITE_PAYLOAD_MAX_BYTES` = 5MB) 超過 (`requireStorageQuotaForWrite`) |
| NOT_FOUND | 404 | リソース不在 (テナント越境も 404 でマスク) |
| **METHOD_NOT_ALLOWED** | **405** | 未対応メソッド (例: cron route への GET アクセス) |
| STATE_CONFLICT | 409 | 状態遷移条件を満たさない |
| IMPORT_CONCURRENT_EDIT | 409 | sync-import の OCC 並行編集検出 (`x-import-snapshot-at` 不一致) |
| TASK_NAME_DUPLICATE_IN_PARENT | 400 | 同一親 WP 配下に同名タスク既存 (部分 UNIQUE 制約の app 層ガード) |
| IMPORT_VALIDATION_ERROR / IMPORT_REMOVE_BLOCKED | 400 | sync-import 本実行での blocker 再検出 / 進捗ありタスク削除要求 |
| TASKS_OUT_OF_RANGE / TASKS_NOT_FOUND / TARGET_PARENT_NOT_FOUND / TARGET_PARENT_NOT_WP / ACT_CANNOT_BE_ROOT | 400/404 | bulk-duplicate のガード群 |
| DANGEROUS_FILE_TYPE / INVALID_OBJECT_KEY | 400 | 添付: 危険拡張子 / objectKey の越境 prefix |
| FILE_TOO_LARGE | 413 | 添付: 50MB 超過 |
| OBJECT_NOT_FOUND | 404 | 添付: finalize 時に Storage 上のオブジェクト不在 |
| STORAGE_UNAVAILABLE / UPLOAD_URL_FAILED / DOWNLOAD_URL_FAILED | 503 | 添付: Supabase Storage 不通 / URL 発行失敗 |
| TOO_MANY_REQUESTS | 429 | レート制限超過 (upload 10/min / delete 100/min) |
| INTERNAL_ERROR | 500 | サーバ内部エラー |

### 7.6 旧版からの是正 (実在しない route の削除)

旧 API_DESIGN.md に記載されていたが **route handler が実在しない** ため削除した:

- `PATCH /api/knowledge/:id/publish` — 実在しない (公開操作はナレッジ作成時の visibility で表現)。
- `PATCH /api/projects/:id/estimates/:estimateId/confirm` — **独立 route は無い**。確定は `PATCH /api/projects/:id/estimates/:estimateId` の body `action='confirm'`。
- `PATCH /api/admin/users/:userId/role`, `PATCH /api/admin/users/:userId/status` — **独立 route は無い**。`PATCH /api/admin/users/:userId` に統合。
- `PATCH /api/projects/:id/retrospectives/:retroId/confirm`, `POST /api/projects/:id/retrospectives/:retroId/comments` — 実在しない。
- `POST /api/projects/:id/tasks/import` (非 sync) — 実在しない。インポートは `sync-import` に一本化。
- `POST /api/auth/signin` / `POST /api/auth/signout` / `GET /api/auth/session` — NextAuth の `[...nextauth]` ハンドラに集約 (個別 route ではない)。

---

## §16. 検索設計 (現行 / embedding + pg_trgm)

旧版の「pg_trgm 未実装」は **誤り**。実 DB (Supabase introspection 2026-05-31) で pg_trgm GIN index は実在する。検索は 2 系統に分かれる。

### 16.1 キーワード検索 (pg_trgm GIN index — 実在)

`vector 0.8.0` (pgvector) / `pg_trgm 1.6` 拡張が有効。以下 3 テーブルに `gin_trgm_ops` GIN index が **実在**する。

| テーブル | trgm index 対象カラム |
|---|---|
| knowledges | title, content |
| risks_issues | title, content |
| retrospectives | problems, improvements |

- 用途: 一覧画面のキーワードフィルタ (`?keyword=`)。部分一致 / 表記揺れに強い 3-gram マッチ。
- projects はキーワード検索を `customers.name` との JOIN + relation filter で行う (専用 trgm index は無し)。

### 16.2 意味検索 (embedding cosine — `/api/chat/search`)

`chat-search.service` が **5 資産** (knowledge / risk・issue / retrospective / memo / attachment) の `content_embedding` (vector(1024)、Voyage embedding) に対し **cosine 類似** で意味検索する。

- **重要 (性能注記)**: **pgvector の vector index は未作成** (Supabase introspection で 0 件) → 類似検索は **ブルートフォース全走査**。現規模では許容範囲だが、データ増加時は IVFFlat / HNSW index 追加を検討。
- keyword filter との **併用**: クエリ条件で対象資産種別・テナント (`where.tenantId`) を絞り込んだうえで embedding 距離順に並べる。
- `visibility='draft'` のエンティティは embedding を生成しないため意味検索の対象外。
- 課金: 検索クエリの embedding 生成は `withMeteredLLM` で 1 業務操作 = 1 ApiCallLog に集約 (EMBEDDING 課金分類)。

### 16.3 AI ヘルプ RAG (`/api/help/chat`)

たすきフクロウ AI ヘルプチャット (ADR-0028)。`FaqEmbedding` / `GuideEmbedding` テーブル (いずれも `content_embedding` NOT NULL) に対する RAG。

- FAQ / ガイド本文を embedding 化し、ユーザ質問の embedding と cosine 類似で関連チャンクを取得 → LLM (Haiku) に full-context で渡して回答生成。
- こちらも vector index 無し (ブルートフォース)。FAQ 件数が 100K tokens 規模に達するまでは現方式で許容 (方針メモ準拠)。

### 16.4 検索クエリ制約

| 項目 | 値 |
|---|---|
| キーワード最小文字数 | 2 文字 (pg_trgm は 3-gram のため 1 文字は精度低) |
| キーワード最大文字数 | 200 文字 (DB 負荷抑制) |
| 結果件数上限 | キーワード一覧はページング、意味検索は service 定数で上限 |

---

## §17. パフォーマンス要件

### 17.1 応答時間目標

| 操作カテゴリ | 目標値 | 備考 |
|---|---|---|
| 一覧画面の初期表示 | 1 秒以内 | 20 件/ページ |
| 詳細画面の表示 | 500ms 以内 | 単一エンティティ + 関連 |
| データの作成・更新 | 500ms 以内 | バリデーション + 保存 |
| キーワード検索 | 2 秒以内 | pg_trgm GIN index |
| 意味検索 (chat/search) | 2 秒以内 | embedding 生成 + cosine 全走査 (現規模) |
| ガントチャート描画 | 2 秒以内 | 100 タスク程度 |
| CSV エクスポート | 5 秒以内 | 最大 1,000 件 |
| ログイン処理 | 1 秒以内 | bcrypt 検証 + JWT 発行 |
| MFA 検証 | 500ms 以内 | TOTP コード検証 |

### 17.2 同時接続数の想定

| 項目 | 想定値 | 根拠 |
|---|---|---|
| 登録ユーザ数 | 100 名以下 | 中小規模組織 |
| 同時アクティブユーザ | 30 名以下 | 登録者の 30% |
| ピーク時リクエスト | 50 req/sec 以下 | 朝の一斉ログイン・進捗更新 |

### 17.3 DB コネクションプール

ランタイムは `@prisma/adapter-pg` (pg Pool 経由)、マイグレーションは `prisma.config.ts` の `DIRECT_URL` (5432 直結)。

| 項目 | 設定値 | 理由 |
|---|---|---|
| pg Pool 接続数 | 5 | 初期 5〜10 名に十分、Supabase Free 負荷軽減 |
| 接続タイムアウト | 5 秒 | プール枯渇時の待機上限 |
| ランタイム接続方式 | pooler (PgBouncer) 経由 | サーバレス Function 向け |
| マイグレーション接続 | DIRECT_URL (5432 直結) | DDL 実行用 |

### 17.4 ページネーション

| 項目 | 仕様 |
|---|---|
| デフォルト件数 | 20 件 |
| 最大件数 | 100 件 |
| 方式 | オフセットベース (`?page=1&limit=20`) |
| meta | `{ total, page, limit }` (totalPages は返さない) |
| 例外 | `/api/risks`, `/api/retrospectives` は全件返却 (ページング無し) |

### 17.5 キャッシュ方針

- サーバサイドキャッシュ (Redis 等) は導入しない。
- 課金根拠データ (DB 容量 / API 利用量) は cron キャッシュ依存を避け、ダッシュボード遷移時に再集計 + 再集計ボタンを併設 (誤請求リスク予防)。
- マスタデータ (定数) はビルド時埋め込み。

### 17.6 パフォーマンス・アンチパターン (コミット前チェックリスト)

1. **同一テーブルへの重複 findMany** — `Promise.all` 内の同エンティティ複数 findMany を 1 回に集約。
2. **表示件数とクエリ limit の乖離** — `take:` / `limit:` を実表示件数と一致させる。
3. **再帰・大量リストの memo 未適用** — 自己再帰コンポーネント / 100 件超リストは `React.memo`、props は参照安定。
4. **O(N×M) の背景 DOM** — グリッドの共通背景は行ループ外のオーバーレイへ。
5. **タブ配下の eager fetch** — 切替表示の UI は lazy fetch を検討。
