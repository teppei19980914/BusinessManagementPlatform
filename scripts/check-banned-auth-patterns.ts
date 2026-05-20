/**
 * 認証関連の禁止パターン検査 (fix/session-clearance 2026-05-20)
 *
 * 役割:
 *   PR #415 で「NextAuth 既定の signOut を使うと Netlify Set-Cookie 脱落で
 *   誤ユーザログイン事故が起きる」問題を `/api/auth/explicit-signout` への統一で解消した。
 *   本スクリプトは**将来の退行 (新規開発者が「ふつうの signOut でいいでしょ」と書く)** を
 *   CI で機械的に検出するためのガード。
 *
 * 検出する禁止パターン:
 *   1. `import { signOut } from 'next-auth/react'` — 自前 explicit-signout に統一済
 *   2. `import { ..., signOut, ... } from 'next-auth/react'` — 同上 (一括 import 形式)
 *   3. `fetch('/api/auth/signout'` — NextAuth 既定エンドポイント直叩き (Set-Cookie 脱落リスク)
 *   4. `await auth()` を Server Component (`page.tsx` / `layout.tsx`) で使用
 *      ただし以下は除外:
 *        - `src/lib/page-auth.ts` (ヘルパ自身、内部で auth() を呼ぶのが本来の動作)
 *        - `src/app/layout.tsx` (root layout: theme 解決のみ、DB query なし)
 *        - `src/app/(auth)/**` (認証フロー自体のページ群、tenantId 未読取)
 *        - `src/app/(dashboard)/**` (親 layout の requireAuthForLayout で tokenVersion 検証済。
 *          ただし (dashboard)/layout.tsx 自身は `requireAuthForLayout` 使用必須 ← 別途検証)
 *
 *   ★ 重要な前提:
 *      上記の除外は **`(dashboard)/layout.tsx` が `requireAuthForLayout()` を呼んでいる**
 *      ことに依存している。万一この呼出を auth() に戻すと、配下 28 ページが一斉に
 *      stale JWT 経由で個人情報漏洩する。layout.tsx の保護は本ルールの土台。
 *
 * 検出時は exit 1 で CI を fail させる。
 *
 * 例外的に許可が必要な場合は該当行末に `// banned-auth-allow: <理由>` を付与する。
 *
 * 関連:
 *   - KDD §5.X+84 (本件の経緯)
 *   - src/app/api/auth/explicit-signout/route.ts (統一先)
 *   - src/lib/page-auth.ts (Server Component 向けヘルパ)
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

type Finding = {
  file: string;
  line: number;
  pattern: string;
  message: string;
};

const findings: Finding[] = [];

/** path セパレータを `/` に統一 (Windows でも比較安定) */
function normalize(p: string): string {
  return p.split(path.sep).join('/');
}

/** ディレクトリ配下を再帰的に walk して条件にマッチするファイル一覧を返す。 */
function walk(
  dir: string,
  matcher: (relPath: string) => boolean,
  out: string[] = [],
): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    // node_modules / .next / .git / dist 等の生成物 + 隠しディレクトリはスキップ
    if (entry === 'node_modules' || entry === '.next' || entry === '.git' || entry === 'dist' || entry === 'coverage') {
      continue;
    }
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      walk(abs, matcher, out);
    } else if (stat.isFile()) {
      const rel = normalize(path.relative(ROOT, abs));
      if (matcher(rel)) out.push(abs);
    }
  }
  return out;
}

function scan(
  files: string[],
  patternName: string,
  regex: RegExp,
  message: string,
  excludePathsNormalized: string[] = [],
): void {
  for (const file of files) {
    const rel = normalize(path.relative(ROOT, file));
    if (excludePathsNormalized.some((ex) => rel === ex)) continue;
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      if (regex.test(line)) {
        findings.push({
          file: rel,
          line: idx + 1,
          pattern: patternName,
          message,
        });
      }
    });
  }
}

