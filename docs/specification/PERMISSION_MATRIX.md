# 画面別権限マトリクス (Specification)

本ドキュメントは、本サービスの全画面における **操作別の権限マトリクス** を集約する (SPECIFICATION.md §7 全体を転記)。ユーザロールの定義は [business/USER_ROLES.md](../business/USER_ROLES.md)、画面の機能仕様は [SCREENS.md](./SCREENS.md) を参照。

§7 は画面・操作単位の仕様マトリクス、§0 は **実装の権限エンジン (`checkPermission`) の完全ミラー** である。両者が矛盾する場合は §0 (= ソースコード) を真値とする。

---

## 0. 権限実装ミラー (`src/lib/permissions/` の完全反映)

> このセクションは推測ではなくソースコードを 1 行ずつ照合した結果である。真値ソース:
> [`src/lib/permissions/check-permission.ts`](../../src/lib/permissions/check-permission.ts) (`Action` 型 / `ROLE_PERMISSIONS`)、
> [`src/lib/permissions/role.ts`](../../src/lib/permissions/role.ts) (システムロール判定)、
> [`src/lib/permissions/membership.ts`](../../src/lib/permissions/membership.ts) (admin/super_admin の pm_tl 昇格)、
> [`src/config/master-data.ts`](../../src/config/master-data.ts) (`SYSTEM_ROLES` / `PROJECT_ROLES`)。

### 0.1 ロール体系

**システムロール (3 階層、`SYSTEM_ROLES`)**:

| キー | ラベル | 説明 | 判定ヘルパ |
|---|---|---|---|
| `super_admin` | システム管理者 | プラットフォーム運営者専用 (管理テナント所属)。全テナント横断アクセス | `isSuperAdmin()` / `isAdminOrAbove()` |
| `admin` | テナント管理者 | 自テナント内の全権限 | `isTenantAdmin()` / `isAdminOrAbove()` |
| `general` | 一般ユーザ | プロジェクト/役割に応じた権限 | (なし) |

**プロジェクトロール (`PROJECT_ROLES`)**: `pm_tl` (PM/TL) / `member` (メンバー) / `viewer` (閲覧者)。

### 0.2 システムロール → プロジェクトロールの昇格挙動

- `checkMembership()` ([membership.ts:87](../../src/lib/permissions/membership.ts)) は **`admin` または `super_admin`** に対し `projectRole: 'pm_tl'` を返す。つまり管理者は project_members に行が無くても全プロジェクトで PM/TL 相当の権限を得る。
- ただし `checkPermission()` ([check-permission.ts:126](../../src/lib/permissions/check-permission.ts)) の短絡 (全操作許可) は **`systemRole === 'admin'` のみ**。`super_admin` はこの短絡に該当しない。
- テナント越境ガード ([membership.ts:81](../../src/lib/permissions/membership.ts)): `super_admin` 以外は `project.tenantId !== userTenantId` なら `isMember:false` (404 扱い)。`super_admin` のみ越境管理を許可。

### 0.3 ★既知の死角★ super_admin は checkPermission で project:delete を持たない

`super_admin` が `checkMembership() → checkPermission()` 経路を通ると `effectiveRole='pm_tl'` で評価される。
`checkPermission` の admin 短絡 (line 126) は `super_admin` を含まないため、`super_admin` は **`pm_tl` の許可集合**で判定される。
`pm_tl` の `ROLE_PERMISSIONS` には `project:delete` / `admin:users` / `admin:audit_logs` が含まれない ([check-permission.ts:74-86](../../src/lib/permissions/check-permission.ts))。
→ **結果: super_admin はこの経路では `project:delete` を実行できない (既知の死角)。** admin (テナント管理者) は line 126 の短絡で全 Action 可。

### 0.4 Action × プロジェクトロール 完全マトリクス (`ROLE_PERMISSIONS` の Set を逐語反映)

`Action` 型は全 22 種。`admin` 列は `ROLE_PERMISSIONS.admin` の Set 内容 (= `systemRole==='admin'` は別途 line 126 で全許可)。
○ = Set に含まれる / × = 含まれない。状態制約 (`STATE_RESTRICTIONS`) と所有者条件は §0.5 / §0.6 参照。

