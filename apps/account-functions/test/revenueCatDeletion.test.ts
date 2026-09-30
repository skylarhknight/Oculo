import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccountCleanupError,
  deleteRevenueCatSubscriber,
  REVENUECAT_DELETION_TIMEOUT_MS,
} from "../src/revenueCatDeletion.js";

const SECRET = "sk_fixture_only_not_a_real_key";

afterEach(() => vi.useRealTimers());

describe("RevenueCat subscriber deletion", () => {
  it("deletes only the encoded Firebase UID and does not follow redirects", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    await expect(deleteRevenueCatSubscriber("uid/with ?#% ü", SECRET, fetcher)).resolves.toBe(
      "requested",
    );
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "https://api.revenuecat.com/v1/subscribers/uid%2Fwith%20%3F%23%25%20%C3%BC",
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${SECRET}`, Accept: "application/json" },
        signal: expect.any(AbortSignal),
        redirect: "error",
      },
    );
  });

  it("accepts a repeated deletion that reports an absent subscriber", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(deleteRevenueCatSubscriber("uid", SECRET, fetcher)).resolves.toBe("requested");
    await expect(deleteRevenueCatSubscriber("uid", SECRET, fetcher)).resolves.toBe("absent");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["", ".", "..", "a".repeat(129), "\ud800"])(
    "rejects invalid/path-normalizing UID %j before requesting",
    async (uid) => {
      const fetcher = vi.fn<typeof fetch>();
      await expect(deleteRevenueCatSubscriber(uid, SECRET, fetcher)).rejects.toMatchObject({
        code: "invalid-uid",
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each(["", " ", "appl_public_sdk", "goog_public_sdk", "sk_", "sk_bad\nheader"])(
    "rejects absent/public/invalid server credential %j",
    async (key) => {
      const fetcher = vi.fn<typeof fetch>();
      await expect(deleteRevenueCatSubscriber("uid", key, fetcher)).rejects.toMatchObject({
        code: "configuration",
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    [201, "provider-rejected"],
    [202, "provider-rejected"],
    [204, "provider-rejected"],
    [301, "provider-rejected"],
    [400, "provider-rejected"],
    [401, "provider-rejected"],
    [403, "provider-rejected"],
    [429, "rate-limited"],
    [500, "provider-unavailable"],
    [503, "provider-unavailable"],
  ])("retains HTTP %i as a failed delivery with redacted diagnostics", async (status, code) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: Number(status) }));
    await expect(deleteRevenueCatSubscriber("private-uid", SECRET, fetcher)).rejects.toMatchObject({
      code,
      status,
    });
  });

  it("does not parse or retain provider response content", async () => {
    const response = new Response(`private-uid ${SECRET} personal@example.invalid`, {
      status: 401,
    });
    const text = vi.spyOn(response, "text");
    const json = vi.spyOn(response, "json");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const failure = await deleteRevenueCatSubscriber("private-uid", SECRET, fetcher).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AccountCleanupError);
    expect(JSON.stringify(failure)).not.toMatch(/private-uid|sk_fixture|personal@/);
    expect(String(failure)).not.toMatch(/private-uid|sk_fixture|personal@/);
    expect(failure).not.toHaveProperty("cause");
    expect(text).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it("discards network errors containing credentials or request URLs", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(`request/private-uid ${SECRET}`));
    const failure = await deleteRevenueCatSubscriber("private-uid", SECRET, fetcher).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "network" });
    expect(String(failure)).not.toMatch(/private-uid|sk_fixture/);
    expect(failure).not.toHaveProperty("cause");
  });

  it("aborts a stalled request after ten seconds and clears its timer", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener("abort", () => reject(new Error(`private-uid ${SECRET}`)), {
            once: true,
          });
        }),
    );
    const promise = deleteRevenueCatSubscriber("private-uid", SECRET, fetcher);
    const rejection = expect(promise).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(REVENUECAT_DELETION_TIMEOUT_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows redelivery after a temporary failure and clears completed request timers", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(deleteRevenueCatSubscriber("uid", SECRET, fetcher)).rejects.toMatchObject({
      code: "network",
    });
    await expect(deleteRevenueCatSubscriber("uid", SECRET, fetcher)).resolves.toBe("requested");
    expect(vi.getTimerCount()).toBe(0);
  });
});
