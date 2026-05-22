# セキュリティチェック CI 対処ガイド (Developer Guide)

本ドキュメントは、セキュリティチェック CI (`.github/workflows/security.yml`) で **PR が弾かれた時の対処手順** と **典型的な失敗パターン → 修正方法** を集約します。
脅威モデル全体は [docs/security/README.md](../security/README.md)、運用セキュリティは [docs/operations/SECURITY_OPS.md](../operations/SECURITY_OPS.md) を参照。

---

## 1. セキュリティチェック概要

### 1.1 ゲート条件

[`.github/workflows/security.yml`](../../.github/workflows/security.yml) は **7 系統** のセキュリティ検査を実行し、最終的に `scripts/security-check.ts --min-score=90` が **score 90/100 未満なら CI fail** ([CLAUDE.md コミット前チェック](../../CLAUDE.md))。

```bash
pnpm security:gate   # = scripts/security-check.ts --min-score=90 (CI と同等)
pnpm security:check  # = scripts/security-check.ts (score 表示のみ、fail しない)
```

### 1.2 実行タイミング

| トリガ | 説明 |
|---|---|
| `push` to main | main 反映後の最終確認 |
| `pull_request` to main | PR ごとに必ず実行 |
| `schedule: '0 3 * * *'` | 毎日 03:00 UTC で定期実行 (新規 CVE 検出) |

### 1.3 自動更新

- **Dependabot** が `.github/workflows/security.yml` で使う action のバージョンを週次更新
- semgrep / CodeQL / OSV / Trivy の **ルールセット本体** は実行時に live fetch (常に最新)
- npm の CVE は dependabot security-only PR で即時起票

---

## 2. チェック項目 (7 系統)

| # | Job 名 | ツール | 検出するもの | データ源 |
|---|---|---|---|---|
| 1 | Secret Scan | gitleaks | API キー / パスワード等の機密情報コミット | gitleaks-action 内蔵ルール |
| 2 | pnpm audit | pnpm | 依存ライブラリの脆弱性 (high 以上で fail) | npm registry live |
| 3 | SAST (Semgrep) | semgrep | OWASP Top 10 / Next.js / TypeScript 脆弱性パターン | semgrep registry live |
| 4 | CodeQL | GitHub CodeQL | SQL injection / XSS / prototype pollution / SSRF 等 | GitHub 管理クエリ (実行時 fetch) |
| 5 | OSV-Scanner | Google OSV | OSS 依存脆弱性 (npm 以外も含む) | osv.dev DB live |
| 6 | Trivy | Aqua Security | CVE + secure coding | Trivy DB (job 起動時同期) |
| 7 | Security Score Gate | `scripts/security-check.ts` | 独自パターン (SQL injection キーワード / Prisma unsafe API / banned auth pattern 等) + pnpm audit | プロジェクト固有 + live |

最後の **8 番目 = Attack Matrix Summary** は GitHub Actions の Job Summary に攻撃種別マトリクスを日本語で出力する (= 検査結果の可視化)。

### 2.1 `scripts/security-check.ts` (独自スクリプト) の主な検出

| パターン | 検出するもの | KDD |
|---|---|---|
| **SQL injection キーワード** | `$queryRawUnsafe` / `$executeRawUnsafe` / 文字列連結 `${x}` を含む raw SQL | §5.X+86 |
| **Prisma unsafe API** | `findRaw` / `aggregateRaw` 等の non-parametrized 経路 | §5.X+86 |
| **Remote property injection** | 動的キー書き込み (`obj[req.body.key] = ...` 等) | §5.X+87 / §5.X+88 |
| **CSP / nonce 不整合** | `Content-Security-Policy` ヘッダの strict-dynamic + nonce 検証 | §5.X+44 |
| **Cookie 属性** | `sameSite` / `httpOnly` / `secure` 欠落 | §5.X+103 |
| **Banned auth pattern** | NextAuth v5 で `useSession().update()` 直接使用等 (`scripts/check-banned-auth-patterns.ts`) | [MEMORY: feedback_netlify_nextauth_set_cookie](../../CLAUDE.md) |

