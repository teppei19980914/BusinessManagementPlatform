# docs/security/

セキュリティチェックスクリプトの出力先ディレクトリ。

## 自動生成ファイル

以下は `pnpm tsx scripts/security-check.ts` 実行で再生成されます。**`.gitignore` で commit 対象外**:

| ファイル | 用途 |
|---|---|
| `security-report.html` | 人間向けビジュアルレポート (ブラウザで確認) |
| `SECURITY-TASKS.md` | Claude Code 向け修正タスクシート (修正実装の指示書) |

## 実行方法 (ローカル)

```bash
pnpm tsx scripts/security-check.ts
```

> **2026-05-09 改訂**: ローカル必須実行は撤廃され、`.github/workflows/security.yml` の **CI 自動実行 (PR ごと、閾値 90/100)** に一本化されました。手動実行はユーザ依頼時 (大規模リファクタ後の追加検査 / CI で score 低下が報告された時) のみ。

STRIDE 脅威モデリング手順は四半期ごとに手動実施します。詳細は [STRIDE_REVIEW_PROCEDURE.md](./STRIDE_REVIEW_PROCEDURE.md) を参照。
過去の脅威モデル例: [SUGGESTION_ENGINE_THREAT_MODEL.md](./SUGGESTION_ENGINE_THREAT_MODEL.md) / [PHASE2_THREAT_MODEL.md](./PHASE2_THREAT_MODEL.md)。

## レポートの確認

```bash
# ブラウザで HTML を開く (Windows)
start docs/security/security-report.html
# macOS
open docs/security/security-report.html
# Linux
xdg-open docs/security/security-report.html
```

## CI 統合 (PR feat/security-auto-update / 2026-05-09 全面再構成)

`.github/workflows/security.yml` で **7 系統のスキャン** を PR ごと + 毎日 03:00 UTC に自動実行。
すべて **実行のたびに最新の検出ルール / 脆弱性 DB を参照** する構成 (live fetch)。

| # | ジョブ | 検出範囲 | 最新性の出所 |
|---|---|---|---|
| 1 | Secret Scan (gitleaks) | Git 履歴の機密情報漏洩 | gitleaks-action のバンドルルール (Dependabot で週次自動更新) |
| 2 | pnpm audit | npm 依存パッケージの既知 CVE | npm registry advisory API (毎回 live) |
| 3 | Semgrep SAST | OWASP Top 10 / Next.js / TypeScript / React / 一般 SAST | semgrep registry (毎回 fetch、token 不要 community ruleset) |
| 4 | CodeQL Analysis | 高度な SAST (security-extended + security-and-quality) | github/codeql-action@v3 がジョブ実行時に最新クエリを fetch |
| 5 | OSV-Scanner | OSS 横断の脆弱性 DB (Google) | OSV.dev (毎回 live、CVE 公開直後の事案も取得) |
| 6 | Trivy | CVE / IaC 設定不備 / secrets (Aqua) | Aqua DB (ジョブ起動時に同期、SARIF で GitHub Security tab に投稿) |
| 7 | Security Score Gate | プロジェクト固有の設計パターン回帰検査 (callbackUrl 検証 / SameSite / Rate-limit / CSP 等) | `scripts/security-check.ts` 内のハードコード正規表現 + pnpm audit live |

詳細は [docs/developer-guide/REFERENCE.md §5.48 / §5.X+9](../developer-guide/REFERENCE.md) 参照。

### 自動更新の仕組み (Dependabot)

`.github/dependabot.yml` が以下をスケジュール実行:

- **github-actions エコシステム**: 週次 (毎週月曜 03:00 JST)
  → gitleaks-action / codeql-action / pnpm/action-setup / actions/setup-node 等が古くならない
- **npm エコシステム**: 月次 + セキュリティアップデートは即時 PR 化

これにより **アクションの pin が古くなって新検出ルールに追従できない** 問題を防ぎ、
「全自動で最新情報をもとに検査される」状態を継続維持します。

### 限界 (Security Score Gate のみ部分的に手動メンテ)

Security Score Gate (`scripts/security-check.ts`) のうち、**プロジェクト固有の設計パターン**
(callbackUrl 検証 / SameSite / Rate-limit 等) は仕組み上ハードコード正規表現のため、
新しい設計パターンを追加する際は、`scripts/security-check.ts` に check 関数を追記して
スコア計算ロジックに組み込みます。**ただし、汎用 OSS 脆弱性 / 一般 CWE パターンの検出は上記 1〜6 の
ジョブが自動でカバーする** 設計のため、本 Gate は固有要件の回帰防止に特化しています。