function main(): void {
  // 全 ts / tsx (test ファイルと型定義は除外、本スクリプト自身も除外)
  const srcDir = path.join(ROOT, 'src');
  const allSources = walk(srcDir, (rel) => {
    return (
      (rel.endsWith('.ts') || rel.endsWith('.tsx'))
      && !rel.endsWith('.test.ts')
      && !rel.endsWith('.test.tsx')
      && !rel.endsWith('.d.ts')
    );
  });

  // Server Component (page.tsx / layout.tsx) のみ抽出
  const serverComponents = allSources.filter((abs) => {
    const rel = normalize(path.relative(ROOT, abs));
    return /\/(page|layout)\.tsx$/.test(rel);
  });

  // パターン 1+2: `from 'next-auth/react'` の signOut import
  scan(
    allSources,
    'BANNED_SIGNOUT_IMPORT',
    /import\s+\{[^}]*\bsignOut\b[^}]*\}\s+from\s+['"]next-auth\/react['"]/,
    "next-auth/react の signOut import は禁止。/api/auth/explicit-signout を fetch するパターンに統一すること (KDD §5.X+84)。",
  );

  // パターン 3: NextAuth 既定 /api/auth/signout への直接 fetch
  //   `/api/auth/explicit-signout` への fetch は除外する (正規表現で / または ' で末尾を限定)
  scan(
    allSources,
    'BANNED_NEXTAUTH_SIGNOUT_FETCH',
    /fetch\s*\(\s*['"]\/api\/auth\/signout['"]/,
    "/api/auth/signout への直接 fetch は禁止。/api/auth/explicit-signout に統一すること (KDD §5.X+84)。",
  );

  // パターン 4: Server Component (layout.tsx / page.tsx) で `await auth()` を直接呼出
  //   除外: 親 layout で守られている (dashboard) 配下、認証フロー (auth) 配下、特定 helper
  const serverComponentsForCheck = serverComponents.filter((abs) => {
    const rel = normalize(path.relative(ROOT, abs));
    // (dashboard) 配下は親 layout.tsx の requireAuthForLayout で tokenVersion 検証済
    // → 各 page.tsx の auth() 呼出は layout が redirect した後は到達しないため安全
    if (rel.startsWith('src/app/(dashboard)/')) return false;
    // (auth) 配下は認証フロー自体 (login / mfa / signup 等)、tenantId 未読取
    if (rel.startsWith('src/app/(auth)/')) return false;
    return true;
  });

  scan(
    serverComponentsForCheck,
    'BANNED_DIRECT_AUTH_IN_SERVER_COMPONENT',
    /\bawait\s+auth\s*\(\s*\)/,
    "Server Component (page.tsx / layout.tsx) での `await auth()` 直接呼出は禁止 (新規 route group の場合)。src/lib/page-auth.ts の `requireAuthForLayout()` を経由して tokenVersion 検証を必ず行うこと (KDD §5.X+84)。例外的に許可する場合は同行末に `// banned-auth-allow: <理由>` コメントを付与すること。",
    [
      // root layout: theme 解決のみで DB query なし。tokenVersion 検証は (dashboard)/layout で実施
      'src/app/layout.tsx',
    ],
  );

  // パターン 5: (dashboard)/layout.tsx と (dashboard)/admin/super/layout.tsx は
  // `requireAuthForLayout()` を呼出必須 (= 配下 page 群の保護の土台)。
  // 万一誰かが auth() 直接呼出に戻したらここで CI fail させる。
  const protectedLayouts = [
    'src/app/(dashboard)/layout.tsx',
    'src/app/(dashboard)/admin/super/layout.tsx',
  ];
  for (const rel of protectedLayouts) {
    const abs = path.join(ROOT, rel);
    let content: string;
    try {
      content = readFileSync(abs, 'utf8');
    } catch {
      findings.push({
        file: rel,
        line: 0,
        pattern: 'PROTECTED_LAYOUT_MISSING',
        message: `保護必須の layout (${rel}) が存在しません。削除した場合は配下ページの認証保護が失われます。`,
      });
      continue;
    }
    if (!/requireAuthForLayout\s*\(/.test(content)) {
      findings.push({
        file: rel,
        line: 0,
        pattern: 'PROTECTED_LAYOUT_MISSING_GUARD',
        message: `${rel} で requireAuthForLayout() を呼んでいません。配下 page 群の tokenVersion 検証が抜け落ち、誤ユーザログイン経路で個人情報漏洩リスクが復活します (KDD §5.X+84)。`,
      });
    }
  }

  // 該当行に `// banned-auth-allow:` コメントがあれば除外する
  const filtered = findings.filter((f) => {
    const content = readFileSync(path.join(ROOT, f.file), 'utf8');
    const targetLine = content.split('\n')[f.line - 1] ?? '';
    return !/\/\/\s*banned-auth-allow:/.test(targetLine);
  });

  if (filtered.length === 0) {
    console.log('✅ 禁止パターンは検出されませんでした');
    process.exit(0);
  }

  console.error(`❌ 認証関連の禁止パターンを ${filtered.length} 件検出しました:\n`);
  for (const f of filtered) {
    console.error(`  ${f.file}:${f.line}`);
    console.error(`    [${f.pattern}] ${f.message}\n`);
  }
  console.error('対応方法:');
  console.error('  1. signOut import → /api/auth/explicit-signout への fetch に置換');
  console.error('  2. Server Component の auth() → requireAuthForLayout() に置換');
  console.error('  3. 例外的に許可が必要な場合は該当行末に `// banned-auth-allow: <理由>` を付与');
  process.exit(1);
}

main();
