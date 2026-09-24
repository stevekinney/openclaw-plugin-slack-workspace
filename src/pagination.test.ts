import { describe, expect, it, vi } from "vitest";
import { cursorParams, toPage, walkPages, type PageRequest } from "./pagination.js";

/**
 * A fake cursor-paginated Slack method: each entry is one page of items, and every
 * page but the last carries `response_metadata.next_cursor` pointing at the next.
 */
function pagedSlackMethod(pages: string[][]) {
  const requests: PageRequest[] = [];
  const fetchPage = vi.fn(async (request: PageRequest) => {
    requests.push(request);
    const index = request.cursor ? Number(request.cursor.replace("page-", "")) : 0;
    const isLast = index === pages.length - 1;
    const data = {
      ok: true,
      scheduled_messages: pages[index],
      response_metadata: { next_cursor: isLast ? "" : `page-${index + 1}` },
    };
    return toPage<string>(data, "scheduled_messages");
  });
  return { fetchPage, requests };
}

describe("cursorParams", () => {
  it("maps cursor and limit onto Slack's request params", () => {
    expect(cursorParams({ cursor: "dXNlcjpVMDYx", limit: 50 })).toEqual({
      cursor: "dXNlcjpVMDYx",
      limit: 50,
    });
  });

  it("omits an empty cursor and a missing limit", () => {
    expect(cursorParams({ cursor: "" })).toEqual({});
    expect(cursorParams({})).toEqual({});
  });
});

describe("toPage", () => {
  it("reads items and next_cursor for manual walking", () => {
    const page = toPage(
      { ok: true, items: [1, 2], response_metadata: { next_cursor: "abc" } },
      "items",
    );
    expect(page).toEqual({ items: [1, 2], cursor: "abc", hasMore: true });
  });

  it("treats an empty or missing next_cursor as the last page", () => {
    expect(toPage({ items: [1], response_metadata: { next_cursor: "" } }, "items")).toEqual({
      items: [1],
      hasMore: false,
    });
    expect(toPage({ items: [1] }, "items")).toEqual({ items: [1], hasMore: false });
  });

  it("treats a missing items array as an empty page", () => {
    expect(toPage({ ok: true }, "items")).toEqual({ items: [], hasMore: false });
  });
});

describe("walkPages", () => {
  it("stops after one page when the response has no next_cursor", async () => {
    const { fetchPage, requests } = pagedSlackMethod([["a", "b"]]);
    await expect(walkPages(fetchPage)).resolves.toEqual({ items: ["a", "b"], hasMore: false });
    expect(requests).toEqual([{}]);
  });

  it("follows next_cursor across two pages", async () => {
    const { fetchPage, requests } = pagedSlackMethod([["a", "b"], ["c"]]);
    await expect(walkPages(fetchPage, { limit: 2 })).resolves.toEqual({
      items: ["a", "b", "c"],
      hasMore: false,
    });
    expect(requests).toEqual([{ limit: 2 }, { cursor: "page-1", limit: 2 }]);
  });

  it("follows next_cursor across three pages", async () => {
    const { fetchPage, requests } = pagedSlackMethod([["a"], ["b"], ["c"]]);
    await expect(walkPages(fetchPage)).resolves.toEqual({
      items: ["a", "b", "c"],
      hasMore: false,
    });
    expect(requests.map((request) => request.cursor)).toEqual([undefined, "page-1", "page-2"]);
  });

  it("resumes from a caller-supplied cursor", async () => {
    const { fetchPage, requests } = pagedSlackMethod([["a"], ["b"], ["c"]]);
    await expect(walkPages(fetchPage, { cursor: "page-1" })).resolves.toEqual({
      items: ["b", "c"],
      hasMore: false,
    });
    expect(requests[0]).toEqual({ cursor: "page-1" });
  });

  it("stops at maxPages and returns the cursor to resume from", async () => {
    const { fetchPage } = pagedSlackMethod([["a"], ["b"], ["c"]]);
    await expect(walkPages(fetchPage, { maxPages: 2 })).resolves.toEqual({
      items: ["a", "b"],
      cursor: "page-2",
      hasMore: true,
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("stops if Slack hands back the cursor it was just given", async () => {
    const fetchPage = vi.fn(async () => ({ items: ["x"], cursor: "same", hasMore: true }));
    await expect(walkPages(fetchPage, { cursor: "same" })).resolves.toEqual({
      items: ["x"],
      cursor: "same",
      hasMore: true,
    });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("stops between pages when the call is aborted", async () => {
    const controller = new AbortController();
    const { fetchPage } = pagedSlackMethod([["a"], ["b"]]);
    fetchPage.mockImplementationOnce(async () => {
      controller.abort(new Error("cancelled"));
      return { items: ["a"], cursor: "page-1", hasMore: true };
    });
    await expect(walkPages(fetchPage, { signal: controller.signal })).rejects.toThrow("cancelled");
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("rejects a maxPages below 1", async () => {
    const { fetchPage } = pagedSlackMethod([["a"]]);
    await expect(walkPages(fetchPage, { maxPages: 0 })).rejects.toThrow(
      "maxPages must be a positive integer",
    );
    expect(fetchPage).not.toHaveBeenCalled();
  });
});