---

## 3. 典型的な失敗パターンと対処

### 3.1 Remote property injection (HIGH) — CodeQL / security-check.ts

**典型エラーログ**:
```
CodeQL: Remote property injection (CWE-915)
  src/lib/sanitize.ts:23
  > obj[key] = value;
```

**原因**: 外部入力 (req.body / req.query) を直接プロパティキーとして書き込む → prototype pollution の余地 (`__proto__` / `constructor` / `prototype` への上書き)。

**対処** (KDD §5.X+87 / §5.X+88):

```ts
// ❌ NG
function sanitize(obj: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = value;  // ← 動的キー書き込み
  }
  return result;
}

// ✅ OK: Object.create(null) + 特殊キー除外 (§5.X+87)
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function sanitize(obj: Record<string, unknown>) {
  const result = Object.create(null);
  for (const [key, value] of Object.entries(obj)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    result[key] = value;
  }
  return result;
}

// ✅ さらに堅牢 (§5.X+88): JSON.stringify replacer で動的キー書き込み自体を排除
function sanitize(obj: unknown) {
  return JSON.parse(
    JSON.stringify(obj, (key, value) => {
      if (FORBIDDEN_KEYS.has(key)) return undefined;
      return value;
    })
  );
}
```

### 3.2 SQL injection (CRITICAL) — Semgrep / CodeQL / security-check.ts

**典型エラーログ**:
```
security-check.ts: CRITICAL: SQL injection pattern detected
  src/services/audit.service.ts:45
  > prisma.$queryRawUnsafe(`SELECT * FROM audit_logs WHERE action = '${action}'`)
```

**原因**: Prisma の `$queryRawUnsafe` / `$executeRawUnsafe` への文字列連結。

**対処** (KDD §5.X+86):

```ts
// ❌ NG (SQL injection)
const result = await prisma.$queryRawUnsafe(
  `SELECT * FROM audit_logs WHERE action = '${action}'`
);

// ✅ OK: prepared statement (タグ付きテンプレート)
const result = await prisma.$queryRaw`
  SELECT * FROM audit_logs WHERE action = ${action}
`;

// ✅ OK: 静的 SQL + params 配列
const result = await prisma.$queryRawUnsafe(
  'SELECT * FROM audit_logs WHERE action = $1',
  action
);
```

**security-check.ts の罠** (KDD §5.X+86): コメント内に `$queryRawUnsafe` 等のキーワードが書かれているだけでも文字列マッチで CRITICAL 検出される。対処は **コメントからも対象 API 名を除去** する (説明文を別文言に書き換え)。

### 3.3 CSP / strict-dynamic / nonce — CodeQL

**典型エラーログ**:
```
CodeQL: Missing Content Security Policy nonce on inline script
```

**対処** (KDD §5.X+44):

- inline script を排除 → 外部 JS ファイルに移動
- どうしても inline が必要なら `nonce={nonce}` を `<script>` に付与
- `Content-Security-Policy` ヘッダで `script-src 'strict-dynamic' 'nonce-XXX'`
- middleware で nonce を生成 → Server Component に伝搬

KDD §5.X+44 では「graceful degradation で粘らず、完全 rollback の勇気」が結論。CSP は仕様の罠が多いので、2 段階修正で粘らない方が良いケースが多い。

### 3.4 Cookie sameSite / httpOnly / secure — security-check.ts

**典型エラーログ**:
```
security-check.ts: Cookie 'session_token' missing sameSite attribute
```

**対処** (KDD §5.X+103):

```ts
// ❌ NG
res.cookies.set('session_token', token);

// ✅ OK
res.cookies.set('session_token', token, {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',   // Stripe Checkout コールバックは 'strict' だと壊れる (§5.X+103)
  maxAge: 60 * 60 * 24,
  path: '/',
});
```

**罠** (KDD §5.X+103): Stripe Checkout コールバックでは `sameSite='strict'` だと cookie が脱落して認証セッションが切れる。`'lax'` を採用するか、Stripe コールバック専用 cookie を別途定義する。

### 3.5 npm audit (HIGH 以上)

