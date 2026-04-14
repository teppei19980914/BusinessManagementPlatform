#!/usr/bin/env bash
# PreToolUse hook: Write/Edit を事前に検査し、危険なパターンをブロックする
# 終了コード 2 で stderr に理由を出力すると Claude Code はツール実行を中止する

set -u

INPUT="${CLAUDE_TOOL_INPUT:-}"
if [ -z "$INPUT" ]; then
  # stdin からも受け取れるようフォールバック
  INPUT="$(cat || true)"
fi

# 1) 機密ファイルへの書き込みをブロック
if echo "$INPUT" | grep -qiE '"file_path"[[:space:]]*:[[:space:]]*"[^"]*(\.env(\.[a-z]+)?|\.pem|\.key|\.p12|\.pfx|id_rsa|credentials\.json|secrets\.ya?ml)"'; then
  echo "BLOCKED: 機密情報を含む可能性があるファイルへの編集は禁止されています (.env/.pem/.key/credentials.json 等)" >&2
  echo "  - .env.example のようなテンプレートファイルを編集してください" >&2
  exit 2
fi

# 2) 危険なAPI/コードパターンをブロック
#    - eval / new Function : 任意コード実行
#    - innerHTML = / dangerouslySetInnerHTML : XSS リスク
#    - document.write : XSS / DOM 破壊
#    - child_process.exec(変数) : コマンドインジェクション疑い
#    - SQL 文字列連結 : SQL インジェクション疑い
DANGEROUS_PATTERNS='(\beval\s*\(|new\s+Function\s*\(|\.innerHTML\s*=[^=]|dangerouslySetInnerHTML|document\.write\s*\(|child_process[^.]*\.exec\s*\(\s*[`"'\''+]*\$\{|execSync\s*\(\s*[`"'\''+]*\$\{)'

if echo "$INPUT" | grep -qE "$DANGEROUS_PATTERNS"; then
  echo "BLOCKED: 危険なAPI/パターンの使用が検出されました" >&2
  echo "  検出されたパターン例: eval / new Function / innerHTML / dangerouslySetInnerHTML / document.write / 動的 exec" >&2
  echo "  代替案:" >&2
  echo "    - innerHTML        → textContent もしくはフレームワークのバインディング" >&2
  echo "    - eval/new Function → JSON.parse やホワイトリスト方式" >&2
  echo "    - exec(\${var})    → execFile + 引数配列、または入力検証" >&2
  echo "  どうしても必要な場合はユーザーに確認の上、明示的に承認を得てから実装してください。" >&2
  exit 2
fi

# 3) SQL 文字列連結の簡易検知 (典型パターンのみ)
if echo "$INPUT" | grep -qiE '(SELECT|INSERT|UPDATE|DELETE)[^"'\'']*["'\'']\s*\+\s*[a-zA-Z_]'; then
  echo "BLOCKED: SQL 文字列連結の可能性があります。プリペアドステートメント/パラメータバインドを使用してください。" >&2
  exit 2
fi

exit 0
