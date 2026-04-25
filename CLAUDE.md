# たすきば Knowledge Relay - Claude Code 運用ガイド

## プロジェクト概要

- **たすきば Knowledge Relay** - Next.js / TypeScript / PostgreSQL プロジェクト

## 情報源の信頼性ルール（必須遵守・例外なし）

調査・リサーチ・実装方針の判断時は、**信頼度の高い情報源を必ず優先**する。推測や不確実な情報に基づく実装は禁止。

### 優先順位（上から順に信頼）
1. **公式ドキュメント** — 製品/ライブラリ/フレームワークのベンダー公式サイト、公式リファレンス
2. **公式リポジトリ** — 公式 GitHub organization の README / docs / ソースコード / Issue
3. **公式ブログ・リリースノート・RFC** — ベンダー公式発表、標準仕様（W3C / IETF / ISO）
4. **著者が信頼できる技術記事** — 公式メンバー・コア開発者・著名エンジニアによる記事
5. **学術論文・査読済み論文** — arXiv、ACM、IEEE 等

### 禁止・警戒すべき情報源
- ❌ 出典不明の Q&A サイト回答（Stack Overflow でも投票数が少なく古いものは注意）
- ❌ 3年以上更新されていない個人ブログ
- ❌ AI 生成記事で一次ソース未検証のもの
- ❌ SEO 目的のまとめ記事・キュレーションサイト
- ❌ **推測・記憶ベースで「存在するはず」の API / 関数 / フラグを使用すること（ハルシネーション防止）**

### 遵守の仕組み
- **Web 検索/WebFetch 使用時**: 必ず URL と情報源の種別（公式/非公式）を明記する
- **不確実な情報**: 「要確認」「一次ソース未検証」と明記する
- **情報の矛盾時**: 必ず公式情報を優先する
- **存在確認**: API・関数・フラグを使う前に公式ドキュメントまたはソースコードで存在を確認する
- **バージョン明記**: ライブラリ仕様を参照する際は対象バージョンを明記する
- **引用の追跡可能性**: 技術的判断の根拠は必ず URL または該当ファイル行を残す

### 違反時の扱い
- 不確実情報に基づくコード提案は**ユーザーに事前確認**してから実装する
- 事後に誤りが発覚した場合は、正しい一次ソースを添えて修正する

## 運用フロー（日次ブランチ自動化）

### 開発開始時 (SessionStart Hook が自動実行)
1. 前日以前の `dev/YYYY-MM-DD` ブランチを検出
2. 未コミット変更があればコミット＆プッシュ
3. PR 未作成なら `gh pr create` で自動作成
4. PR が `MERGED` 状態ならローカル/リモートブランチを削除
5. 当日の `dev/YYYY-MM-DD` ブランチを作成・チェックアウト（既存ならチェックアウトのみ）

### 開発中
1. Claude Code が要件取り込み + テスト追加
2. Stop Hook で `secret-scan` → 静的解析 → テスト → **テスト成功時のみ自動 commit & push**
3. テスト失敗時はコミットせず、原因調査・修正後に再試行

### マージ
- 開発者が GitHub 上で PR をマージ（手動）
- 翌日のセッション開始時に旧ブランチが自動削除される

## コミットルール

- テストコードの追加・修正を伴わないソースコード変更はコミットしない
- コミットメッセージは変更内容を端的に記述する
- **コミット & プッシュは Stop Hook が自動実行**（`auto-commit.sh`）
- **マージは開発者が手動実施**（自動化対象外 — 安全のため）
- `main` / `master` / `develop` / `release/*` / `hotfix/*` への直接コミットは保護（auto-commit.sh が拒否）
- 自動化を無効化したい場合は `.claude/.git-automation-config` を削除

## 知識駆動開発 (KDD) フロー — 全タスク必須

過去の事象・罠・解決パターンを **次の開発で必ず再利用** することで品質保証を継続向上させる。
詳細手順は各 Skill を参照。

