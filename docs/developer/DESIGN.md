# たすきば Knowledge Relay MVP 設計書

- 作成日: 2026-04-14
- 版数: Draft v0.1
- 形式: Markdown

---

## 1. 文書概要

### 1.1 目的
本設計書は、たすきば Knowledge Relay MVP の技術設計を定義する。
要件定義書（REQUIREMENTS.md）および仕様書（SPECIFICATION.md）に基づき、アーキテクチャ、データモデル、API 設計、セキュリティ設計、インフラ構成を網羅する。

### 1.2 対象読者
- 開発者
- レビュアー
- インフラ担当者

### 1.3 関連文書
- [要件定義書](./REQUIREMENTS.md)
- [仕様書](./SPECIFICATION.md)

---

## 2. 技術スタック

### 2.1 選定方針
- MVP を短期間で構築可能な統合フレームワークを採用する
- フロントエンド・バックエンドを同一言語（TypeScript）で統一し、開発効率を高める
- ガントチャート等のリッチ UI を実現できるエコシステムを選択する
- 将来的なスケールアウトに対応可能な構成とする

### 2.2 技術構成

| レイヤー | 技術 | バージョン | 選定理由 |
|---|---|---|---|
| 言語 | TypeScript | 5.x | 型安全性、フロント/バック統一 |
| フロントエンド | Next.js (App Router) | 16.x | SSR/SSG、API Routes 統合、React エコシステム |
| UI ライブラリ | React | 19.x | コンポーネント指向、エコシステムの豊富さ |
| UI コンポーネント | shadcn/ui + Tailwind CSS | - | カスタマイズ性、軽量、アクセシビリティ |
| ガントチャート | @neodrag/gantt または自前実装 | - | MVP では読み取り専用のため軽量ライブラリで十分 |
| 状態管理 | TanStack Query (React Query) | 5.x | サーバ状態管理、キャッシュ、楽観的更新 |
| フォーム | React Hook Form + Zod | - | バリデーション共有（フロント/バック） |
| ORM | Prisma | 7.x | 型安全なクエリ、マイグレーション管理、pg adapter 方式 |
| データベース | PostgreSQL | 16.x | JSONB 対応、全文検索、信頼性 |
| 認証 | NextAuth.js (Auth.js) | 5.x | Credentials + OAuth 対応、セッション管理 |
| MFA | otplib | 13.x | TOTP（RFC 6238）対応 |
| QR コード | qrcode | 1.x | MFA 設定用 QR コード生成 |
| テスト | Vitest | 4.x | 単体テスト（141件） |
| Lint / Format | ESLint + Prettier | - | コード品質、一貫性 |
| CI/CD | GitHub Actions | - | リポジトリ統合 |
| コンテナ | Docker + Docker Compose | - | ローカル開発環境の統一 |

---

## 3. アーキテクチャ概要

### 3.1 システム構成図

```
┌─────────────────────────────────────────────────────────────┐
│                        Client (Browser)                     │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              Next.js Frontend (React)                 │  │
│  │  ┌─────────┐ ┌──────────┐ ┌───────────┐ ┌─────────┐ │  │
│  │  │プロジェクト│ │ タスク/WBS │ │ ガントチャート│ │ナレッジ │ │  │
│  │  └─────────┘ └──────────┘ └───────────┘ └─────────┘ │  │
│  │  ┌─────────┐ ┌──────────┐ ┌───────────┐ ┌─────────┐ │  │
│  │  │ 見積もり │ │リスク/課題│ │  振り返り  │ │ユーザ管理│ │  │
│  │  └─────────┘ └──────────┘ └───────────┘ └─────────┘ │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────┬───────────────────────────────────┘
                          │ HTTPS
┌─────────────────────────┴───────────────────────────────────┐
│                    Next.js Server (Node.js)                  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                  App Router (SSR)                     │   │
│  │  ┌──────────┐  ┌──────────┐  ┌────────────────────┐ │   │
│  │  │Server    │  │Server    │  │  Static Generation │ │   │
│  │  │Components│  │Actions   │  │  (ISR)             │ │   │
│  │  └──────────┘  └──────────┘  └────────────────────┘ │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                   API Layer                           │   │
│  │  ┌───────────┐  ┌───────────┐  ┌──────────────────┐ │   │
│  │  │ Route     │  │Middleware │  │  Zod Validation  │ │   │
│  │  │ Handlers  │  │(Auth/RBAC)│  │                  │ │   │
│  │  └───────────┘  └───────────┘  └──────────────────┘ │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                 Service Layer                         │   │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────────┐ │   │
│  │  │ Business   │  │ Permission │  │  State Machine │ │   │
│  │  │ Logic      │  │ Guard      │  │  (Project)     │ │   │
│  │  └────────────┘  └────────────┘  └────────────────┘ │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │               Data Access Layer (Prisma)              │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────┬───────────────────────────────────┘
                          │ TCP/5432
┌─────────────────────────┴───────────────────────────────────┐
│                     PostgreSQL 16                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐   │
│  │ projects │ │  tasks   │ │knowledges│ │ audit_logs   │   │
│  │ users    │ │estimates │ │ risks    │ │ role_changes  │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 レイヤー構成

```
src/
├── app/                          # Next.js App Router
│   ├── (auth)/                   # 認証関連ページ
│   │   ├── login/
│   │   └── register/
│   ├── (dashboard)/              # 認証済みレイアウト
│   │   ├── projects/             # プロジェクト関連
│   │   │   ├── page.tsx          # プロジェクト一覧
│   │   │   └── [projectId]/
│   │   │       ├── page.tsx      # プロジェクト詳細
│   │   │       ├── estimates/    # 見積もり管理
│   │   │       ├── tasks/        # WBS管理
│   │   │       ├── gantt/        # ガントチャート
│   │   │       ├── risks/        # リスク/課題管理
│   │   │       ├── knowledge/    # ナレッジ管理
│   │   │       ├── retrospectives/ # 振り返り
│   │   │       └── members/      # メンバー管理
│   │   ├── my-tasks/             # マイタスク
│   │   ├── knowledge/            # ナレッジ横断検索
│   │   └── admin/                # システム管理
│   │       ├── users/            # ユーザ管理
│   │       └── audit-logs/       # 監査ログ
│   ├── api/                      # API Route Handlers
│   │   ├── auth/                 # 認証 API
│   │   ├── projects/
│   │   ├── tasks/
│   │   ├── estimates/
│   │   ├── risks/
│   │   ├── knowledge/
│   │   ├── retrospectives/
│   │   └── admin/
│   ├── layout.tsx
│   └── globals.css
├── components/                   # 共通UIコンポーネント
│   ├── ui/                       # shadcn/ui ベース
│   ├── forms/                    # フォームコンポーネント
│   ├── tables/                   # テーブルコンポーネント
│   └── gantt/                    # ガントチャート
├── lib/                          # ユーティリティ
│   ├── db.ts                     # Prisma Client
│   ├── auth.ts                   # NextAuth 設定
│   ├── validators/               # Zod スキーマ
│   └── permissions/              # 権限チェック
├── services/                     # ビジネスロジック
│   ├── project.service.ts
│   ├── task.service.ts
│   ├── estimate.service.ts
│   ├── risk.service.ts
│   ├── knowledge.service.ts
│   ├── retrospective.service.ts
│   └── state-machine.ts         # プロジェクト状態遷移
├── types/                        # 型定義
└── prisma/                       # Prisma
    ├── schema.prisma
    └── migrations/
