# E2E テスト実装で得られた知見 (PR #90 以降累積)

- 初版作成日: 2026-04-22
- 対象 PR: #90 (基盤) → #92 (Steps 1-6) → #93 (Step 7) → #94 (Step 8) → #95 (Steps 9-12)
  → #96 (視覚回帰 + WBS/Gantt/見積) → #97/#99 (session race hotfix) 以降も継続追記
- 罠パターン数: **33 個** (§4.1 〜 §4.33)

## 1. この文書の位置付け

PR #90 以降、E2E 基盤を整備・拡張する過程で **毎回の CI 失敗から学んだ教訓** を
ここに累積する。新しい spec を書く / 失敗をデバッグする前に一読すると、
**同じ罠を再度踏まずに済む**。新しい罠を踏んだら §4.X に追記する (番号は既存の
最大+1、時系列で累積)。

想定読者:
- 新しく E2E spec を書く開発者
- CI で赤になった E2E を調査する担当者
- AI 駆動から人間駆動への引継ぎ資料として残す

関連文書:
- [e2e/README.md](../../e2e/README.md) — テストの内容説明 (WHAT)
- [docs/developer/DEVELOPER_GUIDE.md §9](./DEVELOPER_GUIDE.md) — 実行手順 + 失敗調査手順 (HOW)
- [docs/developer/E2E_COVERAGE.md](./E2E_COVERAGE.md) — カバレッジマニフェスト (COVERAGE)
- [docs/developer/TESTING_STRATEGY.md](./TESTING_STRATEGY.md) — 自動テスト + 手動テストの全体戦略 (STRATEGY)
- 本文書 — 実装判断の背景 (WHY)

---

## 2. 段階導入プランが成功した理由

最初から 12 ステップ全てを 1 PR で書こうとせず、A〜E の 5 PR に分割した。
**これが唯一最も重要な意思決定** だった。

