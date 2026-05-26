/**
 * file-storage-pricing.ts の単体テスト (ADR-0021)
 *
 * 重要: 誤請求は severity-1 リスクのため、境界値・端数処理を網羅的に検証する。
 * Memory: feedback_billing_invariant.md (ApiCallLog SUM = 請求金額 invariant)
 *
 * テスト範囲:
 *   - 単位定数 (SI)
 *   - 課金計算 (calculateFileStorageBillableBytes / calculateFileStorageOverageJpy)
 *   - Stripe Meter quantity (R6 案 A invariant)
 *   - 4 層防御判定 (classifyFileStorageLevel)
 *   - セキュリティヘルパ (sanitizeFileName / isDangerousExtension)
 *   - Embedding 判定 (isEmbeddingSupported / detectFileScopeQuery)
 *   - Storage Object Key 生成 (buildStorageObjectKey)
 *   - 請求 invariant (overageJpy → stripeQuantity)
 */

import { describe, it, expect } from 'vitest';
import {
  SI_MB_BYTES,
  SI_GB_BYTES,
  FILE_STORAGE_FREE_TIER_BYTES,
  FILE_STORAGE_PRICE_JPY_PER_GB_TIER,
  FILE_STORAGE_MAX_FILE_SIZE_BYTES,
  FILE_STORAGE_L1_USER_WARNING_BYTES,
  FILE_STORAGE_L2_ADMIN_ALERT_BYTES,
  FILE_STORAGE_L3_HARD_CAP_BYTES,
  DANGEROUS_FILE_EXTENSIONS,
  EMBEDDING_SUPPORTED_EXTENSIONS,
  PRESIGNED_URL_TTL_SECONDS,
  PRESIGNED_URL_RATE_LIMIT_PER_MIN,
  DELETE_API_RATE_LIMIT_PER_MIN,
  MAX_FILE_NAME_LENGTH,
  MAX_CONCURRENT_EMBEDDING_PER_TENANT,
  MAX_GLOBAL_EMBEDDING_CONCURRENT,
  EMBEDDING_MAX_RETRY,
  FILE_SCOPE_KEYWORDS,
  calculateFileStorageBillableBytes,
  calculateFileStorageOverageJpy,
  calculateFileStorageStripeQuantity,
  classifyFileStorageLevel,
  sanitizeFileName,
  getFileExtension,
  isDangerousExtension,
  isEmbeddingSupported,
  detectFileScopeQuery,
  buildStorageObjectKey,
} from './file-storage-pricing';

describe('SI 単位定数 (DB 容量と整合)', () => {
  it('1MB = 10^6 bytes (SI)', () => {
    expect(SI_MB_BYTES).toBe(1_000_000);
  });

  it('1GB = 10^9 bytes (SI) = 1000MB', () => {
    expect(SI_GB_BYTES).toBe(1_000_000_000);
    expect(SI_GB_BYTES).toBe(1000 * SI_MB_BYTES);
  });
});

describe('課金パラメータ (ADR-0021 §1.1)', () => {
  it('無料枠 = 100MB SI = 100,000,000 bytes', () => {
    expect(FILE_STORAGE_FREE_TIER_BYTES).toBe(100_000_000);
  });

  it('課金単価 = 1GB tier あたり ¥10', () => {
    expect(FILE_STORAGE_PRICE_JPY_PER_GB_TIER).toBe(10);
  });

  it('1 ファイル上限 = 50MB SI = 50,000,000 bytes', () => {
    expect(FILE_STORAGE_MAX_FILE_SIZE_BYTES).toBe(50_000_000);
  });

  it('L1 = 1GB', () => {
    expect(FILE_STORAGE_L1_USER_WARNING_BYTES).toBe(1_000_000_000);
  });

  it('L2 = 10GB', () => {
    expect(FILE_STORAGE_L2_ADMIN_ALERT_BYTES).toBe(10_000_000_000);
  });

  it('L3 = 50GB (ハードキャップ)', () => {
    expect(FILE_STORAGE_L3_HARD_CAP_BYTES).toBe(50_000_000_000);
  });
});

