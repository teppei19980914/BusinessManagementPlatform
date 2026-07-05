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

## コスト効率・モデル運用ルール (2026-06-09 / Pro プラン移行に伴い必須)

契約を Max ($100/月) → **Pro ($19/月)** に変更したため、Claude Code の消費 (トークン / 使用枠) を抑える運用を必須とする。Pro は 5 時間ごと + 週次の使用上限があり、枠を浪費する操作を避ける。

### モデル使い分け (最大のコストレバー)

- **既定は Sonnet** (`.claude/settings.local.json` の `model: sonnet` で固定済)。日々の実装・調査・設計検討・docs 更新・ADR 草案は Sonnet で十分な品質。
- **Opus は明示時のみ**。以下に該当するときだけ Claude 側から「Opus への切替」を提案し、ユーザが `/model` で切り替える (自動切替は不可):
  1. **severity-1 領域の横断検証** — テナント越境 (`where.tenantId`) / 課金 invariant (ApiCallLog SUM 一致) / DB カラム撤去の多レイヤ確認
  2. **大規模リファクタの影響範囲分析** — 広い範囲を同時に保持して矛盾・抜けを探す
  3. **込み入ったデバッグ** — 症状と真因が離れている / テスト緑なのに本番で落ちる
  4. **後戻りコスト極大の根幹設計の最終判断**
- 理想形: Sonnet で設計を詰め、最終チェックだけ Opus に上げて検証する併用。
- ⚠️ **「Claude は判断・設計・調査だけ」ではない。実装 (コードを書く) は Claude の本業**。剥がすのは下記の定型機械作業のみ。

### 消費を抑える運用

- **機械でできることは Claude にやらせない**: lint / test / security:gate / perf 検査 / ブランチ作成 / commit 抑止は hook / CI に置けば Claude トークン消費ゼロで確実に実行される。Claude を介して実行・ログ解釈させると毎回トークンを食う。
- **サブエージェント多並列・`/code-review ultra`・Workflow は Pro では原則封印**。1 回で通常の数十倍消費し週次枠を一気に溶かす。探索は単発で的を絞った検索で代替する。
- **1 タスク = 1 セッション、完了したら `/clear`**。長い会話は毎ターン履歴を再処理し入力トークンが膨張する。
- **拡張思考は常時 OFF** (グローバル設定済)。思考が要る場面だけ明示的に使う。

---

## コミット前チェック (毎回必須)

Claude Code が実装変更を行った場合、コミット前に以下を必ず実施する (詳細手順は [`.claude/skills/quality-check.md`](./.claude/skills/quality-check.md))。

1. **横展開チェック** — 同一パターンを検索し漏れなく対応
2. **退行 (リグレッション) チェック (重点)**
   - **単体テスト** (`pnpm test`): ローカル実行し差分が無いことを確認。テスト数の増減・旧文言残留もチェック
   - **E2E カバレッジ横展開**: 新規 `page.tsx` / `route.ts` を追加したら `docs/test/E2E_COVERAGE.md` に追記。`pnpm e2e:coverage-check` で gap 検出可、`ci.yml` でも強制
3. **デプロイチェック** — 以下の順に実行する
   - **`pnpm check:migration-sync`** (**最優先**。`schema.prisma` を変更した場合は必ず先頭で実行。マイグレーションファイル未生成のまま main にマージすると本番 DB のテーブルが作成されず全 API が 500 になる。v1.5.0 教訓)
   - `pnpm lint` → `pnpm tsc --noEmit` → `pnpm test` → **`pnpm e2e:coverage-check`** (新規 route/page 追加時の漏れ検知、PR #372 で push 後 CI fail 事故 [KDD §5.X+58](./docs/knowledge/KDD_PATTERNS.md)) → `pnpm build`
4. **E2E ローカル実行 (任意)** — UI / API 変更時は `pnpm test:e2e` で事前検証 (CI でも自動実行)
5. **ドキュメント最新化** — 変更内容に応じて [docs/](./docs/README.md) 配下の該当ディレクトリを更新

> セキュリティ・パフォーマンスのチェックは CI (`.github/workflows/security.yml` で `score 90/100` 強制) とユーザリクエストによる都度対応へ移行済。

---

## コミットルール

- **テストコードの追加・修正を伴わないソースコード変更はコミットしない**
- コミットメッセージは変更内容を端的に記述する
- **コミットは Claude Code が勝手にやらず、必ずユーザに確認** してから実施する (緊急時運用では安全性を最優先)
- `main` / `master` / `develop` / `release/*` / `hotfix/*` への直接コミットは禁止
- **commit / push / PR 作成は PreToolUse hook (`block-git-publish.sh`) で既定ブロック**。ユーザが明示依頼したターンのみ、合言葉 `ALLOW_GIT_PUBLISH=1` を前置して実行する (PowerShell は `$env:ALLOW_GIT_PUBLISH='1';`)。

ブランチ命名・コミットメッセージ規約・PR 作成手順は [CONTRIBUTING.md](./CONTRIBUTING.md) 参照。

---

## 週次リリース運用 (2026-06-09)

- **毎週金曜リリース** (目標。リリース日は変動しうる)。**土曜始まり〜金曜まで**の変更を 1 ブランチに集約し、金曜に main へマージ & デプロイする。
- **ブランチ名 = `week/YYYY-wWW`** (ISO 週番号、ただし土曜始まりに補正)。例: `week/2026-w24`。リリース日に依存しない抽象的命名。`release/*`・`hotfix/*` は保護接頭辞のため使わない。
- **SessionStart hook (`session-start-weekly-branch.sh`)** が起動時に当週ブランチを**冪等に保証** (有れば checkout / 無ければ main 最新化のうえ作成)。週途中の再起動でも同じ週次ブランチに乗り続ける。
  - 未コミット変更がある場合は自動切替せず警告のみ (commit はしない方針)。
  - 「ブランチを切らないで」と指示された場合は `.claude/.weekly-branch-disabled` を touch してスキップ。
- 溜め方は**週次ブランチへ直接コミット** (機能別サブブランチ統合はしない)。

---

## docs 同期チェーン (実装変更時に必ず連動)

実装を変更したら、以下を **1 作業単位として連動**させ「片方だけ更新」を禁止する。

```
実装変更 → docs/design/ → docs/public/ → src/config/faq-content.ts / guide-content.ts → (週次デプロイ時に Embedding 自動再生成)
```

- **public への展開条件**: 違法でも、たすきばの機密情報でもないものに限る。
- **FAQ/ガイド = たすきフクロウの頭脳**。`/help`・`/guide` 画面 (ユーザメニューから到達) とフクロウ AI チャットの共通ソース。
- **Embedding は片方向・デプロイ時生成**: `faq-content.ts` 等を更新しても本番フクロウが新知識を学ぶのは**週次デプロイ (`build:netlify` が `generate-faq-embeddings.ts` を実行) 時**。ローカル完了時点で本番フクロウが未更新なのは**正常**。SHA-256 変更検知で差分のみ再生成 (無変更 deploy は Voyage 呼出ゼロ)。
- 詳細手順は完了時に [`.claude/skills/quality-check.md`](./.claude/skills/quality-check.md) Step 2-3 で確認する。

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
