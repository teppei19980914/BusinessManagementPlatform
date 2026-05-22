# ローカルテスト Tips 集 (Developer Guide)

本ドキュメントは、人間開発者が **効率的にローカル単体テストを書くため** の Tips・mock パターン集・典型的な罠を集約します。
テスト戦略の全体像は [docs/test/STRATEGY.md](../test/STRATEGY.md)、E2E は [E2E_TEST_GUIDE.md](./E2E_TEST_GUIDE.md) を参照。

---

## 1. テストフレームワーク

| 区分 | 採用 | 備考 |
|---|---|---|
| Test runner | **vitest** (`pnpm test` = `vitest run`) | Jest 互換 API、ESM ネイティブ、Turbopack と相性良 |
| React component | `@vitejs/plugin-react` + `jsdom` | `vitest.config.ts` で `environment: 'jsdom'` 設定済 |
| Coverage | `@vitest/coverage-v8` (= 内蔵 v8) | 閾値 Lines/Statements/Functions 80% / Branches 70% ([TEST_LINT_BUILD.md §9.2](./TEST_LINT_BUILD.md)) |
| Mock | `vi.mock` / `vi.mocked` (vitest 標準) | Jest と同じ感覚で使える |
| Assertion 拡張 | `@testing-library/jest-dom` (`expect(el).toBeInTheDocument()` 等) | `vitest.setup.ts` で読み込み |

実行コマンド ([TEST_LINT_BUILD.md §9](./TEST_LINT_BUILD.md) 参照):

```bash
pnpm test                # 1 回実行 (CI と同じ)
pnpm test:watch          # 監視モード (ファイル保存で自動再実行)
pnpm test --coverage     # カバレッジ計測 (HTML レポート: coverage/lcov-report/index.html)
pnpm test src/services/billing.service.test.ts   # 単一ファイルのみ
pnpm test -t "tenantId フィルタが効く"            # test name 部分一致で絞り込み
```

---

## 2. テストファイルの配置規約

```
src/
├── services/
│   ├── billing.service.ts
│   └── billing.service.test.ts          ← 実装の隣 (同名 + .test.ts)
├── lib/
│   ├── format.ts
│   └── format.test.ts
└── components/
    ├── settings/
    │   ├── theme-selector.tsx
    │   └── theme-selector.test.tsx
```

**規約**:

- `*.test.ts` または `*.test.tsx` を **実装ファイルの隣** に置く
- 大規模な統合テストは `src/__tests__/integration/` 配下 (例外扱い)
- E2E は `e2e/` 配下 ([E2E_TEST_GUIDE.md](./E2E_TEST_GUIDE.md))

### 2.1 命名

| ファイル | テスト名 |
|---|---|
| `billing.service.ts` の `chargeForUsage()` | `describe('chargeForUsage', () => { it('適用プランが Beginner の場合 ¥1500 上限で打ち止め', ...) })` |
| `format.ts` の `formatDate()` | `describe('formatDate', () => { it('UTC ISO → JST YYYY/MM/DD に変換する', ...) })` |

- `describe` = 関数名 (英語のまま)
- `it` = 仕様文 (日本語、「〜が ... を返す」形式)
- 「テストする」「が動く」みたいな曖昧な文言は避ける

---

## 3. mock パターン集

### 3.1 Prisma mock

`src/lib/db.ts` (= PrismaClient export) を全体 mock するパターンが基本。

```ts
// src/services/billing.service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { calculateMonthlyBilling } from './billing.service';

vi.mock('@/lib/db', () => ({
  prisma: {
    apiCallLog: {
      findMany: vi.fn(),
      aggregate: vi.fn(),
    },
    tenant: {
      findUnique: vi.fn(),
    },
  },
}));

describe('calculateMonthlyBilling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Beginner プラン + 上限超過時に ¥1500 で打ち止め', async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
      id: 'tenant-a',
      plan: 'beginner',
    } as never);
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValue({
      _sum: { costJpy: 3000 },  // 上限 1500 を超える
    } as never);

    const result = await calculateMonthlyBilling('tenant-a', '2026-05');

    expect(result.amountJpy).toBe(1500);
    expect(result.capped).toBe(true);
  });
});
```

**Tips**:
- `vi.mocked(fn).mockResolvedValue(...)` で型安全な mock 化
- `as never` は Prisma の戻り値型 (Promise<DefaultArgs 適用済 type>) を矮小化する逃げ口
- `beforeEach` の `vi.clearAllMocks()` で test 間の汚染を防ぐ

### 3.2 NextAuth session mock

```ts
import { auth } from '@/lib/auth';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

it('viewer の場合は projects.delete API が 403', async () => {
  vi.mocked(auth).mockResolvedValue({
    user: {
      id: 'user-1',
      tenantId: 'tenant-a',
      systemRole: 'admin',
      projectRoles: { 'project-1': 'viewer' },
    },
    expires: '2026-12-31',
  } as never);

  const res = await DELETE(new Request('http://localhost/api/projects/project-1'));
  expect(res.status).toBe(403);
});
```

### 3.3 Stripe API mock

