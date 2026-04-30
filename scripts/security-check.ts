/**
 * セキュリティチェックスクリプト
 *
 * 目的:
 *   ソースコードの静的スキャン + 依存ライブラリ監査を実行し、以下の2ファイルを生成する。
 *   - docs/security/security-report.html  : 人間向けビジュアルレポート
 *   - docs/security/SECURITY-TASKS.md     : Claude Code 向け修正タスクシート
 *
 * 実行方法:
 *   tsx scripts/security-check.ts
 *
 * チェック項目:
 *   [DEP] 依存ライブラリ — beta/RC バージョン、pnpm audit 結果
 *   [AUTH] 認証 / セッション — callbackUrl 未検証、SameSite 設定
 *   [RATE] レート制限 — 公開エンドポイントの制限欠如
 *   [CRYPTO] 暗号化 — キー派生の弱点
 *   [CSP] セキュリティヘッダー — unsafe-inline / unsafe-eval
 *   [INJECT] インジェクション — $queryRawUnsafe, $executeRawUnsafe
 *   [LEAK] 情報漏洩 — console.log への機密データ出力
 *   [SECRET] シークレット — ハードコードされた認証情報、デフォルト値
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'docs', 'security');
const REPORT_DATE = new Date().toISOString().split('T')[0];
const REPORT_DATETIME = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

// ─────────────────────────────────────────────
// 型定義
// ─────────────────────────────────────────────

type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

interface Finding {
  id: string;
  severity: Severity;
  category: string;
  title: string;
  description: string;
  file?: string;
  line?: number;
  evidence?: string;      // 問題のあるコード断片
  recommendation: string; // 修正方針
  fixExample?: string;    // 修正後コード例
  testRequired?: string;  // テスト要件
}

// ─────────────────────────────────────────────
// ユーティリティ
// ─────────────────────────────────────────────

/**
 * 除外ディレクトリ (PR #198 で追加):
 *   - generated: Prisma Client 等の自動生成コード (手動編集対象外、ノイズ source)
 */
const EXCLUDED_DIRS = new Set(['node_modules', '.next', 'generated']);

function findFiles(dir: string, predicate: (name: string) => boolean): string[] {
  const result: string[] = [];
  const abs = path.resolve(ROOT, dir);
  if (!existsSync(abs)) return result;
  function walk(current: string) {
    for (const entry of readdirSync(current)) {
      if (entry.startsWith('.') || EXCLUDED_DIRS.has(entry)) continue;
      const full = path.join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (predicate(entry)) result.push(path.relative(ROOT, full));
    }
  }
  walk(abs);
  return result;
}

function readFile(relPath: string): string {
  try { return readFileSync(path.join(ROOT, relPath), 'utf-8'); }
  catch { return ''; }
}

function findLineNumber(content: string, pattern: RegExp): number | undefined {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return i + 1;
  }
  return undefined;
}

function relPath(p: string): string {
  return p.replace(/\\/g, '/');
}

// ─────────────────────────────────────────────
// Accept-list (PR #198 で追加)
// ─────────────────────────────────────────────
//
// 検出対象だが「設計判断として受容している」事項を `.security-check-acceptlist.json`
// で管理する。例: next-auth の安定版が出るまで beta を採用、next-intl の制約で
// CSP unsafe-inline を一時許容、等。
//
// 形式:
// {
//   "accepted": [
//     {
//       "matcher": { "category": "DEP", "titleContains": "next-auth" },
//       "reason": "...",
//       "until": "2026-12-31",  // 任意の見直し期限
//       "owner": "..."
//     }
//   ]
// }

interface AcceptListEntry {
  matcher: {
    category?: string;
    titleContains?: string;
    file?: string;
  };
  reason: string;
  until?: string;
  owner?: string;
}

interface AcceptListConfig {
  accepted: AcceptListEntry[];
}

let acceptListCache: AcceptListConfig | null = null;

function loadAcceptList(): AcceptListConfig {
  if (acceptListCache) return acceptListCache;
  const filePath = path.join(ROOT, '.security-check-acceptlist.json');
  if (!existsSync(filePath)) {
    acceptListCache = { accepted: [] };
    return acceptListCache;
  }
  try {
    const raw = readFileSync(filePath, 'utf-8');
    acceptListCache = JSON.parse(raw) as AcceptListConfig;
    return acceptListCache;
  } catch {
    acceptListCache = { accepted: [] };
    return acceptListCache;
  }
}

