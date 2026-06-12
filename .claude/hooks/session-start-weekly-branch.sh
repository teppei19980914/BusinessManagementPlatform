#!/usr/bin/env bash
# SessionStart hook: 週次ブランチ運用の自動化 (たすきば専用)
#
# 方針 (CLAUDE.md / project_dev_workflow_enforcement_plan と整合):
#   - 毎週金曜リリース (目標、変動あり)。土曜始まり〜金曜までの変更を 1 ブランチに集約
#   - ブランチ名 = week/YYYY-wWW (ISO週番号、ただし土曜始まりに補正)
#   - 週途中の再起動では同じ週次ブランチに【冪等に】乗り続ける (有れば checkout / 無ければ作成)
#   - ★commit / push / PR / ブランチ削除は一切しない★ (それらは明示許可制。本 hook は checkout のみ)
#   - release/* hotfix/* は使わない (CLAUDE.md で直接コミット禁止の保護接頭辞のため)
#
# スキップ条件:
#   - .claude/.weekly-branch-disabled が存在する (明示的に無効化)
#   - git リポジトリでない
#   - 既に当週の week/ ブランチ上にいる

set -u

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$REPO_ROOT" ]; then
  exit 0
fi
cd "$REPO_ROOT"

# 明示的な無効化フラグ (「ブランチを切らないで」と指示された場合に touch する想定)
if [ -f ".claude/.weekly-branch-disabled" ]; then
  echo "[weekly-branch] .weekly-branch-disabled が存在するためスキップ"
  exit 0
fi

BASE_BRANCH="main"

# ========================================
# 土曜始まり週番号の算出
#   ISO週は月曜始まり。運用は土曜始まりなので +2 日して月曜起点に合わせると
#   土曜/日曜が翌週に繰り上がり、土〜金が同一週になる。
# ========================================
if ! command -v date >/dev/null 2>&1; then
  echo "[weekly-branch] date コマンドが無いためスキップ"
  exit 0
fi

WEEK_ID="$(date -d "+2 days" +%G-w%V 2>/dev/null || true)"
if [ -z "$WEEK_ID" ]; then
  # BSD date など -d 非対応環境のフォールバック (補正なしの素のISO週)
  WEEK_ID="$(date +%G-w%V 2>/dev/null || true)"
  echo "[weekly-branch] 警告: date -d 非対応。土曜始まり補正をスキップしました (要手動確認)"
fi
if [ -z "$WEEK_ID" ]; then
  echo "[weekly-branch] 週番号を算出できないためスキップ"
  exit 0
fi

WEEK_BRANCH="week/${WEEK_ID}"

echo ""
echo "=== 週次ブランチ運用 (SessionStart) ==="

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"

# 既に当週ブランチ上なら何もしない (冪等)
if [ "$CURRENT_BRANCH" = "$WEEK_BRANCH" ]; then
  echo "既に当週ブランチ $WEEK_BRANCH 上です。継続。"
  echo "=== 週次ブランチ運用 完了 ==="
  echo ""
  exit 0
fi

# 未コミット変更がある場合は破壊的操作を避けて警告のみ (commit はしない方針)
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  echo "[!] 未コミットの変更があります (現在: ${CURRENT_BRANCH:-不明})。"
  echo "    自動コミット/ブランチ切替は行いません。手動で整理してから作業してください。"
  echo "    当週ブランチは: $WEEK_BRANCH"
  echo "=== 週次ブランチ運用 完了 (切替は手動) ==="
  echo ""
  exit 0
fi

# 当週ブランチが既存なら checkout、無ければ main 最新化のうえ作成
if git show-ref --verify --quiet "refs/heads/$WEEK_BRANCH"; then
  echo "当週ブランチ $WEEK_BRANCH に切り替え"
  git checkout "$WEEK_BRANCH" 2>/dev/null || echo "  [!] checkout 失敗"
else
  echo "当週ブランチ $WEEK_BRANCH が未作成 → main 最新化のうえ作成"
  git fetch origin "$BASE_BRANCH" 2>/dev/null || echo "  [!] fetch 失敗 (オフライン?)"
  git checkout "$BASE_BRANCH" 2>/dev/null || true
  git pull --ff-only 2>/dev/null || echo "  [!] pull 失敗 (ローカル main で継続)"
  git checkout -b "$WEEK_BRANCH" 2>/dev/null && echo "  [OK] $WEEK_BRANCH 作成" || echo "  [!] 作成失敗"
fi

echo "=== 週次ブランチ運用 完了 ==="
echo ""
exit 0