**典型エラーログ**:
```
pnpm audit: 1 high severity vulnerability found
  Package: foo-lib  Severity: high  CVE: CVE-2026-XXXXX
```

**対処**:

```bash
pnpm audit              # 全脆弱性の一覧
pnpm audit --fix        # 自動修正可能なら適用
pnpm update foo-lib     # 個別 update
```

- patch / minor で済むなら即適用
- breaking change を含む major update は別 PR (回帰テスト必須)
- 修正版がまだ release されていない場合は [DEPENDENCY_VULNERABILITY_PROCESS.md](../operations/DEPENDENCY_VULNERABILITY_PROCESS.md) のプロセスで判断 (一時的 ignore + 監視等)

### 3.6 Banned auth pattern — `scripts/check-banned-auth-patterns.ts`

**典型エラーログ**:
```
check-banned-auth-patterns: Banned pattern detected
  src/components/settings/theme-selector.tsx:15
  > await update({ theme: nextTheme });
```

**対処** ([MEMORY: feedback_netlify_nextauth_set_cookie](../../CLAUDE.md)): NextAuth v5 + Netlify では `useSession().update()` が Set-Cookie 脱落で壊れる。

- テーマは **専用 cookie** を直接書き込む (= `document.cookie` or Server Action 経由)
- MFA / Timezone / Locale は `src/lib/auth-jwt-helper.ts` の **JWT 再署名ヘルパ** を使う

### 3.7 Secret leak — gitleaks

**典型エラーログ**:
```
gitleaks: Found 1 leak
  Rule: stripe-secret-key
  File: src/lib/stripe.ts:3
  Match: STRIPE_SECRET_KEY=sk_live_xxxxxxxxxxxxxxx
```

**対処**:

1. **即座に対象 secret を rotate** (Stripe / Supabase / GitHub PAT 等)
2. リポジトリから除去 (= `git filter-repo` or BFG で history も削除)
3. `.env.local` に移動 → `.gitignore` で除外確認
4. PR を closeなおして clean な branch から作成し直す

**重要**: コミットされた時点で「漏洩済」扱い。秘密情報はローカル `.env.local` のみで保持。

---

## 4. 修正フロー (汎用手順)

### 4.1 CI fail を見たら

1. **Actions タブで失敗 Job を開く** → Step ごとに log を確認
2. **複数 Job が同時 fail なら最初の Job から見る** (連鎖症状の場合あり)
3. 具体的なエラーメッセージ (CWE-XXX / CVE-XXX / file:line) を抽出

### 4.2 KDD を検索

```bash
# 関連 KDD を検索 (本プロジェクトでは Grep tool 推奨)
grep -i "security\|sql injection\|prototype pollution\|csp" docs/knowledge/KDD_PATTERNS.md
```

または `docs/knowledge/KDD_PATTERNS.md` を開いて **§5.X+44 / §5.X+86 / §5.X+87 / §5.X+88 / §5.X+103** 等の security 関連 KDD を一覧確認。

### 4.3 修正 → ローカルで再現テスト

```bash
# 独自スクリプトの再実行
pnpm security:check       # score 表示
pnpm security:gate        # CI と同じく 90 点未満で fail

# 個別の banned auth pattern チェック
pnpm check:banned-auth-patterns

# npm audit
pnpm audit --audit-level=high
```

### 4.4 PR push → CI で再検証

- CI が green になることを確認
- レビュアーへ「セキュリティ修正の意図 / KDD 参照 / 残課題」を PR description に追記

### 4.5 KDD に新規パターンを追記

新しい罠を踏んだら **`docs/knowledge/KDD_PATTERNS.md` に §5.X+N 形式で追記** (番号は最大+1)。形式:

```markdown
## 5.X+NNN **<事象タイトル> (YYYY-MM-DD / PR #XXX)**

### 症状
...

### 根本原因
...

### 修正
```ts
// before / after
```

### 横展開チェック
```bash
grep ...
```

### 関連
- KDD §5.X+...
```

---

## 5. 手動セキュリティチェック (ローカル)