function isAccepted(f: Omit<Finding, 'id'>): boolean {
  const cfg = loadAcceptList();
  return cfg.accepted.some((entry) => {
    const m = entry.matcher;
    if (m.category && m.category !== f.category) return false;
    if (m.titleContains && !f.title.includes(m.titleContains)) return false;
    if (m.file && f.file !== m.file) return false;
    return true;
  });
}

// ─────────────────────────────────────────────
// チェック関数群
// ─────────────────────────────────────────────

const findings: Finding[] = [];
const acceptedFindings: Array<Omit<Finding, 'id'> & { acceptReason: string }> = [];
let findingCounter = 1;

function addFinding(f: Omit<Finding, 'id'>) {
  // accept-list に該当する場合は score 減点せず、別配列に記録する
  // (レポートには「受容済み」として表示し、人間レビュー対象から外す)
  if (isAccepted(f)) {
    const cfg = loadAcceptList();
    const matched = cfg.accepted.find((entry) => {
      const m = entry.matcher;
      if (m.category && m.category !== f.category) return false;
      if (m.titleContains && !f.title.includes(m.titleContains)) return false;
      if (m.file && f.file !== m.file) return false;
      return true;
    });
    acceptedFindings.push({ ...f, acceptReason: matched?.reason ?? '(受容理由未記載)' });
    return;
  }
  findings.push({ id: `F-${String(findingCounter++).padStart(2, '0')}`, ...f });
}

/** [DEP] beta/RC ライブラリ検出 */
function checkBetaDependencies() {
  const pkg = JSON.parse(readFile('package.json'));
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const [name, ver] of Object.entries(all as Record<string, string>)) {
    if (/beta|alpha|rc|canary/i.test(ver)) {
      addFinding({
        severity: 'HIGH',
        category: 'DEP',
        title: `本番環境でプレリリース版を使用: ${name}@${ver}`,
        description: `"${name}@${ver}" はベータ/RC 版です。セキュリティパッチが正式版と異なるサイクルで提供されるため、未公表の脆弱性が放置されるリスクがあります。`,
        file: 'package.json',
        evidence: `"${name}": "${ver}"`,
        recommendation: `${name} の安定版リリース状況を確認し、stable リリース後は速やかに移行してください。`,
        testRequired: '認証フローの E2E テストが全て通過すること。',
      });
    }
  }
}

/** [DEP] pnpm audit 実行 */
function runPnpmAudit() {
  try {
    const result = execSync('pnpm audit --json 2>/dev/null', { cwd: ROOT, encoding: 'utf-8' });
    const data = JSON.parse(result);
    const advisories = Object.values(data.advisories ?? {}) as Array<{
      severity: string; title: string; module_name: string; url: string;
    }>;
    for (const adv of advisories) {
      const sev = adv.severity.toUpperCase() as Severity;
      addFinding({
        severity: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].includes(sev) ? sev : 'MEDIUM',
        category: 'DEP',
        title: `[pnpm audit] ${adv.module_name}: ${adv.title}`,
        description: `pnpm audit により検出された既知脆弱性。詳細: ${adv.url}`,
        recommendation: `pnpm update ${adv.module_name} でパッチバージョンに更新、または pnpm audit fix を実行してください。`,
      });
    }
  } catch {
    // audit コマンド失敗 (lockfile なし等) は無視
  }
}

/** [AUTH] callbackUrl 未検証 (オープンリダイレクト) */
function checkOpenRedirect() {
  const files = findFiles('src', f => f.endsWith('.tsx') || f.endsWith('.ts'));
  const pattern = /window\.location\.href\s*=\s*callbackUrl/;
  for (const file of files) {
    const content = readFile(file);
    if (pattern.test(content)) {
      const line = findLineNumber(content, pattern);
      addFinding({
        severity: 'HIGH',
        category: 'AUTH',
        title: 'callbackUrl の未検証によるオープンリダイレクト',
        description: '外部ドメインを含む任意の URL へリダイレクト可能な状態です。フィッシング攻撃に悪用されます。',
        file: relPath(file),
        line,
        evidence: `window.location.href = callbackUrl;`,
        recommendation: 'callbackUrl が同一オリジン（/ で始まり // で始まらない）であることを検証してからリダイレクトしてください。',
        fixExample: `// src/lib/url-utils.ts に追加
export function isSafeCallbackUrl(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//');
}

// 使用箇所
import { isSafeCallbackUrl } from '@/lib/url-utils';
window.location.href = isSafeCallbackUrl(callbackUrl) ? callbackUrl : '/';`,
        testRequired: 'callbackUrl に外部 URL (https://evil.example.com) を渡したとき / にリダイレクトされることをテストすること。',
      });
    }
  }
}

