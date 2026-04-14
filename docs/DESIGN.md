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
| フロントエンド | Next.js (App Router) | 15.x | SSR/SSG、API Routes 統合、React エコシステム |
| UI ライブラリ | React | 19.x | コンポーネント指向、エコシステムの豊富さ |
| UI コンポーネント | shadcn/ui + Tailwind CSS | - | カスタマイズ性、軽量、アクセシビリティ |
| ガントチャート | @neodrag/gantt または自前実装 | - | MVP では読み取り専用のため軽量ライブラリで十分 |
| 状態管理 | TanStack Query (React Query) | 5.x | サーバ状態管理、キャッシュ、楽観的更新 |
| フォーム | React Hook Form + Zod | - | バリデーション共有（フロント/バック） |
| ORM | Prisma | 6.x | 型安全なクエリ、マイグレーション管理 |
| データベース | PostgreSQL | 16.x | JSONB 対応、全文検索、信頼性 |
| 認証 | NextAuth.js (Auth.js) | 5.x | Credentials + OAuth 対応、セッション管理 |
| テスト | Vitest + Playwright | - | 単体テスト + E2E テスト |
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
│   │   │       ├── tasks/        # WBS/タスク管理
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
        varchar customer_name
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
        varchar wbs_number
        varchar name
        text description
        enum category "requirements | design | development | testing | review | management | other"
        uuid assignee_id FK
        date planned_start_date
        date planned_end_date
        decimal planned_effort
        enum priority "low | medium | high"
        enum status "not_started | in_progress | completed | on_hold"
        integer progress_rate "0-100"
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
| customer_name | VARCHAR(100) | NO | - | 顧客名 |
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
- `idx_projects_customer` (customer_name, WHERE deleted_at IS NULL)

### 5.3 project_members（プロジェクトメンバー）

| カラム名 | 型 | NULL | デフォルト | 説明 |
|---|---|---|---|---|
| id | UUID | NO | gen_random_uuid() | 主キー |
| project_id | UUID | NO | - | FK: projects.id |
| user_id | UUID | NO | - | FK: users.id |
| project_role | VARCHAR(20) | NO | - | pm_tl / member / viewer |
| assigned_by | UUID | NO | - | 設定者（FK: users.id） |
| created_at | TIMESTAMPTZ | NO | now() | 作成日時 |
| updated_at | TIMESTAMPTZ | NO | now() | 更新日時 |

**制約**: UNIQUE(project_id, user_id)

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
        条件③: WBS/タスク作成済み
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

#### プロジェクト

| メソッド | パス | 説明 | ロール |
|---|---|---|---|
| GET | /api/projects | 一覧取得 | 全ロール |
| POST | /api/projects | 新規作成 | admin, pm_tl |
| GET | /api/projects/:id | 詳細取得 | プロジェクト参加者 |
| PATCH | /api/projects/:id | 更新 | admin, pm_tl |
| DELETE | /api/projects/:id | 論理削除 | admin, pm_tl |
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

#### ナレッジ

| メソッド | パス | 説明 | ロール |
|---|---|---|---|
| GET | /api/knowledge | 横断検索 | 全ロール（公開範囲制御あり） |
| POST | /api/knowledge | 新規作成 | admin, pm_tl, member |
| GET | /api/knowledge/:id | 詳細取得 | 公開範囲に応じる |
| PATCH | /api/knowledge/:id | 更新 | admin, pm_tl, 作成者 member |
| DELETE | /api/knowledge/:id | 論理削除 | admin, pm_tl |
| PATCH | /api/knowledge/:id/publish | 公開 | admin, pm_tl |

#### 振り返り

| メソッド | パス | 説明 | ロール |
|---|---|---|---|
| GET | /api/projects/:id/retrospectives | 一覧取得 | 全ロール |
| POST | /api/projects/:id/retrospectives | 新規作成 | admin, pm_tl |
| GET | /api/projects/:id/retrospectives/:retroId | 詳細取得 | 全ロール |
| PATCH | /api/projects/:id/retrospectives/:retroId | 更新 | admin, pm_tl |
| PATCH | /api/projects/:id/retrospectives/:retroId/confirm | 確定 | admin, pm_tl |
| POST | /api/projects/:id/retrospectives/:retroId/comments | コメント投稿 | admin, pm_tl, member |

#### システム管理

| メソッド | パス | 説明 | ロール |
|---|---|---|---|
| GET | /api/admin/users | ユーザ一覧 | admin |
| POST | /api/admin/users | ユーザ登録 | admin |
| PATCH | /api/admin/users/:userId | ユーザ更新 | admin |
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

