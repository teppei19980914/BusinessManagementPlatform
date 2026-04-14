#!/usr/bin/env bash
# SessionStart hook: 日次ブランチ運用の自動化
#
# 動作:
#   1. git automation が有効か確認 (.claude/.git-automation-config)
#   2. gh CLI の前提を確認 (Hybrid: 初回セットアップ案内、以降は warn-only)
#   3. 前日以前の dev/YYYY-MM-DD ブランチを検出
#   4. 未コミット変更があればコミット
#   5. PR 未作成なら作成
#   6. PR が MERGED なら旧ブランチを削除
#   7. 当日の dev/YYYY-MM-DD ブランチを作成・チェックアウト
#      (既存ならチェックアウトのみ — 同一日複数セッション対応)

set -u

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$REPO_ROOT" ]; then
  echo "[git-automation] git リポジトリではないためスキップ"
  exit 0
fi
cd "$REPO_ROOT"

CONFIG_FILE=".claude/.git-automation-config"
SETUP_DONE_FILE=".claude/.git-automation-setup-done"

# ========================================
# Step 0: 有効化チェック (オプトイン)
# ========================================
if [ ! -f "$CONFIG_FILE" ]; then
  # 設定ファイルがない = 無効
  exit 0
fi

# shellcheck disable=SC1090
. "$CONFIG_FILE"

if [ "${enabled:-false}" != "true" ]; then
  exit 0
fi

BRANCH_PREFIX="${branch_prefix:-dev/}"
BASE_BRANCH="${base_branch:-main}"

echo ""
echo "=== Git Automation (SessionStart) ==="

# ========================================
# Step 1: 前提CLIチェック (Hybrid モード)
# ========================================
check_prereqs() {
  local missing=0

  if ! command -v git >/dev/null 2>&1; then
    echo "  [x] git が未インストール"
    missing=1
  fi

  if ! command -v gh >/dev/null 2>&1; then
    echo "  [x] gh CLI が未インストール (https://cli.github.com/)"
    missing=1
  else
    if ! gh auth status >/dev/null 2>&1; then
      echo "  [x] gh CLI が未認証 (実行: gh auth login)"
      missing=1
    fi
  fi

  local remote_url
  remote_url="$(git remote get-url origin 2>/dev/null || echo '')"
  if [ -z "$remote_url" ]; then
    echo "  [!] origin リモートが未設定"
    missing=1
  elif ! echo "$remote_url" | grep -q 'github\.com'; then
    echo "  [!] origin が GitHub ではありません ($remote_url) — gh CLI 連携不可"
    missing=1
  fi

  return $missing
}

if ! check_prereqs; then
  if [ ! -f "$SETUP_DONE_FILE" ]; then
    cat <<'EOF'

[git-automation] 初回セットアップが必要です:

  1. gh CLI をインストール:    https://cli.github.com/
  2. 認証:                     gh auth login
  3. リモート設定確認:         git remote -v

セットアップ完了後、以下を実行して有効化:
  touch .claude/.git-automation-setup-done

今回のセッションは手動コミット運用で継続します。
EOF
  else
    echo "[git-automation] 前提不備のため自動化をスキップ (warn-only mode)"
  fi
  echo "=== Git Automation 終了 ==="
  echo ""
  exit 0
fi

# ========================================
# Step 2: 前日以前のブランチを検出
# ========================================
TODAY="$(date +%Y-%m-%d)"
TODAY_BRANCH="${BRANCH_PREFIX}${TODAY}"

# ローカルの dev/YYYY-MM-DD パターンのうち今日以外
PREV_BRANCHES="$(git branch --format='%(refname:short)' | grep -E "^${BRANCH_PREFIX}[0-9]{4}-[0-9]{2}-[0-9]{2}$" | grep -v "^${TODAY_BRANCH}$" || true)"

if [ -n "$PREV_BRANCHES" ]; then
  echo "前日以前のブランチを検出:"
  echo "$PREV_BRANCHES" | sed 's/^/  - /'
  echo ""

  while IFS= read -r prev_branch; do
    [ -z "$prev_branch" ] && continue
    echo "[$prev_branch] 処理中..."

    # ブランチをチェックアウト
    if ! git checkout "$prev_branch" 2>/dev/null; then
      echo "  [!] チェックアウト失敗 — スキップ"
      continue
    fi

    # 未コミット変更をコミット
    if ! git diff --quiet || ! git diff --cached --quiet; then
      echo "  未コミット変更をコミット中..."
      git add -A
      git commit -m "chore: auto-commit on session start ($(date +%Y-%m-%d\ %H:%M))" >/dev/null 2>&1 || true
    fi

    # リモートにプッシュ (上流未設定なら -u)
    if git rev-parse --abbrev-ref --symbolic-full-name "@{u}" >/dev/null 2>&1; then
      git push 2>/dev/null || echo "  [!] push 失敗"
    else
      git push -u origin "$prev_branch" 2>/dev/null || echo "  [!] push 失敗"
    fi

    # PR の存在確認
    pr_state="$(gh pr view "$prev_branch" --json state -q .state 2>/dev/null || echo '')"

    if [ -z "$pr_state" ]; then
      # PR 未作成 → 作成
      echo "  PR を作成中..."
      pr_title="${prev_branch}: 日次変更"
      pr_body="$(git log "${BASE_BRANCH}..${prev_branch}" --oneline 2>/dev/null | head -50)"
      [ -z "$pr_body" ] && pr_body="自動作成された日次 PR"
      if gh pr create --base "$BASE_BRANCH" --head "$prev_branch" --title "$pr_title" --body "$pr_body" 2>/dev/null; then
        echo "  [OK] PR 作成完了"
      else
        echo "  [!] PR 作成失敗 (既に存在する可能性)"
      fi
      pr_state="OPEN"
    else
      echo "  PR 状態: $pr_state"
    fi

    # MERGED なら削除
    if [ "$pr_state" = "MERGED" ]; then
      echo "  マージ済み → ブランチ削除"
      git checkout "$BASE_BRANCH" 2>/dev/null || true
      git branch -D "$prev_branch" 2>/dev/null || true
      git push origin --delete "$prev_branch" 2>/dev/null || true
      echo "  [OK] 削除完了"
    else
      echo "  [!] 未マージのため削除しません (開発者のマージを待機)"
    fi
  done <<< "$PREV_BRANCHES"
  echo ""
fi

# ========================================
# Step 3: 当日ブランチの作成またはチェックアウト
# ========================================
# 最新の base ブランチを取得
git checkout "$BASE_BRANCH" 2>/dev/null || true
git pull --ff-only 2>/dev/null || true

if git show-ref --verify --quiet "refs/heads/$TODAY_BRANCH"; then
  echo "当日ブランチ $TODAY_BRANCH に切り替え"
  git checkout "$TODAY_BRANCH"
else
  echo "当日ブランチ $TODAY_BRANCH を作成"
  git checkout -b "$TODAY_BRANCH"
fi

echo "=== Git Automation 完了 ==="
echo ""
exit 0
