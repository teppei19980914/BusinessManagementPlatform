# 後続対応 (TODO) 一覧 (Developer Guide)

本ドキュメントは、後続 PR で対応予定のタスク一覧を集約する (DEVELOPER_GUIDE.md §11)。

---

## 11. 後続対応 (TODO) 一覧 (PR #122 で追加)

> セッション内で暫定合意された未着手・延期項目を失念しないよう、本セクションに集約する。
> 着手時は該当行を削除、完了時は該当 PR 番号を記載して残すこと。

### 11.1 未着手 (優先度: 中)

| # | 項目 | 背景 / 詳細 | 起票元 |
|---|---|---|---|
| T-01 | 入力層の TZ 統合 (date-picker / date-field 系) | PR #118-#119 で描画層は `session.user.timezone` 反映済だが、`date-field-helpers.ts` / `date-field-with-actions.tsx` / `gantt-client.tsx` 等の **入力** では `new Date()` / `.getFullYear()` 等のブラウザ runtime TZ 依存 API を使用中。海外ユーザが 2026-04-24 と入力した際の UTC 変換が TZ 依存になる可能性。date-fns-tz 導入 or 軽量自前変換で解消予定 | PR #118-#119 時点で PR #121 予定 → CI 恒久対策と入れ替わりで未着手 |
| T-02 | PAT 動作確認 (`CI_TRIGGER_PAT`) | PR #121 で導入した PAT fallback が次回の baseline 更新時に正しく動作し、CI 自動再起動が効くか実地確認 | PR #121 マージ時、ユーザ指示「今後の開発で様子を見る」 |
| ~~T-03~~ | ~~**【最重要 / 外部展開前必須】** 提案エンジン (suggestion) のヒット率向上 — 仕様 + 設計を詰める~~ → **設計完了 (2026-05-01)、実装着手 (2026-05-02〜)、6月1日リリース予定**。詳細は [SUGGESTION_ENGINE_PLAN.md](./SUGGESTION_ENGINE_PLAN.md) / [REQUIREMENTS.md §13](./REQUIREMENTS.md) / [DESIGN.md §34](./DESIGN.md) / [SPECIFICATION.md §26](./SPECIFICATION.md) / 設計議論の経緯は [§5.62](#562-提案エンジン-v2-の設計議論と意思決定ログ-t-03-設計フェーズ-2026-05-01) | 2026-04-26 ユーザ明言「サービスの核心であり、外部展開時の中心機能」「弱いとサービスが刺さらない」 |
| T-04 | **【外部公開直前必須】** 視覚回帰テスト カバレッジ拡大 (現状 4 spec → 主要画面全体 + cross-browser + a11y) | **現状把握** (PR #95-#96 で導入済): `e2e/visual/` に 4 spec (auth-screens / customers-screens / dashboard-screens / settings-themes 10 テーマ) が CI 自動実行中、baseline 更新は `[gen-visual]` commit 自動化済 (`.github/workflows/e2e-visual-baseline.yml`)。**外部公開直前タスクとして拡大すべき範囲**: ① project 詳細タブ (WBS / ガント / リスク / 課題 / 振り返り / ナレッジ / ステークホルダー) の baseline 取得 — 現状 `E2E_COVERAGE.md:38-42` で `[ ]` skip、② mobile viewport (`*-chromium-mobile-linux.png`) の baseline 拡充 (PR #128 カードビュー導入分の網羅)、③ クロスブラウザ追加 (Firefox / WebKit) — 現状 chromium のみ、④ a11y 自動テスト導入 (`@axe-core/playwright`) で WCAG 違反を CI 検出。④ の導入後は CI に accessibility ゲートを追加。**着手タイミング**: UI 確定 (= 主要機能凍結) 後に一括実施。UI 変更が頻繁なうちに baseline を取ると `[gen-visual]` 再生成コストが膨張するため | 2026-04-27 ユーザ問合せ「視覚回帰テストはどうなっているか / 公開直前で有効化する認識か」に対する回答として確定。既存 4 spec は既に有効、本 T-04 は **カバレッジ拡大とクロスブラウザ + a11y** が論点 |
| T-05 | Estimate (見積もり) に添付 URL 登録 UI を追加 + 一覧表示 | API 経路 (`/api/attachments/batch` の `entityType === 'estimate'` 分岐) は対応済だが、**UI 経由の添付登録手段が無い**ため事実上未使用。`estimates-client.tsx` に `<StagedAttachmentsInput>` (作成時) + 編集 dialog 内の `<AttachmentList>` を追加し、見積一覧にも `useBatchAttachments('estimate', ...)` + `<AttachmentsCell>` を追加すれば他エンティティと parity が揃う。PR #168 で添付対応 entity 全体の一覧表示状態を網羅 grep し、estimate のみ「API 対応済 + UI 未対応」のギャップが判明 | 2026-04-27 PR #168 横展開調査時、ユーザ要望「添付できるものに関しては、一覧画面上に表示されているか影響調査し横展開を徹底」に部分対応。estimate の UI は別 PR で対応する宣言 |
| T-06 | ~~**【外部公開直前必須】** en-US 本格翻訳~~ → **PR #170/#173/#174/#175 で大半完了 (~933 hits / 30+ ファイル / 24 sections / ~813 keys × 2 locales)。`SELECTABLE_LOCALES['en-US']=true` 切替済**。残り T-17 で対応 | PR #169 → #175 で実施。完了 |
| T-17 | en-US 残 sweep — **Group 1 (ユーザ可視) 完了 / Group 2 (API error) 継続** | **2026-04-28 (本 PR) で Group 1 完了**: 全リスク/課題/振り返り page.tsx の見出し + 件数表記、admin-delete-button.tsx (3 entity) の title/aria-label/confirm/error、error.tsx の内部エラー文言、を全て t() 化 (`common.itemCount` / `common.internalError` / `common.adminDelete*` 等の共通キー追加)。**残**: API route の `throw new Error(...)` 約 30 件 (エラー時のみ HTTP body に露出、UX 影響小)、`/admin/audit-logs` 等の管理者画面文言 (一部)、個別 route の MFA / 認証エラー文言。**Group 2 着手指針**: 共通エラー (「対象が見つかりません」4 件 / 「フィルターを 1 つ以上適用」4 件 / 「権限がありません」3 件) を共通 message key に集約 → 各 route で t() 化。test ファイルの `it('...')` 説明文 ~56 件は翻訳不要 (ユーザ非表示) のため対象外 | 2026-04-28 ユーザ要望「残りの英語化対応は今度実施」、Group 1 完了は本 PR |
| T-18 | **【UX 統一 / 後続】** Cross-list 横ぐしコメント機能 + 通知システム | PR #177 で振り返りコメント UI を非表示化したが、API/DB/service は温存中。再有効化時の方針: 振り返り固有の inline コメントではなく、**全 entity 横断で統一仕様**「リスク/課題/振り返り/ナレッジ + メモに対して関係者がコメント可能、コメント時に対象 entity の作成者 / 担当者に通知 (in-app + email)」を実装する。**設計検討項目**: (1) 単一 `comments` テーブル + `entity_type` / `entity_id` 多態的参照 vs 既存 `retrospective_comments` を踏襲, (2) 通知 channel 設計 (Notification entity + 未読管理), (3) UI: 各 ○○ 詳細画面の右パネル / カード内 inline / 全リスト画面横ぐしビューのいずれを最終形にするか。**着手目安**: 各 entity 仕様 (T-04 視覚回帰 / T-15/T-16 横断画面など) が揃った後 | 2026-04-28 ユーザ要望「振り返りのコメント機能は今後強化する予定 / 各○○一覧で横ぐしに実現したい / コメントがされたら通知される仕組み」を踏まえ、PR #177 で UI 非表示化と同時に T-18 として登録 |
| ~~T-19~~ | ~~WBS エクスポート/インポート schema 整合化 (PR-ζ follow-up)~~ → **完了** (2026-04-28、本 PR)。**仕様微調整**: 当初「6 列」だったが、ID 空欄の新規作成行で階層位置 (parent) が解決できないことが判明したため `level` 1 列を追加し **7 列** で確定 (ID/種別/名称/レベル/予定開始日/予定終了日/予定工数)。担当者/優先度/マイルストーン/備考/WBS 番号/進捗系列は CSV 経由で扱わず UI 個別編集に集約する運用に変更。実装内容: (1) `task.service.ts` の `exportWbs` を 7 列出力 + BOM 付き UTF-8 に統一、(2) `task-sync-import.service.ts` の `parseSyncImportCsv` / `computeSyncDiff` / `applySyncImport` を 7 列対応に refactor (担当者 lookup と進捗系警告を廃止)、(3) 旧 template mode (`exportWbsTemplate(mode='template')` / `parseCsvTemplate` / `validateWbsTemplate` / `importWbsTemplate` / `/api/tasks/import` route / `wbsTemplateSchema`) を完全削除、(4) tasks-client.tsx の `_handleExport_unused` と eslint-disable 領域を削除し `handleWbsExport` に集約 | 2026-04-28 PR-ζ で UI 統合のみ実施、schema 整合は本 PR で完了 |
| ~~T-21~~ | ~~アカウント永続ロック実装 (PR-η 調査結果のバグ修正)~~ → **完了** (2026-04-28、本 PR)。§5.29 選択肢 A に従い実装。**変更点**: (1) schema に `temporaryLockCount Int default(0)` 列追加 + migration `20260428_user_temporary_lock_count`、(2) `src/config/security.ts` に `PERMANENT_LOCK_THRESHOLD = 3` 定数追加、(3) `auth.ts`: 一時ロック発生時に `temporaryLockCount` インクリメント、`>= 3` で `permanentLock=true` 自動セット、ログイン成功時には `temporaryLockCount` も 0 にリセット、(4) `unlockAccount` (admin 解除) でも `temporaryLockCount=0` を含める、(5) UserDTO に `temporaryLockCount` 露出 (admin 画面の検証用)、(6) UI コメントを実装と同期、(7) auth_event_logs の `lock` イベント detail に `lockType: 'temporary' \| 'permanent'` + `temporaryLockCount` を記録。**本番適用**: Supabase SQL Editor で `pnpm migrate:print 20260428_user_temporary_lock_count` の SQL を手動実行 (E2E §4.44 教訓適用) | 2026-04-28 PR-η 調査結果、ユーザ要望「ロック情報の数字検証」 |
| ~~T-22~~ | ~~**【重要 / Phase 22a/b/c/d 分割】** 「○○一覧」へのインポート/エクスポート機能の本格実装 (項目 1)~~ → **完了** (2026-04-28、本セッション)。Phase 22a/b/c/d 全実装。**新設**: `src/components/dialogs/entity-sync-import-dialog.tsx` (汎用 component、apiBasePath / i18nNamespace を prop で受ける) + 各 entity の `*-sync-import.service.ts` 4 件 + sync-import / export route 8 件。**列構成**: risks 16 列 / retrospectives 13 列 / knowledge 14 列 (tags 系はセミコロン区切り) / memos 4 列。memos のみ user-scoped (project 紐付けなし、self only 認可)。Phase 22a で確立した汎用 component を 22b/c/d で **完全機械流用**。**規模**: 全体 ~3,800 insertions | 2026-04-28 ユーザ要望「インポート/エクスポート機能を追加」。本日 §5.31 で枠数固定要件の事前検証を確立し T-22 設計を強化、Phase 22a の汎用 component 化により 22b/c/d は機械流用で実装完了 |
| T-25 | **【調査要】** 「全顧客管理」ナビタブクリックで別 Window 起動する象 (Phase B 要件 14 で保留) | **症状**: 画面上部の「全顧客管理」タブをクリックすると別 Window で /customers が開く (他のナビタブは同タブ遷移)。**コード調査結果**: `src/components/dashboard-header.tsx` の nav リンクは全て `<Link>` (next/link) 統一、`target="_blank"` の hardcode なし、`<Menu.Item render={<Link href={...} />}>` の dropdown パターンも customers のみ別動作になる要素なし。**仮説**: (1) @base-ui/react v1.4.0 Menu.Item の rendering が admin-only flag のある link でのみ別挙動 / (2) ブラウザ拡張機能の干渉 / (3) ユーザの環境固有 (Cmd/Ctrl+クリック誤発火)。**着手手順**: 実機で再現、Chrome DevTools の Network panel で navigation type を確認、再現後に修正。**保留理由**: Phase B では再現環境がないため修正できず、誤った defensive 修正を加えるリスクの方が大きい | 2026-04-28 ユーザ要望、Phase B で再現できず保留 |
| T-23 | **【期限: 2026-05 中】** Dependabot 全自動化 (脆弱性修正の PR 自動生成 + patch 自動マージ) | **背景**: 2026-04-28 PR #184 マージ後の `git push` で「3 moderate vulnerabilities (postcss / hono / @hono/node-server)」が GitHub から通知。現状は通知のみで **PR 自動生成・自動マージは未設定**。**実装内容**: (1) `.github/dependabot.yml` 新設で npm パッケージ更新 PR を週次自動生成、patch update は単一 PR にグルーピング、(2) `.github/workflows/dependabot-auto-merge.yml` 新設で **patch update のみ CI green 後に auto-merge** (minor/major は手動レビュー継続)、(3) branch protection で CI 必須を改めて確認、(4) 試験運用: 最初 1 週間は PR 自動生成のみで品質確認、問題なければ auto-merge を有効化。**自動化で防げる範囲**: GitHub Advisory DB 登録済の既知脆弱性 (大半のケース)。**防げない範囲**: 0-day / supply chain attack (別途 `npm audit signatures` 等で補完)。**期限根拠**: 現状の 3 moderate は緊急性なしだが (postcss は build-time 限定、hono 系は未使用 transitive)、放置すると蓄積するため 5 月内に仕組み化 | 2026-04-28 ユーザ指示「セキュリティアラート対応は 5 月中に実施しプランに追記」 |

### 11.2 低優先 (長期案件)

| # | 項目 | 背景 / 詳細 | 起票元 |
|---|---|---|---|
| T-10 | ~~UI 文字列の英訳 (en-US 有効化)~~ → **PR #169 で Phase B 完了 (en-US.json 雛形 + request.ts session 連携 + 抽出スクリプト)。本格翻訳は §11.1 T-06 に昇格して進捗管理** | PR #120 時点で記録、PR #169 (2026-04-27) で基盤完了に伴い T-06 へ昇格・本項は履歴として残置 |
| T-11 | 本番 build での `console.*` 自動削除 (SWC `removeConsole`) | `next.config.ts` に `compiler: { removeConsole: { exclude: ['error', 'warn'] } }` 追加で可。現状 ESLint の `no-console` でソース混入は防げているが、本番バンドルでも保険として削除したい | PR #122 時点、SPECIFICATION §25.5 で限界として明示 |
| T-12 | ソースマップ本番非公開の明示宣言 | 現状 Next.js の既定動作で本番ソースマップは生成されないが、`productionBrowserSourceMaps: false` を `next.config.ts` に明示宣言しておくと将来の誤変更防止になる | PR #122 時点 |
| T-13 | `/api/settings/i18n` の E2E 実カバー | PR #119 で `[ ] skip` で manifest 登録済。単体テスト 8 ケースで主要観点はカバー済だが、設定画面からの反映確認は未 E2E | PR #119 時点 |
| T-14 | `system_error_logs` の自動削除バッチ | 1 ヶ月経過ログの退避 or 物理削除を cron で自動化 (OPERATION §13.1 で言及) | PR #122 時点 |
| T-24 | **`audit_logs` の自動アーカイブ/削除バッチ** (容量対策) | 2026-04-28 時点で audit_logs は **1.2 MB と DB 内最大テーブル** (Free tier 500 MB の 0.24% を単独で消費)。ユーザ操作回数に比例して **線形増加** するため、放置すると将来的に容量を圧迫する。**実装内容**: (1) Vercel Cron で日次実行する `/api/admin/audit-logs/cleanup` 新設、(2) 経過期間 (例: 1 年) を超えた audit_logs を物理削除、(3) 法定保存期間が必要な場合は archive 先 (S3 / 別 DB) に退避してから削除、(4) `OPERATION.md §13` に運用手順を追記。**T-14 と同パターン** (system_error_logs 自動削除と一体化検討)。**着手目安**: 外部公開時 (= ユーザ増のタイミング) までに実装。現状容量は Free tier の 2.97% (15 MB / 500 MB) で急務ではないが、external user の audit log が積み上がる前に仕組み化しておくのが現実的 | 2026-04-28 ユーザ要望「audit_logs の自動アーカイブ/削除バッチをプランに登録」、容量確認の結果 audit_logs が最大であることを受けて起票 |
| T-15 | 全見積もり 横断画面 (`/estimates`) | プロジェクト横断で見積を一覧・比較する画面。route 実装後、ナビ「プロジェクト」プルダウンに追加 (SPECIFICATION §20.4) | PR #127 時点 |
| T-16 | 全 WBS 横断画面 (`/wbs`) | プロジェクト横断で WBS (タスク階層) を俯瞰する画面。同上 | PR #127 時点 |

### 11.3 期限付き (管理必須)

| # | 項目 | 期限 | 内容 |
|---|---|---|---|
| T-20 | `CI_TRIGGER_PAT` ローテーション | **2027/04/24 失効** | 期限 30 日前を目安に fine-grained PAT 再発行 (repo: `BusinessManagementPlatform` only, `Contents: Read and write`, 1 年期限) → Repo Settings → Secrets の `CI_TRIGGER_PAT` を上書き。失効しても fallback で GITHUB_TOKEN に戻るだけで壊れないが、baseline auto-commit 後の CI 自動再起動が効かなくなる (§9.6 参照)。PR #121 時点で `/schedule` による自動リマインド Agent 登録は保留 |

### 運用ルール

- 新規発見の TODO は対応 PR を切る前に本セクションへ記入
- 着手 PR で「T-XX 完了 (PR #XXX)」を commit message に含める
- 半期に 1 回、本セクションの棚卸しを行い不要化した項目を削除

---