### 8.3 権限マトリクス（実装用サマリ）

| 操作カテゴリ | admin | pm_tl | member | viewer |
|---|---|---|---|---|
| プロジェクト CRUD | 全操作 | 作成・編集 | 閲覧のみ | 閲覧のみ |
| メンバー管理 | 全操作 | 一覧閲覧のみ | 不可 | 不可 |
| 見積もり | 全操作 | 全操作 | 不可 | 不可 |
| タスク管理 | 全操作 | 全操作 | 自分タスクの進捗更新のみ | 閲覧のみ |
| リスク・課題 | 全操作 | 全操作 | 起票 + 自分担当分の編集 | 閲覧のみ |
| ナレッジ | 全操作 | 全操作 | 下書き作成 + 自分下書き編集 | 閲覧のみ |
| 振り返り | 全操作 | 作成・編集・確定 | コメント投稿のみ | 閲覧のみ |
| システム管理 | 全操作 | 不可 | 不可 | 不可 |

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

| 項目 | 値 |
|---|---|
| ロック条件 | 10 分以内に 5 回のログイン失敗 |
| ロック期間 | 30 分間の一時ロック |
| 恒久ロック | 一時ロック 3 回で管理者解除が必要な恒久ロック |
| ロック解除 | システム管理者が手動解除 |
| 通知 | ロック発生時に対象ユーザのメールアドレスに通知（将来実装） |

データモデル追加（users テーブル）:
- `failed_login_count` INTEGER DEFAULT 0
- `locked_until` TIMESTAMPTZ NULL
- `permanent_lock` BOOLEAN DEFAULT false

#### 9.4.4 セッション管理

| 項目 | 値 | 理由 |
|---|---|---|
| 保存先 | DB（sessions テーブル） | サーバサイドで無効化可能 |
| 最大有効期限 | 24 時間 | 長期放置リスクの低減 |
| アイドルタイムアウト | 2 時間 | 離席時の不正アクセス防止 |
| セッションローテーション | 認証成功時に再生成 | セッション固定攻撃の防止 |
| 同時セッション | 最大 3 デバイス | 共有アカウントの検出 |
| Cookie 属性 | HttpOnly, Secure, SameSite=Lax, Path=/ | 盗聴・XSS・CSRF の緩和 |
| 権限変更時の無効化 | ロール変更・無効化時に全セッションを即時無効化 | 権限昇格の即時反映 |

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

MVP では in-memory でのレート制限を実装し、本番環境では Redis ベースに切り替える。
Upstash Ratelimit ライブラリ等の sliding window 方式を採用する。

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
| 物理削除 | 論理削除から 1 年経過後にバッチ処理で物理削除（将来実装） |
| 監査ログ | 物理削除対象外。法令要件に応じた保持期間を設定 |
| 認証イベントログ | 物理削除対象外。最低 2 年保持 |

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
ユーザ
  |
  v
[1] 登録フォーム送信（名前・メール・パスワード）
  |
  v
[2] サーバ処理
  - パスワードポリシー検証
  - メールアドレスの重複チェック
  - パスワードを bcrypt ハッシュ化
  - リカバリーコード（10個）を生成し、ハッシュ化して DB 保存
  - ユーザレコードを作成（is_active = false, deleted_at = now()）
    ※ 有効化前は論理削除状態として扱う
  - メール検証トークンを生成（暗号論的乱数 32バイト）
  - トークンのハッシュを DB 保存（有効期限: 24時間）
  - 検証用URLを含むメールを送信
  |
  v
[3] ユーザに画面表示
  - リカバリーコード（平文）を1回限り表示
  - 「このコードを安全な場所に保管してください」と案内
  - メール送信完了の案内
  |
  v
[4] ユーザがメール内リンクをクリック
  |
  v
[5] サーバ処理（有効化）
  - トークンの有効期限チェック
  - トークンのハッシュ照合
  - ユーザの is_active = true, deleted_at = NULL に更新
  - トークンを使用済みに更新
  - 認証イベントログに記録
  |
  v
[6] ログイン画面へリダイレクト
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

#### 9.18.4 フォレンジック対応の原則

| 原則 | 実装方針 |
|---|---|
| ログの不変性 | operation_trace_logs / audit_logs は INSERT のみ。UPDATE / DELETE を DB 権限で禁止 |
| ログの外部保存 | ログのコピーを外部ログサービスにリアルタイム転送（DB 侵害時の証拠保全） |
| ログの保持期間 | 最低 2 年間保持。法令要件に応じて延長 |
| ログのアクセス制限 | システム管理者のみが監査ログ画面から参照可能 |
| ログ参照の記録 | 管理者が監査ログを参照した事実も記録（監視の監視） |
| タイムスタンプ | UTC で記録。NTP 同期を前提とする |

