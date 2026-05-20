# セキュリティアセスメント (Security Assessment)

> **本ドキュメントは時点記録 (snapshot)**: 最終アセスメント実施日に基づく評価。コード変更後は陳腐化する可能性があるため、四半期に 1 回 (もしくは認証/認可周りの大改修後) の再アセスメントを推奨。
>
> **最終更新**: 2026-05-20 (PR #415 / fix/session-clearance)

---

## 1. 目的

本サービス「たすきば」 (Next.js + Prisma + NextAuth v5 + Netlify) のセキュリティ実装状況を OWASP Top 10 観点で網羅的に評価し、**個人情報漏洩リスクの定量化** と **改善優先順位の明確化** を行う。

運用ドキュメントとの関係:
- [SECURITY_OPS.md](SECURITY_OPS.md): 日常運用のセキュリティチェック手順 (オペレーション主体)
- [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md): 障害発生時の対応手順 (リアクティブ)
- 本ドキュメント: 設計面でのセキュリティ評価 (プロアクティブ)

---

## 2. 総合評価 (2026-05-20 時点)

| 観点 | 評価 |
|---|---|
| **総合スコア** | **94 / 100** (scripts/security-check.ts 自動判定) |
| Critical | **0 件** |
| High | **0 件** |
| Medium | **1 件** (PR #415 で解消済) |
| 個人情報漏洩リスク | **低** (重大経路は構造的に阻止済) |

---

## 3. OWASP Top 10 (2021) 対応状況

### A01: Broken Access Control (認可制御の不備)

**評価: ✅ 対応済 (二重防御)**

- **テナント境界**: [src/lib/permissions/tenant.ts](../../src/lib/permissions/tenant.ts) の `requireSameTenant()` / `tenantScope()` で全 service 層に強制
- **API route 認証**: [src/lib/api-helpers.ts:47-79](../../src/lib/api-helpers.ts#L47-L79) `getAuthenticatedUser` で tokenVersion + isActive + deletedAt 検証
- **Server Component 認証**: [src/lib/page-auth.ts](../../src/lib/page-auth.ts) `requireAuthForLayout()` で同等検証 (PR #415 で追加)
- **メンバーシップ + ロール**: [src/lib/api-helpers.ts:85-121](../../src/lib/api-helpers.ts#L85-L121) `checkProjectPermission()`
- **既知の severity-1 対策**: memory `feedback_tenant_isolation.md` (一覧系サービスは viewerTenantId 必須)
- **CI ガード**: [scripts/check-banned-auth-patterns.ts](../../scripts/check-banned-auth-patterns.ts) で退行検出

### A02: Cryptographic Failures (暗号関連の不備)

**評価: ✅ 対応済**

- **パスワード**: bcryptjs でハッシュ化 ([src/lib/auth.ts:152](../../src/lib/auth.ts#L152))。レインボーテーブル耐性あり
- **NEXTAUTH_SECRET**: 32 byte random、`.env` 管理、コミット禁止
- **JWT**: HS256 署名 (NextAuth デフォルト)、tokenVersion による失効機構付き
- **Cookie**: `httpOnly: true` / `sameSite: 'strict'` / `secure: true` (prod) / 永続化なし (= session cookie)
- **HTTPS 強制**: Netlify が自動付与 + HSTS ヘッダ (max-age=63072000) で 2 年強制

### A03: Injection (インジェクション)

**評価: ✅ 対応済**

- **SQL Injection**: Prisma Client 経由でパラメータ化済。`$queryRaw` / `$executeRaw` 17 箇所はすべて tagged template literal で安全
- **XSS**: React の自動エスケープに依存。生 HTML 注入 API の使用箇所 **0 件**
- **markdown**: react-markdown で raw HTML を既定で拒否 ([src/components/ui/markdown-textarea.tsx](../../src/components/ui/markdown-textarea.tsx))
- **コマンドインジェクション**: ユーザ入力で `child_process` を呼ぶ箇所 なし
- **OS コマンド注入**: 該当なし (シェル実行コード なし)
- **動的コード実行**: 該当なし (動的関数生成 / 動的 require / 動的 import の悪用なし)

### A04: Insecure Design (安全でない設計)

**評価: ✅ 対応済 (継続的改善)**

- **多層防御**: 認証 → middleware → layout → API helper → service 層と段階的に検証
- **fail-closed**: LLM 呼出失敗時は処理を中断 (継続しない)
- **failure mode の明示**: 例 [src/lib/auth-jwt-helper.ts](../../src/lib/auth-jwt-helper.ts) の `ReissueResult` 判別 union
- **設計レビュー**: STRIDE 手法による定期的なレビュー ([docs/security/STRIDE_REVIEW_PROCEDURE.md](../security/STRIDE_REVIEW_PROCEDURE.md))
- **KDD (Knowledge-Driven Development)**: 過去の罠を [docs/knowledge/KDD_PATTERNS.md](../knowledge/KDD_PATTERNS.md) に集約、新規開発時の参照源

### A05: Security Misconfiguration (セキュリティ設定の誤り)

**評価: ✅ 対応済**

- **HTTP セキュリティヘッダ** ([next.config.ts](../../next.config.ts)):
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY` (clickjacking 対策)
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Strict-Transport-Security: max-age=63072000`
  - `Permissions-Policy: camera=() microphone=() geolocation=()`
- **CSP**: `default-src 'self'`, `frame-ancestors 'none'`, `style-src 'self' 'unsafe-inline'`, `script-src 'self' 'unsafe-inline'`
  - **`script-src 'unsafe-inline'` は受容項目** (Next.js HMR / hydration 要件、CSP nonce 化は KDD §5.X+43 で取り下げ、post-MVP で再挑戦)
  - XSS 一次防御 (危険 API ゼロ) が強固なため許容範囲
- **エラーメッセージ**: 列挙攻撃を防ぐ汎用文言 (例「メールまたはパスワードが正しくありません」)

### A06: Vulnerable and Outdated Components (脆弱な/古い依存)

**評価: ✅ 対応済**

- **`pnpm audit`**: クリーン (Known vulnerabilities: 0)
- **Dependabot**: [`.github/dependabot.yml`](../../.github/dependabot.yml) で GitHub Actions 週次 + npm 月次更新
- **既知の許容項目**: `next-auth@5.0.0-beta.31` (公式 beta、stable 未リリースのため設計判断で許容)
- **依存追跡プロセス**: [DEPENDENCY_VULNERABILITY_PROCESS.md](DEPENDENCY_VULNERABILITY_PROCESS.md) で明文化済

### A07: Identification and Authentication Failures (認証の不備)

**評価: ✅ 対応済 (PR #415 で再強化)**

- **パスワード強度**: zod validator で最小 8 文字 + 英数記号要件
- **アカウントロック**: 5 回失敗で 30 分 ([src/lib/auth.ts:168-180](../../src/lib/auth.ts#L168-L180))、累積で永続ロック
- **MFA (TOTP)**: 全 admin で必須化、`/login/mfa` で都度検証 ([src/app/(auth)/login/mfa/](../../src/app/(auth)/login/mfa/))
- **Rate Limiting**: login (max 20 / 5 分) + signup / password-reset / lock-status (max 10 / 5 分) を IP 単位で実装
- **★ ログアウト信頼性**: PR #415 で tokenVersion increment + cookie 削除 + login pre-clear の三重防御に切替 (KDD §5.X+84)
- **CI ガード**: 旧 signOut 系の退行を機械的に検出 ([scripts/check-banned-auth-patterns.ts](../../scripts/check-banned-auth-patterns.ts))

### A08: Software and Data Integrity Failures (データ完全性の不備)

**評価: ✅ 対応済 (継続監視)**

- **CSRF**: NextAuth CSRF token + `sameSite: 'strict'` cookie で多層防御
- **JWT 改竄**: HS256 署名検証 + tokenVersion による DB 失効 ([src/lib/api-helpers.ts:53-70](../../src/lib/api-helpers.ts#L53-L70))
- **deserialize 攻撃**: 該当なし (動的コード実行 API の使用なし)
- **依存パッケージの改竄**: pnpm の lockfile hash + Dependabot 通知で監視

### A09: Security Logging and Monitoring Failures (ログ・監視の不備)

**評価: ⚠️ 部分対応 (一部改善余地)**

**対応済**:
- **認証イベントログ**: `auth_event_logs` テーブルに login_success / login_failure / logout / lock を全件記録 ([src/services/auth-event.service.ts](../../src/services/auth-event.service.ts))
- **監査ログ**: super_admin 操作 (テナント作成 / ユーザ削除 / 課金変更等) を `audit_logs` テーブルに記録
- **エラーログ**: `system_error_logs` テーブルに集約 (PR #115)
- **個人情報マスキング**: `maskEmailForLog()` ([src/lib/auth.ts:14-20](../../src/lib/auth.ts#L14-L20)) で email 部分マスク
- **機密漏洩検出**: [scripts/security-check.ts](../../scripts/security-check.ts) で console.log への機密情報出力を CI で検出

**改善余地** (post-MVP 候補):
- **アラート自動化**: 現状は SQL クエリで人手確認。Sentry / Datadog 連携で異常時通知の自動化が望ましい
- **監査ログの beforeValue 保存**: 現状は afterValue のみ。修正前値の復元に手間がかかる
- **長期保管**: 1 ヶ月超過ログの S3 archive 化 (現状は手動 truncate)

### A10: Server-Side Request Forgery (SSRF)

**評価: ✅ 対応済**

- **外部 HTTP 呼出**: Anthropic API / Voyage / Stripe / Brevo / Resend のみ。ホスト名は環境変数 (= ユーザ入力起因の SSRF なし)
- **添付 URL の検証**: [src/lib/validators/attachment.ts:31-55](../../src/lib/validators/attachment.ts#L31-L55) で `http(s)://` のみ許可、その他のスキーマ (script 系 / data 系 / file 系) を拒否
- **画像読込**: `img-src 'self' data:` CSP で外部画像読込を制限

---

## 4. 受容項目 (明示的に許容しているリスク)

以下は技術的・運用的制約から「現状受容」と判断している項目。**6/1 リリース後にユーザベース拡大時に再評価**を必須とする。

| 項目 | 受容理由 | 再評価のトリガ |
|---|---|---|
| `script-src 'unsafe-inline'` (CSP) | Next.js 16 hydration が `nonce` 不互換 (KDD §5.X+43 で 2 度試行 → 取り下げ済)。XSS 一次防御 (危険 API 0 件) が強固なため代替防御で許容 | Next.js 17+ で hydration が改善 / 第三者 pen test で指摘 |
| `next-auth@5.0.0-beta.31` | 公式 beta、stable 未リリース。Migration 計画は post-MVP | NextAuth v5 stable リリース時 |
| Rate Limit が in-memory (分散非対応) | Netlify Functions の serverless 分散環境では完全な制限不可。多層防御の 1 層として機能 | Redis 等の分散ストア導入時 |
| 監査ログのリアルタイムアラート未実装 | 1 人運用フェーズでは SQL 手動確認で十分。MVP 集中 | チーム拡大 / ユーザ 100+ 到達時 |
| ペネトレーションテスト未実施 | リリース前は内部レビューのみ | **6/1 リリース後、外部公開フェーズ前に必須** (下記 §6 参照) |

---

## 5. 過去アセスメント履歴

| 日付 | 実施者 | スコア | 主な発見 |
|---|---|---|---|
| 2026-05-20 | Claude Code (PR #415 監査時) | 94/100 | F-01 (Medium) を同 PR で解消、Critical/High 0 件 |
| (以降、四半期毎に追記) |  |  |  |

---

## 6. 推奨 Next Actions

### 6.1 短期 (リリース前 / リリース直後)

- [ ] **Netlify Deploy Preview での実機検証** (PR #415 の T-15、ユーザ作業依頼中)
- [ ] **CI ガードの稼働確認** (本 PR で追加した `check-banned-auth-patterns`)

### 6.2 中期 (リリース後 1〜3 ヶ月)

- [ ] **第三者ペネトレーションテスト の実施 (★ 推奨)**
  - 対象: 認証フロー / テナント越境 / 課金 API
  - 業者: 国内であれば LAC / 神戸デジタル・ラボ / SecureNavi 等が知名度高い
  - 想定費用: 100〜300 万円 (規模次第)
  - **理由**: 本サービスは個人情報 + 課金情報を扱うため、外部公開フェーズ前の独立検証は事業継続上のリスクヘッジ
- [ ] **CSP nonce 化への再挑戦** (Next.js 17+ で hydration 改善時)
- [ ] **監査ログのアラート自動化** (Sentry / Datadog 連携)

### 6.3 長期 (post-MVP / V1.x)

- [ ] **NextAuth セッション戦略を DB 方式に移行** (KDD §5.X+84 の根本解)
- [ ] **Rate Limit を分散ストア (Redis 等) に移行**
- [ ] **SBOM (Software Bill of Materials) 生成 + SLSA 対応**
- [ ] **ISMS / SOC2 認証取得検討** (B2B 顧客拡大時)

---

## 7. アセスメント実施手順

四半期再アセスメント時は以下を実施:

1. `pnpm security:gate` を実行 (スコア 90 未満なら fail)
2. `pnpm audit` を実行 (Critical/High なら即対応)
3. 本ドキュメントの §3 OWASP 各項目を最新コードに照らして再評価
4. §4 受容項目の有効性を再確認 (前提が変わっていないか)
5. §5 アセスメント履歴に新エントリ追加
6. 必要に応じて §6 Next Actions を更新

外部ペン テスト後は本ドキュメント全体を見直し、発見事項を §6 / §4 に統合する。