```bash
# 全部入り (CI と同じ score gate)
pnpm security:gate

# 個別実行
pnpm security:check                 # score 表示 (fail しない)
pnpm check:banned-auth-patterns     # NextAuth/auth-jwt-helper パターン
pnpm audit --audit-level=high       # 依存脆弱性
```

CI 環境で走る Semgrep / CodeQL / OSV / Trivy はローカルでは実行しない (実行時 fetch + heavy 処理のため)。
ローカルで完全に再現したい場合は [act](https://github.com/nektos/act) で workflow 単位の実行が可能 (= advanced)。

---

## 6. オプション: `/security-review` skill 経由の ultrareview

ハイリスク PR (認可 / Stripe / migration / SQL を直接触る) の場合、Claude Code の `/security-review` skill 経由で **追加レビューを依頼** できる。

- AI の指摘は「参考」扱い、最終判断は人間
- 指摘が KDD と矛盾していれば KDD を優先
- 修正後に再度 `/security-review` で確認するサイクル

> 緊急時のみ Claude Code を使う運用 ([CLAUDE.md](../../CLAUDE.md)) なので、通常の PR では人間レビュー + CI の自動チェックで十分。

---

## 7. CI fail を防ぐ事前チェックリスト (コミット前)

PR 作成前に以下を順に確認:

- [ ] `pnpm security:gate` がローカルで green
- [ ] `pnpm check:banned-auth-patterns` が green
- [ ] `pnpm audit --audit-level=high` で vulnerabilities なし
- [ ] `.env.local` / API キー / トークンを直書きしていない (gitleaks 対策)
- [ ] 新規 `prisma.$queryRaw...` を書いていない (書く場合は parametrized + KDD §5.X+86 を確認)
- [ ] 動的プロパティ書き込み (`obj[key] = ...` で key が外部入力) がない (KDD §5.X+87)
- [ ] 新規 cookie に `sameSite` / `httpOnly` / `secure` を付与 (KDD §5.X+103)
- [ ] NextAuth v5 で `useSession().update()` を直接呼んでいない ([MEMORY: feedback_netlify_nextauth_set_cookie](../../CLAUDE.md))

---

## 関連ドキュメント

- [docs/security/README.md](../security/README.md) — セキュリティディレクトリ索引
- [docs/security/STRIDE_REVIEW_PROCEDURE.md](../security/STRIDE_REVIEW_PROCEDURE.md) — STRIDE 脅威モデリング手順
- [docs/operations/SECURITY_OPS.md](../operations/SECURITY_OPS.md) — 運用セキュリティ手順
- [docs/operations/DEPENDENCY_VULNERABILITY_PROCESS.md](../operations/DEPENDENCY_VULNERABILITY_PROCESS.md) — 依存パッケージ脆弱性対応
- [docs/design/SECURITY.md](../design/SECURITY.md) — 権限制御設計 + 多層防御
- [docs/knowledge/KDD_PATTERNS.md](../knowledge/KDD_PATTERNS.md) — 過去のセキュリティ罠と教訓
- [`.github/workflows/security.yml`](../../.github/workflows/security.yml) — CI 定義
- [`scripts/security-check.ts`](../../scripts/security-check.ts) — 独自セキュリティチェック実装
- [DEVELOPMENT_FLOW.md Phase 6](./DEVELOPMENT_FLOW.md) — レビュー観点における security の位置

---

**最終更新**: 2026-05-22 (PR #425 ベース)

**関連 KDD**:
- §5.X+44 — CSP graceful degradation の 2 段階修正 (粘らず rollback の勇気)
- §5.X+86 — security-check.ts の SQL injection キーワード文字列マッチ (コメントも対象)
- §5.X+87 — Remote property injection 初回対策 (`Object.create(null)` + FORBIDDEN_KEYS)
- §5.X+88 — Remote property injection 完全対策 (`JSON.stringify` replacer で動的キー書き込み排除)
- §5.X+103 — Stripe Checkout cookie sameSite='strict' の罠 (請求堅牢性)
- [MEMORY: feedback_netlify_nextauth_set_cookie](../../CLAUDE.md) — NextAuth v5 + Netlify で `update()` 禁止
