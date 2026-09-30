import { afterEach, describe, expect, it, vi } from "vitest";
import type * as CapacitorCore from "@capacitor/core";
import {
  PRODUCT_TYPE,
  type CustomerInfo,
  type PurchasesPackage,
  type PurchasesStoreProduct,
} from "@revenuecat/purchases-capacitor";
import {
  CapacitorRevenueCatPurchaseService,
  createPurchaseService,
  MockPurchaseService,
  UnavailablePurchaseService,
  type RevenueCatConfiguration,
} from "./PurchaseService";

const platform = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => false),
  getPlatform: vi.fn(() => "ios"),
}));
vi.mock("@capacitor/core", async (importOriginal) => ({
  ...(await importOriginal<typeof CapacitorCore>()),
  Capacitor: platform,
}));

type Sdk = NonNullable<ConstructorParameters<typeof CapacitorRevenueCatPurchaseService>[1]>;
const CONFIG: RevenueCatConfiguration = {
  platform: "ios",
  apiKey: "appl_public_test",
  offeringId: "selected-offer",
  packageId: "selected-package",
  productId: "selected.product",
  development: false,
};

function customer(pro = false, managementURL: string | null = null): CustomerInfo {
  return {
    entitlements: { active: pro ? { oculo_pro: { isActive: true } } : {} },
    managementURL,
  } as unknown as CustomerInfo;
}

function aPackage(
  product: Partial<PurchasesStoreProduct> = {},
  id = "selected-package",
): PurchasesPackage {
  return {
    identifier: id,
    offeringIdentifier: "selected-offer",
    product: {
      identifier: "selected.product",
      price: 79.99,
      priceString: "79,99 €",
      currencyCode: "EUR",
      productType: PRODUCT_TYPE.NON_CONSUMABLE,
      subscriptionPeriod: null,
      introPrice: null,
      defaultOption: null,
      ...product,
    },
  } as unknown as PurchasesPackage;
}

