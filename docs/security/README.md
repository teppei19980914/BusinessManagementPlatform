# docs/security/

セキュリティチェックスクリプトの出力先ディレクトリ。

## 自動生成ファイル

以下は `pnpm tsx scripts/security-check.ts` 実行で再生成されます。**`.gitignore` で commit 対象外**:

| ファイル | 用途 |
|---|---|
| `security-report.html` | 人間向けビジュアルレポート (ブラウザで確認) |
| `SECURITY-TASKS.md` | Claude Code 向け修正タスクシート (修正実装の指示書) |

## 実行方法

```bash
pnpm tsx scripts/security-check.ts
```

> **2026-05-09 改訂**: ローカル必須実行は撤廃され、`.github/workflows/security.yml` の **CI 自動実行 (PR ごと、閾値 90/100)** に一本化されました。手動実行はユーザ依頼時 (大規模リファクタ後の追加検査 / CI で score 低下が報告された時) のみ。

詳細手順は [.claude/skills/threat-model.md の「Mode B」セクション](../../.claude/skills/threat-model.md) と
CLAUDE.md「コミット前チェック」セクションを参照。

## レポートの確認

```bash
# ブラウザで HTML を開く (Windows)
start docs/security/security-report.html
# macOS
open docs/security/security-report.html
# Linux
xdg-open docs/security/security-report.html
```

## CI 統合 (PR #198 で実装済)

`.github/workflows/security.yml` で `pnpm tsx scripts/security-check.ts --min-score=90` を
PR ごとに自動実行。score < 90 で deploy をブロック。詳細は [docs/developer-guide/REFERENCE.md §5.48](../developer-guide/REFERENCE.md) 参照。
