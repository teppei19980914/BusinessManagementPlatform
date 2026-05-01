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

詳細手順は **CLAUDE.md §2 セキュリティチェック (5層目: 静的スキャン)** および
[.claude/skills/threat-model.md の「既存コードの静的スキャン」セクション](../../.claude/skills/threat-model.md) を参照。

## レポートの確認

```bash
# ブラウザで HTML を開く (Windows)
start docs/security/security-report.html
# macOS
open docs/security/security-report.html
# Linux
xdg-open docs/security/security-report.html
```

## CI への組み込み (将来検討)

`scripts/security-check.ts` のヘッダコメントに記載の通り、GitHub Actions で
週次実行 + main 直 push 時実行を追加すれば継続的に検出できます。
