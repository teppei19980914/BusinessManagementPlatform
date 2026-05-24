import { describe, expect, it } from 'vitest';
import type { ChatSearchHit } from '@/services/chat-search.service';
import { buildChatHitLink } from './chat-search-link';

/**
 * チャット意味検索の hit → URL マッピング。
 * entity-link.ts (通知 deep link) と同じ canonical 規約に整合させる。
 */

function makeHit(overrides: Partial<ChatSearchHit> & Pick<ChatSearchHit, 'kind' | 'id'>): ChatSearchHit {
  return {
    title: 'dummy title',
    snippet: 'dummy snippet',
    score: 0.5,
    tier: 'medium',
    sourceProjectId: null,
    sourceProjectName: null,
    authorUserId: null,
    ...overrides,
  };
}

describe('buildChatHitLink', () => {
  describe('project', () => {
    it('専用詳細 page (/projects/{id}) に遷移する', () => {
      const hit = makeHit({ kind: 'project', id: 'proj-123' });
      expect(buildChatHitLink(hit)).toBe('/projects/proj-123');
    });
  });

  describe('knowledge', () => {
    it('全ナレッジ画面の auto-open URL を返す', () => {
      const hit = makeHit({ kind: 'knowledge', id: 'know-1' });
      expect(buildChatHitLink(hit)).toBe('/knowledge?knowledgeId=know-1');
    });
  });

  describe('risk', () => {
    it('全リスク画面の auto-open URL を返す (queryKey=riskId)', () => {
      const hit = makeHit({ kind: 'risk', id: 'risk-1' });
      expect(buildChatHitLink(hit)).toBe('/risks?riskId=risk-1');
    });
  });

  describe('issue', () => {
    it('全課題画面の auto-open URL を返す (queryKey は共通 riskId)', () => {
      const hit = makeHit({ kind: 'issue', id: 'issue-1' });
      expect(buildChatHitLink(hit)).toBe('/issues?riskId=issue-1');
    });
  });

  describe('retrospective', () => {
    it('全振り返り画面の auto-open URL を返す', () => {
      const hit = makeHit({ kind: 'retrospective', id: 'retro-1' });
      expect(buildChatHitLink(hit)).toBe('/retrospectives?retroId=retro-1');
    });
  });

  describe('memo', () => {
    it('viewerUserId と authorUserId が一致する場合は /memos (自分のメモ画面) を返す', () => {
      const hit = makeHit({ kind: 'memo', id: 'memo-1', authorUserId: 'user-A' });
      expect(buildChatHitLink(hit, { viewerUserId: 'user-A' })).toBe('/memos?memoId=memo-1');
    });

    it('viewerUserId と authorUserId が異なる場合は /all-memos (他人 public) を返す', () => {
      const hit = makeHit({ kind: 'memo', id: 'memo-1', authorUserId: 'user-B' });
      expect(buildChatHitLink(hit, { viewerUserId: 'user-A' })).toBe('/all-memos?memoId=memo-1');
    });

    it('viewerUserId 未指定 (session 未取得等) の場合は安全側で /all-memos を返す', () => {
      const hit = makeHit({ kind: 'memo', id: 'memo-1', authorUserId: 'user-A' });
      expect(buildChatHitLink(hit)).toBe('/all-memos?memoId=memo-1');
      expect(buildChatHitLink(hit, {})).toBe('/all-memos?memoId=memo-1');
      expect(buildChatHitLink(hit, { viewerUserId: null })).toBe('/all-memos?memoId=memo-1');
    });

    it('authorUserId が null の場合 (旧データ等) は /all-memos に倒す', () => {
      const hit = makeHit({ kind: 'memo', id: 'memo-1', authorUserId: null });
      expect(buildChatHitLink(hit, { viewerUserId: 'user-A' })).toBe('/all-memos?memoId=memo-1');
    });
  });

  describe('セキュリティ (defense-in-depth)', () => {
    // hit.id は通常 DB UUID で特殊文字を含まないが、将来 id source が変わった場合や
    // 万一不正な値が混入した場合に URL parse が想定外の振る舞いを起こさないよう
    // encodeURIComponent を通す (commit 4629d3e の CodeQL 警告解消方針と整合)。
    it('id に URL 特殊文字 (?, &, #, /) が含まれても encodeURIComponent で安全にエスケープする', () => {
      const hit = makeHit({ kind: 'risk', id: 'risk-1?evil=true&x=y#hash/a' });
      expect(buildChatHitLink(hit)).toBe('/risks?riskId=risk-1%3Fevil%3Dtrue%26x%3Dy%23hash%2Fa');
    });

    it('id がスペースを含んでも安全にエスケープする', () => {
      const hit = makeHit({ kind: 'project', id: 'proj 1' });
      expect(buildChatHitLink(hit)).toBe('/projects/proj%201');
    });
  });
});
