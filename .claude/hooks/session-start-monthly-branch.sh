#!/usr/bin/env bash
# SessionStart hook: 月次ブランチ運用の自動化 (たすきば専用)
#
# 方針 (CLAUDE.md と整合):
#   - 毎月1回リリース (目標、日は変動あり)。暦月単位の変更を1ブランチに集約
#   - ブランチ名 = month/YYYY-MM (暦月、特定日への補正なし)
#   - 月途中の再起動では同じ月次ブランチに【冪等に】乗り続ける (有れば checkout / 無ければ作成)
#   - ★commit / push / PR / ブランチ削除は一切しない★ (それらは明示許可制。本 hook は checkout のみ)
#   - release/* hotfix/* は使わない (CLAUDE.md で直接コミット禁止の保護接頭辞のため)
#
# スキップ条件:
#   - .claude/.monthly-branch-disabled が存在する (明示的に無効化)
#   - git リポジトリでない
#   - 既に当月の month/ ブランチ上にいる

set -u

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$REPO_ROOT" ]; then
  exit 0
fi
cd "$REPO_ROOT"

# 明示的な無効化フラグ (「ブランチを切らないで」と指示された場合に touch する想定)
if [ -f ".claude/.monthly-branch-disabled" ]; then
  echo "[monthly-branch] .monthly-branch-disabled が存在するためスキップ"
  exit 0
fi

BASE_BRANCH="main"

if ! command -v date >/dev/null 2>&1; then
  echo "[monthly-branch] date コマンドが無いためスキップ"
  exit 0
fi

MONTH_ID="$(date +%Y-%m 2>/dev/null || true)"
if [ -z "$MONTH_ID" ]; then
  echo "[monthly-branch] 月番号を算出できないためスキップ"
  exit 0
fi

MONTH_BRANCH="month/${MONTH_ID}"

echo ""
echo "=== 月次ブランチ運用 (SessionStart) ==="

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"

# 既に当月ブランチ上なら何もしない (冪等)
if [ "$CURRENT_BRANCH" = "$MONTH_BRANCH" ]; then
  echo "既に当月ブランチ $MONTH_BRANCH 上です。継続。"
  echo "=== 月次ブランチ運用 完了 ==="
  echo ""
  exit 0
fi

# 未コミット変更がある場合は破壊的操作を避けて警告のみ (commit はしない方針)
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  echo "[!] 未コミットの変更があります (現在: ${CURRENT_BRANCH:-不明})。"
  echo "    自動コミット/ブランチ切替は行いません。手動で整理してから作業してください。"
  echo "    当月ブランチは: $MONTH_BRANCH"
  echo "=== 月次ブランチ運用 完了 (切替は手動) ==="
  echo ""
  exit 0
fi

# 当月ブランチが既存なら checkout、無ければ main 最新化のうえ作成
if git show-ref --verify --quiet "refs/heads/$MONTH_BRANCH"; then
  echo "当月ブランチ $MONTH_BRANCH に切り替え"
  git checkout "$MONTH_BRANCH" 2>/dev/null || echo "  [!] checkout 失敗"
else
  echo "当月ブランチ $MONTH_BRANCH が未作成 → main 最新化のうえ作成"
  git fetch origin "$BASE_BRANCH" 2>/dev/null || echo "  [!] fetch 失敗 (オフライン?)"
  git checkout "$BASE_BRANCH" 2>/dev/null || true
  git pull --ff-only 2>/dev/null || echo "  [!] pull 失敗 (ローカル main で継続)"
  git checkout -b "$MONTH_BRANCH" 2>/dev/null && echo "  [OK] $MONTH_BRANCH 作成" || echo "  [!] 作成失敗"
fi

echo "=== 月次ブランチ運用 完了 ==="
echo ""
exit 0
