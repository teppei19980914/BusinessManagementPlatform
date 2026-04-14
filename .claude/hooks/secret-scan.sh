#!/usr/bin/env bash
# Stop hook: コミット前にワークツリーをスキャンして機密情報の混入を検出する
# gitleaks がインストールされていればそれを優先、なければ grep ベースで簡易検査
# 検出時は終了コード 2 で停止（Claude にも通知される）

set -u

cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" || exit 0

echo "=== Secret Scan ==="

# 1) gitleaks があれば使う
if command -v gitleaks >/dev/null 2>&1; then
  if ! gitleaks detect --no-banner --redact --exit-code 2 --source . ; then
    echo "BLOCKED: gitleaks が機密情報を検出しました。コミット前に除去してください。" >&2
    exit 2
  fi
  echo "gitleaks: クリーン"
  exit 0
fi

# 2) フォールバック: grep ベースの簡易スキャン
#    対象は git で追跡されている / ステージされているファイル + 未追跡ファイル
FILES="$(git ls-files --cached --others --exclude-standard 2>/dev/null | grep -viE '\.(png|jpg|jpeg|gif|svg|ico|pdf|zip|gz|woff2?|ttf|eot|mp4|mp3|lock)$' | grep -viE '(^|/)(node_modules|dist|build|\.next|\.venv|venv|target|coverage)/' || true)"

if [ -z "$FILES" ]; then
  echo "スキャン対象ファイルなし"
  exit 0
fi

PATTERNS=(
  'AKIA[0-9A-Z]{16}'                                  # AWS Access Key ID
  'aws_secret_access_key[[:space:]]*=[[:space:]]*["'\''"][A-Za-z0-9/+=]{40}'
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'                # Private key
  'xox[baprs]-[0-9a-zA-Z-]{10,}'                      # Slack token
  'ghp_[A-Za-z0-9]{36}'                               # GitHub PAT
  'gho_[A-Za-z0-9]{36}'                               # GitHub OAuth
  'sk-[A-Za-z0-9]{20,}'                               # OpenAI / Anthropic 系
  'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}'  # JWT
  '(password|passwd|pwd|secret|api[_-]?key|access[_-]?token)[[:space:]]*[:=][[:space:]]*["'\''][^"'\'' ]{8,}["'\'']'
)

HITS=0
for pat in "${PATTERNS[@]}"; do
  # .env.example / *.md / テストフィクスチャは除外
  matches="$(echo "$FILES" | xargs -I{} grep -HInE "$pat" "{}" 2>/dev/null | grep -viE '(^|/)(\.env\.example|.*\.md|.*test.*fixture.*|.*\.test\.|.*\.spec\.)' || true)"
  if [ -n "$matches" ]; then
    echo "[!] パターン検出: $pat" >&2
    echo "$matches" | sed 's/=.*/=<REDACTED>/' >&2
    HITS=$((HITS + 1))
  fi
done

if [ "$HITS" -gt 0 ]; then
  echo "" >&2
  echo "BLOCKED: $HITS 件の機密情報候補が検出されました。" >&2
  echo "  - 環境変数化 (.env) と .gitignore への追加を検討してください" >&2
  echo "  - テスト用のダミー値であれば、明示的に test/example の名前を含むファイルに移してください" >&2
  exit 2
fi

echo "secret-scan: クリーン"
exit 0
