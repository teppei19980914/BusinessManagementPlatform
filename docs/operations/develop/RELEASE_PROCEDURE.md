# リリース手順 (Release Procedure)

> **このドキュメントの位置付け**: 新バージョン (SemVer の MAJOR / MINOR / PATCH) をリリースする際の手順と、リリース前に必ず更新する真値ファイルの索引。
>
> 日常の機能 PR (= 個別の `feat:` / `fix:`) を main にマージするだけのフローは [docs/developer-guide/COMMIT_AND_DEPLOY.md](./COMMIT_AND_DEPLOY.md) を参照。本書は「ユーザに告知して公開する単位 = リリース」を対象とする。

---

## 1. リリース時に更新する真値ファイル一覧

公開ページ (`/changelog` / `/announcements`) は本ファイル群を真値として描画される。**リリースのたびに以下を必ず確認**すること。

| # | 真値ファイル / 設定値 | 反映先 (公開 UI) | 説明 |
|---|---|---|---|
| 1 | [`CHANGELOG.md`](../../../CHANGELOG.md) (リポジトリ root) | `/changelog` 公開ページ (ヘッダ AccountMenu「バージョンアップ情報」から到達) | Keep a Changelog 1.1.0 形式。SemVer の各バージョンに「追加 / 変更 / 修正 / 削除」を記載。**★root 固定 (移動不可)★**: `src/lib/changelog.ts` が `resolve(process.cwd(), 'CHANGELOG.md')` で読み、`next.config` の `outputFileTracingIncludes` で standalone bundle に同梱している。docs/ 配下へ移すと `/changelog` `/announcements` が 500 になるため、`README.md` / `CONTRIBUTING.md` と同様 **repo root の規約ファイルとして据置** |
| 2 | [`docs/public/announcements/{YYYY-MM-DD}-{slug}.md`](../../public/announcements/) | `/announcements` 一覧 + `/announcements/{slug}` 詳細 (フッタ「お知らせ」はログイン後のみ導線) | 個別お知らせの markdown ファイル。frontmatter (`title`, `publishedAt`, `severity`, `summary`) + 本文 |
| 3 | [`package.json`](../../../package.json) の `version` | `/changelog` の「現在のバージョン」。**フッタ表示には影響しない** (ADR-0031 でフッタからバージョン描画を撤去済) | SemVer (`MAJOR.MINOR.PATCH`) を bump |
| 4 | `NEXT_PUBLIC_RELEASE_DATE` 環境変数 (Netlify Site settings) | `/changelog` 等のリリース日表示。**フッタ表示には影響しない** (ADR-0031 でフッタから「最終更新」を撤去済) | ISO-8601 (`YYYY-MM-DD`)。未設定時の fallback は [`src/lib/app-version.ts`](../../../src/lib/app-version.ts) の `FALLBACK_RELEASE_DATE` |
| 5 | [`src/config/operator.ts`](../../../src/config/operator.ts) | **現在フッタ未参照 / `/settings/about` 廃止** (ADR-0031)。運営者情報は LP `#operator-info` に集約済。本ファイルは [`legal-versions.ts`](../../../src/config/legal-versions.ts) 経由で参照される単一真値として温存 (削除しない) | 運営者氏名 / 表示ラベル / 連絡先 URL。改姓・改名・問い合わせ口変更時のみ |
| 6 | [`src/config/legal-versions.ts`](../../../src/config/legal-versions.ts) | フッタ共通情報リンク (製品ページ / 利用規約 / プライバシー / 運営者情報 / 特商法 / セキュリティ報告) → すべて LP の各アンカーへ集約 | LP 側 anchor URL (`TERMS_URL` / `PRIVACY_URL` / `OPERATOR_INFO_URL` / `TOKUSHOHO_URL` / `SECURITY_REPORT_URL` 等)。法的書面の改定時に更新 |

> **フッタ仕様の変遷 (ADR-0031 / 2026-05-31 改訂)**: 旧フッタには「サービス名 / 運営者 / 更新履歴 / 利用規約 / プライバシー / お問い合わせ」が直接並んでいた (2026-05-24 改訂で `/settings/about` へ一旦集約)。ADR-0031 で **フッタは copyright / 最終更新日 / バージョン / `/settings/about` リンクを描画しない**方針へ再編。共通情報 (製品ページ / 利用規約 / プライバシー / 運営者情報 / 特商法) は外部 LP の各アンカーに集約し、ログイン後のみ「お知らせ (`/announcements`)」と「セキュリティ報告 (LP `#security`)」を追加表示する (認証状態で出し分け)。`/settings/about` ページは廃止し、バージョン / 更新履歴はヘッダ AccountMenu「バージョンアップ情報」→ `/changelog` に移設済。リリース時に「フッタ表示文言」を個別に編集する必要は無い。

---

## 2. リリース前手順 (Pre-Release Checklist)

### 2.1 マイナー / パッチリリース (例: v1.0.0 → v1.0.1 / v1.1.0)