| Action | admin (Set) | pm_tl | member | viewer |
|---|:---:|:---:|:---:|:---:|
| `project:create` | ○ | ○ | × | × |
| `project:read` | ○ | ○ | ○ | ○ |
| `project:update` | ○ | ○ | × | × |
| `project:delete` | ○ | **×** | × | × |
| `project:change_status` | ○ | ○ | × | × |
| `task:create` | ○ | ○ | ○ | × |
| `task:read` | ○ | ○ | ○ | ○ |
| `task:update` | ○ | ○ | × | × |
| `task:update_progress` | ○ | ○ | △ (担当のみ) | × |
| `task:delete` | ○ | ○ | × | × |
| `knowledge:create` | ○ | ○ | ○ | × |
| `knowledge:read` | ○ | ○ | ○ | ○ |
| `knowledge:update` | ○ | ○ | △ (作成者のみ) | × |
| `knowledge:delete` | ○ | ○ | × | × |
| `knowledge:publish` | ○ | ○ | × | × |
| `risk:create` | ○ | ○ | ○ | × |
| `risk:read` | ○ | ○ | ○ | ○ |
| `risk:update` | ○ | ○ | △ (起票/担当のみ) | × |
| `risk:delete` | ○ | ○ | × | × |
| `member:read` | ○ | ○ | × | × |
| `member:manage` | ○ | ○ | × | × |
| `stakeholder:read` | ○ | ○ | × | × |
| `stakeholder:create` | ○ | ○ | × | × |
| `stakeholder:update` | ○ | ○ | × | × |
| `stakeholder:delete` | ○ | ○ | × | × |
| `admin:users` | ○ | **×** | × | × |
| `admin:audit_logs` | ○ | **×** | × | × |

> `pm_tl` と `admin` (Set) の差分は **`project:delete` / `admin:users` / `admin:audit_logs` の 3 件のみ**。その他の Action は完全一致。

> **注意 (§0.4 と §7 系の整合)**: 上表 `knowledge:delete` / `risk:delete` の member=× は **`checkPermission` の Action** の話。
> 一方、ナレッジ/リスク/振り返り/メモの「自分作成を削除」は `ROLE_PERMISSIONS` ではなく **service 層** (例: [`deleteKnowledge`](../../src/services/knowledge.service.ts) の `createdBy === userId OR assigneeId === userId` 判定 + `context: 'project'`) で認可される。
> よって §7.8 等で member が「自分作成を削除 ○」なのは正しい (service 層ゲート)。`knowledge:delete` Action は「全○○」横断経路の admin モデレーション削除でのみ評価される。

### 0.5 member の所有者条件 (`resourceOwnerId === userId`)

`effectiveRole === 'member'` の場合、以下 3 Action は `resourceOwnerId` が指定されると本人のみ許可 ([check-permission.ts:154-173](../../src/lib/permissions/check-permission.ts)):

| Action | 条件 | 拒否理由 |
|---|---|---|
| `knowledge:update` | 自分が作成したナレッジのみ | 自分が作成したナレッジのみ編集できます |
| `task:update_progress` | 自分が担当のタスクのみ | 自分が担当のタスクのみ進捗更新できます |
| `risk:update` | 自分が起票/担当のリスク/課題のみ | 自分が起票または担当のリスク/課題のみ編集できます |

> `resourceOwnerId` 未指定時は所有者条件をスキップ (= ロール許可のみで判定)。

### 0.6 プロジェクト状態制約 (`STATE_RESTRICTIONS`)

ロール許可を通過しても、`projectStatus` が以下の場合は許可 Action が制限される (admin 短絡経路にも適用):

- **`closed`**: `project:read` / `project:delete` / `task:read` / `knowledge:read` / `risk:read` / `stakeholder:read` のみ可 (読み取り専用だが**プロジェクトの削除は可**)。
- 2026-06 簡素化で旧 `completed` / `retrospected` 状態は廃止。`STATE_RESTRICTIONS` で制約を持つのは `closed` のみ（planning〜executing はロール権限のみで判定）。

