# たすきば Knowledge Relay - Claude Code 運用ガイド

> **本プロジェクトの開発モード (2026-06-01 以降)**: 人間駆動開発。Claude Code は **緊急時 / 重大障害時のみ** の利用を想定しています。平時の機能追加・保守は人間の開発者が IDE で直接実施します。
>
> 通常の開発手順・規約は [CONTRIBUTING.md](./CONTRIBUTING.md) と [docs/](./docs/README.md) を参照してください。本ファイルは「Claude Code が稼働するときの追加ルール」のみを記述します。

---

## プロジェクト概要

**たすきば Knowledge Relay** — プロジェクトの知見を蓄積し、次案件の判断を強化する運営プラットフォーム。
技術スタック: Next.js (App Router) / TypeScript / PostgreSQL (Supabase) / Prisma / Tailwind CSS / Voyage embedding。

詳細は [README.md](./README.md) と [docs/README.md](./docs/README.md) を参照。

---

## Claude Code の役割 (緊急時運用前提)

平時は人間が開発するため、Claude Code は以下のような場面のみで起動される想定:

- **重大障害の切り分け・初動調査** — ログ解析、影響範囲特定、暫定回避策の検討
- **特定領域への深い調査依頼** — 大量のファイル横断調査、リファクタの影響範囲分析
- **複雑な仕様変更のドラフト** — 設計案の選択肢提示、ADR 草案作成

緊急時に「何でもいいから動かす」のではなく、**判断材料の提示と人間の承認を経た実装** を原則とする。

---

## 情報源の信頼性ルール (必須遵守・例外なし)

調査・実装方針の判断時は、**信頼度の高い情報源を必ず優先**する。推測や不確実な情報に基づく実装は禁止。

### 優先順位 (上から順に信頼)
1. **公式ドキュメント** — 製品/ライブラリ/フレームワークのベンダー公式サイト・公式リファレンス
2. **公式リポジトリ** — 公式 GitHub organization の README / docs / ソースコード / Issue
3. **公式ブログ・リリースノート・RFC** — ベンダー公式発表、標準仕様 (W3C / IETF / ISO)
4. **著者が信頼できる技術記事** — 公式メンバー・コア開発者・著名エンジニアによる記事
5. **学術論文・査読済み論文** — arXiv / ACM / IEEE 等

### 禁止・警戒すべき情報源
- 出典不明の Q&A サイト回答 (投票数が少なく古いもの)
- 3 年以上更新されていない個人ブログ
- AI 生成記事で一次ソース未検証のもの
- SEO 目的のまとめ記事・キュレーションサイト
- **推測・記憶ベースで「存在するはず」の API / 関数 / フラグを使用すること (ハルシネーション防止)**

### 遵守の仕組み
- **Web 検索/WebFetch 使用時**: URL と情報源の種別 (公式/非公式) を明記する
- **不確実な情報**: 「要確認」「一次ソース未検証」と明記する
- **情報の矛盾時**: 公式情報を優先する
- **存在確認**: API・関数・フラグを使う前に公式ドキュメントまたはソースコードで実在を確認する
- **バージョン明記**: ライブラリ仕様を参照する際は対象バージョンを明記する
- **引用の追跡可能性**: 技術的判断の根拠は必ず URL または該当ファイル行を残す

### 違反時の扱い
- 不確実情報に基づくコード提案は **ユーザに事前確認** してから実装する
- 事後に誤りが発覚した場合は、正しい一次ソースを添えて修正する

---

## コミット前チェック (毎回必須)

Claude Code が実装変更を行った場合、コミット前に以下を必ず実施する (詳細手順は [`.claude/skills/quality-check.md`](./.claude/skills/quality-check.md))。

1. **横展開チェック** — 同一パターンを検索し漏れなく対応
2. **退行 (リグレッション) チェック (重点)**
   - **単体テスト** (`pnpm test`): ローカル実行し差分が無いことを確認。テスト数の増減・旧文言残留もチェック
   - **E2E カバレッジ横展開**: 新規 `page.tsx` / `route.ts` を追加したら `docs/test/E2E_COVERAGE.md` に追記。`pnpm e2e:coverage-check` で gap 検出可、`ci.yml` でも強制
3. **デプロイチェック** — `pnpm lint` → `pnpm tsc --noEmit` → `pnpm test` → **`pnpm e2e:coverage-check`** (新規 route/page 追加時の漏れ検知、PR #372 で push 後 CI fail 事故 [KDD §5.X+58](./docs/knowledge/KDD_PATTERNS.md)) → `pnpm build` をローカル実行
4. **E2E ローカル実行 (任意)** — UI / API 変更時は `pnpm test:e2e` で事前検証 (CI でも自動実行)
5. **ドキュメント最新化** — 変更内容に応じて [docs/](./docs/README.md) 配下の該当ディレクトリを更新

> セキュリティ・パフォーマンスのチェックは CI (`.github/workflows/security.yml` で `score 90/100` 強制) とユーザリクエストによる都度対応へ移行済。

---

## コミットルール

- **テストコードの追加・修正を伴わないソースコード変更はコミットしない**
- コミットメッセージは変更内容を端的に記述する
- **コミットは Claude Code が勝手にやらず、必ずユーザに確認** してから実施する (緊急時運用では安全性を最優先)
- `main` / `master` / `develop` / `release/*` / `hotfix/*` への直接コミットは禁止

ブランチ命名・コミットメッセージ規約・PR 作成手順は [CONTRIBUTING.md](./CONTRIBUTING.md) 参照。

---

## 情報の見つけ方 (docs/ への索引)

緊急時に Claude Code が状況を把握するために、まず以下を参照:

| 知りたいこと | 参照先 |
|---|---|
| 全体構造・どこを読めばいいか | [docs/README.md](./docs/README.md) |
| アーキテクチャ・データモデル | [docs/design/ARCHITECTURE.md](./docs/design/ARCHITECTURE.md) / [docs/design/DATA_MODEL.md](./docs/design/DATA_MODEL.md) |
| API 設計・セキュリティ設計 | [docs/design/API_DESIGN.md](./docs/design/API_DESIGN.md) / [docs/design/SECURITY.md](./docs/design/SECURITY.md) |
| 画面仕様・権限マトリクス | [docs/specification/](./docs/specification/) |
| ビジネスロジック (プロジェクト状態遷移・課金・ロール) | [docs/business/](./docs/business/) |
| 課金モデル ADR (LLM call / DB 容量) | [docs/adr/0019-billable-feature-units-and-free-tier-expansion.md](./docs/adr/0019-billable-feature-units-and-free-tier-expansion.md) (API call 課金) / [docs/adr/0020-db-capacity-usage-based-billing.md](./docs/adr/0020-db-capacity-usage-based-billing.md) (DB 容量従量課金) |
| 障害対応 SOP・運用手順 | [docs/operations/operate/INCIDENT_RESPONSE.md](./docs/operations/operate/INCIDENT_RESPONSE.md) |
| 過去の罠・教訓 (実装時に参照) | [docs/knowledge/](./docs/knowledge/) / [docs/test/E2E_LESSONS.md](./docs/test/E2E_LESSONS.md) |
| テスト戦略・E2E カバレッジ | [docs/test/](./docs/test/) |
| 環境変数・デプロイ | [docs/operations/ENV_VARS.md](./docs/operations/ENV_VARS.md) / [docs/operations/develop/DEPLOYMENT.md](./docs/operations/develop/DEPLOYMENT.md) |
