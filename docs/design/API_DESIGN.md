# API 設計と全文検索 (Program Design)

本ドキュメントは、API 設計とサービス層、全文検索設計を集約する (DESIGN.md §7、§16)。データモデルは [DATA_MODEL.md](./DATA_MODEL.md)、認可・セキュリティは [SECURITY.md](./SECURITY.md) を参照。

---

## §7. API 設計

## 7. API 設計

### 7.1 設計方針
- RESTful API を基本とする
- Next.js App Router の Route Handlers で実装
- 認証は NextAuth.js のセッション Cookie を使用
- レスポンスは JSON 形式
- ページネーションは `?page=1&limit=20` 形式
- ソートは `?sort=created_at&order=desc` 形式
- バリデーションは Zod スキーマで統一

### 7.2 エンドポイント一覧

#### 認証

| メソッド | パス | 説明 | 認証 |
|---|---|---|---|
| POST | /api/auth/signin | ログイン | 不要 |
| POST | /api/auth/signout | ログアウト | 必要 |
| GET | /api/auth/session | セッション情報取得 | 必要 |
| POST | /api/auth/lock-status | ロック状態参照 (SPECIFICATION.md §13.4.4、enumeration 防止済) | 不要 |
| POST | /api/auth/setup-password | 初回パスワード設定 (admin は MFA シークレットも生成、PR #91) | トークン経由 (不要) |
| POST | /api/auth/setup-mfa-initial | admin 初期セットアップの MFA 最終登録 (PR #91) | トークン経由 (不要) |
| POST | /api/auth/mfa/setup | ログイン済ユーザが追加で MFA シークレット生成 (一般ユーザの任意有効化用) | 必要 |
| POST | /api/auth/mfa/enable | 設定画面経由の MFA 有効化 (TOTP 検証) | 必要 |
| POST | /api/auth/mfa/disable | MFA 無効化 (**admin は 403、PR #91**) | 必要 |
| POST | /api/auth/mfa/verify | ログイン中の TOTP 検証 (MFA pending session) | 部分的 (MFA 未検証セッション) |
| GET | /api/auth/current-tenant-info | **認証済ユーザの自テナント { slug, name } のみ返却** (PR #420)。ログイン成功直後に呼び localStorage の組織 ID 履歴 (LRU 5 件) に記録するための軽量 endpoint。列挙不可 (自テナントのみ)、admin 不要 | 必要 |

#### プロジェクト

| メソッド | パス | 説明 | ロール |
|---|---|---|---|
| GET | /api/projects | 一覧取得 | 全ロール |
| POST | /api/projects | 新規作成 | admin, pm_tl |
| GET | /api/projects/:id | 詳細取得 | プロジェクト参加者 |
| PATCH | /api/projects/:id | 更新 | admin, pm_tl |
| DELETE | /api/projects/:id | 論理削除（?cascade=true で関連リスク/課題・振り返り・ナレッジを物理削除） | admin, pm_tl |
| PATCH | /api/projects/:id/status | 状態変更 | admin, pm_tl |

#### プロジェクトメンバー

| メソッド | パス | 説明 | ロール |
|---|---|---|---|
| GET | /api/projects/:id/members | メンバー一覧 | admin, pm_tl |
| GET | /api/projects/:id/available-users | **メンバー追加候補ユーザ一覧** (PR #416 新規)。同 tenantId の isActive ユーザのうち、未参加者のみ返す。select は `{ id, name, email, isActive }` のみで機微情報除外 | admin, pm_tl |
| POST | /api/projects/:id/members | メンバー追加 | admin, pm_tl (PR #416: `requireAdmin` → `checkProjectPermission('member:manage')`。ただし PM/TL ロール追加は service 層で admin only enforce) |
| PATCH | /api/projects/:id/members/:userId | ロール変更 | admin, pm_tl (PR #416: 同上。PM/TL ↔ それ以外のロール変更は service 層で `FORBIDDEN_PMTL_ROLE`。自己ロール変更は `CANNOT_CHANGE_OWN_PROJECT_ROLE`) |
| DELETE | /api/projects/:id/members/:userId | メンバー解除 | admin, pm_tl (PR #416: 同上。PM/TL ロールの解除は service 層で admin only enforce) |

#### 見積もり

| メソッド | パス | 説明 | ロール |
|---|---|---|---|
| GET | /api/projects/:id/estimates | 一覧取得 | admin, pm_tl (PR #416: `project:read` → `project:update` に変更、member/viewer は閲覧不可) |
| POST | /api/projects/:id/estimates | 新規作成 | admin, pm_tl |
| GET | /api/projects/:id/estimates/:estimateId | 詳細取得 | admin, pm_tl (PR #416: 同上) |
| PATCH | /api/projects/:id/estimates/:estimateId | 更新 | admin, pm_tl |
| DELETE | /api/projects/:id/estimates/:estimateId | 論理削除 | admin, pm_tl |
| PATCH | /api/projects/:id/estimates/:estimateId/confirm | 確定 | admin, pm_tl |

#### タスク / WBS

| メソッド | パス | 説明 | ロール |
|---|---|---|---|
| GET | /api/projects/:id/tasks | 一覧取得（ツリー構造） | 全ロール |
| POST | /api/projects/:id/tasks | 新規作成 | admin, pm_tl |
| GET | /api/projects/:id/tasks/:taskId | 詳細取得 | 全ロール |
| PATCH | /api/projects/:id/tasks/:taskId | 更新 | admin, pm_tl |
| DELETE | /api/projects/:id/tasks/:taskId | 論理削除 | admin, pm_tl |
| GET | /api/projects/:id/tasks/:taskId/progress | 進捗履歴取得 | 全ロール |
| POST | /api/projects/:id/tasks/:taskId/progress | 進捗更新 | admin, pm_tl, 担当 member |
| PATCH | /api/projects/:id/tasks/bulk-update | 一括更新 (計画系=admin/pm_tl, 実績系=+member 自分担当) | admin, pm_tl, 担当 member (実績系のみ) |
| POST | /api/projects/:id/tasks/bulk-duplicate | **WBS タスク一括複製** (PR #420)。階層保持で複製、名称衝突は `(コピー)` suffix で自動リネーム、実績情報はリセット。body: `{ taskIds: uuid[], targetParentId: uuid \| null }`、上限 100 件 | admin, pm_tl |
| POST | /api/projects/:id/tasks/export | WBSテンプレートエクスポート（CSV）。`mode='sync'` で新形式 (ID + 進捗列込み、feat/wbs-overwrite-import) | 全ロール |
| POST | /api/projects/:id/tasks/import | WBSテンプレートインポート（旧フロー: 別プロジェクトへの雛形流用、新規 ID で全件 INSERT） | admin, pm_tl |
| POST | /api/projects/:id/tasks/sync-import | **WBS 上書きインポート (Sync by ID)**。`?dryRun=1` でプレビュー、無しで本実行 (feat/wbs-overwrite-import / PR #420 で UX 全面改修)。本実行は `x-import-snapshot-at` header を併送し OCC で並行編集を検出 | admin, pm_tl |
| POST | /api/projects/:id/tasks/recalculate | 全WP集計再計算（修復ツール） | admin, pm_tl |

#### ガントチャート

| メソッド | パス | 説明 | ロール |
|---|---|---|---|
| GET | /api/projects/:id/gantt | ガント用データ取得 | 全ロール |

#### マイタスク

| メソッド | パス | 説明 | ロール |
|---|---|---|---|
| GET | /api/my-tasks | 自分の担当タスク一覧 | 全ロール（viewer 除く） |

#### リスク・課題

| メソッド | パス | 説明 | ロール |
|---|---|---|---|
| GET | /api/projects/:id/risks | 一覧取得 | 全ロール |
| POST | /api/projects/:id/risks | 新規起票 | admin, pm_tl, member |
| GET | /api/projects/:id/risks/:riskId | 詳細取得 | 全ロール |
| PATCH | /api/projects/:id/risks/:riskId | 更新 | admin, pm_tl, 担当/起票 member |
| DELETE | /api/projects/:id/risks/:riskId | 論理削除 (PR #416: service 層に `context: 'project'` 引数追加、作成者本人のみ削除可) | admin, pm_tl, 作成者 member |
| GET | /api/projects/:id/risks/export | CSV エクスポート | admin, pm_tl |
| GET | /api/risks | 全プロジェクト横断一覧（列: プロジェクト・種別・件名・担当者・影響度・発生可能性・優先度・作成/更新日時・作成/更新者。非メンバーは機微項目マスク） | 認証済み全ユーザ |
| DELETE | /api/risks/:riskId | **横断「全リスク/課題」画面からの admin 削除専用** (PR #416 新規)。service 層に `context: 'global'` を渡して admin only enforce | admin |

#### ナレッジ

| メソッド | パス | 説明 | ロール |
|---|---|---|---|
| GET | /api/knowledge | 横断検索（全ナレッジ） | 全ロール（公開範囲制御あり） |
| POST | /api/knowledge | 新規作成（プロジェクト紐付けなし） | admin, pm_tl, member |
| GET | /api/knowledge/:id | 詳細取得 | 公開範囲に応じる |
| ~~PATCH~~ | ~~/api/knowledge/:id~~ | **廃止 (PR #416)** — UI=API 一致原則に従い route handler 削除 (Next.js が 405 Method Not Allowed を返す)。横断「全ナレッジ」画面に編集 UI が無いため。プロジェクト内更新は `/api/projects/:id/knowledge/:knowledgeId` PATCH 経由 (creator-only) のみ | — |
| DELETE | /api/knowledge/:id | **横断「全ナレッジ」画面からの admin 削除専用** (PR #416 で context='global' 化、admin only enforce) | admin |
| PATCH | /api/knowledge/:id/publish | 公開 | admin, pm_tl |
| GET | /api/projects/:id/knowledge | プロジェクト紐付けナレッジ一覧 | ProjectMember |
| POST | /api/projects/:id/knowledge | 作成（当該 projectId を自動紐付け） | ProjectMember |
| PATCH | /api/projects/:id/knowledge/:knowledgeId | プロジェクト scoped 更新 | ProjectMember |
| DELETE | /api/projects/:id/knowledge/:knowledgeId | プロジェクト scoped 論理削除 | ProjectMember |

#### 振り返り

| メソッド | パス | 説明 | ロール |
|---|---|---|---|
| GET | /api/projects/:id/retrospectives | 一覧取得 | 全ロール |
| POST | /api/projects/:id/retrospectives | 新規作成 | admin, pm_tl |
| GET | /api/projects/:id/retrospectives/:retroId | 詳細取得 | 全ロール |
| PATCH | /api/projects/:id/retrospectives/:retroId | 更新 | admin, pm_tl |
| PATCH | /api/projects/:id/retrospectives/:retroId/confirm | 確定 | admin, pm_tl |
| POST | /api/projects/:id/retrospectives/:retroId/comments | コメント投稿 | admin, pm_tl, member |
| PATCH | /api/projects/:id/retrospectives/:retroId | 更新 (行クリック編集ダイアログ経由) | ProjectMember |
| DELETE | /api/projects/:id/retrospectives/:retroId | 論理削除 (PR #416: service 層に `context: 'project'` 引数追加、作成者本人のみ削除可) | admin, pm_tl, 作成者 |
| GET | /api/retrospectives | 全プロジェクト横断一覧（列: プロジェクト・実施日・計画総括・実績総括・良かった点・次回以前事項・作成/更新日時・作成/更新者。非メンバーは機微項目マスク） | 認証済み全ユーザ |
| DELETE | /api/retrospectives/:retroId | **横断「全振り返り」画面からの admin 削除専用** (PR #416 新規)。service 層に `context: 'global'` を渡して admin only enforce | admin |

#### 提案エンジン (Suggestions)

| メソッド | パス | 説明 | ロール |
|---|---|---|---|
| GET | /api/projects/:id/suggestions | 提案一覧 | admin, pm_tl (PR #416: `project:read` → `project:update`、member/viewer 不可) |
| POST | /api/projects/:id/suggestions/adopt | 提案採用 | admin, pm_tl (PR #416: 同上) |
| GET | /api/projects/:id/suggestions/related-issues | 関連 risk/issue 表示 | admin, pm_tl (PR #416: 同上) |
| GET | /api/projects/:id/suggestions/explain | 採用根拠 (explainability) | admin, pm_tl (PR #416: 同上) |

#### メモ (Memo)

| メソッド | パス | 説明 | ロール |
|---|---|---|---|
| DELETE | /api/memos/:id | メモ削除。**自分のメモ** = 自由に削除可、**他人の public メモ** = service 層に `systemRole` 引数を渡し admin のみモデレーション削除 (PR #416) | 全ロール (自分のメモ) / admin (他人の public メモ) |

#### 添付ファイル (Attachments)

| メソッド | パス | 説明 | ロール |
|---|---|---|---|
| GET | /api/attachments?entityType=...&entityId=... | 添付一覧取得 (親 entity スコープ) | 親 entity 認可に従う |
| POST | /api/attachments | URL 参照型添付の追加 (= 旧式、外部リンクのみ保持) | 親 entity write 権限 |
| PATCH | /api/attachments/:id | 添付更新 (displayName / url / mimeHint) | 親 entity write 権限 |
| DELETE | /api/attachments/:id | 論理削除 + Supabase Storage cascade delete (storageProvider='supabase' の場合) + storageFileBytesUsed atomic 減算。**per-tenant rate limit 100/min** (ADR-0021 §10.2.1) | 親 entity write 権限 |
| **POST** | **/api/attachments/upload** | **ADR-0021 §2.2: Pre-signed Upload URL 発行** (TTL 60s / 50MB / 危険拡張子拒否 / per-tenant 10req/min)。response: `{ uploadUrl, token, objectKey, sanitizedFileName, expiresInSeconds }` | 親 entity write 権限 |
| **POST** | **/api/attachments/finalize** | **ADR-0021 §10.2.2: アップロード完了確定**。Supabase API で実サイズ検証 (50MB 超は即時削除 + 413) → DB row 作成 (storageProvider='supabase', embeddingStatus='pending'/'unsupported') → assertFileStorageLimitInTx で 50GB ハードキャップ + peak MAX 更新 | 親 entity write 権限 |
| **GET** | **/api/attachments/:id/download** | **Pre-signed Download URL 発行 → 302 redirect** (TTL 60s)。url 型は外部 URL に直 redirect、supabase 型は Supabase Storage の Pre-signed Download URL | 親 entity read 権限 (visibility=public は認証済全員) |
| GET | /api/attachments/batch | 複数 entity の添付一括取得 (cross-list dialog 用) | 親 entity 認可に従う |

#### Cron (バックエンド定期処理)

| メソッド | パス | 説明 | 認可 |
|---|---|---|---|
| POST | /api/cron/daily-notifications | 日次通知 + DB 容量集計 + **ファイルストレージ bucket 集計 + drift 検知 + anomaly 検知 (ADR-0021)** | Bearer `CRON_SECRET` |
| POST | /api/cron/tenant-monthly-reset | 月初 cron。リセット + plan 適用 + DB 容量超過請求 + **ファイルストレージ超過請求 (ADR-0021 §4)** + snapshot 保存 + 90 日経過テナント物理削除 | Bearer `CRON_SECRET` |
| POST | /api/cron/stripe-usage-flush | StripeUsageRecordQueue 送信 cron (haiku/sonnet/db_capacity_overage/**storage_file_overage**) | Bearer `CRON_SECRET` |
| **POST** | **/api/cron/attachment-embedding** | **ADR-0021 §3.3: 添付ファイル本文 embedding の背景処理 (推奨 5-15 分間隔)**。指数 backoff (1/5min) + 3 回 retry + throttle (per-tenant=5 / global=50) | Bearer `CRON_SECRET` |

#### システム管理

| メソッド | パス | 説明 | ロール |
|---|---|---|---|
| GET | /api/admin/users | ユーザ一覧 | admin |
| POST | /api/admin/users | ユーザ登録 | admin |
| PATCH | /api/admin/users/:userId | ユーザ更新 | admin |
| DELETE | /api/admin/users/:userId | ユーザ削除 (論理削除 + ProjectMember 物理カスケード、PR #89) | admin |
| POST | /api/admin/users/:userId/unlock | ロック解除 (PR #85) | admin |
| POST | /api/admin/users/lock-inactive | 非アクティブユーザ一括ロック (PR #89 で導入、feat/account-lock で **論理削除 → ロック (isActive=false)** に方針変更、日次 cron + 手動) | admin or 外部 cron (cron-job.org) |
| PATCH | /api/admin/users/:userId/role | ロール変更 (PR #416: 自己ロール変更は `CANNOT_CHANGE_OWN_ROLE` で 403、super_admin 行は UI 非表示) | admin |
| PATCH | /api/admin/users/:userId/status | 有効/無効切替 | admin |
| GET | /api/admin/audit-logs | 監査ログ一覧 | admin |
| GET | /api/admin/role-change-logs | 権限変更履歴 | admin |

### 7.3 レスポンス共通形式

```typescript
// 成功レスポンス
{
  "data": { ... },           // 単一エンティティ or 配列
  "meta": {                  // 一覧時のみ
    "total": 100,
    "page": 1,
    "limit": 20,
    "totalPages": 5
  }
}

// エラーレスポンス
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "入力内容に誤りがあります",
    "details": [
      { "field": "name", "message": "必須項目です" }
    ]
  }
}
```

### 7.4 エラーコード一覧

| コード | HTTP ステータス | 説明 |
|---|---|---|
| VALIDATION_ERROR | 400 | 入力バリデーション失敗 |
| UNAUTHORIZED | 401 | 未認証 |
| FORBIDDEN | 403 | 権限不足 |
| NOT_FOUND | 404 | リソースが見つからない |
| STATE_CONFLICT | 409 | 状態遷移条件を満たさない |
| INTERNAL_ERROR | 500 | サーバ内部エラー |
| **TASK_NAME_DUPLICATE_IN_PARENT** | **400** | **同一親 WP 配下に同名タスクが既存 (PR #420 [#C3])。`POST /tasks` 単一作成・`PATCH /tasks/[id]` 単一編集で発生。`(project_id, parent_task_id, name)` の部分 UNIQUE 制約に対する app 層事前ガード** |
| **IMPORT_VALIDATION_ERROR** | **400** | **sync-import 本実行で dry-run と同じ blocker が再検出された (CSV 改竄 / DB 状態変動)** |
| **IMPORT_REMOVE_BLOCKED** | **400** | **sync-import 本実行で removeMode=delete + 進捗ありタスクの削除が要求された** |
| **IMPORT_CONCURRENT_EDIT** | **409** | **sync-import の OCC 並行編集検出 (PR #420 [#C2])。`x-import-snapshot-at` header と現在の最大 updatedAt が不一致** |
| **TASKS_OUT_OF_RANGE** | **400** | **bulk-duplicate (PR #420): 件数が 0 または 101 以上** |
| **TASKS_NOT_FOUND** | **404** | **bulk-duplicate: 指定 ID が当該 project に存在しない (= 他 project の ID も同扱いで enumeration 防止)** |
| **TARGET_PARENT_NOT_FOUND** | **404** | **bulk-duplicate: 複製先 parent が削除済 or 存在しない** |
| **TARGET_PARENT_NOT_WP** | **400** | **bulk-duplicate: 複製先 parent が ACT (WP でない)** |
| **ACT_CANNOT_BE_ROOT** | **400** | **bulk-duplicate: ACT を root or ACT 配下に置こうとした** |
| **DANGEROUS_FILE_TYPE** | **400** | **ADR-0021: 危険拡張子 (.exe / .sh 等) のアップロード試行** |
| **INVALID_OBJECT_KEY** | **400** | **ADR-0021: finalize 時に objectKey が `tenants/{自テナント}/...` prefix と一致しない (path traversal / 越境試行)** |
| **FILE_TOO_LARGE** | **413** | **ADR-0021: アップロードファイルが 50MB 超過 (申告 or 実サイズ)** |
| **OBJECT_NOT_FOUND** | **404** | **ADR-0021: finalize 時に Supabase Storage 上のオブジェクトが存在しない (Pre-signed URL 発行後 PUT 未完了)** |
| **STORAGE_FILE_HARD_CAP_EXCEEDED** | **403** | **ADR-0021: ファイル添付の使用量が 50GB に到達 (download / delete は継続可)** |
| **STORAGE_UNAVAILABLE** | **503** | **ADR-0021: Supabase Storage API 不通 / 認証情報不正 (リトライ可)** |
| **UPLOAD_URL_FAILED** | **503** | **ADR-0021: Pre-signed Upload URL 発行失敗 (Supabase 5xx)** |
| **DOWNLOAD_URL_FAILED** | **503** | **ADR-0021: Pre-signed Download URL 発行失敗 (Supabase 5xx)** |
| **TOO_MANY_REQUESTS** | **429** | **ADR-0021: per-tenant レート制限超過 (upload 10/min / delete 100/min)** |

---


## §16. 全文検索設計

## 16. 全文検索設計

### 16.1 方式

PostgreSQL の pg_trgm（トライグラム）拡張を採用する。

| 項目 | 選定内容 |
|---|---|
| 拡張 | pg_trgm（PostgreSQL 標準 contrib） |
| インデックス | GIN インデックス |
| 日本語対応 | 3文字以上の部分文字列マッチで対応 |
| 選定理由 | 追加インストール不要、MVP に十分な精度、低い導入・運用コスト |

### 16.2 将来の外部サービス移行を考慮した設計

検索ロジックを Service 層の抽象インターフェースとして定義し、実装を差し替え可能にする。

```typescript
// lib/search/search-provider.ts
export interface SearchProvider {
  search(params: SearchParams): Promise<SearchResult[]>;
  index(entity: IndexableEntity): Promise<void>;
  remove(entityId: string): Promise<void>;
}

export type SearchParams = {
  query: string;
  entityTypes: ('knowledge' | 'project' | 'risk')[];
  filters?: Record<string, string>;
  limit: number;
  offset: number;
};

export type SearchResult = {
  entityType: string;
  entityId: string;
  title: string;
  snippet: string;
  score: number;
};
```

```typescript
// lib/search/pg-trgm-provider.ts（MVP 実装）
export class PgTrgmSearchProvider implements SearchProvider {
  async search(params: SearchParams): Promise<SearchResult[]> {
    // pg_trgm を使用した検索実装
  }
  // ...
}

// lib/search/meilisearch-provider.ts（将来の移行先例）
// export class MeilisearchProvider implements SearchProvider { ... }
```

```typescript
// lib/search/index.ts
// 環境変数で切り替え可能
export function createSearchProvider(): SearchProvider {
  const provider = process.env.SEARCH_PROVIDER || 'pg_trgm';
  switch (provider) {
    case 'pg_trgm': return new PgTrgmSearchProvider();
    // case 'meilisearch': return new MeilisearchProvider();
    default: return new PgTrgmSearchProvider();
  }
}
```

### 16.3 検索対象フィールド

| エンティティ | 検索対象カラム | インデックス対象 |
|---|---|---|
| ナレッジ | title, content, conclusion, recommendation | title + content の連結 |
| プロジェクト | name, customer.name (JOIN), purpose | PR #111-2 以降 customer_name 列は廃止、customers.name を relation filter で検索 |
| リスク/課題 | title, content | title + content の連結 |

### 16.4 検索クエリの制約

| 項目 | 制限値 | 理由 |
|---|---|---|
| クエリ最小文字数 | 2 文字 | pg_trgm は 3-gram のため、1文字では精度が低い |
| クエリ最大文字数 | 200 文字 | DB 負荷の抑制 |
| 結果件数上限 | 100 件 | ページネーションで取得 |
| 類似度閾値 | 0.1（デフォルト） | 調整可能。低すぎるとノイズが増加 |

### 16.5 pg_trgm セットアップ

```sql
-- 拡張の有効化（マイグレーションで実行）
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ナレッジ検索用 GIN インデックス
CREATE INDEX idx_knowledges_search
  ON knowledges USING GIN (
    (title || ' ' || content) gin_trgm_ops
  )
  WHERE deleted_at IS NULL;

-- プロジェクト検索用 GIN インデックス
-- PR #111-2 以降、customer_name 列は廃止されたため顧客名併結は JOIN 経由 (customers.name) に変更が必要。
-- 現時点で pg_trgm 検索は未実装、本スキーマは実装時に再設計する。
CREATE INDEX idx_projects_search
  ON projects USING GIN (
    name gin_trgm_ops
  )
  WHERE deleted_at IS NULL;

-- リスク/課題検索用 GIN インデックス
CREATE INDEX idx_risks_search
  ON risks_issues USING GIN (
    (title || ' ' || content) gin_trgm_ops
  )
  WHERE deleted_at IS NULL;
```

---


## §17. パフォーマンス要件

## 17. パフォーマンス要件

### 17.1 応答時間目標

| 操作カテゴリ | 目標値 | 備考 |
|---|---|---|
| 一覧画面の初期表示 | 1 秒以内 | 20件/ページのデフォルト表示 |
| 詳細画面の表示 | 500ms 以内 | 単一エンティティ + 関連データ |
| データの作成・更新 | 500ms 以内 | バリデーション + 保存 |
| ナレッジ全文検索 | 2 秒以内 | pg_trgm による検索 |
| ガントチャート描画 | 2 秒以内 | 100タスク程度を想定 |
| CSV エクスポート | 5 秒以内 | 最大1,000件 |
| ログイン処理 | 1 秒以内 | bcrypt 検証 + セッション発行 |
| MFA 検証 | 500ms 以内 | TOTP コード検証 |

### 17.2 同時接続数の想定

| 項目 | 想定値 | 根拠 |
|---|---|---|
| 登録ユーザ数 | 100 名以下 | 中小規模の組織を想定 |
| 同時アクティブユーザ | 30 名以下 | 登録者の 30% が同時利用 |
| ピーク時リクエスト | 50 req/sec 以下 | 朝の一斉ログイン・進捗更新 |

### 17.3 DB コネクションプール

Prisma 7 では接続 URL を prisma.config.ts で管理し、ランタイム接続は pg adapter 経由で行う。

| 項目 | 設定値 | 理由 |
|---|---|---|
| pg Pool 接続数 | 5（pg Pool デフォルト: 10） | 初期 5〜10 名の利用に十分。Supabase Free の負荷軽減 |
| 接続タイムアウト | 5 秒 | プール枯渇時の待機上限 |
| 接続方式 | @prisma/adapter-pg（pg Pool 経由） | Prisma 7 の推奨方式 |

```prisma
// schema.prisma - Prisma 7 形式（URL は schema 内に記載しない）
datasource db {
  provider = "postgresql"
}
```

```typescript
// prisma.config.ts - マイグレーション用の接続設定
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    // DIRECT_URL が設定されていればマイグレーション用に使用
    // なければ DATABASE_URL を使用（ローカル開発時は同一）
    url: process.env['DIRECT_URL'] || process.env['DATABASE_URL'],
  },
});
```

```typescript
// src/lib/db.ts - ランタイム接続（pg adapter 経由）
import { PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
export const prisma = new PrismaClient({ adapter });
```

### 17.4 ページネーション

| 項目 | 仕様 |
|---|---|
| デフォルト件数 | 20 件 |
| 最大件数 | 100 件 |
| 方式 | MVP ではオフセットベース（?page=1&limit=20） |
| 将来 | データ量増加時にカーソルベースへ移行 |

### 17.5 キャッシュ方針

> **注意**: 本節の TanStack Query 関連記述は **採用予定 (現時点で未導入)** の設計案である。
> 現状の MVP は Next.js App Router の Server Components + Server Actions のみで構成されており、クライアントサイドキャッシュは導入していない。本表は将来のリッチ UI 化時の方針として残している。

| 対象 | キャッシュ方式 | TTL | 無効化タイミング |
|---|---|---|---|
| セッション情報 | TanStack Query (staleTime) ※未導入 | 5 分 | ログアウト / 権限変更時 |
| プロジェクト一覧 | TanStack Query (staleTime) ※未導入 | 1 分 | 作成・更新・削除時 |
| マスタデータ（定数） | ビルド時埋め込み | なし | デプロイ時 |
| ナレッジ検索結果 | TanStack Query (staleTime) ※未導入 | 30 秒 | 作成・更新・削除時 |
| ガントチャートデータ | TanStack Query (staleTime) ※未導入 | 1 分 | タスク更新時 |

MVP ではサーバサイドキャッシュ（Redis 等）は導入しない。将来 TanStack Query を採用する際にクライアントサイドキャッシュで対応する想定。

### 17.6 パフォーマンス・アンチパターン（コミット前チェックリスト）

再発防止のため、コード変更時は以下を自問する。

1. **同一テーブルへの重複 findMany** — Server Component の `Promise.all` に、同じエンティティに対する複数の findMany が入っていないか（tree/flat のような後処理違いでも 1 回に集約）
2. **表示件数とクエリ limit の乖離** — `limit:` / `take:` が実際の表示件数（`slice(0, N)` 等）と一致しているか
3. **再帰・大量リストの memo 未適用** — 自己再帰コンポーネントや 100 件超のリストは `React.memo` 必須、props は参照安定（Set/Array を直接渡すなら親で boolean に畳む）
4. **O(N×M) の背景 DOM** — 行 × 列のグリッドで、各行が共通背景を描画していないか（共通背景は行ループ外のオーバーレイへ）
5. **タブ配下の eager fetch** — 切替で表示する UI のデータを初回ロードで全て取得していないか（可能ならタブ表示時の lazy fetch へ）

---