### 0.7 PM/TL 自律権限 と member 管理の細粒度ガード

- `pm_tl` は `member:manage` を持つ ([check-permission.ts:83](../../src/lib/permissions/check-permission.ts))。member/viewer の追加・削除・ロール変更は PM/TL が実行可。
- ただし「PM/TL ロール」を扱う操作 (PM/TL 追加・削除、PM/TL↔他ロールの昇格/降格) は **admin only**。この細粒度判定は `checkPermission` では表現できず [`src/services/member.service.ts`](../../src/services/member.service.ts) で実施する。

### 0.8 自己ロール変更禁止 (feat/crud-permission-redesign / [ADR-0014](../adr/0014-crud-permission-redesign.md))

- **プロジェクトロール**: 自分自身の projectRole 変更は不可 → `CANNOT_CHANGE_OWN_PROJECT_ROLE` ([member.service.ts:153](../../src/services/member.service.ts))。
- **システムロール**: 自分自身の systemRole 変更は不可 → `CANNOT_CHANGE_OWN_ROLE` ([user.service.ts:341](../../src/services/user.service.ts))。
- 設計意図: 必ず別の管理者が変更する (権限の自己昇格・誤降格による締め出しを防止)。

---

## 7. 画面・操作単位の権限マトリクス

記号の意味:

- ○: 実行可
- △: 条件付きで可
- ×: 実行不可

### 7.1 システム管理系画面

