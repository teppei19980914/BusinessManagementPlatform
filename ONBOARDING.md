# Onboarding — 最初の 30 分

> このファイルは「リポジトリをクローンした直後に開く」ためのクイックスタートです。
> 詳細手順は [docs/beginner/README.md](./docs/beginner/README.md)、ドキュメント全体の歩き方は [docs/README.md](./docs/README.md) を参照。

---

## 1. 何のサービスか (1 分)

**たすきば Knowledge Relay** — プロジェクトの知見を蓄積し、次の判断を強くする運営プラットフォーム。
詳細: [README.md](./README.md) / 思想・価値観: [docs/vision/README.md](./docs/vision/README.md)

---

## 2. 環境を立ち上げる (15-30 分)

| # | やること | 参照 |
|---|---|---|
| 1 | Node.js (v20+) / pnpm / Docker をインストール | [docs/operations/SETUP_LOCAL.md](./docs/operations/SETUP_LOCAL.md) |
| 2 | `.env` を作成 (`.env.example` をコピー) | [docs/operations/ENV_VARS.md](./docs/operations/ENV_VARS.md) |
| 3 | `pnpm install` で依存解決 | — |
| 4 | `docker compose up -d` でローカル PostgreSQL を起動 | — |
| 5 | `pnpm prisma migrate dev` でスキーマ適用 + seed 投入 | — |
| 6 | `pnpm dev` で開発サーバ起動 → `http://localhost:3000` にアクセス | — |
| 7 | seed ユーザでログインして主要画面を一巡 | [docs/beginner/README.md §1](./docs/beginner/README.md) |

詰まったら [docs/operations/SETUP_LOCAL.md](./docs/operations/SETUP_LOCAL.md) のトラブルシューティング節へ。

---

## 3. 次に読むもの (段階別)

新規参入者が **判断できるレベル** に到達するためのリーディングパスが [docs/README.md](./docs/README.md) にあります。

- **初日 (Day 1)** — 動かす / プロダクトを語れる
- **1 週目 (Week 1)** — コード構造を把握 / 簡単な機能追加ができる
- **1 ヶ月目 (Month 1)** — 設計判断の背景を理解 / 複雑な変更を提案できる

各段階で読むべきドキュメントの **#・トピック・参照先** が 3 列表で示されています。**上から飛ばさず順に**読むのが推奨。

---

## 4. 開発フローの要点 (5 分)

- **ブランチ**: `feat/...` / `fix/...` / `docs/...` / `refactor/...` / `hotfix/...` (CONTRIBUTING.md §2)
- **コミット**: テストコードの追加・修正を伴わないソースコード変更は禁止 (テスト必須)
- **コミット前**: `pnpm lint && pnpm tsc --noEmit && pnpm test && pnpm build` を必ず通す
- **新規 `page.tsx` / `route.ts` 追加時**: `pnpm e2e:coverage-check` を必ず実行
- **PR**: テンプレートに従い、レビュー観点チェックリストを埋める ([CONTRIBUTING.md §5](./CONTRIBUTING.md))
- **`main` / `release/*` / `hotfix/*` への直接コミット禁止**

詳細: [CONTRIBUTING.md](./CONTRIBUTING.md) / [docs/developer-guide/COMMIT_AND_DEPLOY.md](./docs/developer-guide/COMMIT_AND_DEPLOY.md)

---

## 5. 困ったときの参照先

| 困りごと | 参照先 |
|---|---|
| 環境構築でハマった | [docs/operations/SETUP_LOCAL.md](./docs/operations/SETUP_LOCAL.md) |
| 業務用語が分からない | [docs/business/GLOSSARY.md](./docs/business/GLOSSARY.md) |
| 「なぜこの設計?」 | [docs/adr/](./docs/adr/README.md) (ADR 索引) |
| 「この機能は何のため?」 | [docs/business/](./docs/business/) / [docs/specification/](./docs/specification/) |
| 過去の罠・教訓 | [docs/knowledge/](./docs/knowledge/) / [docs/test/E2E_LESSONS.md](./docs/test/E2E_LESSONS.md) |
| 障害対応 | [docs/operations/INCIDENT_RESPONSE.md](./docs/operations/INCIDENT_RESPONSE.md) |

---

## 6. 開発モード (現在)

本プロジェクトは **2026-06-01 以降、人間駆動開発** に移行しています。

- 平時の機能追加・保守は人間が IDE で直接実施
- Claude Code (`CLAUDE.md`) は **緊急時 / 重大障害時のみ** 利用
- AI 駆動時代の自動化 (auto-commit / session-start hook / KDD skill 等) は撤去済み

このモードで開発するための前提・規約は [CLAUDE.md](./CLAUDE.md) と [CONTRIBUTING.md](./CONTRIBUTING.md) を参照。
