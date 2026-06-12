#!/usr/bin/env bash
# scripts/netlify-ignore.sh のリグレッションテスト (2026-06-11)
#
# 目的: Netlify ビルドスキップ判定が「本番に必要なデプロイを取りこぼさない」ことを
#   隔離した一時 git リポジトリ上で検証する (本番事故防止の安全ネット)。
#   とくに 2026-06-11 追加の「dev-only 依存更新のスキップ」が、
#   ランタイム影響のある変更を誤ってスキップしないこと (fail-safe) を担保する。
#
# 実行: bash scripts/netlify-ignore.test.sh
#   exit 0 = 全ケース PASS / exit 1 = 1 件以上 FAIL
#
# 注: vitest (src/**・prisma/** のみ対象) の管轄外のため pnpm test には含まれない。
#     シェルスクリプトの単体検証は本ファイルを直接実行する。

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IGNORE_SH="$SCRIPT_DIR/netlify-ignore.sh"

if [ ! -f "$IGNORE_SH" ]; then
  echo "FATAL: $IGNORE_SH が見つかりません"
  exit 1
fi

PASS=0
FAIL=0

# 一時 git リポジトリを作成
TMP="$(mktemp -d 2>/dev/null || mktemp -d -t netlify-ignore-test)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

cd "$TMP"
git init -q
git config user.email "test@example.com"
git config user.name "test"
git config commit.gpgsign false
git config core.autocrlf false   # CRLF 変換警告でテスト出力が汚れるのを防ぐ

# ベースとなる package.json (実 repo の固定スタイルを模倣: next 系は exact、他は caret)
write_base_pkg() {
  cat > package.json <<'JSON'
{
  "name": "app",
  "version": "1.0.0",
  "scripts": { "build": "prisma generate && next build" },
  "dependencies": {
    "next": "16.2.9",
    "react": "19.0.0",
    "@supabase/supabase-js": "^2.108.1"
  },
  "devDependencies": {
    "eslint-config-next": "16.2.9",
    "prettier": "^3.8.4",
    "@types/node": "^25",
    "vitest": "^4.1.8",
    "tailwindcss": "^4.2.0",
    "prisma": "^6.0.0",
    "tsx": "^4.21.0"
  }
}
JSON
}