| 画面 | 操作 | システム管理者 | PM/TL | メンバー | 閲覧者 |
|---|---|---:|---:|---:|---:|
| ユーザ管理画面 | ユーザ一覧を見る | ○ | × | × | × |
| ユーザ管理画面 | ユーザを検索する | ○ | × | × | × |
| ユーザ管理画面 | ユーザを有効化/無効化する | ○ | × | × | × |
| ユーザ管理画面 | システムロールを変更する | ○ | × | × | × |
| ユーザ管理画面 | ユーザを削除する (PR #89) | ○ | × | × | × |
| ユーザ管理画面 | 非アクティブユーザを整理 (手動クリーンアップ、PR #89) | ○ | × | × | × |
| プロジェクトメンバー管理画面 | 参加メンバー一覧を見る | ○ | ○ | × | × |
| プロジェクトメンバー管理画面 | メンバー (member/viewer) を追加する | ○ | ○ | × | × |
| プロジェクトメンバー管理画面 | メンバー (member/viewer) を解除する | ○ | ○ | × | × |
| プロジェクトメンバー管理画面 | member ↔ viewer のロール変更 | ○ | ○ | × | × |
| プロジェクトメンバー管理画面 | PM/TL を追加する | ○ | × | × | × |
| プロジェクトメンバー管理画面 | PM/TL を削除する | ○ | × | × | × |
| プロジェクトメンバー管理画面 | PM/TL ↔ それ以外のロール変更 (昇格/降格) | ○ | × | × | × |
| 権限変更履歴画面 | 権限変更履歴を見る | ○ | × | × | × |

### 7.2 プロジェクト共通画面

| 画面 | 操作 | システム管理者 | PM/TL | メンバー | 閲覧者 |
|---|---|---:|---:|---:|---:|
| プロジェクト一覧画面 | 一覧を見る | ○ | ○ | ○ | ○ |
| プロジェクト一覧画面 | プロジェクトを検索する | ○ | ○ | ○ | ○ |
| プロジェクト一覧画面 | プロジェクトを新規作成する | ○ | ○ | × | × |
| プロジェクト詳細画面 | 基本情報を見る | ○ | ○ | ○ | ○ |
| プロジェクト詳細画面 | 基本情報を編集する | ○ | ○ | × | × |
| プロジェクト詳細画面 | ステータスを変更する | ○ | ○ | × | × |
| プロジェクト詳細画面 | 目的・背景・概要を編集する | ○ | ○ | × | × |
| プロジェクト詳細画面 | プロジェクトをクローズする | ○ | ○ | × | × |

### 7.3 見積もり画面

| 画面 | 操作 | システム管理者 | PM/TL | メンバー | 閲覧者 |
|---|---|---:|---:|---:|---:|
| 見積もりタブ | タブを表示する | ○ | ○ | × | × |
| 見積もり画面 | 見積一覧を見る | ○ | ○ | × | × |
| 見積もり画面 | 見積詳細を見る | ○ | ○ | × | × |
| 見積もり画面 | 見積を新規作成する | ○ | ○ | × | × |
| 見積もり画面 | 見積項目を編集する | ○ | ○ | × | × |
| 見積もり画面 | 見積根拠を編集する | ○ | ○ | × | × |
| 見積もり画面 | 見積を確定する | ○ | ○ | × | × |
| タスク詳細画面 | 自分の担当タスクの予定工数を見る | ○ | ○ | ○ | △ |

### 7.4 WBS / タスク画面

| 画面 | 操作 | システム管理者 | PM/TL | メンバー | 閲覧者 |
|---|---|---:|---:|---:|---:|
| WBS / タスク画面 | タスク一覧を見る | ○ | ○ | ○ | ○ |
| WBS / タスク画面 | タスクを新規作成する | ○ | ○ | × | × |
| WBS / タスク画面 | タスクを編集する（計画情報） | ○ | ○ | × | × |
| WBS / タスク画面 | タスクを編集する（実績情報） | ○ | ○ | △（担当のみ） | × |
| WBS / タスク画面 | タスクを論理削除する | ○ | ○ | × | × |
| WBS / タスク画面 | 親子構造を変更する | ○ | ○ | × | × |
| WBS / タスク画面 | 担当者を設定・変更する | ○ | ○ | × | × |
| WBS / タスク画面 | 予定開始日・終了日を変更する | ○ | ○ | × | × |
| WBS / タスク画面 | 実績開始日・終了日を変更する | ○ | ○ | △（担当のみ） | × |
| WBS / タスク画面 | 予定工数を変更する | ○ | ○ | × | × |
| WBS / タスク画面 | ステータスを変更する | ○ | ○ | △（担当のみ） | × |
| WBS / タスク画面 | 進捗率を変更する | ○ | ○ | △（担当のみ） | × |
| WBS / タスク画面 | 自分の担当タスク詳細を見る | ○ | ○ | ○ | ○ |
| WBS / タスク画面 | 他人の担当タスク詳細を見る | ○ | ○ | ○ | ○ |
| WBS / タスク画面 | **WBS 上書きインポート (sync-import)** (PR #420) | ○ | ○ | × | × |
| WBS / タスク画面 | **WBS タスク一括複製 (bulk-duplicate)** (PR #420) | ○ | ○ | × | × |

### 7.5 ガントチャート (feat/gantt-tab-restructure 改修、2026-04-26)

旧仕様: プロジェクト詳細の専用「ガント」タブ + マイタスク非対応。
新仕様: 専用タブを廃止し以下 2 経路に統合:

- **プロジェクト単位**: プロジェクト詳細 → 「WBS 管理」タブ → 「ガントチャートを表示」ボタン → タブ内で開閉切替
- **横断**: マイタスク画面 → 「ガントチャートを表示」ボタン → 自分の担当タスクをプロジェクトごとに縦並びで Gantt 表示

| 操作 | システム管理者 | PM/TL | メンバー | 閲覧者 |
|---|---:|---:|---:|---:|
| 全体ガントを見る (プロジェクト内) | ○ | ○ | ○ | ○ |
| 担当者別ガントを見る (プロジェクト内) | ○ | ○ | ○ | ○ |
| マイルストーンを見る | ○ | ○ | ○ | ○ |
| 横断 Gantt を見る (マイタスク経由) | ○ | ○ | ○ | ○ |
| ガント上で直接編集する | × | × | × | × |

### 7.6 マイタスク / 進捗・実績更新

> **★2026-06-03 実装ミラー★** マイタスク画面は **WBS / ガント UI を流用した参照専用の横断ビュー**。画面上に進捗率/実績/作業メモ/完了報告の入力欄やボタンは存在せず、編集はリンクから各プロジェクトの **WBS 画面 (§7.4)** へ遷移して行う。画面自体に role gate はなく、表示内容は「自分が担当に設定されたタスクの有無」で決まる (担当に設定されていれば閲覧者ロールでも自分のタスクを参照できる)。

| 画面 | 操作 | システム管理者 | PM/TL | メンバー | 閲覧者 |
|---|---|---:|---:|---:|---:|
| マイタスク画面 | 自分の担当タスクを全プロジェクト横断で参照する (参照専用) | ○ | ○ | ○ | ○ |
| マイタスク画面 | 状況フィルタ / 列ソート / 列幅調整 / 横断ガント表示 / ページ送り | ○ | ○ | ○ | ○ |
| マイタスク画面 | 画面上で直接編集する (進捗率・実績・メモ・完了報告) | × | × | × | × |
| WBS 画面 (実績更新) | 自分の進捗率を更新する | ○ | ○ | ○ | × |
| WBS 画面 (実績更新) | 自分の実績工数・実績日程を入力する | ○ | ○ | ○ | × |
| WBS 画面 | 他人の進捗率を更新する | ○ | ○ | × | × |
| WBS 画面 | 他人の実績工数を更新する | ○ | ○ | × | × |
| WBS 画面 | 進捗履歴を見る | ○ | ○ | ○ | △ |

### 7.7 リスク・課題画面

| 画面 | 操作 | システム管理者 | PM/TL | メンバー | 閲覧者 |
|---|---|---:|---:|---:|---:|
| リスク一覧画面 | 一覧を見る | ○ | ○ | ○ | ○ |
| リスク詳細画面 | 詳細を見る | ○ | ○ | ○ | ○ |
| リスク一覧画面 | リスクを起票する | ○ | ○ | ○ | × |
| 課題一覧画面 | 課題を起票する | ○ | ○ | ○ | × |
| リスク / 課題詳細画面 | 内容を編集する | ○ | ○ | △ | × |
| リスク / 課題詳細画面 | 対応策を編集する | ○ | ○ | △ | × |
| リスク / 課題詳細画面 | 状態を変更する | ○ | ○ | △ | × |
| リスク / 課題詳細画面 | 対応担当者を設定する | ○ | ○ | × | × |
| リスク / 課題詳細画面 | クローズする | ○ | ○ | × | × |

### 7.8 ナレッジ画面

| 画面 | 操作 | システム管理者 | PM/TL | メンバー | 閲覧者 |
|---|---|---:|---:|---:|---:|
| ナレッジ一覧画面 | 公開済みナレッジを見る | ○ | ○ | ○ | ○ |
| ナレッジ一覧画面 | ナレッジを検索する | ○ | ○ | ○ | ○ |
| ナレッジ詳細画面 | 下書きを見る | ○ | ○ | △ | × |
| ナレッジ登録画面 | ナレッジ下書きを作成する | ○ | ○ | ○ | × |
| ナレッジ編集画面 | 自分の下書きを編集する | ○ | ○ | ○ | × |
| ナレッジ編集画面 | 他人の下書きを編集する | ○ | ○ | × | × |
| ナレッジ編集画面 | 公開済みナレッジを編集する | ○ | ○ | × | × |
| ナレッジ編集画面 | ナレッジを公開する | ○ | ○ | × | × |
| ナレッジ編集画面 | 公開範囲を変更する | ○ | ○ | × | × |
| ナレッジ一覧 (プロジェクト内) | 自分作成を削除 | ○ | ○ | ○ | × |
| ナレッジ一覧 (プロジェクト内) | 他人作成を削除 | × | × | × | × |
| 全ナレッジ画面 | 削除する (モデレーション) | ○ | × | × | × |

### 7.9 振り返り画面

| 画面 | 操作 | システム管理者 | PM/TL | メンバー | 閲覧者 |
|---|---|---:|---:|---:|---:|
| 振り返り画面 | 振り返り内容を見る | ○ | ○ | ○ | ○ |
| 振り返り画面 | 振り返りを新規作成する | ○ | ○ | × | × |
| 振り返り画面 | 振り返り本体を編集する | ○ | ○ | × | × |
| 振り返り画面 | 振り返りコメントを投稿する | ○ | ○ | ○ | × |
| 振り返り画面 | 振り返りを確定する | ○ | ○ | × | × |
| 振り返り画面 | ナレッジ化対象を指定する | ○ | ○ | △ | × |

### 7.9.1 ステークホルダー画面 (PMBOK 13 / feat/stakeholder-management で追加)

| 画面 | 操作 | システム管理者 | PM/TL | メンバー | 閲覧者 |
|---|---|---:|---:|---:|---:|
| プロジェクト詳細「ステークホルダー」タブ | タブを表示する | ○ | ○ | × | × |
| ステークホルダー一覧 | 一覧を見る | ○ | ○ | × | × |
| ステークホルダー一覧 | 4 象限ヒートマップを見る | ○ | ○ | × | × |
| ステークホルダー登録画面 | 新規登録する | ○ | ○ | × | × |
| ステークホルダー編集画面 | 内容を編集する | ○ | ○ | × | × |
| ステークホルダー編集画面 | 影響度 / 関心度を変更する | ○ | ○ | × | × |
| ステークホルダー編集画面 | 姿勢を変更する | ○ | ○ | × | × |
| ステークホルダー編集画面 | エンゲージメント水準を変更する | ○ | ○ | × | × |
| ステークホルダー編集画面 | 人となり / 戦略メモを編集する | ○ | ○ | × | × |
| ステークホルダー一覧 | 論理削除する | ○ | ○ | × | × |

**設計理由**:
個人情報 (連絡先、所属、役職) と人物評 (考え方、接し方のコツ) を含むため、
**メンバー / 閲覧者には一切公開しない**。同じ「プロジェクト関係者」を扱う
メンバー管理タブとは責務が異なる (メンバー管理は SSO アカウント割り当て、
ステークホルダー管理は人物評込みの戦略整理)。

### 7.10 ログ・監査系画面

| 画面 | 操作 | システム管理者 | PM/TL | メンバー | 閲覧者 |
|---|---|---:|---:|---:|---:|
| 監査ログ画面 | システム監査ログを見る | ○ | × | × | × |
| 権限変更履歴画面 | 権限変更履歴を見る | ○ | × | × | × |
| 更新履歴画面 | プロジェクト内の更新履歴を見る | ○ | ○ | △ | × |

### 7.11 参考タブ (Suggestions、PR #65 + feat/crud-permission-redesign 2026-05-20)

過去プロジェクトの資産を類似度スコア付きで提案し、現在のプロジェクトへの紐付け (adopt) を行う PM/TL 判断機能。

| 操作 | システム管理者 | PM/TL | メンバー | 閲覧者 |
|---|---:|---:|---:|---:|
| 参考タブを表示する | ○ | ○ | × | × |
| 提案を閲覧する | ○ | ○ | × | × |
| 提案を採用 (プロジェクトに紐付け) する | ○ | ○ | × | × |
| 「なぜ提案された?」を見る | ○ | ○ | × | × |
| 過去課題の inline 提案 (related-issues) | ○ | ○ | × | × |

**設計理由**: 過去資産のプロジェクト紐付けは資産棚卸し・採用判断を伴う PM 業務であり、
member/viewer の閲覧自体を許可するとプロジェクト棚卸し中の中間状態が表に出てしまうため。

### 7.12 全メモ画面 (feat/crud-permission-redesign 2026-05-20 更新)

| 操作 | システム管理者 | PM/TL | メンバー | 閲覧者 |
|---|---:|---:|---:|---:|
| 公開メモ一覧を見る | ○ | ○ | ○ | ○ |
| 他人 public メモを削除する (モデレーション) | ○ | × | × | × |
| 他人 private メモを参照する | × | × | × | × |
| 他人 private メモを削除する | × | × | × | × |

**設計理由**: admin は public メモのモデレーション責務を持つが、private メモは
プライバシー保護のため admin であっても参照・削除不可。

---

## 変更履歴 (feat/crud-permission-redesign, 2026-05-20)

- §7.1 メンバー管理: PM/TL の `member:manage` を開放。「PM/TL ロール」操作のみ admin 限定で残置 (細粒度ガード)
- §7.3 見積もりタブ: タブ可視性を明文化 (member/viewer は UI/API 双方で 404/403)
- §7.7-§7.9 ○○一覧の削除: 「○○一覧」(プロジェクト内) は作成者本人のみ、「全○○」(横断) は admin のみ。route 経路 + service context 引数で経路別認可
- §7.11 参考タブ: 新規セクション (PM/TL + admin 限定)
- §7.12 全メモ画面: admin の public モデレーション削除特権を明文化、private は admin にも非可視

## 変更履歴 (feat/asset-assignee-expansion, 2026-05-26)

**目的**: リスク/課題/ナレッジ/振り返り/メモの編集権限を「作成者本人のみ」から「作成者 OR 担当者」に拡張。
退職・配転等で原作成者がアクセスできなくなった資産を、引継ぎ後の担当者が継続管理できるようにする。

- **対象 4 資産**: Risk/Issue (RiskIssue) / Knowledge / Retrospective / Memo
- **追加列**: Knowledge/Retrospective/Memo に `assignee_id UUID NULL FK→users(id) ON DELETE SET NULL` 列を追加 (RiskIssue は既存)
- **認可拡張** (service 層):
  - update / delete: `createdBy === userId OR assigneeId === userId` を編集権限と判定 (旧: createdBy のみ)
  - admin の越権編集禁止は維持 (= 削除のみ admin 介入可能、編集は本人系のみ)
  - Memo private は assignee 指定不可方針 (UI 上 selector 非表示)、public memo のみ assignee 設定可
- **DTO 拡張**: `assigneeId` / `assigneeName` / `viewerCanEdit` (= `createdBy === viewer OR assigneeId === viewer`) を 4 サービスの DTO に追加
- **UI 反映**:
  - 編集 dialog: 担当者プルダウン (members prop 受領時のみ表示、未受領は selector 非表示)
  - 一覧 readOnly 判定: 作成者 OR 担当者なら編集可 (旧: 作成者のみ)
  - bulk 選択 (selectableIds): 作成者 OR 担当者を対象 (旧: 作成者のみ)
  - 行アクション (削除ボタン等): 作成者 OR 担当者を対象 (旧: 作成者のみ)
- **API 受入**: validator (`createXxxSchema` / `updateXxxSchema`) に `assigneeId: z.string().uuid().nullable().optional()` を追加

## 変更履歴 (docs/design-business-refactor-integrity, 2026-05-31)

権限実装 (`src/lib/permissions/`) との完全ミラー化 (§0 新設) を実施。`ROLE_PERMISSIONS` の Set を 1 件ずつ逐語照合。

- **§0 新設**: `Action` 型 全 22 種 × プロジェクトロール完全マトリクス (§0.4) を実装から逐語反映
- **システムロール 3 階層** (super_admin/admin/general) とプロジェクトロール昇格挙動 (§0.1-0.2) を明文化
- **★既知の死角★** super_admin は `checkPermission` の admin 短絡 (line 126 は admin のみ) に該当せず、pm_tl 評価となるため `project:delete` を持たない点を注記 (§0.3)
- member 所有者条件 (§0.5) / 状態制約 `STATE_RESTRICTIONS` (§0.6) / PM/TL 細粒度ガード (§0.7) / 自己ロール変更禁止 ADR-0014 (§0.8) を実装行番号付きで反映
- **是正**: §7.8 の obsolete 行「ナレッジを論理削除する (旧表記)」(admin/pm_tl/member すべて△) を削除 — 実装に対応する Action が無く、直上の行 (§7.8) と矛盾していたため

---
