# E2E テスト Tips 集 (Developer Guide)

本ドキュメントは、Playwright E2E テストの **実装 Tips とカバレッジ維持手順** を集約します。
過去 PR で蓄積した罠パターンの累積集は [docs/test/E2E_LESSONS.md](../../test/E2E_LESSONS.md)、E2E カバレッジマニフェストは [docs/test/E2E_COVERAGE.md](../../test/E2E_COVERAGE.md) を参照。

---

## 1. テストフレームワーク

| 区分 | 採用 | 備考 |
|---|---|---|
| Runner | **Playwright** (`@playwright/test`) | Chromium / WebKit / Firefox を並列実行、`e2e/playwright.config.ts` で設定 |
| 配置 | `e2e/specs/*.spec.ts` (機能別 spec) | smoke / login / projects / wbs / mfa など分割 |
| 視覚回帰 | `e2e/visual/*.spec.ts` + `toHaveScreenshot()` | Linux baseline (CI で自動生成) |
| Fixture | `e2e/fixtures/` | inbox mail / TOTP / run-id / db helper |
| CI | `.github/workflows/e2e.yml` | 並列実行、artifact に trace/video/screenshot |

実行コマンド ([TEST_LINT_BUILD.md §9.4](./TEST_LINT_BUILD.md) 参照):

```bash
# dev サーバ起動が前提 (別ターミナル)
pnpm dev &

# 全 specs + visual
pnpm test:e2e

# 対話モード (デバッグに最適)
pnpm test:e2e:ui

# 視覚回帰 baseline 更新 (Linux 環境推奨)
pnpm test:e2e:update-snapshots

# 単一 spec のみ
pnpm test:e2e e2e/specs/01-smoke.spec.ts

# 単一 test だけ
pnpm test:e2e -g "ログイン後にプロジェクト一覧が表示される"

# カバレッジ gap 検出
pnpm e2e:coverage-check
```

---

## 2. テストファイル構造

```
e2e/
├── README.md                       ← 各 spec のシナリオを日本語で一覧化 (人間向け)
├── playwright.config.ts
├── specs/
│   ├── 01-smoke.spec.ts
│   ├── 02-login-and-mfa.spec.ts
│   ├── 03-projects-crud.spec.ts
│   ├── 04-wbs-import.spec.ts
│   └── ...
├── visual/
│   ├── dashboard-screens.spec.ts
│   ├── settings-themes.spec.ts
│   └── __screenshots__/         ← baseline PNG (commit 対象)
└── fixtures/
    ├── db.ts                    ← pg 生 SQL で seed / cleanup
    ├── inbox.ts                 ← 招待メール受信 (MAIL_PROVIDER=inbox)
    ├── totp.ts                  ← TOTP コード生成
    ├── run-id.ts                ← 並列テスト用 unique suffix
    └── auth.ts                  ← ログイン helper (使い回し)
```

### 2.1 spec の基本テンプレート

```ts
import { test, expect } from '@playwright/test';
import { ensureInitialAdmin } from '../fixtures/db';
import { loginAsAdmin } from '../fixtures/auth';
import { withRunId } from '../fixtures/run-id';

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PW = 'Initial-Pass-1234!';
const runId = withRunId('projects-crud');

test.describe.serial('プロジェクト CRUD', () => {
  test.beforeAll(async () => {
    await ensureInitialAdmin(ADMIN_EMAIL, ADMIN_PW);
  });

  test('新規プロジェクトを作成 → 一覧に表示される', async ({ page }) => {
    await loginAsAdmin(page, ADMIN_EMAIL, ADMIN_PW);
    await page.goto('/projects');

    const projectName = `${runId}-test-project`;
    await page.getByRole('button', { name: 'プロジェクトを追加', exact: true }).click();
    await page.getByLabel('プロジェクト名').fill(projectName);
    await page.getByRole('button', { name: '登録', exact: true }).click();

    await expect(
      page.locator('tbody tr').filter({ hasText: projectName })
    ).toBeVisible();
  });
});
```

### 2.2 Page Object pattern (推奨)

複数 spec で再利用する操作は page object 化:

