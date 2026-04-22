# E2E テスト実装で得られた知見 (PR #90-#95 まとめ)

- 作成日: 2026-04-22
- 対象 PR: #90 (基盤) → #92 (Steps 1-6) → #93 (Step 7) → #94 (Step 8) → #95 (Steps 9-12)
- 全 PR で発生した hotfix 合計: 約 15 回

## 1. この文書の位置付け

PR #90-#95 を通して E2E 基盤を整備する過程で、**毎回の CI 失敗から学んだ教訓** を
ここに集約する。新しい spec を書く / 失敗をデバッグする前に一読すると、
**同じ罠を再度踏まずに済む**。

想定読者:
- 新しく E2E spec を書く開発者
- CI で赤になった E2E を調査する担当者
- AI 駆動から人間駆動への引継ぎ資料として残す

関連文書:
- [e2e/README.md](../e2e/README.md) — テストの内容説明 (WHAT)
- [docs/DEVELOPER_GUIDE.md §9](./DEVELOPER_GUIDE.md) — 実行手順 + 失敗調査手順 (HOW)
- [docs/E2E_COVERAGE.md](./E2E_COVERAGE.md) — カバレッジマニフェスト (COVERAGE)
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
