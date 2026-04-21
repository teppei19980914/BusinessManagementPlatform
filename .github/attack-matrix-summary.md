## 🛡️ 攻撃種別マトリクス (Attack Coverage Matrix)

このリポジトリが**どの攻撃を考慮して実装されているか**を示すサマリーです。
各行は「主な検証手段」が通過すれば ✅、失敗時は ❌、手段が限定的な場合は ⚠️ を表示します。

| 状況 | 攻撃種別 (Attack) | 主な検証手段 | 備考 |
|:---:|---|---|---|
| @@GITLEAKS@@ | 機密情報漏洩 (Secrets Exposure, CWE-798) | gitleaks | git 履歴全走査で API キー / パスワード等を検出 |
| @@AUDIT@@ | 依存脆弱性 (Dependency Vulnerability, CWE-1104) | pnpm audit (--audit-level=high) | high/critical のみ失敗扱い、毎日 03:00 UTC 再実行 |
| @@SAST@@ | SQL インジェクション (SQL Injection, CWE-89) | Semgrep / CodeQL + Prisma ORM | 本プロダクトは全クエリを Prisma 経由 (raw SQL 非使用) |
| @@SAST@@ | クロスサイトスクリプティング (XSS, CWE-79) | Semgrep / CodeQL + React JSX 自動エスケープ | 危険な DOM API 利用は Stop hook でブロック |
| @@SAST@@ | クロスサイトリクエストフォージェリ (CSRF, CWE-352) | next-auth v5 + SameSite=Lax Cookie | API Route は同一オリジンのみ許可 |
| @@SAST@@ | サーバサイドリクエストフォージェリ (SSRF, CWE-918) | Semgrep / CodeQL | 外部 URL fetch は mail 送信プロバイダのみ (allowlist) |
| @@CODEQL@@ | 認証バイパス (Authentication Bypass, CWE-287) | CodeQL + auth middleware | 全 API route で requireAuth / requireAdmin を実施 |
| @@CODEQL@@ | 認可バイパス / IDOR (Authorization Bypass, CWE-639) | CodeQL + checkProjectPermission/checkMembership | プロジェクトリソースは membership 検証必須 |
| @@SAST@@ | コマンドインジェクション (Command Injection, CWE-78) | Semgrep / CodeQL + Stop hook | 動的コード実行系 API は block-dangerous-edit で防御 |
| @@SAST@@ | パス横断 (Path Traversal, CWE-22) | Semgrep / CodeQL | scripts/print-migration.ts は path サニタイズ実装済 |
| @@CODEQL@@ | オープンリダイレクト (Open Redirect, CWE-601) | CodeQL + next-auth callback | リダイレクト先は同一オリジンのみ許可 |
| @@SAST@@ | 正規表現 DoS (ReDoS, CWE-1333) | Semgrep / CodeQL | ユーザ入力正規表現は未使用、pg_trgm で部分一致 |
| @@CODEQL@@ | 型混乱 / 入力検証不備 (Input Validation, CWE-20) | CodeQL + Zod schema | 全 API 入力は validators/*.ts (Zod) で strict parse |
| @@CODEQL@@ | 機密情報ログ漏洩 (Information Exposure via Log, CWE-532) | audit.service sanitizeForAudit | passwordHash / mfaSecret は [REDACTED] に置換 |
| @@CODEQL@@ | ブルートフォース / アカウントロックアウト (Brute Force, CWE-307) | CodeQL + LOGIN_FAILURE_MAX | 5 回失敗で一時ロック、設定は src/config/security.ts |
| @@CODEQL@@ | セッション固定 (Session Fixation, CWE-384) | next-auth v5 + JWT rotation | ログイン成功時に新セッション発行 |
| @@CODEQL@@ | MFA バイパス (MFA Bypass, CWE-287) | CodeQL + middleware redirect | mfaEnabled ユーザは /login/mfa を必ず通過 |

### 凡例

- **✅ 対策検証済** : 主な検証手段が走って success
- **⚠️ 対策は実装済だが検証手段が限定的** : Semgrep が SEMGREP_APP_TOKEN 未設定等で skip
- **❌ 対策の検証が失敗** : 主な検証手段が failure (要修正)

> 注: このマトリクスは「自動スキャン結果 × 実装上の対策設計」を合成した俯瞰ビューです。
> 個別の脆弱性判断は各ジョブ (Secret Scan / pnpm audit / Semgrep / CodeQL) のログをご確認ください。
