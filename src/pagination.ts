/**
 * Cursor pagination for Slack Web API methods that return
 * `response_metadata.next_cursor` (conversations.*, chat.scheduledMessages.list,
 * slackLists.items.list, ...). Tools opt in by pairing `cursorParams` with their
 * request body and `toPage` with the response, then either return one page for the
 * caller to walk manually or hand the page fetcher to `walkPages`.
 */

/** What a paginated request adds to a method's body. */
export type PageRequest = { cursor?: string; limit?: number };

/** One page of results; `cursor` is present only while more pages remain. */
export type Page<T> = { items: T[]; cursor?: string; hasMore: boolean };

/** Upper bound on pages fetched in one walk, so a tool call cannot run unbounded. */
const DEFAULT_MAX_PAGES = 10;

/** Slack's `cursor`/`limit` request params, omitting whichever are unset. */
export function cursorParams({ cursor, limit }: PageRequest): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (cursor) params.cursor = cursor;
  if (limit !== undefined) params.limit = limit;
  return params;
}

/** Read one page out of a Slack response. An empty `next_cursor` means the last page. */
export function toPage<T>(data: Record<string, unknown>, itemsKey: string): Page<T> {
  const items = (data[itemsKey] ?? []) as T[];
  const cursor = (data.response_metadata as { next_cursor?: string } | undefined)?.next_cursor;
  return cursor ? { items, cursor, hasMore: true } : { items, hasMore: false };
}

/**
 * Fetch pages until `next_cursor` runs out or `maxPages` is reached. When stopped
 * early the result keeps `cursor`/`hasMore` so the caller can resume from there.
 */
export async function walkPages<T>(
  fetchPage: (request: PageRequest) => Promise<Page<T>>,
  options: PageRequest & { maxPages?: number; signal?: AbortSignal } = {},
): Promise<Page<T>> {
  const { limit, maxPages = DEFAULT_MAX_PAGES, signal } = options;
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error(`maxPages must be a positive integer (got ${maxPages}).`);
  }
  const items: T[] = [];
  let cursor = options.cursor || undefined;
  for (let page = 0; page < maxPages; page++) {
    signal?.throwIfAborted();
    const request: PageRequest = {};
    if (cursor) request.cursor = cursor;
    if (limit !== undefined) request.limit = limit;
    const result = await fetchPage(request);
    items.push(...result.items);
    // A cursor that does not advance would loop forever; stop and surface it.
    if (!result.hasMore || !result.cursor || result.cursor === cursor) {
      return result.hasMore && result.cursor
        ? { items, cursor: result.cursor, hasMore: true }
        : { items, hasMore: false };
    }
    cursor = result.cursor;
  }
  return { items, cursor, hasMore: true };
}