```ts
// e2e/pages/projects-page.ts
export class ProjectsPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto('/projects');
    await this.page.waitForLoadState('networkidle');
  }

  async createProject(name: string) {
    await this.page.getByRole('button', { name: 'プロジェクトを追加', exact: true }).click();
    await this.page.getByLabel('プロジェクト名').fill(name);
    const apiPromise = this.page.waitForResponse(
      r => r.url().endsWith('/api/projects') && r.request().method() === 'POST'
    );
    await this.page.getByRole('button', { name: '登録', exact: true }).click();
    await apiPromise;
  }
}
```

---

## 3. 必須テスト: 新規 page.tsx / route.ts 追加時

[CLAUDE.md コミット前チェック](../../../CLAUDE.md): **新規 `page.tsx` / `route.ts` 追加時は `docs/test/E2E_COVERAGE.md` に追記必須**。漏らすと CI fail + 連鎖 fail で `Test (vitest + coverage)` まで赤くなる ([TEST_LINT_BUILD.md §9.5.1](./TEST_LINT_BUILD.md))。

### 3.1 E2E_COVERAGE.md の更新パターン

```markdown
# 完全に E2E カバー済
- [x] `/projects/new` — e2e/specs/03-projects-crud.spec.ts

# 同一 PR 内ではカバーせず、後続 PR で追加予定
- [ ] `/admin/audit-logs` — skip: PR #XYZ で追加予定

# 意図的にカバー対象外
- [ ] `/admin/legacy-report` — skip: read-only / 優先度低
```

### 3.2 ローカル検証

```bash
pnpm e2e:coverage-check
# → green: manifest 漏れなし
# → red: 「未記載の機能」のリストが出力 → E2E_COVERAGE.md に追記
```

> **CI で発覚すると 2 ステップが連鎖 fail** (E2E coverage manifest check + Report coverage)。
> ローカルでこの 1 コマンドを必ず実行してからコミットすること ([TEST_LINT_BUILD.md §9.5.1](./TEST_LINT_BUILD.md))。

---

## 4. テナント越境テスト (severity-1)

[MEMORY: feedback_tenant_isolation](../../../CLAUDE.md): 一覧系画面は **別テナント user で見えないこと** を E2E で必ず検証する。

```ts
test.describe.serial('テナント越境 — プロジェクト一覧', () => {
  test('admin@tenant-a は tenant-b のプロジェクトが見えない', async ({ page }) => {
    // tenant-a / tenant-b の seed (db fixture)
    await seedTenantWithProject('tenant-a', 'A の案件');
    await seedTenantWithProject('tenant-b', 'B の案件');

    await loginAsAdmin(page, 'admin@tenant-a.example.com', PW);
    await page.goto('/projects');

    await expect(page.locator('tbody tr').filter({ hasText: 'A の案件' })).toBeVisible();
    await expect(page.locator('tbody tr').filter({ hasText: 'B の案件' })).toHaveCount(0);
  });
});
```

- **negative assertion (`toHaveCount(0)`)** を必ず加える (positive のみだと「全件取得バグ」で見逃す)
- 同一テナントの **role 越境** (viewer が PM 専用画面に入れないか) も同様に検証

---

## 5. Visual regression test

### 5.1 配置と baseline

- `e2e/visual/*.spec.ts` 配下に配置
- baseline PNG は `e2e/visual/__screenshots__/` に commit
- **Linux CI 環境で生成** (Windows / macOS でフォント差異が出るため)

```ts
test('ダッシュボード — ライトテーマ', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/projects');
  await page.waitForLoadState('networkidle');

  await expect(page).toHaveScreenshot('projects-light.png', {
    fullPage: true,
    mask: [page.locator('tbody tr')],  // 動的データは mask
  });
});
```

### 5.2 baseline 再生成: `[gen-visual]` コミット

UI 変更を含む PR では **最初のコミット message に `[gen-visual]` を含める** ([MEMORY: feedback_visual_baseline_gen](../../../CLAUDE.md))。

```bash
git commit --allow-empty -m "chore: regenerate visual baselines for new settings section [gen-visual]"
git push
```

→ `e2e-visual-baseline.yml` workflow が起動 → 同 branch に baseline auto-commit → E2E 再走で green。

**「最初の push に含める」運用** ([TEST_LINT_BUILD.md §9.6](./TEST_LINT_BUILD.md) 末尾):

