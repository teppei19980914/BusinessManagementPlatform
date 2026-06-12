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
# 加えて (2026-06-11): 変更が package.json / pnpm-lock.yaml のみで、その中身が
#   「ランタイム出荷物に一切影響しない dev ツール (型/lint/test/format/CLI)」の
#   devDependencies 更新だけの場合も本番ビルドをスキップする。これらは Dependabot
#   patch/minor 自動マージで大量に main へ入るが、next build の出力 (= 利用者に届く
#   バンドル) を一切変えないため、本番デプロイは不要 (検証は GitHub Actions の
#   Lint/Test/Build で全 PR 実施済)。判定は本スクリプト末尾の classify_dev_only_deps を参照。
#   ★安全原則: 少しでも不確実なら必ず build する (fail-safe)。許可リスト外・runtime
#     依存・package.json の構造変更 (scripts/dependencies 等)・判定不能は全て build。
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

# ────────────────────────────────────────────────────────────────────────────
# dev-only 依存更新のスキップ判定 (2026-06-11)
#   build_relevant が package.json / pnpm-lock.yaml のみのとき、package.json の
#   旧版↔新版を Node で厳密比較し、変更が「ランタイム出荷物に影響しない dev ツール」の
#   devDependencies だけなら本番ビルドをスキップする (Dependabot の型/lint/test 更新等)。
#
#   ★fail-safe 設計 (本番事故防止)★ 以下はすべて build にフォールバックする:
#     - package.json 以外も変わっている (src/ 等) … そもそも本ブロックに入らない
#     - pnpm-lock.yaml のみ変更で package.json 不変 … 推移的 runtime 依存が動いた可能性 → build
#     - devDependencies 以外 (dependencies / scripts / engines / version 等) の差分 → build
#     - 許可リスト外の devDependency が 1 つでも変化 (tailwindcss/prisma/tsx/typescript 等) → build
#     - node 不在 / git show 失敗 / JSON parse 失敗 / 変化が検出できない → build
# ────────────────────────────────────────────────────────────────────────────
non_dep_files=$(echo "$build_relevant" | grep -v -E '^(package\.json|pnpm-lock\.yaml)$' || true)
if [ -z "$non_dep_files" ] && echo "$build_relevant" | grep -q '^package\.json$'; then
  if ! command -v node >/dev/null 2>&1; then
    echo "[netlify-ignore] node 不在 → 依存種別を判定できないため build (fail-safe)"
    exit 1
  fi
  old_pkg=$(git show "$CACHED_COMMIT_REF:package.json" 2>/dev/null || true)
  new_pkg=$(git show "$COMMIT_REF:package.json" 2>/dev/null || true)
  if [ -z "$old_pkg" ] || [ -z "$new_pkg" ]; then
    echo "[netlify-ignore] package.json の旧/新版取得失敗 → build (fail-safe)"
    exit 1
  fi

  # 許可リスト: ランタイムバンドルに一切入らない dev ツールのみを列挙する。
  #   迷うもの (出荷物に影響しうるもの) は入れない = build される。
  #   ★ロールバック: この値を空文字 ("") にすれば本ブロックは常に build にフォールバックし、
  #     2026-06-11 以前の挙動 (package.json 変更は必ず build) に即座に戻せる。
  #   除外理由 (= 意図的に常に build):
  #     tailwindcss / @tailwindcss/postcss … CSS 出力を生成するため出荷物が変わる
  #     prisma                              … prisma generate で @prisma/client を生成
  #     tsx                                 … build:netlify の post-build 手順で使用
  #     typescript / dotenv                 … 影響は薄いが保守的に build
  #     dependencies の全パッケージ          … 実行時コードに含まれる
  #   注: @types/* は型のみ (tsc/SWC でコンパイル時に除去) のため前方一致で常に許可。
  SAFE_DEV_DEPS="@playwright/test,@vitest/coverage-v8,vitest,eslint,eslint-config-next,eslint-config-prettier,prettier,shadcn"

  if SAFE_LIST="$SAFE_DEV_DEPS" OLD_PKG="$old_pkg" NEW_PKG="$new_pkg" node -e '
    const o = JSON.parse(process.env.OLD_PKG || "{}");
    const n = JSON.parse(process.env.NEW_PKG || "{}");
    const safe = (process.env.SAFE_LIST || "").split(",").filter(Boolean);
    const isSafe = (name) => safe.includes(name) || name.startsWith("@types/");
    const stripDev = (p) => { const c = Object.assign({}, p); delete c.devDependencies; return c; };
    // devDependencies 以外が 1 文字でも変われば build (キー順は Dependabot が値のみ書換するため不変)
    if (JSON.stringify(stripDev(o)) !== JSON.stringify(stripDev(n))) {
      console.error("  devDependencies 以外の変更を検出 → build");
      process.exit(1);
    }
    const od = o.devDependencies || {}, nd = n.devDependencies || {};
    const keys = new Set([...Object.keys(od), ...Object.keys(nd)]);
    const changed = [...keys].filter((k) => od[k] !== nd[k]);
    if (changed.length === 0) {
      console.error("  devDependencies のバージョン変化を検出できず → build (fail-safe)");
      process.exit(1);
    }
    const unsafe = changed.filter((k) => !isSafe(k));
    if (unsafe.length) {
      console.error("  許可リスト外の devDependencies が変化 → build: " + unsafe.join(", "));
      process.exit(1);
    }
    console.error("  許可リストの dev ツールのみ変化: " + changed.join(", "));
    process.exit(0);
  '; then
    echo "[netlify-ignore] dev ツール依存のみの更新 (CI 検証済・出荷物不変) → 本番ビルドをスキップ (credits 節約)"
    echo "[netlify-ignore] Changed files:"
    echo "$changed" | sed 's/^/  - /'
    exit 0
  else
    echo "[netlify-ignore] package.json にランタイム影響の可能性 → build"
    exit 1
  fi
fi

echo "[netlify-ignore] Build-relevant changes detected → running build"
echo "[netlify-ignore] Build-relevant files:"
echo "$build_relevant" | sed 's/^/  - /'
exit 1
