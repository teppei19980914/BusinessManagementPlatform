#!/usr/bin/env bash
# Netlify build ignore script
# Returns:
#   exit 0 → skip build  (Netlify は前回ビルド成果を再利用)
#   exit 1 → run build
#
# 本スクリプトは Netlify ビルド開始前に実行される。
# 変更内容が docs / .md / .github / .vscode のみであればビルドをスキップして、
# Starter プランの統合 credits 枠 (300/月、1 deploy ≈ 15 credits 消費) を効率的に使う。
# 2026 年から Netlify は "ビルド分" から "credits" 統合モデルに変更済。
# 詳細: docs/operations/develop/DEPLOYMENT.md §8.2
#
# 参考: https://docs.netlify.com/configure-builds/ignore-builds/
# 関連: docs/operations/develop/DEPLOYMENT.md §5 (ビルド分節約戦略)

set -u

# dependabot ブランチの deploy preview はビルドしない (2026-06-04)。
#   dependabot PR は GitHub Actions (Lint/Test/Build = next build, E2E, 必須7チェック) で
#   検証済みで、Netlify preview は必須チェックでも検証ゲートでもない。strict + lockfile の
#   直列カスケードで rebase のたびに再ビルド (1 deploy ≈ 15 credits) が走り Starter 枠
#   (300/月) を圧迫するため、dependabot の preview/branch deploy をスキップする。
#   production (= main) は BRANCH=main のため対象外で通常どおりビルドされる。
#   関連: docs/operations/develop/DEPLOYMENT.md §8.2 / .github/workflows/dependabot-auto-merge.yml
if [[ "${BRANCH:-}" == dependabot/* ]]; then
  echo "[netlify-ignore] dependabot branch (${BRANCH}) → skipping preview build (credits 節約)"
  exit 0
fi

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