```

### 3.3 設計原則

| 原則 | 適用方針 |
|---|---|
| レイヤー分離 | Route Handler → Service → Prisma の 3 層 |
| 権限チェック | Service 層で統一実施。Middleware で認証のみ |
| 状態遷移 | State Machine パターンでプロジェクト状態を管理 |
| バリデーション | Zod スキーマをフロント/バックで共有 |
| 論理削除 | 全テーブルに `deleted_at` カラム。クエリで自動フィルタ |
| 監査 | 権限変更・状態変更は専用テーブルに記録 |

---

## 4. データモデル

### 4.1 ER 図

```mermaid
erDiagram
    users {
        uuid id PK
        varchar name
        varchar email UK
        varchar password_hash
        enum system_role "admin | general"
        boolean is_active
        integer failed_login_count
        timestamp locked_until
        boolean permanent_lock
        boolean mfa_enabled
        varchar mfa_secret_encrypted
        timestamp mfa_enabled_at
        timestamp last_login_at
        timestamp created_at
        timestamp updated_at
        timestamp deleted_at
    }

    recovery_codes {
        uuid id PK
        uuid user_id FK
        varchar code_hash
        timestamp used_at
        timestamp created_at
    }

    email_verification_tokens {
        uuid id PK
        uuid user_id FK
        varchar token_hash
        timestamp expires_at
        timestamp used_at
        timestamp created_at
    }

    password_reset_tokens {
        uuid id PK
        uuid user_id FK
        varchar token_hash
        timestamp expires_at
        timestamp used_at
        timestamp created_at
    }

    password_histories {
        uuid id PK
        uuid user_id FK
        varchar password_hash
        timestamp created_at
    }

    auth_event_logs {
        uuid id PK
        varchar event_type
        uuid user_id FK
        varchar email
        varchar ip_address
        text user_agent
        jsonb detail
        timestamp created_at
    }

    operation_trace_logs {
        uuid id PK
        uuid user_id FK
        varchar session_id
        uuid request_id
        varchar http_method
        varchar path
        jsonb query_params
        varchar entity_type
        uuid entity_id
        varchar action
        varchar ip_address
        text user_agent
        integer response_status
        integer duration_ms
        timestamp created_at
    }

    projects {
        uuid id PK
        varchar name
        uuid customer_id FK "PR #111-2: customers.id / ON DELETE SET NULL"
        text purpose
        text background
        text scope
        text out_of_scope
        enum dev_method "scratch | power_platform | package | other"
        varchar tech_stack_tags "JSONB array"
        varchar business_domain_tags "JSONB array"
        date planned_start_date
        date planned_end_date
        enum status "planning | estimating | scheduling | executing | completed | retrospected | closed"
        text notes
        uuid created_by FK
        uuid updated_by FK
        timestamp created_at
        timestamp updated_at
        timestamp deleted_at
    }

    project_members {
        uuid id PK
        uuid project_id FK
        uuid user_id FK
        enum project_role "pm_tl | member | viewer"
        uuid assigned_by FK
        timestamp created_at
        timestamp updated_at
    }

    estimates {
        uuid id PK
        uuid project_id FK
        varchar item_name
        enum category "requirements | design | development | testing | other"
        enum dev_method "scratch | power_platform | package | other"
        decimal estimated_effort
        enum effort_unit "person_hour | person_day"
        text rationale
        text preconditions
        boolean is_confirmed
        text notes
        uuid created_by FK
        uuid updated_by FK
        timestamp created_at
        timestamp updated_at
        timestamp deleted_at
    }

    tasks {
        uuid id PK
        uuid project_id FK
        uuid parent_task_id FK
        enum type "work_package | activity"
        varchar wbs_number
        varchar name
        text description
        enum category "requirements | design | development | testing | review | management | other"
        uuid assignee_id FK "nullable - WP は null"
        date planned_start_date "nullable - WP は子から自動計算"
        date planned_end_date "nullable - WP は子から自動計算"
        decimal planned_effort "WP は子の合計を自動計算"
        enum priority "low | medium | high"
        enum status "not_started | in_progress | completed | on_hold"
        integer progress_rate "0-100 - WP は子の加重平均"
        boolean is_milestone
        text notes
        uuid created_by FK
        uuid updated_by FK
        timestamp created_at
        timestamp updated_at
        timestamp deleted_at
    }

    task_progress_logs {
        uuid id PK
        uuid task_id FK
        uuid updated_by FK
        date update_date
        integer progress_rate "0-100"
        decimal actual_effort
        decimal remaining_effort
        enum status "not_started | in_progress | completed | on_hold"
        boolean is_delayed
        text delay_reason
        text work_memo
        boolean has_issue
        text next_action
        date completed_date
        timestamp created_at
    }

    risks_issues {
        uuid id PK
        uuid project_id FK
        enum type "risk | issue"
        varchar title
        text content
        text cause
        enum impact "low | medium | high"
        enum likelihood "low | medium | high"
        enum priority "low | medium | high"
        text response_policy
        text response_detail
        uuid reporter_id FK
        uuid assignee_id FK
        date deadline
        enum state "open | in_progress | monitoring | resolved"
        text result
        text lesson_learned
        uuid created_by FK
        uuid updated_by FK
        timestamp created_at
        timestamp updated_at
        timestamp deleted_at
    }

    knowledges {
        uuid id PK
        varchar title
        enum knowledge_type "research | verification | incident | decision | lesson | best_practice | other"
        text background
        text content
        text result
        text conclusion
        text recommendation
        enum reusability "low | medium | high"
        varchar tech_tags "JSONB array"
        enum dev_method "scratch | power_platform | package | other"
        varchar process_tags "JSONB array"
        enum visibility "draft | project | company"
        uuid created_by FK
        uuid updated_by FK
        timestamp created_at
        timestamp updated_at
        timestamp deleted_at
    }

    retrospectives {
        uuid id PK
        uuid project_id FK
        date conducted_date
        text plan_summary
        text actual_summary
        text good_points
        text problems
        text estimate_gap_factors
        text schedule_gap_factors
        text quality_issues
        text risk_response_evaluation
        text improvements
        text knowledge_to_share
        enum state "draft | confirmed"
        uuid created_by FK
        uuid updated_by FK
        timestamp created_at
        timestamp updated_at
        timestamp deleted_at
    }

    retrospective_comments {
        uuid id PK
        uuid retrospective_id FK
        uuid user_id FK
        text content
        timestamp created_at
    }

    decisions {
        uuid id PK
        uuid project_id FK
        varchar title
        text background
        text issue
        text options
        text decision_content
        text decision_reason
        date decided_date
        uuid decided_by FK
        text impact_scope
        uuid created_by FK
        uuid updated_by FK
        timestamp created_at
        timestamp updated_at
        timestamp deleted_at
    }

    change_requests {
        uuid id PK
        uuid project_id FK
        text request_content
        text reason
        uuid requester_id FK
        text impact_target
        text impact_assessment
        boolean needs_approval
        enum approval_status "pending | approved | rejected"
        text applied_content
        enum state "open | applied | rejected | cancelled"
        uuid created_by FK
        uuid updated_by FK
        timestamp created_at
        timestamp updated_at
        timestamp deleted_at
    }

    audit_logs {
        uuid id PK
        uuid user_id FK
        varchar action
        varchar entity_type
        uuid entity_id
        jsonb before_value
        jsonb after_value
        varchar ip_address
        timestamp created_at
    }

    role_change_logs {
        uuid id PK
        uuid changed_by FK
        uuid target_user_id FK
        enum change_type "system_role | project_role"
        uuid project_id FK
        varchar before_role
        varchar after_role
        text reason
        timestamp created_at
    }

    %% Relationships
    projects ||--o{ project_members : "has"
    users ||--o{ project_members : "belongs to"
    projects ||--o{ estimates : "has"
    projects ||--o{ tasks : "has"
    tasks ||--o{ tasks : "parent-child"
    tasks ||--o{ task_progress_logs : "has"
    users ||--o{ task_progress_logs : "updates"
    projects ||--o{ risks_issues : "has"
    projects ||--o{ retrospectives : "has"
    retrospectives ||--o{ retrospective_comments : "has"
    projects ||--o{ decisions : "has"
    projects ||--o{ change_requests : "has"
    users ||--o{ audit_logs : "performs"
    users ||--o{ role_change_logs : "changes"
    users ||--o{ recovery_codes : "has"
    users ||--o{ email_verification_tokens : "has"
    users ||--o{ password_reset_tokens : "has"
    users ||--o{ password_histories : "has"
    users ||--o{ operation_trace_logs : "traced"
    users ||--o{ auth_event_logs : "logged"
```

### 4.2 多対多リレーションテーブル

```mermaid
erDiagram
    estimate_knowledges {
        uuid id PK
        uuid estimate_id FK
        uuid knowledge_id FK
    }

    task_knowledges {
        uuid id PK
        uuid task_id FK
        uuid knowledge_id FK
    }

    task_risks {
        uuid id PK
        uuid task_id FK
        uuid risk_issue_id FK
    }

    task_estimates {
        uuid id PK
        uuid task_id FK
        uuid estimate_id FK
    }

    task_dependencies {
        uuid id PK
        uuid task_id FK
        uuid depends_on_task_id FK
    }

    risk_knowledges {
        uuid id PK
        uuid risk_issue_id FK
        uuid knowledge_id FK
    }

    decision_tasks {
        uuid id PK
        uuid decision_id FK
        uuid task_id FK
    }

    decision_risks {
        uuid id PK
        uuid decision_id FK
        uuid risk_issue_id FK
    }

    decision_knowledges {
        uuid id PK
        uuid decision_id FK
        uuid knowledge_id FK
    }

    knowledge_projects {
        uuid id PK
        uuid knowledge_id FK
        uuid project_id FK
    }

    retrospective_knowledges {
        uuid id PK
        uuid retrospective_id FK
        uuid knowledge_id FK
    }

    knowledge_links {
        uuid id PK
        uuid knowledge_id FK
        varchar url
        varchar label
    }
```

---

## 5. テーブル定義書

### 5.1 users（ユーザ）

| カラム名 | 型 | NULL | デフォルト | 説明 |
|---|---|---|---|---|
| id | UUID | NO | gen_random_uuid() | 主キー |
| name | VARCHAR(100) | NO | - | ユーザ名 |
| email | VARCHAR(255) | NO | - | メールアドレス（ログインID）。UNIQUE |
| password_hash | VARCHAR(255) | NO | - | bcrypt ハッシュ済みパスワード |
| system_role | VARCHAR(20) | NO | 'general' | システムロール: admin / general |
| is_active | BOOLEAN | NO | true | 有効/無効 |
| failed_login_count | INTEGER | NO | 0 | ログイン失敗回数 |
| locked_until | TIMESTAMPTZ | YES | NULL | 一時ロック解除日時 |
| permanent_lock | BOOLEAN | NO | false | 恒久ロックフラグ |
| mfa_enabled | BOOLEAN | NO | false | MFA 有効フラグ |
| mfa_secret_encrypted | VARCHAR(255) | YES | NULL | 暗号化された TOTP シークレットキー |
| mfa_enabled_at | TIMESTAMPTZ | YES | NULL | MFA 有効化日時 |
| last_login_at | TIMESTAMPTZ | YES | NULL | 最終ログイン日時 |
| created_at | TIMESTAMPTZ | NO | now() | 作成日時 |
| updated_at | TIMESTAMPTZ | NO | now() | 更新日時 |
| deleted_at | TIMESTAMPTZ | YES | NULL | 論理削除日時 |

**インデックス**: `idx_users_email` (email, UNIQUE, WHERE deleted_at IS NULL)

### 5.2 projects（プロジェクト）

| カラム名 | 型 | NULL | デフォルト | 説明 |
|---|---|---|---|---|
| id | UUID | NO | gen_random_uuid() | 主キー |
| name | VARCHAR(100) | NO | - | プロジェクト名 |
| customer_id | UUID | NO | - | 顧客 FK (PR #111-2 以降): customers.id / ON DELETE SET NULL |
| purpose | TEXT | NO | - | 目的（2000文字以内） |
| background | TEXT | NO | - | 背景（2000文字以内） |
| scope | TEXT | NO | - | スコープ（2000文字以内） |
| out_of_scope | TEXT | YES | NULL | スコープ外（2000文字以内） |
| dev_method | VARCHAR(30) | NO | - | 開発方式 |
| business_domain_tags | JSONB | YES | '[]' | 対象業務領域（タグ配列） |
| tech_stack_tags | JSONB | YES | '[]' | 技術スタック（タグ配列） |
| planned_start_date | DATE | NO | - | 開始予定日 |
| planned_end_date | DATE | NO | - | 終了予定日 |
| status | VARCHAR(20) | NO | 'planning' | プロジェクト状態 |
| notes | TEXT | YES | NULL | 備考（2000文字以内） |
| created_by | UUID | NO | - | 作成者（FK: users.id） |
| updated_by | UUID | NO | - | 更新者（FK: users.id） |
| created_at | TIMESTAMPTZ | NO | now() | 作成日時 |
| updated_at | TIMESTAMPTZ | NO | now() | 更新日時 |
| deleted_at | TIMESTAMPTZ | YES | NULL | 論理削除日時 |

**status の値**: planning / estimating / scheduling / executing / completed / retrospected / closed

**インデックス**:
- `idx_projects_status` (status, WHERE deleted_at IS NULL)
- `idx_projects_customer_id` (customer_id) — PR #111-2 以降、`customer_name` 列は廃止

### 5.2b customers（顧客 / PR #111-1 新設、#111-2 完全移行）

プロジェクト発注元の顧客マスタ。`Project.customer_id` が本テーブルへの FK を持つ (1:N)。

| カラム名 | 型 | NULL | デフォルト | 説明 |
|---|---|---|---|---|
| id | UUID | NO | gen_random_uuid() | 主キー |
| name | VARCHAR(100) | NO | - | 顧客名 |
| department | VARCHAR(100) | YES | NULL | 部門 |
| contact_person | VARCHAR(100) | YES | NULL | 担当者氏名 |
| contact_email | VARCHAR(255) | YES | NULL | 担当者メール |
| notes | TEXT | YES | NULL | 備考（1000文字以内） |
| created_by | UUID | NO | - | 作成者（FK: users.id） |
| updated_by | UUID | NO | - | 更新者（FK: users.id） |
| created_at | TIMESTAMPTZ | NO | now() | 作成日時 |
| updated_at | TIMESTAMPTZ | NO | now() | 更新日時 |

**削除方針**: 物理削除 (`deleted_at` 列を持たない)。`Project.customer_id` FK は `ON DELETE SET NULL` のため、
論理削除済 Project の `customer_id` は Customer 物理削除時に自動 null 化される。active Project が
残存する場合は `deleteCustomerCascade` で関連資源を先にカスケード削除してから Customer を削除する。

**インデックス**: `idx_customers_name` (name)

### 5.3 project_members（プロジェクトメンバー）

ユーザとプロジェクトの多対多の紐付けを管理する中間テーブル。プロジェクトごとに異なるプロジェクトロールを付与する「プロジェクトメンバーシップ」を実現する。

```
User ──< project_members >── Project
            (project_role)
```

**設計意図**: 同一ユーザが複数プロジェクトに参加する際、プロジェクトごとに異なるロール（PM/TL・メンバー・閲覧者）を持てるようにする。例えば、Aプロジェクトではメンバーとして作業し、Bプロジェクトでは PM/TL としてプロジェクトを運営する、といった柔軟な権限運用を可能にする。

| カラム名 | 型 | NULL | デフォルト | 説明 |
|---|---|---|---|---|
| id | UUID | NO | gen_random_uuid() | 主キー |
| project_id | UUID | NO | - | FK: projects.id |
| user_id | UUID | NO | - | FK: users.id |
| project_role | VARCHAR(20) | NO | - | pm_tl / member / viewer |
| assigned_by | UUID | NO | - | 設定者（FK: users.id） |
| created_at | TIMESTAMPTZ | NO | now() | 作成日時 |
| updated_at | TIMESTAMPTZ | NO | now() | 更新日時 |

**制約**: UNIQUE(project_id, user_id) — 同一ユーザは同一プロジェクトに1つのロールのみ

**権限チェックでの利用**: Service 層の権限判定で、操作対象プロジェクトに対するユーザのプロジェクトロールをこのテーブルから取得し、操作可否を判定する（詳細はセクション 8 参照）

### 5.4 estimates（見積もり）

| カラム名 | 型 | NULL | デフォルト | 説明 |
|---|---|---|---|---|
| id | UUID | NO | gen_random_uuid() | 主キー |
| project_id | UUID | NO | - | FK: projects.id |
| item_name | VARCHAR(100) | NO | - | 見積項目名 |
| category | VARCHAR(30) | NO | - | 区分 |
| dev_method | VARCHAR(30) | NO | - | 開発方式 |
| estimated_effort | DECIMAL(10,2) | NO | - | 見積工数 |
| effort_unit | VARCHAR(20) | NO | - | 人時 / 人日 |
| rationale | TEXT | NO | - | 見積根拠（3000文字以内） |
| preconditions | TEXT | YES | NULL | 前提条件（2000文字以内） |
| is_confirmed | BOOLEAN | NO | false | 確定済みフラグ |
| notes | TEXT | YES | NULL | 備考（1000文字以内） |
| created_by | UUID | NO | - | FK: users.id |
| updated_by | UUID | NO | - | FK: users.id |
| created_at | TIMESTAMPTZ | NO | now() | 作成日時 |
| updated_at | TIMESTAMPTZ | NO | now() | 更新日時 |
| deleted_at | TIMESTAMPTZ | YES | NULL | 論理削除日時 |

### 5.5 tasks（タスク / WBS）

| カラム名 | 型 | NULL | デフォルト | 説明 |
|---|---|---|---|---|
| id | UUID | NO | gen_random_uuid() | 主キー |
| project_id | UUID | NO | - | FK: projects.id |
| parent_task_id | UUID | YES | NULL | FK: tasks.id（親タスク） |
| wbs_number | VARCHAR(50) | YES | NULL | WBS 番号（例: 1.2.3） |
| name | VARCHAR(100) | NO | - | タスク名 |
| description | TEXT | YES | NULL | タスク内容（2000文字以内） |
| category | VARCHAR(30) | NO | - | 区分 |
| assignee_id | UUID | NO | - | 担当者（FK: users.id） |
| planned_start_date | DATE | NO | - | 開始予定日 |
| planned_end_date | DATE | NO | - | 終了予定日 |
| planned_effort | DECIMAL(10,2) | NO | - | 予定工数 |
| priority | VARCHAR(10) | YES | 'medium' | 優先度: low / medium / high |
| status | VARCHAR(20) | NO | 'not_started' | ステータス |
| progress_rate | INTEGER | NO | 0 | 進捗率（0〜100） |
| is_milestone | BOOLEAN | NO | false | マイルストーンフラグ |
| notes | TEXT | YES | NULL | 備考（1000文字以内） |
| created_by | UUID | NO | - | FK: users.id |
| updated_by | UUID | NO | - | FK: users.id |
| created_at | TIMESTAMPTZ | NO | now() | 作成日時 |
| updated_at | TIMESTAMPTZ | NO | now() | 更新日時 |
| deleted_at | TIMESTAMPTZ | YES | NULL | 論理削除日時 |

**インデックス**:
- `idx_tasks_project` (project_id, WHERE deleted_at IS NULL)
- `idx_tasks_assignee` (assignee_id, WHERE deleted_at IS NULL)
- `idx_tasks_parent` (parent_task_id, WHERE deleted_at IS NULL)

### 5.6 task_progress_logs（進捗・実績ログ）

| カラム名 | 型 | NULL | デフォルト | 説明 |
|---|---|---|---|---|
| id | UUID | NO | gen_random_uuid() | 主キー |
| task_id | UUID | NO | - | FK: tasks.id |
| updated_by | UUID | NO | - | 更新者（FK: users.id） |
| update_date | DATE | NO | - | 更新日 |
| progress_rate | INTEGER | NO | - | 進捗率（0〜100） |
| actual_effort | DECIMAL(10,2) | NO | - | 実績工数 |
| remaining_effort | DECIMAL(10,2) | YES | NULL | 残工数 |
| status | VARCHAR(20) | NO | - | ステータス |
| is_delayed | BOOLEAN | NO | false | 遅延有無 |
| delay_reason | TEXT | YES | NULL | 遅延理由 |
| work_memo | TEXT | YES | NULL | 作業メモ（2000文字以内） |
| has_issue | BOOLEAN | NO | false | 課題有無 |
| next_action | TEXT | YES | NULL | 次アクション（1000文字以内） |
| completed_date | DATE | YES | NULL | 完了日 |
| created_at | TIMESTAMPTZ | NO | now() | 作成日時 |

**インデックス**: `idx_progress_task` (task_id, update_date DESC)

### 5.7 risks_issues（リスク・課題）

| カラム名 | 型 | NULL | デフォルト | 説明 |
|---|---|---|---|---|
| id | UUID | NO | gen_random_uuid() | 主キー |
| project_id | UUID | NO | - | FK: projects.id |
| type | VARCHAR(10) | NO | - | risk / issue |
| title | VARCHAR(100) | NO | - | 件名 |
| content | TEXT | NO | - | 内容（2000文字以内） |
| cause | TEXT | YES | NULL | 原因（課題時に推奨） |
| impact | VARCHAR(10) | NO | - | 影響度: low / medium / high |
| likelihood | VARCHAR(10) | YES | NULL | 発生可能性（リスク時必須） |
| priority | VARCHAR(10) | NO | - | 優先度: low / medium / high |
| response_policy | TEXT | YES | NULL | 対応方針（1000文字以内） |
| response_detail | TEXT | YES | NULL | 対応策（2000文字以内） |
| reporter_id | UUID | NO | - | 起票者（FK: users.id） |
| assignee_id | UUID | YES | NULL | 対応担当者（FK: users.id） |
| deadline | DATE | YES | NULL | 期限 |
| state | VARCHAR(20) | NO | 'open' | 状態 |
| result | TEXT | YES | NULL | 結果（2000文字以内） |
| lesson_learned | TEXT | YES | NULL | 教訓（2000文字以内） |
| created_by | UUID | NO | - | FK: users.id |
| updated_by | UUID | NO | - | FK: users.id |
| created_at | TIMESTAMPTZ | NO | now() | 作成日時 |
| updated_at | TIMESTAMPTZ | NO | now() | 更新日時 |
| deleted_at | TIMESTAMPTZ | YES | NULL | 論理削除日時 |

**インデックス**:
- `idx_risks_project` (project_id, type, WHERE deleted_at IS NULL)
- `idx_risks_priority` (priority, state, WHERE deleted_at IS NULL)

### 5.8 knowledges（ナレッジ）

| カラム名 | 型 | NULL | デフォルト | 説明 |
|---|---|---|---|---|
| id | UUID | NO | gen_random_uuid() | 主キー |
| title | VARCHAR(150) | NO | - | タイトル |
| knowledge_type | VARCHAR(30) | NO | - | 種別 |
| background | TEXT | NO | - | 背景（2000文字以内） |
| content | TEXT | NO | - | 内容（5000文字以内） |
| result | TEXT | NO | - | 結果（3000文字以内） |
| conclusion | TEXT | YES | NULL | 結論（2000文字以内） |
| recommendation | TEXT | YES | NULL | 推奨事項（2000文字以内） |
| reusability | VARCHAR(10) | YES | NULL | 再利用性: low / medium / high |
| tech_tags | JSONB | YES | '[]' | 対象技術（タグ配列） |
| dev_method | VARCHAR(30) | YES | NULL | 開発方式 |
| process_tags | JSONB | YES | '[]' | 対象工程（タグ配列） |
| visibility | VARCHAR(20) | NO | 'draft' | 公開範囲: draft / project / company |
| created_by | UUID | NO | - | FK: users.id |
| updated_by | UUID | NO | - | FK: users.id |
| created_at | TIMESTAMPTZ | NO | now() | 作成日時 |
| updated_at | TIMESTAMPTZ | NO | now() | 更新日時 |
| deleted_at | TIMESTAMPTZ | YES | NULL | 論理削除日時 |

**インデックス**:
- `idx_knowledges_type` (knowledge_type, WHERE deleted_at IS NULL)
- `idx_knowledges_visibility` (visibility, WHERE deleted_at IS NULL)
- `idx_knowledges_fulltext` (GIN index on title, content for 全文検索)

### 5.9 retrospectives（振り返り）

| カラム名 | 型 | NULL | デフォルト | 説明 |
|---|---|---|---|---|
| id | UUID | NO | gen_random_uuid() | 主キー |
| project_id | UUID | NO | - | FK: projects.id |
| conducted_date | DATE | NO | - | 実施日 |
| plan_summary | TEXT | NO | - | 計画総括（2000文字以内） |
| actual_summary | TEXT | NO | - | 実績総括（2000文字以内） |
| good_points | TEXT | NO | - | 良かった点（3000文字以内） |
| problems | TEXT | NO | - | 問題点（3000文字以内） |
| estimate_gap_factors | TEXT | YES | NULL | 見積差分要因（3000文字以内） |
| schedule_gap_factors | TEXT | YES | NULL | スケジュール差分要因（3000文字以内） |
| quality_issues | TEXT | YES | NULL | 品質面課題（3000文字以内） |
| risk_response_evaluation | TEXT | YES | NULL | リスク対応評価（3000文字以内） |
| improvements | TEXT | NO | - | 次回改善事項（3000文字以内） |
| knowledge_to_share | TEXT | YES | NULL | 横展開したい知見（3000文字以内） |
| state | VARCHAR(20) | NO | 'draft' | 状態: draft / confirmed |
| created_by | UUID | NO | - | FK: users.id |
| updated_by | UUID | NO | - | FK: users.id |
| created_at | TIMESTAMPTZ | NO | now() | 作成日時 |
| updated_at | TIMESTAMPTZ | NO | now() | 更新日時 |
| deleted_at | TIMESTAMPTZ | YES | NULL | 論理削除日時 |

### 5.10 retrospective_comments（振り返りコメント）

| カラム名 | 型 | NULL | デフォルト | 説明 |
|---|---|---|---|---|
| id | UUID | NO | gen_random_uuid() | 主キー |
| retrospective_id | UUID | NO | - | FK: retrospectives.id |
| user_id | UUID | NO | - | FK: users.id |
| content | TEXT | NO | - | コメント内容 |
| created_at | TIMESTAMPTZ | NO | now() | 作成日時 |

### 5.11 decisions（意思決定）

| カラム名 | 型 | NULL | デフォルト | 説明 |
|---|---|---|---|---|
| id | UUID | NO | gen_random_uuid() | 主キー |
| project_id | UUID | NO | - | FK: projects.id |
| title | VARCHAR(100) | NO | - | 件名 |
| background | TEXT | YES | NULL | 背景 |
| issue | TEXT | YES | NULL | 論点 |
| options | TEXT | YES | NULL | 選択肢 |
| decision_content | TEXT | NO | - | 決定内容 |
| decision_reason | TEXT | YES | NULL | 決定理由 |
| decided_date | DATE | YES | NULL | 決定日 |
| decided_by | UUID | YES | NULL | 決定者（FK: users.id） |
| impact_scope | TEXT | YES | NULL | 影響範囲 |
| created_by | UUID | NO | - | FK: users.id |
| updated_by | UUID | NO | - | FK: users.id |
| created_at | TIMESTAMPTZ | NO | now() | 作成日時 |
| updated_at | TIMESTAMPTZ | NO | now() | 更新日時 |
| deleted_at | TIMESTAMPTZ | YES | NULL | 論理削除日時 |

### 5.12 change_requests（変更要求）

| カラム名 | 型 | NULL | デフォルト | 説明 |
|---|---|---|---|---|
| id | UUID | NO | gen_random_uuid() | 主キー |
| project_id | UUID | NO | - | FK: projects.id |
| request_content | TEXT | NO | - | 変更要求内容 |
| reason | TEXT | NO | - | 変更理由 |
| requester_id | UUID | NO | - | 起票者（FK: users.id） |
| impact_target | TEXT | YES | NULL | 影響対象 |
| impact_assessment | TEXT | YES | NULL | 影響評価 |
| needs_approval | BOOLEAN | NO | false | 承認要否 |
| approval_status | VARCHAR(20) | YES | NULL | 承認結果: pending / approved / rejected |
| applied_content | TEXT | YES | NULL | 変更反映内容 |
| state | VARCHAR(20) | NO | 'open' | 状態: open / applied / rejected / cancelled |
| created_by | UUID | NO | - | FK: users.id |
| updated_by | UUID | NO | - | FK: users.id |
| created_at | TIMESTAMPTZ | NO | now() | 作成日時 |
| updated_at | TIMESTAMPTZ | NO | now() | 更新日時 |
| deleted_at | TIMESTAMPTZ | YES | NULL | 論理削除日時 |

### 5.13 audit_logs（監査ログ）

| カラム名 | 型 | NULL | デフォルト | 説明 |
|---|---|---|---|---|
| id | UUID | NO | gen_random_uuid() | 主キー |
| user_id | UUID | NO | - | 操作者（FK: users.id） |
| action | VARCHAR(50) | NO | - | 操作内容（CREATE / UPDATE / DELETE 等） |
| entity_type | VARCHAR(50) | NO | - | 対象エンティティ種別 |
| entity_id | UUID | NO | - | 対象エンティティ ID |
| before_value | JSONB | YES | NULL | 変更前の値 |
| after_value | JSONB | YES | NULL | 変更後の値 |
| ip_address | VARCHAR(45) | YES | NULL | 操作元 IP |
| created_at | TIMESTAMPTZ | NO | now() | 操作日時 |

**インデックス**:
- `idx_audit_entity` (entity_type, entity_id)
- `idx_audit_user` (user_id, created_at DESC)

### 5.14 role_change_logs（権限変更履歴）

| カラム名 | 型 | NULL | デフォルト | 説明 |
|---|---|---|---|---|
| id | UUID | NO | gen_random_uuid() | 主キー |
| changed_by | UUID | NO | - | 変更者（FK: users.id） |
| target_user_id | UUID | NO | - | 対象ユーザ（FK: users.id） |
| change_type | VARCHAR(20) | NO | - | system_role / project_role |
| project_id | UUID | YES | NULL | プロジェクトロール時のみ（FK: projects.id） |
| before_role | VARCHAR(30) | YES | NULL | 変更前ロール |
| after_role | VARCHAR(30) | NO | - | 変更後ロール |
| reason | TEXT | YES | NULL | 変更理由（1000文字以内） |
| created_at | TIMESTAMPTZ | NO | now() | 変更日時 |

---

## 6. プロジェクト状態遷移設計

### 6.1 状態遷移図

```mermaid
stateDiagram-v2
    [*] --> planning: プロジェクト作成
    planning --> estimating: 遷移条件①
    estimating --> scheduling: 遷移条件②
    scheduling --> executing: 遷移条件③
    executing --> completed: 遷移条件④
    completed --> retrospected: 遷移条件⑤
    retrospected --> closed: 遷移条件⑥

    note right of planning
        条件①: 目的・背景・スコープ登録済み
        かつ PM/TL 設定済み
    end note

    note right of estimating
        条件②: 見積確定済み
        かつ見積根拠登録済み
    end note

    note right of scheduling
        条件③: WBS管理作成済み
        かつ担当・工数・期限設定済み
    end note

    note right of executing
        条件④: 全タスク完了/クローズ
        かつリスク/課題整理済み
        かつ実績工数記録完了
    end note

    note right of completed
        条件⑤: 振り返り記録済み
        かつ改善事項登録済み
        かつナレッジ化対象整理済み
    end note

    note right of retrospected
        条件⑥: ナレッジ公開完了
        かつ最終状態確定済み
    end note
```

### 6.2 State Machine 実装方針

```typescript
// services/state-machine.ts

type ProjectStatus =
  | 'planning'
  | 'estimating'
  | 'scheduling'
  | 'executing'
  | 'completed'
  | 'retrospected'
  | 'closed';

type TransitionRule = {
  from: ProjectStatus;
  to: ProjectStatus;
  guard: (projectId: string) => Promise<{ allowed: boolean; reason?: string }>;
};

const transitions: TransitionRule[] = [
  {
    from: 'planning',
    to: 'estimating',
    guard: async (projectId) => {
      // 目的・背景・スコープの初版が登録済み かつ PM/TL 設定済み
    },
  },
  {
    from: 'estimating',
    to: 'scheduling',
    guard: async (projectId) => {
      // 見積もりが確定済み かつ 見積根拠が登録済み
    },
  },
  // ... 以下同様
];
```

---

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
| POST | /api/projects/:id/members | メンバー追加 | admin |
| PATCH | /api/projects/:id/members/:userId | ロール変更 | admin |
| DELETE | /api/projects/:id/members/:userId | メンバー解除 | admin |

#### 見積もり

| メソッド | パス | 説明 | ロール |
|---|---|---|---|
| GET | /api/projects/:id/estimates | 一覧取得 | admin, pm_tl |
| POST | /api/projects/:id/estimates | 新規作成 | admin, pm_tl |
| GET | /api/projects/:id/estimates/:estimateId | 詳細取得 | admin, pm_tl |
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
| POST | /api/projects/:id/tasks/export | WBSテンプレートエクスポート（JSON） | 全ロール |
| POST | /api/projects/:id/tasks/import | WBSテンプレートインポート（JSON） | admin, pm_tl |
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
| DELETE | /api/projects/:id/risks/:riskId | 論理削除 | admin, pm_tl |
| GET | /api/projects/:id/risks/export | CSV エクスポート | admin, pm_tl |
| GET | /api/risks | 全プロジェクト横断一覧（列: プロジェクト・種別・件名・担当者・影響度・発生可能性・優先度・作成/更新日時・作成/更新者。非メンバーは機微項目マスク） | 認証済み全ユーザ |

#### ナレッジ

| メソッド | パス | 説明 | ロール |
|---|---|---|---|
| GET | /api/knowledge | 横断検索（全ナレッジ） | 全ロール（公開範囲制御あり） |
| POST | /api/knowledge | 新規作成（プロジェクト紐付けなし） | admin, pm_tl, member |
| GET | /api/knowledge/:id | 詳細取得 | 公開範囲に応じる |
| PATCH | /api/knowledge/:id | 更新 | admin, pm_tl, 作成者 member |
| DELETE | /api/knowledge/:id | 論理削除 | admin, pm_tl |
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
| DELETE | /api/projects/:id/retrospectives/:retroId | 論理削除 | admin, pm_tl |
| GET | /api/retrospectives | 全プロジェクト横断一覧（列: プロジェクト・実施日・計画総括・実績総括・良かった点・次回以前事項・作成/更新日時・作成/更新者。非メンバーは機微項目マスク） | 認証済み全ユーザ |

#### システム管理

| メソッド | パス | 説明 | ロール |
|---|---|---|---|
| GET | /api/admin/users | ユーザ一覧 | admin |
| POST | /api/admin/users | ユーザ登録 | admin |
| PATCH | /api/admin/users/:userId | ユーザ更新 | admin |
| DELETE | /api/admin/users/:userId | ユーザ削除 (論理削除 + ProjectMember 物理カスケード、PR #89) | admin |
| POST | /api/admin/users/:userId/unlock | ロック解除 (PR #85) | admin |
| POST | /api/admin/users/lock-inactive | 非アクティブユーザ一括ロック (PR #89 で導入、feat/account-lock で **論理削除 → ロック (isActive=false)** に方針変更、日次 cron + 手動) | admin or Vercel Cron |
| PATCH | /api/admin/users/:userId/role | ロール変更 | admin |
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

---

## 8. 権限制御設計

### 8.1 権限チェックの実装箇所

```
Request
  → Middleware（認証チェック: セッション有効性の確認）
    → Route Handler（リクエストの受け取り、バリデーション）
      → Service Layer（権限チェック + ビジネスロジック）
        → Prisma（データアクセス）
```

**原則**: 権限チェックは Service 層で統一実施する。Middleware は認証（ログイン済みか否か）のみを担当する。

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

### 8.3.1 リスク/課題/振り返り/ナレッジ の権限詳細 (2026-04-24 改修)

4 エンティティ共通で以下の方針。メモは個人資産なので対象外。

| 操作 | 全○○ 画面 | ○○一覧 画面 (プロジェクト詳細タブ) |
|---|---|---|
| 一覧参照 | 非 admin: `visibility='public'` のみ<br>admin: draft 含め全件 | 同左 |
| 個別参照 (view) | public: 全員 OK<br>draft: 作成者本人 + admin のみ | 同左 |
| 作成 | — (画面から不可) | **実際の ProjectMember** (`pm_tl` / `member`) のみ<br>admin でも非メンバーなら不可 |
| 編集 | — (画面から不可、全員 read-only) | **作成者本人のみ**<br>admin でも他人の記事は編集不可 |
| 削除 | **admin のみ** (管理削除、全リスク/課題/振り返り/ナレッジ画面から) | **作成者本人のみ** (admin は全○○ 経由で削除) |

**実装ポイント**:
- `lib/permissions/membership.ts#getActualProjectRole` で admin 短絡なしの実メンバー判定を提供
- `lib/api-helpers.ts#requireActualProjectMember` で API POST ルートの作成制約を強制
- service 層の `updateX` は「作成者と一致しなければ FORBIDDEN」で enforce
- service 層の `deleteX` は「作成者 OR admin」で enforce
- `getX(id, viewerUserId?, viewerSystemRole?)` は認可引数付きで draft 秘匿 (他人の draft は null 返却 = 存在しない扱い)
- UI 層 (各 `○○-client.tsx`) では `currentUserId` + `createdBy` / `reporterId` で isOwner 判定し、編集/削除ボタンを出し分け

### 8.3.2 メモ (Memo) の独立方針

- プロジェクト非紐付け、完全に個人資産
- CRUD は常に **自分のメモのみ** 可能 (role 判定は不要)
- 他人のメモは「全メモ」画面で `visibility='public'` のみ閲覧可 (read-only)
- **ユーザ削除時のカスケード物理削除**: `deleteUser` で `memo.deleteMany({ where: { userId } })` を
  `$transaction` に含める。振り返り/ナレッジ等「組織の資産」を残す方針と対照的に、メモは
  退職者分を残す意味がないためカスケード削除で掃除する (2026-04-24)

---

## 9. セキュリティ設計

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

- **認証プロバイダ**: NextAuth.js Credentials Provider（メール + パスワード）
- **パスワードハッシュ**: bcrypt（cost factor: 12）
- **セッション戦略**: サーバサイド DB セッション（JWT ではなく DB ストア）

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
| 権限変更時の無効化 | `NEXTAUTH_SECRET` ローテーションで全 JWT 無効化 (強制再ログイン)、個別ユーザは isActive フラグ即時反映 | 権限昇格の即時反映 |

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
  - 全クエリに project_id 条件を自動付与（Prisma Middleware）
  - 論理削除フィルタの自動適用
```

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

#### 9.5.3 Prisma Middleware によるテナント分離

```typescript
// lib/db.ts - 全クエリに対する自動フィルタ
prisma.$use(async (params, next) => {
  // 論理削除フィルタ: 読み取り系に自動付与
  if (['findMany', 'findFirst', 'findUnique'].includes(params.action)) {
    if (!params.args.where) params.args.where = {};
    if (params.args.where.deletedAt === undefined) {
      params.args.where.deletedAt = null;
    }
  }

  // 論理削除: delete を update に変換
  if (params.action === 'delete') {
    params.action = 'update';
    params.args.data = { deletedAt: new Date() };
  }

  return next(params);
});
```

### 9.6 入力バリデーション・サニタイゼーション

#### 9.6.1 バリデーション方針

| 層 | 責務 | 実装 |
|---|---|---|
| フロントエンド | UX 向上のための即時フィードバック | React Hook Form + Zod |
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

| エンドポイントカテゴリ | 制限 | ウィンドウ | 理由 |
|---|---|---|---|
| POST /api/auth/signin | 5 回 | 10 分 | ブルートフォース防止 |
| POST /api/auth/* | 10 回 | 10 分 | 認証系全般 |
| POST /api/** (書き込み系) | 30 回 | 1 分 | スパム防止 |
| GET /api/** (読み取り系) | 120 回 | 1 分 | 通常利用の範囲 |
| GET /api/**/export | 5 回 | 10 分 | CSV エクスポート等の重い処理 |

#### 9.7.2 実装方針

初期フェーズ（5〜10名）ではレート制限の実装優先度を下げる。ただし、認証エンドポイント（POST /api/auth/signin）のみ、アカウントロックポリシー（9.4.3）で実質的なブルートフォース防止を実現する。

本格運用時は in-memory（Map ベース）の sliding window 方式で実装する。Redis は無料枠に含まれないため、初期フェーズでは導入しない。

### 9.8 機密情報の取り扱い

#### 9.8.1 保存・保護

| 情報 | 保存場所 | 保護方法 |
|---|---|---|
| パスワード | DB (users.password_hash) | bcrypt (cost 12)。平文保存・ログ出力禁止 |
| パスワード履歴 | DB (password_histories) | bcrypt ハッシュで保存。比較のみに使用 |
| セッション | DB (sessions) | HttpOnly Cookie 経由のみアクセス。DB 側で期限管理 |
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

### 9.8.5 エラー情報の機密化方針 (2026-04-24 / PR #115)

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

### 9.8.4 セキュリティ監査 (2026-04-24 / PR #114)

ブラウザ開発者ツールの Network / Console タブから機密情報・クレデンシャル情報が漏洩しないことを確認するため、
全 API ルート / service / config / DTO を網羅監査した。以下に検出事項とミティゲーションを記録する。

| 重大度 | ID | 箇所 | 問題 | 対策 |
|---|---|---|---|---|
| High | H-1 | `/api/cron/cleanup-accounts` | `CRON_SECRET` 未設定時に短絡評価で認証バイパス → 外部から匿名 POST で全ユーザ論理削除・匿名化実行可能 | PR #114: `if (!cronSecret \|\| authHeader !== ...)` に改修して常に 401 → **PR #115: エンドポイント自体を削除** (vercel.json の cron 登録は `/api/admin/users/cleanup-inactive` のみでデッドコードと判明)。多層防御が結果として完成 |
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
| 管理者 | MFA 必須（MFA 未設定の管理者はシステム管理機能にアクセス不可） |
| 一般ユーザ | オプトイン（将来的に必須化を検討） |

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

## 10. インフラ構成

### 10.0 デプロイ方針 (PR #123 で整理)

本システムは **自社運用 (Vercel + Supabase) 一本** で運用する (2026-04-24 時点)。

| 項目 | 状態 |
|---|---|
| デプロイ形態 | Vercel + Supabase のみ (§10.2 参照) |
| 外部配布 (.zip / Docker / オンプレ / AWS / Azure 等) | **現時点で非対応**、体制・構成未整備のため記載を削除。将来的な必要性を鑑みて再検討する |
| 開発環境 | ローカル PostgreSQL (Docker) or Supabase 接続、詳細は §10.1 |

過去に docs 内に Docker Compose / オンプレミス / AWS / Azure 等の外部配布方針を記載していたが、
体制・構成が整備されていないため誤認を避ける目的で PR #123 で削除した。再導入する場合は
git 履歴から過去記述を参照できる。

### 10.1 開発環境構成図

```
┌──────────────────────────────────────────────────────────┐
│                    Developer Machine                      │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │              Docker Compose                        │  │
│  │                                                    │  │
│  │  ┌──────────────────┐  ┌────────────────────────┐ │  │
│  │  │  app              │  │  db                    │ │  │
│  │  │  Next.js (dev)    │  │  PostgreSQL 16         │ │  │
│  │  │  Port: 3000       │──│  Port: 5432            │ │  │
│  │  │  Hot Reload       │  │  Volume: pgdata        │ │  │
│  │  └──────────────────┘  └────────────────────────┘ │  │
│  │                                                    │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  ツール                                             │  │
│  │  - Node.js 22 LTS                                  │  │
│  │  - pnpm (パッケージマネージャ)                       │  │
│  │  - Prisma CLI                                      │  │
│  │  - Claude Code (開発支援)                           │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### 10.2 運用環境構成（無料枠）

初期フェーズでは Vercel Hobby + Supabase Free + Brevo Free の無料構成で運用する。

```
┌──────────────────────────────────────────────────────────────┐
│  Browser (HTTPS)                                              │
└──────────────┬───────────────────────────────────────────────┘
               | HTTPS
┌──────────────┴───────────────────────────────────────────────┐
│  Vercel Hobby (無料)                                          │
│  - Next.js (App Router, Standalone)                          │
│  - Edge Network (CDN)                                        │
│  - 自動 SSL (Let's Encrypt)                                  │
│  - 帯域: 100GB/月                                            │
│  制約: 商用利用不可（個人の試験運用用途）                        │
└──────────────┬───────────────────────────────────────────────┘
               | Connection Pooler (IPv4)
┌──────────────┴───────────────────────────────────────────────┐
│  Supabase Free (無料)                                         │
│  - PostgreSQL 15                                              │
│  - ストレージ: 500MB                                          │
│  - Pooler 経由接続（Transaction mode）                        │
│  - 1週間無操作でプロジェクト一時停止（手動再開可）              │
│  制約: 直接接続不可、バックアップは日次自動のみ                 │
└──────────────────────────────────────────────────────────────┘

  メール送信: Brevo Free (300通/日)
  CI/CD: GitHub Actions (無料枠: 2,000分/月)
  ドメイン: Vercel サブドメイン (*.vercel.app)
```

#### 月額コスト

| コンポーネント | サービス | 月額 |
|---|---|---|
| アプリケーション | Vercel Hobby | $0 |
| データベース | Supabase Free (500MB) | $0 |
| メール送信 | Brevo Free (300通/日) | $0 |
| CI/CD | GitHub Actions (2,000分/月) | $0 |
| ドメイン | Vercel サブドメイン | $0 |
| **合計** | | **$0/月** |

#### 無料枠の制約と対策

| 制約 | 影響 | 対策 |
|---|---|---|
| Vercel Hobby: 商用利用不可 | 試験運用フェーズのみ利用可 | 本格運用時に Pro ($20/月) へ移行 |
| Supabase Free: 500MB | 約3年で逼迫（ログ制御後） | ログ保持期間の厳格化で 5 年以上対応可 |
| Supabase Free: 1週間無操作で停止 | 長期休暇時にDBが停止 | ダッシュボードから手動再開、または定期的なヘルスチェック |
| Supabase Free: Pooler 経由のみ | Prisma の一部機能に制約 | Transaction mode 対応の接続設定を使用 |
| Brevo Free: 300通/日 | 初期フェーズでは十分 | ユーザ増加時に Starter ($9/月) へ移行 |

#### データ量の見積もり（ログ制御後）

| 期間 | ビジネスデータ | 監査ログ | 合計 | 500MB に対する使用率 |
|---|---|---|---|---|
| 1年後 | ~8MB | ~36MB | ~44MB | 9% |
| 3年後 | ~24MB | ~36MB（1年保持で削除） | ~60MB | 12% |
| 5年後 | ~40MB | ~36MB（1年保持で削除） | ~76MB | 15% |

※ operation_trace_logs を初期フェーズで無効化し、audit_logs は 1 年保持で物理削除する前提

### 10.3 将来の有料構成（スケール時）

ユーザ数増加・本格運用移行時は以下の構成に段階的に移行する。

| トリガー | 移行先 | 追加コスト |
|---|---|---|
| 商用利用の開始 | Vercel Pro | +$20/月 |
| DB 500MB 超過 or 直接接続が必要 | Supabase Pro | +$25/月 |
| メール 300通/日超過 | Brevo Starter | +$9/月 |
| 独自ドメインが必要 | ドメイン取得 | +~$1/月 |
| 大規模運用（100名超） | AWS / Azure への移行 | 要別途見積もり |

### 10.4 環境変数一覧

> 詳細は [`docs/administrator/OPERATION.md §1`](../administrator/OPERATION.md#1-環境変数一覧) に集約。本節は概要のみ。

| 変数名 | 説明 | 例 |
|---|---|---|
| DATABASE_URL | PostgreSQL 接続文字列 (Supabase pooler) | postgresql://...:6543/postgres?pgbouncer=true |
| DIRECT_URL | 直接接続文字列 (migration 用) | postgresql://...:5432/postgres |
| NEXTAUTH_URL | アプリケーション URL | http://localhost:3000 or Vercel URL |
| NEXTAUTH_SECRET | NextAuth 暗号化キー | ランダム文字列（32文字以上） |
| NODE_ENV | 実行環境 | development / production |
| MAIL_PROVIDER | メール送信プロバイダ | console（デフォルト）/ brevo（本番推奨）/ resend（代替）/ inbox（E2E 専用） |
| BREVO_API_KEY | Brevo API キー（MAIL_PROVIDER=brevo 時、本番既定） | xkeysib-xxxxxxxxxx |
| MAIL_FROM_NAME | メール送信元表示名（Brevo のみ） | たすきば |
| RESEND_API_KEY | Resend API キー（MAIL_PROVIDER=resend 時、代替選択肢） | re_xxxxxxxxxx |
| MAIL_FROM | メール送信元アドレス | noreply@example.com |
| INITIAL_ADMIN_EMAIL | 初期管理者メールアドレス（シード用） | admin@example.com |
| INITIAL_ADMIN_PASSWORD | 初期管理者パスワード（シード用） | （ポリシー準拠のパスワード） |
| SEARCH_PROVIDER | 検索プロバイダ | pg_trgm（デフォルト） |
| ENABLE_OPERATION_TRACE | 操作トレースログの有効/無効 | false（初期）/ true（本格運用時） |
| APP_DEFAULT_TIMEZONE / APP_DEFAULT_LOCALE | i18n 既定値 (PR #118) | Asia/Tokyo / ja-JP |

> **注**: `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` の記載を PR #123 で削除。
> 過去 docs に記載されていたが、`src/lib/mail/index.ts` の `createMailProvider()` に `smtp`
> ケースが存在せず (実装未提供)、指定しても console フォールバックになるため誤認回避。

#### ローカル開発時のみ (Docker Compose)

| 変数名 | 説明 | デフォルト |
|---|---|---|
| APP_PORT | アプリケーション公開ポート | 3000 |
| DB_PORT | PostgreSQL 公開ポート | 5433（5432 との競合回避） |
| DB_NAME | データベース名 | tasukiba |
| DB_USER | データベースユーザ | postgres |
| DB_PASSWORD | データベースパスワード | （必須設定） |

#### 環境別の DATABASE_URL / DIRECT_URL

| 環境 | DATABASE_URL | DIRECT_URL |
|---|---|---|
| 自社 (Supabase、本番) | Pooler 経由 (ポート 6543, ?pgbouncer=true) | 直接接続 (ポート 5432) |
| ローカル開発 (Docker) | postgresql://postgres:postgres@localhost:5433/tasukiba | DATABASE_URL と同一 |

> **注**: Docker 配布 / 非 Docker 配布 / オンプレミス構成は PR #123 で記載削除 (体制・構成未整備、§10.0 参照)。

---

## 11. 画面遷移設計

### 11.1 画面遷移図

```mermaid
flowchart TD
    LOGIN[ログイン画面] --> PJ_LIST[プロジェクト一覧]

    PJ_LIST --> PJ_NEW[プロジェクト新規作成]
    PJ_LIST --> PJ_DETAIL[プロジェクト詳細]

    PJ_DETAIL --> TAB_EST[見積もり管理]
    PJ_DETAIL --> TAB_TASK[WBS管理]
    PJ_DETAIL --> TAB_GANTT[ガントチャート]
    PJ_DETAIL --> TAB_RISK[リスク/課題一覧]
    PJ_DETAIL --> TAB_KN[ナレッジ管理]
    PJ_DETAIL --> TAB_RETRO[振り返り]
    PJ_DETAIL --> TAB_MEMBER[メンバー管理]

    TAB_EST --> EST_DETAIL[見積もり詳細/編集]
    TAB_TASK --> TASK_DETAIL[タスク詳細/編集]
    TAB_GANTT --> TASK_DETAIL
    TAB_RISK --> RISK_DETAIL[リスク/課題 詳細/編集]
    TAB_KN --> KN_DETAIL[ナレッジ詳細/編集]
    TAB_RETRO --> RETRO_DETAIL[振り返り詳細/編集]

    PJ_LIST --> MY_TASKS[マイタスク]
    MY_TASKS --> TASK_DETAIL

    PJ_LIST --> KN_SEARCH[ナレッジ横断検索]
    KN_SEARCH --> KN_DETAIL

    PJ_LIST --> ADMIN[システム管理]
    ADMIN --> USER_MGMT[ユーザ管理]
    ADMIN --> AUDIT[監査ログ]
    ADMIN --> ROLE_HIST[権限変更履歴]
```

### 11.2 プロジェクト詳細のタブ構成

プロジェクト詳細画面はハブ画面として機能し、以下のタブで各機能に遷移する。

| タブ | パス | 表示条件 |
|---|---|---|
| 概要 | /projects/:id | 常時表示 |
| 見積もり | /projects/:id/estimates | admin, pm_tl のみ |
| WBS管理 | /projects/:id/tasks | 常時表示 |
| ガントチャート | /projects/:id/gantt | 常時表示 |
| リスク/課題 | /projects/:id/risks | 常時表示 |
| ナレッジ | /projects/:id/knowledge | 常時表示 |
| 振り返り | /projects/:id/retrospectives | 完了以降表示 |
| メンバー | /projects/:id/members | admin, pm_tl のみ |

---

## 12. テスト戦略

### 12.1 テストピラミッド

| レベル | ツール | 対象 | カバレッジ目標 |
|---|---|---|---|
| Unit | Vitest | Service 層のビジネスロジック、バリデーション | 80% |
| Integration | Vitest + Prisma | API Route Handler + DB 操作 | 主要パス |
| E2E | Playwright | 画面操作フロー、権限制御の統合動作 | クリティカルパス |

### 12.2 テスト対象の優先度

| 優先度 | 対象 |
|---|---|
| 必須 | 権限チェック（全ロール × 全操作の組み合わせ） |
| 必須 | 状態遷移ガード（遷移条件の充足/未充足） |
| 必須 | バリデーション（必須項目、文字数制限、型） |
| 高 | CRUD 操作の正常系・異常系 |
| 高 | ナレッジの公開範囲制御 |
| 中 | ガントチャートのデータ変換 |
| 中 | CSV エクスポート |

---

## 13. 初期データ・シード設計

### 13.1 初期管理者アカウント

システム起動後に最初のログインを可能にするため、シードスクリプトで初期管理者アカウントを作成する。

#### 作成方法

```
pnpm db:seed
```

#### 処理フロー

```
[1] 環境変数から初期管理者情報を取得
    - INITIAL_ADMIN_EMAIL（必須）
    - INITIAL_ADMIN_PASSWORD（必須、パスワードポリシー準拠）
    |
    v
[2] 管理者アカウント作成
    - system_role = admin
    - is_active = true（シード時はメール検証をスキップ）
    - パスワードを bcrypt ハッシュ化
    - force_password_change = true（初回ログイン時にパスワード変更を強制）
    |
    v
[3] リカバリーコード10個を生成
    - 各コードを bcrypt ハッシュ化して DB 保存
    |
    v
[4] コンソールに出力（1回限り）
    === 初期管理者アカウント作成 ===
    メール:           (環境変数の値)
    初回ログイン後にパスワード変更が強制されます
    リカバリーコード:
      1. XXXX-XXXX
      2. XXXX-XXXX
      ... (10個)
    このリカバリーコードを安全な場所に保管してください。
    再表示はできません。
    ================================
```

#### 冪等性

- 同一メールアドレスのユーザが既に存在する場合はスキップする
- 複数回実行しても安全

#### 環境変数

| 変数名 | 説明 | 例 |
|---|---|---|
| INITIAL_ADMIN_EMAIL | 初期管理者のメールアドレス | admin@example.com |
| INITIAL_ADMIN_PASSWORD | 初期管理者のパスワード | （ポリシー準拠の強力なパスワード） |

### 13.2 マスタデータ

MVP ではマスタデータをコード内定数（enum / 定数オブジェクト）として管理する。DB マスタテーブルは MVP 後に必要に応じて導入する。

#### 定数定義一覧

| 定数名 | 値 | 利用箇所 |
|---|---|---|
| DevMethod | scratch / power_platform / package / other | プロジェクト、見積もり |
| TaskCategory | requirements / design / development / testing / review / management / other | タスク |
| KnowledgeType | research / verification / incident / decision / lesson / best_practice / other | ナレッジ |
| ProjectStatus | planning / estimating / scheduling / executing / completed / retrospected / closed | プロジェクト |
| TaskStatus | not_started / in_progress / completed / on_hold | タスク |
| Priority | low / medium / high | タスク、リスク/課題 |
| Impact | low / medium / high | リスク/課題 |
| RiskIssueState | open / in_progress / monitoring / resolved | リスク/課題 |
| Visibility | draft / project / company | ナレッジ |
| SystemRole | admin / general | ユーザ |
| ProjectRole | pm_tl / member / viewer | プロジェクトメンバー |
| EffortUnit | person_hour / person_day | 見積もり |

#### 実装方針

```typescript
// lib/constants/master.ts
export const DEV_METHODS = {
  scratch: 'スクラッチ開発',
  power_platform: 'PowerPlatform',
  package: 'パッケージ導入',
  other: 'その他',
} as const;

export type DevMethod = keyof typeof DEV_METHODS;
```

---

## 14. DB マイグレーション戦略

### 14.1 ツール

Prisma Migrate を使用する。マイグレーションファイル（SQL）は自動生成され、Git で管理する。

### 14.2 開発環境の運用ルール

| ルール | 内容 |
|---|---|
| マイグレーション生成 | `pnpm prisma migrate dev --name <変更内容>` |
| 命名規則 | 英語スネークケース（例: `add_mfa_columns_to_users`） |
| 1マイグレーション1変更 | テーブル追加とカラム追加は分割する |
| データ投入 | マイグレーション内でデータ投入しない（シードスクリプトで分離） |
| リセット | `prisma migrate reset` で全リセット可（開発環境のみ） |
| Git 管理 | prisma/migrations/ を必ずコミット |

### 14.3 本番環境の運用ルール

#### 適用フロー

```
[1] PR でマイグレーションファイルをレビュー
    - 破壊的変更がないか
    - ロック時間が長くないか
    |
    v
[2] ステージング環境で適用テスト
    |
    v
[3] 本番適用: pnpm prisma migrate deploy
    |
    v
[4] 適用結果の確認
```

#### 破壊的変更の安全な適用手順

| 変更種別 | 安全な手順 |
|---|---|
| NOT NULL カラム追加 | (1) デフォルト値付きで追加 → (2) データ埋め → (3) NOT NULL 制約追加 |
| カラム名変更 | (1) 新カラム追加 → (2) データコピー → (3) アプリ切替 → (4) 旧カラム削除 |
| カラム削除 | (1) アプリから参照除去 → (2) デプロイ → (3) カラム削除 |
| テーブル削除 | (1) アプリから参照除去 → (2) デプロイ → (3) テーブル削除 |
| インデックス追加（大テーブル） | CREATE INDEX CONCURRENTLY を使用（ロック回避） |

### 14.4 禁止事項

| 禁止事項 | 理由 |
|---|---|
| 生成された SQL ファイルの手動編集 | Prisma の整合性管理が破損する |
| 適用済みマイグレーションファイルの削除 | 履歴が失われ、環境間で不整合が発生する |
| 本番環境での `prisma migrate reset` | 全データが消失する |
| 本番環境での `prisma db push` | マイグレーション履歴をバイパスする |

---

## 15. インデックス戦略

### 15.1 設計原則

| 原則 | 説明 |
|---|---|
| WHERE 句頻出カラム | 一覧のフィルタ条件になるカラムにインデックスを付与 |
| 全 FK カラム | JOIN の高速化 |
| 複合インデックス | WHERE 句で複数カラムを同時に使うパターンに対応 |
| 部分インデックス | `WHERE deleted_at IS NULL` で論理削除レコードを除外 |
| 過剰インデックス回避 | 書き込み性能低下を防ぐため必要最小限に |

### 15.2 テーブル別インデックス定義

#### users

| インデックス名 | カラム | 種別 | 用途 |
|---|---|---|---|
| idx_users_email | email | UNIQUE, 部分 | ログイン時のメール検索 |
| idx_users_active | is_active, last_login_at | 部分 | 未使用アカウントバッチ |

#### projects

| インデックス名 | カラム | 種別 | 用途 |
|---|---|---|---|
| idx_projects_status | status | 部分 | 一覧のステータスフィルタ |
| idx_projects_customer_id | customer_id | 通常 | 顧客経由の絞込 (PR #111-2 以降、customer_name 索引は廃止) |
| idx_projects_dates | planned_start_date, planned_end_date | 部分 | 一覧の日付範囲フィルタ |

#### project_members

| インデックス名 | カラム | 種別 | 用途 |
|---|---|---|---|
| idx_pm_project | project_id | - | プロジェクトのメンバー一覧 |
| idx_pm_user | user_id | - | ユーザの参加プロジェクト一覧 |
| uq_pm_project_user | project_id, user_id | UNIQUE | 重複追加防止 |

#### estimates

| インデックス名 | カラム | 種別 | 用途 |
|---|---|---|---|
| idx_estimates_project | project_id | 部分 | プロジェクト内の見積一覧 |

#### tasks

| インデックス名 | カラム | 種別 | 用途 |
|---|---|---|---|
| idx_tasks_project | project_id | 部分 | プロジェクト内タスク一覧 |
| idx_tasks_assignee | assignee_id, status | 部分 | マイタスク画面 |
| idx_tasks_parent | parent_task_id | 部分 | WBS ツリー構築 |
| idx_tasks_gantt | project_id, planned_start_date, planned_end_date | 部分 | ガントチャートデータ取得 |

#### task_progress_logs

| インデックス名 | カラム | 種別 | 用途 |
|---|---|---|---|
| idx_progress_task | task_id, update_date DESC | - | 進捗履歴取得 |

#### risks_issues

| インデックス名 | カラム | 種別 | 用途 |
|---|---|---|---|
| idx_risks_project | project_id, type | 部分 | 一覧表示（リスク/課題別） |
| idx_risks_state | state, priority | 部分 | 未対応の高優先度フィルタ |
| idx_risks_assignee | assignee_id | 部分 | 担当者別フィルタ |

#### knowledges

| インデックス名 | カラム | 種別 | 用途 |
|---|---|---|---|
| idx_knowledges_type | knowledge_type | 部分 | 種別フィルタ |
| idx_knowledges_visibility | visibility | 部分 | 公開範囲フィルタ |
| idx_knowledges_search | (title, content 連結) | GIN (pg_trgm) | 全文検索（セクション16） |

#### retrospectives

| インデックス名 | カラム | 種別 | 用途 |
|---|---|---|---|
| idx_retro_project | project_id | 部分 | プロジェクト内の振り返り一覧 |

#### audit_logs

| インデックス名 | カラム | 種別 | 用途 |
|---|---|---|---|
| idx_audit_entity | entity_type, entity_id | - | エンティティ別の変更履歴 |
| idx_audit_user | user_id, created_at DESC | - | ユーザ別の操作履歴 |
| idx_audit_date | created_at DESC | - | 日時範囲での検索 |

#### operation_trace_logs

| インデックス名 | カラム | 種別 | 用途 |
|---|---|---|---|
| idx_trace_user | user_id, created_at DESC | - | ユーザ別のアクセスログ |
| idx_trace_entity | entity_type, entity_id, created_at DESC | - | エンティティ別の操作履歴 |
| idx_trace_request | request_id | - | リクエスト追跡 |
| idx_trace_date | created_at DESC | - | 日時範囲での検索 |

#### auth_event_logs

| インデックス名 | カラム | 種別 | 用途 |
|---|---|---|---|
| idx_auth_events_user | user_id, created_at DESC | - | ユーザ別の認証履歴 |
| idx_auth_events_type | event_type, created_at DESC | - | イベント種別別の検索 |

### 15.3 パーティショニング

初期フェーズでは不要。500MB の無料枠内で数年間運用可能なため、パーティショニングは実装しない。
本格運用でデータ量が増大した場合（100万レコード超過目安）に、audit_logs / operation_trace_logs を月次パーティションに分割することを検討する。

---

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

| 対象 | キャッシュ方式 | TTL | 無効化タイミング |
|---|---|---|---|
| セッション情報 | TanStack Query (staleTime) | 5 分 | ログアウト / 権限変更時 |
| プロジェクト一覧 | TanStack Query (staleTime) | 1 分 | 作成・更新・削除時 |
| マスタデータ（定数） | ビルド時埋め込み | なし | デプロイ時 |
| ナレッジ検索結果 | TanStack Query (staleTime) | 30 秒 | 作成・更新・削除時 |
| ガントチャートデータ | TanStack Query (staleTime) | 1 分 | タスク更新時 |

MVP ではサーバサイドキャッシュ（Redis 等）は導入しない。TanStack Query のクライアントサイドキャッシュで対応する。

### 17.6 パフォーマンス・アンチパターン（コミット前チェックリスト）

再発防止のため、コード変更時は以下を自問する。詳細と背景は [KNW-002](./knowledge/KNW-002_performance-optimization-patterns.md) 参照。

1. **同一テーブルへの重複 findMany** — Server Component の `Promise.all` に、同じエンティティに対する複数の findMany が入っていないか（tree/flat のような後処理違いでも 1 回に集約）
2. **表示件数とクエリ limit の乖離** — `limit:` / `take:` が実際の表示件数（`slice(0, N)` 等）と一致しているか
3. **再帰・大量リストの memo 未適用** — 自己再帰コンポーネントや 100 件超のリストは `React.memo` 必須、props は参照安定（Set/Array を直接渡すなら親で boolean に畳む）
4. **O(N×M) の背景 DOM** — 行 × 列のグリッドで、各行が共通背景を描画していないか（共通背景は行ループ外のオーバーレイへ）
5. **タブ配下の eager fetch** — 切替で表示する UI のデータを初回ロードで全て取得していないか（可能ならタブ表示時の lazy fetch へ）

---

## 18. 通知（メール送信）設計

### 18.1 メール送信サービス

| 項目 | 選定内容 |
|---|---|
| サービス | Brevo（https://www.brevo.com/）★推奨 |
| 選定理由 | 無料枠で任意宛先に送信可能（300通/日）、ドメイン未検証でも送信可、API がシンプル |
| 代替 | Resend（https://resend.com/）— 要ドメイン検証、3,000通/月 |

### 18.2 将来の移行を考慮した設計

メール送信ロジックを抽象インターフェースとして定義し、サービスを差し替え可能にする。

```typescript
// lib/mail/mail-provider.ts
export interface MailProvider {
  send(params: MailParams): Promise<MailResult>;
}

export type MailParams = {
  to: string;
  subject: string;
  html: string;        // レンダリング済み HTML
  text?: string;       // プレーンテキスト（フォールバック）
  replyTo?: string;
};

export type MailResult = {
  success: boolean;
  messageId?: string;
  error?: string;
};
```

```typescript
// lib/mail/brevo-provider.ts（MVP 実装 — 推奨）
export class BrevoMailProvider implements MailProvider {
  async send(params: MailParams): Promise<MailResult> {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': process.env.BREVO_API_KEY },
      body: JSON.stringify({
        sender: { name: process.env.MAIL_FROM_NAME, email: process.env.MAIL_FROM },
        to: [{ email: params.to }],
        subject: params.subject,
        htmlContent: params.html,
      }),
    });
    const data = await res.json();
    return { success: res.ok, messageId: data.messageId };
  }
}

// lib/mail/resend-provider.ts（代替: 要ドメイン検証）
// lib/mail/console-provider.ts（開発環境用: コンソール出力）
// lib/mail/inbox-provider.ts（E2E テスト専用: ファイル出力）
```

```typescript
// lib/mail/index.ts
// 環境変数 MAIL_PROVIDER で切替
export function createMailProvider(): MailProvider {
  const provider = process.env.MAIL_PROVIDER || 'console';
  switch (provider) {
    case 'brevo': return new BrevoMailProvider();  // 本番推奨
    case 'resend': return new ResendMailProvider();  // 代替選択肢
    case 'inbox': return new InboxMailProvider(process.env.INBOX_DIR);  // E2E
    case 'console':
    default: return new ConsoleMailProvider();
  }
}
```

> **注**: PR #123 で `smtp` ケース記載を削除 (実装未提供で指定時 console fallback、docs 債務清算)。

### 18.3 メールテンプレート一覧

| テンプレート名 | 件名 | トリガー | 主な内容 |
|---|---|---|---|
| email-verification | アカウントの有効化 | アカウント登録時 | 検証リンク（有効期限24時間） |
| password-reset-complete | パスワード変更完了 | パスワードリセット完了時 | 変更日時、心当たりがない場合の連絡先 |
| password-changed | パスワード変更完了 | パスワード変更時（ログイン中） | 同上 |
| account-inactive-warning | アカウント無効化の警告 | 最終ログインから23日後 | 残り日数、ログインリンク |
| account-deactivated | アカウントが無効化されました | 最終ログインから30日後 | 復帰方法、物理削除までの日数 |
| mfa-enabled | 多要素認証が有効化されました | MFA 有効化時 | 設定日時 |
| admin-role-change-alert | 権限変更通知 | 権限変更時（管理者向け） | 対象ユーザ、変更内容、変更者 |

### 18.4 送信の実装方針

| 項目 | 方針 |
|---|---|
| 送信タイミング | サーバ処理内で非同期送信（レスポンスをブロックしない） |
| リトライ | 送信失敗時に最大3回リトライ（指数バックオフ: 1秒→4秒→16秒） |
| ログ記録 | 送信成功/失敗を audit_logs に記録（operation_trace_logs 有効時はそちらにも記録） |
| テンプレート管理 | React Email コンポーネントとして管理 |
| 開発環境 | ConsoleMailProvider でコンソールに出力（実送信しない） |
| 送信元アドレス | 環境変数 MAIL_FROM で設定（例: noreply@example.com） |

### 18.5 環境変数

| 変数名 | 説明 | 例 |
|---|---|---|
| RESEND_API_KEY | Resend の API キー | re_xxxxxxxxxx |
| MAIL_FROM | 送信元メールアドレス | noreply@example.com |

---

## 19. 今後の詳細化対象

MVP-1a / 1b / 2 の実装が完了し、以下が実装済みとなった。

実装済み:
- ~~Prisma Schema 定義ファイルの実装~~ → prisma/schema.prisma に全テーブル定義済み
- ~~Zod バリデーションスキーマの詳細定義~~ → src/lib/validators/ に全スキーマ定義済み

次段階で追加・詳細化する:
- バックアップ・リストア手順
- 災害復旧（DR）方針
- 監視・アラート設計
- ログ運用設計（アプリケーションログのフォーマット・保存期間）
- 定期棚卸ルール（アカウント・権限・プロジェクトの見直し）
- CI/CD パイプライン詳細
- 環境構成（開発・ステージング・本番の差分管理）
- コーディング規約
- 編集 UI の充実（見積もり・ナレッジのインライン編集）
- E2E テスト（Playwright）の導入

---

## 20. 備考

本設計書は、要件定義書（REQUIREMENTS.md）および仕様書（SPECIFICATION.md）に基づく、たすきば Knowledge Relay MVP の技術設計ドラフトである。
実装開始後、技術的な制約や運用要件に応じて改訂する。

---

## 21. 設計原則 (PR #63 追加)

本プラットフォームの UI / コード全般で遵守すべき横断的な原則を明示する。
新規実装・リファクタ時は本セクションを参照し、違反があれば是正する。
ただし、既存コードの書き換え範囲が大きく影響が読みづらい場合は据え置きも許容する
（「動いているものを壊さない」を優先する判断）。

### 21.1 デザインの 3 原則（そろえる・まとめる・繰り返す）

鷹野雅弘氏らが提唱する画面設計 / タイポグラフィの指針を本プラットフォームでも採用する。
UI 要素の配置・配色・余白・見出し階層などに適用する。

| 原則 | 意味 | 本プロダクトでの適用例 |
|---|---|---|
| **そろえる** | 位置・大きさ・色・書式を揃え、視線の迷いを減らす | ダイアログ共通のフィールド並び (公開範囲を常にフォーム先頭に配置する等)、`nativeSelectClass` / `Button` バリアントを一律に使う |
| **まとめる** | 関連する情報を近接・グルーピングして意味単位で認識させる | `grid grid-cols-2 gap-4` で「公開範囲」「脅威/好機」をセットで提示する等、`Table` ヘッダの whitespace-nowrap で論理単位を崩さない |
| **繰り返す** | 同じ意味のものには同じ見た目を使う | リスク一覧・全リスク一覧・全○○ 一覧で同じ `Badge` バリアントを使う、日時は全画面で `formatDateTime` ユーティリティに揃える |

### 21.2 DRY 原則 (Don't Repeat Yourself)

Andrew Hunt / David Thomas『達人プログラマー』で定式化された原則。
「**同じ知識をシステム内で 2 箇所以上で表現しない**」を方針とする。
単なる文字列の重複ではなく「ドメイン上の同じ知識 / ルール」が複数箇所に散らばることを避ける。

本プロダクトで特に意識する適用点:

- **マスタ定数の単一化**: `src/types/index.ts` の `TASK_STATUSES` / `VISIBILITIES` / `RISK_NATURES` / `PRIORITIES` 等を UI と検証（zod）で共有する
- **フィルタ / ツリー走査ユーティリティの共通化**: WBS・ガント・マイタスクで使う `filterTreeByAssignee` / `filterTreeByStatus` / `collectAllIds` を `src/lib/task-tree-utils.ts` に一元化する
- **UI コンポーネントの共通化**: 複数選択フィルタは `MultiSelectFilter` (WBS・ガント・マイタスクで共通)、編集ダイアログは `RiskEditDialog` / `RetrospectiveEditDialog` / `KnowledgeEditDialog` を「一覧」「全○○」両方で共有する
- **セッション設定の永続化**: `useSessionState` / `useSessionStringSet` (`src/lib/use-session-state.ts`) を使い、各画面でバラバラに sessionStorage アクセスを書かない
- **サーバ側ルールの共通化**: 公開範囲 (visibility) フィルタ `{ OR: [{visibility:'public'}, {visibility:'draft', ...:userId}] }` 等、認可ロジックは service 層に集約する

### 21.3 原則適用の判断基準

1. **最優先**: 同一の「ドメイン知識」が 2 箇所以上に現れたら共通化を検討する
2. **共通化のコストが利得を上回る場合**: 据え置き可 (例: 3 行の類似コードで別々に成長する可能性が高いもの)
3. **リファクタの副作用が大きい場合**: PR を分離し段階的に実施する。動作確認不足な変更は避ける
4. **違反の発見時**: ユーザ要求の本線を阻害しない範囲で本 PR 中に是正、困難なものは TODO コメントと Issue として残す

### 21.4 ゼロハードコーディング原則 (PR #75 で明文化)

#### 21.4.1 原則

> **業務的な意味を持つ値はプログラム内にハードコードせず、専用の定義ファイル / 設定ファイルに外出しする。**
> プログラムは定義を**参照する**のみとし、値そのものを埋め込まない。

「業務的な意味を持つ値」とは、**その値の変更がユーザ体験・データ整合性・運用方針に影響するもの** を指す。
逆に、純粋な実装詳細 (ループカウンタ / 内部フラグ / アルゴリズムの閾値など) は対象外。

#### 21.4.2 背景と狙い

複数画面・複数機能を横断する値 (カラー・ラベル・ステータス名・API パス・閾値など) がコード中に散在すると、以下の問題が累積する。

1. **横展開漏れ** — 1 箇所だけ値が更新され、他画面が旧値のままになり UI/データ不整合を起こす
2. **運用保守工数の増加** — 「値を変えたい」要求が都度プログラマを介した全検索・全置換作業になる
3. **画面/機能間の統一が崩れる** — 同じ概念が画面ごとに微妙に違う表記で実装され、ユーザ学習コストが増える
4. **テスト不能** — 「この値がここに現れる」という暗黙知がテスト不可能な形で分散する

これらは PR #73 (テーマ定義一元化) の原体験でも検証済み。定義ファイル化により:

- 値の**追加漏れ**を型検査で検出可能に (`satisfies Record<..., ...>`)
- 値の**一覧性**が確保され、新メンバーでも選択肢全体を把握できる
- **テスト**で「全ての画面/状態で参照されている」ことを自動検証できる

#### 21.4.3 スコープ: 外出し対象の値

以下のカテゴリは **原則として外出し必須**。

| カテゴリ | 典型例 | 正規の格納先 (PR #75 Phase 1 で `src/config/` に集約) |
|---|---|---|
| マスタデータ列挙 | タスク状態 / 公開範囲 / 優先度 / 脅威/好機 | `src/config/master-data.ts` (`TASK_STATUSES` / `VISIBILITIES` / `PRIORITIES` / `RISK_NATURES` 等) |
| UI テーマカタログ (表示名) | 画面テーマの ID と表示ラベル | `src/config/themes.ts` |
| UI テーマ・配色の CSS 変数値 | 背景色 / テキスト色 / ボーダー色 / アクセント色 | `src/config/theme-definitions.ts` (PR #73) |
| 業務ドメインタグ・工程タグ・技術スタック | 提案型サービスで使う候補語彙 | 専用定義モジュール (将来 `src/config/vocabulary.ts` を想定、要確認) |
| 環境依存値 | DB 接続文字列 / API キー / URL / cron 設定 | `.env` (詳細は [OPERATION.md](../administrator/OPERATION.md) §1) |
| 数値閾値で業務的意味があるもの | ログイン失敗ロック回数 / セッション有効時間 / パスワード最小文字数 | `src/config/security.ts` |
| 認可判定用ルートパス | `/login`, `/api/auth`, MFA pending paths 等 | `src/config/routes.ts` |
| 提案スコアリング重み・閾値 | TAG_WEIGHT / TEXT_WEIGHT / SCORE_THRESHOLD | `src/config/suggestion.ts` |
| 画面ラベル・メッセージ文言 | 共通ボタン文言・エラーメッセージ | 原則 JSX 内は許容 (国際化対応は未着手)、ただし**同じ文言が 3 箇所以上**で使われたら共通化する |
| 日付・数値のフォーマット規則 | YYYY-MM-DD / 小数桁数 / 通貨表記 | `src/lib/format/` 相当のユーティリティ (`formatDateTime` 等) |

#### 21.4.4 スコープ外 (ハードコードで許容)

以下は本原則の**対象外** (過度な抽象化を避けるため)。

- 関数内のローカル変数・実装ロジックの分岐値 (例: 配列インデックス、ループ上限)
- テストコード内の期待値 (テストは「この値のとき」を固定するものが本質)
- 明らかに普遍の定数 (円周率、ミリ秒換算係数の `1000` 等)
- その場限りの一時的な値で、他所から参照される予定がないもの

#### 21.4.5 定義ファイルの設計ガイド

新しく定義ファイルを作る際は、PR #73 のテーマ定義を雛形とする (設計書 §29 参照)。共通して満たすべき要件:

1. **型安全な網羅**: `satisfies Record<Key, Value>` パターンで「全 Key が値を持つ」ことをコンパイル時に保証
2. **単一ファイル原則**: 関連する値は 1 ファイルに集約 (検索容易性 + PR 差分の見通し)
3. **値の意味をコメントで明記**: 「なぜこの値なのか」を各エントリで説明
4. **テストで整合性を検証**: 「定義の全キーが想定通りに処理されるか」を網羅するテストを書く
5. **変更手順をコメントで誘導**: 「値を追加するときはここと、ここと、ここを触る」の指示を冒頭コメントに

#### 21.4.6 現在の遵守状況 (2026-04-21 時点、PR #76 Phase 2 実施後)

| 領域 | 遵守状況 | 備考 |
|---|---|---|
| マスタデータ列挙 | ✅ 準拠 | `src/config/master-data.ts` に集約 (PR #75 Phase 1)。`src/types/index.ts` は後方互換の re-export |
| テーマカタログ / 色定義 (CSS 変数) | ✅ 準拠 | `src/config/themes.ts` + `src/config/theme-definitions.ts` に集約 |
| 認証・ロック・トークン期限 | ✅ 準拠 | `src/config/security.ts` に集約 (PR #75 Phase 1 で 4 ファイル重複解消) |
| 認可判定用ルートパス | ✅ 準拠 | `src/config/routes.ts` に集約 (`PUBLIC_PATHS` / `MFA_PENDING_PATHS` / `LOGIN_PATH` / `MFA_LOGIN_PATH`) |
| 提案スコアリング重み | ✅ 準拠 | `src/config/suggestion.ts` に集約 |
| 環境依存値 | ✅ 準拠 | `.env` / `.env.example` に集約 |
| **Tailwind パレット色** (`bg-gray-50` / `text-gray-500` / `bg-red-50` 等) | ✅ **準拠 (PR #76 Phase 2 で完了)** | 全 ~395 箇所を semantic token (`bg-muted` / `text-muted-foreground` / `bg-destructive/10` 等) に置換。新セマンティックトークン (`info` / `success` / `warning` / `milestoneMarker`) を `theme-definitions.ts` に追加し全テーマで定義 |
| 設定画面のテーマプレビュー色 | ✅ 準拠 | hex リテラル 10 行を `THEME_DEFINITIONS` 参照に置換 (テーマ定義の真実から派生) |
| 業務ドメインタグ・工程タグ (候補語彙) | 🟡 部分的 | 現状は入力側で自由文字列。候補語彙の定義ファイル化は今後検討 (要確認) |
| ページ遷移の Link / href (`/projects` 等) | ✅ 準拠 (PR #81) | `src/config/app-routes.ts` に集約。redirect / Link / router.push の全 URL リテラルを定数 / 関数参照に移行 |
| バリデーション数値 (Zod / JSX maxLength) | ✅ 準拠 (PR #81) | `src/config/validation.ts` に集約。Zod スキーマ (knowledge / memo / risk / project / retrospective / estimate / attachment / auth) を全て定数参照に移行 |
| UI ラベル: 共通アクション動詞 (保存 / 削除 / キャンセル等 9 語) | ✅ 準拠 (PR #77 Phase A) | `src/i18n/messages/ja.json` の `action.*` に集約。`useTranslations('action')` / `getTranslations('action')` で参照。テストでキー集合を検査 |
| UI ラベル: 共通フォームラベル (件名 / 内容 等) | 🟢 Phase B カタログ完備 + 主要 dialog 移行済 (PR #82) | `field.*` 20 キー、user-edit / risk-edit / retrospective-edit dialog で `tField()` 使用例あり。残ファイルは段階実施 |
| UI ラベル: 共通メッセージ (saveSuccess / deleteConfirm 等) | 🟢 Phase C カタログ拡張 (PR #82) | `message.*` 13 キー (createFailed / updateFailed / passwordChanged 追加)。JSX 移行は段階実施 |
| CI ワークフロー有効化 | ✅ 準拠 (PR #82) | `.github/workflows/ci.yml` (lint/test/build) + `security.yml` (gitleaks/audit/CodeQL) を有効化 |
| CONTRIBUTING.md | ✅ 準拠 (PR #82) | コミット前チェックリスト / PR 規約 / コードレビューチェックリスト / 禁止事項を集約 |
| 視覚回帰検証 | 🟡 ユーザ実施待ち | `docs/VISUAL_REGRESSION_CHECKLIST.md` (PR #82) を整備、10 テーマ × 主要画面の目視確認手順を文書化 |
| UI ラベル: 画面固有本文 | 🟡 部分的 | 真の多言語化が必要になった段階で Phase D として一括抽出。当面は JSX リテラル許容 |
| コンポーネント固有のレイアウト定数 (Gantt の DAY_WIDTH 等) | 🟢 自己完結で許容 | 単一コンポーネント内のみで使用される数値 (§21.4.4 スコープ外) |
| Tailwind utility class (`flex` / `gap-4` / `p-3` 等) | 🟢 対象外 | レイアウト・配置・サイズの class は外出し対象外 (Tailwind 設計方針に基づく) |
| **サービス層 / API ルートのトップレベル docblock** (PR #79 Phase 1) | ✅ 準拠 | 全 18 サービス + 全 56 API ルートに役割・認可要件・監査記録・関連設計書セクションを記述。AI なしの将来運用引き継ぎを支える人間可読性確保 |

#### 21.4.7 違反発見時の対応フロー

1. 違反を見つけたら、まず**横展開スキャン** (`grep` 等) で全箇所を列挙する
2. 件数・影響範囲を評価し、以下のどれかを選ぶ:
   - **本 PR 内で是正** (数箇所・影響範囲が狭い場合)
   - **別 PR で段階是正** (横断的・数十箇所以上の場合)
   - **既知違反として本節 §21.4.6 に追記** (即時是正が現実的でない場合)
3. 「既知違反」として残す場合は、**テスト・ドキュメントで現状を明示**し、将来の担当者が実態を誤認しないようにする

---

## 22. 添付リンク設計 (PR #64)

### 22.1 方針

実ファイルを DB / Supabase Storage に**保持しない**設計とし、外部ストレージ (SharePoint / Google Drive / OneDrive / GitHub 等) の **URL 参照のみ** を格納する。
Supabase Free (DB 500MB / Storage 1GB) の無料枠で長期運用することを最優先した判断。
base64 化で DB に格納する案は「容量が +33% に膨張し、500MB 上限を数十ファイルで使い切る」「一覧 API が重くなる」ため採用しない。

### 22.2 データモデル

単一のポリモーフィック関連テーブル `attachments` に 6 エンティティ (project / task / estimate / risk / retrospective / knowledge) を集約する (DRY 原則 §21.2)。

| カラム | 型 | 役割 |
|---|---|---|
| `id` | UUID | PK |
| `entity_type` | VARCHAR(30) | 親エンティティ種別 |
| `entity_id` | UUID | 親エンティティ ID |
| `slot` | VARCHAR(30) | 'general' (複数) / 'primary' / 'source' (単数) |
| `display_name` | VARCHAR(200) | 表示名 |
| `url` | VARCHAR(2000) | 外部ストレージ URL (http/https のみ) |
| `mime_hint` | VARCHAR(50)? | アイコン表示用のヒント (任意) |
| `added_by` | UUID | 追加ユーザ (FK: users.id) |
| `created_at / updated_at / deleted_at` | TIMESTAMPTZ | 論理削除対応 |

インデックス: `(entity_type, entity_id)` と `(entity_type, entity_id, slot)`。
FK は `added_by` のみ (エンティティ側は種別が可変のため FK を張らず `resolveProjectIds` で逆引き)。

### 22.3 スロット運用

| スロット | 用途 | 件数制約 | 適用エンティティ |
|---|---|---|---|
| `general` | 一般的な関連 URL | 複数 | 全エンティティ |
| `primary` | 中心となる資料 1 本 | 単数 (UI 強制) | project |
| `source` | 一次情報源 URL | 単数 (UI 強制) | knowledge |

単数スロットへの POST 時、サービス層は**既存行を論理削除してから新規作成**する (置換)。履歴は `deleted_at` に残るため監査に追跡可能。

### 22.4 セキュリティ

- URL スキームは `http://` / `https://` のみ validator で許容
- `javascript:` / `data:` / `file:` は validator + UI pattern 両方で拒否 (XSS / 情報漏洩対策)
- 表示は `<a href={url} target="_blank" rel="noopener noreferrer">` を徹底 (tabnabbing 対策)

### 22.5 認可

- admin: 全エンティティで全操作許可
- メンバー: 親エンティティ → Project ID を `resolveProjectIds` で導出し、`checkMembership` で判定
- 複数プロジェクト紐付けのナレッジ: いずれか 1 つでもメンバーなら許可
- 孤児ナレッジ (`knowledge_projects` 0 件): admin のみ操作可能

### 22.6 UI コンポーネント

| コンポーネント | 用途 |
|---|---|
| `AttachmentList` (`src/components/attachments/attachment-list.tsx`) | 複数 URL 用。リスト表示 + 追加フォーム |
| `SingleUrlField` (`src/components/attachments/single-url-field.tsx`) | 単数 URL 用。未設定時は追加ボタン、設定済みなら編集/削除 |

### 22.7 フェーズ分けと組込み状況

| フェーズ | 内容 | 状態 |
|---|---|---|
| Phase 1 | スキーマ / validator / service / API / 共通 UI | PR #64 で実装 |
| Phase 2 | リスク/課題・振り返り・ナレッジ・タスク・プロジェクト概要タブへの組込み | PR #64 で実装 |
| Phase 3 | Estimate (編集ダイアログ基盤が未整備のため延期) / リンク切れチェック / Slack 通知 | 未着手 |

---

## 23. 核心機能: 提案型サービス (PR #65)

### 23.1 位置付け

本プロダクトの**核心価値**は、単なる情報の一元管理ではなく
「**過去の資産を未来のプロジェクトに自動で活かす**」ことにある。
人が探す限り抜け漏れが発生し、未然に防げた課題が顕在化してしまう。
本機能はその抜け漏れを極小化することを目的とする。

### 23.2 推薦対象

| エンティティ | 絞り込み条件 | 理由 |
|---|---|---|
| Knowledge | `visibility='public'` + 論理削除除外 | 全社で共有済の知見のみを候補にする |
| 過去 Issue (type='issue') | `state='resolved'` + 他プロジェクト | リスクは未発生の不確実性で「事実」ではないため除外。発生済かつ解消済の課題のみを過去資産として扱う |

**除外**: 自プロジェクトのナレッジ / 自プロジェクトの Issue (普段の一覧で見える)、
未解消 Issue、Retrospective (プロジェクト固有性が強く横展開価値が低い、Phase 2 で検討)。

### 23.3 類似度計算

2 つの指標の重み付き平均 (Phase 1 の既定は 50% / 50%):

**タグ交差 (Jaccard 係数)**: Project タグ (businessDomain ∪ techStack ∪ process) と Knowledge タグ (tech ∪ process) を
大文字小文字無視・前後空白除去・重複除外した上で集合比較。過去 Issue はタグ列を持たないため `tagScore=0`。

**テキスト類似度 (pg_trgm similarity)**: Project の purpose + background + scope を `$queryRaw` で渡し、
対象テキスト (Knowledge: title + content / Issue: title + content) と比較。PostgreSQL の `pg_trgm` 拡張を
migration で有効化済。`gin_trgm_ops` GIN インデックスで高速化。

**最終スコア**: `(tagScore × 0.5 + textScore × 0.5)` → 閾値 0.05 以上で採用、上位 10 件 (`limit` で可変)。

### 23.4 採用 UX

| 対象 | 操作 | DB 影響 |
|---|---|---|
| Knowledge | 「このプロジェクトに紐付け」 | `knowledge_projects` に中間行 INSERT (skipDuplicates) |
| 過去 Issue | 「雛形として採用」 | 新規 `risks_issues` を type='issue' / state='open' / visibility='draft' で複製。title / content / cause / impact / likelihood / priority / responsePolicy / responseDetail を継承し、reporter は採用者に差し替え |

採用後の Issue は「未然対応」の位置付けなので state='open' からリスタート。過去の result / lessonLearned は持ち越さない。

### 23.5 発動ポイント

- **(A) 新規プロジェクト作成直後**: 作成成功時に `/projects/[id]?suggestions=1` に遷移 → `SuggestionsPanel` をモーダル表示。抜け漏れゼロ化の UX を強制露出する
- **(B) プロジェクト詳細「参考」タブ**: 常設。いつでも再確認できる

両方とも `SuggestionsPanel` を再利用する (DRY 原則 §21.2)。

### 23.6 スキーマ変更

- `projects.process_tags` (JSONB NOT NULL DEFAULT '[]') を追加 (Knowledge 側の粒度に揃える)
- `CREATE EXTENSION IF NOT EXISTS pg_trgm`
- `knowledges.title` / `knowledges.content` / `risks_issues.title` / `risks_issues.content` に `gin_trgm_ops` インデックス

### 23.7 認可

- GET: `project:read` (メンバー or admin)
- POST (採用): `project:update` (pm_tl / member / admin)
- 他プロジェクトの Issue を含むため「そのプロジェクトのメンバー」に閲覧を限定

### 23.8 フェーズ

| フェーズ | 内容 | 状態 |
|---|---|---|
| Phase 1 | タグ交差 + pg_trgm、参考タブ + 作成後モーダル、Knowledge 紐付け + Issue 雛形複製 | PR #65 で実装 |
| Phase 2 (a) | Retrospective を推薦対象に追加 (読み物として提示、採用操作なし) | PR #65 で追加実装 |
| Phase 2 (b) | Knowledge に businessDomainTags 追加、Project と対称化 | PR #65 で追加実装 |
| Phase 2 (c) | リスク起票ダイアログで類似過去課題を inline 提示 (500ms debounce) | PR #65 で追加実装 |
| Phase 2 (d) 延期 | フィードバック学習 (採用/却下履歴) — 実運用データ蓄積後に再検討 | 未着手 |
| Phase 2 (e) 延期 | 振り返りからナレッジ化自動フロー — 責務が「蓄積」側なので別 PR | 未着手 |
| Phase 3 | 埋め込みベクトル検索 (pgvector + OpenAI embeddings)、精度評価指標の監視 | 未着手 |

### 23.10 Phase 2 追加要素の詳細 (PR #65 続編)

**(a) Retrospective 推薦**
- `suggestForProject` が返す `SuggestionsResult.retrospectives` に追加
- テキスト類似度は `problems + improvements` 連結で計算 (振り返りの最も意味のある部分)
- `gin_trgm_ops` インデックスを `retrospectives.problems` / `retrospectives.improvements` に付与
- UI は `SuggestionsPanel` に読み物専用セクションとして追加、採用ボタンなし

**(b) Knowledge.businessDomainTags**
- スキーマに `business_domain_tags JSONB NOT NULL DEFAULT '[]'` 追加
- `unifyKnowledgeTags` に反映、Jaccard の比較軸を Project と対称化
- Knowledge 作成フォームに 3 種類のタグ入力欄 (businessDomain / tech / process) を追加
- 既存ナレッジは空配列で起動、PATCH で後追い登録可

**(c) 起票中の類似過去課題 inline 提示**
- 専用軽量 API `POST /api/projects/:projectId/suggestions/related-issues`
- 入力 text が 10 文字以上のときのみ、500ms debounce で問い合わせ
- 閾値 0.08 / 上位 5 件 (メインフォームの表示スペースを圧迫しないため Phase 1 より厳しめ)
- 過去同種課題への気付きを促す警告バナー UI

### 23.9 実装ファイル参照

- `src/lib/similarity.ts` / `similarity.test.ts` — 純粋関数 (Jaccard / unify / combineScores) + 16 テストケース
- `src/services/suggestion.service.ts` — サービス層 (DB クエリ + 採用操作 + pg_trgm raw SQL)
- `src/app/api/projects/[projectId]/suggestions/route.ts` — GET
- `src/app/api/projects/[projectId]/suggestions/adopt/route.ts` — POST (採用)
- `src/app/(dashboard)/projects/[projectId]/suggestions/suggestions-panel.tsx` — 共通 UI (参考タブ + 作成後モーダル共用)

---

## 24. PR #67: 作成ダイアログの添付入力 + 一覧添付列 + MFA ログイン強化

### 24.1 作成ダイアログの添付 URL 入力 (Task 1)

既存の AttachmentList / SingleUrlField は **編集**ダイアログ専用 (entityId 必須)。
**作成**ダイアログでは entityId が存在しないため、専用の `StagedAttachmentsInput`
を導入し、React 内でステージした後に作成成功後のエンティティ ID で一括 POST する。

| 箇所 | entityType | 採用 slot |
|---|---|---|
| `ProjectsClient` 新規作成 | project | general |
| `TasksClient` 作成 (WP/ACT) | task | general |
| `RisksClient` 起票 | risk | general |
| `RetrospectivesClient` 作成 | retrospective | general |
| `ProjectKnowledgeClient` 作成 | knowledge | general |

実装: `src/components/attachments/staged-attachments-input.tsx` の
`persistStagedAttachments({ entityType, entityId, items })` を作成 API 呼び出し成功直後に実行。
部分失敗時は親エンティティを残し、呼び出し側で `{ succeeded, failed }` を受け取れる設計。

### 24.2 一覧画面への添付列 (Task 2)

各一覧行に紐づく添付を **chip 形式**の 1 つのセルに並べて表示 (技術的に
「リンクの数だけ動的に追加」される)。N+1 を避けるためバッチ取得 API を新設:

- `POST /api/attachments/batch` — `{ entityType, entityIds[], slot? }` で一括取得、`{ [entityId]: AttachmentDTO[] }` 返却 (O(1) lookup)
- `useBatchAttachments(entityType, ids, slot?)` フックで UI 側からキャッシュアクセス
- `<AttachmentsCell items={...} />` で chip 描画、`target="_blank" rel="noopener noreferrer"` 徹底

導入箇所:
- `/risks` / `/issues` (AllRisksTable)
- `/retrospectives` (AllRetrospectivesTable)
- `/knowledge` (KnowledgeClient)
- `/projects/[id]/risks` / `/issues` (RisksClient 内テーブル)

### 24.3 MFA ログインフロー強化 (Task 3)

**問題**: MFA 有効化後もログイン時に TOTP 検証されず、パスワードのみで通過できる状態だった。

**修正**:
- `authorize` で `mfaEnabled` を返却
- `jwt` callback が新規ログイン時 (user !== undefined) に **常に `mfaVerified=false` にリセット**。以前のセッションで検証済でも新規ログインでは再検証必須
- `authorized` callback (middleware) が `mfaEnabled && !mfaVerified` の未検証ユーザを `/login/mfa` に redirect
- `/login/mfa` で TOTP 検証 → `useSession().update({ mfaVerified: true })` で JWT を trigger='update' 経由で再署名
- 再署名後、`callbackUrl` へ遷移

セキュリティ補強:
- `/api/auth/mfa/verify` の `userId` をセッションユーザと厳格比較 (他人の TOTP 検証を防止)
- `mfaPendingPaths` (/login/mfa, /api/auth/mfa/verify, signout) のみ検証前アクセスを許容し他は全て遮断

---

## 25. PR #68: 一覧列幅のドラッグリサイズ

### 25.1 背景

ガント画面や一覧画面で「タスク名」「件名」「顧客名」などの長文列が切り詰められ、
ユーザが中身を確認できない状況が発生していた (既存の whitespace-nowrap + overflow-hidden)。
ユーザ自身が UI 上で列幅を調整できるようにして画面構成を最適化できるようにする。

### 25.2 共通機構

`src/components/ui/resizable-columns.tsx` に集約 (DRY 原則 §21.2):

| エクスポート | 役割 |
|---|---|
| `<ResizableColumnsProvider tableKey="...">` | 列幅状態を sessionStorage と同期 (`resizable-cols:<tableKey>` キー) |
| `<ResizableHead columnKey="..." defaultWidth={...}>` | `<th>` + 右端ドラッグハンドル、セッション優先で幅決定 |
| `<ResetColumnsButton />` | プロバイダ配下の幅をすべて消去 (デフォルトに戻る) |

- 最小 40px / 最大 800px でクランプ
- `sessionStorage` を使用 (タブ/ブラウザを閉じると破棄、既存の `useSessionState` パターンと統一)

### 25.3 導入範囲

| 画面 | tableKey | 備考 |
|---|---|---|
| `/projects` | `projects` | |
| `/risks` / `/issues` | `all-risks` | typeFilter 別でも同一キー (同一テーブル構造) |
| `/retrospectives` | `all-retrospectives` | |
| `/knowledge` | `all-knowledge` | |
| `/projects/[id]/risks` / `/issues` | `project-risks-<risk|issue|all>` | typeFilter で分岐 |
| `/my-tasks` | `my-tasks` | 複数プロジェクトセクションが同一 Provider で幅を共有 |
| `/projects/[id]/tasks` (WBS) | `project-tasks` | |
| `/projects/[id]/gantt` | (専用実装) | タスク名列のみ対応、日付列は `DAY_WIDTH` 固定 |

### 25.4 ガントチャート専用実装

ガントは絶対位置レイアウトで `NAME_COL_WIDTH` を複数箇所から参照していたため、
ResizableHead 共通機構ではなく**ガント固有の state + ドラッグ**を実装:

- `useSessionState('gantt:<projectId>:name-col-width', 280)` で永続化
- タスク名ヘッダ右端に絶対配置のドラッグハンドル
- 「タスク名列の幅をリセット」ボタンを画面右上に配置
- 日付列は固定 (ユーザ要求: 「日付列は固定で問題ない」)

### 25.5 データフロー

```
ユーザがハンドルをドラッグ
  → onMouseDown で startX/startWidth を capture
  → document の mousemove で delta 計算 → setState
  → useSessionState が sessionStorage を同期更新
  → 次レンダーで th/div に style width 反映
```

### 25.6 Reset UX

各一覧画面の右上に「列幅をリセット」ボタンを配置し、1 クリックで sessionStorage から
当該 `tableKey` のエントリを削除 (`{}` で上書き) → 各 `<ResizableHead>` が defaultWidth に戻る。

---

## 26. PR #70: 個人メモ機能

### 26.1 位置付け

既存の Knowledge はプロジェクト紐付け必須 (KnowledgeProject 経由) で共有前提のため、
個人の一時的な作業メモ・調査ログの置き場として**重すぎた**。独立エンティティとして
`Memo` を新設し「プロジェクトに紐付かない個人の知見置き場」を実現する。

### 26.2 スキーマ

```prisma
model Memo {
  id         String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  userId     String    @map("user_id") @db.Uuid
  title      String    @db.VarChar(150)
  content    String    @db.Text
  visibility String    @default("private") @db.VarChar(20)  // 'private' | 'public'
  createdAt  DateTime  @default(now()) @map("created_at") @db.Timestamptz
  updatedAt  DateTime  @updatedAt @map("updated_at") @db.Timestamptz
  deletedAt  DateTime? @map("deleted_at") @db.Timestamptz

  author User @relation("MemoAuthor", fields: [userId], references: [id])

  @@index([userId, createdAt(sort: Desc)], map: "idx_memos_user_recent")
  @@index([visibility, createdAt(sort: Desc)], map: "idx_memos_visibility_recent")
  @@map("memos")
}
```

タグを持たせない設計判断: 業務知見判断は人間ベース、軽量 UX を優先 (PR #70 要件)。

### 26.3 認可モデル

**他エンティティとの根本的な違い**: memo は project スコープ**外**、admin 特権**なし**。

| 操作 | 許可条件 |
|---|---|
| 閲覧 (list/get) | 作成者 OR `visibility='public'` |
| 作成 | 認証済ユーザなら誰でも (自分の memo として) |
| 編集・削除 | 作成者のみ (admin も不可) |

`getMemoForViewer`: 他人の private memo は `null` を返し、呼び出し側で 404 に変換 (403 ではなく 404 で「存在自体を隠す」情報漏洩防止)。

### 26.4 Attachment 統合

PR #64 の polymorphic attachments 機構を `entityType='memo'` で拡張。

- `resolveProjectIds('memo', ...)`: memo が存在すれば `[]` (project ID なし)、存在しなければ `null`
- `authorizeMemoAttachment(memoId, userId, mode)`: memo 固有の認可を別関数に切り出し
- attachments `route.ts` / `[id]/route.ts` の `authorize` は最初に entityType === 'memo' で分岐、project 経路をスキップ
- batch API は memo の場合 entityIds を `userId+visibility` でフィルタしてから attachments を取得 (URL 漏洩防止)

### 26.5 UI

- ナビ: ユーザ名プルダウンに「**全メモ**」追加 (マイタスクの下、設定の上)
- 画面 `/memos`: 一覧 + 右上「メモ作成」ボタン + 列幅リサイズ (PR #68) + 添付列 (PR #67)
- 自分のメモは行クリックで編集ダイアログ、他人のメモは参照のみ (クリック不活性)
- 作成ダイアログ: `StagedAttachmentsInput` で URL 添付を同時登録 (PR #67)

### 26.6 フェーズ分け (将来拡張)

| フェーズ | 内容 | 状態 |
|---|---|---|
| Phase 1 | Memo 基本 CRUD + visibility + URL 添付 | PR #70 で実装 |
| Phase 1.5 | UI を「メモ (個人管理)」と「全メモ (横断 read-only)」に分離 | PR #71 で実装 |
| Phase 1.5b | 全日付項目に「今日」「削除」ボタンを併設 (DateFieldWithActions) | PR #71 で追加実装 |
| Phase 2 | 「この Memo を Knowledge に昇格」ボタン (個人知見を社内資産に展開) | 未着手 (別 PR) |
| Phase 3 | Memo をソースとした提案サジェスト (匿名化して PR #65 に組込) | 未着手 |

### 26.7 PR #71: UI 分離の詳細

旧 `/memos` (PR #70) は「自分のメモ + 他人の public メモ」を同一画面に混在表示していた。
PR #71 で責務を明確化するため、以下の 2 画面に分離した。

| 画面 | URL | 役割 | 導線 | 操作 |
|---|---|---|---|---|
| メモ | `/memos` | 個人管理 (自分のメモ CRUD) | ユーザ名プルダウン | 作成・編集・削除 |
| 全メモ | `/all-memos` | 公開メモの横断閲覧 | 上部ナビ (全リスク/全課題 等と同列) | 参照のみ (read-only) |

**サービス層** (`memo.service.ts`) の変更:

```ts
// PR #70 の listMemosForViewer を 2 つに分割 (PR #71)
listMyMemos(viewerUserId)       // /memos 用: 自分のメモ (private + public)
listPublicMemos(viewerUserId)   // /all-memos 用: 全 public メモ
```

**API 層** の変更:

- `GET /api/memos?scope=mine|public` の 2 モードに対応
- scope 未指定 → 既定 `mine` (後方互換)

**UI 層** の変更:

- `memos-client.tsx`: タイトルを「メモ」に変更、(自分) バッジ削除 (全件自分のため)
- `all-memos-client.tsx`: 新設。`fieldset disabled` で全入力を read-only 化、添付も `canEdit={false}`
- `dashboard-header.tsx`: ドロップダウンは「メモ」、ナビに「全メモ」を追加

**認可は PR #70 から変更なし**:
- 他人の private メモは `/all-memos` でも表示されない (listPublicMemos で visibility='public' のみ返す)
- 全メモ画面からの編集試行は UI にボタンがないため発生しないが、もし直接 API を叩いても `/api/memos/:id` PATCH は作成者チェックで 404 を返す (二重防御)

---

## 27. PR #71: 日付項目の入力効率化 (DateFieldWithActions)

### 27.1 背景

ブラウザ標準の `<input type="date">` は「今日」「削除」相当の操作がカレンダーポップオーバー内部にしかない。
ユーザはカレンダーを開いてから探す必要があり、2 ステップのオペレーションが発生して負担が大きかった。

### 27.2 実装

`src/components/ui/date-field-with-actions.tsx` に共通部品 `<DateFieldWithActions>` を作成。

```tsx
<DateFieldWithActions
  value={form.plannedStartDate}
  onChange={(v) => setForm({ ...form, plannedStartDate: v })}
  required
  hideClear  // 必須項目では削除ボタンを非表示
/>
```

- 入力の**右**に「今日」ボタン (常時表示) と「削除」ボタン (未記入時 disabled)
- **1 クリック**で今日日付セット / 空文字クリア
- `required` / `disabled` / `hideClear` を prop で制御
- onChange は生文字列を受け取るため既存 state setter と直接接続可能

### 27.3 導入箇所 (全 11 箇所に展開)

| ファイル | 項目 |
|---|---|
| `projects-client.tsx` | プロジェクト新規: 開始予定日 / 終了予定日 |
| `project-detail-client.tsx` | プロジェクト編集: 開始予定日 / 終了予定日 |
| `tasks-client.tsx` (新規 ACT) | 開始予定日 / 終了予定日 |
| `tasks-client.tsx` (bulk edit) | 予定開始日 / 予定終了日 |
| `tasks-client.tsx` (bulk actual) | 実績開始日 / 実績終了日 |
| `tasks-client.tsx` (個別編集) | 予定開始日 / 予定終了日 / 実績開始日 / 実績終了日 |
| `retrospectives-client.tsx` | 実施日 |
| `retrospective-edit-dialog.tsx` | 実施日 |
| `risk-edit-dialog.tsx` | 期限 |

### 27.4 `hideClear` の使い分け

- 必須項目 (required): 削除ボタンを隠す (`hideClear`) → 空にできないのにボタンがあると誤解を招くため
- 任意項目: 削除ボタン表示 (空時は disabled)

---

## 28. PR #72: 自作カレンダーとテーマ設定

### 28.1 カレンダー自作への置き換え (Task 1)

ブラウザ標準 `<input type="date">` は、カレンダーポップオーバー内に「今日」「クリア」相当の
ベンダー提供ボタンを持ち、CSS / JS からは非表示化できない。PR #71 で右側に外出しした
「今日」「削除」ボタンと重複するため、ユーザ体験として冗長だった (要望: カレンダー内から
それらを消してほしい)。

対応として `DateFieldWithActions` を以下に刷新した:

- `<input type="date">` を廃止し、自作の Popover + 日付グリッドに置換
- カレンダー内は「月ナビ (‹ / ›) + 日付グリッド」のみ。今日 / クリアは**常時外側**のボタンで操作
- API サーフェス (`value` / `onChange` / `disabled` / `required` / `hideClear` / `todayLabel` / `clearLabel`) は
  PR #71 と完全互換 — 呼び出し側 11 箇所は変更なし
- 純粋関数 (`parseYMD` / `formatYMD` / `buildMonthGrid` / `todayString`) を
  `date-field-helpers.ts` に分離し、vitest でユニットテスト (9 ケース)

### 28.2 テーマ設定 (Task 3)

#### 28.2.1 テーマカタログ

`src/types/index.ts` の `THEMES` を唯一の真実とし、以下 10 種を提供:

| ID | 表示名 | 分類 |
|---|---|---|
| `light` | ライトテーマ（デフォルト） | 基調 |
| `dark` | ダークテーマ | 基調 |
| `pastel-blue` | パステル（青） | パステル (低彩度) |
| `pastel-green` | パステル（緑） | パステル |
| `pastel-yellow` | パステル（黄） | パステル |
| `pastel-red` | パステル（赤） | パステル |
| `pop-blue` | ポップ（青） | ポップ (高彩度) |
| `pop-green` | ポップ（緑） | ポップ |
| `pop-yellow` | ポップ（黄） | ポップ |
| `pop-red` | ポップ（赤） | ポップ |

`toSafeThemeId(unknown)` で DB / セッションから来た不正値を `light` に安全に丸めて返す
(攻撃面を閉じる)。

#### 28.2.2 永続化方式

要件「セッションにかかわらず永続的に適用」に対して、sessionStorage は不適切 (タブ/ブラウザ
閉じで失われる)。よって `users.theme_preference VARCHAR(30) NOT NULL DEFAULT 'light'` を追加
(`prisma/migrations/20260420_user_theme_preference/migration.sql`)。

- 書き込み経路: `PATCH /api/settings/theme` → Zod で `THEMES` のキー enum 検証 → `prisma.user.update` → 200
- 読み出し経路: NextAuth の `authorize` → `jwt` token → `session.user.themePreference`
- 反映経路: Root layout (`src/app/layout.tsx`) を `async` 化し、`<html data-theme={theme}>` を
  サーバ側で出力 → フラッシュなし

#### 28.2.3 CSS 変数切り替え

`src/app/globals.css` に `[data-theme="..."]` セレクタで 9 テーマ分の CSS 変数を上書き定義。
既存の shadcn トークン (`--background` / `--primary` / `--accent` ...) を使うコンポーネントには
追加改修は不要で、html の `data-theme` 値の変更だけで全画面に反映される。

色相 (oklch の hue 値) は blue=240 / green=150 / yellow=90 / red=20 の 4 軸で統一し、
パステルは低彩度 (`chroma` 0.02〜0.04)、ポップは高彩度 (0.06〜0.2) を採用。

#### 28.2.4 クライアントからのテーマ変更フロー

設定画面 (`settings-client.tsx`) のラジオボタン型 UI で:

1. `PATCH /api/settings/theme` → DB 更新
2. `useSession().update({ themePreference })` → JWT の `token.themePreference` を更新 (再ログイン不要)
3. `router.refresh()` → Root layout が新しい `data-theme` で再レンダリングされ全画面に反映

React の immutability 方針に従い、`document.documentElement.dataset.theme` を直接
書き換える処理は行わない (ESLint `react-hooks/immutability` に抵触するため)。

---

## 29. PR #73: テーマ定義ファイルの一元化 + 生成パターン

### 29.1 背景

PR #72 では全テーマの CSS 変数を `globals.css` に直接定義していた。しかし:

- 新規テーマ追加時に CSS 変数を漏らしても、実行時エラーにならず「色が一部だけ違う」
  見た目バグとなって検出が遅れる
- トークン追加 (例: `--warning`) 時に全テーマ × 全トークンを CSS 側で手動更新する必要があり、
  保守コストと追加漏れリスクが累積する
- CSS ファイルと TS の `THEMES` カタログが独立して管理されており、同期が取れているかは
  目視頼みだった

### 29.2 対応方針

テーマのカラー定義を TypeScript 側 (`src/lib/themes/definitions.ts`) に集約し、
HTML 組立時に CSS を生成して head に inline 注入する「定義 → 生成」パターンに切り替える。

### 29.3 アーキテクチャ

```
src/lib/themes/
  definitions.ts     # ThemeTokens 型 + THEME_DEFINITIONS (10 テーマ × 31 トークン)
  generate-css.ts    # definitions → CSS 文字列の純粋関数
  index.ts           # 公開 API (generateThemeCss / THEME_DEFINITIONS / ThemeTokens)
  definitions.test.ts
  generate-css.test.ts
```

**型安全性による網羅保証**:
```ts
export const THEME_DEFINITIONS = {
  light: LIGHT,
  dark: extend({ ... }),
  // ...
} as const satisfies Record<ThemeId, ThemeTokens>;
```

- `ThemeId` に新テーマを追加 → `Record<ThemeId, ThemeTokens>` 制約で定義漏れがビルドエラー
- `ThemeTokens` にトークンを追加 → 全テーマで値未設定がビルドエラー
- `satisfies` により厳密な型 (`light`, `dark`, ...) を保ったまま制約チェック

**差分上書きパターン (`extend`)**:
LIGHT をベースに、各テーマで「変更したいトークンだけ」を差分指定する。
31 トークン × 10 テーマ = 310 行の総当たりを避け、テーマごとのデザイン意図が読みやすい。

### 29.4 CSS 注入

`src/app/layout.tsx` の先頭で `generateThemeCss()` を一度呼び出して文字列をキャッシュし、
`<head><style id="tasukiba-themes">{THEME_CSS}</style></head>` で描画する。

- **SSR に内包**: 初回 HTML に含まれるため FOUC なし
- **安全性**: CSS 値 (`oklch(...)`) は静的な色トークンのみでユーザ入力を含まないが、念のため
  React の `<style>` 子要素として文字列を渡すパターンを採用 (`<style>{string}</style>`)。
  HTML 危険文字 (`<`, `>`, `&`) が混入していないことは `generate-css.test.ts` で検査
- **パフォーマンス**: 文字列はモジュールロード時に 1 回生成してキャッシュ。
  リクエストごとの再生成は発生しない

### 29.5 保守の流れ

**新しいテーマを追加する場合**:
1. `src/types/index.ts` の `THEMES` に ID と表示名を追加
2. `src/lib/themes/definitions.ts` の `THEME_DEFINITIONS` にも同じ ID を追加
   → `satisfies` で型検査が通るまで必要トークンを埋める
3. テスト (`definitions.test.ts`) が自動で検証
   - THEMES と THEME_DEFINITIONS の ID 一致
   - 全トークンが非空で存在
   - 余計なキーが混入していない

**新しいトークンを追加する場合**:
1. `ThemeTokens` 型に key を追加 → 全 10 テーマで値を要求される (型エラー)
2. shadcn utility として使いたい場合は `globals.css` の `@theme inline` に
   `--color-X: var(--X);` を追記
3. テスト (`generate-css.test.ts`) の `REQUIRED_TOKENS` 配列にキーを追加

**色を変更する場合**:
`globals.css` ではなく `src/lib/themes/definitions.ts` を編集する
(コメントで誘導済み)。

### 29.6 移行によって削除されたもの

- `globals.css` の `:root` 内の色変数群 (約 25 行)
- `globals.css` の `.dark` / `[data-theme="..."]` 9 ブロック (約 140 行)
- 合計 165 行の CSS を約 150 行の型安全な TS に置換 (+自動網羅テスト 11 ケース)

---

## 30. PR #77: i18n 基盤導入 (next-intl) と UI ラベル外出し Phase A

### 30.1 背景

ゼロハードコーディング原則 (§21.4) の最後に残った大きな塊が **JSX 内の日本語 UI ラベル** だった。
特に「同じ機能のボタンが画面ごとに違うラベル名で書かれる」表記ゆれ問題が、横展開漏れの最大の温床だった (例: 「保存」「保存する」「登録」が画面ごとに混在する潜在リスク)。

PR #75 で確立した「定義ファイル → 参照」パターンを UI ラベルにも適用し、加えて将来の多言語化に備えるため、**業界標準の i18n ライブラリ (`next-intl`) を導入** する。

### 30.2 採用ライブラリ: next-intl

| 比較軸 | 採否 / 理由 |
|---|---|
| Next.js App Router 公式推奨 | ✅ Vercel チームが next-intl を案内 |
| TypeScript 型統合 | ✅ メッセージ JSON から型を生成し、未定義キー使用をビルドエラー化可能 |
| Server / Client 両対応 | ✅ `getTranslations()` (RSC) / `useTranslations()` (Client) |
| バンドルサイズ | ⚪ 中程度。単一ロケール運用なら影響軽微 |
| react-i18next との比較 | ⚪ 機能はほぼ同等だが、Next.js App Router 統合は next-intl が手厚い |

### 30.3 ディレクトリ構成

```
src/i18n/
  request.ts            # next-intl のサーバ設定 (locale + messages 解決)
  messages/
    ja.json             # 全 UI ラベルのキー → 日本語文言 (現状唯一のロケール)
  messages.test.ts      # キー集合の整合性テスト
```

`messages/ja.json` の構造 (3 階層: 概念別グルーピング):

```json
{
  "action": { "save": "保存", "cancel": "キャンセル", "delete": "削除", ... },
  "field":   { "title": "件名", "content": "内容", ... },          // Phase B 以降
  "message": { "saveSuccess": "保存しました", ... }                 // Phase C 以降
}
```

### 30.4 利用パターン

**サーバコンポーネント** (RSC):
```tsx
import { getTranslations } from 'next-intl/server';
const t = await getTranslations('action');
return <h1>{t('save')}</h1>;
```

**クライアントコンポーネント**:
```tsx
'use client';
import { useTranslations } from 'next-intl';
const t = useTranslations('action');
return <Button>{t('save')}</Button>;
```

### 30.5 同機能 = 同ラベルの保証メカニズム

ご懸念事項「画面ごとに同じ機能のボタンが違う表記になる」を以下の 3 重で防止:

1. **キー一意性**: `t('action.save')` を呼ぶ全画面が `messages/ja.json` の同じ値を参照 → 文言を変えるなら 1 行修正のみで全画面同時更新
2. **テスト網羅**: `messages.test.ts` の `REQUIRED_ACTION_KEYS` でキー追加漏れ・余計なキー混入を検出
3. **検索性**: 「保存ボタンの全使用箇所をリストアップしたい」が `grep "action.save"` 一発

### 30.6 段階移行プラン

| Phase | 範囲 | 進捗 |
|---|---|---|
| **A** | 基盤導入 + アクション動詞 9 語 (save / cancel / delete / edit / create / back / close / today / clear) を 10 ファイルで使用箇所置換 | ✅ PR #77 で完了 |
| B | 共通フォームラベル (件名 / 内容 / 担当者 等) を `field.*` で抽出 | 未着手 |
| C | 共通エラー / 成功メッセージを `message.*` で抽出 | 未着手 |
| D | 残り (画面固有文言) を改修機会のたびに段階移行 | 未着手 |

Phase B〜D は将来の修正機会で増やしていけば良く、必須ではない。

### 30.7 §21.4 原則との整合

`§21.4.4 スコープ外` で「画面ラベル・メッセージ文言は JSX 内リテラルを許容」としていたが、PR #77 で**この方針を更新**:

- **共通アクション動詞 (Phase A)** は外出し必須 (横展開漏れ防止のため)
- **共通フォームラベル (Phase B)** は外出し推奨 (使用機会あれば抽出)
- **画面固有の本文・見出し (Phase D)** は当面 JSX リテラル許容 (i18n 真の必要時に一括抽出)

§21.4.6 の遵守状況表も「共通アクション動詞」を ✅ 準拠として記録する。

---

## 31. PR #78: ネイティブ `<select>` のドロップダウンコントラスト修正

### 31.1 問題

ダークテーマでネイティブ `<select>` を開いた際、ドロップダウンパネル内の `<option>` 一覧が **黒系背景に黒系文字** で表示され、選択肢が読みづらかった。

原因:
- ブラウザネイティブのフォームコントロール (`<select>` の OS 描画ドロップダウン等) は CSS の `color-scheme` プロパティを参照して描画モードを決める
- 本プロダクトはこれを宣言していなかったため、Chrome / Edge は常に "light モード既定" でドロップダウンを描画していた
- そこに theme-aware な `bg-card` 等で着色されたコンテナが重なり、コントラスト不一致が発生

### 31.2 解決方針

PR #75 / #76 で確立した「テーマ定義の唯一の真実 = `theme-definitions.ts`」パターンを、`color-scheme` プロパティにも拡張する。

**追加した定義**:

```ts
// src/config/theme-definitions.ts
export const THEME_COLOR_SCHEMES = {
  light:           'light',
  dark:            'dark',
  'pastel-blue':   'light',
  'pastel-green':  'light',
  'pastel-yellow': 'light',
  'pastel-red':    'light',
  'pop-blue':      'light',
  'pop-green':     'light',
  'pop-yellow':    'light',
  'pop-red':       'light',
} as const satisfies Record<ThemeId, 'light' | 'dark'>;
```

`generate-css.ts` を拡張し、各テーマブロックに `color-scheme: <value>;` を追記:

```css
[data-theme="dark"] {
  color-scheme: dark;
  --background: oklch(0.145 0 0);
  ...
}
```

### 31.3 二重防御: `<option>` 直接スタイル

`color-scheme` の挙動はブラウザ間で差がある (Firefox / Safari は限定対応)。保険として `nativeSelectClass` にも明示スタイルを追加:

```ts
'... [&>option]:bg-popover [&>option]:text-popover-foreground'
```

これにより `<option>` の背景は `var(--popover)`、文字色は `var(--popover-foreground)` になる。各テーマの popover トークン値に追従するため、light / dark / pastel / pop いずれでもコントラストが確保される。

### 31.4 横展開保証

新しいテーマを追加するときの必須作業 (3 箇所):

1. `src/config/themes.ts` の `THEMES` に ID と表示名
2. `src/config/theme-definitions.ts` の `THEME_DEFINITIONS` に色トークン値
3. `src/config/theme-definitions.ts` の **`THEME_COLOR_SCHEMES`** に `'light'` か `'dark'` (本 PR で追加)

それぞれ `satisfies Record<ThemeId, ...>` 制約により**追加漏れがビルドエラー**になる。
さらに `theme-definitions.test.ts` の 3 つのテストケースが「全 ID に値があるか」「light / dark のいずれかか」「dark 以外は全て light か」を実行時にも検証する。

---

## 32. PR #79: 人間可読性改善 — サービス層 + API ルート docblock 整備 (Phase 1)

### 32.1 背景

将来 AI を使わない開発者が引き継いだ場合に「コードを読んでも何が何だか分からない」状態を
避けるため、ゼロハードコーディング原則 (§21.4) に加えて **コード可読性の最低基準** を定める。

直近 (PR #70 以降) の実装は丁寧な docblock を持つが、初期実装 (PR #25 以前) のサービス
ファイルや API ルートは「import → 関数本体」のみで、認可要件・監査記録・関連設計書
セクションの記述が無かった。

### 32.2 Phase 1 で実施した整備

#### 32.2.1 サービス層 (8 ファイル + 既存 10 = 18 全ファイル準拠)

各サービスのトップに以下を必ず含む docblock を追加:

- **役割**: そのサービスが業務上担う責任 (1 段落)
- **設計判断**: 論理削除 vs 物理削除、トランザクション境界、状態整合等の意思決定理由
- **認可**: 呼び出し元 API ルートで実施済みの前提の認可チェック
- **関連ドキュメント**: DESIGN.md / SPECIFICATION.md の該当セクション

対象: `estimate / knowledge / member / project / retrospective / risk / task / user`
(既に docblock があった `attachment / audit / auth-event / email-verification / memo /
mfa / password / password-reset / state-machine / suggestion` は既存内容を維持)

#### 32.2.2 API ルート (30 ファイル + 既存 26 = 56 全ファイル準拠)

各エンドポイントのトップに以下を含む docblock を追加:

- **HTTP メソッド + パス + 役割**
- **認可**: `requireAdmin` / `checkProjectPermission('action:resource')` / 未認証可 等
- **監査**: audit_logs / auth_event_logs / role_change_logs への記録有無
- **関連**: DESIGN.md セクション / 関連 PR

### 32.3 効果

- **将来の人間引き継ぎ**: 初見の開発者がファイルを開いた時点で「何のために存在するか」「どんな
  権限が必要か」「ログに何が残るか」が即座に分かる。git blame で意図を遡る必要が減る
- **設計書との対応付け**: 各ファイルに DESIGN.md の参照先が明記され、コード ↔ 設計書の往復が容易
- **横展開漏れ検出**: 新規 API ルート追加時に既存ルートと同じ docblock パターンが残っているかを
  レビューで確認できる

### 32.4 機能影響

ゼロ。コメント追加のみ、ロジック・テスト挙動・bundle に変化なし。
全 386 テスト pass / lint clean / build 成功で確認済。

### 32.5 残タスク (将来 PR)

- **Phase 2**: サービス層の大規模関数 (特に `task.service.ts` 1274 行) への inline コメント追加
- **Phase 3**: クライアントページ (`src/app/(dashboard)/**/*-client.tsx`) の docblock + 複雑な
  useState/useEffect への補足コメント

これらは「修正機会のあるたびに段階移行」とし、本 PR では着手しない (大量 diff のリスク回避)。

### 32.6 PR #80: Phase 2 + Phase 3 実施 (2026-04-21 追加)

#### Phase 2 実施内容

`task.service.ts` (1274 行、最複雑) の主要関数 5 つに JSDoc 形式の関数ヘッダ + inline コメントを追加:

- **`buildTree`**: WBS 階層ツリー構築の純粋関数 (Map ベース 2 パス)
- **`createTask`**: WP/ACT 区別と親 WP 集計再計算の副作用を明記
- **`updateTask`**: PR #69 の双方向整合ルール (進捗 100% ⇔ ステータス完了) の優先順位を明記
- **`deleteTask`**: 論理削除の理由 + 子ノードの孤児扱いを明記
- **`updateTaskProgress`**: 進捗ログ + タスク本体最新値の同時更新と整合性ルール

`project.service.ts`:
- **`changeProjectStatus`**: state-machine.ts への委譲設計、エラーコード仕様を明記

WP 集約関数 (`aggregateWpFromChildren` / `recalculateAncestors`) は既存コメントが十分詳細だったため変更なし。

#### Phase 3 実施内容

`src/app/(dashboard)/**/*-client.tsx` および `*-table.tsx` 計 15 ファイルにトップレベル docblock を追加:

- **役割**: その画面が業務上担う責任 (1 段落)
- **重要設計**: lazy fetch / メモ化 / 整合性ルール 等の設計判断
- **公開範囲制御 / 認可**: 表示対象データの絞り込みと操作権限
- **API**: 呼び出すエンドポイント
- **関連**: SPECIFICATION.md / DESIGN.md セクション

主な対象:
`tasks-client` (本プロダクト最複雑) / `project-detail-client` / `gantt-client` /
`risks-client` / `retrospectives-client` / `estimates-client` / `members-client` /
`project-knowledge-client` / `settings-client` / `users-client` / `knowledge-client` /
`my-tasks-client` / `projects-client` / `all-risks-table` / `all-retrospectives-table`

#### 効果

- **将来の人間引き継ぎ**: 各クライアントページが「何の画面か」「どんな設計判断があるか」を
  ファイル先頭で読める。git blame で意図を遡る必要が減る
- **task.service.ts**: 1274 行の中で「複雑な業務ロジック (WP 集計 / 状態整合性 / 親子伝播)」を
  持つ関数が一目で識別可能に

#### 機能影響

ゼロ。コメント追加のみで全 386 テスト pass / lint clean / build 成功。