describe('calculateFileStorageBillableBytes', () => {
  it('0 byte → 0', () => {
    expect(calculateFileStorageBillableBytes(BigInt(0))).toBe(BigInt(0));
  });

  it('無料枠ちょうど (100MB) → 0', () => {
    expect(calculateFileStorageBillableBytes(BigInt(100 * SI_MB_BYTES))).toBe(BigInt(0));
  });

  it('無料枠未満 (99MB) → 0', () => {
    expect(calculateFileStorageBillableBytes(BigInt(99 * SI_MB_BYTES))).toBe(BigInt(0));
  });

  it('無料枠 + 1 byte (100MB + 1) → 1', () => {
    expect(calculateFileStorageBillableBytes(BigInt(100 * SI_MB_BYTES + 1))).toBe(BigInt(1));
  });

  it('101MB → 1MB 分 (1,000,000 bytes)', () => {
    expect(calculateFileStorageBillableBytes(BigInt(101 * SI_MB_BYTES))).toBe(BigInt(1 * SI_MB_BYTES));
  });

  it('1GB (= 1,000,000,000 bytes) → 900MB 分', () => {
    expect(calculateFileStorageBillableBytes(BigInt(SI_GB_BYTES))).toBe(BigInt(900 * SI_MB_BYTES));
  });
});

describe('calculateFileStorageOverageJpy — ADR-0021 §1.2 階段関数型料金 (¥10/GB tier)', () => {
  describe('無料枠 (0 ~ 100MB) は ¥0', () => {
    it('0 byte → ¥0', () => {
      expect(calculateFileStorageOverageJpy(BigInt(0))).toBe(0);
    });

    it('50MB → ¥0', () => {
      expect(calculateFileStorageOverageJpy(BigInt(50 * SI_MB_BYTES))).toBe(0);
    });

    it('100MB ちょうど → ¥0', () => {
      expect(calculateFileStorageOverageJpy(BigInt(100 * SI_MB_BYTES))).toBe(0);
    });
  });

  describe('Tier 1 (101MB ~ 1,100MB) = ¥10', () => {
    it('100MB + 1 byte → ¥10 (= 1 tier)', () => {
      expect(calculateFileStorageOverageJpy(BigInt(100 * SI_MB_BYTES + 1))).toBe(10);
    });

    it('101MB → ¥10', () => {
      expect(calculateFileStorageOverageJpy(BigInt(101 * SI_MB_BYTES))).toBe(10);
    });

    it('500MB → ¥10', () => {
      expect(calculateFileStorageOverageJpy(BigInt(500 * SI_MB_BYTES))).toBe(10);
    });

    it('1,100MB (tier 1 上限) → ¥10', () => {
      expect(calculateFileStorageOverageJpy(BigInt(1100 * SI_MB_BYTES))).toBe(10);
    });
  });

  describe('Tier 2 (1,101MB ~ 2,100MB) = ¥20', () => {
    it('1,100MB + 1 byte → ¥20', () => {
      expect(calculateFileStorageOverageJpy(BigInt(1100 * SI_MB_BYTES + 1))).toBe(20);
    });

    it('1,101MB → ¥20', () => {
      expect(calculateFileStorageOverageJpy(BigInt(1101 * SI_MB_BYTES))).toBe(20);
    });

    it('2,100MB (tier 2 上限) → ¥20', () => {
      expect(calculateFileStorageOverageJpy(BigInt(2100 * SI_MB_BYTES))).toBe(20);
    });
  });

  describe('Tier 3+ 連続性', () => {
    it('2,101MB → ¥30 (tier 3)', () => {
      expect(calculateFileStorageOverageJpy(BigInt(2101 * SI_MB_BYTES))).toBe(30);
    });

    it('10,100MB (= 10.1GB) → ¥100 (tier 10)', () => {
      expect(calculateFileStorageOverageJpy(BigInt(10100 * SI_MB_BYTES))).toBe(100);
    });

    it('50GB SI (ハードキャップ) → ¥500 (tier 50)', () => {
      // 50GB - 100MB = 49,900 MB billable → ceil(49900/1000) = 50 tier → ¥500
      expect(calculateFileStorageOverageJpy(BigInt(50 * SI_GB_BYTES))).toBe(500);
    });
  });

  describe('端数処理 (1MB 未満は繰上)', () => {
    it('100MB + 1 byte (= 100.000001MB) → 1MB billable → tier 1 = ¥10', () => {
      expect(calculateFileStorageOverageJpy(BigInt(100 * SI_MB_BYTES + 1))).toBe(10);
    });

    it('100.5MB (= 100,500,000 bytes) → ceil(0.5MB) = 1MB → tier 1 = ¥10', () => {
      expect(calculateFileStorageOverageJpy(BigInt(100_500_000))).toBe(10);
    });

    it('1,100MB + 500,000 bytes (= 1,100.5MB) → ceil(0.5MB) = 1MB → tier 2 開始 = ¥20', () => {
      expect(calculateFileStorageOverageJpy(BigInt(1100 * SI_MB_BYTES + 500_000))).toBe(20);
    });
  });
});

