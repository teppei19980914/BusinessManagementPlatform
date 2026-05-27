/**
 * billing-feature-units.ts のユニットテスト (ADR-0019 / ADR-0022)
 *
 * 本テストは 4 階層分類 (LLM_BILLABLE / EMBEDDING_BILLABLE / STORAGE_OVERAGE / EMBEDDING_BACKFILL) の
 * 構成を **明示的に固定** する役割を持つ。将来「課金対象が変わったつもりはなかったのに変わっていた」
 * 事故を防ぐため、各 featureUnit の判定を 1 件ずつ確認する。
 *
 * 重要 invariant:
 *   - BILLABLE_FEATURE_UNITS = LLM + EMBEDDING + STORAGE_OVERAGE の union
 *   - EMBEDDING_BACKFILL は BILLABLE_FEATURE_UNITS に含まれない (= 明示 free)
 *   - 4 つの判定関数は同一 featureUnit に対して同時に true を返さない (= 排他関係)
 */
import { describe, expect, it } from 'vitest';
import {
  BILLABLE_FEATURE_UNITS,
  EMBEDDING_BACKFILL_FEATURE_UNITS,
  EMBEDDING_BILLABLE_FEATURE_UNITS,
  LLM_BILLABLE_FEATURE_UNITS,
  STORAGE_OVERAGE_FEATURE_UNITS,
  isBillableFeatureUnit,
  isEmbeddingBackfillFeatureUnit,
  isEmbeddingBillableFeatureUnit,
  isLlmBillableFeatureUnit,
  isStorageOverageFeatureUnit,
} from './billing-feature-units';

describe('LLM_BILLABLE_FEATURE_UNITS', () => {
  it('LLM 系課金対象 featureUnit が ADR-0019 の決定通り 3 件存在する', () => {
    expect(LLM_BILLABLE_FEATURE_UNITS).toEqual([
      'project-upsert',
      'suggestion-explanation',
      'auto-tag-extract',
    ]);
  });
});

describe('EMBEDDING_BILLABLE_FEATURE_UNITS', () => {
  it('Embedding 系課金対象 featureUnit が ADR-0022 の決定通り 7 件存在する', () => {
    expect(EMBEDDING_BILLABLE_FEATURE_UNITS).toEqual([
      'knowledge-embedding',
      'risk-issue-embedding',
      'retrospective-embedding',
      'memo-embedding',
      'chat-semantic-search',
      'external-import-embedding',
      'attachment-embedding',
    ]);
  });
});

describe('STORAGE_OVERAGE_FEATURE_UNITS', () => {
  it('Storage 超過課金 featureUnit が ADR-0020/0021 の決定通り 2 件存在する', () => {
    expect(STORAGE_OVERAGE_FEATURE_UNITS).toEqual([
      'db-capacity-overage',
      'storage-file-overage',
    ]);
  });
});

describe('EMBEDDING_BACKFILL_FEATURE_UNITS', () => {
  it('Embedding backfill (明示 free) featureUnit が ADR-0022 の決定通り 5 件存在する', () => {
    expect(EMBEDDING_BACKFILL_FEATURE_UNITS).toEqual([
      'project-embedding-backfill',
      'knowledge-embedding-backfill',
      'risk-issue-embedding-backfill',
      'retrospective-embedding-backfill',
      'memo-embedding-backfill',
    ]);
  });
});

describe('BILLABLE_FEATURE_UNITS (= LLM + EMBEDDING + STORAGE_OVERAGE の union)', () => {
  it('合計 12 件 (= 3 + 7 + 2) の課金対象 featureUnit が存在する', () => {
    expect(BILLABLE_FEATURE_UNITS.length).toBe(12);
    expect(BILLABLE_FEATURE_UNITS).toEqual([
      ...LLM_BILLABLE_FEATURE_UNITS,
      ...EMBEDDING_BILLABLE_FEATURE_UNITS,
      ...STORAGE_OVERAGE_FEATURE_UNITS,
    ]);
  });

  it('★invariant★ EMBEDDING_BACKFILL は BILLABLE に含まれない (= 明示 free 保護)', () => {
    for (const fu of EMBEDDING_BACKFILL_FEATURE_UNITS) {
      expect(BILLABLE_FEATURE_UNITS).not.toContain(fu);
    }
  });
});

