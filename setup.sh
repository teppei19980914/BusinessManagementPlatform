#!/bin/bash
# Claude Code Level 5 テンプレート セットアップスクリプト
#
# 使い方:
#   新規プロジェクト:
#     cd /path/to/new-repo
#     bash /path/to/ClaudeCodeTemplate/setup.sh
#
#   既存プロジェクトへの後付け適用 (差分のみ追加):
#     cd /path/to/existing-repo
#     bash /path/to/ClaudeCodeTemplate/setup.sh --upgrade
#
# 対話形式でプロジェクト固有の設定を入力し、テンプレートを適用します。

set -e

UPGRADE_MODE=false
if [ "${1:-}" = "--upgrade" ]; then
  UPGRADE_MODE=true
fi

TEMPLATE_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_DIR="$(pwd)"

echo "=== Claude Code Level 5 セットアップ ==="
if [ "$UPGRADE_MODE" = true ]; then
  echo "モード:       --upgrade (差分追加のみ・既存ファイルは保護)"
fi
echo "テンプレート: $TEMPLATE_DIR"
echo "適用先:       $TARGET_DIR"
echo ""

# 既存ファイルの確認 (新規モードのみ)
if [ "$UPGRADE_MODE" = false ]; then
  if [ -d "$TARGET_DIR/.claude" ] || [ -f "$TARGET_DIR/CLAUDE.md" ]; then
    read -p "既存の .claude/ または CLAUDE.md が見つかりました。上書きしますか？ (y/n): " OVERWRITE
    if [ "$OVERWRITE" != "y" ]; then
      echo "キャンセルしました。--upgrade フラグでの差分追加も検討してください。"
      exit 0
    fi
  fi
fi

# プロジェクト情報の入力
read -p "プロジェクト名 (例: ユメログ): " PROJECT_NAME
read -p "技術スタック (例: Flutter / Dart): " TECH_STACK
read -p "テストコマンド (例: flutter test): " TEST_COMMAND
read -p "静的解析コマンド (例: flutter analyze): " ANALYZE_COMMAND
read -p "ビルドコマンド (例: flutter build web): " BUILD_COMMAND
read -p "フォーマットコマンド (例: dart format --fix): " FORMAT_COMMAND
read -p "プロジェクトの絶対パス: " PROJECT_DIR

# Git 自動化のオプトイン
echo ""
echo "--- Git 自動化（日次ブランチ運用） ---"
echo "有効化すると以下が自動実行されます:"
echo "  - SessionStart: 前日ブランチの PR 作成・マージ済みなら削除・新ブランチ作成"
echo "  - Stop:          テスト成功時に自動 commit & push"
echo "  - 前提:          gh CLI の認証 (gh auth login) と GitHub リモート"
read -p "Git 自動化を有効にしますか？ (y/n): " ENABLE_GIT_AUTO
ENABLE_GIT_AUTO="${ENABLE_GIT_AUTO:-n}"

BASE_BRANCH=""
if [ "$ENABLE_GIT_AUTO" = "y" ]; then
  read -p "ベースブランチ (デフォルト: main): " BASE_BRANCH
  BASE_BRANCH="${BASE_BRANCH:-main}"
fi

echo ""
echo "--- 設定内容 ---"
echo "プロジェクト名:       $PROJECT_NAME"
echo "技術スタック:         $TECH_STACK"
echo "テストコマンド:       $TEST_COMMAND"
echo "静的解析コマンド:     $ANALYZE_COMMAND"
echo "ビルドコマンド:       $BUILD_COMMAND"
echo "フォーマットコマンド: $FORMAT_COMMAND"
echo "プロジェクトパス:     $PROJECT_DIR"
echo "Git 自動化:           $ENABLE_GIT_AUTO ${BASE_BRANCH:+(base: $BASE_BRANCH)}"
echo ""
read -p "この内容でセットアップしますか？ (y/n): " CONFIRM
if [ "$CONFIRM" != "y" ]; then
  echo "キャンセルしました。"
  exit 0
fi

# ========================================
# ファイルコピー (--upgrade では既存を保護)
# ========================================
copy_file() {
  local src="$1"
  local dst="$2"
  if [ "$UPGRADE_MODE" = true ] && [ -e "$dst" ]; then
    echo "  スキップ (既存): $dst"
    return 0
  fi
  cp "$src" "$dst"
  echo "  配置: $dst"
}

