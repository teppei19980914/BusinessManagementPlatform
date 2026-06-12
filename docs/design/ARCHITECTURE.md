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
| 国際化 (i18n) | next-intl | - | App Router 対応のメッセージカタログ。サーバ側 `getRequestConfig` でロケール解決 (§3.4) |
| MFA | otplib | 13.x | TOTP（RFC 6238）対応 |
| QR コード | qrcode | 1.x | MFA 設定用 QR コード生成 |
| テスト | Vitest | 4.x | 単体テスト（数千件規模、`src/**/*.test.ts`。具体数は CI で変動するため固定値は記さない） |
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
│  │  │ Handlers  │  │(Auth+Guard│  │                  │ │   │
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

以下は 2026-05-31 時点の実構成 (Glob で実在確認)。網羅ではなく主要セグメントの俯瞰。

```
src/
├── app/                          # Next.js App Router
│   ├── (auth)/                   # 認証関連ページ (login / mfa / setup-password / reset-password 等)
│   ├── (dashboard)/              # 認証済みレイアウト (layout.tsx で認証ガード)
│   │   ├── page.tsx              # ダッシュボード (ホーム)
│   │   ├── projects/
│   │   │   ├── page.tsx          # プロジェクト一覧
│   │   │   └── [projectId]/
│   │   │       ├── page.tsx      # プロジェクト詳細
│   │   │       ├── estimates/    # 見積もり管理
│   │   │       ├── tasks/        # WBS 管理
│   │   │       ├── gantt/        # ガントチャート
│   │   │       ├── risks/        # リスク管理
│   │   │       ├── issues/       # 課題管理
│   │   │       ├── knowledge/    # ナレッジ管理
│   │   │       ├── retrospectives/ # 振り返り
│   │   │       └── stakeholders/ # ステークホルダー管理
│   │   ├── my-tasks/             # マイタスク
│   │   ├── customers/            # 顧客管理 (+ [customerId])
│   │   ├── risks/                # リスク横断
│   │   ├── issues/               # 課題横断
│   │   ├── knowledge/            # ナレッジ横断
│   │   ├── retrospectives/       # 振り返り横断
│   │   ├── memos/                # メモ (個人資産)
│   │   ├── all-memos/            # 全メモ (public 閲覧)
│   │   ├── guide/                # 操作ガイド
│   │   ├── help/                 # AI ヘルプチャット (たすきフクロウ)
│   │   ├── settings/             # 個人/テナント設定 (about / tenant / tenant/billing / tenant/external-import)
│   │   └── admin/                # 管理
│   │       ├── users/            # ユーザ管理
│   │       ├── audit-logs/       # 監査ログ
│   │       ├── role-changes/     # 権限変更履歴
│   │       └── super/            # super_admin 専用 (Basic Auth ガード)
│   │           ├── tenants/      # テナント管理 (+ [id] / diagnostics / new)
│   │           ├── billing/      # 売上集計 (+ [yearMonth])
│   │           ├── stripe-dlq/   # Stripe DLQ
│   │           ├── email-failures/ # メール送信失敗
│   │           ├── cron-history/ # cron 実行履歴
│   │           ├── usage/        # 利用量サマリ
│   │           └── diagnostics/  # 診断
│   ├── api/                      # API Route Handlers
│   │   ├── auth/                 # 認証 (signin/mfa/setup-password/reset-password/verify-email/
│   │   │                         #   explicit-signout/delete-account/change-password/recovery-codes 等)
│   │   ├── projects/             # プロジェクト + 配下 (tasks/tree・workload, estimates, risks, knowledge,
│   │   │                         #   retrospectives, stakeholders, members, suggestions, gantt, status 等)
│   │   ├── customers/            # 顧客
│   │   ├── risks/                # リスク横断 (GET/詳細/DELETE)
│   │   ├── retrospectives/       # 振り返り横断
│   │   ├── knowledge/            # ナレッジ横断
│   │   ├── memos/                # メモ (+ bulk)
│   │   ├── my-tasks/             # マイタスク
│   │   ├── comments/             # コメント (polymorphic)
│   │   ├── mention-candidates/   # @mention 候補
│   │   ├── notifications/        # 通知 (+ mark-all-read)
│   │   ├── attachments/          # ファイル添付 (Supabase Storage)
│   │   ├── chat/                 # 意味検索 RAG (chat/search)
│   │   ├── help/                 # AI ヘルプチャット RAG
│   │   ├── settings/             # theme 等
│   │   ├── tenants/              # テナント自己管理 (me/billing/stripe/*, export, self-delete, i18n, recalculate 等)
│   │   ├── admin/                # admin + super (tenants suspend/resume/export/recalculate, stripe-dlq retry,
│   │   │                         #   billing confirm-payment, cron-history, usage-summary 等)
│   │   ├── webhooks/             # webhooks/stripe (署名検証)
│   │   ├── cron/                 # cron (billing-monthly-aggregation, cron-failure-alert,
│   │   │                         #   attachment-embedding, daily-notifications 等)
│   │   ├── client-errors/        # クライアントエラー受信
│   │   └── health/               # ヘルスチェック
│   ├── layout.tsx
│   └── globals.css
├── components/                   # 共通 UI コンポーネント (ui/ shadcn ベース 他)
├── lib/                          # ユーティリティ
│   ├── db.ts                     # Prisma Client (pg adapter / $use 無し)
│   ├── auth.config.ts            # NextAuth Edge 互換設定 (JWT 戦略・read-only ガード)
│   ├── auth.ts                   # NextAuth (authorize 実体・Node 側)
│   ├── rate-limit.ts             # in-memory レート制限
│   ├── basic-auth.ts             # super_admin 画面の Basic Auth
│   └── permissions/              # 権限/テナント境界 (check-permission / membership / role / tenant)
├── services/                     # ビジネスロジック (~70 service。DB 操作・認可・課金の中核)
├── config/                       # 業務定数 (master-data / security / validation / suggestion 等)
├── types/                        # 型定義
└── prisma/                       # schema.prisma + migrations/
```

### 3.3 設計原則

| 原則 | 適用方針 |
|---|---|
| レイヤー分離 | Route Handler → Service → Prisma の 3 層 |
| ロール/テナント認可 | **Service 層で明示実施** (各関数が `viewerTenantId` を引数に取り `where.tenantId` を強制)。**Middleware は認証だけでなく Basic Auth / login レート制限 / Beginner read-only / suspended write ブロックも担う** (詳細は [SECURITY.md §8.1](./SECURITY.md)) |
| 状態遷移 | State Machine パターンでプロジェクト状態を管理 |
| バリデーション | Zod スキーマで Route Handler / Server Action 側を検証 (フロント Zod も共有) |
| 論理削除 | 全テーブルに `deleted_at` カラム。**各 service が where に `deletedAt: null` を明示記述** (Prisma `$use` による自動フィルタは**不使用** — `src/lib/db.ts` は `$use` フックを持たない) |
| テナント分離 | service 層 `where.tenantId` が唯一の防御線。**DB の RLS はポリシー 0 件で実効的に無効**、Prisma が特権ロールで接続しバイパスする (詳細は [SECURITY.md §9.5.3](./SECURITY.md)) |
| 監査 | 権限変更・状態変更は専用テーブルに記録 |

> **訂正**: 旧版の「Prisma で project_id を自動付与」「論理削除フィルタをクエリで自動適用」は **実装と不一致**。
> `src/lib/db.ts` は PrismaClient を pg adapter で生成するのみ (全 21 行、`$use` 無し)。tenantId / `deletedAt` の
> 付与は service 層が where 句に明示記述する方式。SECURITY.md §9.5.3 と平仄を合わせる。

### 3.4 国際化 (i18n) アーキテクチャ

UI 文言の多言語対応は **next-intl** で実装する。メッセージカタログはサーバ側で解決し、Server / Client Component の双方に供給する。

**ロケールとメッセージ構成**:

| 項目 | 内容 |
|---|---|
| ライブラリ | next-intl (App Router、サーバ設定 `src/i18n/request.ts` の `getRequestConfig`) |
| 対応ロケール | **`ja` (日本語) / `en-US` (英語)** の 2 つ。`src/i18n/request.ts#SUPPORTED_LOCALES` (= messages/ のファイル名) |
| メッセージカタログ | `src/i18n/messages/ja.json` / `src/i18n/messages/en-US.json`。両者は同一キー構造 (`action` / `nav` / `field` / `message` 等のネスト) で、`src/i18n/messages.test.ts` がキー集合の整合をテストで保証 |
| 既定ロケール | `ja` (`DEFAULT_LOCALE`)。未認証ページ・ロケール未解決時に適用 |
| BCP 47 ↔ ファイル名 | `src/config/i18n.ts` は BCP 47 形式 (`ja-JP` / `en-US`) を扱い、`request.ts#toMessagesFilename` が messages/ ファイル名 (`ja` / `en-US`) に変換 (`ja-JP` / 未知ロケールは `ja` にフォールバック) |

**ロケール解決順序** (3 段フォールバック、`src/config/i18n.ts#resolveLocale`):

1. **認証ユーザの個別設定** — `auth().user.locale` (設定画面で変更、JWT claim 経由)
2. **システムデフォルト** — 環境変数 `APP_DEFAULT_LOCALE`、未設定なら `ja-JP`
3. **未サポート/未解決** — `ja` にフォールバック (`auth()` が middleware 等の特殊 context で throw した場合も含め安全側に倒す)

> ロケール変更は JWT 再署名で全経路 (middleware / SSR / client) に透過反映する (`/api/tenants/me/i18n` → `reissueAuthJwtOnResponse`、[SECURITY.md §9.4.4.1](./SECURITY.md))。タイムゾーンも同じ 3 段フォールバック (`resolveTimezone`)。DB は常に UTC 保存し描画時に TZ/locale を解決する。

**現状の方針 (MVP)**: プロダクトは **ja 中心** で開発・運用している。`en-US` カタログは既に全キーが翻訳済で `src/config/i18n.ts#SELECTABLE_LOCALES` も `'en-US': true` (Phase C 完了 / PR #175) のため UI のロケール選択肢としても **選択可能**。ただし MVP の主対象は日本語ユーザであり、英語は周辺対応の位置づけ。新規 UI 文言を追加する際は **ja / en-US 両方** にキーを追加すること (`messages.test.ts` がキー集合の欠落を検知する)。

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

詳細: [docs/developer-guide/REFERENCE.md](../operations/develop/REFERENCE.md)(設計原則のリマインダ)

---

## ADR-0025: Beginner プラン write ガード層 (2026-05-29 追加)

[src/services/storage-guard.service.ts](../../src/services/storage-guard.service.ts) の 4 関数 (`precheckStorageLimit` / `assertStorageLimitInTx` / `precheckFileStorageLimit` / `assertFileStorageLimitInTx`) に Beginner プラン専用判定を統合:

- `plan === 'beginner' && cached usage > BEGINNER_DB_FREE_TIER_BYTES (50MB)` で `BeginnerWriteGuardExceededError` を throw
- DELETE は storage-guard を通らないため自動許可、`addedBytes < 0` (= ファイル削除) もガード対象外
- **2026-05-31 (ADR-0030「データはたすきばの命」)**: 累積 50GB ハードキャップ (全プラン write 拒否) と circuit-breaker (計測失敗時 fail-close) は撤去済。現在の storage-guard の write block は **Beginner 無料枠ガードのみ**。L1/L2/L3 (1GB/10GB/50GB) は super_admin への監視アラート閾値 (write は止めない)。計測失敗は **fail-open** (write 継続、日次 cron `updateAllStorageBytesUsed` が真値補正)。1 操作あたりの瞬間負荷は `DB_WRITE_PAYLOAD_MAX_BYTES` (5MB、`requireStorageQuotaForWrite`) / ファイル 50MB/件で抑制

DELETE 後の自動再集計 (`maybeRecalcAfterBeginnerDelete()`) は post-commit hook として 6 主要 service (knowledge / project / risk / retrospective / memo / attachment) の DELETE 関数末尾で呼出。debounce 30 秒、fail-safe (re-calc 失敗は DELETE 本体を巻き戻さない)。

詳細: [ADR-0025](../adr/0025-beginner-write-guard.md) / [仕様書 BEGINNER_PLAN.md](../specification/BEGINNER_PLAN.md)

---

## ADR-0035: 一括操作のチャンク分割送信 + サーバ側バッチ化 + 再計算末尾集約 (2026-06-05 追加)

WBS の一括削除を、**Netlify 同期関数の 10 秒上限**と性能を両立する形へ再設計した。背景は、旧実装が「クライアントが ID ごとに `DELETE /tasks/[taskId]` を逐次送信 (1 件 ~9 DB 往復) する」ため、15 件で 1 件 3〜4 秒 = 数十秒かかっていたこと。一方で全件 1 リクエストに集約すると大量データで 10 秒を再超過する (ADR-0032 のインポート 504 と同型)。

**2 つの独立レバーを分離して両方適用する**:

- **レバー A (往復削減 / バッチ)**: 専用エンドポイント [`bulk-delete`](../../src/app/api/projects/[projectId]/tasks/bulk-delete/route.ts) + service `bulkDeleteTasks` で、認証/権限を 1 回に集約し、対象を 1 回の `findMany` で所有確認 (越境/別 project/既削除を除外)、本体 + Attachment + Comment を `$transaction([updateMany×3])` で一括 soft-delete。**往復は件数 K に依存せず ~5-6 回で固定**。監査は `recordBulkAuditLogs` (createMany)。
- **レバー B (分割送信 / チャンク)**: 共有 util [`runChunkedBulk`](../../src/lib/run-chunked-bulk.ts) が選択 ID を **K=100 件ずつ・最大 3 並列**で送信。各チャンクの ID は互いに素なので並列安全。部分失敗はチャンク単位で集約し、論理削除が `deletedAt: null` 条件付きで**冪等**なため失敗チャンクのみ再送可能。
- **再計算の末尾集約**: 削除チャンク内では再計算せず、`runChunkedBulk` の `finalize` で **`POST /tasks/recalculate` を全チャンク完了後に 1 回だけ**呼ぶ (`task:delete` 保持ロールは `task:update` も持つため認可される)。なお `recalculateAllProjectWps` 自体も ADR-0037 で「全タスク 1 fetch + メモリ集計 (深度降順) + 変更 WP のみ `$transaction` 一括 update」に畳み、往復を WP 数非依存にした (旧: WP ごと findUnique+update の O(WP) 逐次往復)。この共有改善で finalize の `recalculate` も高速化する。

**適用範囲 (本リリース)**: WBS 一括削除に加え、**単一 CRUD の冗長 fetch / 無条件 write も削減**した — (a) `deleteTask` を単一 fetch 化 (所有確認 + before(TaskDTO) を 1 query に集約、`projectId` 引数追加) し route の `getTask` 二重 fetch を撤去 (監査内容は同一)、(b) `updateTask` の現在値 `findUnique` を owned `findFirst` に統合、(c) `recalculateAncestors` に「一致時 skip + 上位伝播停止」を追加 (最終格納値は同一)。一括更新 (`bulkUpdateTasks`) は本体 `updateMany` はバッチ済のため据え置きだが、**再計算の末尾処理を改修**した: 旧実装は「親ごとに `recalculateAncestors` をルートまで再帰」で共有祖先を親の数だけ重複再計算し、横広な更新 (多数の別 WP にまたがる) で逐次往復が膨らんでいた。新ヘルパ `recalculateAffectedWps` で**影響 WP 集合 (親 ∪ 祖先) を重複なく深度降順で 1 回ずつ**再計算する (最終集計値は同一)。`recalculateAllProjectWps` への置換は、狭い更新を巨大プロジェクトで O(全 WP) に退行させるため**採らない**。認可は不変 (認可済リクエスト内で再計算。member の `task:update_progress` 経由でも成立。`recalculate` を別途叩く bulk-delete 方式は権限上 bulk-update には使えないが本改修は不要とする)。将来、巨大プロジェクトの WP 再計算が 10 秒超になる場合は WP 集計の SQL 化または Background Function を検討 (ADR-0032 §79 / 本 ADR 決定 7)。

詳細: [ADR-0035](../adr/0035-bulk-ops-chunked-batching-and-recalc-deferral.md) / [ADR-0032](../adr/0032-task-name-uniqueness-removal-and-wbs-import-batching.md) (同型のインポートバッチ化)

---

