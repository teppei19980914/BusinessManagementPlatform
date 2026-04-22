import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { InboxMailProvider } from './inbox-provider';

describe('InboxMailProvider (PR #92)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'inbox-provider-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('送信内容を JSON ファイルとして INBOX_DIR に書き出す', async () => {
    const provider = new InboxMailProvider(dir);
    const result = await provider.send({
      to: 'user@example.com',
      subject: 'テスト件名',
      html: '<p>Hello</p>',
      text: 'Hello',
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toMatch(/^inbox-\d+-[a-f0-9]{8}$/);

    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const payload = JSON.parse(readFileSync(join(dir, files[0]), 'utf-8'));
    expect(payload).toMatchObject({
      to: 'user@example.com',
      subject: 'テスト件名',
      html: '<p>Hello</p>',
      text: 'Hello',
    });
    expect(payload.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('同じディレクトリに複数通送信しても衝突しない', async () => {
    const provider = new InboxMailProvider(dir);
    await provider.send({ to: 'a@example.com', subject: '1', html: '<p>1</p>' });
    await provider.send({ to: 'b@example.com', subject: '2', html: '<p>2</p>' });
    await provider.send({ to: 'c@example.com', subject: '3', html: '<p>3</p>' });

    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(3);
  });

  it('text 省略時は空文字で保存される', async () => {
    const provider = new InboxMailProvider(dir);
    await provider.send({ to: 'u@example.com', subject: 's', html: '<p/>' });

    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    const payload = JSON.parse(readFileSync(join(dir, files[0]), 'utf-8'));
    expect(payload.text).toBe('');
  });

  it('存在しないディレクトリを指定した場合は自動作成する', async () => {
    const nestedDir = join(dir, 'nested', 'deep');
    const provider = new InboxMailProvider(nestedDir);
    await provider.send({ to: 'u@example.com', subject: 's', html: '<p/>' });
    const files = readdirSync(nestedDir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
  });
});