通常の機能 PR / 修正 PR を main にマージし続けてから、リリース判断時にまとめて以下を実施。

- [ ] **(1) `CHANGELOG.md` に新エントリ追記** — 最新セクション (`## [Unreleased]` or 直接 `## [X.Y.Z] — YYYY-MM-DD`) に「追加 / 変更 / 修正 / 削除」をカテゴリ別に記載
  - 文体: 「ユーザにとってどう変わったか」を主眼に。PR 番号は末尾に `(#NNN)` で参照
  - 内部リファクタ / テスト追加のみは「変更」扱いにせず省略可 (ユーザ無関係なため)
- [ ] **(2) `package.json` の `version` を SemVer で bump**
  - MAJOR: 後方非互換変更 (= 既存 URL / API / DB 仕様の破壊)
  - MINOR: 後方互換の機能追加
  - PATCH: 後方互換のバグ修正のみ
- [ ] **(3) `NEXT_PUBLIC_RELEASE_DATE` を Netlify Site settings で当日 (`YYYY-MM-DD`) に更新**
  - 反映には Netlify 再 deploy が必要 (mainマージで自動 trigger される)
- [ ] **(4) `/announcements` への告知が必要なら markdown ファイルを新規作成** — `docs/public/announcements/{YYYY-MM-DD}-{slug}.md`
  - frontmatter の `severity` は内容に応じて: `info` (新機能告知) / `warning` (注意喚起) / `critical` (緊急) / `maintenance` (メンテ予告)
  - **bug fix のみのパッチリリースは告知不要** (ユーザ体験への影響が無い場合)
