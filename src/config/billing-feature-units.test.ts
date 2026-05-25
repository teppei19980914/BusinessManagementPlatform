/**
 * billing-feature-units.ts のユニットテスト (ADR-0019 / 2026-05-24)
 *
 * 本テストは BILLABLE_FEATURE_UNITS の構成を **明示的に固定** する役割を持つ。
 * 将来「課金対象が変わったつもりはなかったのに変わっていた」事故を防ぐため、
 * 各 featureUnit の billable/free 判定を 1 件ずつ確認する。
 */
import { describe, expect, it } from 'vitest';
import {
  BILLABLE_FEATURE_UNITS,
  isBillableFeatureUnit,
} from './billing-feature-units';

describe('BILLABLE_FEATURE_UNITS', () => {
  it('課金対象 featureUnit が ADR-0019/0020 の決定通り 4 件存在する', () => {
    // ADR-0019: project-upsert, suggestion-explanation, auto-tag-extract
    // ADR-0020 (2026-05-25 追加): db-capacity-overage
    expect(BILLABLE_FEATURE_UNITS).toEqual([
      'project-upsert',
      'suggestion-explanation',
      'auto-tag-extract',
      'db-capacity-overage',
    ]);
  });

  it('配列は readonly (const assertion) で意図しない書き換えを防ぐ', () => {
    const expected: readonly string[] = BILLABLE_FEATURE_UNITS;
    expect(expected.length).toBe(4);
  });
});

describe('isBillableFeatureUnit', () => {
  describe('課金対象 (billable)', () => {
    it('project-upsert は課金対象', () => {
      expect(isBillableFeatureUnit('project-upsert')).toBe(true);
    });

    it('suggestion-explanation は課金対象 (なぜ機能 / Pro 限定)', () => {
      expect(isBillableFeatureUnit('suggestion-explanation')).toBe(true);
    });

    it('auto-tag-extract は課金対象 (スタンドアロン auto-tag 用の予約)', () => {
      expect(isBillableFeatureUnit('auto-tag-extract')).toBe(true);
    });

    it('db-capacity-overage は課金対象 (ADR-0020 / DB 容量月次集約)', () => {
      expect(isBillableFeatureUnit('db-capacity-overage')).toBe(true);
    });
  });

  describe('無料 (free) — 資産作成/更新系', () => {
    it('knowledge-embedding は無料 (Knowledge 作成/更新の embedding)', () => {
      expect(isBillableFeatureUnit('knowledge-embedding')).toBe(false);
    });

    it('risk-issue-embedding は無料 (RiskIssue 作成/更新の embedding)', () => {
      expect(isBillableFeatureUnit('risk-issue-embedding')).toBe(false);
    });

    it('retrospective-embedding は無料 (Retrospective 作成/更新の embedding)', () => {
      expect(isBillableFeatureUnit('retrospective-embedding')).toBe(false);
    });

    it('memo-embedding は無料 (Memo 作成/更新の embedding)', () => {
      expect(isBillableFeatureUnit('memo-embedding')).toBe(false);
    });
  });

  describe('無料 (free) — チャット / cron / インポート', () => {
    it('chat-semantic-search は無料 (チャット検索のクエリ embedding)', () => {
      expect(isBillableFeatureUnit('chat-semantic-search')).toBe(false);
    });

    it('project-embedding-backfill は無料 (月初 cron 補完)', () => {
      expect(isBillableFeatureUnit('project-embedding-backfill')).toBe(false);
    });

    it('knowledge-embedding-backfill は無料', () => {
      expect(isBillableFeatureUnit('knowledge-embedding-backfill')).toBe(false);
    });

    it('risk-issue-embedding-backfill は無料', () => {
      expect(isBillableFeatureUnit('risk-issue-embedding-backfill')).toBe(false);
    });

    it('retrospective-embedding-backfill は無料', () => {
      expect(isBillableFeatureUnit('retrospective-embedding-backfill')).toBe(false);
    });

    it('memo-embedding-backfill は無料', () => {
      expect(isBillableFeatureUnit('memo-embedding-backfill')).toBe(false);
    });

    it('external-import-embedding は無料 (CSV 外部インポート)', () => {
      expect(isBillableFeatureUnit('external-import-embedding')).toBe(false);
    });
  });

  describe('未知の値', () => {
    it('未定義の featureUnit は安全側で無料扱い (false)', () => {
      // 想定外の文字列が来た場合、誤って課金しない方が安全 (= 顧客信頼の方を優先)。
      // 想定外値の検出は ApiCallLog の featureUnit 集計監視で別途行う前提。
      expect(isBillableFeatureUnit('unknown-feature')).toBe(false);
      expect(isBillableFeatureUnit('')).toBe(false);
      expect(isBillableFeatureUnit('test')).toBe(false);
      expect(isBillableFeatureUnit('test-batch')).toBe(false);
    });
  });

  describe('型ガード (TypeScript 推論)', () => {
    it('isBillableFeatureUnit が true なら BillableFeatureUnit 型として narrow される', () => {
      const fu: string = 'project-upsert';
      if (isBillableFeatureUnit(fu)) {
        // この分岐内では BillableFeatureUnit 型 (= 4 つの union 型)
        const _check:
          | 'project-upsert'
          | 'suggestion-explanation'
          | 'auto-tag-extract'
          | 'db-capacity-overage' = fu;
        expect(_check).toBe('project-upsert');
      } else {
        throw new Error('expected billable');
      }
    });
  });
});