| 条件 (どれかに該当したら最初から含める) |
|---|
| 既存 jsx 構造に手を入れた (要素追加 / className 変更等) |
| 権限分岐や条件レンダリングを変えた |
| shadcn/ui コンポーネントを追加・差し替えた |
| settings / dashboard / customers / auth ディレクトリ配下を編集した |

漏らすと「E2E fail → hotfix push → 再走」のサイクルを 1 回余分に消費し、Netlify credits も無駄になる。

### 5.3 PAT fallback による auto-rerun

`e2e-visual-baseline.yml` は `CI_TRIGGER_PAT || GITHUB_TOKEN` の fallback 構文を採用 ([TEST_LINT_BUILD.md §9.6 PAT fallback](./TEST_LINT_BUILD.md))。

- `CI_TRIGGER_PAT` 登録時: auto-commit → E2E が自動再起動 (人手不要)
- 未登録時: GITHUB_TOKEN で auto-commit → 手動で空 commit push が必要 (GitHub の無限ループ防止仕様)

---

## 6. CI での実行

### 6.1 `.github/workflows/e2e.yml`

- ubuntu-latest で並列実行
- artifact 保持 14 日: `playwright-report-<run_id>.zip` / `playwright-test-results-<run_id>.zip`
- failure 時は trace / video / screenshot 全て確認可能

### 6.2 `DISABLE_LOGIN_RATE_LIMIT='true'` の使い方

並列 E2E で同一 IP から大量にログインすると **rate limit** (=既定 5 回/分) に引っかかる。CI では:

```yaml
env:
  DISABLE_LOGIN_RATE_LIMIT: 'true'
```

を E2E job のみ設定。**production / staging では絶対に true にしない** (= ブルートフォース攻撃を許す)。
ローカル E2E でも同様に環境変数を設定:

```bash
DISABLE_LOGIN_RATE_LIMIT=true pnpm test:e2e
```

### 6.3 失敗時の調査手順

詳細は [TEST_LINT_BUILD.md §9.7 E2E テスト失敗の調査手順](./TEST_LINT_BUILD.md)。最重要ポイント:

1. **失敗テストと成功テストの対比** — 類似シナリオが部分的に通っていれば、ページ自体は健全 → アサーション側を疑う
2. **Playwright HTML レポートの artifact ダウンロード** → trace viewer / video / screenshot を視覚的に確認
3. **Actions UI 右上 歯車 → View raw logs** で生ログ全量を取得 (画像切り抜きは情報欠落)

---

## 7. Tips: flaky test を避ける

### 7.1 click → navigation の 3 つの race パターン (重要)

[TEST_LINT_BUILD.md §9.3.6](./TEST_LINT_BUILD.md) で整理済。新規 spec では必ず判別フローを通すこと:

| # | パターン | 修正方法 |
|---|---|---|
| 1 | router.refresh() race | `await page.reload({ waitUntil: 'networkidle' })` |
| 2 | 長い click chain race | `page.waitForResponse(...)` を click 前に予約 |
| 3 | Next.js Link click race | `Promise.all([page.waitForURL(/regex/), link.click()])` |

```ts
// ❌ アンチパターン (3 つすべての race を踏みうる)
await page.getByRole('link', { name: '...' }).first().click();
await page.waitForLoadState('networkidle');  // 0ms 即 resolve のリスク
await expect(page.getByRole('heading', { name: '...' })).toBeVisible();

// ✅ Pattern 3
await Promise.all([
  page.waitForURL(/\/customers\/[a-f0-9-]+/),
  page.getByRole('link', { name: '...' }).first().click(),
]);
```

### 7.2 文言衝突を防ぐ `exact: true`

```ts
// ❌ 「登録」が複数 (テナント登録 / プロジェクト登録 / 担当者登録 ボタンが同画面に) で strict mode violation
await page.getByRole('button', { name: '登録' }).click();

// ✅ exact 一致 or filter で絞り込み
await page.getByRole('button', { name: '登録', exact: true }).first().click();
await page.locator('tbody tr').filter({ hasText: projectName }).getByRole('button', { name: '編集' }).click();
```

### 7.3 timeout の使い分け