describe('calculateFileStorageStripeQuantity — R6 案 A: quantity = costJpy 整数', () => {
  it('costJpy=10 → quantity=10', () => {
    expect(calculateFileStorageStripeQuantity(10)).toBe(10);
  });

  it('costJpy=0 → quantity=0', () => {
    expect(calculateFileStorageStripeQuantity(0)).toBe(0);
  });

  it('負数 → 0 (defensive)', () => {
    expect(calculateFileStorageStripeQuantity(-10)).toBe(0);
  });

  it('小数 → floor', () => {
    expect(calculateFileStorageStripeQuantity(10.7)).toBe(10);
  });

  it('ハードキャップ請求額 500 → quantity=500', () => {
    expect(calculateFileStorageStripeQuantity(500)).toBe(500);
  });
});

describe('classifyFileStorageLevel — 4 層防御 (= ADR-0020 と同閾値)', () => {
  it('0 byte → none', () => {
    expect(classifyFileStorageLevel(BigInt(0))).toBe('none');
  });

  it('500MB → none (L1 未満)', () => {
    expect(classifyFileStorageLevel(BigInt(500 * SI_MB_BYTES))).toBe('none');
  });

  it('1GB ちょうど → l1', () => {
    expect(classifyFileStorageLevel(BigInt(FILE_STORAGE_L1_USER_WARNING_BYTES))).toBe('l1');
  });

  it('5GB → l1', () => {
    expect(classifyFileStorageLevel(BigInt(5 * SI_GB_BYTES))).toBe('l1');
  });

  it('10GB ちょうど → l2', () => {
    expect(classifyFileStorageLevel(BigInt(FILE_STORAGE_L2_ADMIN_ALERT_BYTES))).toBe('l2');
  });

  it('30GB → l2', () => {
    expect(classifyFileStorageLevel(BigInt(30 * SI_GB_BYTES))).toBe('l2');
  });

  it('50GB ちょうど → l3 (ハードキャップ到達)', () => {
    expect(classifyFileStorageLevel(BigInt(FILE_STORAGE_L3_HARD_CAP_BYTES))).toBe('l3');
  });

  it('60GB (over hard cap) → l3', () => {
    expect(classifyFileStorageLevel(BigInt(60 * SI_GB_BYTES))).toBe('l3');
  });
});

describe('sanitizeFileName — ADR-0021 §10.4 path traversal / OS 禁止文字防止', () => {
  it('通常のファイル名はそのまま', () => {
    expect(sanitizeFileName('document.pdf')).toBe('document.pdf');
  });

  it('日本語ファイル名はそのまま', () => {
    expect(sanitizeFileName('提案資料.xlsx')).toBe('提案資料.xlsx');
  });

  it('path traversal (..) を _ に置換', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('_/_/etc/passwd'.replace(/\//g, '_'));
  });

  it('OS 禁止文字を _ に置換', () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j.txt')).toBe('a_b_c_d_e_f_g_h_i_j.txt');
  });

  it('隠しファイル偽装 (先頭ドット) を _ に置換', () => {
    expect(sanitizeFileName('.htaccess')).toBe('_htaccess');
  });

  it('複数の連続ドット (...) は path traversal 対策で先頭 .. が _ に変換される', () => {
    // 実装順序: 1) OS禁止文字 → 2) `..` → `_` (path traversal) → 3) 先頭 `.` → `_`
    // `'...evil'` → step2 で先頭 2 文字 `..` が `_` に → `'_.evil'`
    // 先頭が `_` になったため step3 は発火しないが、path traversal リスクは消えている
    expect(sanitizeFileName('...evil')).toBe('_.evil');
  });

  it('制御文字 (\\x00-\\x1f) を _ に置換', () => {
    expect(sanitizeFileName('a\x00b\x1fc.txt')).toBe('a_b_c.txt');
  });

  it('文字数上限 (200) で切り捨て', () => {
    const longName = 'a'.repeat(300) + '.txt';
    const result = sanitizeFileName(longName);
    expect(result.length).toBe(MAX_FILE_NAME_LENGTH);
  });
});