copy_dir_files() {
  local src_dir="$1"
  local dst_dir="$2"
  mkdir -p "$dst_dir"
  if [ ! -d "$src_dir" ]; then return 0; fi
  find "$src_dir" -mindepth 1 -maxdepth 1 -type f | while read -r f; do
    copy_file "$f" "$dst_dir/$(basename "$f")"
  done
}

echo ""
echo "テンプレートをコピー中..."
mkdir -p "$TARGET_DIR/.claude"
copy_file "$TEMPLATE_DIR/CLAUDE.md" "$TARGET_DIR/CLAUDE.md"
copy_file "$TEMPLATE_DIR/.claude/settings.json" "$TARGET_DIR/.claude/settings.json"
copy_dir_files "$TEMPLATE_DIR/.claude/hooks" "$TARGET_DIR/.claude/hooks"
copy_dir_files "$TEMPLATE_DIR/.claude/skills" "$TARGET_DIR/.claude/skills"
copy_dir_files "$TEMPLATE_DIR/.claude/agents" "$TARGET_DIR/.claude/agents"

# ドキュメント雛形のコピー（既存ファイルがあればスキップ）
echo "ドキュメント雛形を配置中..."
for tpl in DESIGN REQUIREMENTS OPERATIONS; do
  src="$TEMPLATE_DIR/docs/templates/${tpl}.template.md"
  dst="$TARGET_DIR/${tpl}.md"
  if [ -f "$src" ] && [ ! -f "$dst" ]; then
    cp "$src" "$dst"
    echo "  配置: ${tpl}.md"
  elif [ -f "$dst" ]; then
    echo "  スキップ: ${tpl}.md（既存）"
  fi
done

# CI ワークフロー雛形のコピー（既存ファイルがあればスキップ）
echo "CI ワークフロー雛形を配置中..."
mkdir -p "$TARGET_DIR/.github/workflows"
if [ -f "$TEMPLATE_DIR/.github/workflows/security.yml.template" ] && [ ! -f "$TARGET_DIR/.github/workflows/security.yml" ] && [ ! -f "$TARGET_DIR/.github/workflows/security.yml.template" ]; then
  cp "$TEMPLATE_DIR/.github/workflows/security.yml.template" "$TARGET_DIR/.github/workflows/security.yml.template"
  echo "  配置: .github/workflows/security.yml.template"
  echo "    → 有効化するには .template を外してリネームしてください"
fi

# Git 自動化の設定ファイル生成
if [ "$ENABLE_GIT_AUTO" = "y" ]; then
  CONFIG_PATH="$TARGET_DIR/.claude/.git-automation-config"
  cat > "$CONFIG_PATH" <<EOF
# Git Automation Config
# このファイルが存在し enabled=true の場合のみ自動化が動作します
enabled=true
branch_prefix=dev/
base_branch=$BASE_BRANCH
EOF
  echo "Git 自動化を有効化: $CONFIG_PATH"
  echo "  → 初回は gh auth login を実行してください"
fi

# hooks スクリプトに実行権限を付与
chmod +x "$TARGET_DIR/.claude/hooks/"*.sh 2>/dev/null || true

