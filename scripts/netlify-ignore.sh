#!/usr/bin/env bash
# Netlify build ignore script
# Returns:
#   exit 0 → skip build  (Netlify は前回ビルド成果を再利用)
#   exit 1 → run build
#
# 本スクリプトは Netlify ビルド開始前に実行される。
# 変更内容が docs / .md / .github / .vscode のみであればビルドをスキップして、
# Starter プランの 300 分/月制約を効率的に使う。
#
# 参考: https://docs.netlify.com/configure-builds/ignore-builds/
# 関連: docs/operations/DEPLOYMENT.md §5 (ビルド分節約戦略)

set -u

# Netlify が渡す環境変数
#   CACHED_COMMIT_REF: 前回ビルド成功時の commit SHA
#   COMMIT_REF:        今回ビルド対象の commit SHA
if [ -z "${CACHED_COMMIT_REF:-}" ] || [ -z "${COMMIT_REF:-}" ]; then
  echo "[netlify-ignore] CACHED_COMMIT_REF or COMMIT_REF unset → forcing build"
  exit 1
fi

if [ "$CACHED_COMMIT_REF" = "$COMMIT_REF" ]; then
  echo "[netlify-ignore] Same commit as last build → skipping"
  exit 0
fi

# 変更ファイル一覧を取得
changed=$(git diff --name-only "$CACHED_COMMIT_REF" "$COMMIT_REF" 2>/dev/null)

if [ -z "$changed" ]; then
  echo "[netlify-ignore] No diff between commits → skipping"
  exit 0
fi

# ビルド対象に影響する変更があるかチェック
# スキップ対象パターン (これらだけの変更ならビルド不要):
#   - docs/**
#   - .github/**     (workflow / template の変更は Netlify と無関係)
#   - .vscode/**
#   - *.md           (ルート直下の Markdown 含む)
#   - .gitignore / LICENSE / CONTRIBUTING など (拡張子なしのメタファイル)
build_relevant=$(echo "$changed" \
  | grep -v '^docs/' \
  | grep -v '^\.github/' \
  | grep -v '^\.vscode/' \
  | grep -v '\.md$' \
  | grep -v '^\.gitignore$' \
  | grep -v '^LICENSE$' \
  | grep -v '^CODEOWNERS$' \
  || true)

if [ -z "$build_relevant" ]; then
  echo "[netlify-ignore] Only docs/markdown/meta changes detected → skipping build"
  echo "[netlify-ignore] Changed files:"
  echo "$changed" | sed 's/^/  - /'
  exit 0
fi

echo "[netlify-ignore] Build-relevant changes detected → running build"
echo "[netlify-ignore] Build-relevant files:"
echo "$build_relevant" | sed 's/^/  - /'
exit 1
