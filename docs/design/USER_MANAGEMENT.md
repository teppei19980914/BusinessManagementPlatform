# ユーザ管理画面 設計書

> 対象画面: `/admin/users`（テナント管理者専用）
> 本書は **現ソースコードを正** とした設計の真値です（2026-06-03 時点）。画面仕様の要約は [specification/SCREENS.md §11.11](../specification/SCREENS.md)、公開向けの説明は [public/admin-guide.md](../public/admin-guide.md) を参照。
> 関連: [DATA_MODEL.md](./DATA_MODEL.md)（User モデル）/ [COLUMN_USAGE_MAP.md](./COLUMN_USAGE_MAP.md)（全カラム正本）/ [SECURITY.md](./SECURITY.md)（認証・アカウントロック）。

---

## 1. 目的

テナント管理者が、自テナント内のユーザ（メンバー）を **発行・編集・無効化・削除・ロック解除・招待管理** する画面。

---

## 2. アクセス制御（多層防御）

| レイヤ | 実装 | 挙動 |
|---|---|---|
| 画面到達 | `page.tsx`：`auth()` + `isAdminOrAbove(session.user)` | 非 admin は `redirect('/')` |
| API 認可 | 全ルートで `getAuthenticatedUser` + `requireAdmin`（= `isAdminOrAbove`） | 非 admin は 403 `FORBIDDEN` |
| テナント越境遮断 | 個別ユーザ操作は `requireSameTenantUser`、一覧は `listUsers(viewerTenantId)` | 他テナントのユーザは取得・操作不可（severity-1 PII 漏洩対策） |
| ロール昇格ガード | `super_admin` への変更は `isSuperAdmin(呼出者)` のみ許可 | テナント管理者による super_admin 昇格を 403 で遮断 |
| 自己ロール変更ガード | `updateUserRole`：`userId === updaterId` で `CANNOT_CHANGE_OWN_ROLE` | 自分の admin 権限剥奪事故を防止（UI 側も select を disabled） |

- **`isAdminOrAbove`** = `admin` + `super_admin`。「システム管理者」と表記する箇所はこの 2 ロールを指す。
- `super_admin` は管理テナント所属の内部ロールで、テナント側の UI（招待・編集の選択肢）には**出さない**（seed / 運用手順でのみ付与）。
- DB 取得失敗時（`listUsers` / `getTenantSelfInfo` が throw）は**空配列 + 警告バナー**で描画継続し、`system_error_logs` に記録（画面操作不能にしない）。

---

## 3. データモデル（User の主なカラム）

正本は [COLUMN_USAGE_MAP.md](./COLUMN_USAGE_MAP.md) / `prisma/schema.prisma`。本画面に関係する主なカラム:

| カラム | 用途 |
|---|---|
| `name` / `email` | 氏名 / ログイン ID（テナント内一意 `@@unique([tenantId, email])`） |
| `systemRole` | `admin` / `general`（`super_admin` は内部） |
| `isActive` | 有効/無効フラグ（受諾後の状態軸） |
| `invitationAcceptedAt` | **招待受諾日時。NULL = 招待中（パスワード未設定）**、値あり = 受諾済（2026-06-03 追加） |
| `failedLoginCount` / `lockedUntil` / `permanentLock` / `temporaryLockCount` | パスワードログインのロック状態 |
| `mfaEnabled` / `mfaFailedCount` / `mfaLockedUntil` | 二段階認証（MFA）の有無とロック状態 |
| `lastLoginAt` | 前回ログイン成功日時（NULL = 未ログイン） |
| `createdBy` / `updatedBy` | 作成者 / 更新者（操作した管理者の UUID。**自己参照 FK は張らず** UUID のみ保持、氏名は一覧で解決）（2026-06-03 追加） |
| `createdAt` / `updatedAt` | 作成日時 / 更新日時 |
| `deletedAt` | **論理削除専用**（NULL = 有効）。2026-06-03 以前は「招待中」もここで代用していたが廃止 |

---

## 4. アカウント状態モデル（招待中 / 有効 / 無効）

状態は `deriveAccountStatus({ isActive, invitationAcceptedAt })` で**一意に導出**する（単一ソース、`user.service.ts`）。

| 状態 | 条件 | 意味 |
|---|---|---|
| 招待中 `invited` | `invitationAcceptedAt == null` | 招待メール送信〜本人がパスワード設定するまで |
| 有効 `active` | 受諾済 かつ `isActive == true` | ログイン可能 |
| 無効 `inactive` | 受諾済 かつ `isActive == false` | 管理者が席を停止（退職者等） |

- **ロック（連続失敗の自動保護）はこの 3 状態とは別軸**。有効なユーザにも一時ロックは掛かる。一覧では「ステータス」列（状態）と「認証ロック」列を別に表示する。
- 論理削除（`deletedAt != null`）されたユーザは一覧クエリで除外され、状態導出の対象外。