| 操作 | 推奨 timeout | 補足 |
|---|---|---|
| `expect(...).toBeVisible()` | 既定 (5s) | ほとんどのケース |
| `waitForURL(/...regex.../)` | 10-15s | 並列 CI で navigation 遅延 |
| `waitForResponse(...)` | 既定 | API 完了待ち |
| `toHaveScreenshot(...)` | 既定 | hydration 完了待ち (networkidle 後) |

15s を超えるテストは設計を見直す (= race 踏んでいる可能性大)。

### 7.4 全角/半角の Unicode 一致

UI が `（確認）` (U+FF08/FF09) なのにテストが `(確認)` (U+0028/0029) だと **`getByLabel` が辿れない** ([TEST_LINT_BUILD.md §9.8](./TEST_LINT_BUILD.md))。

- UI の文言をそのまま copy & paste
- 疑わしければ `node -e 'console.log([..."（確認）"].map(c => c.codePointAt(0).toString(16)))'`

### 7.5 データセットアップは fixture or seed 経由

- ❌ test 内で API 経由で大量 seed する (test が長く / flaky に)
- ✅ `e2e/fixtures/db.ts` の `ensureInitialAdmin` / `seedProject` 等で 1 行 setup
- ✅ `withRunId` で並列 test の test name 衝突を防ぐ

```ts
import { withRunId, cleanupByRunId } from '../fixtures/run-id';

const runId = withRunId('cross-tenant');

test.afterAll(async () => {
  await cleanupByRunId(runId);  // ローカル実行時の残存を防ぐ (CI は Postgres コンテナ破棄)
});
```

### 7.6 shadcn/ui の `CardTitle` は heading role ではない

`getByRole('heading', { name: '...' })` で拾えない (= `<div>` で描画される)。`getByText('...', { exact: true })` を使う ([TEST_LINT_BUILD.md §9.8](./TEST_LINT_BUILD.md))。

### 7.7 visibility=draft entity は embedding 対象外

[MEMORY: feedback_visibility_embedding](../../../CLAUDE.md): draft データに対する Voyage API 課金を消費しない設計。E2E でも draft 経由で API 呼び出しが発生しないことを検証する場合がある。

---

## 8. 参考リンク

### 8.1 必読

- [docs/test/E2E_COVERAGE.md](../../test/E2E_COVERAGE.md) — カバレッジマニフェスト (WHAT)
- [docs/test/E2E_LESSONS.md](../../test/E2E_LESSONS.md) — 累積罠パターン集 (WHY、新規 spec 着手前に一読)
- [e2e/README.md](../../../e2e/README.md) — 各 spec のシナリオ一覧 (人間向け)
- [TEST_LINT_BUILD.md §9.3.6 / §9.4 / §9.5 / §9.6 / §9.7 / §9.8](./TEST_LINT_BUILD.md) — 実行 + 失敗調査 + race パターン + visual baseline 全集

### 8.2 関連

- [docs/test/STRATEGY.md](../../test/STRATEGY.md) — 自動/手動テスト全体戦略
- [docs/test/VISUAL_REGRESSION_CHECKLIST.md](../../test/VISUAL_REGRESSION_CHECKLIST.md) — 視覚回帰チェックリスト
- [LOCAL_TEST_GUIDE.md](./LOCAL_TEST_GUIDE.md) — vitest 単体テスト Tips
- [DEVELOPMENT_FLOW.md Phase 4](./DEVELOPMENT_FLOW.md) — E2E の開発フロー上の位置

---

**最終更新**: 2026-05-22 (PR #425 ベース)

**関連 KDD / MEMORY**:
- [MEMORY: feedback_tenant_isolation](../../../CLAUDE.md) — テナント越境テスト必須 (severity-1)
- [MEMORY: feedback_e2e_coverage_gate](../../../CLAUDE.md) — `pnpm e2e:coverage-check` を 5 点セットに含める
- [MEMORY: feedback_visual_baseline_gen](../../../CLAUDE.md) — `[gen-visual]` コミットによる baseline 再生成
- §5.X+58 (E2E coverage 漏れ CI 連鎖 fail)
- [TEST_LINT_BUILD.md §9.3.6 / §9.7 / §9.8](./TEST_LINT_BUILD.md) — race パターン / 失敗調査 / 罠集