# 各シナリオ: base commit を作り、変更を加えた commit を作り、netlify-ignore.sh を実行
# $1=ケース名 $2=期待 (skip|build) $3=変更を行う関数名
run_case() {
  local name="$1" expect="$2" mutate="$3"

  # クリーンな作業ツリーに戻す
  git checkout -q -- . 2>/dev/null || true
  rm -f src/app.ts docs/readme.md 2>/dev/null || true
  write_base_pkg
  echo "lockfileVersion: '9.0'" > pnpm-lock.yaml
  mkdir -p src docs
  echo "export const x = 1;" > src/app.ts
  git add -A
  git commit -q -m "base"
  local base_sha
  base_sha="$(git rev-parse HEAD)"

  # 変更を適用
  "$mutate"
  git add -A
  git commit -q -m "$name"
  local head_sha
  head_sha="$(git rev-parse HEAD)"

  # netlify-ignore.sh を本番 (BRANCH=main) として実行
  local out rc got
  out="$(BRANCH=main CACHED_COMMIT_REF="$base_sha" COMMIT_REF="$head_sha" bash "$IGNORE_SH" 2>&1)"
  rc=$?
  got="build"; [ "$rc" -eq 0 ] && got="skip"

  if [ "$got" = "$expect" ]; then
    echo "PASS [$name] expected=$expect"
    PASS=$((PASS + 1))
  else
    echo "FAIL [$name] expected=$expect got=$got"
    echo "$out" | sed 's/^/    /'
    FAIL=$((FAIL + 1))
  fi

  # 次ケースのため base commit まで戻す (履歴をリセット)
  git checkout -q --orphan _tmp 2>/dev/null
  git reset -q --hard 2>/dev/null
  git checkout -q -B main 2>/dev/null
  git branch -q -D _tmp 2>/dev/null || true
  rm -rf "$TMP"/* 2>/dev/null
  cd "$TMP"
}

# ── mutate 関数群 (package.json / lock / src / docs を改変) ──
m_eslint_bump() { sed -i 's/"eslint-config-next": "16.2.9"/"eslint-config-next": "16.2.10"/' package.json; echo "x" >> pnpm-lock.yaml; }
m_prettier_bump() { sed -i 's/"prettier": "\^3.8.4"/"prettier": "^3.9.0"/' package.json; echo "x" >> pnpm-lock.yaml; }
m_vitest_bump() { sed -i 's/"vitest": "\^4.1.8"/"vitest": "^4.2.0"/' package.json; echo "x" >> pnpm-lock.yaml; }
m_next_bump() { sed -i 's/"next": "16.2.9"/"next": "16.3.0"/' package.json; echo "x" >> pnpm-lock.yaml; }
m_supabase_bump() { sed -i 's#"@supabase/supabase-js": "\^2.108.1"#"@supabase/supabase-js": "^2.109.0"#' package.json; echo "x" >> pnpm-lock.yaml; }
m_tailwind_bump() { sed -i 's/"tailwindcss": "\^4.2.0"/"tailwindcss": "^4.3.0"/' package.json; echo "x" >> pnpm-lock.yaml; }
m_prisma_bump() { sed -i 's/"prisma": "\^6.0.0"/"prisma": "^6.1.0"/' package.json; echo "x" >> pnpm-lock.yaml; }
m_tsx_bump() { sed -i 's/"tsx": "\^4.21.0"/"tsx": "^4.22.0"/' package.json; echo "x" >> pnpm-lock.yaml; }
m_scripts_change() { sed -i 's#"build": "prisma generate && next build"#"build": "prisma generate \&\& next build --turbo"#' package.json; echo "x" >> pnpm-lock.yaml; }
m_new_unknown_devdep() { sed -i 's/"tsx": "\^4.21.0"/"tsx": "^4.21.0", "some-new-tool": "^1.0.0"/' package.json; echo "x" >> pnpm-lock.yaml; }
m_lock_only() { echo "x" >> pnpm-lock.yaml; }              # package.json 不変 → build (推移的 runtime 可能性)
m_src_change() { echo "export const y = 2;" >> src/app.ts; }
m_docs_only() { echo "# doc" >> docs/readme.md; }
m_mixed_dev_and_runtime() { sed -i 's/"eslint-config-next": "16.2.9"/"eslint-config-next": "16.2.10"/' package.json; sed -i 's/"next": "16.2.9"/"next": "16.3.0"/' package.json; echo "x" >> pnpm-lock.yaml; }

echo "=== netlify-ignore.sh regression tests ==="
# 許可リストの dev ツール (出荷物不変) → skip
run_case "eslint-config-next bump (allowlist)" skip m_eslint_bump
run_case "prettier bump (allowlist)"           skip m_prettier_bump
run_case "vitest bump (allowlist)"             skip m_vitest_bump
# ランタイム依存 → build
run_case "next runtime bump"                   build m_next_bump
run_case "supabase runtime bump"               build m_supabase_bump
# 出荷物に影響する devDependency → build
run_case "tailwindcss bump (CSS生成)"          build m_tailwind_bump
run_case "prisma bump (client生成)"            build m_prisma_bump
run_case "tsx bump (build経路)"                build m_tsx_bump
# 構造変更・未知依存・混在 → build
run_case "package.json scripts change"         build m_scripts_change
run_case "new unknown devDependency"           build m_new_unknown_devdep
run_case "dev + runtime mixed"                 build m_mixed_dev_and_runtime
# lock-only (package.json 不変) → build (fail-safe: 推移的 runtime 依存の可能性)
run_case "pnpm-lock.yaml only change"          build m_lock_only
# 通常のソース変更 → build / docs のみ → skip (既存挙動の回帰)
run_case "src/ source change"                  build m_src_change
run_case "docs-only change"                    skip m_docs_only

echo ""
echo "=== RESULT: PASS=$PASS FAIL=$FAIL ==="
[ "$FAIL" -eq 0 ]