---

## 5. ライフサイクル（状態遷移）

| # | 操作 | 入口 | DB 変化 | 備考 |
|---|---|---|---|---|
| 1 | 招待発行 | `createUser`（POST） | `isActive=false` / `invitationAcceptedAt=null` / `deletedAt=null` / `createdBy=updatedBy=招待者` | パスワード未設定の仮登録 + 検証メール送信（リンク有効期限 24h）。重複メール: 受諾済→`DUPLICATE_EMAIL` / 招待中→旧レコード掃除して再登録 |
| 2 | 受諾（有効化） | `setupPassword`（本人） | `invitationAcceptedAt=now` / `isActive=true` / `deletedAt=null` | **有効化の起点はパスワード設定完了の瞬間**（初回ログインではない）。`super_admin` は MFA 設定完了時（`setupInitialMfa`） |
| 3 | 無効化 / 再有効化 | `updateUserStatus`（PATCH） | `isActive` 切替 + `tokenVersion++` + `updatedBy` | 無効化で既存 JWT 失効 → 即時ログアウト |
| 4 | 削除 | `deleteUser`（DELETE） | `deletedAt=now` / `isActive=false` / MFA 解除 + `tokenVersion++`。ProjectMember / Session / RecoveryCode 等を**物理削除** | Task 担当・Risk 起票等の scalar 参照は履歴保全。自己削除不可 |
| 5 | 招待取消 | `cancelInvitation`（POST） | 招待中ユーザを付随レコードごと**物理削除**（席を即解放） | 招待中（`invitationAcceptedAt=null`）のみ。受諾済は対象外 |
| 6 | 自動/手動ロック | `lockInactiveUsers` | 30 日（`INACTIVE_USER_LOCK_DAYS`）無アクティブの非 admin を `isActive=false` | cron（全テナント）/ 管理画面手動（自テナントのみ） |

---

## 6. 席数制御（Beginner プラン・案A）

- **席使用数 = 有効（`isActive=true`）+ 招待中（`invitationAcceptedAt=null`）**（招待を予約席として数える）。無効・論理削除は対象外。
- 上限超過チェック: `assertSeatAvailableForTenant`（`createUser` 内、重複掃除の**後**に実施）。`seatUsage + 1 > beginnerMaxSeats`（既定 5）で `SEAT_LIMIT_EXCEEDED`。
- UI: テナント設定の `seatUsageCount`（= 有効 + 招待中）で席数表示・新規招待ボタンの活性判定。満席時はボタン disabled。
- **課金スナップショット用の `activeUserCount`（`isActive=true` のみ）とは別概念**（月次課金根拠の不変性を守るため意味を変えない）。
- Expert / Pro は席数無制限。

---

## 7. 一覧（テーブル）

| 列 | 内容 / 表示 |
|---|---|
| ユーザ名 | `name` |
| メールアドレス | `email` |
| ロール | `systemRole`（バッジ。テナント管理者 / 一般ユーザ） |
| ステータス | アカウント状態バッジ（招待中 / 有効 / 無効） |
| 認証ロック | 永続ロック / 一時ロック（PW・MFA、解除予定 tooltip）/ 失敗カウント / —（状態とは別軸） |
| 前回ログイン | `lastLoginAt`（`formatDateTimeFull`、未ログインは「未ログイン」） |
| 作成者 | `createdByName`（自テナント内で氏名解決、無ければ「—」） |
| 作成日時 | `createdAt`（**`formatDateTimeSeconds` = `YYYY/MM/DD HH:mm:ss`**、監査列の全画面共通書式） |
| 更新者 | `updatedByName`（同上、無ければ「—」） |
| 更新日時 | `updatedAt`（**`formatDateTimeSeconds`**） |

- 検索: 氏名・メールアドレスの部分一致（`?keyword=` で URL 永続化）。
- 並び替え: 各列（`sessionStorage` 永続化、複数列対応）。
- **画面見出し（「ユーザ管理」h2）は表示しない**（2026-06-03 削除）。操作ボタン群（席数表示 / 非アクティブ一括ロック / 新規ユーザ登録）は右寄せ。

---

## 8. 新規ユーザ登録ダイアログ

| 入力 | 必須 | 制約 |
|---|---|---|
| ユーザ名 | ○ | `NAME_MAX_LENGTH`（100）文字以内 |
| メールアドレス | ○ | メール形式 / テナント内重複不可 |
| システムロール | ○ | テナント管理者 / 一般ユーザ（`super_admin` 非表示） |

- 送信で `POST /api/admin/users` → 招待メール送信（`noreply@tasukiba.com`、リンク 24h）。成功画面で完了通知。
- 席数満席時はトリガーボタンが disabled + tooltip。