describe('isLlmBillableFeatureUnit', () => {
  it('LLM 系課金対象は全て true', () => {
    expect(isLlmBillableFeatureUnit('project-upsert')).toBe(true);
    expect(isLlmBillableFeatureUnit('suggestion-explanation')).toBe(true);
    expect(isLlmBillableFeatureUnit('auto-tag-extract')).toBe(true);
  });

  it('Embedding 系は false (= Embedding は別カテゴリ)', () => {
    for (const fu of EMBEDDING_BILLABLE_FEATURE_UNITS) {
      expect(isLlmBillableFeatureUnit(fu)).toBe(false);
    }
  });

  it('Storage 系は false', () => {
    expect(isLlmBillableFeatureUnit('db-capacity-overage')).toBe(false);
    expect(isLlmBillableFeatureUnit('storage-file-overage')).toBe(false);
  });

  it('Backfill 系は false', () => {
    for (const fu of EMBEDDING_BACKFILL_FEATURE_UNITS) {
      expect(isLlmBillableFeatureUnit(fu)).toBe(false);
    }
  });

  it('未知の値は false', () => {
    expect(isLlmBillableFeatureUnit('unknown')).toBe(false);
    expect(isLlmBillableFeatureUnit('')).toBe(false);
  });
});

describe('isEmbeddingBillableFeatureUnit (= ADR-0022 で新設)', () => {
  it('Embedding 系課金対象 7 種は全て true', () => {
    expect(isEmbeddingBillableFeatureUnit('knowledge-embedding')).toBe(true);
    expect(isEmbeddingBillableFeatureUnit('risk-issue-embedding')).toBe(true);
    expect(isEmbeddingBillableFeatureUnit('retrospective-embedding')).toBe(true);
    expect(isEmbeddingBillableFeatureUnit('memo-embedding')).toBe(true);
    expect(isEmbeddingBillableFeatureUnit('chat-semantic-search')).toBe(true);
    expect(isEmbeddingBillableFeatureUnit('external-import-embedding')).toBe(true);
    expect(isEmbeddingBillableFeatureUnit('attachment-embedding')).toBe(true);
  });

  it('LLM 系は false', () => {
    expect(isEmbeddingBillableFeatureUnit('project-upsert')).toBe(false);
    expect(isEmbeddingBillableFeatureUnit('suggestion-explanation')).toBe(false);
    expect(isEmbeddingBillableFeatureUnit('auto-tag-extract')).toBe(false);
  });

  it('★重要★ Backfill 系は false (= ユーザ非起動の自動リカバリ、不当請求リスク回避)', () => {
    expect(isEmbeddingBillableFeatureUnit('knowledge-embedding-backfill')).toBe(false);
    expect(isEmbeddingBillableFeatureUnit('risk-issue-embedding-backfill')).toBe(false);
    expect(isEmbeddingBillableFeatureUnit('retrospective-embedding-backfill')).toBe(false);
    expect(isEmbeddingBillableFeatureUnit('memo-embedding-backfill')).toBe(false);
    expect(isEmbeddingBillableFeatureUnit('project-embedding-backfill')).toBe(false);
  });

  it('Storage 系は false', () => {
    expect(isEmbeddingBillableFeatureUnit('db-capacity-overage')).toBe(false);
    expect(isEmbeddingBillableFeatureUnit('storage-file-overage')).toBe(false);
  });

  it('未知の値は false', () => {
    expect(isEmbeddingBillableFeatureUnit('unknown')).toBe(false);
    expect(isEmbeddingBillableFeatureUnit('')).toBe(false);
    expect(isEmbeddingBillableFeatureUnit('test')).toBe(false);
  });
});

describe('isStorageOverageFeatureUnit', () => {
  it('Storage 系は true', () => {
    expect(isStorageOverageFeatureUnit('db-capacity-overage')).toBe(true);
    expect(isStorageOverageFeatureUnit('storage-file-overage')).toBe(true);
  });

  it('それ以外は false', () => {
    expect(isStorageOverageFeatureUnit('project-upsert')).toBe(false);
    expect(isStorageOverageFeatureUnit('knowledge-embedding')).toBe(false);
    expect(isStorageOverageFeatureUnit('project-embedding-backfill')).toBe(false);
  });
});

describe('isEmbeddingBackfillFeatureUnit (= ADR-0022 で新設、明示 free 判定)', () => {
  it('Backfill 5 種は全て true', () => {
    expect(isEmbeddingBackfillFeatureUnit('project-embedding-backfill')).toBe(true);
    expect(isEmbeddingBackfillFeatureUnit('knowledge-embedding-backfill')).toBe(true);
    expect(isEmbeddingBackfillFeatureUnit('risk-issue-embedding-backfill')).toBe(true);
    expect(isEmbeddingBackfillFeatureUnit('retrospective-embedding-backfill')).toBe(true);
    expect(isEmbeddingBackfillFeatureUnit('memo-embedding-backfill')).toBe(true);
  });

  it('Embedding 系課金対象は false (= ユーザ起動 vs cron 自動の区別)', () => {
    for (const fu of EMBEDDING_BILLABLE_FEATURE_UNITS) {
      expect(isEmbeddingBackfillFeatureUnit(fu)).toBe(false);
    }
  });

  it('LLM / Storage / 未知は false', () => {
    expect(isEmbeddingBackfillFeatureUnit('project-upsert')).toBe(false);
    expect(isEmbeddingBackfillFeatureUnit('db-capacity-overage')).toBe(false);
    expect(isEmbeddingBackfillFeatureUnit('unknown')).toBe(false);
  });
});

