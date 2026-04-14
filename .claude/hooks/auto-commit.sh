#!/usr/bin/env bash
# Stop hook: 開発中の自動コミット&プッシュ
#
# 動作:
#   1. git automation が有効か確認
#   2. 現在ブランチが dev/YYYY-MM-DD パターンか確認 (main 等への commit を防止)
#   3. 変更がなければ何もしない
#   4. テスト実行 (失敗ならスキップ — Claude が修正する)
#   5. secret-scan は別 hook で既に実行済 (Stop hook の順序に依存)
#   6. commit & push
#
# 注意: テスト/secret-scan は別の Stop hook で実行される。
#       本スクリプトはそれらが PASS した前提で commit する。

set -u

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$REPO_ROOT" ]; then
  exit 0
fi
cd "$REPO_ROOT"

CONFIG_FILE=".claude/.git-automation-config"

# ========================================
# Step 0: 有効化チェック
# ========================================
[ -f "$CONFIG_FILE" ] || exit 0
# shellcheck disable=SC1090
. "$CONFIG_FILE"
[ "${enabled:-false}" = "true" ] || exit 0

BRANCH_PREFIX="${branch_prefix:-dev/}"

# ========================================
# Step 1: 現在ブランチの安全確認
# ========================================
CURRENT_BRANCH="$(git branch --show-current 2>/dev/null || echo '')"

if [ -z "$CURRENT_BRANCH" ]; then
  exit 0
fi

# main / master / develop / release 系へのコミットを禁止
case "$CURRENT_BRANCH" in
  main|master|develop|release/*|hotfix/*)
    echo "[auto-commit] 保護ブランチ ($CURRENT_BRANCH) のためスキップ"
    exit 0
    ;;
esac

# dev/YYYY-MM-DD パターンか確認
if ! echo "$CURRENT_BRANCH" | grep -qE "^${BRANCH_PREFIX}[0-9]{4}-[0-9]{2}-[0-9]{2}$"; then
  echo "[auto-commit] ブランチ名が日次パターンと一致しないためスキップ ($CURRENT_BRANCH)"
  exit 0
fi

# ========================================
# Step 2: 変更の有無確認
# ========================================
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  echo "[auto-commit] 変更なし"
  exit 0
fi

echo ""
echo "=== Auto Commit (Stop hook) ==="

# ========================================
# Step 3: テスト/secret-scan は別hookに依存
# ========================================
# Stop hook の順序:
#   1. secret-scan.sh   (失敗時 exit 2 → Claude Code が後続を中断する想定)
#   2. デプロイチェック (静的解析+テスト)
#   3. auto-commit.sh   (本スクリプト)
#
# したがって本スクリプトに到達した時点で secret-scan/テストは PASS している
# ただし念のため軽い再確認を行う

# secret-scan の最低限再確認 (gitleaks があれば実行)
if command -v gitleaks >/dev/null 2>&1; then
  if ! gitleaks detect --no-banner --redact --exit-code 2 --source . >/dev/null 2>&1; then
    echo "[auto-commit] secret-scan で問題検出 → コミット中止"
    exit 0
  fi
fi

# ========================================
# Step 4: コミット & プッシュ
# ========================================
git add -A

COMMIT_MSG="chore(wip): auto-commit $(date +%Y-%m-%d\ %H:%M)"
if git commit -m "$COMMIT_MSG" >/dev/null 2>&1; then
  echo "[auto-commit] コミット作成: $COMMIT_MSG"
else
  echo "[auto-commit] コミット対象なし"
  exit 0
fi

# プッシュ
if git rev-parse --abbrev-ref --symbolic-full-name "@{u}" >/dev/null 2>&1; then
  if git push 2>/dev/null; then
    echo "[auto-commit] push 完了"
  else
    echo "[auto-commit] [!] push 失敗 — 次回セッション開始時に再試行されます"
  fi
else
  if git push -u origin "$CURRENT_BRANCH" 2>/dev/null; then
    echo "[auto-commit] push 完了 (上流設定)"
  else
    echo "[auto-commit] [!] push 失敗 — 次回セッション開始時に再試行されます"
  fi
fi

echo "=== Auto Commit 完了 ==="
echo ""
exit 0
