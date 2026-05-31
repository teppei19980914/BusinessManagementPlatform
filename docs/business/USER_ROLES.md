# ユーザロールと権限制御方針 (Business Logic)

本ドキュメントは、システムロール (super_admin / admin / general) とプロジェクトロール (pm_tl / member / viewer) の定義、および権限制御の基本方針を集約する。画面別の権限マトリクスは [specification/PERMISSION_MATRIX.md](../specification/PERMISSION_MATRIX.md)、認可の技術設計は [security/](../security/) または [archive/developer/DESIGN.md §8〜§9](../archive/developer/DESIGN.md) を参照。

> 実装の真値: システムロールは `src/config/master-data.ts` の `SYSTEM_ROLES` (3 値)、プロジェクトロールは `PROJECT_ROLES` (3 値)。ロール判定ヘルパは `src/lib/permissions/role.ts` (`isSuperAdmin` / `isTenantAdmin` / `isAdminOrAbove`)。

---

## 利用ロールと権限制御方針 (SPEC §6 から転記)

## 6. 利用ロールと権限制御方針

### 6.1 権限制御方式
本システムでは、ロールベースアクセス制御（RBAC）を採用する。

ユーザは以下の2種類のロールを持つ。

- **システムロール**: ユーザに対して1つ（システム全体の権限）
- **プロジェクトロール**: プロジェクトごとに0個以上（プロジェクト単位の権限）

### 6.1.1 プロジェクトメンバーシップ

プロジェクトへの参加は「プロジェクトメンバーシップ」によって管理される。
プロジェクトメンバーシップとは、ユーザとプロジェクトの紐付けであり、プロジェクトごとにプロジェクトロール（PM/TL・メンバー・閲覧者）を個別に設定する仕組みである。

#### 設計意図
同一ユーザが複数プロジェクトに参加する場合、プロジェクトごとに異なるロールを持てるようにする。
これにより、あるプロジェクトではリーダーとして運営責任を担い、別のプロジェクトではメンバーとして作業に従事する、といった柔軟な権限運用が可能になる。

#### 具体例

| ユーザ | プロジェクトA | プロジェクトB | プロジェクトC |
|---|---|---|---|
| Aさん | PM/TL | メンバー | （未参加） |
| Bさん | メンバー | PM/TL | 閲覧者 |
| Cさん | メンバー | メンバー | PM/TL |

#### ルール

- 1ユーザは同一プロジェクトに1つのプロジェクトロールのみ持てる（重複不可）
- プロジェクトに参加していないユーザは、そのプロジェクトの情報にアクセスできない（システム管理者を除く）
- プロジェクトメンバーシップの追加・変更・解除は、システム管理者 (admin / super_admin) に加え、**PM/TL も自プロジェクト内で実行できる** (ADR-0014 / feat/crud-permission-redesign 2026-05-20)。ただし「PM/TL ロール」を扱う操作は admin 限定。詳細は §6.6.1 を正仕様とする

### 6.2 システムロール

システムロールは **3 階層** (PR-X1 / 2026-05-07、`SYSTEM_ROLES` @ `src/config/master-data.ts:193-197`)。
既存の `=== 'admin'` チェックは「テナント管理者」を意味し続ける (意味再解釈)。全テナント横断用途は `isSuperAdmin()` ヘルパで判定する (`src/lib/permissions/role.ts`)。

| キー (DB 値) | 表示ラベル | スコープ | 概要 |
|---|---|---|---|
| `super_admin` | システム管理者 | プラットフォーム運営者専用 (管理テナント所属) | 全テナント横断アクセス。テナント suspend/resume・課金 DLQ・cron 監視等の運営機能 |
| `admin` | テナント管理者 | 自テナント内 | 自テナント内の全権限 (= 従来の「システム管理者」の意味を再解釈) |
| `general` | 一般ユーザ | 自テナント内 | プロジェクト/役割に応じた権限 |

> 日本語ラベルは PR-X3 で「テナント管理者」「システム管理者」へ変更予定 (現状の表示は既存維持)。

#### super_admin (システム管理者 / プラットフォーム運営者)
- 全テナント横断の参照・管理 (テナント suspend/resume/export/recalculate 等)
- `checkMembership` で全テナントのプロジェクトに `pm_tl` 相当でアクセス可 (テナント越境バイパスは super_admin のみ許可、`membership.ts:81-93`)
- 課金 DLQ 再送・cron 実行履歴監視 等の運営専用機能

#### admin (テナント管理者)
- ユーザ管理 (自テナント内)
- システムロール設定/変更・プロジェクトロール設定/変更
- 自テナント全プロジェクト参照
- 必要に応じた代理更新
- 監査ログ参照
- マスタ管理

#### general (一般ユーザ)
- 自身に付与されたプロジェクトロールに応じた操作のみ可能
- システムロールの権限変更不可

### 6.3 プロジェクトロール

#### PM/TL
- プロジェクト運営責任者
- 見積もり、WBS、タスク、リスク、振り返りの管理
- プロジェクト状態遷移
- 自プロジェクト内のメンバー管理 (member/viewer の追加・解除・ロール変更)。ただし「PM/TL ロール」を扱う操作は admin 限定 — 詳細は §6.6.1 を正仕様とする
- ステークホルダー管理 (CRUD、人物評を含むため member 以下は閲覧不可)

#### メンバー
- 自分の担当タスク更新
- 実績入力
- リスク/課題起票
- ナレッジ下書き登録

#### 閲覧者
- 閲覧のみ

### 6.4 権限変更ルール