describe('getFileExtension', () => {
  it('小文字拡張子をそのまま返す', () => {
    expect(getFileExtension('document.pdf')).toBe('.pdf');
  });

  it('大文字拡張子は小文字に変換', () => {
    expect(getFileExtension('Document.PDF')).toBe('.pdf');
  });

  it('複数ドットがあっても最後のドット以降が拡張子', () => {
    expect(getFileExtension('archive.tar.gz')).toBe('.gz');
  });

  it('拡張子なしは空文字', () => {
    expect(getFileExtension('README')).toBe('');
  });

  it('ドット終わりは空文字 (拡張子なし扱い)', () => {
    expect(getFileExtension('file.')).toBe('');
  });

  it('先頭ドットのみのファイル (.gitignore) はファイル名全体を拡張子として返す (セキュリティ意図)', () => {
    // ⚠️ 重要: lastDot === 0 で空文字を返さないのは意図的設計。
    //   理由: '.exe' というファイル名 (拡張子 .exe で実行ファイル) を確実に
    //   isDangerousExtension で検知するため。空文字に丸めると '.exe' が検知漏れする。
    //   '.gitignore' は DANGEROUS / EMBEDDING どちらにも含まれないため副作用なし。
    expect(getFileExtension('.gitignore')).toBe('.gitignore');
  });

  it('.exe という名前のファイル (拡張子 .exe) は危険検知できる', () => {
    expect(getFileExtension('.exe')).toBe('.exe');
    expect(isDangerousExtension('.exe')).toBe(true);
  });
});

describe('isDangerousExtension — ADR-0021 §10.3 危険拡張子 blacklist', () => {
  it('.exe は危険', () => {
    expect(isDangerousExtension('malware.exe')).toBe(true);
  });

  it('.sh は危険', () => {
    expect(isDangerousExtension('attack.sh')).toBe(true);
  });

  it('.bat は危険', () => {
    expect(isDangerousExtension('runme.bat')).toBe(true);
  });

  it('.ps1 (PowerShell) は危険', () => {
    expect(isDangerousExtension('hack.ps1')).toBe(true);
  });

  it('.js は危険 (XSS / 攻撃用スクリプト)', () => {
    expect(isDangerousExtension('payload.js')).toBe(true);
  });

  it('.apk (Android) は危険', () => {
    expect(isDangerousExtension('app.apk')).toBe(true);
  });

  it('.rar は危険 (zip bomb)', () => {
    expect(isDangerousExtension('archive.rar')).toBe(true);
  });

  it('大文字 .EXE も危険 (小文字化される)', () => {
    expect(isDangerousExtension('malware.EXE')).toBe(true);
  });

  it('.pdf は安全', () => {
    expect(isDangerousExtension('document.pdf')).toBe(false);
  });

  it('.xlsx は安全', () => {
    expect(isDangerousExtension('data.xlsx')).toBe(false);
  });

  it('.zip は安全 (業務利用想定で許容)', () => {
    expect(isDangerousExtension('archive.zip')).toBe(false);
  });

  it('.txt は安全', () => {
    expect(isDangerousExtension('memo.txt')).toBe(false);
  });

  it('拡張子なしは安全 (検知対象外)', () => {
    expect(isDangerousExtension('README')).toBe(false);
  });
});

describe('isEmbeddingSupported — ADR-0021 §3.1 Embedding 対象判定', () => {
  it('.pdf は対象', () => {
    expect(isEmbeddingSupported('proposal.pdf')).toBe(true);
  });

  it('.xlsx は対象', () => {
    expect(isEmbeddingSupported('budget.xlsx')).toBe(true);
  });

  it('.xls (旧形式) も対象', () => {
    expect(isEmbeddingSupported('legacy.xls')).toBe(true);
  });

  it('.csv は対象', () => {
    expect(isEmbeddingSupported('data.csv')).toBe(true);
  });

  it('.txt は対象', () => {
    expect(isEmbeddingSupported('memo.txt')).toBe(true);
  });

  it('.md は対象', () => {
    expect(isEmbeddingSupported('README.md')).toBe(true);
  });

  it('.docx は対象', () => {
    expect(isEmbeddingSupported('contract.docx')).toBe(true);
  });

  it('大文字 .PDF も対象 (小文字化される)', () => {
    expect(isEmbeddingSupported('Proposal.PDF')).toBe(true);
  });

  it('.jpg は対象外 (画像)', () => {
    expect(isEmbeddingSupported('photo.jpg')).toBe(false);
  });

  it('.png は対象外 (画像)', () => {
    expect(isEmbeddingSupported('screenshot.png')).toBe(false);
  });

  it('.mp4 は対象外 (動画)', () => {
    expect(isEmbeddingSupported('video.mp4')).toBe(false);
  });

  it('.zip は対象外 (圧縮)', () => {
    expect(isEmbeddingSupported('archive.zip')).toBe(false);
  });
});

