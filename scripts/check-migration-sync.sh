#!/usr/bin/env bash
# scripts/check-migration-sync.sh
#
# prisma/schema.prisma が変更されているにもかかわらず
# prisma/migrations/ にマイグレーションファイルが追加されていない場合に fail する。
#
# 背景 (v1.5.0 教訓):
#   schema.prisma にモデルを追加したが migrate dev を実行せずにコミットしたため
#   ローカル・本番 DB ともにテーブルが存在せず 500 エラーが発生した。
#   prisma migrate deploy はファイルがなければ何もしないため、
#   「ファイル未生成」を静的解析・ビルドでは検出できない。
#
# 使い方:
#   pnpm check:migration-sync                  # origin/main との比較 (デフォルト)
#   pnpm check:migration-sync origin/develop   # 任意のベースブランチを指定
#
# CI (GitHub Actions) では ci.yml 側で origin/<base_ref> を渡している。
#
# 終了コード:
#   0 = OK
#   1 = NG (schema 変更あり / マイグレーションファイルなし)

set -euo pipefail

BASE="${1:-origin/main}"

echo "[migration-sync] ベースブランチとの差分を確認: ${BASE}"

# origin/main が fetch されていない場合に備えて shallow fetch を試みる (CI 向け)
if ! git rev-parse --verify "$BASE" > /dev/null 2>&1; then
  REMOTE_BRANCH="${BASE#origin/}"
  echo "[migration-sync] ${BASE} が見つかりません。fetch を試みます..."
  git fetch origin "$REMOTE_BRANCH" --depth=1 2>/dev/null || {
    echo "[migration-sync] WARN: fetch に失敗しました。チェックをスキップします。" >&2
    exit 0
  }
fi

# schema.prisma がベースブランチと差分があるか
schema_changed=$(git diff "$BASE" HEAD --name-only 2>/dev/null | grep -c "prisma/schema.prisma" || echo "0")

if [ "$schema_changed" -eq 0 ]; then
  echo "[migration-sync] OK: prisma/schema.prisma の変更なし。"
  exit 0
fi

echo "[migration-sync] prisma/schema.prisma の変更を検出しました。マイグレーションファイルを確認..."

# prisma/migrations/ 配下にファイルが追加または変更されたか
migration_changed=$(git diff "$BASE" HEAD --name-only 2>/dev/null | grep -c "prisma/migrations/" || echo "0")

if [ "$migration_changed" -eq 0 ]; then
  echo "" >&2
  echo "╔══════════════════════════════════════════════════════════════╗" >&2
  echo "║  ERROR: マイグレーションファイルが未生成です                ║" >&2
  echo "╠══════════════════════════════════════════════════════════════╣" >&2
  echo "║  prisma/schema.prisma が変更されましたが、対応する          ║" >&2
  echo "║  prisma/migrations/ のファイルが追加されていません。        ║" >&2
  echo "║                                                              ║" >&2
  echo "║  以下のコマンドでマイグレーションファイルを生成してから     ║" >&2
  echo "║  schema.prisma と一緒にコミットしてください:               ║" >&2
  echo "║                                                              ║" >&2
  echo "║    pnpm prisma migrate dev --name <変更内容を表す名前>      ║" >&2
  echo "║                                                              ║" >&2
  echo "║  背景: prisma migrate deploy はファイルがなければ何もしない ║" >&2
  echo "║  ため、本番 DB のテーブルが作成されず 500 エラーになります。║" >&2
  echo "╚══════════════════════════════════════════════════════════════╝" >&2
  echo "" >&2
  exit 1
fi

echo "[migration-sync] OK: マイグレーションファイルの追加を確認しました (${migration_changed} 件)。"
exit 0
