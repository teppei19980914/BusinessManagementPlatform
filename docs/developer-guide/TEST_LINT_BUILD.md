# テスト・lint・build 実行ガイド (Developer Guide)

本ドキュメントは、開発時のテスト・lint・build 実行方法を集約する (DEVELOPER_GUIDE.md §9)。テスト戦略は [../test/STRATEGY.md](../test/STRATEGY.md) を参照。

---

## 9. テスト・lint・build の実行

```bash
# 単体テスト (vitest)
pnpm test

# テストをウォッチモードで
pnpm test:watch

# 単体テスト + カバレッジ計測 (PR #83 で追加)
#   coverage/coverage-summary.json / lcov.info / HTML レポート (coverage/lcov-report/index.html)
#   を出力する。HTML を開けば行単位で未到達箇所を確認可能。
pnpm test --coverage

# Lint (eslint)
pnpm lint

# ビルド検証 (型エラー / Next.js ビルドエラーを検出)
pnpm build
```

**コミット前に最低限すべて通ること**。Stop hook で自動検査されます。

### 9.1 CI のカバレッジレポート (PR #83)

GitHub Actions CI は `pnpm test --coverage` を実行し、`davelosert/vitest-coverage-report-action@v2`
経由で **PR コメントにカバレッジ要約・変更ファイル別カバレッジ・変更行カバレッジ** を
自動投稿する。外部サービス (Codecov 等) 連携なしで GitHub 完結。

- 対象計測範囲: `src/lib/**` / `src/services/**` (`vitest.config.ts` の `coverage.include` で指定)
- レポーター: `text` / `lcov` / `json` / `json-summary` (action 必須の 2 つを含む)
- CI 実行は `main` への push / PR でトリガー (PR コメントは PR 時のみ)

### 9.2 カバレッジ閾値 80% (PR #84)

`vitest.config.ts` の `thresholds` で **Lines / Statements / Functions: 80%**、
**Branches: 70%** を常時強制する。これを下回る変更は CI (`pnpm test`) が失敗し
マージできない。

**計測対象外 (coverage.exclude)** — 単体テストで検証するのが困難なため除外:

| ファイル | 除外理由 |
|---|---|
| `src/lib/auth.config.ts` / `src/lib/auth.ts` | next-auth provider 配線 (integration test 領域) |
| `src/lib/use-lazy-fetch.ts` / `src/lib/use-session-state.ts` | React クライアントフック (要 RTL) |
| `src/lib/db.ts` | PrismaClient のインスタンス化のみ |
| `src/lib/search/pg-trgm-provider.ts` | 実 PostgreSQL (pg_trgm 拡張) 接続が必要 |
| `src/lib/mail/resend-provider.ts` | 外部メール送信 API アダプタ (本物の Resend 必要) |
| `**/*.test.ts`, `**/*.d.ts` | テスト本体・型定義 |

**閾値を下げたい場合**の運用:
1. 原則として **テストを追加して充足させる** (除外を増やさない)
2. どうしても単体テストで検証不可能なファイルが増えた場合のみ `coverage.exclude` に
   追加し、Why をコメントで残す
3. `thresholds.branches` を 70% 未満にする変更は事前に DESIGN.md で合意を取る

### 9.3 Security Workflow 攻撃種別マトリクス (PR #84)

[.github/workflows/security.yml](../../.github/workflows/security.yml) の最後に
`attack-matrix` job があり、GitHub Actions の **Job Summary** に以下のような
攻撃種別マトリクスを日本語で自動出力する:

| 状況 | 攻撃種別 (Attack) | 主な検証手段 |
|:---:|---|---|
| ✅ | 機密情報漏洩 (Secrets Exposure, CWE-798) | gitleaks |
| ✅ | SQL インジェクション (SQL Injection, CWE-89) | Semgrep / CodeQL + Prisma ORM |
| ✅ | 認可バイパス / IDOR (Authorization Bypass, CWE-639) | CodeQL + checkProjectPermission |
| ... | ... | ... |

- テンプレートは [.github/attack-matrix-summary.md](../../.github/attack-matrix-summary.md)
- ワークフロー側で `sed` による `@@FOO@@` プレースホルダ置換で実スキャン結果を埋め込む
- **行を追加/編集したいとき**: `.github/attack-matrix-summary.md` を直接編集する。
  `to_mark` / `or_mark` で使えるステータストークン (`@@GITLEAKS@@` / `@@AUDIT@@` /
  `@@SAST@@` / `@@CODEQL@@`) は security.yml の `sed` で定義済み。新しい検証手段を
  増やす場合は security.yml にも変数を追加する。

### 9.3.5 E2E 実装で得られた知見 (PR #90 以降累積)

新しい E2E spec を書く前 / CI で E2E が赤になった時は、まず
**[docs/E2E_LESSONS_LEARNED.md](./E2E_LESSONS_LEARNED.md)** を一読する。
PR #90 以降の hotfix から得た **40 個超の罠パターン** (§4.1〜§4.40) と
**アサーション戦略**が集約されている。

### 9.3.6 Click 後の navigation 完了待機: 3 つの race パターンと使い分け (PR #154 で整理)

E2E spec で「click → URL 遷移 → 遷移後 DOM を expect」という流れを書くとき、
**click() の resolve タイミングと UI 遷移完了タイミングの race** に踏み込みやすい。
本プロジェクトでは PR #114 / #144 / #154 で踏み抜いた 3 つの race パターンが整理されている。
それぞれ性質が異なるため**修正方法も異なる**。新規 spec を書くときは下記マトリクスで
適切なパターンを選ぶこと。