describe('detectFileScopeQuery — ADR-0021 §9.5.3 チャット file scope 検出', () => {
  it('「ファイル」を含む → true', () => {
    expect(detectFileScopeQuery('提案資料のファイルを探して')).toBe(true);
  });

  it('「添付」を含む → true', () => {
    expect(detectFileScopeQuery('プロジェクトAの添付を確認したい')).toBe(true);
  });

  it('「添付ファイル」を含む → true', () => {
    expect(detectFileScopeQuery('過去の添付ファイルから探して')).toBe(true);
  });

  it('「PDF」を含む → true', () => {
    expect(detectFileScopeQuery('PDF資料を確認')).toBe(true);
  });

  it('小文字 「pdf」 を含む → true (小文字化される)', () => {
    expect(detectFileScopeQuery('pdfで探して')).toBe(true);
  });

  it('英語 「file」 を含む → true', () => {
    expect(detectFileScopeQuery('find me a file about X')).toBe(true);
  });

  it('英語 「attachment」 を含む → true', () => {
    expect(detectFileScopeQuery('show attachments from project A')).toBe(true);
  });

  it('「Excel」 を含む → true', () => {
    expect(detectFileScopeQuery('Excelの予算表を探して')).toBe(true);
  });

  it('「資料」を含む → true', () => {
    expect(detectFileScopeQuery('過去の資料を見たい')).toBe(true);
  });

  it('「文書」 を含む → true', () => {
    expect(detectFileScopeQuery('契約文書を確認')).toBe(true);
  });

  it('キーワードなし → false (通常の意味検索)', () => {
    expect(detectFileScopeQuery('プロジェクトAのリスクは何ですか')).toBe(false);
  });

  it('「ファイル」と無関係な文 → false', () => {
    expect(detectFileScopeQuery('顧客の予算と納期を教えて')).toBe(false);
  });
});

describe('buildStorageObjectKey — ADR-0021 §10.5 テナント越境物理防止', () => {
  it('正常系: tenants/{tenantId}/{entityType}/{entityId}/{uuid}-{fileName}', () => {
    const key = buildStorageObjectKey({
      tenantId: 'tenant-abc',
      entityType: 'project',
      entityId: 'proj-123',
      uuid: 'uuid-xyz',
      fileName: 'proposal.pdf',
    });
    expect(key).toBe('tenants/tenant-abc/project/proj-123/uuid-xyz-proposal.pdf');
  });

  it('日本語ファイル名は sanitize 後に key へ', () => {
    const key = buildStorageObjectKey({
      tenantId: 't1',
      entityType: 'knowledge',
      entityId: 'k1',
      uuid: 'u1',
      fileName: '提案書.pdf',
    });
    expect(key).toBe('tenants/t1/knowledge/k1/u1-提案書.pdf');
  });

  it('path traversal を含むファイル名は sanitize される (= 物理的に越境不能)', () => {
    const key = buildStorageObjectKey({
      tenantId: 't1',
      entityType: 'project',
      entityId: 'p1',
      uuid: 'u1',
      fileName: '../../../etc/passwd',
    });
    // .. → _, / → _ で sanitize
    expect(key).not.toContain('..');
    expect(key).toMatch(/^tenants\/t1\/project\/p1\/u1-/);
  });

  it('tenant prefix は常に先頭 (RLS Policy 整合)', () => {
    const key = buildStorageObjectKey({
      tenantId: 'evil-tenant',
      entityType: 'project',
      entityId: 'p1',
      uuid: 'u1',
      fileName: 'doc.pdf',
    });
    expect(key.startsWith('tenants/evil-tenant/')).toBe(true);
  });
});

