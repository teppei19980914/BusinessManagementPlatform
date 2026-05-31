# テスト・lint・build 実行ガイド (Developer Guide)

本ドキュメントは、開発時のテスト・lint・build 実行方法を集約する (DEVELOPER_GUIDE.md §9)。テスト戦略は [../../test/STRATEGY.md](../../test/STRATEGY.md) を参照。

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

[.github/workflows/security.yml](../../../.github/workflows/security.yml) の最後に
`attack-matrix` job があり、GitHub Actions の **Job Summary** に以下のような
攻撃種別マトリクスを日本語で自動出力する:

| 状況 | 攻撃種別 (Attack) | 主な検証手段 |
|:---:|---|---|
| ✅ | 機密情報漏洩 (Secrets Exposure, CWE-798) | gitleaks |
| ✅ | SQL インジェクション (SQL Injection, CWE-89) | Semgrep / CodeQL + Prisma ORM |
| ✅ | 認可バイパス / IDOR (Authorization Bypass, CWE-639) | CodeQL + checkProjectPermission |
| ... | ... | ... |

- テンプレートは [.github/attack-matrix-summary.md](../../../.github/attack-matrix-summary.md)
- ワークフロー側で `sed` による `@@FOO@@` プレースホルダ置換で実スキャン結果を埋め込む
- **行を追加/編集したいとき**: `.github/attack-matrix-summary.md` を直接編集する。
  `to_mark` / `or_mark` で使えるステータストークン (`@@GITLEAKS@@` / `@@AUDIT@@` /
  `@@SAST@@` / `@@CODEQL@@`) は security.yml の `sed` で定義済み。新しい検証手段を
  増やす場合は security.yml にも変数を追加する。

### 9.3.5 E2E の詳細は E2E_TEST_GUIDE.md に集約

以前ここに展開していた E2E (Playwright / 視覚回帰) の詳細手順 — race パターンと待機戦略、視覚回帰 baseline 運用 (`[gen-visual]` / PAT fallback)、E2E 失敗の調査手順、招待メール / MFA fixture、pg 生 SQL 規約など — は **E2E_TEST_GUIDE.md** に移管・集約した。重複を避けるため本書では概要のみとし、詳細はそちらを参照する。

要点 (詳細は E2E_TEST_GUIDE.md):

- **E2E 実行**: `pnpm test:e2e` (全 specs + visual)、`pnpm test:e2e:ui` (対話)、`pnpm test:e2e:update-snapshots` (baseline 更新)、`pnpm e2e:coverage-check` (カバレッジ gap 検出)。
- **新規 spec / route 追加時**: 新しい `page.tsx` / `route.ts` を足したら `docs/test/E2E_COVERAGE.md` を必ず更新する (未更新だと CI の `e2e:coverage-check` が fail)。
- **click → navigation の race**: `Promise.all([page.waitForURL(...), link.click()])`、mutation 系は `waitForResponse` 予約、再描画期待は `page.reload({ waitUntil: 'networkidle' })`。`waitForLoadState('networkidle')` 単独は 0ms 即 resolve のリスクあり。
- **視覚回帰 baseline**: Linux CI 環境で生成。`[gen-visual]` コミットで再生成し、UI 変更を含む PR は最初の commit に付ける。
- **アサーション**: shadcn/ui の `CardTitle` は `<div>` (heading role なし) → `getByText`。タブは ARIA 標準 `aria-selected="true"` を見る。`<Label htmlFor>` + `<Input id>` をペアで付ける。
- 蓄積された 50 個超の罠パターンと調査フローは E2E_TEST_GUIDE.md (および `docs/test/E2E_LESSONS_LEARNED.md`) を参照。

### 9.4 新機能追加時の E2E カバレッジ横展開 (必須)

**新しい `page.tsx` や `route.ts` を追加したら、必ず `docs/test/E2E_COVERAGE.md` を更新**してください。
更新がないと CI の `e2e:coverage-check` ステップが fail し、マージできません。

更新パターン:
```markdown
# 完全に E2E カバー済
- [x] `/new-feature` — e2e/specs/04-new-feature.spec.ts

# 同一 PR 内ではカバーせず、後続 PR で追加予定
- [ ] `/new-feature` — skip: PR #XX で追加予定

# 意図的にカバー対象外
- [ ] `/admin/legacy-report` — skip: read-only / 優先度低
```

> 旧 §9.4〜§9.8 にあった Playwright 実行詳細・race パターン使い分け・視覚回帰 baseline 運用・E2E 失敗調査手順・招待メール / MFA fixture・pg 生 SQL 規約は **E2E_TEST_GUIDE.md** へ集約済み。

---

