import { describe, it, expect } from 'vitest';
import { stripComments, countBannedPatterns } from './check-banned-i18n-patterns';

describe('countBannedPatterns', () => {
  describe('throwError パターン', () => {
    it('throw new Error with JP literal → count 1', () => {
      const src = `throw new Error('テナントが見つかりません')`;
      expect(countBannedPatterns(src)).toEqual({ throwError: 1, legacyToast: 0 });
    });

    it('throw new Error with template literal JP → count 1', () => {
      const src = 'throw new Error(`IMPORT_VALIDATION_ERROR:ID "${row.id}" が見つかりません`)';
      expect(countBannedPatterns(src)).toEqual({ throwError: 1, legacyToast: 0 });
    });

    it('throw new AppError with JP key → not counted', () => {
      const src = `throw new AppError('TENANT_NOT_FOUND', { tenantId })`;
      expect(countBannedPatterns(src)).toEqual({ throwError: 0, legacyToast: 0 });
    });

    it('throw new Error without JP → not counted', () => {
      const src = `throw new Error('validation failed')`;
      expect(countBannedPatterns(src)).toEqual({ throwError: 0, legacyToast: 0 });
    });

    it('multiple violations on different lines → counted per line', () => {
      const src = [
        `throw new Error('エラー1')`,
        `throw new Error('エラー2')`,
        `throw new AppError('SOME_CODE')`,
      ].join('\n');
      expect(countBannedPatterns(src)).toEqual({ throwError: 2, legacyToast: 0 });
    });
  });

  describe('legacyToast パターン', () => {
    it('showError with JP literal → count 1', () => {
      const src = `showError('プロジェクトの作成に失敗しました')`;
      expect(countBannedPatterns(src)).toEqual({ throwError: 0, legacyToast: 1 });
    });

    it('showSuccess with JP literal → count 1', () => {
      const src = `showSuccess('保存しました')`;
      expect(countBannedPatterns(src)).toEqual({ throwError: 0, legacyToast: 1 });
    });

    it('showErrorKey → not counted (correct variant)', () => {
      const src = `showErrorKey('project.toastCreateFailed')`;
      expect(countBannedPatterns(src)).toEqual({ throwError: 0, legacyToast: 0 });
    });

    it('showSuccessKey → not counted (correct variant)', () => {
      const src = `showSuccessKey('project.toastCreateSuccess')`;
      expect(countBannedPatterns(src)).toEqual({ throwError: 0, legacyToast: 0 });
    });

    it('showErrorKey with JP key string → not counted', () => {
      // key strings are never JP, but even if they were, Key variant is exempt
      const src = `showErrorKey('project.fail') // 失敗時に呼ぶ`;
      // comment is stripped, so JP vanishes → not counted
      expect(countBannedPatterns(src)).toEqual({ throwError: 0, legacyToast: 0 });
    });
  });

  describe('コメント除外', () => {
    it('// コメント内の JP は無視', () => {
      const stripped = stripComments(`// throw new Error('エラー')`);
      expect(countBannedPatterns(stripped)).toEqual({ throwError: 0, legacyToast: 0 });
    });

    it('/* */ コメント内の JP は無視', () => {
      const stripped = stripComments(`/* showError('保存失敗') */`);
      expect(countBannedPatterns(stripped)).toEqual({ throwError: 0, legacyToast: 0 });
    });

    it('コード + コメントが混在する行: コードの JP のみカウント', () => {
      const stripped = stripComments(`throw new Error('エラー') // 正常パス以外`);
      expect(countBannedPatterns(stripped)).toEqual({ throwError: 1, legacyToast: 0 });
    });
  });

  describe('JP なし行は無視', () => {
    it('英語エラーは対象外', () => {
      const src = `throw new Error('not found');\nshowError('save failed')`;
      expect(countBannedPatterns(src)).toEqual({ throwError: 0, legacyToast: 0 });
    });

    it('空行・空文字は対象外', () => {
      expect(countBannedPatterns('')).toEqual({ throwError: 0, legacyToast: 0 });
    });
  });
});