function harness(
  config: RevenueCatConfiguration = CONFIG,
  packages: PurchasesPackage[] = [aPackage()],
) {
  let identity = "$RCAnonymousID:test";
  const accounts = new Map<string, boolean>([["member", true]]);
  const sdk = {
    setLogLevel: vi.fn().mockResolvedValue(undefined),
    configure: vi.fn().mockResolvedValue(undefined),
    getCustomerInfo: vi.fn(async () => ({
      customerInfo: customer(accounts.get(identity) ?? false),
    })),
    getOfferings: vi.fn().mockResolvedValue({
      current: null,
      all: { "selected-offer": { availablePackages: packages } },
    }),
    getAppUserID: vi.fn(async () => ({ appUserID: identity })),
    isAnonymous: vi.fn(async () => ({ isAnonymous: identity.startsWith("$RCAnonymousID:") })),
    logIn: vi.fn(async ({ appUserID }: { appUserID: string }) => {
      identity = appUserID;
      return { customerInfo: customer(accounts.get(identity) ?? false), created: false };
    }),
    logOut: vi.fn(async () => {
      identity = "$RCAnonymousID:next";
      return { customerInfo: customer(false) };
    }),
    purchasePackage: vi.fn(async () => {
      accounts.set(identity, true);
      return { customerInfo: customer(true) };
    }),
    restorePurchases: vi.fn(async () => {
      accounts.set(identity, true);
      return { customerInfo: customer(true) };
    }),
  };
  return {
    service: new CapacitorRevenueCatPurchaseService(config, sdk as unknown as Sdk),
    sdk,
    setIdentity: (value: string) => {
      identity = value;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllEnvs();
  platform.isNativePlatform.mockReturnValue(false);
  platform.getPlatform.mockReturnValue("ios");
});

describe("purchase factory and configuration", () => {
  it.each([false, true])(
    "never simulates a production browser purchase even with mock=%s",
    async (mock) => {
      vi.stubEnv("DEV", false);
      vi.stubEnv("VITE_REVENUECAT_MOCK", String(mock));
      const service = createPurchaseService();
      expect(service).toBeInstanceOf(UnavailablePurchaseService);
      expect(await service.initialize()).toMatchObject({
        isPro: false,
        available: false,
        restoreAvailable: false,
        mode: "unavailable",
      });
      await expect(service.purchasePro()).rejects.toMatchObject({ code: "unavailable" });
      await expect(service.restore()).rejects.toMatchObject({ code: "unavailable" });
      expect((await service.refresh()).isPro).toBe(false);
    },
  );

  it("requires an explicit development flag and labels simulated purchases", async () => {
    vi.stubEnv("DEV", true);
    vi.stubEnv("VITE_REVENUECAT_MOCK", "false");
    expect(createPurchaseService()).toBeInstanceOf(UnavailablePurchaseService);
    vi.stubEnv("VITE_REVENUECAT_MOCK", "true");
    const service = createPurchaseService();
    expect(service).toBeInstanceOf(MockPurchaseService);
    expect(await service.purchasePro()).toMatchObject({
      isPro: true,
      mode: "demo",
      priceDescription: "Demo purchase — no charge",
    });
  });

  it.each([
    { platform: "ios", apiKey: "" },
    { platform: "ios", apiKey: "goog_wrong_platform" },
    { platform: "android", apiKey: "appl_wrong_platform" },
    { platform: "web", apiKey: "appl_native_only" },
    { platform: "ios", apiKey: "test_test_store" },
    { platform: "ios", apiKey: "sk_never_use_secret" },
  ])(
    "does not configure unsupported production keys/platforms: $platform $apiKey",
    async (override) => {
      const { service, sdk } = harness({ ...CONFIG, ...override });
      expect(await service.initialize()).toMatchObject({
        configured: false,
        available: false,
        restoreAvailable: false,
      });
      expect(sdk.configure).not.toHaveBeenCalled();
      await expect(service.restore()).rejects.toMatchObject({ code: "unavailable" });
    },
  );

  it("selects the Android key and exact Android product from the environment", async () => {
    platform.getPlatform.mockReturnValue("android");
    vi.stubEnv("VITE_REVENUECAT_IOS_API_KEY", "appl_ios_public");
    vi.stubEnv("VITE_REVENUECAT_ANDROID_API_KEY", "goog_android_public");
    vi.stubEnv("VITE_REVENUECAT_OFFERING_ID", "selected-offer");
    vi.stubEnv("VITE_REVENUECAT_PRO_PACKAGE_ID", "selected-package");
    vi.stubEnv("VITE_REVENUECAT_IOS_PRO_PRODUCT_ID", "ios.product");
    vi.stubEnv("VITE_REVENUECAT_ANDROID_PRO_PRODUCT_ID", "android.product");
    const { sdk } = harness(CONFIG, [aPackage({ identifier: "android.product" })]);
    const service = new CapacitorRevenueCatPurchaseService(undefined, sdk as unknown as Sdk);
    expect((await service.initialize()).available).toBe(true);
    expect(sdk.configure).toHaveBeenCalledExactlyOnceWith({ apiKey: "goog_android_public" });
  });

  it("configures once across initialization, refresh, and an identity request", async () => {
    const { service, sdk } = harness();
    await Promise.all([service.initialize(), service.refresh(), service.logIn("member")]);
    expect(sdk.configure).toHaveBeenCalledTimes(1);
    expect((await service.refresh()).isPro).toBe(true);
  });

  it("retries failed configuration instead of permanently marking the SDK ready", async () => {
    const { service, sdk } = harness();
    sdk.configure.mockRejectedValueOnce(new Error("Configuration failed"));
    expect(await service.initialize()).toMatchObject({ configured: false, available: false });
    expect(await service.refresh()).toMatchObject({ configured: true, available: true });
    expect(sdk.configure).toHaveBeenCalledTimes(2);
  });
});

describe("exact product selection and billing disclosures", () => {
  it("purchases only the intended package/product, regardless of offering/package order", async () => {
    const intended = aPackage();
    const { service, sdk } = harness(CONFIG, [
      aPackage({ identifier: "unrelated.product" }, "first-package"),
      aPackage({ identifier: "wrong.product" }),
      intended,
    ]);
    expect(await service.initialize()).toMatchObject({
      available: true,
      price: "79,99 €",
      priceDescription: "79,99 € one-time",
    });
    expect((await service.purchasePro()).isPro).toBe(true);
    expect(sdk.purchasePackage).toHaveBeenCalledExactlyOnceWith({ aPackage: intended });
  });

  it.each(["offeringId", "packageId", "productId"] as const)(
    "requires configured %s while retaining restore",
    async (key) => {
      const { service, sdk } = harness({ ...CONFIG, [key]: "" });
      expect(await service.initialize()).toMatchObject({
        configured: true,
        available: false,
        restoreAvailable: true,
      });
      await expect(service.purchasePro()).rejects.toMatchObject({ code: "unavailable" });
      expect((await service.restore()).isPro).toBe(true);
      expect(sdk.purchasePackage).not.toHaveBeenCalled();
    },
  );

  it("does not substitute the current offering when the configured offering is missing", async () => {
    const { service, sdk } = harness();
    sdk.getOfferings.mockResolvedValue({ current: { availablePackages: [aPackage()] }, all: {} });
    expect((await service.initialize()).available).toBe(false);
    await expect(service.purchasePro()).rejects.toMatchObject({ code: "unavailable" });
  });

  it.each(["P1M", "P3M", "P1Y", "P1W", "P7D"])(
    "rejects subscription %s while preserving restore",
    async (period) => {
      const { service, sdk } = harness(CONFIG, [
        aPackage({
          productType: PRODUCT_TYPE.AUTO_RENEWABLE_SUBSCRIPTION,
          subscriptionPeriod: period,
        }),
      ]);
      expect(await service.initialize()).toMatchObject({
        available: false,
        restoreAvailable: true,
      });
      await expect(service.purchasePro()).rejects.toMatchObject({ code: "unavailable" });
      expect(sdk.purchasePackage).not.toHaveBeenCalled();
    },
  );

  it("labels a non-consumable as a one-time charge", async () => {
    const { service } = harness(CONFIG, [
      aPackage({ productType: PRODUCT_TYPE.NON_CONSUMABLE, subscriptionPeriod: null }),
    ]);
    const state = await service.initialize();
    expect(state).toMatchObject({
      available: true,
      priceDescription: "79,99 € one-time",
      purchaseKind: "one-time",
    });
    expect(state.billingPeriod).toBeUndefined();
  });

  it.each([
    { productType: PRODUCT_TYPE.CONSUMABLE, subscriptionPeriod: null },
    { productType: PRODUCT_TYPE.PREPAID_SUBSCRIPTION },
    { productType: PRODUCT_TYPE.UNKNOWN },
    { subscriptionPeriod: "P1M2D" },
    { productType: PRODUCT_TYPE.AUTO_RENEWABLE_SUBSCRIPTION, subscriptionPeriod: null },
    { introPrice: { price: 0 } },
  ])("does not sell terms that the current paywall cannot disclose: %o", async (product) => {
    const { service, sdk } = harness(CONFIG, [aPackage(product as Partial<PurchasesStoreProduct>)]);
    expect(await service.initialize()).toMatchObject({ available: false, restoreAvailable: true });
    await expect(service.purchasePro()).rejects.toMatchObject({ code: "unavailable" });
    expect(sdk.purchasePackage).not.toHaveBeenCalled();
  });
});

describe("purchase identity serialization", () => {
  it("waits for pending SDK configuration before linking a signed-in user", async () => {
    const configured = deferred<void>();
    const started = deferred<void>();
    const { service, sdk } = harness();
    sdk.configure.mockImplementationOnce(() => {
      started.resolve();
      return configured.promise;
    });
    const initializing = service.initialize();
    await started.promise;
    const login = service.logIn("member");
    expect(sdk.logIn).not.toHaveBeenCalled();
    configured.resolve();
    expect((await initializing).isPro).toBe(true);
    expect((await login).isPro).toBe(true);
    expect(sdk.logIn).toHaveBeenCalledExactlyOnceWith({ appUserID: "member" });
  });

  it("does not return the previous account entitlement when login is superseded", async () => {
    const pending = deferred<{ customerInfo: CustomerInfo; created: boolean }>();
    const started = deferred<void>();
    const { service, sdk } = harness();
    await service.initialize();
    sdk.logIn.mockImplementationOnce(() => {
      started.resolve();
      return pending.promise;
    });
    const first = service.logIn("member");
    await started.promise;
    const second = service.logIn("other-account");
    pending.resolve({ customerInfo: customer(true), created: false });
    expect((await first).isPro).toBe(false);
    expect((await second).isPro).toBe(false);
    expect(sdk.logIn).toHaveBeenLastCalledWith({ appUserID: "other-account" });
  });

  it("discards customer information returned after an account change during refresh", async () => {
    const pending = deferred<{ customerInfo: CustomerInfo }>();
    const started = deferred<void>();
    const { service, sdk } = harness();
    await service.logIn("member");
    sdk.getCustomerInfo.mockImplementationOnce(() => {
      started.resolve();
      return pending.promise;
    });
    const refreshing = service.refresh();
    await started.promise;
    const logout = service.logOut();
    pending.resolve({ customerInfo: customer(true) });
    expect((await refreshing).isPro).toBe(false);
    expect((await logout).isPro).toBe(false);
  });

  it("blocks transactions after a failed identity link, then retries linking on refresh", async () => {
    const { service, sdk } = harness();
    await service.logIn("member");
    sdk.logIn.mockRejectedValueOnce({ code: "10" }).mockRejectedValueOnce({ code: "10" });
    expect(await service.logIn("other-account")).toMatchObject({
      isPro: false,
      available: false,
      restoreAvailable: false,
    });
    await expect(service.purchasePro()).rejects.toMatchObject({ code: "identity" });
    expect(sdk.purchasePackage).not.toHaveBeenCalled();
    expect(await service.refresh()).toMatchObject({
      isPro: false,
      available: true,
      restoreAvailable: true,
    });
  });

  it("does not swallow a logout network failure as anonymous success", async () => {
    const { service, sdk } = harness();
    await service.logIn("member");
    sdk.logOut.mockRejectedValueOnce({ code: "10" });
    const before = sdk.getCustomerInfo.mock.calls.length;
    expect(await service.logOut()).toMatchObject({
      isPro: false,
      available: false,
      restoreAvailable: false,
    });
    expect(sdk.getCustomerInfo).toHaveBeenCalledTimes(before);
    expect((await service.refresh()).restoreAvailable).toBe(true);
  });

  it("clears a persisted signed-in SDK identity when the app starts signed out", async () => {
    const { service, sdk, setIdentity } = harness();
    setIdentity("member");
    expect((await service.initialize()).isPro).toBe(false);
    expect(sdk.logOut).toHaveBeenCalledTimes(1);
  });
});

describe("purchase outcomes and restoration", () => {
  it("restores before initialization without requiring a loaded catalog", async () => {
    const { service, sdk } = harness();
    expect(await service.restore()).toMatchObject({
      isPro: true,
      configured: true,
      restoreAvailable: true,
    });
    expect(sdk.getOfferings).not.toHaveBeenCalled();
  });

  it("keeps access ungranted and explains a completed purchase missing oculo_pro", async () => {
    const { service, sdk } = harness();
    await service.initialize();
    sdk.purchasePackage.mockResolvedValueOnce({ customerInfo: customer(false) });
    expect(await service.purchasePro()).toMatchObject({
      isPro: false,
      message: expect.stringContaining("not confirmed"),
    });
  });

  it("does not apply a purchase result to a different account selected while the store was open", async () => {
    const pending = deferred<{ customerInfo: CustomerInfo }>();
    const started = deferred<void>();
    const { service, sdk } = harness();
    await service.initialize();
    sdk.purchasePackage.mockImplementationOnce(() => {
      started.resolve();
      return pending.promise;
    });
    const purchasing = service.purchasePro();
    await started.promise;
    const login = service.logIn("other-account");
    pending.resolve({ customerInfo: customer(true) });
    expect((await purchasing).isPro).toBe(false);
    expect((await login).isPro).toBe(false);
    expect(sdk.logIn).toHaveBeenLastCalledWith({ appUserID: "other-account" });
  });

  it.each([{ code: "1" }, { code: 1 }, { userCancelled: true }])(
    "handles normal cancellation and permits retry: %o",
    async (reason) => {
      const { service, sdk } = harness();
      await service.initialize();
      sdk.purchasePackage.mockRejectedValueOnce(reason);
      expect(await service.purchasePro()).toMatchObject({
        isPro: false,
        cancelled: true,
        available: true,
      });
      expect(await service.purchasePro()).toMatchObject({ isPro: true, cancelled: false });
    },
  );

  it("reports pending approval without granting access", async () => {
    const { service, sdk } = harness();
    await service.initialize();
    sdk.purchasePackage.mockRejectedValueOnce({ code: "20" });
    await expect(service.purchasePro()).rejects.toMatchObject({ code: "pending" });
    expect((await service.refresh()).isPro).toBe(false);
  });

  it("allows restoration despite an offerings failure", async () => {
    const { service, sdk } = harness();
    sdk.getOfferings.mockRejectedValue(new Error("Store catalog failed"));
    expect(await service.initialize()).toMatchObject({
      configured: true,
      available: false,
      restoreAvailable: true,
    });
    expect((await service.restore()).isPro).toBe(true);
    expect(sdk.restorePurchases).toHaveBeenCalledTimes(1);
  });

  it("preserves confirmed access during an offline refresh and updates it when expiry is confirmed", async () => {
    const { service, sdk } = harness();
    expect((await service.logIn("member")).isPro).toBe(true);
    sdk.getCustomerInfo.mockRejectedValueOnce({ code: "35" });
    expect(await service.refresh()).toMatchObject({
      isPro: true,
      available: false,
      restoreAvailable: true,
    });
    sdk.getCustomerInfo.mockResolvedValueOnce({ customerInfo: customer(false) });
    expect((await service.refresh()).isPro).toBe(false);
  });

  it("exposes only HTTPS management links and clears old account URLs", async () => {
    const { service, sdk } = harness();
    sdk.getCustomerInfo.mockResolvedValueOnce({
      customerInfo: customer(true, "https://apps.apple.com/account/subscriptions"),
    });
    expect((await service.initialize()).managementURL).toBe(
      "https://apps.apple.com/account/subscriptions",
    );
    sdk.getCustomerInfo.mockResolvedValueOnce({
      customerInfo: customer(false, "javascript:alert(1)"),
    });
    expect((await service.refresh()).managementURL).toBeUndefined();
  });
});