- [ ] **(5) ローカルゲート確認** — `pnpm lint && pnpm tsc --noEmit && pnpm test && pnpm e2e:coverage-check && pnpm build`
- [ ] **(6) PR 作成 → CI 通過** — CI には **🤖 機能受け入れ回帰 (E2E)** が含まれる: 払い出し→全資産CRUD→解約→eligibility→チャット/ヘルプ配線 (`e2e/specs/19〜23`、[RELEASE_ACCEPTANCE_TEST.md](../../test/RELEASE_ACCEPTANCE_TEST.md) の 🤖 項目)。E2E が red の場合は merge しない
- [ ] **(6.5) 👤 Deploy Preview で機能受け入れスモーク (数分・マージ判断)** — `deploy-preview-<PR番号>--tasukiba.netlify.app` で [RELEASE_ACCEPTANCE_TEST.md §9](../../test/RELEASE_ACCEPTANCE_TEST.md#9-数分の人間スモーク-毎リリース必須) の **SMK-1〜7** を実施。Deploy Preview は**実外部サービス + ステージング DB** 接続のため、実メール到達・実 Storage 添付・実 AI 品質を**本番 DB を汚さず**検証できる。FAIL なら merge しない
- [ ] **(6.6) squash merge**
- [ ] **(7) Netlify Production deploy 成功確認** ([COMMIT_AND_DEPLOY.md §10.5 squash merge 時の skip キーワード罠](./COMMIT_AND_DEPLOY.md))
- [ ] **(7.5) 👤 本番で最終確認 (軽量・本番固有の差分のみ)** — 本番 `tasukiba.netlify.app` で SMK-2 (ログイン/Cookie)・SMK-7 (主要画面レンダリング) + 任意で実メール 1 通。Deploy Preview と本番は `NEXTAUTH_URL`/ドメイン/CONTEXT が異なり Cookie/認証・本番レンダリングは本番でしか確認できないため (破壊的操作は不要)。FAIL があれば原則ロールバック判断
- [ ] **(8) `/changelog` を本番で開き (ヘッダ AccountMenu「バージョンアップ情報」経由)、バージョン番号とリリース日が反映されていることを確認**
- [ ] **(9) `/changelog` `/announcements` を本番で開き、新エントリが表示されることを確認** (`/announcements` はフッタ「お知らせ」リンク = ログイン後のみ導線)

### 2.2 メジャーリリース (例: v0.x → v1.0.0)

上記 2.1 に加えて:

- [ ] **[RELEASE_ACCEPTANCE_TEST.md](../../test/RELEASE_ACCEPTANCE_TEST.md) のフル完走** (§1〜§8) — メジャーリリース、または signup・課金・資産経路を触ったリリースでは、数分スモーク (§9) ではなくフルの受け入れテストを完走し go/no-go を判定する
- [ ] [`docs/operations/PUBLIC_LAUNCH_CHECKLIST.md`](../../archive/2026-06-01-pre-ops-reorg/PUBLIC_LAUNCH_CHECKLIST.md) の全項目を完了
- [ ] [`docs/operations/GO_LIVE_RUNBOOK.md`](../../archive/2026-06-01-pre-ops-reorg/GO_LIVE_RUNBOOK.md) の T-2 週間前 / T-1 週間前 / 当日 のタイムラインを実施
- [ ] OG 画像 (`public/og-image.png`) の差し替え判断
- [ ] 利用規約 / プライバシーポリシー (LP 側) の改定確認
- [ ] [`docs/operations/RELEASE_NOTES_v1.md`](../../archive/2026-06-01-pre-ops-reorg/RELEASE_NOTES_v1.md) 相当のリリースノート (PDF 配布等が必要な場合のみ)

---

## 3. お知らせの severity 使い分けと UX 影響

`/announcements/{slug}.md` の frontmatter `severity` は、お知らせ一覧画面 (`/announcements`) でのバッジ色に影響する (旧 AppHeader 下部バナーは 2026-05-24 削除済のため、現在は一覧/詳細のみへの影響)。

| severity | 用途 | 一覧バッジ |
|---|---|---|
| `info` (既定) | 新機能告知 / リリースアナウンス | muted (目立たない) |
| `warning` | 既知の問題 / 一部機能の制限 | amber |
| `critical` | サービス停止級の障害 / セキュリティ告知 | destructive (赤) |
| `maintenance` | メンテナンス予告 | sky (青) |

**critical 告知が必要なインシデント時**は [`docs/operations/INCIDENT_RESPONSE.md`](../operate/INCIDENT_RESPONSE.md) も合わせて参照。

---

## 4. CHANGELOG.md 編集の罠 (チェックリスト形式)

- [ ] 日付は **リリース確定日** (= 本番デプロイ完了日) を書く。PR マージ日ではない
- [ ] バージョン番号は `package.json.version` と一致させる (片方だけ変えない)
- [ ] エントリは Keep a Changelog のカテゴリ (`### 追加 / 変更 / 修正 / 削除`) を守る — `/changelog` ページはこの見出し階層で render されるため、独自カテゴリは表示が崩れる
- [ ] **削除した機能** は必ず「削除」セクションに明記 — ユーザの「あの機能どこ?」問い合わせ削減に直結する

---

## 5. お知らせ markdown 編集の罠

- [ ] ファイル名は `{YYYY-MM-DD}-{slug}.md` 形式厳守 — URL の slug と公開日抽出に使われる ([src/lib/announcements.ts](../../../src/lib/announcements.ts) の正規表現で検証)
- [ ] `publishedAt` は frontmatter と filename 先頭を一致させる (filename からも抽出されるが二重定義時は frontmatter 優先)
- [ ] 本文中の内部リンクは必ず本番 URL に解決可能な絶対 path (`/projects/...`) — 相対 path は `/announcements/{slug}` 配下に解釈される
- [ ] `severity=critical` を使う場合は SOC / 開発者責任者にも別途共有 — UI 上の赤バッジだけでユーザに知らせるのは不十分

---

## 6. 関連ドキュメント

- [docs/test/RELEASE_ACCEPTANCE_TEST.md](../../test/RELEASE_ACCEPTANCE_TEST.md) — 機能受け入れテスト (払い出し→全資産CRUD→主要機能→解約のライフサイクル)。🤖 自動 E2E (毎 CI) + 👤 本番数分スモーク (§9、毎リリース) の 2 層。本書 §2.1 (6)(7.5) / §2.2 から参照
- [docs/developer-guide/COMMIT_AND_DEPLOY.md](./COMMIT_AND_DEPLOY.md) — 日常コミット・デプロイのワークフロー
- [docs/operations/PUBLIC_LAUNCH_CHECKLIST.md](../../archive/2026-06-01-pre-ops-reorg/PUBLIC_LAUNCH_CHECKLIST.md) — 一般公開前の包括チェックリスト
- [docs/operations/GO_LIVE_RUNBOOK.md](../../archive/2026-06-01-pre-ops-reorg/GO_LIVE_RUNBOOK.md) — 2026-06-01 GA リリースの当日進行
- [docs/operations/DEPLOYMENT.md](./DEPLOYMENT.md) — Netlify deploy / skip キーワード / ロールバック手順
- [docs/operations/INCIDENT_RESPONSE.md](../operate/INCIDENT_RESPONSE.md) — critical 告知時の社内手順
- [CONTRIBUTING.md](../../../CONTRIBUTING.md) — コード変更全般のレビュー観点とコミット規約

---

## 改訂履歴

| 日付 | 変更 |
|---|---|
| 2026-05-24 | 初版作成 (PR #439 / feat/app-header-footer-unification: 全画面共通フッタ削減により真値ファイルの集約場所が明確化されたため、リリース手順を独立ドキュメント化) |
| 2026-06 | 機能受け入れゲートを統合 (test/release-acceptance-e2e): §2.1 (6) に 🤖 E2E 回帰注記 + (7.5) 本番 👤 数分スモークを追加 / §2.2 にフル完走を追加 / RELEASE_ACCEPTANCE_TEST.md を §6 関連ドキュメントに追加。粒度 = 🤖毎CI / 👤数分毎リリース / フルはメジャー or 主要経路変更時 |
