# セキュリティ設計と多層防御 (Program Design)

本ドキュメントは、認証・認可・多層防御の技術設計を集約する (DESIGN.md §8〜§9)。脅威モデルは [../security/SUGGESTION_ENGINE_THREAT_MODEL.md](../security/SUGGESTION_ENGINE_THREAT_MODEL.md)、運用上のセキュリティ手順は [../operations/](../operations/) を参照。

---

## §8. 権限制御設計

### 8.1 権限チェックの実装箇所

```
Request
  → Middleware（認証 + Basic Auth + レート制限 + read-only/suspended write ガード）
    → Route Handler（リクエストの受け取り、バリデーション、Stripe disabled guard 等）
      → Service Layer（ロール/テナント認可 + ビジネスロジック）
        → Prisma（データアクセス、where に tenantId 明示）
```

**原則**: 業務的なロール認可・テナント分離は Service 層で統一実施する。ただし **Middleware は単なる認証チェックだけではない** —
`src/middleware.ts` + `src/lib/auth.config.ts` の `authorized` callback が以下の横断ガードを Edge runtime で担う:

| 担当 | 実装箇所 | 概要 |
|---|---|---|
| 認証ゲート | `auth.config.ts:88-91` | 未ログインは `LOGIN_PATH` へ redirect。`PUBLIC_PATHS` は通過 |
| MFA 未検証ガード | `auth.config.ts:96-105` | `mfaEnabled && !mfaVerified` で保護領域へ来たら `/login/mfa` へ誘導 |
| Basic Auth | `middleware.ts:75-83` | `/admin/super/*` + `/api/admin/super/*` にネットワークレベル Basic Auth (クレ協チェックリスト 1.1 対応)。`ADMIN_SUPER_BASIC_AUTH_USER/_PASS` 両 set で有効化 |
| login レート制限 | `middleware.ts:86-95` | `/api/auth/callback/credentials` POST に IP 単位 rate limit (詳細は §9.7.1) |
| suspended write ブロック | `auth.config.ts:137-153` | `tenantSuspendedAt` が non-null の間、write メソッド (POST/PATCH/PUT/DELETE) を `403 TENANT_SUSPENDED` で遮断 |
| Beginner read-only ガード | `auth.config.ts:159-191` | Beginner プランで試用期間 90 日 (テナント TZ カレンダー日) 経過後、write メソッドを `403 BEGINNER_EXPIRED_READ_ONLY` で遮断 |

#### 8.1.1 middleware matcher — public 静的アセットの認証ガード除外 (★severity-1 修正済)

Edge middleware は `config.matcher` の正規表現 (`src/middleware.ts:142`) に一致したパスでのみ実行され、`auth()` wrapper の認証ガードもこの matcher 範囲に限定される。matcher は以下を **認証チェックから除外** している:

| 除外対象 | 理由 |
|---|---|
| `_next/static` / `_next/image` / `favicon.ico` | Next.js のビルド成果物・画像最適化エンドポイント |
| `[^?]+\.(png\|jpg\|jpeg\|svg\|webp\|gif\|ico\|txt\|xml\|woff2?\|ttf\|eot)$` | **`?` を含まない (= API ではない) パスで拡張子が静的アセット拡張子のもの全て**。`public/` 配下の現在/将来のファイル (マスコット PNG / OG 画像 / `robots.txt` / `sitemap.xml` / フォント等) を一括で素通りさせる |
| `api/auth/mfa/verify` / `api/tenants/me/i18n` / `api/auth/explicit-signout` | これら 3 ルートは自前で `await auth()` 認証チェックを行い、かつ JWT 再署名 / cookie 削除の Set-Cookie を返すため、middleware の auto-refresh による Set-Cookie 上書きを避ける目的で除外 (§9.4.4.1) |