| Step | 何をする | 仕組み |
|---|---|---|
| 1 | 開発着手 (要件・タスク定義) | 通常通り |
| 2 | **既存ナレッジ参照** (実装前に必須) | `/recall <topic>` skill で `DEVELOPER_GUIDE.md §5/§10` + `E2E_LESSONS_LEARNED.md §4` から関連事例を抽出。**横展開すべき先例があれば即適用** (例: htmlFor/id ペア、editDialog の close→reload 順、SearchableSelect の事前 validation 等) |
| 3 | 実装 | step 2 で抽出したナレッジを必ず適用。「同じ罠を再現させない」を最優先 |
| 4 | **実装中の新ナレッジ追記** | `/knowledge-add` skill で発見した罠・パターンを `DEVELOPER_GUIDE.md` または `E2E_LESSONS_LEARNED.md` に追記 |
| 5 | コミット & プッシュ | `pnpm lint && pnpm tsc --noEmit && pnpm test` を必ず通してから (lint だけでは Vercel build を救えない: §5.11.1) |
| 6 | **CI / E2E / Vercel エラー対応** | 失敗ログを基に修正、調査と修正で得たナレッジは `/knowledge-add` で必ず追記 |
| 7 | **PR マージごとの MECE 整理** | `/knowledge-organize` skill で重複・古いナレッジを統合・削除。SessionStart hook (`session-start-knowledge-check.sh`) が **前回セッション以降に main へマージされた PR を検出** し、1 件以上あれば本セッション中に実行を提案する |

**遵守の原則**:

- **Step 2 を飛ばさない**: 「ちょっとした修正」でも `/recall` する。同じ罠の連鎖が §10.5 末尾追記コンフリクトの 5 例目まで続いた経験から学ぶ
- **新規ナレッジは即追記**: 「PR にまとめてから」ではなく **発見時点で追記**。記憶は揮発する
- **重複は許さない**: 同じ事象を 2 箇所に書かない。整理時に統合する (`/knowledge-organize`)
- **前提が変わったら updatedAt と再発事例の連番を必ず付ける** (§10.5 の方式)

## コミット前チェック（毎回必須）

実装完了後、コミット前に以下を必ず実施する。詳細手順は各スキルを参照。

1. **横展開チェック** — 同一パターンを検索し漏れなく対応
2. **セキュリティチェック** — 以下の仕組みで多層防御
   - **自動ブロック (Hooks)**: 危険API (`eval`/`innerHTML`/`dangerouslySetInnerHTML`/動的`exec`)、機密ファイル (`.env`/`*.pem`/`*.key`) への編集、機密情報の混入を自動検知
   - **観点別レビュー (Agents)**: `auth-reviewer` / `injection-reviewer` / `xss-reviewer` / `secret-reviewer` / `dependency-reviewer` を**並列実行**
   - **設計段階 (Skill)**: 新機能実装前に `/threat-model` で STRIDE 分析を必須化
   - **セキュリティテスト必須**: 認可境界、不正入力（SQLi/XSS payload）、認証バイパス試行のテストを追加
3. **パフォーマンスチェック** — N+1禁止、不要な再描画、非同期並列化
4. **デプロイチェック** — `pnpm lint` → `pnpm test` → `pnpm build` をローカル実行
5. **単体テスト** — テスト数の増減を確認、旧文言の残留を検索
6. **E2E カバレッジ横展開** (PR #90 以降) — 新規 `page.tsx` / `route.ts` を追加したら必ず `docs/developer/E2E_COVERAGE.md` に追記する。`pnpm e2e:coverage-check` で gap 検出可、`ci.yml` でも強制
7. **ドキュメント最新化** — 変更内容に応じて以下のドキュメントを必ず更新する (docs/ は PR #107 以降、役割別サブディレクトリ構成)
   - `README.md` — プロジェクト概要・セットアップ手順 (外部ユーザ向け)
   - `docs/administrator/OPERATION.md` — 運用手順・環境変数・マイグレーション・デプロイ・監視・障害対応・ロールバック
   - `docs/developer/REQUIREMENTS.md` — 要件定義
   - `docs/developer/SPECIFICATION.md` — 機能仕様
   - `docs/developer/DESIGN.md` — 設計（アーキテクチャ・データモデル等）
   - `docs/developer/TESTING_STRATEGY.md` — 自動テスト + 手動テストの全体戦略 (PR #96 以降、UAT/a11y/クロスブラウザ等の人間担当領域)
   - `docs/developer/DEVELOPER_GUIDE.md` — コード改修手順・テスト実行・spec 作成規約
   - `docs/beginner/README.md` — 初見開発者向け onboarding (環境構築〜PR 作成)

## Claude Code レベル最適化ルール

各レベルの構成を変更する際は、以下の最適化を毎回実施する:

- **CLAUDE.md**: 150行以内を維持。詳細手順は Skills に移行し、ここにはルールの要約のみ残す
- **Skills**: 繰り返し使う作業手順を配置。CLAUDE.md と重複する詳細は Skills 側に集約
- **Hooks**: 自動化可能な品質チェックを追加。手動で繰り返している作業があれば Hook 化を検討
- **Agents**: 独立して並行実行できるレビュー作業を配置
