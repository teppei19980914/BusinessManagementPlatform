#!/usr/bin/env bash
# SessionStart hook: PR マージ後の /knowledge-organize 提案
#
# 動作:
#   1. 前回セッション時に記録した main の HEAD SHA と現在の origin/main を比較
#   2. 差分があれば、その間に発生した merge commit (PR マージ) をカウント
#   3. 1 件以上検出 → ユーザに /knowledge-organize 実行を提案 (mark file 更新)
#   4. 0 件 (or 初回) → 何もせず mark file 初期化
#
# 設計:
#   - 既存 session-start-git.sh とは独立 (単一責任)
#   - 提案のみ行い、自動実行はしない (整理判断は人間 + Claude 協働で行う)
#   - mark file は .claude/.last-knowledge-check-sha (gitignore 推奨)

set -u

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$REPO_ROOT" ]; then
  exit 0
fi
cd "$REPO_ROOT"

MARK_FILE=".claude/.last-knowledge-check-sha"
BASE_BRANCH="main"

# 最新の origin/main を取得 (network なしでもローカル ref が更新済みなら拾える)
git fetch origin "$BASE_BRANCH" --quiet 2>/dev/null || true

CURRENT_SHA="$(git rev-parse "origin/${BASE_BRANCH}" 2>/dev/null || echo '')"
if [ -z "$CURRENT_SHA" ]; then
  # origin/main を解決できない (初回 clone 直後等) → 何もしない
  exit 0
fi

# 前回マークがなければ初期化のみ (初回起動時の誤発火を防ぐ)
if [ ! -f "$MARK_FILE" ]; then
  echo "$CURRENT_SHA" > "$MARK_FILE"
  exit 0
fi

LAST_SHA="$(cat "$MARK_FILE" 2>/dev/null || echo '')"
if [ -z "$LAST_SHA" ] || [ "$LAST_SHA" = "$CURRENT_SHA" ]; then
  # 進展なし
  exit 0
fi

# 前回 SHA から現在 SHA までの merge commit をカウント
# (PR マージ = `Merge pull request #N from ...` 形式の commit)
MERGE_COUNT="$(git log "${LAST_SHA}..${CURRENT_SHA}" --merges --pretty=format:'%H' 2>/dev/null | wc -l | tr -d ' ')"
SQUASH_PR_COUNT="$(git log "${LAST_SHA}..${CURRENT_SHA}" --pretty=format:'%s' 2>/dev/null | grep -cE '\(#[0-9]+\)$' || true)"
TOTAL_PR_COUNT=$(( MERGE_COUNT + SQUASH_PR_COUNT ))

if [ "$TOTAL_PR_COUNT" -ge 1 ]; then
  echo ""
  echo "=== /knowledge-organize 提案 ==="
  echo "前回セッション以降、main に ${TOTAL_PR_COUNT} 件 (merge: ${MERGE_COUNT} / squash: ${SQUASH_PR_COUNT}) の PR がマージされました。"
  echo ""
  echo "これらの PR で蓄積されたナレッジが DEVELOPER_GUIDE.md / E2E_LESSONS_LEARNED.md に重複や"
  echo "陳腐化なく整理されているか確認するため、本セッション中に /knowledge-organize の実行を推奨します。"
  echo ""
  echo "(KDD フロー Step 7 / CLAUDE.md「知識駆動開発」参照)"
  echo "=== 提案ここまで ==="
  echo ""
fi

# 次回比較用に現在 SHA を記録
echo "$CURRENT_SHA" > "$MARK_FILE"
exit 0
