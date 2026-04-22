# E2E テスト ガイド (人間向け)

> このファイルは **E2E テストが何を検証しているのか** を日本語で説明します。
> spec の仕様変更があったら本ファイルも更新してください (CLAUDE.md 第 6 項 ドキュメント最新化より)。

## テストの実行結果を確認する方法

### 1. CI (GitHub Actions)

Pull Request の画面下部に Playwright E2E ジョブが出ます。

1. PR の `Checks` タブ → `Playwright E2E + Visual Regression` をクリック
2. 下部の **Artifacts** セクション から 2 つダウンロード:
   - `playwright-report-<run_id>` ... HTML レポート (最も強力)
   - `playwright-test-results-<run_id>` ... 生のスクリーンショット / video / trace / 節目 snapshot

### 2. HTML レポート (1 番目の Artifact) の見方

`playwright-report-<run_id>.zip` を解凍し `index.html` をブラウザで開く。

各 test ごとに以下が確認可能:

| 機能 | 説明 |
|---|---|
| **Trace viewer** | 各 action 毎に before / after の DOM snapshot + network + console + スクリーンショット。右上「View Trace」から起動 |
| **Screenshot** | test 終了時点の画面 |
| **Video** | test 実行の全録画 (失敗時の視聴に最も便利) |
| **Error ログ** | 失敗時のスタックトレース + Playwright の call log |

### 3. 節目スクリーンショット (2 番目の Artifact) の見方

`playwright-test-results-<run_id>.zip` の `steps/` 配下に、spec 内で明示的に呼び出した
`snapshotStep(page, label)` のキャプチャがラベル付きで並びます:

```
steps/2026-04-22T13-15-00-000Z-step-1-password-changed.png
steps/2026-04-22T13-15-02-000Z-step-2-mfa-qr-displayed.png
steps/2026-04-22T13-15-05-000Z-step-2-mfa-enabled-badge.png
...
```

各ファイルは「そのシナリオの節目で実際に画面がどう見えていたか」のスナップショットです。
コード読みが不要で、画像だけで挙動が追えるようにしています。

### 4. ローカル実行 (開発者向け)

```bash
pnpm dev &                        # 別 shell で Next.js dev を起動
pnpm test:e2e                     # 全 spec を CLI 実行
pnpm test:e2e:ui                  # Playwright UI モード (対話的)
pnpm test:e2e:update-snapshots    # 視覚回帰 baseline 更新
```

UI モード (`test:e2e:ui`) は最も人間向け: time travel デバッガで任意時点の
DOM を検査でき、失敗しなくても全 step が視覚的に追える。

---

## 各 spec の検証内容

### `e2e/specs/00-smoke.spec.ts` — ログイン画面スモーク

**目的**: CI 起動と基本描画の疎通確認。

- `/login` がマウントでき、タイトル「たすきば」「メールアドレス」「パスワード」が表示される
- 不正メールアドレスでログイン失敗 → Enumeration 対策の一般エラー文言が出る

### `e2e/specs/01-admin-and-member-setup.spec.ts` — 初期セットアップ ~ メンバー招待

**シナリオ**: 管理者が初めてシステムを使い、一般ユーザを招待してプロジェクトを閲覧させる。

| Step | 検証内容 | 主要な節目 snapshot |
|---|---|---|
| 1 | 初期 admin 初回ログイン → 強制パスワード変更 | `step-1-password-changed` |
| 2 | admin が設定画面から MFA を有効化 (TOTP) | `step-2-mfa-qr-displayed` / `step-2-mfa-enabled-badge` |
| 2b | MFA 有効化後の再ログインで `/login/mfa` を通過 | (なし) |
| 3 | admin が一般ユーザを招待 (招待メール送信) | `step-3-invitation-sent` |
| 4 | 一般ユーザが招待メールから setup-password でパスワード設定 | `step-4-setup-complete` |
| 5 | admin がプロジェクトを作成 | `step-5-project-created` |
| 6a | admin がプロジェクトメンバーに一般ユーザを追加 (API) | (なし) |
| 6b | 一般ユーザがログインしてプロジェクトを閲覧 | `step-6b-member-sees-project` |

### `e2e/specs/02-project-detail-tabs.spec.ts` — プロジェクト詳細 タブ構成

**シナリオ**: プロジェクト詳細ページの 10 タブがロールに応じて正しく表示される。

- admin で 10 タブ (概要 / 見積もり / WBS管理 / ガント / リスク一覧 / 課題一覧 / 振り返り一覧 / ナレッジ一覧 / 参考 / メンバー) が全表示
- 各タブをクリックすると Radix UI の `data-state="active"` に切替
- general member では admin 専用タブ (見積もり / メンバー) が非表示

**主要な節目 snapshot**: `project-detail-all-tabs-admin` / `project-detail-members-tab` / `project-detail-general-member-view`

### `e2e/specs/03-global-entity-lists.spec.ts` — 全横断一覧

**シナリオ**: 管理者用の全横断一覧 4 画面が開ける。

- `/risks` (全リスク)
- `/issues` (全課題)
- `/retrospectives` (全振り返り)
- `/knowledge` (全ナレッジ)

**主要な節目 snapshot**: `global-risks-list` / `global-issues-list` / `global-retrospectives-list` / `global-knowledge-list`

### `e2e/visual/auth-screens.spec.ts` — 視覚回帰 (認証画面)

**目的**: `/login` / `/reset-password` / `/setup-password` の初期状態を baseline PNG と比較し、意図せぬ UI 崩れを検出。

baseline は `e2e/**__screenshots__/` に commit。更新したい場合は `pnpm test:e2e:update-snapshots`。

---

## 新しい spec を追加するときのチェックリスト

ドキュメント読みやすさ維持のため、spec 追加時は以下を守ってください:

1. spec ファイルの先頭 JSDoc に「カバー範囲」「シナリオ」を日本語で書く
2. 主要な節目に `await snapshotStep(page, '<わかりやすいラベル>')` を入れる
3. この `README.md` に「各 spec の検証内容」として 1 節追加
4. `docs/E2E_COVERAGE.md` のカバレッジ一覧を `[x]` に更新
5. `docs/DEVELOPER_GUIDE.md §9.8` の 5 項目チェックリストを再読

## 共通ヘルパー (fixture) の索引

| ファイル | 役割 |
|---|---|
| `fixtures/run-id.ts` | 実行ごとに一意な prefix 生成、cleanup 用 |
| `fixtures/db.ts` | `ensureInitialAdmin` / `ensureGeneralUser` / `cleanupByRunId` |
| `fixtures/inbox.ts` | 招待メールの JSON 捕捉 + URL 抽出 |
| `fixtures/totp.ts` | TOTP 6 桁コード生成 |
| `fixtures/auth.ts` | `loginAsAdminWithMfa` / `loginAsGeneral` / `waitForProjectsReady` |
| `fixtures/project.ts` | `createProjectViaApi` / `addProjectMemberViaApi` |
| `fixtures/snapshot.ts` | `snapshotStep(page, label)` 節目スクリーンショット |

## 関連ドキュメント

- [docs/E2E_COVERAGE.md](../docs/E2E_COVERAGE.md) — カバレッジマニフェスト
- [docs/DEVELOPER_GUIDE.md §9](../docs/DEVELOPER_GUIDE.md) — 実行方法 / 失敗調査手順 / spec 作成規約
- [playwright.config.ts](../playwright.config.ts) — 設定
- [.github/workflows/e2e.yml](../.github/workflows/e2e.yml) — CI 設定
