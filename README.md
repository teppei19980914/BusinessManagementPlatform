# たすきば Knowledge Relay

> 知見を残す。判断をつなぐ。プロジェクトを強くする。

## 概要

**たすきば Knowledge Relay** は、プロジェクトの知見を蓄積し、次の判断を強くする運営プラットフォームです。

### テーマ

プロジェクトの知見を蓄積し、次の判断を強くする運営プラットフォーム

### コンセプト

運営するほど、次のプロジェクトがうまくいく。

プロジェクトを繰り返すごとに、現担当者が蓄積したナレッジが次の担当者へ引き継がれ、さらに洗練された判断が可能になります。

### 主な特徴

- **一気通貫の運営基盤** - 企画・見積もり・計画・実行・監視・振り返りまで、一つのプラットフォームで完結
- **知見の循環** - プロジェクトで得た知見をナレッジとして蓄積し、次案件の見積もり・計画に再利用
- **健全なプロジェクト運営** - QCD のバランスを保ち、リスク・課題を早期に可視化

## MVP 機能

| 機能 | 説明 |
|---|---|
| プロジェクト管理 | 企画から振り返りまでの状態遷移管理 |
| 見積もり管理 | 過去ナレッジ・実績を参照した見積もり作成 |
| WBS / タスク管理 | 階層構造のタスク管理、担当割り当て |
| ガントチャート | スケジュールの時系列可視化 |
| 進捗・実績管理 | メンバーの進捗更新、実績工数の記録 |
| リスク・課題管理 | リスク/課題の起票・追跡・対応記録 |
| ナレッジ管理 | 知見の登録・検索・公開・再利用 |
| 振り返り | プロジェクト完了後の総括とナレッジ化 |
| 権限管理 | RBAC（システム管理者 / PM・TL / メンバー / 閲覧者） |

## 技術スタック

| レイヤー | 技術 |
|---|---|
| フロントエンド | Next.js 15 (App Router) / React 19 / TypeScript |
| UI | shadcn/ui / Tailwind CSS |
| バックエンド | Next.js API Routes / Server Actions |
| ORM | Prisma 7 |
| データベース | PostgreSQL 16 |
| 認証 | NextAuth.js (Auth.js) 5 |
| テスト | Vitest / Playwright |

## セットアップ

### 前提条件

- Node.js 22 LTS
- pnpm
- Docker / Docker Compose（PostgreSQL 用）

### 手順

```bash
# 1. リポジトリのクローン
git clone <repository-url>
cd BusinessManagementPlatform

# 2. 依存パッケージのインストール
pnpm install

# 3. 環境変数の設定
cp .env.example .env
# .env を編集して DATABASE_URL, NEXTAUTH_SECRET 等を設定

# 4. データベースの起動
docker compose up -d

# 5. マイグレーションの実行
pnpm prisma migrate dev

# 6. 開発サーバの起動
pnpm dev
```

http://localhost:3000 でアクセスできます。

## ドキュメント

| ドキュメント | 説明 |
|---|---|
| [要件定義書](docs/REQUIREMENTS.md) | プラットフォームの要件定義（たたき台） |
| [仕様書](docs/SPECIFICATION.md) | MVP の機能仕様・画面仕様・権限マトリクス |
| [設計書](docs/DESIGN.md) | アーキテクチャ・ER 図・テーブル定義・API 設計 |
| [開発計画書](docs/PLAN.md) | MVP-1a / 1b / 2 のスケジュール・スコープ・リリース条件 |

## ライセンス

Private