| PR | scope | 結果 |
|---|---|---|
| A (#90) | 基盤 + スモーク + visual 雛形 | hotfix 5 回 |
| B (#92) | Steps 1-6 (admin + 招待) | hotfix 7 回 |
| C (#93) | Step 7 (タブ + 全横断) | hotfix 3 回 |
| D (#94) | Step 8 (個人機能) | hotfix 0 回 |
| E (#95) | Steps 9-12 + visual 雛形 | (本稿時点で観測中) |

**観察**: PR B/C の早期に罠を踏みきったおかげで、PR D は一発で通った。後続で同じ
問題に再び当たる確率が急激に下がる。**「最初の PR で地雷を消費する」戦略が有効**。

単一 PR で 12 step やっていたら、以下の連鎖失敗が発生していたと思われる:
- どの step が壊れたか切り分け困難
- 部分成功の保護ができない (全 or 無の扱い)
- hotfix 対応が爆発的に複雑化

---

## 3. アーキテクチャ上のコア決定事項

### 3.1 sharedContext + sharedPage パターン

Playwright は **既定で test ごとに新しい BrowserContext を作る**。
`test.describe.serial()` を指定しても、このコンテキスト分離は維持される。

つまり **Step 1 でログインしたセッションは Step 2 では自動的に失われる**。
これを知らずに `test.describe.serial()` に頼ると、後続 step が middleware に
よって `/login` にリダイレクトされ、存在しないボタンを永遠に待ち続ける。

**解決**: `beforeAll` で 1 つの context + page を作り、describe 全体で共有する。
意図的ログアウトは `sharedContext.clearCookies()` で行う。

```ts
let sharedContext: BrowserContext;
let sharedPage: Page;

test.describe.configure({ mode: 'serial', retries: 0 });

test.describe('Steps 1-N', () => {
  test.beforeAll(async ({ browser }) => {
    sharedContext = await browser.newContext();
    sharedPage = await sharedContext.newPage();
    // ... seed + login
  });

  test.afterAll(async () => {
    await sharedPage.close();
    await sharedContext.close();
    await cleanupByRunId(RUN_ID);
    await disconnectDb();
  });

  test('Step 1: ...', async () => {
    const page = sharedPage;  // ← { page } fixture ではなく sharedPage
    // ...
  });
});
```

### 3.2 fixture 階層

```
e2e/fixtures/
├── run-id.ts       ← 実行ごと一意 prefix、cleanup 用
├── db.ts           ← pg 生 SQL で admin/general シード、FK 順序の cleanup
├── inbox.ts        ← 招待メール JSON 捕捉 + URL 抽出
├── totp.ts         ← otplib 同版での TOTP 生成
├── auth.ts         ← UI ログイン + MFA 検証 + /projects 到達ヘルパー
├── project.ts      ← プロジェクト / メンバー作成 API ヘルパー
└── snapshot.ts     ← 節目スクリーンショット (label 付き PNG)
```

**学び**: fixture を粒度別に分けた方が、新シナリオを書くとき何を import するか
直感的に決められる。

### 3.3 節目 snapshot (PR #93 hotfix 2)

Playwright の trace/screenshot/video を `'on'` に固定 + 手動 `snapshotStep()`。

目的の違い:
| 仕組み | 何に使う |
|---|---|
| trace viewer | action 単位でタイムライン的に追いたいとき |
| screenshot 'on' | test 終了時の最終状態確認 |
| video 'on' | 失敗時の再現性確認 (動画全体を通して見る) |
| **snapshotStep** (手動) | **シナリオの "意味ある節目" を目視で一瞬確認** |

snapshotStep は少数精鋭で置くと効果が大きい。「step-2-mfa-enabled-badge」
「step-11-delete-dialog-open」のように「この瞬間を見たい」を厳選する。

---

## 4. 地雷リスト (同じ罠を二度踏まないために)

以下は **CI で実際に失敗して学んだ** 事項。順序は発生時期ではなく、
**新しい spec を書くときの回避優先順** で並べる。

### 4.1 Prisma 生成クライアントを E2E から直接 import しない

**症状**:
```
ReferenceError: exports is not defined in ES module scope
at ../src/generated/prisma/client.ts:3
```

**原因**: `src/generated/prisma/client.ts` は `import.meta.url` を使う ESM。
Playwright の TypeScript ローダは `package.json` に `"type": "module"` が無い
プロジェクトで `.ts` を CJS として扱おうとし、ESM/CJS 衝突を起こす。

**対策**:
- E2E の DB 操作は `pg` の生 SQL で書く (`e2e/fixtures/db.ts` 参照)
- 列名は `prisma/schema.prisma` の `@map()` 名 (snake_case) を使う
- `@updatedAt` は DB デフォルト無しなので INSERT 時に `NOW()` を明示
- Prisma の型情報が必要なら本体 (`src/services/`) に寄せ、E2E からは HTTP API で呼ぶ

### 4.2 `waitForURL` の正規表現は厳密に

**症状**: `page.goto: net::ERR_ABORTED at /settings` 等のナビゲーション中断

**原因**: `waitForURL(/\/projects|\/$/)` のような緩い regex が
**302 チェーン途中のルート URL `/`** にマッチし、遷移完了前に次の goto が走る。

```
login 成功 → window.location='/' → Server Component が redirect('/projects')
                ↑ ここにマッチしてしまう
```

**対策**: glob 完全一致 + `waitForLoadState('networkidle')` のヘルパー化

```ts
// e2e/fixtures/auth.ts
export async function waitForProjectsReady(page: Page) {
  await page.waitForURL('**/projects', { timeout: 15_000 });
  await page.waitForLoadState('networkidle');
}
```

### 4.3 `getByLabel` は ARIA リンクが無いと動かない

**症状**: `locator.fill: Timeout 10000ms exceeded. waiting for
locator('form').filter({ hasText: '現在のパスワード' }).getByLabel('現在のパスワード')`

**原因**: `<Label>現在のパスワード</Label><Input ... />` のように **`htmlFor`
+ `id` のペアが無い** と、Playwright も screen reader もラベル-入力リンクを辿れない。
a11y の欠陥 ≒ E2E で getByLabel が使えない。

**対策**: UI 側で `<Label htmlFor="x">...</Label><Input id="x" ... />` を必ず
ペアで付ける (アクセシビリティ改善と E2E 両立)。PR #92 hotfix 5 で
settings-client.tsx の password フォームを実装修正。

**再発事例 (fix/project-create-customer-validation, PR #134)**:
projects-client.tsx の新規作成ダイアログで `<Label>プロジェクト名</Label>` + `<Input>` が
htmlFor/id 未付与のまま残存。新規追加した Step 6b の E2E が `getByLabel('プロジェクト名')` で
timeout し両 project (chromium / chromium-mobile) で同時 fail。全入力フィールドに
`project-create-{field}` 規則で id を付与して解消。新規フォームは **§5.10.1.5 の規約** に
従うこと (DEVELOPER_GUIDE.md 参照)。

### 4.4 全角/半角括弧の Unicode 完全一致

**症状**: `getByLabel('...(確認)')` が見つからない。UI は `（確認）` で全角。

**原因**: `(` U+0028 と `（` U+FF08 は Unicode 上別文字。`getByLabel` の
substring/exact match はどちらでも文字一致で判定する。

**対策**:
- UI ソースの文字を **コピペで** そのまま spec に入れる
- 疑わしいときは `node` で codepoint を dump して確認
- ドキュメント・テストコードは UI と **完全一致** を原則

### 4.5 shadcn/ui の CardTitle は `<div>`

**症状**: `getByRole('heading', { name: 'たすきば' })` が element not found

**原因**: shadcn/ui の `CardTitle` は `<div>` で実装されており、heading role を
持たない。`/login` `/setup-password` `/login/mfa` 等の「Card ベースの見出し風」は
全てこのパターン。

**対策**: `getByText('たすきば', { exact: true })` に置換する。

判断ルール (PR #90 hotfix 5 で確立):
- 真の heading (`<h1>`/`<h2>` 等): `getByRole('heading')`
- CardTitle 等の `<div>`: `getByText(..., { exact: true })`
- UI 側の heading 化は **scope 外** (shadcn/ui の広範囲変更になる)

### 4.6 BrowserContext は明示的に共有する

**症状**: Step 2 で `/settings` のボタンが見つからず timeout

**原因**: `test.describe.serial()` だけでは context は共有されない。
Step 2 は新しい context を持って middleware に捕まり `/login` へ redirect。
ボタンは元々そのページに存在しない。

**対策**: [§3.1 sharedContext パターン](#31-sharedcontext--sharedpage-パターン) を使う。

### 4.7 UI ライブラリ別の属性

本プロジェクトは **Base UI** (`@base-ui/react/tabs`) を使用しており、
Radix UI とは data 属性が異なる:

| ライブラリ | アクティブタブ判定 |
|---|---|
| Radix UI | `data-state="active"` |
| Base UI  | `data-active=""` + `aria-selected="true"` |

**対策**: **ライブラリ非依存の W3C ARIA 標準** で判定する。

```ts
// Bad (Radix 想定)
await expect(tab).toHaveAttribute('data-state', 'active');

// Good (Base UI / Radix / Headless UI どれでも動く)
await expect(tab).toHaveAttribute('aria-selected', 'true');
```

UI ライブラリを識別するには `src/components/ui/*.tsx` の import 元を確認する。

### 4.8 並列 CI 下の timing 問題

**症状**: 並列 CI run で `strict mode violation (2 elements)` や
MFA badge の 10s timeout が発生

**原因**: 2 worker 並列で hydration 過渡状態の要素ダブリ / router.refresh の
ラウンドトリップが遅延。

**対策**:
- `waitForLoadState('networkidle')` を navigation 後に追加
- 重要 API は `page.waitForResponse(...)` で応答を明示的に待機
- locator は `<h2>` のように **要素種別まで scope** して `.first()` で保険

### 4.9 FK RESTRICT なテーブル削除順

**症状**: `DELETE FROM users WHERE email = ...` が FK 違反で失敗

**原因**: users からの FK は大半が `ON DELETE RESTRICT`
(audit_logs / project_members / recovery_codes / password_histories 等)。
関連レコードが残っていると users が削除できない。

**対策**:
- `ensureInitialAdmin` は DELETE→INSERT ではなく **UPSERT** (`ON CONFLICT
  DO UPDATE`) で状態だけリセット。user.id は保つ
- `cleanupByRunId` は FK 先を先に削除してから users / projects
- 全体を BEGIN..COMMIT で atomic 化、失敗時は ROLLBACK で best-effort

### 4.10 pg 生 SQL の入力検証

**症状**: (現状実被害なし)

**原因**: `LIKE '%' || runId || '%'` で runId に `%` `_` `'` `;` が混入すると
意図外行に match、あるいは構文エラー。

**対策**:
- `assertRunIdFormat` で英数ハイフンのみに制限 (6-64 文字)
- クエリは常に prepared statement (`$1` / `ANY($1)`)
- 値文字列連結 (`` `... ${x} ...` ``) は絶対禁止

### 4.12 視覚回帰の baseline 生成は Linux CI で自動化する (PR #96)

**問題**: 開発者の Windows / macOS ローカルで生成した baseline PNG は、CI Linux
環境のフォントレンダリング / アンチエイリアスと微妙に異なり、pixel 比較で毎回 fail する。

**対策**:
- `.github/workflows/e2e-visual-baseline.yml` を `workflow_dispatch` で用意
- Linux CI 内で `playwright test --update-snapshots` を実行
- 生成 PNG を github-actions bot が自動 commit & push
- `permissions: contents: write` が必要

**重要**: 「CI を rerun」するだけでは baseline は生成されない。baseline workflow を
**起動** → 自動 commit → (それをトリガに) E2E CI 自動再実行、の 2 段階。

**chicken-and-egg 回避**: `workflow_dispatch` は GitHub 仕様で **default branch
(main) にファイルが存在する**必要がある。workflow 自体を新規追加する PR (#96 等)
では UI に表示されないため、`push` トリガ + commit message 条件 `[gen-visual]` で
発火できるよう二重化する:

```yaml
on:
  workflow_dispatch: { inputs: {...} }
  push:
    branches: ['**']

jobs:
  generate:
    if: >-
      github.event_name == 'workflow_dispatch' ||
      contains(github.event.head_commit.message, '[gen-visual]')
```

利用者は空コミットで発火できる:
```bash
git commit --allow-empty -m "chore: generate visual baselines [gen-visual]"
git push
```

**動的コンテンツの mask**: RUN_ID 付きデータ等の動的部分は `mask:` オプションで
pixel 比較から除外する:

```ts
await expect(page).toHaveScreenshot('x.png', {
  fullPage: true,
  mask: [page.locator('tbody tr')],  // 毎回変わる部分を除外
});
```

### 4.17 `toContainText` はボタン/バッジの文字衝突で誤 pass する

**症状**: テストは「確定」操作後に「確定」表示を確認するが、実際には確定処理が
失敗していて状態が変わっていないのに、`toContainText('確定')` が pass してしまう。
後続の「削除ボタンが消える」検証で初めて失敗が発覚する。

**原因**: 同じ行内に以下の両方が存在:
- 未確定時: **確定ボタン** (text='確定') + 未確定バッジ (text='未確定') + 削除ボタン
- 確定後:   確定バッジ (text='確定') のみ

`toContainText('確定')` は、ボタンの '確定' テキストでも満たされるので **確定前/後の
両方でマッチ** してしまい、UI 状態の変化を検知できない。

**対策**: 状態変化を識別できるアサーションを選ぶ:

```ts
// Bad: ボタン文字でも pass する
await expect(row).toContainText('確定');

// Good: 消失を検証 (= 状態遷移を確定できる)
await expect(row.getByRole('button', { name: '確定' })).toHaveCount(0);
await expect(row).not.toContainText('未確定');  // 以前の状態が消えたことを確認
```

**汎化ルール**: **同じ文字が複数要素に出る UI** (ボタン / バッジ / ラベル等に同一語彙
がある) では、`toContainText` での状態判定は避け、**要素単位の存在/消失** で判定する。

### 4.37 PC テーブル前提の spec はモバイルカードビュー導入後に `<tr>` セレクタで `hidden` 判定 fail する (PR #137 で遭遇)

**症状**: PR #137 (PR #128a-2 = WBS モバイル階層カードビュー追加) を main へ取り込む
過程で、`06-wbs-tasks.spec.ts` の以下 test が **chromium-mobile project でのみ** fail。
chromium (PC) では引き続き pass。

```
Error: expect(locator).toBeVisible() failed
Locator: locator('tr').filter({ hasText: 'e2e-...-WorkPackage-root' }).first()
Expected: visible
Received: hidden
```

**原因**: `tasks-client.tsx` (PR #128a-2) の WBS 描画は **viewport 単位で 2 系統を
並べて描画 + CSS で切替** する SSR 安全パターンを採用:

```tsx
{/* PC (md+) は従来テーブル */}
<div className="hidden md:block">
  <table>
    <tr>{/* TaskTreeNode を <tr> として描画 */}</tr>
  </table>
</div>

{/* モバイル (md-) はカードビュー */}
<div className="space-y-2 md:hidden" role="list" aria-label="WBS タスク一覧">
  {filteredTasks.map((task) => <TaskMobileCard ... />)}
</div>
```

mobile viewport では `<table>` 側が `display:none` になり、子の `<tr>` は **DOM に
存在するが hidden** 状態。Playwright の `toBeVisible()` は CSS による hidden を
visibility:hidden として扱うため fail する。`<tr>` が hidden になる理由は
DOM 自体に存在しないわけではなく、親が `display:none` のため (DOM クエリ自体は
ヒットするが visibility 判定で false)。

**対策 (本 fix で採用)**: PR #137 では `06-wbs-tasks.spec.ts` を
**chromium-mobile project から `testIgnore`** で除外。理由:

1. WBS spec の機能ロジック (CRUD / 展開 / 削除) は同じ handler / 同じ API を経由
   するため、chromium (PC) で機能担保すれば mobile でも同じ動作
2. mobile UI 固有の verify はカードビュー描画の視覚回帰で別途検証する
   (PR #128a-2 が `[gen-visual]` で生成した mobile baseline で代替)
3. `<tr>` ⇄ `[role="listitem"]` を viewport 切替で出し分ける helper を spec 全体に
   適用するには 5 箇所の locator 修正 + TaskMobileCard 側に role="listitem" 付与の
   双方が必要で、本 PR スコープ外

**汎化ルール**:

1. **viewport 切替で UI 構造を別 DOM サブツリー (table vs cards) にする画面は、
   既存 PC spec を mobile project で動かすと `<tr>` 系セレクタが hidden 判定で fail する**。
2. **対応の選択肢は 3 通り**:
   - (A) **`testIgnore` で当該 spec を mobile から除外** (本 fix の選択)。
     mobile UX は視覚回帰でカバー、機能 logic は PC spec で担保。
   - (B) **viewport-agnostic locator** に refactor (`getByText(name).first()` 等)。
     visibility 判定は両 viewport で正しく動くが、scope (行/カード) の概念が消える
     ため後続の button click 等が複雑化する。
   - (C) **TaskMobileCard に role="listitem" 付与 + helper 関数 `wbsRow(text)` を
     `<tr>` ⇄ `[role="listitem"]` で OR 結合**。
     完全 mobile 対応だが本格的な test refactor が必要。
3. **新規 mobile UI を追加する PR では事前に「PC spec を mobile project に流すと
   どこで壊れるか」を grep で確認** し、(A) testIgnore か (B)/(C) refactor かの
   判断を PR スコープに含める (後付け hotfix の連鎖を避ける)。
4. **mobile UX 固有の機能 spec は別 spec ファイル** (e.g. `06-wbs-tasks-mobile.spec.ts`)
   として PC spec とは独立に書く方が長期的に綺麗 (現状は未実装、TODO)。

**関連**: §4.36 (spec 01 を mobile から除外、DB contention 理由) と本 §4.37 (spec 06
を mobile から除外、UI 構造理由) は **異なる動機での同じ手法 (testIgnore)**。
将来 `testIgnore` リストが伸びた場合、(B)/(C) の refactor を検討する閾値とすべき。

**playwright.config.ts の最新 testIgnore** (2026-04-25 時点):
```ts
testIgnore: [
  /01-admin-and-member-setup\.spec\.ts/,  // §4.36: 共有 admin の DB contention
  /06-wbs-tasks\.spec\.ts/,                // §4.37: PC テーブル前提 + mobile カードビュー
],
```

### 4.36 共有 DB 上の admin ユーザを mutate する spec は **project 単位で 1 回のみ実行**する (PR #128 で遭遇)

**症状**: PR #128 で chromium-mobile project を追加後、`01-admin-and-member-setup.spec.ts` の
**Step 1 (パスワード変更)** のみが chromium-mobile で fail。Step 2-6 は serial skip。
他 spec (00, 02-09) は chromium-mobile でも正常 pass。

```
[chromium]        ✓  Step 1: 初期 admin でログインしてパスワードを変更する (5.5s)  @12:21:33
[chromium-mobile] ✘  Step 1: 初期 admin でログインしてパスワードを変更する (12.2s) @12:22:45

Error: expect(locator).toBeVisible() failed
Locator: getByText('パスワードが変更されました')
```

**原因**: Playwright は既定で **project を並列 worker で実行** する (`workers: 2` 設定)。
両 project の `beforeAll` は以下で **同一の admin-e2e@example.com を UPSERT** する:

```ts
await ensureInitialAdmin(ADMIN_EMAIL, ADMIN_INITIAL_PW);
// → INSERT ... ON CONFLICT (email) DO UPDATE SET password_hash=..., mfa_enabled=false, ...
```

`ADMIN_EMAIL` は `admin-e2e@example.com` 固定で、RUN_ID の接尾辞が付かない (他 spec は
`admin-visual-${RUN_ID}` / `admin-pr111-customer-${RUN_ID}` のように run スコープだが、
01 のみ環境変数 `INITIAL_ADMIN_EMAIL` を使うため固定)。
その結果:

1. `t=0` chromium beforeAll: admin を password=INITIAL, mfa=false に reset
2. `t=0-5s` chromium Step 1: password を NEW に変更
3. `t=5-10s` chromium Step 2: MFA を enable
4. **`t=10s` chromium-mobile beforeAll**: admin を再 reset (password=INITIAL, **mfa=false**) ← chromium の mid-run 状態を破壊
5. chromium の ongoing Step (MFA 有効化 / user invite 等) が DB 状態ミスマッチで失敗しうる
6. chromium-mobile Step 1: login → password form 送信 → しかし session 不整合等で `setPwSuccess` が呼ばれず timeout

つまり **project 間の非同期 DB mutation 干渉** が原因。retries を増やしても改善せず
(beforeAll 状態が破壊されたまま再実行されるため)。

**対策**: `playwright.config.ts` の chromium-mobile project に **`testIgnore`** を追加して
spec 01 を chromium project のみで実行する:

```ts
{
  name: 'chromium-mobile',
  use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' },
  testIgnore: [/01-admin-and-member-setup\.spec\.ts/],
},
```

spec 01 は **auth 配線の機能検証** を担う spec であり、モバイル viewport 固有の UX
リスク (タップ領域、viewport 幅依存描画) は薄い。chromium project 単独で 1 回実行すれば
auth 基盤の回帰検出に十分。他 spec (02-09) は:

- **RUN_ID でユーザ/データを分離している** (02 以降は `admin-feature-{RUN_ID}@example.com`) か
- **read-only** (02 タブ表示、03 横断一覧、07 ガント表示等)

のどちらかのため、並列 project 実行でも DB 干渉が起きず pass する (CI 実測で確認済)。

**汎化ルール**:

1. **複数 project で同じ spec を走らせる場合、beforeAll の DB mutation が他 project の
   ongoing 状態を破壊しないか確認する**。固定 email / 固定リソース ID を触る spec は特に注意。
2. **beforeAll の `ensureInitialAdmin` / `ensureGeneralUser` 等の UPSERT 系 fixture は
   `RUN_ID` で email を分離するのを原則とする**。spec 01 のみ `INITIAL_ADMIN_EMAIL` env を
   使う理由は「Next.js 初期 admin boot 検証」のため (プロジェクトで 1 アカウント固定想定)。
3. **mobile project は新規追加時点で全 spec を無差別に含めない**。
   まず読み取り系 spec で挙動確認、mutate 系は個別に可否判定する。
4. **「chromium で pass / chromium-mobile で fail」のパターンを見たら、viewport 問題より先に
   並列 DB 干渉を疑う**。対称なはずの 2 project で片方だけ落ちるのは viewport より
   DB state race の方がよくある原因。

**関連**: §4.8 (並列 CI 下の timing 問題)、§4.26 (テスト間の state 分離パターン)、
[playwright.config.ts:106](../../playwright.config.ts) の `testIgnore` 設定。

### 4.35 `devices['iPhone 13']` を spread するだけで Playwright は **WebKit** を起動しようとする (PR #128 で遭遇)

**症状**: PR #128 の CI で、E2E ジョブが 16 件一斉 fail。失敗は全て起動時エラー:

```
Error: browserType.launch: Executable doesn't exist at /home/runner/.cache/ms-playwright/webkit-2272/pw_run.sh
TypeError: Cannot read properties of undefined (reading 'close')
```

16 件の内訳は、mobile project で走る全シナリオ (`specs/` + `visual/` ≒ mobile viewport ぶん)。
ブラウザ起動前に落ちるため test の中身に関係なく全件起動失敗。

**原因**: PR #128 で `playwright.config.ts` に以下のプロジェクトを追加した:

```ts
{
  name: 'chromium-mobile',
  use: {
    ...devices['iPhone 13'],  // ← これが罠
  },
},
```

`devices['iPhone 13']` の中身を実際にダンプすると:

```json
{
  "userAgent": "Mozilla/5.0 (iPhone; ... Safari/604.1)",
  "viewport": { "width": 390, "height": 664 },
  "deviceScaleFactor": 3,
  "isMobile": true,
  "hasTouch": true,
  "defaultBrowserType": "webkit"   // ← 実在
}
```

`defaultBrowserType: "webkit"` が含まれる。これは iPhone の実機エンジンが
Safari / WebKit であることに合わせた Playwright 公式デバイスの既定値
(参考: <https://playwright.dev/docs/api/class-browser#browser-new-context-option-is-mobile>、
および `node_modules/playwright-core/server/deviceDescriptorsSource.json` の生データ)。

したがってプロジェクト名が `chromium-mobile` でも **実際は WebKit 用プロジェクト** として解釈される。
一方 `.github/workflows/e2e.yml` は `playwright install --with-deps chromium` で chromium しか
インストールしないため、WebKit バイナリが無く 16 件一斉起動失敗となる。

**修正**: プロジェクト側で `defaultBrowserType: 'chromium'` を明示的に上書きする。
userAgent / viewport / deviceScaleFactor / isMobile / hasTouch 等の mobile エミュレーション
設定は維持したままエンジンだけ Chromium に差し替える (Chromium は `isMobile: true` を正式
サポート — Firefox は非対応なので注意):

```ts
{
  name: 'chromium-mobile',
  use: {
    ...devices['iPhone 13'],
    defaultBrowserType: 'chromium',  // ← iPhone 13 デバイスを chromium で駆動
  },
},
```

**汎化ルール**:

1. **mobile / tablet デバイスを Playwright project に追加するときは defaultBrowserType を明示確認** する。
   `devices['iPhone *'] / devices['iPad *']` 系は WebKit、`devices['Pixel *'] / devices['Galaxy *']`
   系は chromium が既定。
2. **プロジェクト名が示すエンジンと spread したデバイスの既定エンジンが一致しない場合は必ず
   override する**。名前を信じて放置すると CI が (本家コード変更なしで) 突然 16 件 fail する。
3. **`playwright install --with-deps` コマンドの引数と project のエンジンは 1:1 で合わせる**。
   WebKit project を足すなら `--with-deps webkit` も足す。Chromium だけで済ませたいなら
   mobile project の defaultBrowserType を chromium に固定する (本件のアプローチ)。
4. **ローカルで chromium-mobile が動いて CI で落ちる場合は、まず browser バイナリ差を疑う**。
   ローカル PC は `playwright install` をフル実行していれば webkit も入っており気付きにくい。
   再現は `pnpm exec playwright install chromium --with-deps` だけした環境で
   `pnpm test:e2e --project=chromium-mobile` を叩くと再現する。

**関連**: §4.12 (視覚回帰の baseline 生成は Linux CI)、`.github/workflows/e2e.yml:101`、
`playwright.config.ts:81` (`chromium-mobile` project 定義)。

### 4.33 MFA enable 成功後の `router.refresh()` race — `page.reload()` で確定させる (§4.20 のバリアント)

**症状**: PR #114 CI で、spec 01 Step 2「admin が MFA を有効化する」が intermittent に fail:

```
Error: expect(locator).toHaveCount(expected) failed
Locator: getByRole('button', { name: 'MFA を有効化する' })
Expected: 0
Received: 1
Timeout: 10000ms
14 × locator resolved to 1 element - unexpected value "1"
```

テストログ上:
- `POST /api/auth/mfa/enable` → 200 OK (`expect(response.ok(),...).toBeTruthy()` 通過)
- `waitForLoadState('networkidle')` 通過
- しかし `MFA を有効化する` ボタンが 10s 経っても残存

**原因**: `settings-client.tsx#handleMfaEnable` は enable API 成功後に
`router.refresh()` を fire-and-forget で呼ぶ。`router.refresh()` は:
1. Server Component の再 render を引き起こす (RSC fetch が裏で飛ぶ)
2. **fetch 発火も完了待ちも外部からは await できない**

その結果:
1. テストは `waitForResponse('/api/auth/mfa/enable')` で 1 API は待てる
2. 続く `waitForLoadState('networkidle')` は RSC fetch が始まる前に 0ms で即解決
3. UI は古い mfaEnabled=false のまま、ボタンが残る
4. 10s timeout で fail

§4.20 で一覧画面の `削除後の router.refresh` race を `page.reload` 置換で解決した。
MFA enable flow も同パターン。

**対策**: `waitForLoadState('networkidle')` を `page.reload({ waitUntil: 'networkidle' })`
に置換。DB の真状態を強制取得する。

```ts
// Before (router.refresh の RSC fetch を待てず flaky)
await page.waitForLoadState('networkidle');
await expect(page.getByRole('button', { name: 'MFA を有効化する' })).toHaveCount(0, {
  timeout: 10_000,
});

// After (DB の真状態を強制取得)
await page.reload({ waitUntil: 'networkidle' });
await expect(page.getByRole('button', { name: 'MFA を有効化する' })).toHaveCount(0, {
  timeout: 10_000,
});
```

**汎化ルール — `router.refresh()` と UI assertion の race**:

1. **`router.refresh()` を呼ぶ全 UI フロー** でこの race は発生し得る:
   - 削除操作後の一覧再描画 (§4.20, §4.27)
   - 設定変更後のステータス反映 (テーマ変更 §4.23, MFA 有効化 §4.33)
   - プロジェクト編集後の表示反映
   - etc.
2. **選択肢の使い分け**:
   - **同一 URL での部分更新** (例: MFA enable, theme change): `page.reload()` で確定
   - **ナビゲーション伴う遷移**: `waitForURL` + `waitForLoadState`
   - **API 応答 + 後続 API** (verify → session update 等): 両 API の `waitForResponse` を click 前に予約
3. **`waitForLoadState('networkidle')` を単体で使わない**:
   - 「0ms で解決する現象」(§4.20) を思い出す
   - 必ず **前段の waitForResponse で特定 API を捕捉** + 後段の `page.reload` / `waitForURL` で DOM 確定

**適用箇所** (PR #114 hotfix):
- `e2e/specs/01-admin-and-member-setup.spec.ts:140`: `waitForLoadState` → `page.reload`

**関連**: §4.20 (router.refresh + 削除 race), §4.23 (テーマ変更 2 段階非同期), §4.24 (MFA verify の verify + session race), §4.27 (削除の §4.20 適用漏れ横展開)。
§4.33 は §4.20 の **MFA enable flow 版**。

---

### 4.32 UI 見出しラベルを変更したら `getByRole('heading', { exact: true })` の spec を同じ PR で更新する

**症状**: PR #113 (「メモ」→「メモ一覧」などラベル統一改修) の CI で、無関係そうな
`04-personal-features.spec.ts:107` の `メモ画面 (/memos) で作成済み個人メモが一覧に表示される`
テストが fail:

```
Error: expect(locator).toBeVisible() failed
Locator: getByRole('heading', { name: 'メモ', exact: true })
Expected: visible
Error: element(s) not found
```

**原因**: UI 改修で `<h2>メモ</h2>` を `<h2>メモ一覧</h2>` に変更したが、**同じ PR 内で**
spec の `getByRole('heading', { name: 'メモ', exact: true })` を更新し忘れた。
`exact: true` 付きの accessible name 一致なので「メモ一覧」にはヒットしない (逆に
`exact: false` なら substring で通ってしまって修正漏れに気付けない危険がある)。

**対策**: UI の label / heading を変える PR では、以下を必ず grep する:

```bash
# 変更前ラベルを exact で指定している spec を検出
grep -rn "name: '<旧ラベル>', exact: true" e2e/
grep -rn "name: \"<旧ラベル>\", exact: true" e2e/
# heading だけでなく button / label / link も同様
```

本プロジェクトでは `exact: true` を要ラベル多用 (§4.14 / §4.30 回避のため)、
旧ラベルが即 FAIL を誘発する。**UI の見出し改称は spec 更新とペア PR が必須**。

**汎化ルール — UI テキスト変更時の横展開チェックリスト**:

1. **変更前ラベルで e2e/ を grep** して exact: true な一致箇所を全洗い出し
2. **変更後ラベルで重複衝突** (他の要素との接頭辞衝突で新たな strict mode violation が
   起きないか) も確認 (§4.30 対策)
3. **spec だけでなく視覚回帰 baseline** も影響する (baseline 画像に旧テキストが焼かれて
   いるので `[gen-visual]` 再生成が必要になる、§4.31 参照)
4. **見出しだけでなく `<title>`** / ページタイトルも忘れず更新

**適用箇所** (PR #113 hotfix):
- `e2e/specs/04-personal-features.spec.ts:107`: `name: 'メモ', exact: true` →
  `name: 'メモ一覧', exact: true`
- 他 spec の `振り返り` / `リスク` 等の heading 名は現状 exact:false なので、`振り返り一覧`
  などに改称しても substring 一致で通る (ただし §4.30 リスクはあるので改称時は必ずチェック)

**関連**: §4.30 (getByLabel 接頭辞衝突) / §4.14 (合成ラベルの exact 問題).
§4.32 は **UI ラベル変更 PR の横展開漏れ** を一般化した罠。

---

### 4.38 タブ / ナビ構造を変える PR では `getByRole('tab', { name: ... })` 系 spec も同 PR で見直す (PR #145 で遭遇)

**症状**: PR #145 (feat/gantt-tab-restructure) で「ガント」タブを WBS 管理タブ内のトグル
に統合し UI から廃止 → CI の `02-project-detail-tabs.spec.ts` が fail:

```
Error: expect(locator).toBeVisible() failed
Locator: getByRole('tab', { name: 'ガント' })
Expected: visible
Error: element(s) not found
   94 |     await expect(page.getByRole('tab', { name: '見積もり' })).toBeVisible();
   95 |     await expect(page.getByRole('tab', { name: 'WBS管理' })).toBeVisible();
>  96 |     await expect(page.getByRole('tab', { name: 'ガント' })).toBeVisible();
```

タブ廃止 spec の更新が PR から漏れたため、本来削除すべき assertion がそのまま残った。

**原因**: §4.32 (UI ラベル変更時の漏れ) と同じ構造の罠だが、対象が「ラベル」ではなく
「タブ自体の存在」。ProjectDetailClient から `<TabsTrigger value="gantt">ガント</TabsTrigger>`
を削除した時に、e2e spec 内の以下 3 種類の参照を更新し忘れた:

1. `expect(getByRole('tab', { name: 'ガント' })).toBeVisible()` (廃止タブの可視性確認)
2. `tabNames = ['概要', '見積もり', 'WBS管理', 'ガント', ...]` 配列内の固定文字列
3. general user 用の同種 assertion (権限差分テストでも同じタブ確認が走る)

**対策 — タブ / ナビ構造変更 PR の横展開チェックリスト**:

```bash
# 1. 廃止タブを参照する spec を検出
grep -rn "name: '<廃止タブ名>'" e2e/specs/
grep -rn "name: \"<廃止タブ名>\"" e2e/specs/
# 2. タブ名の配列リテラル参照 (tabNames = [...]) も忘れずチェック
grep -rn "<廃止タブ名>" e2e/specs/
```

**汎化ルール**:

1. **タブ廃止時は `toBeVisible()` → `toHaveCount(0)` に置換** する (削除よりも「廃止された
   ことの証跡を spec として残す」方が、後の誤回帰時に意図がわかる)
2. **タブ名の配列リテラルから当該要素を削除**。`for ...of tabNames` ループを書いている
   spec があれば、削除しないと存在しないタブに対して click する fail が起きる
3. **権限差分テストも同時に確認**: admin 用と general 用で同じタブ確認が複数 spec に分散
   している場合があるため、1 箇所修正で満足せず grep で全箇所洗い出す
4. **URL 直アクセスのテスト** (`/projects/[id]/gantt` 等) はナビ削除しても通るので、
   敢えて残せばリグレッション検知になる (PR #145 の 07-gantt-timeline.spec.ts は維持)

**§4.32 との違い**:
- §4.32: ラベル文字列の変更 (`'メモ' → 'メモ一覧'`)
- §4.38: 要素自体の存在/非存在 (`<TabsTrigger>` の追加/削除)

両者とも「UI 構造を変える PR では spec も同 PR で更新」が原則。

**適用箇所** (PR #145 hotfix):
- `e2e/specs/02-project-detail-tabs.spec.ts:96`: `toBeVisible()` → `toHaveCount(0)` に変更
- 同 spec line 119: `tabNames` 配列から `'ガント'` を削除
- 同 spec line 146: general user 用 assertion に `toHaveCount(0)` を追加

**関連**: §4.32 (ラベル変更時の漏れ) / §5.16 (DEVELOPER_GUIDE) / DEVELOPER_GUIDE §5.7
(タブ構造の設計判断).

---

### 4.40 Next.js Link `click() + waitForLoadState('networkidle')` の race (PR #154 chromium-mobile で遭遇)

**症状**: `09-customers.spec.ts` Step 4 が chromium-mobile project で fail (chromium PC は pass):

```
Error: expect(locator).toBeVisible() failed
Locator: getByRole('heading', { name: 'e2e-202604270202055-5136-a2bc-PR111 顧客' })
Expected: visible
Timeout: 10000ms
```

trace の steps:
- Click getByRole('link') | dur: **54ms**
- Wait for load state "networkidle" | dur: **0ms** ← 即返却 (即時 idle 判定)
- Expect "toBeVisible" heading | dur: 10014ms (timeout)

**根本原因**: Next.js Link の `click()` は **client-side navigation** を起動するが、
これは内部的にイベントループに乗せるため、click() resolve 直後にはまだ network 層に
何の request も出ていない。直後に呼ぶ `page.waitForLoadState('networkidle')` は
「現在 in-flight が 0 件 = idle」と判定して **0ms で即 resolve** する。
結果、まだ navigation が始まっていない古いページに対して expect heading が走り、
heading が永遠に出てこない (= timeout)。

PC viewport では Vercel Preview のレスポンスが速く、navigation が click 完了直前に
始まることが多く偶然 race を回避できることが多い。chromium-mobile (= iPhone 13
emulation) は CPU throttle + viewport 計算負荷で僅かにイベントループ遅延が増え、
race を踏みやすくなる。

**修正パターン**: `Promise.all([waitForURL, click])` で navigation を確実に anchor:

```ts
// NG: 0ms で即 resolve する race あり
await page.getByRole('link', { name: ... }).first().click();
await page.waitForLoadState('networkidle');
await expect(page.getByRole('heading', { name: ... })).toBeVisible({ timeout: 10_000 });

// OK: waitForURL を click と同時に投入 (navigation 完了を確実に待つ)
await Promise.all([
  page.waitForURL(/\/customers\/[a-f0-9-]+/),
  page.getByRole('link', { name: ... }).first().click(),
]);
await page.waitForLoadState('networkidle');
await expect(page.getByRole('heading', { name: ... })).toBeVisible({ timeout: 10_000 });
```

**§4.20 / §4.19 との区別**:
- §4.20: `router.refresh()` の race (re-fetch + re-render の遅延、`page.reload()` で確定)
- §4.19: 長い非同期チェーン経由の click (API response 予約で区切る)
- §4.40 (本件): **Next.js Link client-side navigation** の race (waitForURL で確実に anchor)

**横展開ルール**:
新規 spec で `getByRole('link', ...).click()` を書く場合、後続が「URL 遷移後の DOM」を
期待するなら **常に `Promise.all([waitForURL, click])` で書く**。`waitForLoadState`
単独は「現在 idle なら即 resolve」の意味であり、navigation 開始を待つ保証がない。

**関連**: §4.20 (router.refresh race) / §4.19 (長い click chain) /
docs/developer/DEVELOPER_GUIDE.md §10.5 (CI race パターン集)

---

### 4.39 新規マイグレーションを含む PR は E2E pass でも本番 DB に未適用なら 500 になる (構造的ギャップ、PR #149 で遭遇)

**症状**: PR #149 (ステークホルダー管理機能) を main にマージし Vercel の本番デプロイ完了後、
プロジェクト詳細「ステークホルダー」タブを開くと 500 Internal Server Error。Server log:

```
Error [PrismaClientKnownRequestError]: Invalid `prisma.stakeholder.findMany()` invocation:
The table `public.stakeholders` does not exist in the current database.
code: 'P2021'
```

CI 上は E2E + 全 821 テスト pass。production build も成功してマージされていた。

**根本原因**: 構造的なギャップで、E2E では原理的に検知不可:

| 環境 | スキーマ適用方法 |
|---|---|
| ローカル開発 | `npx prisma migrate dev` で手動適用 (開発者の責務) |
| **CI E2E テスト DB** | CI セットアップで `prisma migrate deploy` を **自動実行** |
| **本番 Supabase DB** | `vercel.json` の buildCommand に migrate を **含めない** ため **手動適用** が必須 (OPERATION.md §3.3) |

→ E2E は「テスト DB にマイグレーション済」を前提に走るため、コード上「新規テーブル X を
参照するが本番 DB に X が無い」パターンは通り抜ける。本番デプロイ後にユーザが画面を
開いた時点で初めて発覚する。

**なぜ Vercel buildCommand に migrate を入れていないか** (OPERATION.md §3.3):
- Vercel ビルド環境は IPv4 のみで Supabase 直結 URL `db.[ref].supabase.co:5432` に到達不可
- DIRECT_URL を Supavisor セッションモード (`pooler.supabase.com:5432`) に切替えれば
  自動化可能だが、現状は採用していない (本件をきっかけに再検討の価値あり)

**当面の対策 (運用ルール強化)**:

1. **新規 migration を含む PR をマージしたら必ず**:
   - OPERATION.md §4 の「適用済みマイグレーション一覧」に追記
   - Supabase ダッシュボード → SQL Editor で `prisma/migrations/<name>/migration.sql` を
     手動実行 (§3.3 の手順)
2. **マージ後の確認**: 本番 URL で新機能の画面を 1 度開き、500 が出ないことを
   目視確認。テストでは検知できないため人間の最終ゲート。
3. **migration を新設する PR の説明欄**: マージ後の運用作業 (Supabase SQL 適用 +
   OPERATION.md 追記) を必ず Test plan / Post-merge checklist セクションに明記する。

**将来的な構造的解消候補** (将来 PR):

- (a) Vercel buildCommand に `prisma migrate deploy` 追加 (DIRECT_URL を pooler 5432
  に切替えてから)
- (b) post-deploy smoke test workflow: 本番 URL に対して critical な API endpoints を
  1 リクエストずつ叩いて HTTP 200 を確認する CI ジョブ
- (c) GitHub Actions の `on: push to main` で Supabase に直接 `psql` で migrate を
  流す (secrets に DIRECT_URL を保持)

**E2E と本番の違いを認識する観点ルール**:

E2E pass = コードロジックは正しい (テスト DB スキーマと一致)。
**E2E pass ≠ 本番動作保証**。スキーマ依存の機能を追加した PR は **必ず人間が本番で
1 度動作確認する** ことを徹底する。

**関連**: OPERATION.md §3.3 (Supabase 本番への適用手順) / OPERATION.md §4 (適用済み
マイグレーション一覧) / OPERATION.md §3.4 (自動化案、未採用)

---

### 4.31 `[gen-visual]` で baseline を生成しても並列 CI と条件が違って一覧画面は再 fail する

**症状**: PR #111-2 で新規追加した `e2e/visual/customers-screens.spec.ts` の
`customers-list-light.png` が `[gen-visual]` workflow での baseline 生成後の
通常 E2E CI で **ratio 0.20 (247101 px) の pixel diff** で fail:

```
Error: expect(page).toHaveScreenshot(expected) failed
  247101 pixels (ratio 0.20 of all image pixels) are different.
  Snapshot: customers-list-light.png
  (Retry #1 / #2 も同じ diff で fail)
```

**原因**: baseline workflow と通常 E2E CI で **DB の顧客行数が一致しない**:
- `[gen-visual]` workflow は visual spec のみ (or 単独 job) で動くため、
  `/customers` 一覧の tbody は自身が作成した 1 行のみ
- 通常 E2E CI は **9 spec 並列** (spec 01/09 が別々に顧客を作成)、
  同じ beforeAll タイミングに tbody が 5〜10 行並ぶ

`mask: [page.locator('tbody')]` を設定していても解決しない:
- mask は「撮影時点の DOM 要素の bounding box」をピンクで塗りつぶすため、
  行数が増えて tbody の高さが伸びると **ピンクの矩形座標** が baseline と異なる
- mask 外の下部領域 (footer, scroll 表示) も layout shift で差分化

**対策**: §4.15 の対策 a を踏襲し、**一覧画面の視覚回帰を丸ごと削除**。

```ts
// NG (mask しても並列 CI で fail)
test('顧客一覧画面 (light テーマ)', async () => {
  await expect(page).toHaveScreenshot('customers-list-light.png', {
    fullPage: true,
    mask: [page.locator('tbody')],  // ← 行数変動で座標ずれて無意味
  });
});

// OK (視覚回帰から除外し、主要回帰は settings-themes の 10 テーママトリクス任せ)
// /customers 一覧は spec 09 の機能 E2E で構造カバー済み。視覚はテーマトークン
// レベルで settings-themes がカバーするため、画面ごとの追加は不要。
```
</code>

**汎化ルール — 新規視覚回帰 spec を追加する際の判定フロー**:

1. **単独スコープ画面か?** (自分が作ったデータだけが表示される、例: /customers/[id], /projects/[id])
   → 対策 b: データを固定日付・固定内容で seed して視覚回帰対象化 OK
2. **全体スコープ画面か?** (全 user / 全 project / 全顧客が載る一覧、例: /customers, /projects)
   → 対策 a: 視覚回帰から除外。主要回帰は settings-themes 等の単独スコープ画面で担保
3. **baseline workflow と通常 CI で DB 状態が異なる** のを大前提として設計する
   (baseline 生成時の DB を「理想化された条件」と期待してはいけない)

**適用箇所** (PR #111-2 hotfix):
- `e2e/visual/customers-screens.spec.ts`: `customers-list-light` test を削除
- baseline PNG (`customers-list-light-chromium-linux.png`) も合わせて削除
- `/customers/[id]` 詳細のみ残す (単独スコープで決定的)

**関連**: §4.15 (動的コンテンツの mask 不可), §4.22 (視覚回帰で動的 state).
§4.31 は §4.15 の **「mask でも対応不能で削除以外に手段なし」** という具体事例。

---

### 4.30 `getByLabel('担当者')` は「担当者メール」にも部分一致して strict mode violation

**症状**: PR #111-2 の CI で `09-customers.spec.ts` Step 3 「新規顧客をダイアログから登録」が fail:

```
Error: locator.fill: Error: strict mode violation: getByLabel('担当者') resolved to 2 elements:
  1) <input id="customer-contact-person">  (<Label>担当者</Label>)
  2) <input id="customer-contact-email">   (<Label>担当者メール</Label>)
```

**原因**: Playwright の `getByLabel()` は **正規化された accessible name の部分一致** で要素を探す。
「担当者」は「担当者メール」の接頭辞なので、両方の input がヒット → strict mode で error。

プロジェクト内で今までこの罠を踏まなかったのは、単にラベル名が偶然すべて一意だっただけ。
**顧客管理のように同一リソース内で similar な日本語ラベルを複数持つと顕在化する**。

**対策**: 接頭辞で衝突しうるラベルは **`{ exact: true }`** を第 2 引数に渡して厳密一致させる。

```ts
// Before (「担当者」が「担当者メール」にも一致して fail)
await page.getByLabel('担当者').fill('山田 太郎');

// After (accessible name === '担当者' の要素のみ)
await page.getByLabel('担当者', { exact: true }).fill('山田 太郎');
```

**汎化ルール — spec でラベル照合する際のチェックリスト**:

1. **日本語の短いラベル** (2〜4 文字) は接頭辞衝突しやすい。書く時点で `{ exact: true }` を基本にする
2. **フォーム内で類似語彙** (「担当者 / 担当者メール」「顧客名 / 顧客名カナ」等) が存在するなら必須
3. 既存 spec の `getByLabel('X')` を変更する場合、**同じ画面に X を接頭辞に持つラベルが新しく
   増えていないか** を確認する (UI 変更時の横展開)
4. どうしても label text の管理が手間なら `page.locator('#customer-contact-person')` のように
   **id 直接指定** に逃げる選択もある (a11y ツリーに乗らないが安定)

**適用箇所** (PR #111-2):
- `e2e/specs/09-customers.spec.ts`: 新規登録ダイアログ / 編集ダイアログの両方で
  `顧客名 *` / `部門` / `担当者` を exact:true 化
- 既存 spec への横展開は、今後類似語彙を追加する PR ごとにチェックする (原則 `{ exact: true }` デフォルト)

**関連**: §4.14 (合成ラベルのボタンは exact で取れない) — 逆方向の罠 (exact にすると失敗) だが、
**「Playwright の text matching が非直感的」という本質的問題** は共通。

---

### 4.29 `Project.customer_id NOT NULL` 化でテストフィクスチャ + 直書き POST が破壊される

**症状**: PR #111-2 (Project.customer_name → customer_id FK 移行) の CI で、**本 PR と無関係な**
`01-admin-and-member-setup.spec.ts` Step 5 (admin API でプロジェクト作成) が fail:

```
expect(res.ok()).toBeTruthy();
Received: false      ← POST /api/projects が 400 VALIDATION_ERROR
```

**原因**: spec 01 は fixture `createProjectViaApi` を使わず **spec 内で直接 POST** していた。
PR #111-2 で validator から `customerName` を削除して `customerId: UUID` に変更したため、
`customerName: withRunId('顧客')` を送っている旧コードは zod validation で弾かれる。

fixture (`createProjectViaApi`) は本 PR で **customerId を内部自動生成** するように更新済だが、
**fixture を経由しない呼び出し元** は検出できず見逃した。grep で `page.request.post.*projects`
を探せば一発だが、PR 作成時には意識から漏れていた。

**対策**: 修正は 2 点 — 直書き POST 側を `customerId` に切替 + 顧客を先に API で作成:

```ts
// Before
const res = await page.request.post('/api/projects', {
  data: { name, customerName: 'xxx', ... },
});

// After (PR #111-2)
import { createCustomerViaApi } from '../fixtures/project';
const { id: customerIdForProject } = await createCustomerViaApi(page, {
  name: withRunId('顧客'),
});
const res = await page.request.post('/api/projects', {
  data: { name, customerId: customerIdForProject, ... },
});
```

**汎化ルール — モデル層の破壊的変更を PR で入れる時の横展開チェックリスト**:

1. **API スキーマ (zod validator)** が変わったら、grep で「そのフィールドを送る箇所」を全検索
   - `grep -rn "'customerName'" src/ e2e/` 等、リテラル名で探す
   - fixture を経由せず直接 `page.request.post` している spec は個別修正が必要
2. **fixture の default 値** を更新してもそれだけでは不十分。**既存テストが fixture の挙動に
   暗黙的に依存している**ので、型が変われば呼び出し元を一斉修正する
3. **CI を走らせるまで気付かない** ことが多いので、fixture 更新時は必ず `grep` で呼出元を
   確認 + 不整合を検出する (理想的には TypeScript 型で fixture return 型を変えて検出させる)

**関連**: §4.28 (PR #110 の mfa epochTolerance) と同じ「**無関係 spec の fail が真因**」パターン。
単体テストで対策しづらいので、CI の E2E が最終防衛線になる。

---

### 4.28 MFA verify の 400 は TOTP の時刻ずれ (otplib の epochTolerance) が真因

**症状**: PR #110 (顧客管理機能追加) の CI で、**本 PR と無関係な** `01-admin-and-member-setup.spec.ts`
Step 5 (admin 再ログインでプロジェクト作成) が intermittent に fail:

```
Error: MFA verify failed: 400
expect(received).toBeTruthy()
Received: false

  >  253 |     const mfaRes = await verifyRes;
     254 |     expect(mfaRes.ok(), `MFA verify failed: ${mfaRes.status()}`).toBeTruthy();

Error: page.waitForResponse: Target page, context or browser has been closed
  (後続の sessionRes を await している途中で afterAll の sharedPage.close() が走る)
```

**原因**: `src/services/mfa.service.ts` の `verifyTotp` が `otplib.verifySync({ token, secret })`
を **`epochTolerance` 未指定** (既定 0) で呼んでいた。

`otplib` の既定動作では、**コード生成時刻と検証時刻が同一 period (30 秒幅) 内** にないと
`.valid = false` を返す。つまり:

1. E2E (Step 5) が `generateTotpCode(mfaSecret)` で time=T 時点のコードを生成
2. `page.getByLabel('認証コード').fill(code)` → click → verify API に到達するまでに数秒かかる
3. CI 負荷 + 並列 workers + Step 1-4 の累積で、T から数十秒経過して **period 境界を跨ぐ**
4. サーバは現在時刻 T' の period で検証 → 生成時刻 T の period と違う → **400 Bad Request**

この race は「通る日もある」が、**CI 実行時間の変動** (customer 追加で test 件数 646 → 671 に増加した等)
で閾値を越えた瞬間に顕在化する。PR #110 の E2E 初回 CI で初めて観測された。

**対策**: `verifySync` に **`epochTolerance: 30`** (= ±1 window = ±30 秒) を渡す。

```ts
// Before (epochTolerance 既定 0、境界跨ぎで fail)
const result = otplib.verifySync({ token: totpCode, secret });

// After (±30 秒許容、CI の time-skew 耐性)
const result = otplib.verifySync({
  token: totpCode,
  secret,
  epochTolerance: 30,
});
```

**なぜ epochTolerance=30 が安全か**:

- **RFC 6238 §5.2** (Validation and Time-Step Size) が時刻ずれ許容を推奨:
  > "We RECOMMEND that at most one time step is allowed as the network delay."
- **業界標準**: Google Authenticator / AWS MFA / Microsoft Authenticator が同様の許容を採用
- **セキュリティ影響**: TOTP コード空間は 10^6 (6 桁)。ブルートフォースは 1 秒 1 コードでも **11 日**かかる。
  許容 window を 2 倍 (1 → 3) にしても攻撃成功率は数学的に誤差レベル。
- **ロック機構との併用**: 本プロジェクトは 5 回失敗で一時ロック・3 回目で恒久ロックのため、
  ブルートフォースは実質不可能。

**汎化ルール — TOTP を扱うサービスの時刻ずれ耐性**:

1. **サーバ側**: 検証 API で **必ず epochTolerance (or window) を設定**。既定値は危険。
   - 推奨: 30 秒 (= 1 period)
   - 高セキュリティ要件なら [30, 0] (過去のみ許容)
2. **テスト側**: TOTP コード生成を **click 直前** に実施 (本プロジェクトは既に対応済)
3. **監視**: MFA verify の 400 連発は time-skew の兆候。サーバ時刻同期 (NTP) も確認

**適用箇所** (PR #110 hotfix):
- `src/services/mfa.service.ts` の `verifyTotp` / `enableMfa` / `verifyInitialTotpSecret` の 3 関数
  すべてに `TOTP_EPOCH_TOLERANCE_SEC = 30` を適用
- unit test (mfa.service.test.ts) に 3 ケース追加:
  - 前 period のコードを許容する
  - 次 period のコードを許容する
  - 60 秒以上離れたコードは拒否する (過剰許容防止)

**関連**: §4.19 (長い非同期チェーン), §4.24 (verify + session 両 API 待機). §4.28 はサーバ側の
`verifyTotp` 実装そのものの時刻ずれ耐性で、E2E だけの対応では解決不能なサーバ仕様問題。

### 4.27 アセットディレクトリを空にすると CI の `cp -r public` が fail する (空ディレクトリ問題)

**症状**: PR #103 (dotenv 追加のみの独立 PR) の CI で、**無関係な** `06-wbs-tasks.spec.ts`
「Activity を UI から削除できる」が intermittent に fail:

```
Test Steps:
  ✓ Click 削除ボタン                          60ms
  ✓ Accept dialog                             0ms
  ✓ Wait for load state "networkidle"         1ms    ← 🚩 router.refresh 未発火
  ✗ Expect toHaveCount 0 (Activity 行消失)    10s timeout
    - 14 × locator resolved to 1 element
    - unexpected value "1"
```

**原因**: §4.20 と同根 (`router.refresh()` fire-and-forget) だが、**削除テスト
特有の重複要因** で race がより顕著になる:

1. `page.once('dialog', ...)` で `window.confirm` 承諾 → **asynchronous な UX パス**
2. click → `onClick` ハンドラ → (microtask) `confirm()` 評価 →
   「承諾」選択 → `fetch DELETE` 発火 → `router.refresh()` 呼び出し
3. **この間ずっと Playwright の click は返り値を持たない** ので、
   外側から見ると「何が終わったのか」が見えない
4. `waitForLoadState('networkidle')` を呼んだ時点で:
   - fetch DELETE はまだ flight の可能性
   - router.refresh の RSC fetch はまだ未発火の可能性
   - **全て未決の状態で 1ms で idle 判定される**
5. 続く `toHaveCount(0)` は UI 未更新の行を見続けて 10s timeout

§4.20 で確立したパターン (waitForResponse + page.reload) を、一部の削除テスト
(`04-personal-features.spec.ts` / `06-wbs-tasks.spec.ts`) に **適用し忘れて
いた** のが真因。PR #97 の時点で 08-estimates 系のみ適用済みで横展開が不完全だった。

**対策テンプレート** (全 `page.once('dialog', ...)` 系の削除テストで統一):

```ts
// ①click 前に DELETE API を予約 (必須)
const deleteRes = page.waitForResponse(
  (r) => r.url().includes('/api/<resource>/') && r.request().method() === 'DELETE',
);
// ②dialog 承諾を予約 (必須、click より前)
page.once('dialog', (dialog) => dialog.accept());

// ③click (handler 内で confirm → fetch DELETE → router.refresh が走る)
await row.getByRole('button', { name: '削除' }).click();

// ④DELETE の完了を明示的に確認 (race 排除)
const res = await deleteRes;
expect(res.ok(), `DELETE failed: ${res.status()}`).toBeTruthy();

// ⑤DB は更新済み。router.refresh の race を回避して UI を DB 真状態に強制同期。
await page.reload({ waitUntil: 'networkidle' });

// ⑥消失確認 (ここは race せず確実に解決する)
await expect(...).toHaveCount(0, { timeout: 10_000 });
```

**なぜ 5 ステップ全部が必要か**:
- ①②④を省くと dialog 承諾 + fetch 完了を待てず、`click` は 60ms で返ってしまう
- ⑤を省くと `router.refresh()` が発火前のタイミングで count 検査が始まり 10s timeout
- ⑥ の `toHaveCount(0)` は強制 reload 後なので確実 (任意の timeout でも良い)

**汎化ルール — `page.once('dialog', ...)` が出てくる spec**:

検索で `page.once('dialog'` を grep し、すべての発生箇所で上記 5 ステップが
揃っていることを確認する。欠けている spec があれば即適用 (PR #106 で
04/06 に適用、08 は既適用、05 は `waitForURL` 経由で別パターン)。

| spec | 削除対象 | §4.20/§4.26 適用状況 |
|---|---|---|
| `04-personal-features.spec.ts` | memo | ✅ 適用 (PR #106) |
| `05-teardown-and-residuals.spec.ts` | project | ✅ 別 pattern (router.push + waitForURL、§4.18 相当) |
| `06-wbs-tasks.spec.ts` | Activity | ✅ 適用 (PR #106) |
| `08-estimates.spec.ts` | estimate | ✅ 適用済 (PR #97) |

**CI 環境での再現性の考察**:

無関係 PR #103 (dotenv 追加のみ) で今回初めて顕在化した理由は、CI 負荷の tick で
Next.js の RSC fetch タイミングが遅れ、本来 networkidle 直後には in-flight だった
fetch が検知できなかったため。ローカル実行や他の CI run では通っていた可能性が高い。
**race は本質的に tick 依存なので「通る日もある」が、いずれ確実に fail する**。
適切な wait (§4.26 5 ステップ) で race 自体を排除するのが唯一の根本対策。

**関連**: §4.18 (waitForResponse reservation), §4.19 (長い非同期チェーンの分割),
§4.20 (router.refresh race → page.reload), §4.24 (MFA session + navigation race).
§4.26 はこれら削除系への統一適用ルール。

### 4.27 アセットディレクトリを空にすると CI の `cp -r public` が fail する (空ディレクトリ問題)

**症状**: PR #100 (デフォルト SVG 5 件を `public/` から全削除) の Playwright E2E
ワークフロー "Prepare standalone assets" step で fail:

```
Run cp -r public .next/standalone/
cp: cannot stat 'public': No such file or directory
Error: Process completed with exit code 1.
```

ビルド (`next build`) は成功、その後の **standalone 組み立て step** で `public/` が
存在しない。ローカル開発や他 PR では通っていた `.github/workflows/e2e.yml` が、
SVG 削除 PR だけで赤くなった。

**原因**: **Git は空ディレクトリを tracked しない** 仕様:

1. PR #100 で `public/` 配下のファイル 5 件をすべて削除
2. `public/` ディレクトリ自体は local には空で残るが、**git に commit されていない**
3. CI ランナーが fresh clone すると `public/` は存在しない
4. `next build` は public なしでも通る (内容が無いので含めるものがない)
5. **`cp -r public .next/standalone/` は public ディレクトリ自体の存在を要求** → fail

Next.js standalone build の仕様で `public/` は standalone 出力に自動で含まれない
ため、workflow 側で手動 `cp -r public .next/standalone/` している
([Next.js 公式ドキュメント](https://nextjs.org/docs/app/api-reference/next-config-js/output#automatically-copying-traced-files))。
これは一般的なプラクティスで、public にアセットがある前提。

**対策** (2 通り、本プロジェクトは (1) を採用):

**(1) `public/.gitkeep` で空ディレクトリを保持** ← 本プロジェクト採用
```bash
# アセット全削除と同時にコミットする
touch public/.gitkeep
git add public/.gitkeep
git commit
```
- メリット: workflow は変更不要、public/ の「存在」が git で保証される
- デメリット: 将来 public に実アセットが入ったら .gitkeep は慣例として残すか削除するか判断が必要 (Next.js 規約的にはどちらでも OK)

**(2) workflow を defensive に書く**
```yaml
- name: Prepare standalone assets
  run: |
    [ -d public ] && cp -r public .next/standalone/ || true
    cp -r .next/static .next/standalone/.next/
```
- メリット: public 不要なサービスでも通る
- デメリット: 本来必要な場面で public が無いことを検知できなくなる (silent failure)

**汎化ルール — アセット/バイナリディレクトリの整理 PR の鉄則**:

以下のいずれかの作業をする PR では、**必ず `.gitkeep` の同時 commit を確認する**:

- `public/*` 系ディレクトリ内のファイルを全削除
- `docs/performance/*` 系の計測データディレクトリを全削除 (PR #101 事例)
- その他、**「空になる可能性があるディレクトリ」** から最後のファイルを消す時

**検出方法** (PR レビュー時):

```bash
# 削除後のディレクトリが空になっていないか確認
git status  # ← "deleted: public/x.svg" 5 件があっても空ディレクトリは表示されない
find <target-dir> -type f  # ← 出力が空なら .gitkeep が必要
```

ワークフローで `cp -r <dir>` しているパスを grep する手もある:
```bash
grep -rE "cp -r |copy-item.*-recurse" .github/workflows/
```

**関連**:
- PR #101 で `docs/performance/20260417/before/*` と `after/タスク更新処理パフォーマンス/`
  を全削除した際には CI 側で `cp` していなかったため問題なし (.gitkeep 不要と判断)
- `public/` のように **build 成果物に明示 copy する** ディレクトリだけが本問題の対象

### 4.25 Suspense streaming 過渡で CardTitle が一瞬重複し strict mode violation

**症状**: PR #98 CI で `e2e/specs/00-smoke.spec.ts` の
「ログイン画面が表示される」が strict mode violation で fail:

```
Error: strict mode violation: getByText('たすきば', { exact: true }) resolved to 2 elements:
  1) <div data-slot="card-title" class="font-heading ...">たすきば</div>
  2) <div data-slot="card-title" class="font-heading ...">たすきば</div>
```

両方が完全同一の CardTitle div。retry ラウンドで:
- Run (初回): 589ms で fail (strict mode は retry しない即時失敗)
- Retry #1: 819ms で fail
- Retry #2: 1.7s で pass (この時点で DOM が 1 要素に収束)

**原因**: [`src/app/(auth)/login/page.tsx`](../../src/app/(auth)/login/page.tsx) は
LoginForm を `<Suspense>` で包んでいる。React 19 + Next.js 16 の RSC streaming で:

1. Server が初期 HTML を送信 (Suspense boundary 内は後送)
2. RSC chunk が流れて Suspense 内容が hydrate される
3. **hydrate 過渡の一瞬**、同一 CardTitle ノードが shadow/template 風に DOM 上で
   二重に観測されることがある (fallback 未指定の場合でも streaming の内部 marker
   が関与すると推測)
4. hydrate 完了後は 1 要素に収束

`page.goto()` は `load` イベントまで (= DOMContentLoaded + 同期リソース) しか待たず、
**hydration 完了は load イベントとは独立**。load 直後に getByText を評価すると
strict mode の 2 要素検知で即 fail する。

**対策**:

```ts
await page.goto('/login');
await page.waitForLoadState('networkidle');  // hydration まで待つ
await expect(page.getByText('たすきば', { exact: true }).first()).toBeVisible();
// ↑ 万が一 networkidle でも race が残る場合の safety net として .first() を併用
```

- `waitForLoadState('networkidle')`: 全 RSC chunk + prefetch が fully in-flight でなく
  なるまで待つ。これで **hydration はほぼ完了**
- `.first()`: strict mode を緩和。仮に transient な 2 要素状態が残っていても最初の
  visible で判定 (視覚検証としては十分)

**汎化ルール — Suspense streaming を使うページに対するテスト**:

次のいずれかに該当するページで `getByText` / `getByRole` を使う場合:
- `<Suspense>` ラップが存在
- `loading.tsx` / `error.tsx` が同階層にある
- parallel routes / intercepting routes を含む

→ **assertion 前に `waitForLoadState('networkidle')` を必ず入れる** + strict mode
   violation の可能性がある text locator には `.first()` を付ける。

**適用済み箇所** (PR #98 hotfix):
- `e2e/specs/00-smoke.spec.ts` (ログイン画面)
- `e2e/specs/01-admin-and-member-setup.spec.ts` Step 4 (/setup-password)

### 4.24 next-auth MFA verify 後のナビゲーションは verify + session 両 API を待つ

**症状**: PR #98 CI で `specs/01-admin-and-member-setup.spec.ts` Step 5 が
`waitForProjectsReady` 内の `waitForURL('**/projects', { timeout: 15_000 })` で
15s タイムアウト:

```
TimeoutError: page.waitForURL: Timeout 15000ms exceeded.
waiting for navigation to "**/projects" until "load"
  navigated to "http://localhost:3000/login/mfa"
  navigated to "http://localhost:3000/login/mfa"
```

MFA verify API は 431ms で 200 OK を返しているのに、URL が `/login/mfa` から動かない。

**原因**: [`src/app/(auth)/login/mfa/mfa-form.tsx`](../../src/app/(auth)/login/mfa/mfa-form.tsx)
の handleSubmit は 3 段階の非同期を持つ:

```ts
const res = await fetch('/api/auth/mfa/verify', {...});  // ①verify API
// ... res.ok チェック
await update({ mfaVerified: true });                     // ②POST /api/auth/session
window.location.href = callbackUrl;                      // ③ナビゲーション
```

`update({ mfaVerified: true })` は next-auth v5 が内部で **独立した
POST /api/auth/session** を発火し JWT cookie を再発行する。従来のテストは ① のみ
`waitForResponse` しており、② が完了する前に `waitForProjectsReady` に入るため、
**② の完了時間 + ③ の遷移 + middleware 処理 + /projects の描画** を 15s budget 内に
全部収めなければならない。

並列 CI (workers=2 + Supabase pool + Next.js JIT ウォーム不足) では:
- ② の POST /api/auth/session が数秒〜10 秒以上
- さらに /api/auth/session が何らかの理由で遅れたり失敗すると ③ (`window.location.href`)
  自体が呼ばれず URL が /login/mfa から動かない

§4.23 (テーマ変更の page.reload race) と同じ **「独立した session 更新 API を待たない
テスト」** の構造問題。テーマは page.reload、MFA はナビゲーションという違いだけ。

**対策**: **verify API + session API の両方を click 前に並行予約し、両方 await**:

```ts
const verifyRes = page.waitForResponse(
  (r) => r.url().includes('/api/auth/mfa/verify') && r.request().method() === 'POST',
);
const sessionRes = page.waitForResponse(
  (r) => r.url().includes('/api/auth/session') && r.request().method() === 'POST',
);
await page.getByRole('button', { name: '検証' }).click();
const res = await verifyRes;
expect(res.ok()).toBeTruthy();
await sessionRes;  // ← これで JWT 更新完了を保証
await waitForProjectsReady(page);  // 残り 15s は純粋に /projects 遷移のみに消費
```

**汎化ルール — §4.23 の拡張**:

next-auth `useSession().update()` を呼ぶ click ハンドラでは、click 後のテスト挙動に応じて
待ち方が 2 種類に分岐する:

| click 後にテストが何をする? | 必要な待機 |
|---|---|
| `page.reload()` で SSR 再実行 (テーマ切替等) | `waitForResponse(session POST)` **必須** + 成功メッセージ UI 確認 (§4.23) |
| 別 URL へナビゲーション (MFA 検証後の /projects 等) | `waitForResponse(session POST)` **必須** + 続けて waitForURL (§4.24) |
| 同一 URL で client state の変化のみ検証 (useSession 再レンダ) | aria-checked 等 client 属性で十分 (session 待機不要) |

**検出方法**: click ハンドラを grep。`update\(\{` / `useSession\(\)\.update` を検知したら
`/api/auth/session` POST を **必ず** 予約待ちする。

**適用済み箇所** (PR #98 hotfix):
- `e2e/fixtures/auth.ts` `loginAsAdminWithMfa`
- `e2e/specs/01-admin-and-member-setup.spec.ts` Step 2b / Step 5

**関連**: §4.18 (waitForResponse reservation), §4.19 (長い非同期チェーンの分割待機),
§4.23 (テーマ変更の JWT race).

### 4.23 next-auth `updateSession()` は独立した API 呼び出し — PATCH だけ待っても不十分

**症状**: PR #97 hotfix 3 で §4.22 (page.reload + data-theme 確証) を適用したが、
次の CI run で **別のテーマ (dark) の data-theme アサーションが 10s タイムアウト**:

```
Error: expect(locator).toHaveAttribute(expected) failed
Locator: locator('html')
Expected: "dark"
Received: "light"
Timeout: 10000ms
```

テストログ:
```
✓ Navigate to /settings
✓ networkidle
✓ Wait for response (PATCH /api/settings/theme) 130ms
✓ Click radio
✓ page.reload 733ms
✗ toHaveAttribute data-theme = "dark" 10s timeout (received "light")
```

page.reload が完了しているのに、**SSR が古いテーマを返し続けている**。

**原因**: テーマ変更フロー (`settings-client.tsx handleThemeChange`) は
**2 段階の非同期操作** を持つ:

```ts
// settings-client.tsx handleThemeChange
const res = await fetch('/api/settings/theme', {...});  // ①DB 更新
if (!res.ok) { ... return; }
await updateSession({ themePreference: next });         // ②JWT cookie 更新
setThemeSuccess('テーマを変更しました');                  // ③UI 成功メッセージ
router.refresh();                                       // ④RSC 再取得
```

`updateSession()` は next-auth v5 が内部で **POST /api/auth/session** を呼んで
JWT cookie を差し替える、**①と独立した HTTP request**。

`<html data-theme>` の値源泉は `layout.tsx` の `await auth()` →
`session.user.themePreference` で、これは **リクエストに付随する JWT cookie** から
デコードされる。つまり ② が完了していない状態で `page.reload()` を呼ぶと:

1. Playwright が古い JWT cookie を持ったまま GET /settings
2. layout.tsx が古い JWT を読む → `themePreference = 'light'`
3. SSR が `<html data-theme="light">` を吐く
4. reload 完了 — でも data-theme は切り替わっていない

hotfix 3 のテストは ①(PATCH) しか `waitForResponse` で待っていなかったため、
②(POST /api/auth/session) が click → reload の間に完了する保証が無く、race を
踏み続けていた。

**対策**: **両方の API 呼び出しを click 前に予約して、両方の完了を待つ**:

```ts
const themeRes = page.waitForResponse(
  (r) => r.url().includes('/api/settings/theme') && r.request().method() === 'PATCH',
);
const sessionRes = page.waitForResponse(
  (r) => r.url().includes('/api/auth/session') && r.request().method() === 'POST',
);
await page.getByRole('radio', { name: uiLabel }).click();
await themeRes;
await sessionRes;  // ← この行が hotfix 3 に欠けていた真因
// 二重保険: UI signal も待つ
await expect(page.getByText('テーマを変更しました')).toBeVisible();
await page.reload({ waitUntil: 'networkidle' });  // JWT 更新後なので SSR は新テーマを返す
```

**汎化ルール — next-auth `updateSession()` を伴う click**:

next-auth v5 の `const { update } = useSession()` で **session を更新する画面** は、
click → `await update()` という形で **独立した /api/auth/session POST** を発火する。
この API を待たずに reload / ナビゲーションすると、**JWT cookie が古いまま
次ページの SSR が走る** → session 依存の属性が古い値のまま。

以下の要素が session 経由でレンダリングされる場合、全て同じ race を抱える:
- `<html data-theme>` (テーマ)
- `<html lang>` (言語設定)
- サイドバー権限表示 (ロール情報)
- アバター / 表示名 (プロフィール更新直後)

対策の判別表:

| UI が session を読むタイミング | E2E での待ち方 |
|---|---|
| CSR (クライアント側 `useSession()` の再レンダ) | `aria-checked` 等 client state の assertion で十分 |
| **SSR (layout.tsx / page.tsx での `auth()`)** | `waitForResponse(/api/auth/session POST)` **必須** |

**検出方法**: テスト対象の click ハンドラを grep して `updateSession` /
`useSession().update` を呼んでいるか確認。呼んでいれば **両 API を並行予約** する。

**関連**: §4.18 (waitForResponse reservation pattern), §4.20 (page.reload で
DB 真状態取得), §4.22 (視覚回帰で SSR 属性確証). §4.23 は §4.22 の **深掘り** で、
「page.reload が有効に働くためには JWT が更新済みである必要がある」という前提を
明文化したもの。

### 4.22 視覚回帰で動的 state (テーマ等) を撮るときは属性確証 + page.reload を併用

**症状**: `settings-theme-dark.png` の視覚回帰が **pixel 差分 98%** で fail。
diff 画像はほぼ全面が赤で、2 枚の画像が **まったく別物** であることを示す。

```
1689066 pixels (ratio 0.98 of all image pixels) are different.
```

**原因**: テーマ変更フローで **実描画のトリガが 2 段階** ある:

1. クライアント側 state 更新 — radio の `aria-checked` は即時切替
2. **サーバ側 SSR 再実行 が必要** — `<html data-theme="xxx">` は `layout.tsx` で
   `await auth()` → `session.user.themePreference` から生成される。つまり
   router.refresh の RSC 再取得 (Server Component 再実行) が完了して初めて更新される

テストコード (hotfix 前):
```ts
await page.getByRole('radio', { name: uiLabel }).click();
await themeRes;  // PATCH 完了を待つ
await page.waitForLoadState('networkidle');  // 0ms で解決する race あり (§4.20)
await expect(radio).toHaveAttribute('aria-checked', 'true');  // ← OK
await expect(page).toHaveScreenshot(...);  // ← <html data-theme> 未更新で古いテーマを撮る
```

aria-checked は true (radio 選択は即時)、でも data-theme が未切替 = **ライトテーマの
背景 + 選択 radio がダークテーマ** という中間状態の screenshot が取れてしまう。

**対策** (2 段階):

```ts
await themeRes;
// 1. page.reload で data-theme を確定 (§4.20 と同じ原理)
await page.reload({ waitUntil: 'networkidle' });
// 2. SSR が data-theme 属性を新テーマで書き込んだことを明示的に確証
await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id);
// 3. ここで初めて screenshot 安全
await expect(page).toHaveScreenshot(...);
```

**汎化**: 視覚回帰で **Server Component の再取得に依存する動的 state** (テーマ / 言語
設定 / ユーザロール切替 / 等) を撮る場合:

1. 状態変更 API を待つ (waitForResponse)
2. **page.reload** で Server Component 再実行
3. **決定要素の属性** (data-theme / lang / role 等) を assert で確証
4. screenshot を撮る

`aria-checked` / `aria-selected` 等は client state で即時切替するため、
**SSR 決定属性の代わりに使うと race する**。必ず SSR が書く属性を見る。

### 4.21 CI では `ECONNRESET` 系 transient network error を retry で吸収する

**症状**: spec 04 beforeAll / 冒頭の API 呼び出しで突然 fail:
```
Error: apiRequestContext.post: read ECONNRESET
→ POST http://localhost:3000/api/memos
```
139ms という極めて短時間で fail。response ではなく **TCP 接続自体が切断** される
タイプのエラー。

**原因**: 並列 CI 環境で Next.js サーバの一時的 resource 逼迫:
- 複数 test spec が workers=2 で並列、同じ Next.js サーバを叩く
- TCP 接続プール / ephemeral port 枯渇
- メモリ逼迫で server が短時間 GC stall
- Supabase 接続プール枯渇 (上位から Next.js に伝播)

code bug ではなく **infra-level flakiness**。通常の retry=2 にしても spec 04 は
`retries: 0` 設定なので auto-retry が効かない。

**対策**: **API ヘルパー内に transient error 限定 retry** を実装する。
非 transient (4xx/5xx response や他の例外) は即 throw、transient のみ 1s 間隔 x
最大 3 回 retry:

```ts
async function postWithRetry(page, fn, label) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient = /ECONNRESET|ECONNREFUSED|socket hang up/i.test(msg);
      if (!isTransient || attempt === 3) break;
      await page.waitForTimeout(1000);
    }
  }
  throw new Error(`${label} failed after retries: ${lastError.message}`);
}
```

**適用範囲** (PR #97 hotfix 時点):
- `e2e/fixtures/project.ts`: createProjectViaApi / addProjectMemberViaApi
- `e2e/specs/04-personal-features.spec.ts`: createMemoViaApi
- 今後 追加する API ヘルパーも同 pattern を採用

**判別基準 — retry する / しない**:

| エラー種別 | retry する? | 理由 |
|---|---|---|
| `ECONNRESET` / `ECONNREFUSED` / `socket hang up` | ✅ | transient infra error |
| 4xx response (Client error) | ❌ | コード側バグの可能性、retry しても同じ |
| 5xx response (Server error) | ❌ | サーバ側で修正要 (retry は隠蔽になる) |
| その他 (Promise rejection) | ❌ | 予期しないエラー、retry は危険 |

**注意**: retry は **諸刃の剣**。infra flakiness は吸収するが、**本物のバグも隠蔽**
し得る。この pattern は「空振りが多い API 試行」(作成系 POST) にのみ適用、
検証系 (GET / アサーション) には使わない。

### 4.20 `router.refresh()` と UI 検証の race は `page.reload()` で確定させる

**症状**: PR #96 hotfix 5 で `waitForResponse` + `waitForLoadState('networkidle')`
を組んだのに、**別の CI run で同じ test が再び fail**:
```
✓ Wait for event "response" 87ms         (PATCH 200 OK)
✓ Wait for load state "networkidle" 0ms  (即時 idle 判定)
✗ Expect toHaveCount 0 (確定ボタン) 10s timeout
  - 14 × locator resolved to 1 element  (10s 間 button 消えず)
```

**原因 (更に深い層)**: `router.refresh()` は fire-and-forget の更に複雑な挙動:

1. click → handleConfirm 実行
2. `await fetch PATCH` 完了 → microtask 続行
3. `router.refresh()` を呼ぶ (fire-and-forget)
4. **しかし RSC fetch はさらに次の tick でスケジュール**される
5. handleConfirm 関数完了

並列的に Playwright 側:
1. `waitForResponse` が PATCH 完了を検知
2. **この瞬間、router.refresh の RSC fetch はまだ発火していない**可能性
3. `waitForLoadState('networkidle')` → 何も in-flight でない → 即時 idle (0ms)
4. `toHaveCount(0)` を 10s 間 retry するが、RSC fetch は起きなかった or UI 未更新

Next.js App Router 本番ビルドの RSC cache も影響する可能性あり (調査困難)。

**対策**: **`page.reload({ waitUntil: 'networkidle' })` で DB の真の状態を強制取得**:

```ts
// hotfix 5 (不十分だった pattern):
const res = await confirmRes;
await page.waitForLoadState('networkidle');  // ← 0ms で即解決する race
await expect(...toHaveCount(0));               // ← UI 未更新で fail

// hotfix (PR #97 に同梱、§4.20 として確立):
const res = await confirmRes;
expect(res.ok()).toBeTruthy();
await page.reload({ waitUntil: 'networkidle' });  // ← DB 真の状態を強制取得
await expect(...toHaveCount(0));                   // ← 確実に更新後の DOM を見る
```

**汎化**: 「click → API → `router.refresh()` → UI 検証」系は、
UI の **自動再描画に依存せず page.reload で強制再取得** する。副次的に `router.refresh`
の自動更新検証は犠牲になるが、それは Next.js framework の責務であり E2E の対象外と
割り切る。

**判別基準**: どの pattern を使うべきか?

| pattern | 用途 |
|---|---|
| `waitForResponse + waitForLoadState(networkidle)` (§4.18) | **ナビゲーションを伴う** click (`location.href=...` 等) で、別 URL に遷移して新規 SSR される場合 |
| `page.reload({ waitUntil: 'networkidle' })` (§4.20) | **同一 URL で router.refresh() に依存して UI 更新**する click (確定/編集/削除操作) |

ナビゲーション伴う click は §4.18 で十分、**同一 URL で部分更新する click は §4.20** を適用。

### 4.19 長い非同期チェーンを経る click は API レスポンス予約で区切る

**症状**: MFA 検証の click 後、`waitForURL('**/projects', { timeout: 15_000 })`
が 15s タイムアウトで fail する。

**原因**: click 後の処理チェーンが長く、かつ ほぼ全てが非同期:
```
click 検証
  ↓ fetch /api/auth/mfa/verify  (async)
  ↓ await update({ mfaVerified: true })  → 内部で /api/auth/session 呼び出し (async)
  ↓ window.location.href = '/'
  ↓ middleware が mfaVerified=true を読み取り許可
  ↓ /  Server Component が redirect('/projects')
  ↓ navigate to /projects
  ↓ load event
```
並列 CI 下で各段階が数百ms〜数秒かかり、合計で 15s を超えることがある。
`click()` 自体は click 事件を dispatch して返るだけなので、`waitForURL` の計測は
click 直後から開始、チェーン全体をこの 1 つのタイムアウトで吸収させるのは
脆弱。

**対策**: **最初の API 完了を明示的に待機して、チェーンを 2 段階に分割**する:

```ts
// Bad: 1 本の waitForURL でチェーン全体を吸収
await button.click();
await page.waitForURL('**/projects', { timeout: 15_000 });  // 全体で 15s

// Good: API 完了で区切る → 残りのナビゲーションだけ待つ
const verifyRes = page.waitForResponse(r =>
  r.url().includes('/api/auth/mfa/verify') && r.request().method() === 'POST'
);
await button.click();
const res = await verifyRes;
expect(res.ok()).toBeTruthy();  // verify 自体の成否も確証できる
await page.waitForURL('**/projects', { timeout: 15_000 });  // 残り部分だけ
```

**汎化**: §4.18 の一般形。**「click → API → 別 API → ナビゲーション」系の長い
チェーン** は全体で 1 つの timeout に任せず、**中間 API の完了を checkpoint** に
して複数段階で待機する。API が失敗した場合もすぐに検知できる副次効果もある。

適用パターン例:
- MFA 検証後のナビゲーション (本事例、Spec 01 Step 2b / Step 5)
- パスワードリセット確認後のリダイレクト (将来実装時)
- OAuth callback 処理
- ファイルアップロード → 処理完了 → ページ遷移

### 4.18 `router.refresh()` は fire-and-forget、click の await 経由では待てない

**症状**: `router.refresh()` を呼ぶ onClick を click した直後 `waitForLoadState('networkidle')`
が 0ms で即時解決し、その後のアサーションが reload 完了前に実行されて fail する。

**原因**: Next.js App Router の `router.refresh()` は void を返す fire-and-forget API。
呼び出し側の Promise と非連動なので `await reload()` しても reload 完了は待たない。

```js
async function handleConfirm() {
  await fetch(...);      // これは await される
  router.refresh();      // これは fire-and-forget
  // → 関数終了。refresh の RSC request はまだ送信されていないかも
}
```

クリックハンドラで `onClick={() => handleConfirm(id)}` としている場合、onClick は
Promise を await しない (React の仕様)。Playwright の `click()` は click 事件ディスパッチ後
ただちに返るので、fetch/refresh は background task として続く。
この時点で `waitForLoadState('networkidle')` を呼ぶと、fetch がまだ flight 前なら
networkidle は true として即時解決する。

**対策**: click *前* に `page.waitForResponse(...)` を **Promise として予約** し、
click 後に await する:

```ts
// Good: click 前に response を予約 → click 後に await
const patchRes = page.waitForResponse(r =>
  r.url().includes('/api/...') && r.request().method() === 'PATCH'
);
await row.getByRole('button', { name: '確定' }).click();
const res = await patchRes;
expect(res.ok()).toBeTruthy();
await page.waitForLoadState('networkidle');  // refresh の RSC も含めて待機
```

**汎化**: `router.refresh()` / `router.push()` など fire-and-forget な UI 遷移を
await したいとき、**API レスポンス待機で「その操作が完了した」証拠を掴む**のが最も
信頼できる。`waitForLoadState` は補助で、API 待機の後に使う。

### 4.16 `title` 属性は accessible name に使われない (text content が優先)

**症状**: `getByRole('button', { name: /展開|折りたたみ/ })` が 10s timeout。

**原因**: WBS の展開トグルボタンは以下の構造:
```jsx
<button title={isCollapsed ? '展開' : '折りたたみ'}>
  <span>▶</span>
</button>
```

ARIA の accessible name 算出アルゴリズムは以下の優先順位:
1. `aria-labelledby`
2. `aria-label`
3. **Name from content** (subtree の text content) ← ココで `▶` が採用される
4. `title` (3 以前が空のときのみ fallback)

text content `▶` が存在するため、`title="展開"` は無視される。
結果、button の accessible name は `▶` であり、`/展開|折りたたみ/` にマッチしない。

**対策 (2 通り)**:

1. **UI 側に `aria-label` を追加** (推奨、a11y 改善も兼ねる):
   ```jsx
   <button title={...} aria-label={...}>
     <span>▶</span>
   </button>
   ```
   → `getByRole('button', { name: ... })` で拾える。ARIA 標準に沿う。

2. **テスト側で `getByTitle(...)` を使う** (UI 変更不可の場合の workaround):
   ```ts
   await wpRow.getByTitle(/展開|折りたたみ/).click();
   ```

**実例 (PR #96 hotfix 4)**: WBS の展開トグルは `title` のみで `aria-label` が無かった
(Gantt 側は両方付いていた、一貫性欠如)。対策 1 で WBS 側にも `aria-label` を追加し、
テストは `getByRole` で統一した。

**判別基準**: `aria-label` / `aria-labelledby` / text content のいずれかが無ければ、
`title` は accessible name 算出で使われない。Playwright 標準の `getByRole` は
a11y-first の推奨 pattern なので、**UI の a11y 不足を先に直す** のが望ましい。
テストが a11y 欠陥を自動検知する役割を持てる。

### 4.13 collapsed ツリーの子要素は DOM 自体に不在

**症状**: `page.locator('tr').filter({ hasText: ACT_NAME })` が `toBeVisible` で
「element(s) not found」でタイムアウト。

**原因**: WBS ツリーは親 WP が collapsed 状態だと **子 ACT を DOM から除外する**:
```tsx
{!isCollapsed && task.children?.map((child) => <TaskTreeNode ... />)}
```
初期状態 (fresh navigation 直後) では `expandedTaskIds` が空なので全 WP が collapsed。

**対策**: 子要素を検証する前に親の展開トグルをクリックする:
```ts
const wpRow = page.locator('tr').filter({ hasText: WP_NAME });
await wpRow.getByRole('button', { name: /展開|折りたたみ/ }).click();
// その後に子を検証
await expect(page.locator('tr').filter({ hasText: ACT_NAME }).first()).toBeVisible();
```

**汎化**: 折りたたみ/開閉を持つ UI (tree / accordion / disclosure) では **親を開いてから子を検証**。
useSessionStringSet 等で永続化される展開状態は後続 test にも引き継がれるので、1 度展開すれば OK。

### 4.14 合成ラベルのボタンは exact match で取れない

**症状**: `page.getByText('担当者', { exact: true })` が「element not found」。

**原因**: MultiSelectFilter コンポーネントは label + 選択状態を合成してボタン表示する:
```jsx
<Button>{label}: {isAllSelected ? allLabel : `${selected.size} / ${options.length}`}</Button>
```
→ 実テキストは「担当者: 全員」「状況: 2 / 5」等。`exact: true` では label 単独と一致しない。

**対策**: 正規表現で prefix match する (半角/全角コロンの両方を許容):
```ts
await expect(
  page.getByRole('button', { name: /^担当者[::]/ }),
).toBeVisible();
```

**汎化**: フィルタボタンや「○○: △△」形式のトグル/select 等は `^<label>[::]`
正規表現で取るのが標準 pattern。

### 4.15 視覚回帰での動的コンテンツは mask ではなく "除去" で対応する

**症状**: `/projects` 一覧を `mask: [page.locator('tbody tr')]` で撮影しても、
baseline と現在の行数が異なると mask 境界が一致せず **pixel diff 23%** 等で fail する。

**原因**:
1. 並列テスト環境で他 spec (spec 02, 04, 06 等) が同じ DB にデータを残存させる
2. mask は撮影時点の DOM を基に動的に領域決定するため、**行数が違えば mask 範囲も違う**
3. mask 外の白地領域も位置が変わり、pixel 比較で差分として検知される

**対策 (3 つの選択肢)**:

| 対策 | 適用場面 |
|---|---|
| a) 視覚回帰対象から外す | 一覧画面 (多 spec のデータが混在) |
| b) 固定値でデータを seed | 日付・ID 等の可変要素がある詳細画面 |
| c) 画面全体を固定サイズ element に限定 | ヘッダやフォームなど構造が動的でない |

**実例 (PR #96 hotfix)**:
- `/projects` 一覧 → 対策 a: 視覚回帰削除 (settings-themes で主視覚回帰を担保)
- `/projects/[id]` 概要 → 対策 b: `createProjectViaApi` に固定日付
  `{ plannedStartDate: '2026-01-01', plannedEndDate: '2026-02-01' }` を渡す
- `/login`, `/reset-password` → 既に対策 c (データ入力前の初期状態)

**教訓**: mask は「座標固定」の補助であって、「動的データの吸収」には向かない。
動的データを撮るなら **データ側を固定化** する方が確実。

### 4.11 一覧画面の行要素は行スコープ + .first() で取る

**症状**:
```
strict mode violation: getByText('<プロジェクト名>') resolved to 2 elements:
  1) <a class="font-medium text-info hover:underline" href="/projects/..."> ...
  2) <a class="font-medium text-info hover:underline" href="/projects/..."> ...
- unexpected value "hidden"
```

**原因 (推定)**: `/projects` 一覧の `<Link>` が Next.js App Router の prefetch
や hydration 過渡状態で **同一 href の `<a>` が 2 要素に解決される** ことがある。
片方は `visibility:hidden` だが strict mode は fail する。ソースコード上は
`.map()` で 1 行あたり 1 `<Link>` しか描画していないため、DOM 観察だけでは
原因特定が難しい。§4.8 並列 CI / PR #93 hotfix 1 の `<h2>` 重複と同じ系統。

**対策**: ページ全体ではなく **`tbody tr` 行内にスコープ + `.first()`** で
一意化する。strict mode を尊重しつつ重複にも耐える。

```ts
// Bad: page 全体 → hidden な同一要素に当たって strict violation
await expect(page.getByText(PROJECT_NAME)).toBeVisible();

// Good: 行内スコープ + .first()
await page.waitForLoadState('networkidle');
await expect(
  page.locator('tbody tr').filter({ hasText: PROJECT_NAME }).first(),
).toBeVisible();
```

**汎化**: **表形式一覧で特定行の存在確認** は、この pattern (`tbody tr` scope
+ `.first()`) を **既定** にする。最初から書くとき:

```ts
// Template
await expect(
  page.locator('<tbody tr|li|dl|card selector>').filter({ hasText: NAME }).first(),
).toBeVisible();
```

表の代わりに card / dl / li で描画されている場合は適切な親要素に置換する。
重要なのは「page 全体の getByText ではなく **行境界でスコープする**」という考え方。

### 4.34 native `<select>` を Combobox に置換したら E2E ロケータも追従必須 (PR #126 で遭遇)

#### 症状

PR #126 で「件数が増える可能性のある Select」を Base UI Combobox (`SearchableSelect` コンポーネント) に置換。`/projects` の顧客選択がこれに該当したが、`e2e/specs/09-customers.spec.ts` の **Step 6** で以下の locator が `element(s) not found` で fail:

```ts
// PR #126 以前の locator (native <select> 前提)
const customerSelect = page.locator('select').filter({
  has: page.locator(`option:has-text("${CUSTOMER_FOR_CASCADE}")`),
}).first();
await expect(customerSelect).toBeVisible({ timeout: 10_000 });
```

#### 原因

Base UI Combobox は `<select>` ではなく `<input role="combobox">` + 展開時の `<div role="listbox">` + `<div role="option">` に render される。`locator('select')` は HTML タグ名マッチなので Combobox には一致しない。

#### 修正 (正しい locator 戦略)

テストの**意図**は「自由入力ではなく選択式であること」+「作成済 item が候補に含まれること」。実装詳細 (`<select>` vs Combobox) に依存しない ARIA ベースの locator に変更:

```ts
// 最終修正: role="combobox" + name regex で Input のみを一意特定
const customerField = page.getByRole('combobox', { name: /顧客/ });
await expect(customerField).toBeVisible({ timeout: 10_000 });

// Combobox を展開 → 候補が表示される
await customerField.click();
await expect(
  page.getByRole('option', { name: CUSTOMER_FOR_CASCADE }),
).toBeVisible({ timeout: 5_000 });
```

#### ⚠️ 試行錯誤メモ: `getByLabel('顧客')` は strict mode violation で使えない

初回修正で `getByLabel('顧客')` を使ったが再度 fail。Base UI Combobox は以下 2 要素を emit する:

1. `<input role="combobox" aria-label="顧客選択">` — 実入力要素
2. `<button aria-expanded=... aria-label="顧客選択（展開）">` — 装飾的な ▼ トリガー

`getByLabel()` は `<label htmlFor>` と **`aria-label` の両方で substring マッチ** するため、上記 2 要素を同時に拾って strict mode violation になる。

**正しい戦略**:

| 手段 | 結果 |
|---|---|
| `getByLabel('顧客')` | ❌ 2 要素マッチ (input aria-label + trigger aria-label) |
| `getByLabel('顧客', { exact: true })` | △ `<label>顧客</label>` のみヒットするが fragile (将来 aria-label 変更で壊れうる) |
| **`getByRole('combobox', { name: /顧客/ })`** | ✅ `role="combobox"` は Input のみが持つため一意特定 (推奨) |
| `page.locator('#project-create-customer')` | ✅ ID 固定で一意。ただし実装詳細に依存 |

`getByRole('combobox')` は Base UI Combobox の ARIA 設計 (Input のみが combobox role) を利用して、**実装詳細に依存せず Input を一意に取る** ので最も堅牢。

#### コンポーネント側の予防策 (本 PR で実施)

`SearchableSelect` の Trigger の aria-label を Input の aria-label と衝突しない固定値 (`"候補を開く"`) に変更。これで `getByLabel(ariaLabel)` でも strict mode violation が起きなくなり、**将来別の spec で同じ罠を踏まない**。

```diff
 <Combobox.Trigger
-  aria-label={ariaLabel ? `${ariaLabel} (展開)` : '展開'}
+  aria-label="候補を開く"
   className="pointer-events-none absolute"
 >
```

#### 教訓

1. **UI コンポーネント置換時は E2E spec を同 PR でチェック**: PR #126 マージ前に `/projects` 関連 E2E (09-customers.spec.ts Step 6) を touch し、新 UI に合わせた locator 更新を同 PR 内でやるべきだった。CI が並列 PR 順で流れると発覚が遅れる。
2. **ロケータは実装詳細に依存しない ARIA ベースが堅牢**: `locator('select')` → `getByRole('combobox', ...)` + `getByRole('option', ...)` にすることで、将来 UI が変わっても test が生存する。
3. **`<select>` + `<option>` パターンは脆弱**: 今後 native `<select>` を使う箇所でも、E2E では role / name ベースを原則とする。
4. **複合コンポーネントの `aria-label` 衝突に注意** (新知見): Combobox のように 1 フィールドで複数要素を emit する UI では、それぞれの aria-label に同じ文字列を含めると `getByLabel` / `getByRole` の name match が strict violation になる。**role が同じ複数要素に同じ name を付けない / 装飾要素には固定の役割名 (例: 「候補を開く」) を付ける**。

#### 横展開チェック

本事象を踏まえ、`locator('select')` を他の spec で使っていないか定期的に grep:

```bash
rg -n "locator\\('select'\\)" e2e/
```

2026-04-24 時点: 09-customers.spec.ts のみ検出 (本 PR で修正)。他 spec は既に label / role ベース or native `<select>` の locator を使っていないため影響なし。

---

## 5. アサーション戦略

一貫したアサーションパターンを全 spec で採用:

| 対象 | 推奨 | 理由 |
|---|---|---|
| ページ遷移 | `waitForProjectsReady(page)` ヘルパー | 302 チェーン完了保証 |
| 真の heading | `getByRole('heading', { name: ... })` | ARIA 標準 |
| CardTitle 系 | `getByText(..., { exact: true })` | heading role 無いため |
| フォーム入力 | `getByLabel(...)` | htmlFor ペア済 UI のみ |
| タブ選択状態 | `aria-selected="true"` | ライブラリ非依存 |
| radio 選択状態 | `aria-checked="true"` | ライブラリ非依存 |
| API 完了待機 | `page.waitForResponse(url/method 条件)` | タイミング保証 |
| UI 再レンダ待機 | `waitForLoadState('networkidle')` | router.refresh 後の安定 |
| 要素不在 | `toHaveCount(0, { timeout })` | 削除検証 |
| 一覧内の特定行 | `page.locator('tbody tr').filter({ hasText: X }).first()` | prefetch/hydration 重複耐性 (§4.11) |
| 節目の可視化 | `await snapshotStep(page, 'label')` | 人間目視用 |

---

## 6. スコープ管理の哲学

### 6.1 PR あたりの scope を絞る

PR #92 (hotfix 7 回) と PR #94 (hotfix 0 回) の差は、scope の差だけではなく
**学びが蓄積していたかどうか**。

- 学び不足の段階で scope を広げると、hotfix の連鎖で CI が何度も回り、
  reviewer と作者の両方に負担がかかる
- 1 PR は「失敗してもロールバックしやすいサイズ」に保つ
- 既知の罠が出尽くしたあとに widen する

### 6.2 UI が複雑な箇所は API で代替

プロジェクト作成フォームは 10 フィールド + DateFieldWithActions (カスタム日付
ピッカー) を含む。UI でテストするより `page.request.post('/api/projects', {...})`
で作成する方が **test の本質に集中できる**。

代替判断基準:
- 対象 UI が **そのテストの主役か**
- 主役なら UI で、主役でないなら API で

例:
- **Step 3 の招待メール送信**: 主役は「招待フォームの UX」→ UI
- **Step 5 のプロジェクト作成**: 主役は「その後のメンバー追加」→ プロジェクト作成は API
- **Step 11 の削除**: 主役は「削除ダイアログの UI」→ UI

### 6.3 carry-over を明示する

カバーしきれない範囲は `docs/E2E_COVERAGE.md` に `[ ]` + `skip: 理由 (PR #X)`
で**未実装の予約席** を可視化する。「いつか誰かが書く」にしない。

---

## 7. 可視化と人間引き継ぎ

AI 駆動から人間駆動への段階移行方針に沿い、以下を整備:

1. **e2e/README.md** — 全 spec のシナリオを日本語で一覧化
2. **docs/E2E_COVERAGE.md** — 画面/API を網羅したカバレッジ管理
3. **docs/DEVELOPER_GUIDE.md §9** — 実行方法 + 失敗調査手順 + 書くときの規約
4. **節目 snapshotStep** — コード読みなしで「どの瞬間に何が映っていたか」確認
5. **HTML レポート trace viewer** — action 単位のタイムライン

これにより、この文書を読めば **新規参入者が hotfix マラソンを再演することなく
次の spec を書ける** 状態を目指している。

---

## 8. 未解決課題 (将来 PR 候補)

| 項目 | 理由 |
|---|---|
| 視覚回帰 baseline の Linux CI 生成 | フォント/レンダリング差異のため Windows / macOS では不可 |
| 10 テーマ × 主要画面マトリクス展開 | 上記 baseline 生成 WF が先 |
| WBS ツリー CRUD の E2E | ドラッグ&ドロップ含む複雑 UI |
| ガントチャート時系列表示の E2E | 日付計算 + 描画の検証が重い |
| 見積詳細 UI の E2E | フィールド多数 + 金額計算 |
| self-delete (/api/auth/delete-account) | recoveryCode 取得フローの整備が必要 |
| Firefox / Safari ブラウザ互換 | MVP では Chromium 1 種類のみ |
| モバイル解像度マトリクス | 固定 1440×900 で運用中 |

---

## 9. 最後に

E2E 実装は **「正解のテストを書く」** 作業ではなく、**「自分のプロジェクトだけに
当てはまる罠を炙り出す」** 作業だった。hotfix の 1 回 1 回が、次の spec を
楽にしてくれる未来への投資になっている。

同じ罠が再発しそうになったら、真っ先に本文書の §4 を見返すこと。