```ts
vi.mock('stripe', () => {
  const StripeMock = vi.fn(() => ({
    subscriptions: {
      create: vi.fn(),
      cancel: vi.fn(),
    },
    customers: {
      create: vi.fn(),
    },
    checkout: {
      sessions: {
        create: vi.fn(),
      },
    },
  }));
  return { default: StripeMock };
});

import Stripe from 'stripe';

it('Subscription cancel が冪等に動く', async () => {
  const stripeInstance = new Stripe('sk_test_xxx', { apiVersion: '2025-01-27' });
  vi.mocked(stripeInstance.subscriptions.cancel).mockResolvedValue({ id: 'sub_xxx', status: 'canceled' } as never);

  await cancelSubscription('sub_xxx');
  expect(stripeInstance.subscriptions.cancel).toHaveBeenCalledWith('sub_xxx');
});
```

### 3.4 fetch / external API mock

```ts
import { vi } from 'vitest';

global.fetch = vi.fn(async (url: string) => {
  if (url.includes('api.voyageai.com')) {
    return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 });
  }
  throw new Error(`Unmocked fetch: ${url}`);
}) as never;
```

### 3.5 環境変数 mock

```ts
import { vi, beforeEach, afterEach } from 'vitest';

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  process.env.STRIPE_ENABLED = 'true';
});

afterEach(() => {
  process.env = originalEnv;
});
```

---

## 4. テスト密度を保つコツ

### 4.1 新規 service 関数は必ず単体テスト追加

[CLAUDE.md コミットルール](../../CLAUDE.md): **テストコードの追加・修正を伴わないソースコード変更はコミット禁止**。

- 新規 service 関数 → 同名の `.test.ts` を作成
- 公開メソッド (export 関数) は最低 1 シナリオは網羅
- private helper は service の test 経由で間接的にカバー (= export しないでテストする)

### 4.2 エッジケースの網羅

| 想定 | チェック内容 |
|---|---|
| null / undefined | 引数が null/undefined のとき throw か default を返すか |
| 空 array / 空 string | `[]` / `""` のときに 0 件で返るか、エラーになるか |
| 境界値 | 0 / 1 / 上限 / 上限+1 (例: タイトル文字数 max=200 のとき 200/201) |
| 異常系 | DB 接続失敗 / 外部 API 5xx / タイムアウト |
| 並行 | 同一 tenantId への並列リクエストで race を踏まないか |

### 4.3 テナント越境チェック (severity-1 必須)

[MEMORY: feedback_tenant_isolation](../../CLAUDE.md) より、一覧系サービスは **`viewerTenantId` を必須引数で受け、`where.tenantId` フィルタを強制** する。テストで以下を必ず検証:

```ts
it('別テナントのデータは返さない (tenantId フィルタ)', async () => {
  await prisma.tenant.create({ data: { id: 'tenant-a', name: 'A' } });
  await prisma.tenant.create({ data: { id: 'tenant-b', name: 'B' } });
  await prisma.project.create({ data: { id: 'p1', name: 'A-project', tenantId: 'tenant-a', ... } });
  await prisma.project.create({ data: { id: 'p2', name: 'B-project', tenantId: 'tenant-b', ... } });

  const result = await listProjectsForViewer({ viewerTenantId: 'tenant-a' });

  expect(result.map(p => p.id)).toEqual(['p1']);
  expect(result.map(p => p.id)).not.toContain('p2');  // negative も明示
});
```

### 4.4 課金 invariant のテスト (★最重要★)

[MEMORY: feedback_billing_invariant](../../CLAUDE.md): **ApiCallLog SUM = 画面表示 = 請求金額** を真値とする。

```ts
it('画面表示と Stripe 請求額が ApiCallLog SUM と一致する', async () => {
  // ApiCallLog に既知のデータを投入
  await seedApiCallLogs({ tenantId: 'tenant-a', month: '2026-05', totalJpy: 2480 });

  const display = await getMonthlyUsageForDisplay('tenant-a', '2026-05');
  const stripeAmount = await getMonthlyAmountForStripe('tenant-a', '2026-05');

  expect(display.totalJpy).toBe(2480);
  expect(stripeAmount).toBe(2480);
});
```

---

## 5. CLAUDE.md feedback_test_rule との関係

> **テストコードの追加・修正を伴わないソースコード変更はコミットしない** ([CLAUDE.md](../../CLAUDE.md))

実装変更とテストを **同一コミット** に含める運用。Stop hook でも検出される。

### 5.1 適用される変更

- ✅ 新規 service 関数追加 → テスト追加
- ✅ 既存 service 関数の挙動変更 → 既存テスト更新 or 新規テスト追加
- ✅ バグ修正 → **バグを再現するテスト** を先に追加 (Red → Green)

### 5.2 例外 (テスト追加不要)

- README.md / docs/ 配下の文書修正のみ
- `package.json` の dependencies update (脆弱性修正等、振る舞いに影響しない場合)
- コメントだけの修正

### 5.3 バグ修正は「Red First」が推奨

```ts
// 1. まず再現テストを書いて Red (= 失敗) を確認
it('プロジェクト名に絵文字を含むとき normalize される (bug #XXX 修正)', () => {
  expect(normalizeProjectName('🎉 New Project')).toBe('New Project');  // Red
});

// 2. 実装修正 → Green に
// 3. コミット
```

