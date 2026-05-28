# アーキテクチャ概要 (Program Design)

本ドキュメントは、本サービスの技術スタックと全体アーキテクチャを集約する (DESIGN.md §1〜§3)。データモデルは [DATA_MODEL.md](./DATA_MODEL.md)、API 設計は [API_DESIGN.md](./API_DESIGN.md) を参照。

---

﻿# たすきば Knowledge Relay MVP 設計書

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
| ガントチャート | @neodrag/gantt または自前実装 ※**未導入 (採用予定)** | - | MVP では読み取り専用のため軽量ライブラリで十分 |
| 状態管理 | TanStack Query (React Query) ※**未導入 (採用予定)** | 5.x | サーバ状態管理、キャッシュ、楽観的更新。現状は Server Components + Server Actions のみ |
| フォーム | React Hook Form + Zod ※**React Hook Form 未導入 (採用予定)** | - | バリデーション共有（フロント/バック）。現状は Zod のみ採用済 |
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

## 4. リポジトリの主要ディレクトリ構造

コードベースを最初に歩く際の俯瞰図。ファイル種別ごとに役割が明確に分離されている。

| パス | 役割 |
|---|---|
| `src/app/(auth)/` | ログイン / パスワード設定 / MFA 画面(認証フロー) |
| `src/app/(dashboard)/` | ログイン後の全画面(projects / tasks / gantt / estimates / risks / retrospectives / knowledge / memos / settings / admin) |
| `src/app/api/` | REST API ルート(Next.js Route Handlers) |
| `src/services/` | **ビジネスロジック**(DB 操作・認可・業務ルールはここに集約。テナント越境防止 + 二段階認可の中核、[ADR-0005](../adr/0005-rbac-two-stage-tenant-authorization.md)) |
| `src/lib/` | 汎用ヘルパー(auth / db / permissions / validators) |
| `src/components/` | 共通 UI コンポーネント(shadcn/ui ベース) |
| `src/config/` | **業務的意味を持つ定数の集約場所**(マスタデータ / セキュリティ / validation / テーマ / ルーティング — ゼロハードコーディング原則の実装基盤) |
| `prisma/` | DB schema(`schema.prisma`)+ migration 履歴(`migrations/`) |
| `e2e/` | E2E テスト(Playwright spec + fixtures) |
| `scripts/` | 補助スクリプト(CI / 開発 / 運用)— 役割別索引は [scripts/README.md](../../scripts/README.md) |
| `.github/workflows/` | CI/CD ワークフロー(ci / e2e / security / dependency-review / docs-link-check / e2e-visual-baseline) |
| `docs/` | プロジェクトドキュメント(役割別分割、入口は [docs/README.md](../README.md)) |

### Service 層が中核な理由

本サービスの認可ロジック(テナント越境防止)は **`src/services/` の各関数の引数 `viewerTenantId` の必須化と `where.tenantId` フィルタの強制** で実現されている。
新規 Service 関数を追加する際は [ADR-0005](../adr/0005-rbac-two-stage-tenant-authorization.md) と [CONTRIBUTING.md §5.2](../../CONTRIBUTING.md) を必ず確認すること。

### `src/config/` への定数集約

業務的意味を持つ値(色 / 文字数上限 / パス / 認証定数等)は `src/config/` 配下に集約する。例:

| ファイル | 集約対象 |
|---|---|
| `src/config/master-data.ts` | プロジェクト状態 / リスク種別 / 重要度 enum 等 |
| `src/config/security.ts` | bcrypt cost / ログイン失敗ロック回数 / セッション有効期限 |
| `src/config/validation.ts` | 文字数上限 / 入力長制約 |
| `src/config/app-routes.ts` | 画面遷移パス |
| `src/config/theme-definitions.ts` | テーマ色定義 |

詳細: [docs/developer-guide/REFERENCE.md](../developer-guide/REFERENCE.md)(設計原則のリマインダ)

---

## ADR-0025: Beginner プラン write ガード層 (2026-05-29 追加)

[src/services/storage-guard.service.ts](../../src/services/storage-guard.service.ts) の 4 関数 (`precheckStorageLimit` / `assertStorageLimitInTx` / `precheckFileStorageLimit` / `assertFileStorageLimitInTx`) に Beginner プラン専用判定を統合:

- `plan === 'beginner' && cached usage > BEGINNER_DB_FREE_TIER_BYTES (50MB)` で `BeginnerWriteGuardExceededError` を throw
- DELETE は storage-guard を通らないため自動許可、`addedBytes < 0` (= ファイル削除) もガード対象外
- 既存の 50GB ハードキャップ判定より前段で評価し、Beginner は早期 short-circuit

DELETE 後の自動再集計 (`maybeRecalcAfterBeginnerDelete()`) は post-commit hook として 6 主要 service (knowledge / project / risk / retrospective / memo / attachment) の DELETE 関数末尾で呼出。debounce 30 秒、fail-safe (re-calc 失敗は DELETE 本体を巻き戻さない)。

詳細: [ADR-0025](../adr/0025-beginner-write-guard.md) / [仕様書 BEGINNER_PLAN.md](../specification/BEGINNER_PLAN.md)

---

