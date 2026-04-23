/**
 * E2E カバレッジ gap 検出スクリプト (PR #90)。
 *
 * 目的:
 *   新しい画面 (page.tsx) や API route (route.ts) を追加したとき、
 *   docs/developer/E2E_COVERAGE.md にエントリが欠けていれば CI で fail させる。
 *   機能追加 PR の標準手順として「E2E_COVERAGE.md 更新」を強制する。
 *
 * 検出ロジック:
 *   1. src/app 配下の page.tsx と src/app/api 配下の route.ts を glob
 *   2. 相対パスから URL パスを導出 (例: src/app/api/memos/route.ts → /api/memos)
 *   3. E2E_COVERAGE.md 内のバッククォートで囲まれた URL と照合
 *   4. 記載なしパスを列挙。1 件以上あれば exit 1 で CI 失敗
 *
 * スキップ項目:
 *   - next-auth の [...nextauth] route (NextAuth 内部、テスト対象外)
 *   - layout.tsx / loading.tsx / not-found.tsx 等の UI 補助
 *   - _components / _utils 等 underscore prefix のプライベートファイル
 *
 * 出力例:
 *   ❌ 以下の新規ファイルが docs/developer/E2E_COVERAGE.md に未記載です:
 *     - /api/projects/[projectId]/attachments (src/app/api/projects/[projectId]/attachments/route.ts)
 *     - /new-feature (src/app/(dashboard)/new-feature/page.tsx)
 *   対応: 該当エントリを追記してください (skip 理由も可)
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/**
 * 再帰的に特定のファイル名を収集する (fs.globSync は Node 22+ のみ + @types/node 未提供のため自作)。
 * 返却値は ROOT からの相対パス (POSIX 区切り)。
 */
function findFiles(startDir: string, predicate: (name: string) => boolean): string[] {
  const result: string[] = [];
  const abs = path.resolve(ROOT, startDir);
  function walk(dir: string): void {
    if (!existsDir(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = path.join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (predicate(entry)) {
        result.push(path.relative(ROOT, full));
      }
    }
  }
  walk(abs);
  return result;
}

function existsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function globSync(pattern: string): string[] {
  // 本スクリプトでは 2 パターンしか使わないため簡易実装で十分
  if (pattern === 'src/app/api/**/route.ts') {
    return findFiles('src/app/api', (n) => n === 'route.ts');
  }
  if (pattern === 'src/app/**/page.tsx') {
    return findFiles('src/app', (n) => n === 'page.tsx');
  }
  throw new Error(`Unsupported glob pattern: ${pattern}`);
}

// ---------- 1. ファイルシステムから抽出 ----------

/** Windows / POSIX 両対応: バックスラッシュを / に正規化 */
function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function collectRoutes(): string[] {
  const apiFiles = globSync('src/app/api/**/route.ts');
  return apiFiles
    .map(toPosix)
    .filter((f) => !f.includes('[...nextauth]'))
    .map((f) => {
      // src/app/api/projects/[projectId]/route.ts → /api/projects/[projectId]
      return f.replace(/^src\/app/, '').replace(/\/route\.ts$/, '');
    });
}

function collectPages(): string[] {
  // (dashboard) / (auth) 等のグループディレクトリを除外してパスを組む
  const pageFiles = globSync('src/app/**/page.tsx');
  return pageFiles.map((f) => {
    const rel = toPosix(f)
      .replace(/^src\/app/, '')
      .replace(/\/page\.tsx$/, '')
      .replace(/\/\([^)]+\)/g, ''); // (auth) / (dashboard) 等を除去
    return rel || '/';
  });
}

// ---------- 2. E2E_COVERAGE.md から抽出 ----------

function extractDocumentedPaths(): Set<string> {
  const docPath = path.join(ROOT, 'docs', 'developer', 'E2E_COVERAGE.md');
  const content = readFileSync(docPath, 'utf-8');
  const paths = new Set<string>();

  // バッククォート囲みの内容から / で始まるパス表現を抽出。
  // 例:
  //   `/`                                  → / (ルート)
  //   `/login`                             → /login
  //   `POST /api/projects`                 → /api/projects
  //   `PATCH /api/projects/[id]/tasks/*`   → /api/projects/[id]/tasks/*
  const backtickMatches = content.matchAll(/`([^`]+)`/g);
  for (const m of backtickMatches) {
    // 単独の "/" (ルートパス) を特別扱い
    if (m[1] === '/') {
      paths.add('/');
      continue;
    }
    // それ以外: バッククォート内から `/` で始まる部分文字列 (1 文字以上) を抽出
    const pathMatches = m[1].matchAll(/(\/[^\s`]+)/g);
    for (const pm of pathMatches) {
      paths.add(pm[1]);
    }
  }

  return paths;
}

// ---------- 3. gap 検出 ----------

function matches(fsPath: string, documented: Set<string>): boolean {
  // 完全一致 or ワイルドカード親パス一致 (例: /api/attachments/* が子を代表)
  if (documented.has(fsPath)) return true;
  // 親パス + /* で一括表現されているかを確認
  for (const docPath of documented) {
    if (docPath.endsWith('/*')) {
      const parent = docPath.slice(0, -2);
      if (fsPath.startsWith(parent + '/') || fsPath === parent) return true;
    }
  }
  return false;
}

function main() {
  const routes = collectRoutes();
  const pages = collectPages();
  const documented = extractDocumentedPaths();

  const missing: string[] = [];
  for (const p of [...pages, ...routes]) {
    if (!matches(p, documented)) {
      missing.push(p);
    }
  }

  if (missing.length === 0) {
    console.log('✅ E2E カバレッジ一覧に全ての画面/API ルートが記載されています');
    console.log(`   画面: ${pages.length} 件`);
    console.log(`   API : ${routes.length} 件`);
    return;
  }

  console.error('❌ docs/developer/E2E_COVERAGE.md に未記載の機能があります:');
  for (const m of missing.sort()) {
    console.error(`   - ${m}`);
  }
  console.error('');
  console.error('対応方法:');
  console.error('   docs/developer/E2E_COVERAGE.md の該当セクションにエントリを追加してください。');
  console.error('   未カバーで許容する場合は `[ ] /path — skip: <理由>` の形式で記載可。');
  process.exit(1);
}

main();