| # | パターン | 症状 | 原因 | 修正方法 | 関連 LESSONS |
|---|---|---|---|---|---|
| 1 | **router.refresh() race** | mutation 後の一覧再取得が間に合わず古い行が残る | `router.refresh()` は **fire-and-forget** で await できない | mutation 完了後に `await page.reload({ waitUntil: 'networkidle' })` で確定 | §4.20 / §4.33 |
| 2 | **長い click chain race** | API mutation を伴う click の後に複数 await が連なって不安定 | 各 await の間に Server Action / refetch が走り、状態が漂流 | click 前に `page.waitForResponse(...)` を**予約**してから click → response を await | §4.19 |
| 3 | **Next.js Link click race** | `getByRole('link').click()` 直後の `waitForLoadState('networkidle')` が **0ms で即 resolve** し、navigation 未開始の古いページで expect が timeout | client-side navigation は **イベントループ非同期** のため click() resolve 直後はまだ network 層に request が出ていない | `Promise.all([page.waitForURL(/regex/), link.click()])` で navigation 完了を確実に anchor | §4.40 (PR #154) |

**判別フロー** (どのパターンか見分けるための質問):

```text
Q1: その click は URL 遷移を起こすか?
  YES → Q2 へ
  NO (= 同一 URL の状態変化のみ) → ① router.refresh race を疑う

Q2: 遷移は <Link> による client-side navigation か (vs <a href> や form submit)?
  YES → ③ Next.js Link click race パターン
  NO  → 通常の navigation。waitForLoadState で十分なことが多い

Q3: click 後に複数の API 呼び出しを伴う複雑な flow か?
  YES → ② 長い click chain race も併発しうる。waitForResponse で API ごとに区切る
```

**コード例**:

```ts
// ❌ アンチパターン (3 つすべての race を踏みうる)
await page.getByRole('link', { name: '...' }).first().click();
await page.waitForLoadState('networkidle');  // 0ms 即 resolve のリスク
await expect(page.getByRole('heading', { name: '...' })).toBeVisible();

// ✅ Pattern 3 (Link click race を回避)
await Promise.all([
  page.waitForURL(/\/customers\/[a-f0-9-]+/),
  page.getByRole('link', { name: '...' }).first().click(),
]);
await expect(page.getByRole('heading', { name: '...' })).toBeVisible();

// ✅ Pattern 2 (API 経由 mutation の後に DOM 検証)
const apiResponse = page.waitForResponse(
  (r) => r.url().endsWith('/api/customers') && r.request().method() === 'POST',
);
await page.getByRole('button', { name: '登録' }).click();
await apiResponse;
await page.reload({ waitUntil: 'networkidle' });  // Pattern 1 (router.refresh) もケア
await expect(page.locator('tbody tr').filter({ hasText: '...' })).toBeVisible();
```

**新規 spec 作成時のチェックリスト**:

- [ ] click() が URL 遷移を起こすなら **`Promise.all([waitForURL, click])`** を使う (Pattern 3)
- [ ] mutation 系 click は **`waitForResponse`** で API 完了を anchor (Pattern 2)
- [ ] mutation 後に画面再描画を期待するなら **`page.reload`** で router.refresh race を確定 (Pattern 1)
- [ ] `waitForLoadState('networkidle')` 単独使用は **0ms 即 resolve のリスク** がある
       (currently in-flight = 0 を満たすだけで navigation 完了を保証しない) → 補助手段として使う

**関連**:
- [E2E_LESSONS_LEARNED.md §4.20](./E2E_LESSONS_LEARNED.md) — router.refresh race の詳細
- [E2E_LESSONS_LEARNED.md §4.19](./E2E_LESSONS_LEARNED.md) — 長い click chain race の詳細
- [E2E_LESSONS_LEARNED.md §4.40](./E2E_LESSONS_LEARNED.md) — Link click race の詳細 (PR #154)

### 9.4 E2E テスト (PR #90 で導入)

```bash
# ローカル実行 (Next.js dev 起動済みが前提)
pnpm dev &
pnpm test:e2e                       # 全 specs + visual を実行
pnpm test:e2e:ui                    # UI モードで対話的に実行
pnpm test:e2e:update-snapshots      # 視覚回帰 baseline を更新

# カバレッジ一覧の gap 検出
pnpm e2e:coverage-check
```

#### 「何のテストをしているか」の確認方法 (PR #93 hotfix 2 で整備)

1. **`e2e/README.md`** — 各 spec のシナリオを日本語で一覧化。コードを読まなくても
   全シナリオが把握できる。新しい spec を追加したら必ず更新する。
2. **Playwright HTML レポート** — CI の Artifact `playwright-report-<run_id>.zip` を
   解凍し `index.html` を開く。各 test の trace viewer で各 action 毎の
   DOM snapshot + スクリーンショット + ビデオを視覚的に追える。
3. **節目スクリーンショット** — `test-results/steps/` 配下 (Artifact
   `playwright-test-results-<run_id>.zip`) にラベル付きで保存される。
   各 spec が `await snapshotStep(page, 'step-N-what-happened')` で
   意味のある瞬間をキャプチャしている。
4. **UI モード (ローカル)** — `pnpm test:e2e:ui` で Playwright の対話モードが起動。
   time travel デバッガで任意時点の DOM を検査でき、成功したテストも
   action 単位で追える。人間による目視確認に最適。

PR #93 hotfix 2 で `playwright.config.ts` の `trace` / `screenshot` / `video` を
全て `'on'` に変更し、成功・失敗を問わず記録する方針にした (Artifact 肥大化は
14 日保持で吸収)。

### 9.5 新機能追加時の E2E カバレッジ横展開 (必須)

**新しい `page.tsx` や `route.ts` を追加したら、必ず `docs/developer/E2E_COVERAGE.md` を更新**してください。
更新がないと `ci.yml` の `e2e:coverage-check` ステップが fail し、マージできません。

更新パターン:
```markdown
# 完全に E2E カバー済
- [x] `/new-feature` — e2e/specs/04-new-feature.spec.ts

# 同一 PR 内ではカバーせず、後続 PR で追加予定
- [ ] `/new-feature` — skip: PR #XX で追加予定

# 意図的にカバー対象外
- [ ] `/admin/legacy-report` — skip: read-only / 優先度低
```

#### 9.5.1 漏れた場合の CI 連鎖 fail パターン (PR #115 で得た知見)

`E2E coverage manifest check` が fail すると、**後続の `Test (vitest + coverage)` ステップが
skip され、`coverage/coverage-summary.json` が生成されない**。その結果
`Report coverage (PR comment)` ステップが `if: always()` で走るものの、
`coverage-summary.json` が不在で ENOENT エラーとなり **2 ステップが赤で表示される**。

見かけの症状:
- Actions 一覧で `E2E coverage manifest check` と `Report coverage` の 2 ステップが ✗
- `Report coverage` の log に `Error: ENOENT: no such file or directory, open '.../coverage-summary.json'`

**真因は 1 つ**: `E2E_COVERAGE.md` に新規 `route.ts` / `page.tsx` の記載漏れ。
manifest を修正するだけで 2 つの赤ランプが同時に解消する (Report coverage は副次症状)。

デバッグ時のコツ:
1. **まず Actions 一覧の最初の ✗ を見る** — 後続の fail は大体その連鎖症状
2. `pnpm e2e:coverage-check` をローカルで実行して同じエラーが出るか確認
3. `script/check-e2e-coverage.ts` の出力にある「未記載の機能」を手動で `E2E_COVERAGE.md`
   に追記 (`[x]` / `[ ] skip: <理由>` のどちらかを選ぶ)

### 9.6 視覚回帰のベースライン運用 (PR #90 合意 → PR #96 で自動化)

視覚回帰テスト (`e2e/visual/*.spec.ts`) の baseline PNG は `e2e/**__screenshots__/` に
commit されています。**PR 中に baseline 更新を許容**する方針です (前提: リビジョンが
git 履歴に残るため監査可能)。

**baseline 生成は Linux CI 環境で自動実行** (Windows / macOS ローカルではフォント差異で
別 PNG になるため使わない):

#### トリガ方法 A: commit message タグ (PR 中の初回推奨)

`workflow_dispatch` は GitHub 仕様で **default branch (main) にファイルが存在する**
必要があり、workflow 自体を新規追加する PR では UI に表示されません。回避策として、
commit message に `[gen-visual]` タグを付けた push で自動発火します:

```bash
git commit --allow-empty -m "chore: generate visual baselines [gen-visual]"
git push
```

→ GitHub Actions で "E2E Visual Baseline" ジョブが自動起動、PNG を同 branch に
auto-commit する。push に `[gen-visual]` が無い限り発火しないので誤トリガしない。

#### トリガ方法 B: Actions UI 手動実行 (workflow 本体が main にマージ済の場合)

1. GitHub Actions UI → **"E2E Visual Baseline" workflow** を開く
2. "Run workflow" → 対象 branch を選んで実行
3. 完了後、同 branch に `Update visual baselines (workflow)` commit が auto-commit

---

いずれの方法でも、完了後 E2E ワークフローが push をトリガに自動再実行されて green になります。

**⚠️ 「CI を rerun する」だけでは baseline は生成されません**。
baseline workflow の実行 → 自動 commit → (それをトリガに) E2E CI が自動再実行、
という 2 段階の手順が必要です。

baseline を上げずに fail したままマージすると main が red になり続けるので、
**PR マージ前に必ず緑化**してください。

#### ⚠️ 罠: `GITHUB_TOKEN` による auto-commit は次の workflow を起動しない (PR #119 で遭遇)

baseline workflow の auto-commit (`Update visual baselines (workflow)` コミット)
は既定の `GITHUB_TOKEN` で push されるため、**GitHub 仕様により後続 workflow を
トリガしない** (無限ループ防止の仕様。[公式ドキュメント](https://docs.github.com/en/actions/security-guides/automatic-token-authentication#using-the-github_token-in-a-workflow)):

> When you use the repository's GITHUB_TOKEN to perform tasks, events triggered
> by the GITHUB_TOKEN will not create a new workflow run.

**症状**: PR UI の required checks が延々と "Expected — Waiting for status to
be reported" のまま変化しない。`gh run list --commit <auto-commit-SHA>` が空配列を返す。

##### 手動対処手順 (確定版、PR #120 まで毎回必要)

`[gen-visual]` push → baseline workflow が走り auto-commit された **後** に、
開発者の credentials (GITHUB_TOKEN ではない) で空コミットを push して CI を再起動する:

```bash
# 1. baseline workflow の完了を待つ (gh run watch でも可)
gh run list --branch $(git branch --show-current) --limit 5

# 2. baseline auto-commit をローカルに取り込む
git pull --ff-only

# 3. 開発者 credentials で空コミット → push → CI 起動
git commit --allow-empty -m "chore: retrigger CI after baseline update"
git push

# 4. 再起動された CI の状況確認
gh run list --commit $(git rev-parse HEAD) --limit 5
```

**検出方法** (CI が止まっているか判断):

```bash
# 最新コミットに対する workflow run が 0 件なら GITHUB_TOKEN の罠に該当
gh run list --commit $(git rev-parse origin/$(git branch --show-current)) --limit 5
```

空配列 (`[]`) が返ったら手動再起動が必要。1 件以上返れば正常に実行中 or 完了済。

##### 恒久対策: PAT fallback 構文 (PR #121 で実装済み)

PR #121 で `.github/workflows/e2e-visual-baseline.yml` に以下の fallback 構文を採用:

```yaml
token: ${{ secrets.CI_TRIGGER_PAT || secrets.GITHUB_TOKEN }}
```

- `CI_TRIGGER_PAT` が secrets に **登録されていれば** → PAT で push → **後続 CI が自動再起動** (GITHUB_TOKEN の罠回避)
- 未登録なら → 空文字列扱いで `||` により `GITHUB_TOKEN` にフォールバック → 従来動作維持 (手動再起動が必要)

**PAT 登録手順** (ユーザ側で 1 回のみ):

1. GitHub → Settings → Developer settings → **Personal access tokens → Fine-grained tokens → Generate new token**
2. 設定:
   - Repository access: `teppei19980914/BusinessManagementPlatform` のみ
   - Permissions: **Contents: Read and write**
   - Expiration: 最長 1 年 (fine-grained の上限)
3. Repo → Settings → Secrets and variables → Actions → Repository secrets → **`CI_TRIGGER_PAT`** として登録
4. 次回以降の `[gen-visual]` push で自動再起動される

**期限管理**: PAT の expiration 30 日前を目安に再発行 + secret 上書き。失効したら fallback で GITHUB_TOKEN に戻るだけ (壊れない)。

**検討済の他選択肢** (PR #121 時点で不採用):

| 選択肢 | 状態 | 理由 |
|---|---|---|
| **B. workflow_dispatch 連鎖** | 不採用 | workflow_dispatch 起動の check run が PR の required checks に紐付くか実運用検証リスクあり |
| **C. GitHub App** | 将来検討 | 個人非依存だがセットアップ工数大。MVP 段階では PAT で十分 |
| **D. 現状維持** | 不採用 (旧案) | baseline 更新ごとに手動再起動。PR #119 / #120 で 2 回連続発生 |

IDE 警告 `Context access might be invalid: CI_TRIGGER_PAT` は secrets 未登録時に出るが、
fallback 構文で保護されているため **実害なし**。登録すれば警告も消える。

#### mask テクニック (PR #96)

動的に変化するコンテンツ (RUN_ID 付きのテストデータ名等) を視覚回帰対象外にするには
`mask` オプションを使う:

```ts
await expect(page).toHaveScreenshot('projects-light.png', {
  fullPage: true,
  mask: [page.locator('tbody tr')],  // テーブル内容は RUN_ID 依存で毎回変わる
});
```

mask 対象は画像上でグレーに塗りつぶされ、pixel 比較から除外される。構造比較に集中できる。

**ただし mask の限界** (PR #96 hotfix 3 教訓 / LESSONS §4.15): 並列テスト環境で
他 spec のデータが DB に残り行数が変わると mask 領域自体が baseline とズレる。
動的データは mask ではなく **固定値で seed** するほうが確実。

#### 今後の視覚回帰運用 (PR #96 定着後)

視覚回帰はユーザ体感 UI の「見栄え回帰検知」を担うので、以下の運用サイクルで保つ。

**(1) 日常開発 (通常の PR)**

- UI に手を入れない PR → 視覚回帰は既存 baseline と比較、green で通る
- UI に手を入れた PR → 意図通りの変更なら `[gen-visual]` コミットで baseline 再生成
- 意図せぬ崩れ → コード側を修正して CI 緑化

**(2) 判断フロー (PR に視覚回帰 fail が出たとき)**

```
差分 PNG を Artifact でダウンロード → 確認
  ↓
Q1. UI 変更は PR のスコープに含まれているか?
  YES → Q2
  NO  → 回帰バグ (コード側を修正)
  ↓
Q2. 変更は意図通り (仕様を満たす) か?
  YES → [gen-visual] コミットで baseline 更新 + レビュアに PR diff で見せる
  NO  → コード側を修正
```

**(3) baseline 更新時のレビュー観点**

- diff 画像 (Actual / Expected / Diff) の 3 面が Artifact `playwright-report/` に入る
- レビュアは **「変更予告された部分だけが差分か」** を確認
- 予告外の領域に差分が出ていたら **副作用** なので差戻し

**(4) 定期メンテナンス (月 1 程度)**

- 全 baseline が最新の main の UI と一致しているか: CI 定期 run (schedule: daily) で検知
- フォント/レンダリングライブラリの更新は CI image の更新で影響が出うる
- baseline は git に残るので履歴から崩れ始めた時点を特定可能

**(5) 大規模 UI リファクタ時**

- shadcn/ui のバージョンアップや Tailwind 設定変更などで **全テーマの配色が微ズレ** する場合あり
- `[gen-visual]` で一括再生成 → PR diff で全 PNG の差分をレビュアが一通り確認
- 事前に事前共有 (スクショを Slack 等で) しておくとレビュー負担が軽い

#### 「最初の push に `[gen-visual]` を含める」運用ルール (PR #143 / PR #144 連続漏れ事例より)

UI レイアウト変更を含む PR では **最初の commit message に `[gen-visual]` を含める**
ことで E2E 失敗 → hotfix → 再 push の 1 サイクルを節約できる。

**判定条件 (どれかに該当したら最初から含める)**:
- 既存の jsx 構造 (要素追加 / 順序変更 / className 変更) に手を入れた
- 権限分岐や条件レンダリングを変えた (新しい UI 要素が表示される側のケースを生む)
- shadcn/ui コンポーネントを追加・差し替えた

**漏れた場合の連鎖**:
1. PR push → E2E が visual mismatch で fail (3〜5 分浪費)
2. 「あ、baseline 古いままだった」と気付く
3. 空 commit `[gen-visual]` を push → baseline workflow 再走 (~3 分)
4. baseline auto-commit → E2E 再走 (~5 分)

事例:
- **PR #143**: admin に状態変更 Select が新規表示 → 概要タブ baseline ズレ
- **PR #144**: 概要タブを 11 フィールド + 3 タグ列追加 → 同上 baseline ズレ

両者とも「最初から `[gen-visual]` を含めれば 1 サイクルで完了」だったが、
後追い対応で 2 サイクル消費した。

**判断のフローチャート**:

```
新規 PR を作成する直前 →
  Q: jsx の構造変更 / className 変更 / 権限緩和 / コンポーネント追加 のいずれかをしたか?
  YES → 最初の commit message に [gen-visual] を含める
  NO  → 含めない (誤発火を防ぐ意図、文書/test のみの PR では baseline 不変)
```

### 9.7 E2E テスト失敗の調査手順 (PR #90 運用メモ)

E2E が CI で失敗したとき、**ログの切り抜き画像だけでは原因を特定しにくい**ことが
多々あります (minify されたスタックトレース、同時実行中のテストが出すノイズログ等)。
以下の手順で切り分けると効率的です。

#### 調査で集める情報

1. **失敗テストと成功テストの対比** ← 最も強力な情報
   - 類似シナリオの中で **一部だけ成功している** 場合、ページ自体は動作している
   - 例: PR #90 hotfix 5 のケースでは以下で真因特定できた:
     - test 6「不正メールでログイン失敗」 ✅ PASS (912ms)
     - test 3「ログイン画面が表示される」 ❌ FAIL (5.7s)
     - → 両方 `/login` を使う。test 6 が通る = ページは正常 = 原因は test 3 の
       アサーション側 (`getByRole('heading')` が `<div>` を拾えない)

2. **Playwright HTML レポートの Artifact ダウンロード** ← 画像証拠
   - PR のチェック欄 → Actions タブ → Playwright E2E の失敗 run → Artifacts
   - `playwright-report-<run_id>.zip` をダウンロード
   - 解凍 → `index.html` をブラウザで開く
   - 各テストで:
     - 実際にキャプチャされたスクリーンショット (ページが 500 か、正常レンダリングか)
     - trace viewer (タイムラインでどの操作で stuck したか)
     - video (ブラウザ画面の録画、再現性確認)

3. **テキストベースのログ全量**
   - Actions UI の右上 **歯車 → View raw logs** で生ログ取得 (画像より情報多い)
   - 画像切り抜きでは下部の詳細や前後のコンテキストが欠落しがち

#### 原因切り分けで誤解しやすいログ

| ログ | 意味 | 実際の原因かどうか |
|---|---|---|
| `[auth][error] CredentialsSignin` | next-auth `authorize()` が null を返したときの正常な内部ログ | ❌ 多くの場合ノイズ (意図的にログイン失敗を確認するテストで毎回出る) |
| `"next start" does not work with "output: standalone"` | 警告 | ⚠️ 実害あり (`node .next/standalone/server.js` を使う必要) |
| `Cannot find module ./messages/xxx.json` | next-intl 動的 import の標準トレース漏れ | ✅ 真因 (outputFileTracingIncludes で対応) |
| `Type error: Expected N arguments, but got M` | TypeScript コンパイル失敗 | ✅ 真因 |
| `waiting for getByRole...` タイムアウト | セレクタ不一致 | ✅ アサーション実装か UI 実装どちらかを直す |
| `ReferenceError: exports is not defined in ES module scope` | Playwright の TS ローダが ESM の generated コード (例: Prisma client の `import.meta.url`) を CJS として扱って衝突 | ✅ 真因。E2E fixture から **Prisma client を直接 import しない**。DB 操作は `pg` の生 SQL で書く (PR #92 初回 CI 失敗の事例) |
| `page.goto: net::ERR_ABORTED at http://localhost:3000/<path>` | 直前の navigation (特に 302 リダイレクトチェーン) が完了する前に次の `goto` / 別ナビゲーションが始まり、ブラウザが前者を abort | ✅ 真因。`waitForURL` の正規表現が中間 URL (例: ログイン後の `/` → `redirect('/projects')` 中の `/`) にマッチしていないか確認。対策: URL を glob 完全一致で待つ + `waitForLoadState('networkidle')` を加える (PR #92 hotfix 4、`waitForProjectsReady` ヘルパー参照) |
| `locator.fill: Timeout Nms exceeded. waiting for ...getByLabel(...)` | **`<Label>` に `htmlFor` が無く `<Input>` に `id` が無い** 等で ARIA のラベル-入力リンクが欠落、`getByLabel` が辿れない。または全角/半角括弧の Unicode 不一致 (例: UI が `（確認）` U+FF08/FF09 なのにテストが `(確認)` U+0028/0029) | ✅ 真因 (a11y 欠陥も兼ねる)。**フォーム要素には `<Label htmlFor="x">` + `<Input id="x">` を必ずペアで付ける** (スクリーンリーダ対応と E2E 両立)。括弧は UI と Unicode 完全一致で書く (PR #92 hotfix 5 事例)。|
| `locator.click: Timeout Nms exceeded. waiting for getByRole('button', ...)` が `/login` ページで発生 | **Playwright は既定で test ごとに新しい BrowserContext を作る**ため、前 test のログイン cookie が失われ、次 test で middleware が `/login` にリダイレクトする。該当ボタンは `/login` に存在しないためタイムアウト | ✅ 真因。`test.describe.serial()` だけでは context 共有されない。`beforeAll` で `browser.newContext() + context.newPage()` を作って describe 全体で共有し、各 test 内で `const page = sharedPage;` と明示する。意図的ログアウトは `sharedContext.clearCookies()` (PR #92 hotfix 6 事例)。|
| `toBeVisible() failed` / `element(s) not found` on `getByRole('heading', { name: ... })` | shadcn/ui の `CardTitle` は `<div>` として描画され heading role を持たない。`<h1>`/`<h2>` 以外の「見出し風テキスト」はこのケースに該当 | ✅ 真因。`getByText('...', { exact: true })` に置換する。UI 側で heading 化するのはアクセシビリティ改善だが **別 PR 相当** (shadcn/ui の広範囲変更になる)。PR #90 hotfix 5 / PR #92 hotfix 7 で再発した既知パターン |
| `strict mode violation: getByText(...) resolved to 2 elements` | 同一テキストを含む要素が hydration 過渡や状態バッジ近傍、**一覧テーブルの `<a>` prefetch** で 2 つ以上一致する。片方が `visibility:hidden` でも strict mode は fail する | ✅ locator スコープを具体化する。`<h2>` なら `page.locator('h2').filter({ hasText: X }).first()`、**一覧の行内文言なら `page.locator('tbody tr').filter({ hasText: X }).first()`**。`waitForLoadState('networkidle')` で過渡状態の待機も追加 (PR #93 hotfix 1 / PR #95 hotfix 1 / LESSONS_LEARNED §4.11) |
| WBS 等のツリー UI で子行が `element(s) not found` | 親 WP が collapsed 状態だと子 ACT を **DOM に描画しない** (`{!isCollapsed && children.map(...)}`)。可視/不可視ではなく存在そのものが無い | ✅ 子を検証する前に親の展開トグルをクリックする。展開状態は useSessionStringSet 等で永続化される場合が多いので 1 度展開すれば後続 test でも保持 (PR #96 hotfix / LESSONS §4.13) |
| `getByRole('button', { name: /...title-text.../ })` が見つからない | button に visible text (アイコン文字等) があると accessible name は **text content が優先**、`title` 属性は無視される (ARIA 仕様) | ✅ `aria-label` が無い title-only ボタン (展開トグル等) は **`getByTitle(...)`** を使う。`aria-label` がある場合は `getByRole` で OK (PR #96 hotfix / LESSONS §4.16) |
| `toContainText` が **状態変化の前後どちらでも pass** する | 同じ行内に「確定ボタン」と「確定バッジ」両方に `確定` 文字がある等、**文字が複数要素に重複**する UI では text match で状態判定できない | ✅ `toContainText` ではなく **要素単位の存在/消失** (`toHaveCount(0)` / `toBeVisible`) で状態遷移を判定。消失すべき文字の `not.toContainText` も併用 (PR #96 hotfix / LESSONS §4.17) |
| click 直後の `waitForLoadState('networkidle')` が 0ms で解決、その後のアサーションが reload 前に走って fail | Next.js `router.refresh()` は fire-and-forget。onClick が Promise を await しないため、Playwright の click() が返った時点では fetch/refresh は背景タスクで未 flight | ✅ click **前** に `page.waitForResponse(...)` を Promise として予約 → click 後に await し API 完了を確証。その後 `waitForLoadState('networkidle')` で補助 (PR #96 hotfix / LESSONS §4.18) |
| MFA 検証等「click → API → session update → location.href → middleware → /projects」系 長いチェーンで `waitForURL` が 15s timeout | 並列 CI 下で各段階が数百ms〜数秒かかり合計で timeout 超過。click は event dispatch で即返るため、全チェーンを 1 つの timeout に吸収させると脆弱 | ✅ 最初の API (verify) のレスポンスを click 前に予約 → click 後に await → その後 `waitForURL` で残り部分のみ待機。チェーンを 2 段階に分割 (PR #96 hotfix / LESSONS §4.19) |
| `waitForResponse + waitForLoadState('networkidle')` を組んでも確定/編集系の UI 検証が間欠的に fail | `router.refresh()` の RSC fetch は microtask の更に後 tick で発火することがあり、networkidle を呼んだ瞬間は「まだ発火していない」→ 0ms で即解決して race | ✅ 同一 URL で部分更新する操作 (router.refresh 依存) は `page.reload({ waitUntil: 'networkidle' })` で DB 真状態を強制取得する。ナビゲーション系 click は §4.19 の 2 段階待機で OK (PR #97 hotfix / LESSONS §4.20) |
| `apiRequestContext.post: read ECONNRESET` 等 transient network error | 並列 CI で Next.js サーバ resource 逼迫 / TCP 接続プール枯渇 / Supabase 接続プール伝播等の infra flakiness。139ms 程度の極短時間で fail する点が特徴 | ✅ API ヘルパーに **transient error 限定 retry** (1s × 最大 3 回) を実装。4xx/5xx response は retry せず即 throw (本物のバグを隠蔽しない) (PR #97 hotfix / LESSONS §4.21) |
| 視覚回帰テストで **pixel 差分 98% 等 大規模差** (Diff 画像が全面赤) | テーマ変更等 **Server Component 再取得に依存する動的 state** で、client state (`aria-checked` 等) は即時更新されるが SSR 属性 (`<html data-theme>` 等) は router.refresh 完了後に更新される。screenshot が中間状態 (client 更新済 / SSR 未更新) を captured | ✅ 状態変更 → **page.reload** → SSR 決定属性を assert で確証 → screenshot の順に並べる。client state (`aria-checked` 等) は race するので SSR が書く属性を見る (PR #97 hotfix / LESSONS §4.22) |
| §4.22 を適用したのに `data-theme` 等 SSR 属性が 10s タイムアウトで前の値のまま | `page.reload` が JWT cookie 未更新の状態で走り、`layout.tsx` が古い session からテーマを SSR する。**原因は click → `updateSession()` (POST /api/auth/session) が独立 API であり、PATCH のみを `waitForResponse` していても JWT 更新を待てない** | ✅ click 対象のハンドラが next-auth の `useSession().update()` を呼んでいる場合、`waitForResponse(/api/auth/session POST)` **も click 前に予約して click 後に await** する。SSR が session を読む属性 (data-theme / lang / ロール等) は全て同じ race を抱える (PR #97 hotfix / LESSONS §4.23) |
| MFA verify 後に `waitForURL('**/projects', { timeout: 15_000 })` が timeout し URL が `/login/mfa` から動かない | MfaForm は verify API の後に **独立した `await update({ mfaVerified: true })` (POST /api/auth/session)** を呼んで JWT を再発行し、その後 `window.location.href` で遷移する。verify API だけ `waitForResponse` しても session 更新の時間が 15s budget を食い尽くす | ✅ verify API **と** `/api/auth/session` POST の **両方** を click 前に並行予約し、両方 await してから `waitForURL` に入る。§4.23 と同根の race で、click 後の挙動が「reload」か「別 URL 遷移」かで待ち方が変わるだけ (PR #98 hotfix / LESSONS §4.24) |
| `page.goto` 直後の `getByText` / `getByRole` が strict mode violation (同一 CardTitle 等が 2 要素) | Next.js 16 / React 19 の Suspense streaming 過渡期で、hydration 完了前に一瞬 DOM が二重化して観測される。`page.goto` は "load" までしか待たず hydration 完了は待たない | ✅ `page.waitForLoadState('networkidle')` を assertion 前に挟んで hydration を完了させる。safety net として text locator に `.first()` を付ける。Suspense / loading.tsx / parallel routes を含むページでは全般的に必要 (PR #98 hotfix / LESSONS §4.25) |
| `page.once('dialog', ...)` を使う削除テストが CI で intermittent に `toHaveCount(0)` 10s timeout (networkidle が 1ms で即解決しているログが決定打) | click → confirm 承諾 → fetch DELETE → `router.refresh()` という **dialog 非同期 + fire-and-forget 連鎖** を `waitForLoadState('networkidle')` 単独では待てない。1 ms で idle 判定 → 古い DOM を 10s 観測し続けて fail | ✅ click 前に **`waitForResponse(DELETE)` + `page.once('dialog')`** を予約 → click → DELETE await → **`page.reload({ waitUntil: 'networkidle' })`** で DB 真状態を強制同期 → `toHaveCount(0)` で消失確認、の 5 ステップを全削除テストに横展開する。`page.once('dialog')` が grep でヒットする全 spec で揃える必要あり (PR #106 hotfix / LESSONS §4.26) |
| CI の Playwright build step で `cp: cannot stat 'public': No such file or directory` (exit 1) — `next build` は成功しているのに standalone 組み立てで fail | アセット整理 PR で `public/` 配下のファイルを **全削除** して空ディレクトリになったが、**git は空ディレクトリを tracked しない** ため CI clone 時に `public/` 自体が存在しない。workflow の `cp -r public .next/standalone/` が標的ディレクトリ欠落で fail | ✅ 空になるアセットディレクトリには **`touch <dir>/.gitkeep`** を同時 commit する (本プロジェクトでは `public/.gitkeep`)。代替策として workflow を `[ -d public ] && cp ...` と defensive にする方法もあるが、silent failure の温床になるため本プロジェクトでは採用せず (PR #100 hotfix / LESSONS §4.27) |
| MFA verify API が CI で intermittent に 400 を返す (ローカルでは通る) — `expect(mfaRes.ok()).toBeTruthy()` で Received: false | `otplib.verifySync({ token, secret })` を **`epochTolerance` 未指定** (既定 0) で呼んでおり、TOTP コード生成時刻と検証時刻が同一 30 秒 period 内になければ拒否される。CI 負荷 + Step 累積で period 境界を跨ぐと fail。テスト件数増加 (646 → 671 等) で顕在化する flaky | ✅ サーバ側で `verifyTotp` / `enableMfa` / `verifyInitialTotpSecret` すべてに **`epochTolerance: 30`** (±30 秒許容) を付与。RFC 6238 §5.2 推奨で業界標準。ブルートフォース耐性はロック機構 (5 回失敗で一時、3 回目で恒久) で十分確保 (PR #110 hotfix / LESSONS §4.28) |
| 合成ラベルのボタンが `getByText('ラベル', { exact: true })` で見つからない | `<Button>{label}: {state}</Button>` の形式 (例: MultiSelectFilter) で実テキストは「担当者: 全員」等。label 単独では exact 一致しない | ✅ 正規表現で prefix match する: `page.getByRole('button', { name: /^担当者[::]/ })` (半角/全角コロン両対応) (PR #96 hotfix / LESSONS §4.14) |
| 視覚回帰 mask ありでも `N pixels different` | 並列テスト環境で他 spec のデータが DB に残り行数が baseline 時と不一致。mask 境界は DOM 撮影時に動的決定なので、mask 範囲そのものが baseline とズレる | ✅ 動的データを mask で吸収するのは不確実。代わりに (a) 対象を視覚回帰から外す、(b) 固定値 (日付・名前) でデータ seed、(c) 画面を固定構造要素に絞る のいずれか (PR #96 hotfix / LESSONS §4.15) |
| MFA 有効化後に `強制有効化 (解除不可)` バッジが 10s 待っても出ない | `router.refresh()` + Server Component 再取得のラウンドトリップが並列 CI で延びると expected visible が timeout する。API レスポンス自体は OK でも UI 反映が遅れる | ✅ `page.waitForResponse(r => r.url().includes('/api/auth/mfa/enable'))` で API 完了を明示的に待ち、続いて `waitForLoadState('networkidle')` で再レンダも待機。元ボタン (`MFA を有効化する`) の消失 (`toHaveCount(0)`) も補強アサーションとして加える (PR #93 hotfix 1) |
| Tab アサーション `toHaveAttribute('data-state', 'active')` が timeout、Received `""` | 本プロジェクトは **Base UI** (`@base-ui/react/tabs`) で、Radix UI の `data-state="active"` とは異なる `data-active=""` + `aria-selected="true"` を使う | ✅ ライブラリ非依存の **W3C ARIA 標準** `aria-selected="true"` でアサーションする。`toHaveAttribute('aria-selected', 'true')` (PR #93 hotfix 3 事例)。UI ライブラリを識別するには `src/components/ui/*.tsx` の import 元を確認 |

#### 修正方針の判断ルール

E2E が fail したら、以下のどちらの原因かを見極める:

1. **UI/実装に不具合がある** → ソースコードを修正
2. **アサーションが UI 実装とズレている** → テスト側を実装に合わせる (仕様上許容される範囲で)

判断基準:
- 既存ユーザの体験として不備があるか → あれば実装修正、なければテスト修正
- 例: `<div>` で見出し風に描画しているところに `getByRole('heading')` を当てるのは
  アクセシビリティ観点で改善の余地はあるが、**本 E2E test の責務外** (別タスク化)

### 9.8 E2E で招待メールと MFA を扱う (PR #92)

Steps 1-6 のように、**招待メールのトークン抽出**や **TOTP コード生成**を含むテストを
書く場合は、以下の E2E fixture を使う。

#### 招待メールの捕捉 (inbox provider)

CI 環境では `MAIL_PROVIDER=inbox` で `InboxMailProvider` が起動し、送信内容を
`INBOX_DIR` 配下に 1 通 1 JSON ファイルとして書き出す。Playwright 側はこの
ディレクトリを polling して受信を待つ。

```ts
import { waitForMail, extractSetupPasswordUrl } from '../fixtures/inbox';

const mail = await waitForMail('user@example.com', { after: testStartedAt });
const setupUrl = extractSetupPasswordUrl(mail);
await page.goto(setupUrl);
```

- `after` を渡すと、それ以前のメール (他テストの残骸) を無視できる
- タイムアウト既定 10 秒 / 250ms 間隔 polling
- 本番環境では `MAIL_PROVIDER` を `brevo` / `resend` / `console` にする (inbox は E2E 専用)

#### TOTP コード生成

アプリ本体と同じ `otplib` (`generateSync`) で生成する。**時刻跨ぎのズレを
避けるため、呼び出し直前で生成して即 fill** する。

```ts
import { generateTotpCode } from '../fixtures/totp';
await page.getByLabel('認証コード').fill(generateTotpCode(mfaSecret));
```

MFA シークレットは `/settings` 画面の「手動入力用のシークレットキー」詳細から読み取るか、
初期セットアップフローで setup-password レスポンスの `otpauthUri` から抽出する。

#### 初期 admin シード + クリーンアップ

`e2e/fixtures/db.ts` の `ensureInitialAdmin(email, password)` を `beforeAll` で
呼ぶと、UPSERT で対象 email のユーザ状態を初期化する
(`forcePasswordChange=true` / `mfaEnabled=false` / `isActive=true` /
`failed_login_count=0` 等にリセット)。既存レコードがあっても `user.id` を保持したまま
状態だけ洗い替えるため、users からの RESTRICT な FK (audit_logs 等) に抵触しない。

`e2e/fixtures/run-id.ts` の `withRunId('label')` で実行ごとに一意な文字列が得られる。
ユーザ email / プロジェクト名等に付与し、`afterAll` の `cleanupByRunId()` で
prefix 一括削除するとローカル実行時の残存を防げる (CI は Postgres コンテナ破棄で完全消去)。

#### ⚠️ 重要: Prisma 生成クライアントを E2E から直接 import しない

`src/generated/prisma/client.ts` は `import.meta.url` を使う ESM で、Playwright の
TypeScript ローダ (CJS デフォルト) から直接 import すると:

```
ReferenceError: exports is not defined in ES module scope
at ../src/generated/prisma/client.ts:3
```

で落ちる (PR #92 の初回 CI 失敗事例)。対策:

- **E2E の DB 操作は `pg` の生 SQL で書く** (`e2e/fixtures/db.ts` 参照)
- 列名は `prisma/schema.prisma` の `@map()` 名 (snake_case) を参照
- `@updatedAt` は DB デフォルト無しなので INSERT 時に明示的に `NOW()` を入れる
- Prisma の型情報が必要なら服務ロジック層 (`src/services/`) へ寄せ、E2E からは HTTP API 経由で呼ぶ

#### E2E スペックを書くときの注意点 (PR #92 連続 hotfix で得た知見)

以下は CI 失敗を繰り返して学んだチェックリスト。新しい spec を書くとき / 既存 spec を
書き換えるときは必ず再確認する:

1. **ログイン後は `waitForProjectsReady(page)` ヘルパーを使う** (hotfix 4)
   - `waitForURL(/\/projects|\/$/)` 等の緩い正規表現は 302 中間 URL にマッチして
     `net::ERR_ABORTED` を起こす
   - `**/projects` glob 完全一致 + `networkidle` で待つ

2. **UI 実装の文字コードと完全一致させる** (hotfix 5 / hotfix 7)
   - 全角括弧 `（）` U+FF08/U+FF09 と半角括弧 `()` U+0028/U+0029 は別文字
   - `getByLabel('...(確認)')` と `getByLabel('...（確認）')` は別物
   - rewrite のたびに混入しやすいので、疑わしければ `node` 等で文字コード確認

3. **shadcn/ui の `CardTitle` は `<div>` で描画される** (hotfix 7, 既知 PR #90 hotfix 5 の再発)
   - `getByRole('heading', { name: '...' })` では拾えない
   - `getByText('...', { exact: true })` を使う
   - 対象: `/login` / `/setup-password` / `/login/mfa` 等、Card ベースの画面
   - 真の heading (`<h1>`/`<h2>` 等) は対象外 (例: `/settings` の `<h2>設定</h2>`)

4. **フォーム要素は `<Label htmlFor="x">` + `<Input id="x">` を必ずペアで付ける** (hotfix 5)
   - 欠けていると `getByLabel` が辿れない + スクリーンリーダーも壊れる
   - a11y 改善と E2E 対応が両立する

5. **`test.describe.serial()` だけでは BrowserContext は共有されない** (hotfix 6)
   - 既定で test ごとに新しい context が作られセッション cookie が失われる
   - セッションを引き継ぐ場合は `beforeAll` で `browser.newContext()` + `newPage()`
     を作って describe 全体で共有する
   - 意図的ログアウトは `sharedContext.clearCookies()`

#### pg 生 SQL を使う際のセキュリティ/パフォーマンス規約 (PR #92 hotfix 2)

E2E は CI で隔離実行されるが、`cleanupByRunId` のようにユーザ提供文字列を
`LIKE` パターンに組み込む場合は以下を徹底する:

1. **入力検証**: ユーザ/呼び出し元から渡る値は正規表現で許容文字集合を制限
   (`assertRunIdFormat` の例: `/^[A-Za-z0-9-]{6,64}$/`)。LIKE の wildcard 文字
   (`%` / `_`) やクオート/セミコロンが混入した時点で即 throw。
2. **Prepared statement のみ**: 値連結 (`` `... ${x} ...` ``) は絶対に使わず、
   必ず `$1` / `ANY($1)` プレースホルダ経由で渡す。
3. **並列化**: 相互独立な DELETE (FK 先テーブル群) は `Promise.all` で束ねて
   ラウンドトリップを削減する。
4. **Transaction**: 2 段階削除 (FK 先 → 親) は `BEGIN..COMMIT` でアトミック化し、
   失敗時は `ROLLBACK` + warn ログ (best-effort クリーンアップの一貫性保持)。

これらは CLAUDE.md のコミット前チェック (2. セキュリティ / 3. パフォーマンス) に
該当するため、E2E fixture に生 SQL を追加するたびに再確認する。

---