describe('セキュリティ定数 (ADR-0021 §10)', () => {
  it('Pre-signed URL TTL は 60 秒 (漏洩時被害最小化)', () => {
    expect(PRESIGNED_URL_TTL_SECONDS).toBe(60);
  });

  it('Pre-signed URL 発行レート制限 = 10/min/tenant', () => {
    expect(PRESIGNED_URL_RATE_LIMIT_PER_MIN).toBe(10);
  });

  it('delete API レート制限 = 100/min/tenant', () => {
    expect(DELETE_API_RATE_LIMIT_PER_MIN).toBe(100);
  });

  it('ファイル名長さ上限 = 200', () => {
    expect(MAX_FILE_NAME_LENGTH).toBe(200);
  });

  it('per-tenant 同時 embedding job 上限 = 5', () => {
    expect(MAX_CONCURRENT_EMBEDDING_PER_TENANT).toBe(5);
  });

  it('global 同時 embedding job 上限 = 50 (Voyage rate limit 抵触防止)', () => {
    expect(MAX_GLOBAL_EMBEDDING_CONCURRENT).toBe(50);
  });

  it('embedding 失敗リトライ = 3 回', () => {
    expect(EMBEDDING_MAX_RETRY).toBe(3);
  });

  it('危険拡張子に .exe / .sh / .bat / .ps1 / .apk / .rar が含まれる', () => {
    expect(DANGEROUS_FILE_EXTENSIONS).toContain('.exe');
    expect(DANGEROUS_FILE_EXTENSIONS).toContain('.sh');
    expect(DANGEROUS_FILE_EXTENSIONS).toContain('.bat');
    expect(DANGEROUS_FILE_EXTENSIONS).toContain('.ps1');
    expect(DANGEROUS_FILE_EXTENSIONS).toContain('.apk');
    expect(DANGEROUS_FILE_EXTENSIONS).toContain('.rar');
  });

  it('Embedding 対象に .pdf / .xlsx / .csv / .txt / .md / .docx が含まれる', () => {
    expect(EMBEDDING_SUPPORTED_EXTENSIONS).toContain('.pdf');
    expect(EMBEDDING_SUPPORTED_EXTENSIONS).toContain('.xlsx');
    expect(EMBEDDING_SUPPORTED_EXTENSIONS).toContain('.csv');
    expect(EMBEDDING_SUPPORTED_EXTENSIONS).toContain('.txt');
    expect(EMBEDDING_SUPPORTED_EXTENSIONS).toContain('.md');
    expect(EMBEDDING_SUPPORTED_EXTENSIONS).toContain('.docx');
  });

  it('FILE_SCOPE_KEYWORDS に「ファイル」「添付」「PDF」「Excel」が含まれる', () => {
    expect(FILE_SCOPE_KEYWORDS).toContain('ファイル');
    expect(FILE_SCOPE_KEYWORDS).toContain('添付');
    expect(FILE_SCOPE_KEYWORDS).toContain('PDF');
    expect(FILE_SCOPE_KEYWORDS).toContain('Excel');
  });
});

describe('billing invariant — 計算経路の整合性 (feedback_billing_invariant.md)', () => {
  it('calculateFileStorageOverageJpy → calculateFileStorageStripeQuantity で値が保たれる (R6 案 A invariant)', () => {
    const peakBytes = BigInt(2345 * SI_MB_BYTES);
    const costJpy = calculateFileStorageOverageJpy(peakBytes);
    // 2345 - 100 = 2245 MB → ceil(2245/1000) = 3 tier → ¥30
    expect(costJpy).toBe(30);
    const stripeQuantity = calculateFileStorageStripeQuantity(costJpy);
    expect(stripeQuantity).toBe(30); // 完全一致 (整数のため丸めロスなし)
  });

  it('境界値 100MB ちょうどでは Stripe Meter quantity = 0 (送信不要)', () => {
    const peakBytes = BigInt(100 * SI_MB_BYTES);
    expect(calculateFileStorageOverageJpy(peakBytes)).toBe(0);
    expect(calculateFileStorageStripeQuantity(calculateFileStorageOverageJpy(peakBytes))).toBe(0);
  });

  it('ハードキャップ 50GB でも overage → stripeQuantity invariant 保持', () => {
    const peakBytes = BigInt(FILE_STORAGE_L3_HARD_CAP_BYTES);
    const costJpy = calculateFileStorageOverageJpy(peakBytes);
    expect(costJpy).toBe(500);
    expect(calculateFileStorageStripeQuantity(costJpy)).toBe(500);
  });
});