---

## 9. 編集ダイアログ

行クリックで開く。アカウント状態により表示セクションを出し分ける。

| セクション | 表示条件 | 内容 |
|---|---|---|
| 基本フォーム | 常時 | 氏名 / システムロール（自己は disabled・`super_admin` 非表示）/ アカウントステータス（**招待中は disabled**） + 保存 |
| アカウント情報 | 常時 | 状態（招待中/有効/無効）/ 前回ログイン / 二段階認証(MFA): 設定済み・未設定 |
| ログインロック情報 | 非招待中 | 失敗回数 / 一時ロック / 永続ロック + 「ロック解除」ボタン（条件付き） |
| リカバリーコード | 非招待中 かつ `mfaEnabled` | 「リカバリーコードを再発行」→ 新コード（`RECOVERY_CODE_COUNT`=10）を**その場で 1 回だけ**表示 |
| 招待中 | 招待中のみ | 「招待メールを再送」/「招待を取り消す」 |
| 危険な操作 | 非招待中 | 「このユーザを削除」 |

---

## 10. API 一覧

| メソッド・パス | 役割 | 認可 | 主なエラー |
|---|---|---|---|
| `GET /api/admin/users` | 一覧取得（自テナント） | requireAdmin | — |
| `POST /api/admin/users` | 招待発行（検証メール送信） | requireAdmin | 400 `VALIDATION_ERROR` / 409 `DUPLICATE_EMAIL` / 400 `SEAT_LIMIT_EXCEEDED` / 502 `EMAIL_SEND_FAILED` |
| `PATCH /api/admin/users/[userId]` | 編集（氏名/ロール/有効状態） | requireAdmin + sameTenant | 400 / 403 `FORBIDDEN`（自己ロール変更・super_admin 昇格） |
| `DELETE /api/admin/users/[userId]` | 削除（論理削除 + カスケード） | requireAdmin + sameTenant | 403 `cannotDeleteSelf` / 404 |
| `POST /api/admin/users/[userId]/unlock` | ロック解除（PW + MFA 一括） | requireAdmin + sameTenant | — |
| `POST /api/admin/users/[userId]/recovery-codes` | リカバリーコード再発行（10 個、1 回返却） | requireAdmin + sameTenant | — |
| `POST /api/admin/users/[userId]/resend-invitation` | 招待メール再送（招待中のみ） | requireAdmin + sameTenant | 404 `USER_NOT_FOUND` / 502 `EMAIL_SEND_FAILED` |
| `POST /api/admin/users/[userId]/cancel-invitation` | 招待取消（招待中を物理削除・席解放） | requireAdmin + sameTenant | 404 `USER_NOT_FOUND` |
| `POST /api/admin/users/lock-inactive` | 非アクティブ自動/手動ロック | cron（`Bearer CRON_SECRET`、全テナント）または requireAdmin（手動、自テナント） | 401 系（cron 設定誤り）|

---

## 11. サービス層（`src/services/user.service.ts`）

`listUsers`（氏名解決込み）/ `createUser` / `updateUser`（→ `updateUserStatus` / `updateUserRole` にディスパッチ）/ `deleteUser` / `resendInvitationByAdmin` / `cancelInvitation` / `lockInactiveUsers` / `assertSeatAvailableForTenant` / `deriveAccountStatus` / `toUserDTO`（`UserDTO`）。

---

## 12. 監査

- すべての write 操作で `audit_logs`（`entityType='user'`、`recordAuditLog`、`sanitizeForAudit` で機微フィールド redact、`entityId` は UUID）。
- 主要イベントは `auth_event_logs` にも記録（`account_created` / `password_change`〔= recovery 再発行〕等）。
- 監査ログは `/admin/audit-logs` 画面で参照（操作種別・対象種別はロケール表示、対象 ID 列なし）。

---

## 13. 設定定数（関連）

| 定数 | 既定 | 用途 |
|---|---|---|
| `NAME_MAX_LENGTH` | 100 | ユーザ名上限 |
| `LOGIN_FAILURE_MAX` | 5 | パスワード一時ロック発火 |
| `TEMPORARY_LOCK_DURATION_MS` | 30 分 | 一時ロック時間 |
| `PERMANENT_LOCK_THRESHOLD` | 3 | 一時ロック累積で永続ロック |
| `INACTIVE_USER_LOCK_DAYS` | 30 | 非アクティブ自動ロック閾値 |
| `RECOVERY_CODE_COUNT` | 10 | リカバリーコード生成数 |
| `beginnerMaxSeats`（DB 値） | 5 | Beginner 席数上限 |
| 検証トークン有効期限 | 24 時間 | 招待リンク |
