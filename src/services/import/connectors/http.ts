/**
 * 外部移行インポート — コネクタ共通 HTTP 基盤 (ADR-0034 / IMPORT_CONNECTORS.md §0)
 *
 * 役割:
 *   - 全サービス共通の JSON 取得 (認証ヘッダ/クエリ付与は各コネクタが RequestSpec で指定)。
 *   - レート制御: 429 / 5xx を `Retry-After`(秒 or HTTP-date) → `X-RateLimit-Reset`(Unix秒) →
 *     指数バックオフ の優先順で待機・再試行する (IMPORT_CONNECTORS.md §0 各サービスの方針を一本化)。
 *   - ページング: カーソル / オフセット の汎用ループ (range 一括は Sheets コネクタ側で完結)。
 *
 * テスト容易性:
 *   - fetch は注入可能 (`opts.fetchImpl`)。実APIは叩かず、レスポンスをモックして決定的にテストする。
 *   - 待機 (`sleep`) と現在時刻 (`now`) も注入可能 (バックオフ計算を決定化)。
 */

/** HTTP エラー (再試行不能 or 上限到達)。status と本文を保持し UI に原因を伝える。 */
export class ConnectorHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly bodyText: string,
  ) {
    super(`HTTP ${status} ${url}`);
    this.name = 'ConnectorHttpError';
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  /** テスト注入用。未指定ならグローバル fetch。 */
  fetchImpl?: FetchLike;
  /** 429/5xx の最大再試行回数 (既定 5)。 */
  maxRetries?: number;
  /** バックオフ計算の基準時刻 (ms)。既定 Date.now。テストで固定する。 */
  now?: () => number;
  /** 待機関数。既定 setTimeout。テストで即時解決にする。 */
  sleep?: (ms: number) => Promise<void>;
  /** 指数バックオフの基準待機 (ms。既定 500)。 */
  baseDelayMs?: number;
  /** 1 リクエストあたりの待機上限 (ms。既定 60_000)。Retry-After が極端でも頭打ち。 */
  maxDelayMs?: number;
}

export interface RequestSpec {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** JSON ボディ (POST 時)。null/undefined なら送らない。 */
  body?: unknown;
  /** クエリ (undefined の値は除外。値は文字列化)。 */
  query?: Record<string, string | number | boolean | undefined>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** クエリを URL に付与する (undefined を除外、encodeURIComponent)。 */
export function buildUrl(base: string, query?: RequestSpec['query']): string {
  if (!query) return base;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  if (parts.length === 0) return base;
  return base + (base.includes('?') ? '&' : '?') + parts.join('&');
}

/**
 * 待機 ms を決める。優先順位:
 *   1. Retry-After (秒の整数、または HTTP-date) — Notion / Backlog / 一般的な 429
 *   2. X-RateLimit-Reset (Unix 秒) — Backlog 等
 *   3. 指数バックオフ baseDelay * 2^attempt
 * いずれも maxDelay で頭打ち。負値は 0。
 */
export function computeBackoffMs(
  res: Pick<Response, 'headers' | 'status'>,
  attempt: number,
  opts: { now?: () => number; baseDelayMs?: number; maxDelayMs?: number } = {},
): number {
  const now = opts.now ?? Date.now;
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 60_000;

  const clamp = (ms: number): number => Math.max(0, Math.min(max, ms));

  const retryAfter = res.headers.get('retry-after');
  if (retryAfter != null && retryAfter !== '') {
    const asInt = Number(retryAfter);
    if (Number.isFinite(asInt)) return clamp(asInt * 1000);
    const asDate = Date.parse(retryAfter);
    if (Number.isFinite(asDate)) return clamp(asDate - now());
  }

  const reset = res.headers.get('x-ratelimit-reset');
  if (reset != null && reset !== '') {
    const resetSec = Number(reset);
    if (Number.isFinite(resetSec)) return clamp(resetSec * 1000 - now());
  }

  return clamp(base * 2 ** attempt);
}

/**
 * JSON を取得する。429 / 5xx は Retry-After/X-RateLimit-Reset/指数バックオフ で待機して再試行。
 * 4xx (429 除く) は再試行せず {@link ConnectorHttpError} を投げる (権限不足/404 等)。
 */
export async function fetchJson<T>(spec: RequestSpec, opts: HttpClientOptions = {}): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const maxRetries = opts.maxRetries ?? 5;
  const sleep = opts.sleep ?? defaultSleep;
  const url = buildUrl(spec.url, spec.query);
  const method = spec.method ?? 'GET';

  const headers: Record<string, string> = { ...(spec.headers ?? {}) };
  let body: string | undefined;
  if (spec.body != null) {
    body = JSON.stringify(spec.body);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
  }

  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, { method, headers, body });
    if (res.ok) {
      return (await res.json()) as T;
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < maxRetries) {
      const waitMs = computeBackoffMs(res, attempt, opts);
      await sleep(waitMs);
      continue;
    }
    const text = await res.text().catch(() => '');
    throw new ConnectorHttpError(res.status, url, text);
  }
}

/** ページング・全件取得時の安全弁 (暴走防止)。1 取得元あたりの最大ページ数 / 最大件数。 */
export const MAX_PAGES = 1000;

/**
 * カーソル方式の全件取得 (Notion next_cursor / kintone カーソル)。
 * fetchPage は「現在のカーソル → そのページの items と次カーソル」を返す。
 * nextCursor が falsy になるか MAX_PAGES に達したら停止。
 */
export async function collectByCursor<TItem>(
  fetchPage: (cursor: string | undefined) => Promise<{ items: TItem[]; nextCursor?: string | null }>,
  opts: { maxPages?: number } = {},
): Promise<TItem[]> {
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const all: TItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const { items, nextCursor } = await fetchPage(cursor);
    all.push(...items);
    if (!nextCursor) return all;
    cursor = nextCursor;
  }
  return all;
}

/**
 * オフセット方式の全件取得 (Backlog count+offset / Pleasanter PageSize+Offset)。
 * fetchPage は「offset → そのページの items と総件数 total」を返す。
 * 取得済みが total 以上、空ページ、または MAX_PAGES で停止。
 */
export async function collectByOffset<TItem>(
  fetchPage: (offset: number) => Promise<{ items: TItem[]; total: number }>,
  pageSize: number,
  opts: { maxPages?: number } = {},
): Promise<TItem[]> {
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const all: TItem[] = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    const { items, total } = await fetchPage(offset);
    all.push(...items);
    offset += pageSize;
    // 空ページ (これ以上ない) または総件数到達で停止
    if (items.length === 0 || all.length >= total) return all;
  }
  return all;
}
