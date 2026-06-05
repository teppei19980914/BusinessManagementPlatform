import { describe, it, expect } from 'vitest';
import {
  resolveVisibility,
  resolveProjectStatus,
  resolveDevMethod,
  resolveContractType,
  resolveImpact,
  resolveLikelihood,
  resolveRiskNature,
  resolveKnowledgeType,
} from './value-mapping';

describe('value-mapping (ADR-0034 選択項目の値マッピング)', () => {
  describe('resolveVisibility — 不正値は draft (誤データは全て下書き)', () => {
    it('表示ラベルを内部値に', () => {
      expect(resolveVisibility('下書き')).toBe('draft');
      expect(resolveVisibility('公開')).toBe('public');
    });
    it('内部値もそのまま受け付ける', () => {
      expect(resolveVisibility('draft')).toBe('draft');
      expect(resolveVisibility('public')).toBe('public');
      expect(resolveVisibility('PUBLIC')).toBe('public'); // 大文字小文字無視
      expect(resolveVisibility('  公開 ')).toBe('public'); // 前後空白無視
    });
    it('不正値・空欄・null は draft', () => {
      expect(resolveVisibility('なにか')).toBe('draft');
      expect(resolveVisibility('')).toBe('draft');
      expect(resolveVisibility(null)).toBe('draft');
      expect(resolveVisibility(undefined)).toBe('draft');
    });
  });

  describe('resolveProjectStatus — 不正値は planning', () => {
    it('表示ラベル/内部値', () => {
      expect(resolveProjectStatus('企画中')).toBe('planning');
      expect(resolveProjectStatus('クローズ')).toBe('closed');
      expect(resolveProjectStatus('executing')).toBe('executing');
    });
    it('不正値・空欄は planning', () => {
      expect(resolveProjectStatus('進行中(旧)')).toBe('planning');
      expect(resolveProjectStatus('')).toBe('planning');
    });
  });

  describe('resolveDevMethod — 必須・不正値は other', () => {
    it('表示ラベル/内部値', () => {
      expect(resolveDevMethod('スクラッチ開発')).toBe('scratch');
      expect(resolveDevMethod('ローコード/ノーコード開発')).toBe('low_code_no_code');
      expect(resolveDevMethod('package')).toBe('package');
    });
    it('不正値・空欄は other', () => {
      expect(resolveDevMethod('アジャイル')).toBe('other');
      expect(resolveDevMethod('')).toBe('other');
    });
  });

  describe('resolveContractType — 任意・不正値は null', () => {
    it('表示ラベル/内部値', () => {
      expect(resolveContractType('準委任')).toBe('quasi_mandate');
      expect(resolveContractType('請負')).toBe('lump_sum');
      expect(resolveContractType('SES')).toBe('ses');
      expect(resolveContractType('ses')).toBe('ses');
    });
    it('不正値・空欄は null (未設定)', () => {
      expect(resolveContractType('業務委託')).toBeNull();
      expect(resolveContractType('')).toBeNull();
      expect(resolveContractType(null)).toBeNull();
    });
  });

  describe('resolveImpact / resolveLikelihood', () => {
    it('impact は不正値で medium', () => {
      expect(resolveImpact('高')).toBe('high');
      expect(resolveImpact('low')).toBe('low');
      expect(resolveImpact('なし')).toBe('medium');
      expect(resolveImpact('')).toBe('medium');
    });
    it('likelihood は任意で不正値は null', () => {
      expect(resolveLikelihood('中')).toBe('medium');
      expect(resolveLikelihood('')).toBeNull();
      expect(resolveLikelihood('不明')).toBeNull();
    });
  });

  describe('resolveRiskNature — 任意・不正値は null', () => {
    it('表示ラベル/内部値', () => {
      expect(resolveRiskNature('脅威')).toBe('threat');
      expect(resolveRiskNature('好機')).toBe('opportunity');
      expect(resolveRiskNature('opportunity')).toBe('opportunity');
    });
    it('空欄・不正値は null', () => {
      expect(resolveRiskNature('')).toBeNull();
      expect(resolveRiskNature('リスク')).toBeNull();
    });
  });

  describe('resolveKnowledgeType — 不正値は other', () => {
    it('表示ラベル/内部値', () => {
      expect(resolveKnowledgeType('調査')).toBe('research');
      expect(resolveKnowledgeType('障害対応')).toBe('incident');
      expect(resolveKnowledgeType('best_practice')).toBe('best_practice');
    });
    it('不正値・空欄は other', () => {
      expect(resolveKnowledgeType('メモ')).toBe('other');
      expect(resolveKnowledgeType('')).toBe('other');
    });
  });
});