# メモリ（ユーザー情報・横断的フィードバック）を Claude Code のメモリ領域にコピー
SEED_DIR="$TEMPLATE_DIR/.claude/memory-seed"
if [ -d "$SEED_DIR" ] && [ -n "$(ls "$SEED_DIR"/*.md 2>/dev/null)" ]; then
  echo "メモリシードを配置中..."
  # Claude Code のメモリパスを生成 (パスをハイフンに変換)
  NORMALIZED_PATH="$(echo "$PROJECT_DIR" | sed 's|[:\\]|-|g; s|/|-|g; s|^-||; s|-$||')"
  CLAUDE_HOME="${APPDATA:-$HOME/.config}/claude"
  if [ -d "$HOME/.claude" ]; then
    CLAUDE_HOME="$HOME/.claude"
  fi
  MEMORY_DIR="$CLAUDE_HOME/projects/$NORMALIZED_PATH/memory"
  mkdir -p "$MEMORY_DIR"
  for seed_file in "$SEED_DIR"/*.md; do
    dst="$MEMORY_DIR/$(basename "$seed_file")"
    if [ ! -f "$dst" ]; then
      cp "$seed_file" "$dst"
      echo "  配置: $(basename "$seed_file")"
    else
      echo "  スキップ: $(basename "$seed_file")（既存）"
    fi
  done
  echo "  メモリ配置先: $MEMORY_DIR"
fi

# プレースホルダを置換
echo "プレースホルダを置換中..."
find "$TARGET_DIR/.claude" "$TARGET_DIR/CLAUDE.md" -type f \( -name "*.md" -o -name "*.json" -o -name "*.sh" \) 2>/dev/null | while read file; do
  sed -i "s|{{PROJECT_NAME}}|$PROJECT_NAME|g" "$file"
  sed -i "s|{{TECH_STACK}}|$TECH_STACK|g" "$file"
  sed -i "s|{{TEST_COMMAND}}|$TEST_COMMAND|g" "$file"
  sed -i "s|{{ANALYZE_COMMAND}}|$ANALYZE_COMMAND|g" "$file"
  sed -i "s|{{BUILD_COMMAND}}|$BUILD_COMMAND|g" "$file"
  sed -i "s|{{FORMAT_COMMAND}}|$FORMAT_COMMAND|g" "$file"
  sed -i "s|{{PROJECT_DIR}}|$PROJECT_DIR|g" "$file"
done

# .gitignore に機密ファイルパターンを追記（既存に追記）
GITIGNORE="$TARGET_DIR/.gitignore"
SECURITY_IGNORES=".env
.env.*
!.env.example
*.pem
*.key
*.p12
*.pfx
credentials.json
secrets.yaml
secrets.yml
id_rsa
id_rsa.pub
.claude/.git-automation-setup-done"

if [ -f "$GITIGNORE" ]; then
  if ! grep -q "# Security (added by ClaudeCodeTemplate)" "$GITIGNORE"; then
    echo "" >> "$GITIGNORE"
    echo "# Security (added by ClaudeCodeTemplate)" >> "$GITIGNORE"
    echo "$SECURITY_IGNORES" >> "$GITIGNORE"
    echo ".gitignore にセキュリティ関連パターンを追記しました"
  fi
else
  echo "# Security (added by ClaudeCodeTemplate)" > "$GITIGNORE"
  echo "$SECURITY_IGNORES" >> "$GITIGNORE"
  echo ".gitignore を新規作成しました"
fi

echo ""
echo "=== セットアップ完了 ==="
echo ""
echo "作成/更新されたファイル:"
echo "  $TARGET_DIR/CLAUDE.md"
echo "  $TARGET_DIR/.claude/settings.json"
echo "  $TARGET_DIR/.claude/hooks/ (3 hooks)"
echo "  $TARGET_DIR/.claude/skills/ (5 スキル)"
echo "  $TARGET_DIR/.claude/agents/ (7 エージェント)"
echo "  $TARGET_DIR/DESIGN.md / REQUIREMENTS.md / OPERATIONS.md (雛形)"
echo "  $TARGET_DIR/.github/workflows/security.yml.template"
echo "  $TARGET_DIR/.gitignore (セキュリティパターン追記)"
if [ "$ENABLE_GIT_AUTO" = "y" ]; then
  echo "  $TARGET_DIR/.claude/.git-automation-config (Git 自動化有効)"
fi
echo ""
echo "次のステップ:"
echo "  1. CLAUDE.md をプロジェクトに合わせて調整"
echo "  2. DESIGN.md / REQUIREMENTS.md / OPERATIONS.md を記入"
echo "  3. CI を有効化する場合は security.yml.template から .template を除去"
echo "  4. gitleaks をインストール推奨: https://github.com/gitleaks/gitleaks"
if [ "$ENABLE_GIT_AUTO" = "y" ]; then
  echo "  5. gh CLI 認証: gh auth login"
  echo "  6. 認証完了後: touch $TARGET_DIR/.claude/.git-automation-setup-done"
  echo "  7. Claude Code でセッションを開始 (SessionStart Hook が動作確認)"
else
  echo "  5. Claude Code でセッションを開始"
fi