describe('isBillableFeatureUnit (= 後方互換、union 判定)', () => {
  describe('課金対象 (billable)', () => {
    it('LLM 系 3 種は true', () => {
      expect(isBillableFeatureUnit('project-upsert')).toBe(true);
      expect(isBillableFeatureUnit('suggestion-explanation')).toBe(true);
      expect(isBillableFeatureUnit('auto-tag-extract')).toBe(true);
    });

    it('Embedding 系 7 種は true (ADR-0022)', () => {
      for (const fu of EMBEDDING_BILLABLE_FEATURE_UNITS) {
        expect(isBillableFeatureUnit(fu)).toBe(true);
      }
    });

    it('Storage 系 2 種は true', () => {
      expect(isBillableFeatureUnit('db-capacity-overage')).toBe(true);
      expect(isBillableFeatureUnit('storage-file-overage')).toBe(true);
    });
  });

  describe('無料 (free)', () => {
    it('★重要★ Backfill 系 5 種は false (= 明示 free 維持、不当請求リスク回避)', () => {
      for (const fu of EMBEDDING_BACKFILL_FEATURE_UNITS) {
        expect(isBillableFeatureUnit(fu)).toBe(false);
      }
    });

    it('未知の値は安全側で free', () => {
      expect(isBillableFeatureUnit('unknown-feature')).toBe(false);
      expect(isBillableFeatureUnit('')).toBe(false);
      expect(isBillableFeatureUnit('test')).toBe(false);
      expect(isBillableFeatureUnit('test-batch')).toBe(false);
    });
  });
});

describe('★invariant★ 4 つの判定関数の排他関係', () => {
  // 同一 featureUnit に対して、4 つの判定関数のうち高々 1 つだけが true を返すべき。
  // この invariant が崩れると「LLM 単価と Embedding 単価が二重課金される」等の重大事故が発生。
  const ALL_KNOWN_FEATURE_UNITS = [
    ...LLM_BILLABLE_FEATURE_UNITS,
    ...EMBEDDING_BILLABLE_FEATURE_UNITS,
    ...STORAGE_OVERAGE_FEATURE_UNITS,
    ...EMBEDDING_BACKFILL_FEATURE_UNITS,
  ];

  it('全 known featureUnit に対し、4 判定関数の true 数は厳密に 1', () => {
    for (const fu of ALL_KNOWN_FEATURE_UNITS) {
      const flags = [
        isLlmBillableFeatureUnit(fu),
        isEmbeddingBillableFeatureUnit(fu),
        isStorageOverageFeatureUnit(fu),
        isEmbeddingBackfillFeatureUnit(fu),
      ];
      const trueCount = flags.filter((f) => f).length;
      expect(trueCount, `featureUnit '${fu}' should match exactly 1 category`).toBe(1);
    }
  });

  it('未知 featureUnit に対し、4 判定関数すべて false', () => {
    const unknowns = ['', 'unknown', 'test', 'test-batch', 'project-embedding'];
    for (const fu of unknowns) {
      expect(isLlmBillableFeatureUnit(fu)).toBe(false);
      expect(isEmbeddingBillableFeatureUnit(fu)).toBe(false);
      expect(isStorageOverageFeatureUnit(fu)).toBe(false);
      expect(isEmbeddingBackfillFeatureUnit(fu)).toBe(false);
    }
  });
});

describe('型ガード (TypeScript narrowing)', () => {
  it('isLlmBillableFeatureUnit が true なら LlmBillableFeatureUnit 型に narrow', () => {
    const fu: string = 'project-upsert';
    if (isLlmBillableFeatureUnit(fu)) {
      const _check: 'project-upsert' | 'suggestion-explanation' | 'auto-tag-extract' = fu;
      expect(_check).toBe('project-upsert');
    } else {
      throw new Error('expected LLM billable');
    }
  });

  it('isEmbeddingBillableFeatureUnit が true なら EmbeddingBillableFeatureUnit 型に narrow', () => {
    const fu: string = 'knowledge-embedding';
    if (isEmbeddingBillableFeatureUnit(fu)) {
      const _check:
        | 'knowledge-embedding'
        | 'risk-issue-embedding'
        | 'retrospective-embedding'
        | 'memo-embedding'
        | 'chat-semantic-search'
        | 'external-import-embedding'
        | 'attachment-embedding' = fu;
      expect(_check).toBe('knowledge-embedding');
    } else {
      throw new Error('expected Embedding billable');
    }
  });
});