#### 9.18.5 実装方針

```typescript
// middleware.ts - 全リクエストの操作ログ記録
// Route Handler の前後で自動的にログを記録する Middleware

async function operationTraceMiddleware(request: NextRequest) {
  const requestId = crypto.randomUUID();
  const startTime = Date.now();

  // レスポンス後にログを非同期で記録
  // パフォーマンスへの影響を最小化するため、ログ書き込みはレスポンス返却後に実行
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

### 10.2 本番環境構成図（想定）

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Cloud Environment                            │
│                                                                     │
│  ┌──────────┐     ┌────────────────────────────┐                   │
│  │  CDN      │     │  Application Server         │                   │
│  │ (静的     │     │                              │                   │
│  │  アセット) │     │  ┌────────────────────────┐ │                   │
│  └─────┬────┘     │  │  Next.js (Standalone)   │ │                   │
│        │          │  │  Node.js 22             │ │                   │
│  ┌─────┴────┐     │  │  Port: 3000             │ │                   │
│  │ Browser  │────▶│  └────────────┬───────────┘ │                   │
│  │ (HTTPS)  │     │               │              │                   │
│  └──────────┘     └───────────────┼──────────────┘                   │
│                                   │ TCP/5432                         │
│                   ┌───────────────┼──────────────┐                   │
│                   │  Database      │              │                   │
│                   │               ▼              │                   │
│                   │  ┌────────────────────────┐ │                   │
│                   │  │  PostgreSQL 16          │ │                   │
│                   │  │  - 自動バックアップ      │ │                   │
│                   │  │  - ポイントインタイム     │ │                   │
│                   │  │    リカバリ              │ │                   │
│                   │  └────────────────────────┘ │                   │
│                   └─────────────────────────────┘                   │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  CI/CD: GitHub Actions                                         │ │
│  │  - Lint / Type Check / Test → Build → Deploy                  │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### 10.3 デプロイ候補

| 選択肢 | App | DB | 特徴 |
|---|---|---|---|
| **Vercel + Supabase** | Vercel (Hobby/Pro) | Supabase PostgreSQL | Next.js 最適化、無料枠あり |
| **Railway** | Railway | Railway PostgreSQL | シンプル、Docker 対応 |
| **AWS (ECS + RDS)** | ECS Fargate | RDS PostgreSQL | 本格運用向け、コスト高 |
| **Azure (App Service + Flexible Server)** | App Service | Azure Database for PostgreSQL | エンタープライズ向け |

MVP では **Vercel + Supabase** または **Railway** を推奨。本格運用移行時に AWS / Azure へ切り替え可能な構成とする。

### 10.4 環境変数一覧

| 変数名 | 説明 | 例 |
|---|---|---|
| DATABASE_URL | PostgreSQL 接続文字列 | postgresql://user:pass@localhost:5432/bmp |
| NEXTAUTH_URL | アプリケーション URL | http://localhost:3000 |
| NEXTAUTH_SECRET | NextAuth 暗号化キー | ランダム文字列（32文字以上） |
| NODE_ENV | 実行環境 | development / production |

---

## 11. 画面遷移設計

### 11.1 画面遷移図

```mermaid
flowchart TD
    LOGIN[ログイン画面] --> PJ_LIST[プロジェクト一覧]

    PJ_LIST --> PJ_NEW[プロジェクト新規作成]
    PJ_LIST --> PJ_DETAIL[プロジェクト詳細]

    PJ_DETAIL --> TAB_EST[見積もり管理]
    PJ_DETAIL --> TAB_TASK[WBS/タスク管理]
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
| WBS/タスク | /projects/:id/tasks | 常時表示 |
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

## 13. 今後の詳細化対象

本設計書は MVP 初版であり、次段階で以下を追加・詳細化する。

- Prisma Schema 定義ファイルの実装
- Zod バリデーションスキーマの詳細定義
- 通知機能の設計（MVP 対象外だが基盤は検討）
- パフォーマンス要件（応答時間目標、同時接続数）
- バックアップ・リストア手順
- 監視・アラート設計
- ログ運用設計（アプリケーションログのフォーマット・保存期間）

---

## 14. 備考

本設計書は、要件定義書（REQUIREMENTS.md）および仕様書（SPECIFICATION.md）に基づく、たすきば Knowledge Relay MVP の技術設計ドラフトである。
実装開始後、技術的な制約や運用要件に応じて改訂する。