---

## 6. よくある罠

### 6.1 Date / Timezone

クライアント or サーバの timezone に依存するテストは flaky になる。

- ❌ `expect(formatDate(new Date())).toBe('2026-05-22')` ← 実行 TZ で変わる
- ✅ `expect(formatDate(new Date('2026-05-22T00:00:00Z'), { timeZone: 'Asia/Tokyo' })).toBe('2026/05/22')`

実装側でも `toLocaleString` / `getFullYear()` 等は禁止 → `@/lib/format` のヘルパを使う ([TEST_LINT_BUILD.md §10.7](./TEST_LINT_BUILD.md))。

### 6.2 Decimal / BigInt

Prisma の `Decimal` / `BigInt` は `===` で比較できない。

```ts
import { Decimal } from '@prisma/client/runtime/library';

// ❌ NG
expect(result.amount).toBe(new Decimal(1500));  // Object identity で fail

// ✅ OK
expect(result.amount.toString()).toBe('1500');
expect(result.amount.equals(new Decimal(1500))).toBe(true);
```

### 6.3 Prisma generated client の import 経路

E2E から `src/generated/prisma/client.ts` を直接 import すると `ReferenceError: exports is not defined in ES module scope` ([TEST_LINT_BUILD.md §9.8](./TEST_LINT_BUILD.md))。

- 単体テスト (vitest) では問題なし
- E2E (Playwright) では `pg` 生 SQL を使う

### 6.4 test isolation の崩れ

`describe` 間で mock state や DB state が残ると、テスト順序依存の flaky が発生。

- `beforeEach(() => vi.clearAllMocks())` を describe top に必ず置く
- DB を触る統合テストは `beforeEach` で truncate
- グローバル変数 (`process.env` 等) を変更したら `afterEach` で復元

### 6.5 React component test で `act` warning

```
Warning: An update to MyComponent inside a test was not wrapped in act(...)
```

→ `@testing-library/react` の `act` でラップする。最近の RTL は user-event 経由で自動 `act` するので、user interaction は user-event で書く。

```ts
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

it('click でテーマが切り替わる', async () => {
  const user = userEvent.setup();
  render(<ThemeSelector />);

  await user.click(screen.getByRole('button', { name: 'ダーク' }));

  expect(screen.getByRole('button', { name: 'ダーク' })).toHaveAttribute('aria-pressed', 'true');
});
```

### 6.6 Client Component → service の value import 罠

`useEffect` 等で service を value import (= `import { fn } from '@/services/foo'`) すると **Prisma が client bundle に混入** して build 失敗 ([MEMORY: feedback_client_service_boundary](../../CLAUDE.md))。

- service は **API route / Server Action 経由でのみ呼ぶ**
- 閾値定数等は `@/config/*` に分離して、Client Component からは `@/config` 経由で参照

---

## 7. 既存テストの参考リンク (お手本)

| パターン | 参考テストファイル |
|---|---|
| Prisma mock + service 単体テスト | `src/services/billing.service.test.ts` |
| Stripe API mock | `src/services/stripe.service.test.ts` (存在する場合) |
| NextAuth session mock + API route | `src/app/api/projects/route.test.ts` |
| Date / Timezone | `src/lib/format.test.ts` |
| Decimal 比較 | `src/services/billing.service.test.ts` |
| テナント越境 (negative test) | `src/services/project.service.test.ts` の `listProjectsForViewer` テスト |
| Config 定数 + 表示文字列の同期 | `src/config/i18n.test.ts` |

> 上記が存在しない場合は `pnpm test --reporter=verbose` で全テスト一覧を見て、近いシナリオを参考に。

---

## 関連ドキュメント

- [TEST_LINT_BUILD.md](./TEST_LINT_BUILD.md) — pnpm test の実行詳細 + カバレッジ閾値
- [E2E_TEST_GUIDE.md](./E2E_TEST_GUIDE.md) — Playwright E2E Tips
- [docs/test/STRATEGY.md](../test/STRATEGY.md) — 自動/手動テスト全体戦略
- [DEVELOPMENT_FLOW.md](./DEVELOPMENT_FLOW.md) — Phase 3 (ローカルテスト) の位置付け
- [CLAUDE.md](../../CLAUDE.md) — コミット前チェック / テストコード必須ルール

---

**最終更新**: 2026-05-22 (PR #425 ベース)

**関連 KDD / MEMORY**:
- [MEMORY: feedback_test_rule](../../CLAUDE.md) — テスト密度向上による品質保証
- [MEMORY: feedback_tenant_isolation](../../CLAUDE.md) — テナント越境防止 (severity-1)
- [MEMORY: feedback_billing_invariant](../../CLAUDE.md) — 請求 invariant (★最重要★)
- [MEMORY: feedback_client_service_boundary](../../CLAUDE.md) — Client Component → service value import 罠
- §5.X+58 (E2E coverage 漏れと CI 連鎖 fail) — ローカルテストでも `pnpm e2e:coverage-check` を 5 点セットに含める