- システムロールの設定・変更・解除はシステム管理者 (admin / super_admin) のみが実行できる。プロジェクトロールは §6.6.1 の通り PM/TL も一部実行可 (PM/TL ロールを扱う操作は admin 限定)
- 一般ユーザは、自身または他ユーザの権限を変更できない
- **自己ロール変更禁止 (ADR-0014 / feat/crud-permission-redesign 2026-05-20)**: admin/super_admin であっても、自分自身のシステムロール・プロジェクトロールは変更できない。自己昇格・自己降格による特権昇格 / テナント管理者不在化を構造的に防ぐため、3 経路すべてを遮断する:
  - admin/users 管理画面: `CANNOT_CHANGE_OWN_ROLE`
  - プロジェクトメンバー管理: `CANNOT_CHANGE_OWN_PROJECT_ROLE` (`member.service.ts:157-159`)
  - super_admin への昇格 UI: そもそも UI 非表示 (自己昇格経路を物理的に作らない)
- 権限変更時は、変更者、変更日時、変更対象、変更前ロール、変更後ロールを `roleChangeLog` に記録する
- 権限変更は保存後に即時反映する (対象ユーザの全セッションを無効化)

### 6.5 公開範囲 (visibility)

公開範囲は **2 値体系** (PR #60 で統合、`VISIBILITIES` @ `src/config/master-data.ts:161-164`)。リスク/課題・振り返り・ナレッジの 3 エンティティ共通で使用。従来の `project` / `company` は migration で全て `public` に集約済 (20260418 migration)。

| キー (DB 値) | 表示ラベル | 閲覧範囲 |
|---|---|---|
| `draft` | 下書き | 作成者本人 + admin のみ閲覧可 (個別 GET で他者は「存在しない」扱い) |
| `public` | 公開 | 全ログインユーザが閲覧可 |

### 6.6 削除方針 (feat/crud-permission-redesign 2026-05-20 改訂)

- 削除は物理削除ではなく論理削除とする (Memo / Knowledge / RiskIssue / Retrospective / Project)
- 経路別認可:
  - **「○○一覧」(プロジェクト内)** からの削除: **作成者本人のみ** (PM/TL も admin も他人作成は不可)
  - **「全○○」(横断)** からの削除: **テナント管理者 (admin) のみ** (モデレーション用途)
- 経路は API レベルで分離 (`/api/projects/[id]/{resource}/[id]` vs `/api/{resource}/[id]`)
- メモは特殊: admin は **public のメモのみ** モデレーション削除可、private は admin にも非可視
- service 層では `context: 'project' | 'global'` 引数で経路別の権限を enforce

### 6.6.1 メンバー管理 (feat/crud-permission-redesign 2026-05-20 改訂)

- 旧仕様: メンバーの追加・解除・ロール変更は **システム管理者のみ**
- 新仕様: **PM/TL も実行可** (運営責任者として「自プロジェクト内のメンバー補充」を可能に)
- ただし「PM/TL ロール」を扱う以下 4 操作は引き続き **admin のみ** (権限委譲リスク回避):
  - PM/TL の新規追加
  - PM/TL の削除
  - PM/TL への昇格 (member/viewer → PM/TL)
  - PM/TL からの降格 (PM/TL → member/viewer)
- 細粒度判定は `src/services/member.service.ts` で実施 (`FORBIDDEN_PMTL_ROLE`)

### 6.7 マルチテナント User Membership (ADR-0016 / 2026-05-20)

ロール体系の前提となるテナント所属モデル。詳細は [ADR-0016](../adr/0016-multi-tenant-user-membership.md) を正仕様とする。

- **email の一意性は tenant スコープ**: `User.email` は `@@unique([tenantId, email])` (旧: グローバル一意)。同一個人が複数テナントに同一 email で所属可能。テナント削除後の email 再利用も衝突しない
- **認証フローは組織 ID 入力方式 (Option B)**: ログイン / パスワードリセット / lock-status の pre-auth で「組織 ID (tenant slug)」を明示入力させる。メールリンクには URL クエリで `?tenant=<slug>` を埋め込む
- **super_admin の横断管理**: super_admin は管理テナント (MANAGEMENT) 所属で、全テナント横断の参照・管理が可能。テナント越境チェック (`membership.ts:81`) でも super_admin のみバイパスが許可される
- **Beginner 払い出し eligibility (3 層判定)**: 過去に自前テナントを保有した email は公開フォームからの新規 Beginner 払い出しを制限 (`OWNED_TENANT_EXISTS` / `BEGINNER_REQUIRES_UPGRADE`)。super_admin 経由のテナント作成は本判定を全スキップ

### 6.8 既知の実装上の死角 (要修正候補)

- **super_admin が `checkPermission` で `project:delete` を拒否される** (`src/lib/permissions/check-permission.ts:126`):
  `checkPermission` のシステム管理者短絡は `systemRole === 'admin'` のみを対象とし、`super_admin` を含まない。
  super_admin は手前の `checkMembership` (`membership.ts:87-93`) で `projectRole: 'pm_tl'` を付与されるため、
  step 2 のロールチェックで `pm_tl` 扱いとなる。`pm_tl` の `ROLE_PERMISSIONS` には `project:delete` が含まれない (`check-permission.ts:74-86`) ため、
  **super_admin はプロジェクト削除が拒否される**。admin は短絡で通るため顕在化しにくい死角。
  修正時は step 1 の条件を `isAdminOrAbove()` 相当 (admin または super_admin) に拡張するのが妥当 (要確認 / 要 admin 承認)。

---