/** [AUTH] SameSite=Lax → Strict 推奨 */
function checkSameSiteLax() {
  const file = 'src/lib/auth.config.ts';
  const content = readFile(file);
  if (/sameSite:\s*['"]lax['"]/i.test(content)) {
    const line = findLineNumber(content, /sameSite:\s*['"]lax['"]/i);
    addFinding({
      severity: 'LOW',
      category: 'AUTH',
      title: 'セッション Cookie の SameSite が Strict でなく Lax',
      description: 'SameSite=Lax は GET トップレベルナビゲーション時に Cookie を送信します。外部サイトからの誘導後も認証状態を維持する必要がなければ Strict が推奨です。',
      file: relPath(file),
      line,
      evidence: `sameSite: 'lax',`,
      recommendation: `sameSite: 'strict' に変更してください。`,
      fixExample: `sameSite: 'strict',`,
      testRequired: '変更後にログインフロー（通常ログイン・MFA ログイン）の E2E テストが通過すること。',
    });
  }
}

/** [RATE] 公開 API エンドポイントにレート制限がないか確認 */
function checkRateLimiting() {
  const publicEndpoints = [
    'src/app/api/auth/reset-password/route.ts',
    'src/app/api/auth/setup-password/route.ts',
    'src/app/api/auth/lock-status/route.ts',
  ];
  const unprotected: string[] = [];
  for (const file of publicEndpoints) {
    const content = readFile(file);
    if (!content) continue;
    const hasRateLimit = /rateLimit|rate_limit|rateLimiter|upstash|429/i.test(content);
    if (!hasRateLimit) unprotected.push(relPath(file));
  }
  if (unprotected.length > 0) {
    addFinding({
      severity: 'HIGH',
      category: 'RATE',
      title: '公開認証エンドポイントにレート制限が未実装',
      description: `以下の認証不要エンドポイントにリクエスト数制限がなく、ブルートフォース・スパム攻撃のリスクがあります:\n${unprotected.map(f => `  - ${f}`).join('\n')}`,
      evidence: `// レート制限の実装が見当たらないファイル:\n${unprotected.map(f => `// ${f}`).join('\n')}`,
      recommendation: 'Upstash Redis + @upstash/ratelimit を使い、IP ベースのレート制限を実装してください。目安: 同一 IP から 5 分間に 10 回まで。',
      fixExample: `// src/lib/rate-limit.ts (新規作成)
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { NextRequest, NextResponse } from 'next/server';

const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(10, '5 m'),
});

export async function applyRateLimit(req: NextRequest): Promise<NextResponse | null> {
  const ip = req.ip ?? req.headers.get('x-forwarded-for') ?? 'unknown';
  const { success } = await ratelimit.limit(ip);
  if (!success) {
    return NextResponse.json(
      { error: { code: 'TOO_MANY_REQUESTS' } },
      { status: 429 }
    );
  }
  return null;
}

// 各 route.ts の先頭で呼び出す例:
// const limited = await applyRateLimit(req);
// if (limited) return limited;`,
      testRequired: '同一 IP から閾値以上のリクエストを送った場合に 429 が返ることをユニットテストで確認すること。',
    });
  }
}

/** [CRYPTO] MFA 暗号化キーのゼロパディング */
function checkMfaEncryptionKey() {
  const file = 'src/services/mfa.service.ts';
  const content = readFile(file);
  if (/padEnd\(32,\s*['"]0['"]\)/.test(content)) {
    const line = findLineNumber(content, /padEnd\(32,\s*['"]0['"]\)/);
    addFinding({
      severity: 'MEDIUM',
      category: 'CRYPTO',
      title: 'MFA 暗号化キーが NEXTAUTH_SECRET から直接派生 (短い場合にゼロパディング)',
      description: 'NEXTAUTH_SECRET が 32 文字未満の場合、残りがゼロ文字で埋められ、予測可能なキーになります。また JWT 署名と暗号化キーが同一シークレット由来で用途分離が不十分です。',
      file: relPath(file),
      line,
      evidence: `const ENCRYPTION_KEY = process.env.NEXTAUTH_SECRET?.slice(0, 32).padEnd(32, '0') || '0'.repeat(32);`,
      recommendation: 'MFA 暗号化専用の環境変数 MFA_ENCRYPTION_KEY を追加してください。openssl rand -base64 32 で生成した 32 文字以上のランダム値を使用します。',
      fixExample: `// src/services/mfa.service.ts
const rawKey = process.env.MFA_ENCRYPTION_KEY;
if (!rawKey || rawKey.length < 32) {
  throw new Error('MFA_ENCRYPTION_KEY は 32 文字以上の環境変数を設定してください');
}
const ENCRYPTION_KEY = rawKey.slice(0, 32);

// .env.example に追加
// MFA_ENCRYPTION_KEY=  # openssl rand -base64 32 で生成`,
      testRequired: 'MFA_ENCRYPTION_KEY 未設定時にサーバー起動エラーになることをテストすること。MFA 登録→認証の E2E が通過すること。',
    });
  }
}

/** [CSP] unsafe-inline が本番 CSP に残存 */
function checkCspUnsafeInline() {
  const file = 'next.config.ts';
  const content = readFile(file);
  // 本番 (isDev=false) でも unsafe-inline が使われていないか確認
  if (/"script-src 'self' 'unsafe-inline'"/.test(content)) {
    const line = findLineNumber(content, /"script-src 'self' 'unsafe-inline'"/);
    addFinding({
      severity: 'MEDIUM',
      category: 'CSP',
      title: "本番 CSP の script-src に 'unsafe-inline' が残存",
      description: "'unsafe-inline' が有効だと XSS 攻撃者がインラインスクリプトを実行できます。CSP の XSS 防御効果が大幅に低下します。",
      file: relPath(file),
      line,
      evidence: `"script-src 'self' 'unsafe-inline'"`,
      recommendation: "Next.js nonce ベース CSP に移行し、'unsafe-inline' を排除してください。",
      fixExample: `// middleware.ts で nonce を生成し、next.config.ts の CSP に反映する方式
// 参照: https://nextjs.org/docs/app/building-your-application/configuring/content-security-policy

// middleware.ts
import { NextResponse } from 'next/server';
export function middleware(request: Request) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const response = NextResponse.next();
  response.headers.set('x-nonce', nonce);
  // CSP ヘッダーに nonce を埋め込む
  response.headers.set(
    'Content-Security-Policy',
    \`script-src 'self' 'nonce-\${nonce}'\`
  );
  return response;
}`,
      testRequired: "CSP レスポンスヘッダーに 'unsafe-inline' が含まれないことを HTTP レスポンステストで確認すること。",
    });
  }
}

/** [INJECT] $queryRawUnsafe / $executeRawUnsafe の使用 */
function checkUnsafeRawQuery() {
  const files = findFiles('src', f => f.endsWith('.ts') || f.endsWith('.tsx'));
  const pattern = /\$queryRawUnsafe|\$executeRawUnsafe/;
  for (const file of files) {
    const content = readFile(file);
    if (pattern.test(content)) {
      const line = findLineNumber(content, pattern);
      addFinding({
        severity: 'CRITICAL',
        category: 'INJECT',
        title: `SQLインジェクションリスク: $queryRawUnsafe / $executeRawUnsafe の使用 (${relPath(file)})`,
        description: 'Prisma の unsafe 系 API は SQL インジェクションの危険があります。ユーザー入力を文字列連結で渡すと攻撃が成立します。',
        file: relPath(file),
        line,
        evidence: `$queryRawUnsafe(...)`,
        recommendation: 'タグドテンプレートリテラルの $queryRaw に置き換えるか、Prisma の型安全な API を使用してください。',
        fixExample: `// NG
await prisma.$queryRawUnsafe(\`SELECT * FROM users WHERE name = '\${input}'\`);

// OK: タグドテンプレート (自動パラメータ化)
await prisma.$queryRaw\`SELECT * FROM users WHERE name = \${input}\`;`,
        testRequired: '悪意ある SQL 文字列を渡したときにエラーになることをユニットテストで確認すること。',
      });
    }
  }
}

/** [LEAK] console.log への機密情報出力 */
function checkSensitiveLog() {
  const files = findFiles('src', f => f.endsWith('.ts') || f.endsWith('.tsx'));
  const pattern = /console\.(log|error|warn|debug)\s*\(.*?(password|secret|token|key|hash)/i;
  for (const file of files) {
    const content = readFile(file);
    if (pattern.test(content)) {
      const line = findLineNumber(content, pattern);
      addFinding({
        severity: 'MEDIUM',
        category: 'LEAK',
        title: `console.log への機密情報出力の可能性: ${relPath(file)}`,
        description: 'パスワード・シークレット・トークン・ハッシュ等を含む変数が console.log に渡されている可能性があります。ログ収集ツール経由で漏洩するリスクがあります。',
        file: relPath(file),
        line,
        evidence: '// password / secret / token / hash などをログ出力している行',
        recommendation: '機密情報を含む変数をログに出力しないでください。デバッグ用のログは本番ビルドで削除するか、機密フィールドをマスクしてください。',
        fixExample: `// NG
console.log('user:', { email, password, token });

// OK: 機密フィールドを除外
console.log('user:', { email });`,
        testRequired: 'コードレビューで対象行を確認し、意図しない機密情報の出力がないことを確認すること。',
      });
    }
  }
}

/** [SECRET] ハードコードされたシークレット・デフォルト値 */
function checkHardcodedSecrets() {
  const configFiles = ['src/lib/auth.config.ts', 'src/lib/auth.ts'];
  for (const file of configFiles) {
    const content = readFile(file);
    // デフォルト値フォールバックのチェック
    if (/\|\|\s*['"][a-zA-Z0-9]{8,}['"]/.test(content)) {
      addFinding({
        severity: 'MEDIUM',
        category: 'SECRET',
        title: `ハードコードされたデフォルトシークレット値: ${relPath(file)}`,
        description: '環境変数が未設定の場合にフォールバックするハードコード値が存在します。本番環境での設定漏れ時に固定値で動作するリスクがあります。',
        file: relPath(file),
        evidence: '// || "..." のフォールバック値',
        recommendation: '未設定時はアプリケーションを起動エラーにしてください。デフォルト値での無言の動作継続は危険です。',
        fixExample: `// NG
secret: process.env.NEXTAUTH_SECRET || 'fallback-secret-value',

// OK: 未設定時に明示的なエラー
const secret = process.env.NEXTAUTH_SECRET;
if (!secret) throw new Error('NEXTAUTH_SECRET 環境変数が設定されていません');`,
        testRequired: '必須環境変数が未設定の場合にサーバーが起動エラーになることを確認すること。',
      });
    }
  }
}

// ─────────────────────────────────────────────
// スコアリング
// ─────────────────────────────────────────────

function calcScore(): number {
  // カテゴリ×重大度の組み合わせで重複排除 (同一問題の多重カウントを防ぐ)
  const deductions: Record<Severity, number> = { CRITICAL: 20, HIGH: 12, MEDIUM: 6, LOW: 2, INFO: 0 };
  const seen = new Set<string>();
  let score = 100;
  for (const f of findings) {
    const key = `${f.category}:${f.severity}`;
    if (!seen.has(key)) {
      score -= deductions[f.severity];
      seen.add(key);
    }
  }
  return Math.max(0, score);
}

// ─────────────────────────────────────────────
// HTML レポート生成
// ─────────────────────────────────────────────

function severityColor(s: Severity): string {
  return { CRITICAL: '#ff4d4d', HIGH: '#f59e0b', MEDIUM: '#60a5fa', LOW: '#34d399', INFO: '#94a3b8' }[s];
}

function severityBg(s: Severity): string {
  return { CRITICAL: 'rgba(255,77,77,0.12)', HIGH: 'rgba(245,158,11,0.12)', MEDIUM: 'rgba(96,165,250,0.1)', LOW: 'rgba(52,211,153,0.1)', INFO: 'rgba(148,163,184,0.08)' }[s];
}

function generateHtml(score: number): string {
  const sevCount = (s: Severity) => findings.filter(f => f.severity === s).length;
  const findingCards = findings.map(f => `
    <div class="finding" style="border-left:3px solid ${severityColor(f.severity)}">
      <div class="finding-head">
        <span class="badge" style="background:${severityBg(f.severity)};color:${severityColor(f.severity)}">${f.severity}</span>
        <span class="fid">${f.id}</span>
        <span class="cat">${f.category}</span>
        <strong class="ftitle">${f.title}</strong>
      </div>
      ${f.file ? `<div class="floc">📄 ${f.file}${f.line ? ` (L${f.line})` : ''}</div>` : ''}
      <p class="fdesc">${f.description}</p>
      ${f.evidence ? `<pre class="code">${escHtml(f.evidence)}</pre>` : ''}
      <div class="fix"><strong>💡 推奨対策</strong><p>${f.recommendation}</p></div>
      ${f.fixExample ? `<pre class="code ok">${escHtml(f.fixExample)}</pre>` : ''}
      ${f.testRequired ? `<div class="test"><strong>🧪 テスト要件</strong><p>${f.testRequired}</p></div>` : ''}
    </div>`).join('');

  return `<!DOCTYPE html>
<html lang="ja"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>たすきば セキュリティレポート ${REPORT_DATE}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0c10;color:#e2e8f0;font-family:'Segoe UI',sans-serif;font-size:14px;line-height:1.7}
.header{background:#111318;border-bottom:1px solid #1e2330;padding:32px 40px}
.header-tag{font-family:monospace;font-size:11px;color:#ff4d4d;letter-spacing:3px;margin-bottom:8px}
.header h1{font-size:24px;font-weight:700;margin-bottom:4px}
.header-meta{font-size:12px;color:#64748b;font-family:monospace}
.header-meta span{color:#60a5fa}
.summary{display:flex;align-items:center;gap:40px;padding:24px 40px;background:#0f1117;border-bottom:1px solid #1e2330}
.score-box{text-align:center}
.score-num{font-family:monospace;font-size:48px;font-weight:700;color:${score>=80?'#34d399':score>=60?'#f59e0b':'#ff4d4d'};line-height:1}
.score-label{font-size:11px;color:#64748b;letter-spacing:2px;margin-top:4px}
.counts{display:flex;gap:16px;flex-wrap:wrap}
.cnt{background:#111318;border:1px solid #1e2330;border-radius:6px;padding:10px 18px;text-align:center}
.cnt .n{font-family:monospace;font-size:24px;font-weight:700}
.cnt .l{font-size:11px;color:#64748b;letter-spacing:1px}
.section{padding:24px 40px}
.section h2{font-family:monospace;font-size:11px;letter-spacing:3px;color:#64748b;text-transform:uppercase;margin-bottom:16px}
.finding{background:#111318;border:1px solid #1e2330;border-radius:6px;padding:16px;margin-bottom:12px}
.finding-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.badge{font-family:monospace;font-size:10px;font-weight:700;letter-spacing:1px;padding:2px 8px;border-radius:3px}
.fid{font-family:monospace;font-size:11px;color:#64748b}
.cat{font-family:monospace;font-size:10px;background:#1e2330;color:#60a5fa;padding:2px 7px;border-radius:3px}
.ftitle{font-size:14px;color:#e2e8f0}
.floc{font-size:12px;color:#64748b;font-family:monospace;margin-bottom:6px}
.fdesc{color:#94a3b8;font-size:13px;margin-bottom:10px}
.code{background:#0d1117;border:1px solid #1e2330;border-radius:4px;padding:10px 12px;font-family:monospace;font-size:12px;color:#c9d1d9;overflow-x:auto;margin-bottom:10px;white-space:pre-wrap}
.code.ok{border-color:rgba(52,211,153,0.3);color:#a7f3d0}
.fix{background:rgba(52,211,153,0.04);border:1px solid rgba(52,211,153,0.15);border-radius:4px;padding:10px 12px;margin-bottom:8px}
.fix strong,.test strong{font-size:12px;color:#34d399;display:block;margin-bottom:4px}
.fix p,.test p{font-size:13px;color:#94a3b8}
.test{background:rgba(96,165,250,0.04);border:1px solid rgba(96,165,250,0.15);border-radius:4px;padding:10px 12px}
.test strong{color:#60a5fa}
footer{padding:16px 40px;border-top:1px solid #1e2330;font-family:monospace;font-size:11px;color:#475569;display:flex;justify-content:space-between}
</style></head><body>
<div class="header">
  <div class="header-tag">// SECURITY AUDIT REPORT</div>
  <h1>たすきば セキュリティチェックレポート</h1>
  <div class="header-meta">生成日時: <span>${REPORT_DATETIME}</span> &nbsp;|&nbsp; スタック: <span>Next.js / NextAuth v5 / Prisma / PostgreSQL</span></div>
</div>
<div class="summary">
  <div class="score-box">
    <div class="score-num">${score}</div>
    <div class="score-label">/ 100</div>
  </div>
  <div class="counts">
    <div class="cnt"><div class="n" style="color:#ff4d4d">${sevCount('CRITICAL')}</div><div class="l">CRITICAL</div></div>
    <div class="cnt"><div class="n" style="color:#f59e0b">${sevCount('HIGH')}</div><div class="l">HIGH</div></div>
    <div class="cnt"><div class="n" style="color:#60a5fa">${sevCount('MEDIUM')}</div><div class="l">MEDIUM</div></div>
    <div class="cnt"><div class="n" style="color:#34d399">${sevCount('LOW')}</div><div class="l">LOW</div></div>
    <div class="cnt"><div class="n" style="color:#94a3b8">${findings.length}</div><div class="l">TOTAL</div></div>
    <div class="cnt"><div class="n" style="color:#94a3b8">${acceptedFindings.length}</div><div class="l">ACCEPTED</div></div>
  </div>
</div>
<div class="section">
  <h2>// 検出項目</h2>
  ${findings.length === 0 ? '<p style="color:#34d399">✓ 検出された問題はありません</p>' : findingCards}
</div>
${acceptedFindings.length > 0 ? `<div class="section">
  <h2>// 受容済み (Accept-list、score 計算対象外)</h2>
  ${acceptedFindings.map((f, i) => `
    <div class="finding" style="border-left:3px solid #94a3b8;opacity:0.75">
      <div class="finding-head">
        <span class="badge" style="background:rgba(148,163,184,0.12);color:#94a3b8">ACCEPTED</span>
        <span class="fid">A-${String(i + 1).padStart(2, '0')}</span>
        <span class="cat">${f.category}</span>
        <strong class="ftitle">${f.title}</strong>
      </div>
      ${f.file ? `<div class="floc">📄 ${f.file}${f.line ? ` (L${f.line})` : ''}</div>` : ''}
      <p class="fdesc">${f.description}</p>
      <div class="fix"><strong>📝 受容理由</strong><p>${f.acceptReason}</p></div>
    </div>`).join('')}
</div>` : ''}
<footer>
  <span>docs/security/security-report.html</span>
  <span>${REPORT_DATE} — たすきば自動セキュリティチェック</span>
</footer>
</body></html>`;
}

function escHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─────────────────────────────────────────────
// TASKS.md 生成 (Claude Code 向け)
// ─────────────────────────────────────────────

function generateTasks(score: number): string {
  const priorityFindings = findings.filter(f => f.severity === 'CRITICAL' || f.severity === 'HIGH');
  const otherFindings    = findings.filter(f => f.severity !== 'CRITICAL' && f.severity !== 'HIGH');

  function taskBlock(f: Finding): string {
    return `
## ${f.id}: ${f.title}

**Severity**: ${f.severity}
**Category**: ${f.category}
${f.file ? `**File**: \`${f.file}\`${f.line ? ` (line ${f.line})` : ''}` : ''}

### 問題

${f.description}

${f.evidence ? `**問題のあるコード:**
\`\`\`typescript
${f.evidence}
\`\`\`` : ''}

### 修正要件

${f.recommendation}

${f.fixExample ? `**修正後のコード例:**
\`\`\`typescript
${f.fixExample}
\`\`\`` : ''}

### テスト要件 (必須)

${f.testRequired ?? '修正内容に応じたユニットテストまたは E2E テストを追加すること。'}

### 完了条件

- [ ] 上記の修正要件を満たすコードが実装されている
- [ ] テスト要件を満たすテストコードが追加・通過している
- [ ] 同じパターンが他ファイルに横展開していないか検索済み
- [ ] \`pnpm test\` が全件通過している

---`;
  }

  return `# SECURITY-TASKS.md
> 生成日時: ${REPORT_DATETIME}
> スクリプト: \`tsx scripts/security-check.ts\`
> 総合スコア: **${score}/100**
> 検出件数: CRITICAL ${findings.filter(f=>f.severity==='CRITICAL').length} / HIGH ${findings.filter(f=>f.severity==='HIGH').length} / MEDIUM ${findings.filter(f=>f.severity==='MEDIUM').length} / LOW ${findings.filter(f=>f.severity==='LOW').length}

## Claude Code への指示

このファイルはセキュリティチェックスクリプトが自動生成したタスクシートです。
以下の手順で修正を実施してください:

1. **優先度 HIGH 以上のタスクから順に対応** してください
2. 各タスクの「修正要件」と「修正後のコード例」に従って実装してください
3. **テスト要件は必須** です。テストなしの修正はコミットしないでください
4. 各タスク完了後に「完了条件」のチェックボックスを確認してください
5. 全タスク完了後に \`tsx scripts/security-check.ts\` を再実行し、スコアが改善されていることを確認してください

---

${priorityFindings.length > 0 ? `# ⚠️ 優先対応 (CRITICAL / HIGH)\n${priorityFindings.map(taskBlock).join('\n')}` : '# ✅ CRITICAL / HIGH は検出されませんでした\n'}

${otherFindings.length > 0 ? `# 📋 通常対応 (MEDIUM / LOW)\n${otherFindings.map(taskBlock).join('\n')}` : ''}

${acceptedFindings.length > 0 ? `# 📝 受容済み (Accept-list、score 計算対象外)

以下は \`.security-check-acceptlist.json\` で **設計判断として受容** している事項です。修正不要ですが、定期的な見直し対象として記録します。

${acceptedFindings.map((f, i) => `## A-${String(i + 1).padStart(2, '0')}: ${f.title}

**Severity (元)**: ${f.severity}
**Category**: ${f.category}
${f.file ? `**File**: \`${f.file}\`${f.line ? ` (line ${f.line})` : ''}` : ''}

### 受容理由
${f.acceptReason}

### 元の問題説明
${f.description}

---`).join('\n')}` : ''}
`.trim();
}

// ─────────────────────────────────────────────
// メイン
// ─────────────────────────────────────────────

console.log('🔍 セキュリティチェック開始...\n');

checkBetaDependencies();
runPnpmAudit();
checkOpenRedirect();
checkSameSiteLax();
checkRateLimiting();
checkMfaEncryptionKey();
checkCspUnsafeInline();
checkUnsafeRawQuery();
checkSensitiveLog();
checkHardcodedSecrets();

const score = calcScore();

// 出力ディレクトリ作成
mkdirSync(OUTPUT_DIR, { recursive: true });

// HTML レポート出力
const htmlPath = path.join(OUTPUT_DIR, 'security-report.html');
writeFileSync(htmlPath, generateHtml(score), 'utf-8');

// TASKS.md 出力
const tasksPath = path.join(OUTPUT_DIR, 'SECURITY-TASKS.md');
writeFileSync(tasksPath, generateTasks(score), 'utf-8');

// コンソールサマリー
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  総合スコア: ${score}/100`);
console.log(`  CRITICAL : ${findings.filter(f=>f.severity==='CRITICAL').length}`);
console.log(`  HIGH     : ${findings.filter(f=>f.severity==='HIGH').length}`);
console.log(`  MEDIUM   : ${findings.filter(f=>f.severity==='MEDIUM').length}`);
console.log(`  LOW      : ${findings.filter(f=>f.severity==='LOW').length}`);
console.log(`  ACCEPTED : ${acceptedFindings.length}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`\n📄 レポート    : docs/security/security-report.html`);
console.log(`📋 タスクシート: docs/security/SECURITY-TASKS.md`);

// PR #198: Deploy ゲート用の最小スコア閾値チェック
//   `tsx scripts/security-check.ts --min-score=90` で CI から呼び出すと
//   score < 閾値 のとき exit 1。CI / pre-deploy gate で利用する。
//   閾値未指定 (引数なし) のときは従来通り exit 0 (レポート生成のみ)。
const minScoreArg = process.argv.find((a) => a.startsWith('--min-score='));
if (minScoreArg) {
  const threshold = Number(minScoreArg.split('=')[1]);
  if (Number.isFinite(threshold)) {
    if (score < threshold) {
      console.error(
        `\n❌ セキュリティスコア ${score}/100 が閾値 ${threshold} を下回っています。デプロイをブロックします。`,
      );
      console.error(
        '   docs/security/SECURITY-TASKS.md の優先対応項目を解消してから再実行してください。',
      );
      process.exit(1);
    }
    console.log(`\n✅ セキュリティスコア ${score}/100 ≥ 閾値 ${threshold} — デプロイゲート通過`);
  }
}

console.log('\n✅ セキュリティチェック完了\n');