> **★severity-1 経緯 (PR #451 / fix/login-mascot-and-layout-fix / 2026-05-29)**: マスコット導入 (PR #451) で追加された `public/` 配下の静的ファイル (`/mascot-owl.png`, `/og-image.png`, `/robots.txt` 等) が middleware の認証ガードに巻き込まれ、未認証ユーザに対し `/login` へ **302 redirect** されていた。結果としてマスコット画像の broken-image 表示、SNS シェア時の OG プレビュー消失、`robots.txt` の noindex 制御不全 (招待制中の SEO リスク) が発生。旧 matcher は `favicon.ico` のみ列挙していたため新規ファイルが追記漏れだった。
>
> **設計判断**: 個別ファイル列挙ではなく **拡張子ベースの一括除外** に変更し、追記漏れリスクを根絶した。`public/` 配下は Next.js の設計上「全公開リソース」であり、middleware で除外しても情報漏洩リスクは無い (むしろ認証 redirect の方が異常動作)。詳細: `src/middleware.ts:125-142` / KDD §5.X+177。

read-only / suspended ガードはいずれも `READ_ONLY_BYPASS_PATHS` (`/api/tenants/me`, `/api/tenants/me/self-delete`) を例外とし、
顧客側からのプラン変更・セルフ解約 (= 脱出経路) は維持する (`auth.config.ts:126-130`)。
Middleware は Edge runtime で DB を引けないため、判定は JWT claim (`tenantPlan` / `tenantCreatedAt` / `tenantBeginnerEverUpgraded` / `tenantSuspendedAt` / `timezone`) のみで行う純関数。

### 8.2 権限判定ロジック

```typescript
// lib/permissions/check-permission.ts

type PermissionContext = {
  user: { id: string; systemRole: 'admin' | 'general' };
  projectId?: string;
  projectRole?: 'pm_tl' | 'member' | 'viewer' | null;
  projectStatus?: ProjectStatus;
  resourceOwnerId?: string; // リソースの作成者/担当者
};

function checkPermission(
  action: string,
  context: PermissionContext
): { allowed: boolean; reason?: string } {
  // 1. システム管理者は（監査系を除き）全操作可
  // 2. プロジェクトロールによるロールチェック
  // 3. プロジェクト状態による状態チェック
  // 4. 対象データ条件チェック（自分担当か等）
  // 操作可 = ロール可 AND 状態可 AND 対象データ条件可
}
```

### 8.2.1 プロジェクトメンバーシップと権限判定の関係

権限判定において、`projectRole` は `project_members` テーブルから取得する。
一般ユーザがプロジェクト関連の操作を行う場合、以下の順序で判定する。

```
1. project_members テーブルで (project_id, user_id) を検索
2. レコードが存在しない → アクセス拒否（プロジェクト未参加）
3. レコードが存在する → project_role を取得
4. project_role + project_status + resource_owner で操作可否を判定
```

システム管理者（`system_role = 'admin'`）はプロジェクトメンバーシップに関係なく全プロジェクトにアクセス可能。ただし、監査上は操作記録を残す。

### 8.3 権限マトリクス（実装用サマリ）

| 操作カテゴリ | admin | pm_tl | member | viewer |
|---|---|---|---|---|
| プロジェクト CRUD | 全操作 | 作成・編集 | 閲覧のみ | 閲覧のみ |
| メンバー管理 | 全操作 | 一覧閲覧のみ | 不可 | 不可 |
| 見積もり | 全操作 | 全操作 | 不可 | 不可 |
| タスク管理 | 全操作 | 全操作 | 自分タスクの進捗更新のみ | 閲覧のみ |
| リスク・課題 / ナレッジ / 振り返り (2026-04-24 改修) | 参照 + 削除 (全○○ から管理削除のみ) | 作成 + **自分起票分の編集/削除** | 作成 + **自分起票分の編集/削除** | 閲覧のみ |
| メモ | 自分の全メモ (個人資産) | 自分の全メモ | 自分の全メモ | 自分の全メモ |
| システム管理 | 全操作 | 不可 | 不可 | 不可 |

### 8.3.1 リスク/課題/振り返り/ナレッジ の権限詳細 (2026-05-01 改修 / 旧 2026-04-24)

4 エンティティ共通で以下の方針。メモは個人資産なので対象外。

| 操作 | 全○○ 画面 | ○○一覧 画面 (プロジェクト詳細タブ) |
|---|---|---|
| 一覧参照 | `visibility='public'` のみ (admin / 非 admin 共通) | **public + 自分の draft** (非 admin)<br>admin: draft 含め全件 |
| 個別参照 (view) | public: 全員 OK<br>draft: 作成者本人 + admin のみ | 同左 |
| 作成 | — (画面から不可) | **実際の ProjectMember** (`pm_tl` / `member`) のみ<br>admin でも非メンバーなら不可 |
| 編集 | — (画面から不可、全員 read-only) | **作成者 OR 担当者**<br>admin でも他人の記事は編集不可<br>(2026-05-26 担当者拡張: feat/asset-assignee-expansion) |
| 削除 | **admin のみ** (管理削除、全リスク/課題/振り返り/ナレッジ画面から) | **作成者 OR 担当者** (admin は全○○ 経由で削除)<br>(2026-05-26 担当者拡張) |

**2026-05-01 変更点 (PR fix/visibility-auth-matrix)**: 「○○一覧」で **自分の draft が表示されるように** filter を緩和
(`OR [{public}, {draft AND createdBy=自分}]`)。旧仕様 (2026-04-24「自分の draft も一覧から除外」) はユーザが
自分の起票を視認できず、Toast 通知 (PR #194) と組み合わさって「成功メッセージは出るが画面に出ない」UX バグを発生させた。
詳細は DEVELOPER_GUIDE §5.51 / E2E_LESSONS_LEARNED §4.50 参照。

**実装ポイント**:
- `lib/permissions/membership.ts#getActualProjectRole` で admin 短絡なしの実メンバー判定を提供
- `lib/api-helpers.ts#requireActualProjectMember` で API POST ルートの作成制約を強制
- service 層の `listX` (project-scoped) は **`OR [{public}, {draft AND createdBy=viewer}]`** で自己 draft を含める
- service 層の `updateX` は **「作成者 (createdBy/reporterId) OR 担当者 (assigneeId) と一致しなければ FORBIDDEN」** で enforce (2026-05-26 担当者拡張)
- service 層の `deleteX` は **「作成者 OR 担当者 OR admin」** で enforce (project context は本人系のみ、global context は admin のみ)
- service 層の `deleteX` は entity 削除時に **`prisma.comment.updateMany` で同 entity のコメントも cascade soft-delete**
- `getX(id, viewerUserId?, viewerSystemRole?)` は認可引数付きで draft 秘匿 (他人の draft は null 返却 = 存在しない扱い)
- UI 層 (各 `○○-client.tsx`) では `currentUserId` + `createdBy` / `reporterId` で isOwner 判定し、編集/削除ボタンを出し分け
- UI 層 では `<VisibilityBadge>` で draft / public を視覚的に区別 (一覧で混在表示するため)

### 8.3.2 コメント機能の認可詳細 (PR #199 / 2026-05-01 PR fix/visibility-auth-matrix)

エンティティ別のコメント参照/投稿/編集/削除権限。entity の visibility と連動する設計:

| entity | コメント参照 | コメント投稿 | コメント編集/削除 |
|---|---|---|---|
| issue / risk / retrospective / knowledge (visibility='public') | 認証済全アカウント | 認証済全アカウント | 投稿者本人のみ |
| issue / risk / retrospective / knowledge (visibility='draft') | 作成者本人 + admin (admin は read のみ) | 作成者本人のみ (admin 不可) | 投稿者本人のみ |
| task | project member or admin | 同左 | 投稿者本人のみ |
| stakeholder | project member or admin | 同左 | 投稿者本人のみ |
| customer | admin のみ | admin のみ | 投稿者本人のみ |

**カスケード削除**: 親 entity が削除されたら、当該 entity に紐づくコメントも自動で soft-delete される
(各 service の `deleteX` 関数で `prisma.comment.updateMany({entityType, entityId, deletedAt:null}, {deletedAt:now})` を
同 transaction に含める方式)。`deleteProjectCascade` は物理削除のため `prisma.comment.deleteMany` を使用。

**実装ポイント**:
- `comment.service.ts#resolveEntityForComment` が entity の visibility と creatorId を返し、route 層で mode (read/write) と
  組み合わせて認可判定する判別ユニオン拡張パターン
- `comment.service.ts#softDeleteCommentsForEntity` が cascade 用の共通ヘルパ (新規 entity 追加時の再利用先)

### 8.3.3 コメント @mention 機能の認可詳細 (PR feat/comment-mentions / 2026-05-01)

| entityType | 許容 mention kind |
|---|---|
| issue / risk / retrospective / knowledge | 全 kind: `user` / `all` / `project_member` / `role_pm_tl` / `role_general` / `role_viewer` / `assignee` |
| task / stakeholder | project スコープのみ: `user` / `project_member` / `role_pm_tl` / `role_general` / `role_viewer` / `assignee` (`all` 不可) |
| customer | `user` のみ (admin only entity) |

**UI 経路 (context) 別のタブ表示**:

| URL 経路 | context | 表示する group タブ |
|---|---|---|
| `/projects/[id]/tasks` | `wbs` | project_member / role_* / assignee (all なし) |
| `/projects/[id]/...` (上記以外) | `project_list` | 全 kind (entity が許容するもの) |
| `/risks` `/issues` `/retrospectives` `/knowledge` 等 | `cross_list` | all / assignee のみ |

**配信フロー**:
1. POST /api/comments で mentions[] を受信
2. validateMentionsForEntity で entityType と突合 (Q3 二重防御)
3. Comment + Mention レコード作成
4. 各 mention を expandMention で userId[] に展開
5. recipients から自分自身を除外 (Q5)
6. Notification を一括 createMany (dedupeKey UNIQUE で 2 重通知防止)

**編集時 (Q2)**:
- 旧 / 新 mentions を `mentionKey = '{kind}:{targetUserId ?? ""}'` で diff
- added の mention のみ通知生成、removed は DB 削除のみ (通知なし)

**実装ポイント**:
- `mention.service.ts#getAllowedMentionKinds` が entityType → 許容 kind の単一ソース (UI / server で共有)
- `expandMention` は kind ごとの DB クエリで動的展開、グループメンションは保存時点で確定せず配信時に解決
- `generateMentionNotifications` は dedupeKey UNIQUE 制約で同一 (commentId, userId) の 2 重通知を DB レベルで弾く

### 8.3.4 通知 (Notification) 機能の認可詳細 (PR feat/notifications-mvp / 2026-05-01)

| 操作 | 認可 |
|---|---|
| 一覧取得 (`GET /api/notifications`) | 認証済ユーザの **自分宛のみ** (userId フィルタ強制) |
| 既読/未読切替 (`PATCH /api/notifications/[id]`) | 通知の `userId` が呼出ユーザと一致する場合のみ (admin も他人の通知は不可、CWE-639 IDOR 対策) |
| 一括既読 (`POST /api/notifications/mark-all-read`) | 自分宛の未読のみが対象、他人に影響しない |
| Cron (`POST /api/cron/daily-notifications`) | `Authorization: Bearer ${CRON_SECRET}` のみ。`CRON_SECRET` 未設定で fail-closed (401) |

**通知生成フロー** (毎日 JST 7:00 / UTC 22:00 cron 実行):

1. ACT (`type='activity'`) で `status='not_started'` AND `plannedStartDate=今日 (JST)` AND `assigneeId IS NOT NULL` → **開始通知** を assignee に作成
2. 同 ACT で `status≠'completed'` AND `plannedEndDate=今日 (JST)` AND `assigneeId IS NOT NULL` → **終了通知** を assignee に作成
3. 既読 + `readAt > 30日` の通知を物理削除 (容量管理)

**重複抑止**: `dedupeKey = '{type}:{taskId}:{YYYY-MM-DD}'` を UNIQUE 制約で DB レベルに弾く。
cron が同日に複数回呼ばれても安全 (`createMany skipDuplicates: true`)。

**パフォーマンス**: WBS 階層 traversal を完全回避するため、partial index 2 本を migration で追加:

```sql
CREATE INDEX idx_tasks_planned_start_due ON tasks (planned_start_date)
  WHERE deleted_at IS NULL AND type='activity'
    AND assignee_id IS NOT NULL AND status='not_started';
CREATE INDEX idx_tasks_planned_end_due ON tasks (planned_end_date)
  WHERE deleted_at IS NULL AND type='activity'
    AND assignee_id IS NOT NULL AND status<>'completed';
```

### 8.3.5 メモ (Memo) の独立方針

- プロジェクト非紐付け、完全に個人資産
- CRUD は常に **自分のメモのみ** 可能 (role 判定は不要)
- 他人のメモは「全メモ」画面で `visibility='public'` のみ閲覧可 (read-only)
- **ユーザ削除時のカスケード物理削除**: `deleteUser` で `memo.deleteMany({ where: { userId } })` を
  `$transaction` に含める。振り返り/ナレッジ等「組織の資産」を残す方針と対照的に、メモは
  退職者分を残す意味がないためカスケード削除で掃除する (2026-04-24)

### 8.4 PR #416 で導入された認可機構 (CRUD 設計刷新)

PR #416 (feat/crud-permission-redesign) で導入された認可機構の設計原則と実装パターン。
既存の §8.3.x の補強として、UI=API 一致原則 / context-aware service / 細粒度ロールガード /
監査ログ秘匿化 / cron 重複実行防止 / transaction 化を整理する。

#### 8.4.1 UI=API 認可一致原則

> **UI から到達できない経路は API でも 403 を返す**。Method Not Allowed (405) も含め、
> route handler 自体を削除することで「UI には無いが API は通る」という IDOR の温床を断つ。

**例: 横断 `/api/knowledge/[knowledgeId]` の PATCH ハンドラ削除**:
- 横断「全ナレッジ」画面は read-only / 削除のみで、編集 UI は存在しない
- 旧仕様では PATCH route が残っていたため、curl 直叩きで他人のナレッジ更新が可能だった
- PR #416 で **PATCH ハンドラ自体を route.ts から削除** → Next.js が **405 Method Not Allowed** を自動応答
- プロジェクト内更新は `/api/projects/[id]/knowledge/[knowledgeId]` PATCH 経由 (creator-only enforce) のみに集約

**設計判断**: 「UI から呼ばれないなら API も用意しない」を原則化。横断系 (cross-list) の API は
GET (一覧/詳細) と DELETE (admin global moderation) のみ提供し、CREATE/UPDATE は project-scoped route に限定する。

#### 8.4.2 削除 service の context 引数 (project / global)

`deleteKnowledge` / `deleteRisk` / `deleteRetrospective` の 3 service に
`context: 'project' | 'global'` 引数を追加し、route 層から経路を明示する設計に変更。

| context | 呼出元 route | 認可ルール |
|---|---|---|
| `'project'` | `/api/projects/[id]/{knowledge,risks,retrospectives}/[childId]` DELETE | **作成者 OR 担当者** (admin でも他人の記事は削除不可、UI ボタン非表示と一致)<br>2026-05-26 担当者拡張 (feat/asset-assignee-expansion) |
| `'global'` | `/api/{knowledge,risks,retrospectives}/[childId]` DELETE | **admin only** (横断「全○○」画面からのモデレーション削除専用) |

**狙い**: route 層が経路情報を service に明示することで、「同じ delete 関数でも経路により認可が異なる」
ロジックを service 層に集約。route 層は context を渡すだけで判定責任を持たず、テスタビリティが向上する
(service 単体テストで context ごとの認可分岐を網羅可能)。

**実装**: service 層で context に応じて `if (context === 'global' && systemRole !== 'admin') throw FORBIDDEN`
と早期 return。`context === 'project'` の場合のみ creator 一致チェックを実施。

#### 8.4.3 PM/TL のメンバー管理開放 + 細粒度ガード

`member:manage` 権限を **pm_tl にも付与** し、メンバー追加 / メンバー解除 / ロール変更を
PM/TL でも実施可能とした。ただし「PM/TL ロール」を扱う操作は **service 層で別途 admin only enforce**。

**細粒度ガード対象 (`FORBIDDEN_PMTL_ROLE` で 403)**:
- PM/TL ロールでのメンバー追加 (`addMember` で `role='pm_tl'` を指定)
- PM/TL からそれ以外のロール (member/viewer) への変更
- それ以外のロールから PM/TL への昇格
- PM/TL ロールの解除 (`removeMember` で対象が PM/TL)

**狙い**: PM/TL が現場の member/viewer を機動的に追加/外す運用を可能にしつつ、
**「PM/TL の任命権」だけは admin に集中** させる。組織階層の境界線を守る設計。

**実装**: `member.service.ts` の各関数で対象/現在ロールが `pm_tl` の場合に systemRole を再チェック。
route 層は `checkProjectPermission('member:manage')` のみで通し、PM/TL 特例は service 層に集約する。

#### 8.4.4 自己ロール変更禁止

以下 3 経路で「自分自身の権限を自分で変更する」操作をブロック:

| 経路 | エラーコード | 対象操作 |
|---|---|---|
| `/api/admin/users/[userId]/role` | `CANNOT_CHANGE_OWN_ROLE` | admin が自分自身の systemRole を変更しようとする |
| `/api/projects/[id]/members/[userId]` PATCH | `CANNOT_CHANGE_OWN_PROJECT_ROLE` | プロジェクトメンバーが自分の projectRole を変更しようとする |
| `/admin/users` UI | super_admin の行を非表示 (UI レベルガード) | super_admin は admin UI から操作不可、システム所有者として保護 |

**狙い**: ロックアウト防止 (誤って自分の admin 権限を剥奪して操作不能になるのを防ぐ)
+ 権限昇格攻撃の遮断 (一旦取得した低権限を自己昇格できないように)。

#### 8.4.5 `sanitizeForAudit` の JSON.stringify replacer 方式

監査ログ (`AuditLog.details` 等) の機密フィールド秘匿化を、`JSON.stringify(obj, replacer)` の
replacer 関数で実装する設計に変更 (PR #416 で再実装)。

**プロトタイプ汚染防御**:
- `Object.hasOwn(obj, key)` で own property のみを処理
- `__proto__` / `constructor` / `prototype` の key は明示的にスキップ
- 入力オブジェクトに対する `Object.create(null)` ベースのコピーは不要 (stringify が新規 string を生成するため副作用なし)

**nested 機微フィールド再帰 redact**:
- replacer は depth に関係なく全 key に呼ばれるため、ネスト構造でも漏れなく処理可能
- 配列要素にも再帰適用 (`Array.isArray` の特別扱い不要)

**SENSITIVE_FIELDS (14 種)**:
`passwordHash`, `mfaSecretEncrypted`, `recoveryCodeHash`, `tokenHash`, `sessionToken`,
`refreshToken`, `apiKey`, `webhookSecret`, `stripeMeterEventToken`, `password`,
`secret`, `apiToken`, `accessToken`, `clientSecret` (実装は src/lib/sanitize-audit.ts 参照)。

**Redact 後の値**: `'[REDACTED]'` (固定文字列) を返却。null/undefined にしないことで、
「フィールドが存在したが秘匿された」と「フィールドが存在しなかった」をログ上で区別可能。

#### 8.4.6 cron advisory lock (PostgreSQL `pg_try_advisory_lock`)

cron job の重複実行 (Netlify cron + 手動トリガ + 別 region 並走など) を防ぐため、
PostgreSQL の `pg_try_advisory_lock(bigint)` を採用。

**Lock key 算出**:
1. `cronName` (例: `'daily-notifications'`, `'lock-inactive-users'`) を文字列で受け取る
2. **djb2 hash** で 32bit 整数に縮約 (`hash = ((hash << 5) + hash) + char` を全 char 累積)
3. BigInt にキャストして PostgreSQL に渡す (advisory lock は bigint 引数を取る)

**ロック取得失敗時**: 即座に return (HTTP 200, body に `'already-running'` 等を返す)。
他インスタンスが処理中なら自分は何もしない `at-most-once` セマンティクス。

**ロック解放**: `pg_advisory_unlock(key)` を finally 句で必ず呼出。
セッション断絶時も PostgreSQL 側が session-level lock を自動解放するためデッドロック耐性あり。

**狙い**: Netlify cron は分散実行されるため、同 cron が複数 region で同時起動するリスクが
ある (DB レベル idempotency を担保しない処理では二重実行による不整合が発生する)。

#### 8.4.7 transaction 化された経路

PR #416 で新たに `$transaction` 化した service 経路一覧。
**いずれも「複数テーブル更新 + 失敗時の部分コミット排除」** が目的。

| service | 含まれる操作 |
|---|---|
| `deleteAccount` (user self-delete) | User soft-delete + Memo 物理削除 + ProjectMember 物理削除 + Session 物理削除 |
| `deleteUser` (admin) | 同上 + AuditLog 記録 |
| `addMember` | ProjectMember 作成 + AuditLog 記録 + (新規 PM/TL なら) RoleChangeLog 記録 |
| `updateMemberRole` | ProjectMember 更新 + AuditLog 記録 + RoleChangeLog 記録 |
| `removeMember` | ProjectMember 削除 + 該当ユーザ起票の draft 強制取扱判定 + AuditLog 記録 |
| `lockInactiveUsers` (cron) | 対象ユーザ列の isActive=false 一括更新 + Session 一括無効化 + AuditLog 一括記録 |
| `deleteProjectCascade` (強制削除) | Project + 配下全 entity 物理削除 + Comment 物理削除 + Knowledge 物理削除 + AuditLog 記録 |

**設計判断**: いずれも「権限変更 / 削除 / cascade 系」で、部分コミットが残ると
**監査証跡と実データの矛盾** を生む。よって route 層ではなく **service 層内で `prisma.$transaction([...])`** を呼出し、
呼出側からは単一 promise として扱える設計に揃える。

#### 8.4.8 参照

- ADR-0014: CRUD 設計刷新 (本 §8.4 全体の意思決定背景)
- ADR-0015: cascade 削除冪等設計 (§8.4.7 transaction 化と `deleteProjectCascade` の方針)
- KDD §5.X+85〜+88: PR #416 開発中に発見された罠と教訓
- [FOLLOW_UP_AFTER_PR416.md](../archive/2026-06-01-pre-ops-reorg/FOLLOW_UP_AFTER_PR416.md): PR #416 マージ後の残課題 / 後続対応一覧

---


## §9. セキュリティ設計

### 9.1 セキュリティ設計方針

本プラットフォームは複数組織のプロジェクト情報（見積もり・実績・顧客情報・知見）を扱うため、情報漏洩は事業上の重大リスクとなる。
以下の原則に基づき、多層防御（Defense in Depth）を設計する。

| 原則 | 適用方針 |
|---|---|
| 最小権限の原則 | ロール x プロジェクト状態 x データ所有者の 3 層で操作を制限 |
| 多層防御 | Middleware → Route Handler → Service → DB の各層で独立した検証 |
| Fail Secure | 権限判定に失敗した場合は拒否（デフォルト拒否） |
| 機密情報の最小化 | パスワードハッシュ・内部IDはレスポンスに含めない |
| 監査可能性 | 全ての状態変更・権限変更・認証イベントを記録 |

### 9.2 信頼境界

```
非信頼ゾーン: ブラウザ / 外部ネットワーク
         | HTTPS (TLS 1.2+)
         v
境界 1: HTTP 入口
  検証: セキュリティヘッダ付与, CORS, レート制限, リクエストサイズ制限
         |
         v
境界 2: 認証ゲート (Middleware)
  検証: セッション有効性, CSRF トークン, アカウントロック状態
         |
         v
境界 3: 入力バリデーション (Route Handler)
  検証: Zod スキーマ, 文字数制限, 型検査, サニタイゼーション
         |
         v
境界 4: 認可ゲート (Service Layer)
  検証: RBAC (ロール x 状態 x 所有者), IDOR防止, ビジネスルール
         |
         v
境界 5: データアクセス (Prisma)
  検証: プリペアドステートメント, 論理削除フィルタ, テナント分離
         |
         v
信頼ゾーン: PostgreSQL (暗号化接続, 最小権限 DB ユーザ)
```

| 境界 | 内側（信頼） | 外側（非信頼） | 境界越えで行う検証 |
|---|---|---|---|
| 1 HTTP 入口 | Next.js サーバ | クライアント | TLS, セキュリティヘッダ, CORS, レート制限, リクエストサイズ制限 |
| 2 認証ゲート | 認証済みリクエスト | 未認証リクエスト | セッション有効性, CSRF トークン, アカウント状態 |
| 3 入力検証 | バリデーション済みデータ | 生リクエストデータ | Zod スキーマ, サニタイゼーション |
| 4 認可ゲート | 許可された操作 | 未許可の操作 | RBAC + 状態制御 + IDOR 防止 |
| 5 データアクセス | SQL クエリ | アプリケーション | プリペアドステートメント, テナント分離 |

### 9.3 脅威と対策（STRIDE）

| # | 脅威 | カテゴリ | 影響 | 対策 | 実装箇所 |
|---|---|---|---|---|---|
| 1 | 他ユーザになりすましてログイン | S | HIGH | bcrypt ハッシュ + アカウントロック + レート制限 | NextAuth + Middleware |
| 2 | セッション乗っ取り | S | HIGH | HttpOnly / Secure / SameSite Cookie + セッションローテーション | NextAuth Session |
| 3 | セッション固定攻撃 | S | HIGH | ログイン成功時にセッションIDを再生成 | NextAuth Session |
| 4 | 他プロジェクトのデータ改ざん | T | HIGH | Service 層でプロジェクトメンバーシップ検証（全クエリ） | Permission Guard |
| 5 | リクエストパラメータ改ざん | T | MEDIUM | Zod スキーマバリデーション + 許可リスト方式 | Route Handler |
| 6 | IDOR（他ユーザのリソース操作） | T | HIGH | リソース取得時に所有者/メンバーシップを必ず検証 | Service Layer |
| 7 | 操作の否認 | R | MEDIUM | 監査ログ記録（操作者・日時・変更前後の値・IP） | audit_logs |
| 8 | 権限変更の否認 | R | HIGH | 権限変更専用の不変履歴テーブル | role_change_logs |
| 9 | 認証イベントの否認 | R | HIGH | ログイン成功/失敗を専用テーブルに記録 | auth_event_logs |
| 10 | 他プロジェクトの見積もり閲覧 | I | HIGH | 全 API でプロジェクトメンバーシップ検証 | Service Layer |
| 11 | ナレッジの不正閲覧 | I | MEDIUM | 公開範囲（visibility）+ メンバーシップ検証 | Knowledge Service |
| 12 | エラーメッセージからの情報漏洩 | I | MEDIUM | 本番環境ではスタックトレース非表示、汎用エラーメッセージ | Error Handler |
| 13 | レスポンスからの機密情報漏洩 | I | HIGH | password_hash 等を DTO 変換で除外 | Service Layer |
| 14 | 大量リクエストによるサービス停止 | D | MEDIUM | エンドポイント別レート制限 + ページネーション強制 | Middleware |
| 15 | 大容量リクエストによるリソース枯渇 | D | MEDIUM | リクエストボディサイズ制限（1MB） | Middleware |
| 16 | 検索クエリによる DB 負荷 | D | MEDIUM | 全文検索のクエリ長制限 + タイムアウト | Service Layer |
| 17 | 権限のないユーザがシステム管理操作 | E | CRITICAL | system_role = admin の厳格チェック | Permission Guard |
| 18 | メンバーが PM/TL 操作を実行 | E | HIGH | project_role + 状態 + 所有者の 3 層チェック | Permission Guard |
| 19 | 無効化ユーザの継続アクセス | E | HIGH | セッション検証時に is_active チェック | Middleware |
| 20 | SQL インジェクション | T | CRITICAL | Prisma ORM（プリペアドステートメント自動適用） | Data Access Layer |
| 21 | XSS（格納型） | T | HIGH | React 自動エスケープ + CSP + 入力サニタイゼーション | Frontend + Middleware |
| 22 | CSRF | T | MEDIUM | SameSite Cookie + NextAuth CSRF Token + Origin 検証 | NextAuth + Middleware |
| 23 | クリックジャッキング | T | MEDIUM | X-Frame-Options: DENY + CSP frame-ancestors | Security Headers |
| 24 | オープンリダイレクト | T | MEDIUM | リダイレクト先を許可リストで制限 | Auth Flow |
| 25 | パスワードリスト攻撃 | S | HIGH | アカウントロック + レート制限 + ログイン試行ログ | Auth + Middleware |

### 9.4 認証設計

#### 9.4.1 認証方式

- **認証プロバイダ**: NextAuth.js Credentials Provider（**組織 ID + メール + パスワード** — ADR-0016 / 2026-05-20）
- **パスワードハッシュ**: bcrypt（cost factor: 12）
- **セッション戦略**: **JWT 戦略**（NextAuth `session.strategy: 'jwt'` — `src/lib/auth.config.ts:30`）。サーバ側にセッションストアを持たず、JWT を HttpOnly セッション cookie で保持する。§9.4.4 と統一。
  - 補足: `sessions` テーブルは schema に存在するが、現行の認証は JWT 戦略で動作しており DB セッションアダプタは使用していない。失効は §9.4.4 の `tokenVersion` + DB 照合方式で実現する。

> **ADR-0016 (2026-05-20) 多テナント対応**: `User.email` を **tenant-scoped 一意** (`@@unique([tenantId, email])`) に変更。
>   同一個人が複数テナントに同じ email で所属可能になった (Slack / Notion / GitHub Org 系の標準設計)。
>   pre-auth フロー (login / lock-status / password-reset / email-verification) は全て **tenantSlug 必須**。
>   tenantSlug 不存在 / user 不存在は **同一の汎用エラー**を返す (= enumeration 攻撃防止)。
>   詳細: [docs/adr/0016-multi-tenant-user-membership.md](../adr/0016-multi-tenant-user-membership.md)

#### 9.4.2 パスワードポリシー

| ルール | 要件 |
|---|---|
| 最小文字数 | 10 文字以上 |
| 文字種要件 | 英大文字・英小文字・数字・記号のうち 3 種以上 |
| 最大文字数 | 128 文字（bcrypt の 72 バイト制限を考慮し超過分は事前ハッシュ） |
| 禁止パターン | メールアドレスと同一、連続同一文字 4 文字以上 |
| 履歴チェック | 直近 5 回のパスワードの再利用を禁止 |
| 有効期限 | MVP では未実装（将来的に 90 日を検討） |

#### 9.4.3 アカウントロックポリシー

本プロダクトは **2 系統** のロックを持つ (PR #116 以降):

##### パスワードロック (従来)

| 項目 | 値 |
|---|---|
| ロック条件 | 10 分以内に **5 回** のログイン失敗 |
| ロック期間 | 30 分間の一時ロック |
| 恒久ロック | 一時ロック **3 回** で管理者解除が必要な恒久ロック |
| ロック解除 | 時間経過 (一時のみ) / システム管理者が手動解除 |

##### MFA ロック (PR #116 新設)

| 項目 | 値 |
|---|---|
| ロック条件 | **3 回** 連続の MFA TOTP 失敗 (パスワードより厳しめ) |
| ロック期間 | 30 分間の一時ロック |
| 恒久ロック | **設けない** (recovery code で自己解除可能なため) |
| ロック解除 | 時間経過 / **recovery code 入力** / システム管理者が手動解除 |
| HTTP 応答 | `/api/auth/mfa/verify` が **429** + `{code: 'MFA_LOCKED', lockedUntil: ISO8601}` を返す |

データモデル (users テーブル):

| 系統 | 列名 |
|---|---|
| パスワードロック | `failed_login_count INTEGER DEFAULT 0` / `locked_until TIMESTAMPTZ NULL` / `permanent_lock BOOLEAN DEFAULT false` |
| MFA ロック (PR #116) | `mfa_failed_count INTEGER DEFAULT 0` / `mfa_locked_until TIMESTAMPTZ NULL` |

**分離する設計判断**:
- ロック原因 (パスワード / MFA) を admin 画面で個別に可視化
- recovery code による解除対象を **MFA ロックのみ** に限定 (パスワード側で間違えた人が recovery code で解除する矛盾を防ぐ)

**admin 画面の表示 (PR #116)**:
- `/admin/users` の「認証ロック」列 1 つに両系統の情報を集約
- Badge のラベルで原因を区別 (例: `一時ロック (パスワード)` / `一時ロック (MFA)` / `PW 失敗 3/5` / `MFA 失敗 2/3`)
- tooltip で解除予定 / 解除手段 / 失敗回数の詳細を表示 (A 案)

**手動解除 (admin)**:
- `/api/admin/users/[userId]/unlock` は **パスワードロックと MFA ロックを同時に** リセット
- 「admin の介入時点でクリーンなアカウント状態に戻す」方針

#### 9.4.4 セッション管理

| 項目 | 値 | 理由 |
|---|---|---|
| 保存先 | JWT (NextAuth JWT 戦略) + セッション cookie (tab 閉じで失効) | サーバ側状態を持たずスケール容易、cookie 側で tab 閉じ時失効も担保 |
| 最大有効期限 (無操作上限) | **9 時間** (PR #124 で 24h→9h 短縮) | 日本の通常就業時間 (8h + 休憩 1h) を超えて無操作なら強制ログアウト。NextAuth JWT 戦略は各リクエストで token を再署名する sliding 挙動のため「最後の操作から 9 時間」として機能 |
| セッションローテーション | 認証成功時に再生成 | セッション固定攻撃の防止 |
| 同時セッション | 制限なし（初期）。本格運用時に最大 3 デバイスに制限検討 | 初期は実装コストを削減 |
| Cookie 属性 | HttpOnly, Secure, SameSite=Lax, Path=/ | 盗聴・XSS・CSRF の緩和 |
| 個別ユーザの即時失効 | **`users.tokenVersion` を increment** し、各リクエスト入口の `getAuthenticatedUser` で JWT claim と DB 最新値を照合 (`auth.config.ts:207-210` で JWT に格納、`:268-270` で session に伝播)。admin が increment した瞬間に既存 JWT は全て 401 になる (強制ログアウト)。ログアウトも cookie 削除に依存せず tokenVersion increment + layout DB 照合で実質失効させる (`/api/auth/explicit-signout`、KDD §5.X+72) | 権限昇格/失効の即時反映。Netlify で Set-Cookie が脱落しても DB 側で確実に無効化 |
| 他の端末からログアウト (本人操作) | **`POST /api/auth/logout-other-devices`** (feat/logout-other-devices 2026-06-03)。`tokenVersion` を increment して全端末の JWT を失効させた上で、**呼出端末のみ**新 tokenVersion で JWT を再署名 (`auth-jwt-helper`) し現在端末はログイン維持。他端末は次回リクエストで 401。設定画面 `/settings` の「他の端末からログアウト」ボタンから本人が実行 (認可=本人のみ、`authEventLog.eventType='logout_other_devices'` 記録)。再署名失敗時は現在端末も失効する安全側設計 | 端末紛失/共用 PC 置き忘れ時の自己防衛。通常ログアウトと違い現在端末は継続利用可 |
| 無効化ユーザの遮断 | isActive フラグを DB 照合で即時反映 | 退職者/無効化アカウントの継続アクセス防止 |

##### 9.4.4.1 セッション中の JWT claim 更新 — 再署名方式 (NextAuth `update()` 不使用)

セッション継続中に JWT claim を更新する必要がある操作 (MFA 検証成功 / タイムゾーン・ロケール変更) では、クライアント側の `useSession().update()` を **使わず**、API route handler が `src/lib/auth-jwt-helper.ts#reissueAuthJwtOnResponse` で **JWT を直接再署名して Set-Cookie する** 方式を採用する。

**背景 (Netlify Set-Cookie 脱落の罠)**: NextAuth v5 0-beta.31 + `@netlify/plugin-nextjs` では `POST /api/auth/session` (= `update()` の内部経路) の Set-Cookie レスポンスがブラウザに反映されない事象を確認 (MFA 検証ループに陥る、KDD §5.X+66)。middleware / SSR / client `useSession` の全経路で透過的に新値を読ませるには、cookie 分離より JWT 自体の更新が副作用が少ない。

**設計上の要点**:

| 項目 | 内容 |
|---|---|
| 更新可能 claim | `mfaVerified` / `timezone` / `locale` のみ (`JwtReissuePatch` 型ガード)。`tenantId` / `id` 等の改竄不可項目は patch を受け付けない |
| cookie 名の解決 | `NODE_ENV` ではなく **request の cookies から実在名を auto-detect** (`__Secure-authjs.session-token` / `authjs.session-token`)。Netlify Functions runtime の NODE_ENV 差で salt mismatch → decode 失敗する罠 (PR #398) の対策。検出名を decode/encode の salt と Set-Cookie name の双方に一貫使用 |
| cookie 属性 | `httpOnly:true` / `sameSite:'strict'` (CWE-1275 対策) / `secure` は `__Secure-` prefix 付きの時のみ true。`auth.config.ts` の `cookies.sessionToken.options` と整合 |
| 失敗時の扱い | theme cookie のような silent fallback は **しない**。MFA/TZ/Locale は middleware/SSR が JWT を直接読むため、更新失敗の黙殺は「クライアントは成功と認識・実態は旧 JWT」の致命ループを生む (PR #396 後本番で実観測)。`{ok:false, reason}` を返し、呼出側は必ず check して失敗時 5xx で通知する |
| middleware 除外 | 上記ルート (`api/auth/mfa/verify` / `api/tenants/me/i18n` / `api/auth/explicit-signout`) は matcher 除外済 (§8.1.1)。middleware の auth() wrapper による auto-refresh が旧 JWT 値で Set-Cookie を上書きし、再署名/削除を打ち消す事象の対策 |

詳細: `src/lib/auth-jwt-helper.ts` / KDD §5.X+66・+68。MFA 検証フローでの適用は §9.17.3 を参照。

#### 9.4.5 認証イベントログ

| 記録対象 | 記録内容 |
|---|---|
| ログイン成功 | user_id, IP, User-Agent, タイムスタンプ |
| ログイン失敗 | email（存在有無は記録しない）, IP, User-Agent, 失敗理由 |
| ログアウト | user_id, セッション ID |
| アカウントロック | user_id, ロック種別（一時/恒久）, トリガー |
| パスワード変更 | user_id, 変更者（自身 or 管理者） |

テーブル追加: `auth_event_logs`

| カラム名 | 型 | NULL | 説明 |
|---|---|---|---|
| id | UUID | NO | 主キー |
| event_type | VARCHAR(30) | NO | login_success / login_failure / logout / lock / password_change |
| user_id | UUID | YES | FK: users.id |
| email | VARCHAR(255) | YES | login_failure 時（user_id が不明な場合） |
| ip_address | VARCHAR(45) | YES | 操作元 IP |
| user_agent | TEXT | YES | ブラウザ情報 |
| detail | JSONB | YES | 追加情報（失敗理由等） |
| created_at | TIMESTAMPTZ | NO | イベント日時 |

インデックス:
- `idx_auth_events_user` (user_id, created_at DESC)
- `idx_auth_events_type` (event_type, created_at DESC)

### 9.5 認可設計（堅牢化）

#### 9.5.1 認可チェックの多層構造

```
リクエスト到達
  |
  v
[Layer 1] Middleware: 認証チェック
  - セッション有効性
  - ユーザ is_active = true
  - アカウントロック状態
  |
  v
[Layer 2] Route Handler: 入力バリデーション
  - Zod スキーマによる型・形式検証
  - パスパラメータ（:projectId 等）の UUID 形式検証
  |
  v
[Layer 3] Service Layer: 認可チェック（ここが主戦場）
  - プロジェクトメンバーシップ検証（IDOR 防止）
  - ロールチェック（system_role + project_role）
  - プロジェクト状態チェック
  - リソース所有者チェック（自分の担当タスクか等）
  - 判定式: 操作可 = メンバーである AND ロール可 AND 状態可 AND 所有者条件可
  |
  v
[Layer 4] Data Access: テナント分離
  - service 層が where に tenantId / 論理削除条件を **明示記述**（Prisma Middleware/$use は不使用）
  - 各 service 関数が viewerTenantId を必須引数で受け where.tenantId を強制（§9.5.3）
```

> **注意**: 旧版に記載のあった「全クエリに project_id を自動付与する Prisma Middleware (`$use`)」は **実在しない**。
> `src/lib/db.ts` は PrismaClient を pg adapter で生成するだけで `$use` フックを持たない (全 21 行)。
> テナント分離・論理削除フィルタは service 層が where 句に明示記述する方式である (§9.5.3 / ARCHITECTURE §3.3)。

#### 9.5.2 IDOR（Insecure Direct Object Reference）防止パターン

全てのリソース取得・更新で、パスパラメータの ID だけでなく、呼び出し元ユーザのメンバーシップを必ず検証する。

```typescript
// NG: IDOR 脆弱性あり - ID だけで取得
async function getTask(taskId: string) {
  return prisma.task.findUnique({ where: { id: taskId } });
}

// OK: IDOR 防止 - メンバーシップ検証を含む
async function getTask(taskId: string, userId: string) {
  const task = await prisma.task.findUnique({
    where: { id: taskId, deletedAt: null },
    include: { project: { include: { members: true } } },
  });
  if (!task) throw new NotFoundError();

  const isMember = task.project.members.some(m => m.userId === userId);
  if (!isMember) throw new ForbiddenError();

  return task;
}
```

#### 9.5.3 service 層によるテナント分離 (実装の実態)

> **重要な訂正**: 旧版は「`lib/db.ts` の `prisma.$use(...)` が全クエリに tenantId / 論理削除フィルタを
> 自動付与する」と記載していたが、**この `$use` コードは実在しない**。`src/lib/db.ts` は PrismaClient を
> pg adapter で生成するだけ (全 21 行、`$use` フックなし)。実装はすべて service 層での明示記述である。

##### テナント分離の実装方式

各 service 関数は **`viewerTenantId` (またはセッションの `tenantId`) を必須引数で受け取り**、Prisma クエリの
`where` 句に `tenantId` フィルタを必ず含める。専用ヘルパは `src/lib/permissions/tenant.ts`:

```typescript
// src/lib/permissions/tenant.ts
// クエリレベルで where に展開してテナント境界を強制する
export function tenantScope(tenantId: string): { tenantId: string } {
  return { tenantId };
}

// 取得結果に対する二重防御 (DEFAULT 設定漏れの保険)。不一致なら TenantBoundaryError → 403
export function requireSameTenant(userTenantId: string, entity: TenantOwned | null | undefined): void {
  if (entity == null) return;
  if (userTenantId !== entity.tenantId) throw new TenantBoundaryError(userTenantId, entity.tenantId);
}
```

```typescript
// service 層での典型パターン (クエリ + 結果の二重防御)
const projects = await prisma.project.findMany({
  where: { ...tenantScope(viewerTenantId), deletedAt: null, status: 'in_progress' },
});
requireAllSameTenant(viewerTenantId, projects);
```

書き込み (`create`) でも `data` に `tenantId` を明示記述する。tenant_id カラムは DB DEFAULT を撤去済 (ADR-0024)
のため、明示し忘れると Prisma が NOT NULL 違反でエラー化する三層防御 (§26.2 参照)。論理削除フィルタ (`deletedAt: null`)
も同様に各 service が where に明示する (自動付与する仕組みはない)。

##### DB の RLS は実効的に無効 — service 層が唯一の防御線

実 DB (Supabase introspection / 2026-05-31) の事実:

- **大半のテーブルは RLS が enabled だが、Policy が 0 件**。RLS は有効でもポリシーが無いテーブルへは
  特権ロール (Prisma が接続する DB ロール) が **そのまま素通り** するため、**実効的に RLS は無効**。
- 一部テーブルは **RLS 自体が OFF**: `billing_history`, `cron_execution_logs`, `faq_embeddings`,
  `guide_embeddings`, `stripe_usage_record_queue`, `stripe_webhook_events`, `tenant_consent_logs`。
- forced=false のため、Prisma の接続ロールは RLS を考慮せずクエリを実行する。

**結論**: **テナント分離の唯一の防御線はアプリケーション (service) 層の `where.tenantId` 強制である**。
DB レイヤ (RLS) は本サービスではテナント分離の防御として機能していないため、service 層のフィルタ漏れが
そのままテナント越境 (severity-1 個人情報漏洩) に直結する。新規 service 関数追加時は必ず `viewerTenantId`
を引数に取り `where.tenantId` を強制すること (§26 / ADR-0024 / ADR-0005)。

> 例外: Supabase **Storage** の `storage.objects` には RLS Policy 5 件が適用されており (§9.8.6)、
> ファイル添付のストレージ層に限り DB レベルのテナント prefix 強制が二重防御として機能する。
> これは PostgreSQL の業務テーブル群とは別管理である。

### 9.6 入力バリデーション・サニタイゼーション

#### 9.6.1 バリデーション方針

| 層 | 責務 | 実装 |
|---|---|---|
| フロントエンド | UX 向上のための即時フィードバック | React Hook Form + Zod ※**React Hook Form 未導入 (採用予定)**。現状は Server Actions 経由で Route Handler/Server Action 側 Zod 検証のみ |
| Route Handler | サーバサイドの型・形式検証（信頼の起点） | Zod（フロントと同一スキーマ） |
| Service Layer | ビジネスルール検証 | 手続き的チェック |
| DB | 制約による最終防衛線 | NOT NULL, CHECK, UNIQUE |

**原則**: フロントエンドのバリデーションは UX 目的であり、セキュリティ上は信頼しない。サーバサイドが信頼の起点。

#### 9.6.2 サニタイゼーション

| 対象 | 処理 | 実装 |
|---|---|---|
| HTML タグ | React の自動エスケープに依拠。生 HTML の直接挿入は使用禁止 | React |
| URL | プロトコルを https / http に制限。javascript: スキーム等を拒否 | Zod カスタムバリデータ |
| 検索クエリ | PostgreSQL 全文検索のクエリ構文をエスケープ | Service Layer |
| ファイル名（将来） | パストラバーサル防止。`..` やパス区切り文字を除去 | Zod + Service Layer |

#### 9.6.3 リクエストサイズ制限

| 対象 | 制限値 |
|---|---|
| リクエストボディ | 1 MB |
| URL パラメータ長 | 2,048 文字 |
| 検索クエリ文字列 | 200 文字 |
| 一覧取得の limit | 最大 100 件 |
| JSONB 配列（タグ等） | 最大 50 要素 |

### 9.7 レート制限

#### 9.7.1 エンドポイント別レート制限

| エンドポイントカテゴリ | 制限 | ウィンドウ | 理由 / 実装 |
|---|---|---|---|
| **POST /api/auth/callback/credentials** (login, per-IP) | **20 回** | **5 分** | credential stuffing 対策の IP 単位制限 (`src/middleware.ts:86-95`)。`DISABLE_LOGIN_RATE_LIMIT='true'` で E2E バイパス可。被害者単位のアカウントロック (§9.4.3: 10 分以内 5 回失敗) と組み合わせた多層防御 |
| 公開認証系エンドポイント (per-IP)<br>`reset-password` / `setup-password` / `lock-status` 等 | **10 回** | **5 分** | `src/lib/rate-limit.ts#applyRateLimit` の保守的デフォルト (CWE-307 対策)。各 route 先頭で `applyRateLimit(req, { key })` を呼ぶ |
| **POST /api/attachments/upload** (per-tenant) | **10 回** | **1 分** | ADR-0021 §10.2.1: Pre-signed URL 発行レート |
| **DELETE /api/attachments/:id** (per-tenant) | **100 回** | **1 分** | ADR-0021 §10.2.1: Supabase API rate limit + ロック保護 |
| POST /api/** (書き込み系) | 30 回 | 1 分 | スパム防止 (将来方針。汎用 write には未一括適用) |
| GET /api/** (読み取り系) | 120 回 | 1 分 | 通常利用の範囲 (将来方針) |
| GET /api/**/export | 5 回 | 10 分 | CSV エクスポート等の重い処理 (将来方針) |

> **注意**: 旧版の「POST /api/auth/signin = 5 回/10 分」は **レート制限ではなくアカウントロック条件** (§9.4.3) であり、
> 表記を実装に合わせて訂正した。in-memory (Map ベース) の sliding window 実装であり、Netlify Functions の
> instance 分散により完全な分散制限ではない (= 攻撃コストを上げる多層防御の 1 層)。Upstash Redis 等への
> 切替は将来候補 (§9.7.2)。

#### 9.7.2 実装方針

初期フェーズ（5〜10名）でも、login (`/api/auth/callback/credentials`) と公開認証系エンドポイントには
in-memory レート制限を実装済 (上表)。汎用の書き込み/読み取り系 API への一括レート制限は将来方針。
アカウントロックポリシー（§9.4.3: 10 分以内 5 回失敗）と組み合わせて実質的なブルートフォース防止を実現する。

本格運用時は in-memory（Map ベース）の sliding window 方式で実装する。Redis は無料枠に含まれないため、初期フェーズでは導入しない。

### 9.8 機密情報の取り扱い

#### 9.8.1 保存・保護

| 情報 | 保存場所 | 保護方法 |
|---|---|---|
| パスワード | DB (users.password_hash) | bcrypt (cost 12)。平文保存・ログ出力禁止 |
| パスワード履歴 | DB (password_histories) | bcrypt ハッシュで保存。比較のみに使用 |
| セッション (JWT) | HttpOnly セッション cookie | JWT 戦略 (§9.4.1)。サーバ側ストア無し、cookie は HttpOnly で JS からアクセス不可。失効は tokenVersion + DB 照合 (§9.4.4) |
| DB 接続文字列 | 環境変数 (DATABASE_URL) | .env, .gitignore 除外。本番は Secrets Manager |
| NextAuth Secret | 環境変数 (NEXTAUTH_SECRET) | 32 文字以上のランダム文字列。本番は Secrets Manager |

#### 9.8.2 レスポンスからの機密情報除外

API レスポンスに含めてはならないフィールドを DTO 変換で除外する。

```typescript
// types/dto.ts - ユーザ DTO（password_hash を除外）
type UserDTO = {
  id: string;
  name: string;
  email: string;
  systemRole: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

// services/user.service.ts
function toUserDTO(user: User): UserDTO {
  const { passwordHash, deletedAt, ...dto } = user;
  return dto;
}
```

#### 9.8.3 ログ出力のマスキング

| マスキング対象 | 処理 |
|---|---|
| パスワード | ログに一切出力しない |
| メールアドレス | 部分マスク形式で出力 |
| セッション ID | 先頭 8 文字のみ表示 |
| リクエストボディ | password フィールドを [REDACTED] に置換 |

### 9.8.4 エラー情報の機密化方針 (2026-04-24 / PR #115)

#### 原則

**「機密情報を含み得るエラー詳細 (スタック、設定値、SQL 構造、環境変数値) は
Console にも画面にも出さず、必ず DB (system_error_logs) に保存する。
ユーザには固定文言『内部エラーが発生しました』のみを表示する。」**

本プロダクトで扱うエラーは以下 2 種類に大別される:

| 種別 | 発生源 | 記録経路 | ユーザに見せるもの |
|---|---|---|---|
| サーバ側内部エラー | API route の未捕捉例外 / cron バッチ / メールプロバイダ失敗 | `recordError` / `withErrorHandler` 経由で `system_error_logs` | HTTP 500 + 固定文言 |
| クライアント側エラー | React render error / unhandled Promise rejection | `global-error.tsx` / `error.tsx` → POST `/api/client-errors` → `system_error_logs` | エラーバウンダリ UI (固定文言) |
| ビジネスエラー (想定内) | 403 / 404 / 409 / validation 400 等 | 通常の NextResponse で返却 | エラーコード + 業務上のわかりやすい文言 |

#### 実装コンポーネント

- **`src/services/error-log.service.ts`** — `recordError(input)` / `logUnknownError(source, error, extras?)`。DB 書込失敗は silent (再帰ログ防止)
- **`src/lib/api-error-handler.ts#withErrorHandler`** — API route を wrap。throw された時点で DB 記録 + 固定 500 応答
- **`src/app/global-error.tsx`** — root layout レベルのエラーバウンダリ
- **`src/app/(dashboard)/error.tsx`** — dashboard セグメントのエラーバウンダリ
- **`src/app/api/client-errors/route.ts`** — クライアントエラー受信エンドポイント
- **`system_error_logs` テーブル** (`prisma/migrations/20260424_system_error_logs`) — severity / source / message / stack / userId / requestId / context (JSONB) / createdAt

#### 強制機構

- **eslint `no-console` rule** (`eslint.config.mjs`): src/ 配下 (テスト除く) で `console.*` を **error** として扱う。recordError 経由のみ許可。
- **SystemErrorLog の FK は ON DELETE SET NULL** (`userId`): ユーザ削除時もログは残り続ける (監査証跡)

#### 運用

- Supabase SQL Editor で migration 適用:
  ```sql
  -- prisma/migrations/20260424_system_error_logs/migration.sql の内容を実行
  CREATE TABLE system_error_logs (...);
  CREATE INDEX idx_system_errors_severity ON system_error_logs (...);
  -- 他 3 index
  ```
- 運用時は `SELECT * FROM system_error_logs WHERE severity IN ('error','fatal') ORDER BY created_at DESC LIMIT 100;` 等で異常を監視
- **長期的ロードマップ**: システムエラーログ量がある水準を超えたら外部監視 (Sentry 等) を検討。MVP 段階では DB 内蓄積で十分

---

### 9.8.5 セキュリティ監査 (2026-04-24 / PR #114)

ブラウザ開発者ツールの Network / Console タブから機密情報・クレデンシャル情報が漏洩しないことを確認するため、
全 API ルート / service / config / DTO を網羅監査した。以下に検出事項とミティゲーションを記録する。

> **下表は監査時点 (2026-04-24) の履歴記録**。H-1 の `/api/cron/cleanup-accounts` は **PR #115 で endpoint 自体を削除済**
> (現在ソースに存在しない)。cron 運用は現在 cron-job.org のダッシュボード管理 (ADR-0023)。当時の検出と是正の経緯として残す。

| 重大度 | ID | 箇所 | 問題 | 対策 |
|---|---|---|---|---|
| High | H-1 | `/api/cron/cleanup-accounts` | `CRON_SECRET` 未設定時に短絡評価で認証バイパス → 外部から匿名 POST で全ユーザ論理削除・匿名化実行可能 | PR #114: `if (!cronSecret \|\| authHeader !== ...)` に改修して常に 401 → **PR #115: エンドポイント自体を削除** (当時の vercel.json の cron 登録は `/api/admin/users/cleanup-inactive` のみでデッドコードと判明、現在は cron-job.org の dashboard 管理 ADR-0023)。多層防御が結果として完成 |
| High | H-2 | `/api/projects/[id]/tasks/import` | 500 エラー body に Prisma `e.message` を含め返し、スキーマ/制約名/衝突値が Network タブで漏洩 | 固定文言のみ返却、詳細は `console.error` のみ |
| Medium | M-1 | `next.config.ts` | `X-Powered-By: Next.js` ヘッダ送出 (既知脆弱性絞り込みに悪用可) | `poweredByHeader: false` 明示 |
| Medium | M-2 | `/api/knowledge` POST | 非メンバーが `projectIds` 指定で他プロジェクトにナレッジを注入可能 (PR #113 新権限方針と不整合) | projectIds 各項に対し `prisma.projectMember.findFirst` で確認、1 つでも非メンバーなら 403 |
| Low | L-2 | `/api/auth/mfa/setup` | 有効化済ユーザも何度でも POST できシークレット平文が再取得可 | `generateMfaSecret` 冒頭で `mfaEnabled=true` なら `ALREADY_ENABLED` を throw、route は 409 |
| Low | L-3 | `/api/projects/[id]/retrospectives/[retroId]/comments` | docstring は `retrospective:comment` 指定、実装は `project:read` で viewer も書ける | `requireActualProjectMember` + `projectRole !== 'viewer'` で書き込み制限 |

#### 問題なし確認済項目 (監査対象として明示的にチェックし安全性を確認)

- **User DTO** (`toUserDTO`): `passwordHash` / `mfaSecretEncrypted` / `mfaEnabled` / 生成トークンは含まない
- **NextAuth session callback**: `id/systemRole/forcePasswordChange/mfaEnabled/mfaVerified/themePreference` のみコピー、JWT 自体はレスポンス body に出さず HttpOnly Cookie 経由
- **MFA verify**: レスポンスは `{success:true}` のみ
- **Recovery codes**: 初回平文返却のみ、以降は bcrypt ハッシュ。参照 GET エンドポイントなし
- **`sanitizeForAudit`**: `passwordHash` / `mfaSecretEncrypted` を `[REDACTED]` 置換
- **`NEXT_PUBLIC_*` の機密漏洩**: ソース内実参照ゼロ (Grep 全域確認済)
- **Client component (`'use client'`) 内 `process.env` 参照**: ゼロ (server-only 境界維持)
- **IDOR**: 他人の private memo / draft は `findFirst` 後 visibility / createdBy で fold、404 相当で秘匿 (403 と区別しないことで存在有無も漏らさない)

#### 継続観察項目 (今回は修正見送り、次回以降のレビューで優先)

- **`mfaSecretEncrypted` の暗号鍵**: `NEXTAUTH_SECRET` の先頭 32 bytes 流用 (JWT 署名鍵と同一系統)。
  単一鍵漏洩で MFA シークレットも復号される設計上の tight coupling。
  MVP 後に `MFA_ENCRYPTION_KEY` を独立 env 化 + KMS 管理へ移行予定 (ロードマップ Phase 2)
- **`/api/admin/audit-logs` / `role-change-logs`**: admin にのみ他ユーザの email を返却。
  要件によっては部分マスクに変更。運用ルールを OPERATION.md で明記
- **振り返りコメント本文**: 非メンバーでも `visibility='public'` なら閲覧可。
  組織判断で「業務詳細を含むので members のみ」にするか、`visibility` を 3 値化する余地あり
- **SSRF via Attachment URL**: URL 型添付の preview 機能があれば `169.254.169.254` 等内部アドレスに
  アクセス可能になる可能性。現状 preview は未実装だが、将来実装時は URL 安全性検証が必要

#### 9.8.6 ファイル添付ストレージのセキュリティ (ADR-0021 / 2026-05-26)

ファイル本体を Supabase Storage に保存する設計に伴い、以下の多層防御を実装:

| 攻撃ベクトル | リスク | 対策 |
|---|---|---|
| **大容量ファイル DoS** | サーバ memory/disk 圧迫、Function timeout | (1) Pre-signed URL 直接アップロード (= サーバ通さない) / (2) 50MB/ファイル サーバ側検証 (`FILE_STORAGE_MAX_FILE_SIZE_BYTES`) |
| **大量ファイルアップロード DoS** | 単発の巨大ファイルで Function timeout / memory 圧迫 | (1) 1 ファイル 50MB 上限 (`FILE_STORAGE_MAX_FILE_SIZE_BYTES`、upload/finalize route で検証) / (2) Pre-signed URL 発行レート制限 (10 req/min/tenant)。**累積 50GB ハードキャップは撤廃済 (ADR-0030「データはたすきばの命」)**: ファイルは Supabase Storage (オブジェクトストレージ) で Postgres RAM 非依存のため noisy-neighbor 無関係。L1/L2/L3 (1GB/10GB/50GB) は super_admin への監視アラート閾値であり、アップロードは止めない |
| **悪意ある実行ファイル** | サーバ・他ユーザへのマルウェア配布 | 危険拡張子 blacklist (.exe / .bat / .sh / .cmd / .scr / .com / .ps1 / .vbs / .apk / .ipa / .rar / .zipx) で拒否、upload + finalize の **2 段階チェック** (defense-in-depth) |
| **path traversal** | バケット越境、他テナントオブジェクト読取 | ファイル名 sanitize (`sanitizeFileName`: OS 禁止文字 + `..` + 先頭ドット除去 + 200 文字制限) + bucket path に tenant prefix 強制 (`tenants/{tenantId}/{entityType}/{entityId}/{uuid}-{name}`) |
| **Storage 計測失敗** | drift で課金漏れ + 暴走検知不能 | drift 検知 daily cron (50%/100% で warning/critical alert)、anomaly 検知 (+5GB/day で super_admin 通知) |
| **embedding job 暴走** | Voyage rate limit 抵触、200M 無料枠食い潰し | per-tenant job 並列上限 (5 件) + global 並列上限 (50 件) + 月次 token 消費 watchdog |
| **Pre-signed URL 漏洩** | 第三者が tenant データ書込 / 越境 | URL 有効期限 **60 秒** + tenant_id 検証 + ファイル名予約 (UUID 含む) |
| **delete API 連打** | Supabase API rate limit、storage_objects ロック | per-tenant rate limit (100/min) |

#### RLS Policy (= 2 重防御の DB レイヤ)

`storage.objects` に以下 5 件の Policy を適用 (= docs/operations/setup/SUPABASE_STORAGE_SETUP.md §3):
1. `service_role_full_access_attachments`: service_role は全アクセス可 (cron / 集計 / Pre-signed URL 発行用)
2. `deny_direct_select_attachments`: anon / authenticated の直接 SELECT 禁止 (Pre-signed URL 強制)
3. `deny_direct_insert_attachments`: anon / authenticated の直接 INSERT 禁止
4. `deny_direct_update_attachments` / `deny_direct_delete_attachments`: 同上
5. `enforce_tenant_prefix_attachments`: service_role でも `tenants/` prefix が無い path への INSERT を block (= アプリ層のバグで prefix が抜けても DB で拒否)

これにより仮に Pre-signed URL や anon_key が漏洩しても、**テナント越境はデータベースレベルで拒否** される多層防御。

#### 容量 Level 到達時の挙動 (2026-05-31 改定 / ADR-0030)

**累積 50GB ハードキャップ (アップロード拒否) は撤廃済**。「データはたすきばの命」原則 (ADR-0030) に基づき、累積容量による write block は廃止し、L1/L2/L3 は **super_admin への監視アラート閾値** に役割変更した。50GB 到達テナントの状態:
- 新規 Pre-signed URL 発行 → **継続可** (アップロードは止めない)。L3 (50GB) 到達で super_admin に監視アラート (Supabase Compute 増強検討の合図)
- 既存ファイルの read / download → 継続可
- 既存ファイルの delete → 継続可 (= 削減手段の提供)
- 他テナント → 完全に独立して動作
- 1 ファイル 50MB 上限 (`FILE_STORAGE_MAX_FILE_SIZE_BYTES`) は瞬間負荷ガードとして存続
- 例外: **Beginner プランのみ** 無料枠 (Storage 100MB) 超過でアップロード拒否 (`BeginnerWriteGuardExceededError`、§9.8 末尾 / ADR-0025)

> 撤去済の識別子 (ADR-0030): `FileStorageLimitExceededError` / `STORAGE_FILE_HARD_CAP_EXCEEDED` / `mapFileStorageGuardErrorToResponse`。DB 側も同様に `StorageLimitExceededError` / `StorageGuardCircuitOpenError` / `STORAGE_LIMIT_EXCEEDED` / `mapStorageGuardErrorToResponse` を撤去。circuit-breaker (計測失敗時の fail-close write 拒否) は **fail-open** 化 (計測失敗でも write 継続、日次 cron `updateAllStorageBytesUsed` が補正)。

---

### 9.9 CORS ポリシー

**原則**: ワイルドカード（`*`）は使用禁止。`NEXTAUTH_URL` に設定されたオリジンのみ許可する。

| ヘッダ | 値 |
|---|---|
| Access-Control-Allow-Origin | NEXTAUTH_URL（自ドメインのみ） |
| Access-Control-Allow-Methods | GET, POST, PATCH, DELETE, OPTIONS |
| Access-Control-Allow-Headers | Content-Type, Authorization |
| Access-Control-Allow-Credentials | true |
| Access-Control-Max-Age | 86400 |

### 9.10 セキュリティヘッダ

| ヘッダ | 値 | 目的 |
|---|---|---|
| X-Content-Type-Options | nosniff | MIME スニッフィング防止 |
| X-Frame-Options | DENY | クリックジャッキング防止 |
| X-XSS-Protection | 1; mode=block | XSS フィルタ（レガシーブラウザ向け） |
| Referrer-Policy | strict-origin-when-cross-origin | リファラ制御 |
| Content-Security-Policy | default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' | CSP |
| Strict-Transport-Security | max-age=63072000; includeSubDomains; preload | HTTPS 強制 |
| X-DNS-Prefetch-Control | off | DNS プリフェッチ制御 |
| X-Download-Options | noopen | ダウンロード時の自動実行防止 |
| X-Permitted-Cross-Domain-Policies | none | クロスドメインポリシー |
| Permissions-Policy | camera=(), microphone=(), geolocation=() | ブラウザ機能制限 |

### 9.11 エラーハンドリングとセキュリティ

#### 9.11.1 環境別エラーレスポンス

| 環境 | エラー詳細 | スタックトレース | 内部エラーコード |
|---|---|---|---|
| development | フィールド単位の詳細 | 表示 | 表示 |
| production | 汎用メッセージのみ | 非表示 | 非表示 |

#### 9.11.2 認証エラーの情報漏洩防止

ログイン失敗時、ユーザの存在有無を漏洩させない。

- NG: 「このメールアドレスは登録されていません」
- NG: 「パスワードが間違っています」
- OK: 「メールアドレスまたはパスワードが正しくありません」

#### 9.11.3 エラーコード一覧（拡充）

| コード | HTTP | 説明 | 本番でのメッセージ |
|---|---|---|---|
| VALIDATION_ERROR | 400 | 入力バリデーション失敗 | 入力内容に誤りがあります |
| UNAUTHORIZED | 401 | 未認証 | ログインが必要です |
| FORBIDDEN | 403 | 権限不足 | この操作を実行する権限がありません |
| NOT_FOUND | 404 | リソース不存在 | 対象が見つかりません |
| STATE_CONFLICT | 409 | 状態遷移条件未充足 | 現在の状態では実行できません |
| ACCOUNT_LOCKED | 423 | アカウントロック中 | アカウントがロックされています |
| RATE_LIMITED | 429 | レート制限超過 | リクエストが多すぎます。しばらく待ってください |
| INTERNAL_ERROR | 500 | サーバ内部エラー | システムエラーが発生しました |

### 9.12 データ保護

#### 9.12.1 通信の暗号化

| 区間 | 暗号化方式 |
|---|---|
| ブラウザ - サーバ間 | TLS 1.2 以上（HSTS による強制） |
| サーバ - DB 間 | SSL 接続（sslmode=require を DATABASE_URL に付与） |

#### 9.12.2 保存データの保護

| 対象 | 保護方式 |
|---|---|
| パスワード | bcrypt ハッシュ化（不可逆） |
| DB データ全体 | PostgreSQL のディスク暗号化（クラウド提供機能を利用） |
| バックアップ | 暗号化バックアップ（クラウド提供機能を利用） |

#### 9.12.3 論理削除とデータ保持

| 項目 | 方針 |
|---|---|
| 削除方式 | 全テーブル論理削除（deleted_at カラム） |
| 物理削除 | 論理削除から 1 年経過後にバッチ処理で物理削除 |
| 監査ログ (audit_logs) | 1 年保持後に物理削除（DB 無料枠維持のため） |
| 認証イベントログ (auth_event_logs) | 1 年保持後に物理削除 |
| 操作トレースログ (operation_trace_logs) | 初期フェーズでは無効。有効化時は 6 ヶ月保持後に物理削除 |

### 9.13 依存パッケージのセキュリティ

| 対策 | 実施方法 | タイミング |
|---|---|---|
| 既知脆弱性スキャン | pnpm audit | CI パイプライン毎実行 |
| ロックファイル整合性 | pnpm install --frozen-lockfile | CI でのビルド時 |
| 依存関係の自動更新 | Dependabot / Renovate | 週次で PR 自動作成 |
| SAST（静的解析） | Semgrep / CodeQL | CI パイプライン（PR 時） |
| シークレットスキャン | gitleaks | pre-commit hook + CI |

### 9.14 セキュリティテスト要件

実装時に必須とするセキュリティテストの観点。

| カテゴリ | テスト内容 | 優先度 |
|---|---|---|
| 認可境界 | 全ロール x 全操作の組み合わせで 403 が返ることを検証 | 必須 |
| IDOR | 他プロジェクトの ID でアクセスし 403/404 が返ることを検証 | 必須 |
| 認証 | ロック条件でのログイン拒否、無効ユーザのセッション拒否 | 必須 |
| 入力バリデーション | 各フィールドの境界値、不正型、超長文字列 | 必須 |
| XSS | ナレッジ・コメント等のテキストフィールドにスクリプトタグを含む入力 | 必須 |
| SQL インジェクション | 検索クエリ・フィルタに SQL 構文を含む入力 | 高 |
| レート制限 | 制限超過時の 429 レスポンスとリカバリ | 高 |
| セッション | 権限変更後のセッション無効化、有効期限切れ | 高 |
| CSRF | 外部サイトからの POST リクエストが拒否されること | 中 |
| パスワードリセット | リセットトークンの有効期限切れ・使用済みトークンの拒否 | 必須 |
| メール検証 | 未検証アカウントの全操作拒否、トークン有効期限切れ | 必須 |
| MFA | TOTP コード検証、リカバリーコードの1回限り使用、不正コードの拒否 | 必須 |
| 未使用アカウント | 30日未ログインでの論理削除、60日で物理削除の動作検証 | 高 |
| デジタルフォレンジック | 操作ログの完全性、画面遷移・操作内容の記録 | 高 |

### 9.15 アカウント登録・有効化フロー

#### 9.15.1 登録フロー全体像

```
管理者
  |
  v
[1] 登録フォーム送信（名前・メール・システムロール）
    ※ パスワードは管理者が設定しない（ユーザ自身が設定する）
  |
  v
[2] サーバ処理
  - メールアドレスの重複チェック（有効ユーザ）
  - 未有効化の同一メール既存ユーザがあれば物理削除（再登録許可）
  - ユーザレコードを作成（is_active = false, deleted_at = now(), パスワード = ランダムプレースホルダ）
  - メール検証トークンを生成（暗号論的乱数 32バイト）
  - トークンのハッシュを DB 保存（有効期限: 24時間）
  - パスワード設定URLを含む招待メールを送信
  - ★ メール送信失敗時: ユーザ・関連レコードをロールバック（物理削除）
  |
  v
[3] 管理者に画面表示
  - 「招待メールを送信しました」と案内
  - ★ メール送信失敗時: エラーメッセージを表示し、再登録を促す
  |
  v
[4] ユーザがメール内のパスワード設定リンクをクリック
  |
  v
[5] パスワード設定画面（/setup-password）
  - トークンの有効期限チェック
  - ユーザがパスワード + 確認パスワードを入力
  |
  v
[6] サーバ処理（パスワード設定 + 有効化）
  - トークン検証
  - パスワードポリシー検証 + bcrypt ハッシュ化
  - リカバリーコード（10個）を生成し、ハッシュ化して DB 保存
  - ユーザの password_hash を設定、is_active = true, deleted_at = NULL に更新
  - トークンを使用済みに更新
  |
  v
[7] リカバリーコード表示
  - リカバリーコード（平文）を1回限り表示
  - 「このコードを安全な場所に保管してください」と案内
  |
  v
[8] ログイン画面へ遷移
```

#### 9.15.2 メール検証の制約

| 項目 | 要件 |
|---|---|
| トークン生成 | crypto.randomBytes(32) による暗号論的乱数 |
| トークン保存 | SHA-256 ハッシュ化して DB 保存。平文保存禁止 |
| 有効期限 | 24 時間 |
| 使用回数 | 1 回限り |
| 再送制限 | 同一メールアドレスに対して 5 分に 1 回まで |
| 未検証アカウント | ログイン不可。全 API アクセスを拒否 |
| 自動削除 | 未検証のまま 7 日経過したアカウントは物理削除 |

#### 9.15.3 リカバリーコード

| 項目 | 要件 |
|---|---|
| 生成タイミング | アカウント登録時に 1 回のみ生成 |
| コード形式 | 8文字の英数字 x 10個（例: ABCD-1234） |
| 保存方式 | 各コードを個別に bcrypt ハッシュ化して DB 保存 |
| 表示 | 登録完了画面で 1 回のみ表示。以降は再表示不可 |
| 用途 | パスワードリセット時の本人確認（9.16 で使用） |
| 使用回数 | 各コード 1 回限り。使用後は used_at を記録し無効化 |

テーブル追加: `recovery_codes`

| カラム名 | 型 | NULL | 説明 |
|---|---|---|---|
| id | UUID | NO | 主キー |
| user_id | UUID | NO | FK: users.id |
| code_hash | VARCHAR(255) | NO | bcrypt ハッシュ化されたコード |
| used_at | TIMESTAMPTZ | YES | 使用日時（NULL = 未使用） |
| created_at | TIMESTAMPTZ | NO | 生成日時 |

テーブル追加: `email_verification_tokens`

| カラム名 | 型 | NULL | 説明 |
|---|---|---|---|
| id | UUID | NO | 主キー |
| user_id | UUID | NO | FK: users.id |
| token_hash | VARCHAR(255) | NO | SHA-256 ハッシュ化されたトークン |
| expires_at | TIMESTAMPTZ | NO | 有効期限 |
| used_at | TIMESTAMPTZ | YES | 使用日時 |
| created_at | TIMESTAMPTZ | NO | 生成日時 |

### 9.16 パスワードリセットフロー

#### 9.16.1 リセットフロー

```
ユーザ
  |
  v
[1] パスワードリセット画面
  - 登録メールアドレスを入力
  - リカバリーコード（10個のうち未使用の1つ）を入力
  |
  v
[2] サーバ処理（検証）
  - メールアドレスでユーザを検索
  - リカバリーコードを該当ユーザの未使用コードと照合（bcrypt 比較）
  - 両方一致した場合のみ、パスワードリセットトークンを発行
  - トークンのハッシュを DB 保存（有効期限: 30分）
  - 使用したリカバリーコードを used_at で無効化
  |
  v
[3] 新パスワード入力画面
  - 新パスワードを入力（パスワードポリシー適用）
  - リセットトークンをhiddenフィールドで保持
  |
  v
[4] サーバ処理（パスワード変更）
  - リセットトークンの有効期限チェック
  - トークンのハッシュ照合
  - 新パスワードを bcrypt ハッシュ化して更新
  - パスワード履歴に追加（直近5回の再利用防止）
  - 既存の全セッションを無効化
  - リセットトークンを使用済みに更新
  - 認証イベントログに記録
  - パスワード変更完了メールを送信
  |
  v
[5] ログイン画面へリダイレクト
```

#### 9.16.2 パスワードリセットの制約

| 項目 | 要件 |
|---|---|
| 本人確認方式 | メールアドレス + リカバリーコードの組み合わせ |
| リカバリーコード枯渇時 | 10個すべて使用済みの場合、システム管理者に連絡して再発行 |
| トークン生成 | crypto.randomBytes(32) |
| トークン保存 | SHA-256 ハッシュ化して DB 保存 |
| トークン有効期限 | 30 分 |
| トークン使用回数 | 1 回限り |
| リセット試行制限 | 10 分以内に 3 回失敗でメールアドレス単位で 30 分ブロック |
| 旧セッション | パスワード変更成功時に既存の全セッションを即時無効化 |
| 通知 | パスワード変更完了時にメール通知 |

#### 9.16.3 リカバリーコード再発行

| 項目 | 要件 |
|---|---|
| 再発行条件 | システム管理者のみが実行可能 |
| 再発行時の本人確認 | 管理者がユーザの身元を別の手段で確認（対面・社内連絡等） |
| 処理 | 旧コードを全て無効化 → 新コード 10 個を生成 → ユーザに 1 回のみ表示 |
| 監査記録 | 再発行の実施者・対象ユーザ・日時を auth_event_logs に記録 |

テーブル追加: `password_reset_tokens`

| カラム名 | 型 | NULL | 説明 |
|---|---|---|---|
| id | UUID | NO | 主キー |
| user_id | UUID | NO | FK: users.id |
| token_hash | VARCHAR(255) | NO | SHA-256 ハッシュ化されたトークン |
| expires_at | TIMESTAMPTZ | NO | 有効期限 |
| used_at | TIMESTAMPTZ | YES | 使用日時 |
| created_at | TIMESTAMPTZ | NO | 生成日時 |

テーブル追加: `password_histories`

| カラム名 | 型 | NULL | 説明 |
|---|---|---|---|
| id | UUID | NO | 主キー |
| user_id | UUID | NO | FK: users.id |
| password_hash | VARCHAR(255) | NO | bcrypt ハッシュ化された過去パスワード |
| created_at | TIMESTAMPTZ | NO | 設定日時 |

### 9.17 多要素認証（MFA）設計

#### 9.17.1 MFA 方式

本システムでは TOTP（Time-based One-Time Password）を採用する。

| 項目 | 要件 |
|---|---|
| 方式 | TOTP（RFC 6238） |
| コード桁数 | 6 桁 |
| 時間ステップ | 30 秒 |
| 対応アプリ | Google Authenticator / Microsoft Authenticator / Authy 等 |
| サービス運営者 (super_admin) | **MFA 必須**（初期セットアップで強制有効化、設定画面から無効化不可）。強制範囲は #11 (2026-05-09) で旧「admin」判定から **super_admin 限定** に narrowing 済 (実装: `setup-password` / `email-verification` の `requiresMfa` は super_admin のみ true) |
| テナント管理者 (admin) | **任意** (オプトイン)。MFA 未設定でも管理機能にアクセス可 (専用ゲートは無し)。設定画面の「多要素認証 (MFA)」で本人が有効化/無効化できる |
| 一般ユーザ (general) | **任意** (オプトイン)。設定画面で本人が有効化/無効化できる |

#### 9.17.2 MFA 有効化フロー

```
ユーザ（設定画面）
  |
  v
[1] MFA 有効化を開始
  - パスワード再入力で本人確認
  |
  v
[2] サーバ処理
  - TOTP シークレットキーを生成
  - シークレットキーをアプリケーション暗号化キーで暗号化して DB 保存
  - QR コード用の otpauth:// URI を生成
  |
  v
[3] QR コード表示
  - ユーザが認証アプリで QR コードをスキャン
  - 確認のため TOTP コードを 1 回入力させて検証
  |
  v
[4] 検証成功
  - mfa_enabled = true に更新
  - 認証イベントログに記録
```

#### 9.17.3 MFA 付きログインフロー

```
[1] メール + パスワード入力 → 検証成功
  |
  v
[2] MFA が有効なユーザの場合
  - この時点ではセッションを発行しない
  - 一時トークン（有効期限 5 分）を発行
  - MFA 入力画面に遷移
  |
  v
[3] TOTP コード（6桁）を入力
  - 現在の時間ステップ +/- 1 ステップを許容（時刻ずれ対策）
  - 試行回数は 5 回まで。超過でステップ1からやり直し
  |
  v
[4] 検証成功 → セッション発行 → ログイン完了

[3'] TOTP コードが手元にない場合
  - 「リカバリーコードを使用」を選択
  - リカバリーコード入力 → 照合成功 → セッション発行
  - 使用したリカバリーコードを無効化
```

> **MFA 検証成功時の JWT 更新方式** (PR #396 / 2026-05-18 改訂):
>
> 旧仕様はクライアント側の `useSession().update({ mfaVerified: true })` で JWT を更新していたが、NextAuth v5 0-beta.31 + @netlify/plugin-nextjs では `POST /api/auth/session` のレスポンス cookie がブラウザに反映されず MFA ループに陥る問題があった (KDD §5.X+66)。
>
> 現行は **`/api/auth/mfa/verify` ルート側で JWT を直接再署名 + Set-Cookie** する方式 (`src/lib/auth-jwt-helper.ts` の `reissueAuthJwtOnResponse`)。クライアント側 `update()` 呼出しは削除済。中間者にとっての改竄経路は増えていない (`reissueAuthJwtOnResponse` は許可された claim のみ patch を受け付ける = `JwtReissuePatch` 型ガード)。

#### 9.17.4 MFA 関連データモデル

users テーブルへのカラム追加:

| カラム名 | 型 | NULL | 説明 |
|---|---|---|---|
| mfa_enabled | BOOLEAN | NO (DEFAULT false) | MFA 有効フラグ |
| mfa_secret_encrypted | VARCHAR(255) | YES | 暗号化された TOTP シークレットキー |
| mfa_enabled_at | TIMESTAMPTZ | YES | MFA 有効化日時 |

### 9.18 デジタルフォレンジック設計

#### 9.18.1 設計方針

セキュリティインシデント発生時に「誰が・いつ・どの画面で・何を実施したか」を完全に追跡可能とする。
監査ログ（audit_logs）に加え、操作トレーサビリティログを専用テーブルで管理する。

#### 9.18.2 記録対象

| カテゴリ | 記録する操作 |
|---|---|
| 認証 | ログイン成功/失敗、ログアウト、パスワード変更、MFA 操作 |
| 権限 | ロール変更、メンバー追加/解除、アカウント有効化/無効化 |
| データ操作 | 作成・更新・削除（全エンティティ）の変更前後の値 |
| 画面アクセス | どのユーザがどの画面（URL）にアクセスしたか |
| エクスポート | CSV エクスポート等の一括データ取得操作 |
| 管理操作 | 管理者による全操作（通常操作と区別して記録） |

#### 9.18.3 操作トレーサビリティログ

テーブル追加: `operation_trace_logs`

| カラム名 | 型 | NULL | 説明 |
|---|---|---|---|
| id | UUID | NO | 主キー |
| user_id | UUID | NO | 操作者（FK: users.id） |
| session_id | VARCHAR(255) | NO | セッション識別子（先頭8文字のハッシュ） |
| request_id | UUID | NO | リクエスト固有ID（トレーサビリティ用） |
| http_method | VARCHAR(10) | NO | GET / POST / PATCH / DELETE |
| path | VARCHAR(500) | NO | リクエストパス |
| query_params | JSONB | YES | クエリパラメータ（機密情報はマスク済み） |
| entity_type | VARCHAR(50) | YES | 操作対象エンティティ種別 |
| entity_id | UUID | YES | 操作対象エンティティ ID |
| action | VARCHAR(50) | NO | 操作種別（view / create / update / delete / export） |
| ip_address | VARCHAR(45) | NO | 操作元 IP |
| user_agent | TEXT | YES | ブラウザ情報 |
| response_status | INTEGER | NO | HTTP レスポンスステータス |
| duration_ms | INTEGER | YES | 処理時間（ミリ秒） |
| created_at | TIMESTAMPTZ | NO | 操作日時 |

インデックス:
- `idx_trace_user` (user_id, created_at DESC)
- `idx_trace_entity` (entity_type, entity_id, created_at DESC)
- `idx_trace_request` (request_id)
- `idx_trace_date` (created_at DESC)

#### 9.18.4 段階的導入（コスト効率化）

DB ストレージの無料枠（500MB）を考慮し、ログ記録レベルを段階的に導入する。

| レベル | 記録対象 | 年間データ量 | 導入フェーズ |
|---|---|---|---|
| **Level 1（初期）** | auth_event_logs + audit_logs + role_change_logs | ~36MB | 初期フェーズから有効 |
| **Level 2** | Level 1 + 書き込み系 API の操作ログ | ~120MB | 試験運用安定後 |
| **Level 3** | Level 2 + 全リクエストの操作トレース | ~450MB | 本格運用・有料プラン移行後 |

**初期フェーズでは Level 1 のみ**で運用する。operation_trace_logs は環境変数 `ENABLE_OPERATION_TRACE=true` で有効化する（デフォルト: false）。

#### 9.18.5 フォレンジック対応の原則

| 原則 | 実装方針 |
|---|---|
| ログの不変性 | audit_logs は INSERT のみ。UPDATE / DELETE を DB 権限で禁止 |
| ログの外部保存 | 本格運用時に外部ログサービスへの転送を検討 |
| ログの保持期間 | audit_logs: 1年保持後に物理削除（無料枠維持のため）。auth_event_logs: 1年保持 |
| ログのアクセス制限 | システム管理者のみが監査ログ画面から参照可能 |
| タイムスタンプ | UTC で記録 |

#### 9.18.6 実装方針

```typescript
// middleware.ts - 操作トレースログ（環境変数で有効/無効を切替）
const isTraceEnabled = process.env.ENABLE_OPERATION_TRACE === 'true';

async function operationTraceMiddleware(request: NextRequest) {
  if (!isTraceEnabled) return;

  const requestId = crypto.randomUUID();
  const startTime = Date.now();
  // レスポンス後にログを非同期で記録
}
```

### 9.19 依存ライブラリのゼロデイ対策

#### 9.19.1 方針

- パッケージは**必要最小限**に留める
- 暗号化処理は**自前実装を禁止**し、実績のあるパッケージの仕様に従う
- 間接依存を含めたサプライチェーン全体を監視する

#### 9.19.2 パッケージ選定基準

| 基準 | 要件 |
|---|---|
| メンテナンス状態 | 直近 6 ヶ月以内に更新があること |
| 利用実績 | npm 週間ダウンロード数 10,000 以上 |
| セキュリティ実績 | 既知の未修正脆弱性がないこと |
| ライセンス | MIT / Apache 2.0 / BSD 等の許容ライセンス |
| 依存の深さ | 間接依存が過度に深くないこと |

#### 9.19.3 暗号化パッケージの選定

| 用途 | 推奨パッケージ | 理由 |
|---|---|---|
| パスワードハッシュ | bcrypt (bcryptjs) | 業界標準、コストファクタ調整可能 |
| トークン生成 | Node.js 標準 crypto.randomBytes | 暗号論的に安全な乱数。追加パッケージ不要 |
| トークンハッシュ | Node.js 標準 crypto.createHash('sha256') | 標準ライブラリ。追加パッケージ不要 |
| TOTP | otplib | RFC 6238 準拠、広く利用されている |
| カラム暗号化 | Node.js 標準 crypto.createCipheriv('aes-256-gcm') | AES-256-GCM。認証付き暗号化 |
| セッション管理 | NextAuth.js 内蔵 | フレームワーク標準機能を利用 |

**原則**: Node.js 標準の crypto モジュールで対応可能な処理は追加パッケージを使わない。

#### 9.19.4 サプライチェーン防御

| 対策 | 実施方法 | タイミング |
|---|---|---|
| ロックファイル厳格化 | pnpm install --frozen-lockfile | CI ビルド時 |
| 脆弱性スキャン | pnpm audit --audit-level=high | CI 毎実行。high 以上でブロック |
| 自動更新 PR | Dependabot / Renovate | 週次。セキュリティ更新は即日 |
| CDN 非依存 | 外部 CDN からの JS/CSS 読み込み禁止 | 設計ルール |
| SAST | Semgrep / CodeQL | PR 作成時 |
| シークレットスキャン | gitleaks | pre-commit hook + CI |

#### 9.19.5 脆弱性報告窓口 (受付経路) (ADR-0031 / 2026-05-31)

外部からの脆弱性報告 (responsible disclosure) は **外部 LP の `#security` セクションに集約**する (単一真値)。

- **報告窓口**: LP `#security` (`src/config/legal-versions.ts` の `SECURITY_REPORT_URL` = `${LEGAL_DOC_BASE_URL}#security`)。実体は GitHub Security Advisory (`src/config/operator.ts` の `SECURITY_ADVISORY_URL`) への導線で、ユーザ向けには説明文付きの LP セクションを見せる。email でも受付可 (`SECURITY_CONTACT_EMAIL`)。
- **アプリ内導線**: 全画面共通フッタの「セキュリティ報告」リンクから到達できるが、**ログイン後 (完全認証済) のときだけ表示**する (`src/components/app-footer.tsx` の `isAuthenticated` 出し分け)。未ログインのログイン / MFA 画面では運用情報・報告経路を前面に出さない方針。

### 9.20 個人情報保持・未使用アカウント管理

#### 9.20.1 基本運用方針

- プロジェクト終了と同時に、参加ユーザはアカウント削除を自身で実施する
- 長期間使用されていないアカウントはシステムが自動的に段階削除する

#### 9.20.2 未使用アカウントの自動削除フロー

```
アクティブなアカウント
  |
  | 最終ログインから 30 日間ログインなし
  v
[段階1] 論理削除状態に自動変更
  - is_active = false, deleted_at = 現在日時
  - 全セッションを無効化
  - 対象ユーザにメール通知「アカウントが無効化されました」
  - 通知メール内にログイン用リンクを記載
  - ログインすれば即座に復活（is_active = true, deleted_at = NULL）
  |
  | 論理削除状態から 30 日間ログインなし（= 最終ログインから 60 日）
  v
[段階2] 物理削除
  - 個人情報（氏名・メールアドレス）を完全削除
  - ユーザが作成したデータ（ナレッジ・タスク等）は「削除済みユーザ」名義で保持
  - パスワードハッシュ・リカバリーコード・セッション・MFA 情報を完全削除
  - 監査ログ・認証イベントログは保持（user_id の参照は残すが個人特定不可）
  - 物理削除実行をシステムログに記録
```

#### 9.20.3 未使用アカウント管理のデータモデル

users テーブルへのカラム追加:

| カラム名 | 型 | NULL | 説明 |
|---|---|---|---|
| last_login_at | TIMESTAMPTZ | YES | 最終ログイン日時 |

#### 9.20.4 自動削除バッチ処理

| 項目 | 要件 |
|---|---|
| 実行タイミング | 日次（深夜帯） |
| 論理削除対象 | last_login_at が 30 日以上前 かつ is_active = true |
| 物理削除対象 | deleted_at が 30 日以上前 かつ is_active = false |
| 除外条件 | システム管理者ロールのユーザは自動削除対象外 |
| 通知 | 論理削除の 7 日前に警告メールを送信 |
| ログ | 自動削除の実行結果を運用ログに記録 |

#### 9.20.5 ユーザ自身によるアカウント削除

| 項目 | 要件 |
|---|---|
| 申請者 | ユーザ自身（設定画面から実行） |
| 本人確認 | パスワード再入力 + リカバリーコード入力 |
| 処理 | 即座に論理削除。30 日後に物理削除 |
| 取り消し | 論理削除期間中にログインすれば復活可能 |
| データの扱い | 作成したナレッジ・タスク等は「削除済みユーザ」名義で保持 |

#### 9.20.6 プライバシーポリシーに明記すべき事項

| 項目 | 内容 |
|---|---|
| 収集する情報 | 氏名、メールアドレス、操作履歴 |
| 利用目的 | サービス提供、セキュリティ監査 |
| 保持期間 | アカウント有効期間 + 論理削除後 30 日 |
| 自動削除 | 最終ログインから 60 日後に個人情報を完全削除 |
| 監査ログ | 個人情報削除後も匿名化された操作ログは 2 年間保持 |
| 削除請求 | ユーザは設定画面からアカウント削除を申請可能 |

---


## SPECIFICATION §25. セキュリティ実装の全体像 (多層防御) (PR #122 で整理) からの転記

## 25. セキュリティ実装の全体像 (多層防御) (PR #122 で整理)

> **用語**: 以下「漏洩面の最小化」とは、Web アプリケーションとして**技術的に到達可能な範囲で
> 機密情報が UI / DevTools / ログに表出する経路を減らす** ことを指す。HTTP 仕様上ユーザ自身が
> DevTools Network タブで自分宛 API レスポンスを確認する行為等、ブラウザの仕様で防止不可能な
> 表出は対象外 (RFC 7540 / W3C 仕様等)。「完全制御」と誤認しないための明示。

### 25.1 機密情報の漏洩面最小化 (PR #115 以降)

| 対策 | 実装箇所 | 備考 |
|---|---|---|
| `console.*` 抑制 (lint) | `eslint.config.mjs` の `no-console` ルール (`src/` 対象) | 本番 build での自動削除 (SWC `removeConsole`) は未導入 (将来オプション) |
| JWT の httpOnly cookie 化 | `src/lib/auth.config.ts` の `cookies.sessionToken.options.httpOnly=true` + 本番で `secure=true` | JavaScript から session token にアクセス不可 |
| API レスポンスの DTO サニタイズ | `toUserDTO()` 等で `passwordHash` / `mfaSecretEncrypted` 等を除外 | Network タブで API レスポンスを見られても機密値は含まれない |
| React の生 HTML 埋め込み API 不使用 | 該当 prop を使わず JSX 構造のみで描画 (grep 0 件) | XSS 耐性を標準化 |
| エラー詳細の DB 隔離 | `system_error_logs` テーブル (PR #115) | 画面には「内部エラーが発生しました」等の固定文言のみ表示 |

**本節の明示的な限界**:
- Network タブ: ログインユーザ自身が自分宛 API レスポンス (プロジェクト / 顧客 / タスク等) を閲覧するのは設計上正常。**他ユーザデータの閲覧は API 認可ロジック (PROJECT_ROLES / sytemRole) により遮断済**
- Application タブ: cookie は httpOnly で JS から読めないが、DevTools からは見える (ブラウザ仕様)
- Sources タブ: 本番バンドルは minified だがロジックは読めば判別可能 (ソースマップは本番では生成しない既定)

### 25.2 エラー記録の統一化 (PR #115)

全エラーを `system_error_logs` テーブルに記録し、画面・console への機密情報露出を抑制:

| カテゴリ | 捕捉経路 | DB 記録内容 | ユーザ表示 |
|---|---|---|---|
| サーバエラー | `withErrorHandler` で API route を包む | message (≤4KB) + stack (≤16KB) + userId | 500 + 固定メッセージ |
| クライアントエラー | `error.tsx` / `global-error.tsx` + `POST /api/client-errors` | 同上 | 画面上「内部エラーが発生しました」+ 再試行ボタン |
| Cron / mail 系 | 各ジョブ内で `recordError()` 呼び出し | 同上 | N/A (バックグラウンド) |

- 失敗時は **silent fail** (DB 書込失敗がユーザ操作を阻害しない設計)
- admin は `/admin/audit-logs` → (将来) 専用 system_error_logs 画面で閲覧予定 (現状は DB 直参照)

### 25.3 エラー検知性 (ユーザ向け通知)

- Error boundary (`error.tsx` / `global-error.tsx`) で実装
- 表示は **固定文言「内部エラーが発生しました」** + 再試行ボタン (stack trace を画面に出さない)
- API バリデーションエラー等の業務的なエラーは通常通り詳細メッセージを返し、UI で toast / inline 表示

### 25.4 MFA ロック機構 (PR #116)

| 項目 | 値 / 実装 |
|---|---|
| 閾値 | 3 回連続失敗 |
| ロック期間 | 30 分 |
| ロック時 API 応答 | 429 + `MFA_LOCKED` コード |
| UI 表示 | admin/users 画面でツールチップ形式で解除予定時刻 JST 表示 |
| 解除経路 (3 つ) | (1) 正しい TOTP 入力、(2) recovery code 使用 (`resetMfaLockOnRecoveryCodeUse`)、(3) admin 手動解除 (`unlockMfaByAdmin`) |
| パスワードロックとの分離 | `mfaFailedCount` / `mfaLockedUntil` は `failedLoginCount` / `lockedUntil` と別カラム (混在防止) |
| 恒久ロック | **なし** (recovery code で自己解除可能な設計) |

### 25.5 セキュリティ観点の到達状況と限界

**達成済**:
- OWASP Top 10 対策の主要項目 (認証 / 認可 / 暗号化 / CSRF / XSS / ログイン試行制限)
- 機密情報の画面・console 露出抑制
- エラー情報の DB 集約と固定文言表示の分離
- MFA のブルートフォース対策

**本番運用時の限界 (意図的な未対応)**:
- DevTools の Network / Storage / Sources タブ自体は技術的に塞げない (ブラウザ仕様)
- 本番ビルド時の `console.*` 自動削除 (SWC `removeConsole`) は導入余地あり (将来対応)
- ソースマップの本番 CDN 配信抑止は既定動作に依存 (明示宣言は将来対応)

現行体制で MVP 〜 小規模本番運用には十分な堅牢性を確保。追加強化は `DEVELOPER_GUIDE §11 後続対応 (TODO) 一覧` (PR #122) 参照。

---

## §26. テナント分離検証 (ADR-0024 / 2026-05-28 severity-1 fix)

### 26.1 背景

PR #2 (T-03, 2026-04-15) で導入したマルチテナント基盤は、`schema.prisma` の各エンティティの `tenantId` カラムに DB DEFAULT (`@default(dbgenerated("'00000000-...-001'::uuid"))`) を設定していた。これは「単一テナント運用期 (v1) でコードが tenantId を渡し忘れても Default テナントに自動配属する」という暫定設計だった。

2026-05-28 に **severity-1 のテナント越境バグ** が発覚:

- `src/services/risk.service.ts createRisk()` と `retrospective.service.ts createRetrospective()` が `data` に `tenantId` を渡しておらず、すべての非 Default テナントの起票が **silent に Default テナントに混入** していた
- 起票者本人の一覧から消える + Default テナント側に他テナントデータが露出する個人情報漏洩リスク

ADR-0024 により schema の DB DEFAULT を撤去し、コード側で tenantId を必ず明示する設計に移行。

### 26.2 テナント分離の三層防御

| 層 | 場所 | 役割 | 違反時の挙動 |
|---|---|---|---|
| **層 1 (DB schema)** | `prisma/schema.prisma` | tenant_id NOT NULL (DEFAULT なし) | コードが渡さなければ Prisma が NOT NULL 違反でエラー |
| **層 2 (service 層 create)** | `src/services/*.service.ts` の `prisma.X.create({ data: { tenantId, ... } })` | data に tenantId を明示記述 | 明示しないと層 1 でエラー化 |
| **層 3 (service 層 query)** | `src/services/*.service.ts` の `prisma.X.findMany({ where: { tenantId: viewerTenantId } })` | 一覧/個別取得で必ず `where.tenantId` フィルタ | フィルタ漏れで越境表示 |

### 26.3 SystemErrorLog の正当な例外

`recordError()` (`src/services/error-log.service.ts`) は pre-auth エラー (login 失敗等) を記録するため `tenantId` 不明のケースが正当に発生する。本サービスのみ:

```typescript
tenantId: input.tenantId ?? DEFAULT_TENANT_ID,
```

の明示的な fallback を **コード側に書く**。これは「pre-auth エラーは Default テナントの super_admin 監視に集約する」という設計判断の明示記述であり、暗黙の DB DEFAULT に頼らない。

### 26.4 再発防止チェック項目 (コードレビュー時)

1. `prisma.X.create({ data: { ... } })` の差分が含まれる PR では **data 内に tenantId があるか** を必ず確認
2. service 関数のシグネチャに `tenantId: string` が含まれているか確認
3. 新規モデル追加時、schema で `tenantId String @map("tenant_id") @db.Uuid` (DEFAULT なし) で定義する
4. `findMany` / `findFirst` 等の where 句に `tenantId: viewerTenantId` が含まれているか確認 (ADR-0001 / Phase 2-3 のテナント越境防御)

### 26.5 関連

- [ADR-0024: tenant_id カラムから DB DEFAULT を撤去](../adr/0024-explicit-tenant-id-no-db-default.md)
- [docs/knowledge/KDD_PATTERNS.md §5.X+169](../knowledge/KDD_PATTERNS.md) — `tenant_id DB DEFAULT silent fallthrough` 罠
- [docs/operations/INCIDENT_RESPONSE.md §2026-05-28](../operations/operate/INCIDENT_RESPONSE.md)
- e2e: `e2e/specs/11-tenant-isolation.spec.ts` (severity-1 regression セクション)

---

## アクセス制御の最小特権原則 — Beginner プラン write block (ADR-0025、2026-05-29)

Beginner プランは「90 日完全無料試用」訴求のため、容量超過時の課金を発生させない設計上の制約がある。これを保証するため、最小特権原則 (principle of least privilege) に従い:

- **INSERT / UPDATE 拒否**: DB 50MB / File Storage 100MB を超過した Beginner テナントは「容量を増やす操作」を一切禁止
- **DELETE のみ許可**: 「容量を減らす操作」だけは継続許可 (= ユーザが状態回復できる経路を残す)
- **READ / EXPORT 継続許可**: 既存データの閲覧・エクスポートはガード対象外 (= ユーザロックインを防ぐ)

実装は [src/services/storage-guard.service.ts](../../src/services/storage-guard.service.ts) の `BeginnerWriteGuardExceededError` (HTTP 403)。エラーレスポンスには `upgradeUrl: '/settings/tenant'` を含めユーザに復旧経路を提示する。

詳細: [ADR-0025](../adr/0025-beginner-write-guard.md) / [仕様書 BEGINNER_PLAN.md](../specification/BEGINNER_PLAN.md)

---

