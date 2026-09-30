import { Capacitor } from "@capacitor/core";
import {
  LOG_LEVEL,
  PRODUCT_TYPE,
  PURCHASES_ERROR_CODE,
  Purchases,
  type CustomerInfo,
  type PurchasesPackage,
  type PurchasesStoreProduct,
} from "@revenuecat/purchases-capacitor";

export const PRO_ENTITLEMENT = "oculo_pro";

export interface PurchaseState {
  isPro: boolean;
  /** The exact configured product is ready for a new purchase. */
  available: boolean;
  configured?: boolean;
  restoreAvailable?: boolean;
  mode?: "native" | "demo" | "unavailable";
  price?: string;
  priceDescription?: string;
  purchaseKind?: "subscription" | "one-time";
  billingPeriod?: { unit: "day" | "week" | "month" | "year"; value: number };
  managementURL?: string;
  message?: string;
  cancelled?: boolean;
}

export interface PurchaseService {
  initialize(): Promise<PurchaseState>;
  refresh(): Promise<PurchaseState>;
  purchasePro(): Promise<PurchaseState>;
  restore(): Promise<PurchaseState>;
  logIn(appUserId: string): Promise<PurchaseState>;
  logOut(): Promise<PurchaseState>;
}

export class PurchaseError extends Error {
  constructor(
    readonly code: "unavailable" | "network" | "pending" | "identity" | "store",
    message: string,
  ) {
    super(message);
    this.name = "PurchaseError";
  }
}

/** Explicit development simulation only; the factory never selects it in production. */
export class MockPurchaseService implements PurchaseService {
  private isPro = false;
  async initialize(): Promise<PurchaseState> {
    return {
      isPro: this.isPro,
      available: true,
      configured: false,
      restoreAvailable: true,
      mode: "demo",
      priceDescription: "Demo purchase — no charge",
      purchaseKind: "one-time",
      message: "Development simulation. No real purchase will be made.",
    };
  }
  refresh(): Promise<PurchaseState> {
    return this.initialize();
  }
  purchasePro(): Promise<PurchaseState> {
    this.isPro = true;
    return this.initialize();
  }
  restore(): Promise<PurchaseState> {
    return this.initialize();
  }
  logIn(): Promise<PurchaseState> {
    return this.initialize();
  }
  logOut(): Promise<PurchaseState> {
    return this.initialize();
  }
}

export class UnavailablePurchaseService implements PurchaseService {
  async initialize(): Promise<PurchaseState> {
    return {
      isPro: false,
      available: false,
      configured: false,
      restoreAvailable: false,
      mode: "unavailable",
      message: "Purchases and restoration are available in the configured iOS or Android app.",
    };
  }
  refresh(): Promise<PurchaseState> {
    return this.initialize();
  }
  async purchasePro(): Promise<PurchaseState> {
    throw new PurchaseError("unavailable", "Purchases are unavailable in this browser.");
  }
  async restore(): Promise<PurchaseState> {
    throw new PurchaseError("unavailable", "Restore purchases in the iOS or Android app.");
  }
  logIn(): Promise<PurchaseState> {
    return this.initialize();
  }
  logOut(): Promise<PurchaseState> {
    return this.initialize();
  }
}

export interface RevenueCatConfiguration {
  platform: string;
  apiKey?: string;
  offeringId?: string;
  packageId?: string;
  productId?: string;
  development?: boolean;
}

type RevenueCatSdk = Pick<
  typeof Purchases,
  | "setLogLevel"
  | "configure"
  | "getCustomerInfo"
  | "getOfferings"
  | "purchasePackage"
  | "restorePurchases"
  | "logIn"
  | "logOut"
  | "isAnonymous"
  | "getAppUserID"
>;

function errorCode(reason: unknown): string {
  if (typeof reason !== "object" || reason === null || !("code" in reason)) return "";
  return String(reason.code);
}
function cancelled(reason: unknown): boolean {
  return (
    errorCode(reason) === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR ||
    (typeof reason === "object" &&
      reason !== null &&
      "userCancelled" in reason &&
      reason.userCancelled === true)
  );
}
function purchaseError(reason: unknown): PurchaseError {
  if (reason instanceof PurchaseError) return reason;
  if (
    [
      PURCHASES_ERROR_CODE.NETWORK_ERROR,
      PURCHASES_ERROR_CODE.OFFLINE_CONNECTION_ERROR,
      PURCHASES_ERROR_CODE.PRODUCT_REQUEST_TIMED_OUT_ERROR,
    ].includes(errorCode(reason) as PURCHASES_ERROR_CODE)
  ) {
    return new PurchaseError(
      "network",
      "The store could not be reached. Check your connection and try again.",
    );
  }
  if (errorCode(reason) === PURCHASES_ERROR_CODE.PAYMENT_PENDING_ERROR) {
    return new PurchaseError(
      "pending",
      "This purchase is awaiting approval. Access will update after the store confirms it.",
    );
  }
  return new PurchaseError("store", "The store could not complete this request. Please try again.");
}

function customerState(info: CustomerInfo): Pick<PurchaseState, "isPro" | "managementURL"> {
  let managementURL: string | undefined;
  try {
    if (info.managementURL && new URL(info.managementURL).protocol === "https:")
      managementURL = info.managementURL;
  } catch {
    /* Invalid provider URLs are not displayed. */
  }
  return {
    isPro: Boolean(info.entitlements.active[PRO_ENTITLEMENT]),
    ...(managementURL ? { managementURL } : {}),
  };
}

function productState(
  product: PurchasesStoreProduct,
):
  Pick<PurchaseState, "price" | "priceDescription" | "purchaseKind" | "billingPeriod"> | undefined {
  if (!product.priceString.trim() || !Number.isFinite(product.price) || product.price < 0)
    return undefined;
  if (
    product.productType === PRODUCT_TYPE.NON_CONSUMABLE &&
    product.subscriptionPeriod === null &&
    !product.introPrice
  ) {
    return {
      price: product.priceString,
      priceDescription: `${product.priceString} one-time`,
      purchaseKind: "one-time",
    };
  }
  return undefined;
}

function configuration(): RevenueCatConfiguration {
  const platform = Capacitor.getPlatform();
  return {
    platform,
    apiKey:
      platform === "ios"
        ? import.meta.env.VITE_REVENUECAT_IOS_API_KEY
        : import.meta.env.VITE_REVENUECAT_ANDROID_API_KEY,
    offeringId: import.meta.env.VITE_REVENUECAT_OFFERING_ID,
    packageId: import.meta.env.VITE_REVENUECAT_PRO_PACKAGE_ID,
    productId:
      platform === "ios"
        ? import.meta.env.VITE_REVENUECAT_IOS_PRO_PRODUCT_ID
        : import.meta.env.VITE_REVENUECAT_ANDROID_PRO_PRODUCT_ID,
    development: import.meta.env.DEV,
  };
}

export class CapacitorRevenueCatPurchaseService implements PurchaseService {
  private configured = false;
  private offeringPackage: PurchasesPackage | undefined;
  private state: PurchaseState = {
    isPro: false,
    available: false,
    configured: false,
    restoreAvailable: false,
    mode: "native",
  };
  private queue: Promise<void> = Promise.resolve();
  private desiredIdentity: string | null = null;
  private identityRevision = 0;
  private appliedIdentityRevision = -1;

  constructor(
    private readonly config: RevenueCatConfiguration = configuration(),
    private readonly sdk: RevenueCatSdk = Purchases,
  ) {}

  initialize(): Promise<PurchaseState> {
    return this.enqueue(() => this.refreshInternal());
  }
  refresh(): Promise<PurchaseState> {
    return this.enqueue(() => this.refreshInternal());
  }
  logIn(appUserId: string): Promise<PurchaseState> {
    if (!appUserId.trim())
      return Promise.reject(
        new PurchaseError("identity", "Sign in again before linking purchase access."),
      );
    return this.requestIdentity(appUserId);
  }
  logOut(): Promise<PurchaseState> {
    return this.requestIdentity(null);
  }
  private requestIdentity(identity: string | null): Promise<PurchaseState> {
    if (identity !== this.desiredIdentity) {
      this.desiredIdentity = identity;
      this.identityRevision += 1;
      this.offeringPackage = undefined;
      this.state = {
        isPro: false,
        available: false,
        configured: this.configured,
        restoreAvailable: false,
        mode: "native",
        message: "Refreshing purchase access for this account…",
      };
    }
    return this.enqueue(() => this.refreshInternal());
  }

  purchasePro(): Promise<PurchaseState> {
    return this.enqueue(async () => {
      await this.requireIdentity();
      if (this.state.isPro) return { ...this.state, cancelled: false };
      const aPackage = this.offeringPackage;
      if (!aPackage || !this.state.available)
        throw new PurchaseError(
          "unavailable",
          this.state.message ??
            "This purchase is not currently available. Refresh the store and try again.",
        );
      const revision = this.identityRevision;
      try {
        const result = await this.sdk.purchasePackage({ aPackage });
        if (revision !== this.identityRevision) return this.refreshInternal();
        this.updateCustomer(result.customerInfo);
        if (!this.state.isPro) {
          this.state.message =
            "The store completed the purchase, but Oculo Pro access is not confirmed yet. Refresh or restore purchases.";
        }
        return { ...this.state, cancelled: false };
      } catch (reason) {
        if (cancelled(reason)) {
          if (revision !== this.identityRevision) await this.refreshInternal();
          return { ...this.state, cancelled: true };
        }
        throw purchaseError(reason);
      }
    });
  }

  restore(): Promise<PurchaseState> {
    return this.enqueue(async () => {
      await this.requireIdentity();
      const revision = this.identityRevision;
      try {
        const result = await this.sdk.restorePurchases();
        if (revision !== this.identityRevision) return this.refreshInternal();
        this.updateCustomer(result.customerInfo);
        if (!this.state.isPro)
          this.state.message = "No active Oculo Pro purchase was found for this store account.";
        return { ...this.state, cancelled: false };
      } catch (reason) {
        if (cancelled(reason)) {
          if (revision !== this.identityRevision) await this.refreshInternal();
          return { ...this.state, cancelled: true };
        }
        throw purchaseError(reason);
      }
    });
  }

  private enqueue(operation: () => Promise<PurchaseState>): Promise<PurchaseState> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async ensureConfigured(): Promise<boolean> {
    if (this.configured) return true;
    const prefix =
      this.config.platform === "ios"
        ? "appl_"
        : this.config.platform === "android"
          ? "goog_"
          : undefined;
    const apiKey = this.config.apiKey;
    if (
      !prefix ||
      !apiKey ||
      !(apiKey.startsWith(prefix) || (this.config.development && apiKey.startsWith("test_")))
    ) {
      this.state = {
        ...this.state,
        configured: false,
        available: false,
        restoreAvailable: false,
        message: "Purchases are not configured for this build.",
      };
      return false;
    }
    await this.sdk.setLogLevel({
      level: this.config.development ? LOG_LEVEL.DEBUG : LOG_LEVEL.ERROR,
    });
    await this.sdk.configure({ apiKey });
    this.configured = true;
    this.state = { ...this.state, configured: true };
    return true;
  }

  private async synchronizeIdentity(): Promise<void> {
    while (this.appliedIdentityRevision !== this.identityRevision) {
      const revision = this.identityRevision;
      const identity = this.desiredIdentity;
      let info: CustomerInfo | undefined;
      if (identity === null) {
        if (!(await this.sdk.isAnonymous()).isAnonymous) {
          try {
            info = (await this.sdk.logOut()).customerInfo;
          } catch (reason) {
            if (errorCode(reason) !== PURCHASES_ERROR_CODE.LOG_OUT_ANONYMOUS_USER_ERROR)
              throw reason;
            info = (await this.sdk.getCustomerInfo()).customerInfo;
          }
        }
      } else if ((await this.sdk.getAppUserID()).appUserID !== identity) {
        info = (await this.sdk.logIn({ appUserID: identity })).customerInfo;
      }
      if (revision !== this.identityRevision) continue;
      this.appliedIdentityRevision = revision;
      if (info) this.updateCustomer(info);
    }
  }

  private async requireIdentity(): Promise<void> {
    try {
      if (!(await this.ensureConfigured()))
        throw new PurchaseError("unavailable", this.state.message ?? "Purchases are unavailable.");
      await this.synchronizeIdentity();
      this.state = { ...this.state, configured: true, restoreAvailable: true };
    } catch (reason) {
      this.state = {
        ...this.state,
        isPro: false,
        available: false,
        restoreAvailable: false,
        message:
          "Purchase access could not be linked to the current account. Refresh or sign in again.",
      };
      if (reason instanceof PurchaseError) throw reason;
      throw new PurchaseError("identity", this.state.message!);
    }
  }

  private async refreshInternal(): Promise<PurchaseState> {
    try {
      if (!(await this.ensureConfigured())) return { ...this.state };
      while (true) {
        await this.requireIdentity();
        const revision = this.identityRevision;
        const hasMapping = Boolean(
          this.config.offeringId && this.config.packageId && this.config.productId,
        );
        const [customer, offerings] = await Promise.allSettled([
          this.sdk.getCustomerInfo(),
          hasMapping ? this.sdk.getOfferings() : Promise.resolve(undefined),
        ]);
        if (revision !== this.identityRevision) continue;
        if (customer.status === "fulfilled") this.updateCustomer(customer.value.customerInfo);
        this.offeringPackage = undefined;
        this.state = {
          ...customerStateFromExisting(this.state),
          available: false,
          configured: true,
          restoreAvailable: true,
          mode: "native",
        };
        if (customer.status === "rejected") {
          this.state.message =
            "Purchase access could not be refreshed. Check your connection and try again.";
        } else if (!hasMapping) {
          this.state.message =
            "New purchases are not configured for this build. Existing purchases can still be restored.";
        } else if (offerings.status === "rejected") {
          this.state.message =
            "The store offer could not be loaded. Refresh to retry, or restore an existing purchase.";
        } else {
          const offering = offerings.value?.all[this.config.offeringId!];
          const matches =
            offering?.availablePackages.filter(
              (item) =>
                item.identifier === this.config.packageId &&
                item.product.identifier === this.config.productId,
            ) ?? [];
          const selected = matches.length === 1 ? matches[0] : undefined;
          const metadata = selected ? productState(selected.product) : undefined;
          if (selected && metadata) {
            this.offeringPackage = selected;
            this.state = { ...this.state, ...metadata, available: true };
          } else {
            this.state.message = selected
              ? "This store offer has billing terms this build does not support yet. Existing purchases can still be restored."
              : "The configured purchase is unavailable. Refresh to retry, or restore an existing purchase.";
          }
        }
        return { ...this.state };
      }
    } catch (reason) {
      this.state = {
        ...this.state,
        available: false,
        restoreAvailable: false,
        message:
          reason instanceof PurchaseError
            ? reason.message
            : "Purchase access could not be initialized. Refresh to retry.",
      };
      return { ...this.state };
    }
  }

  private updateCustomer(info: CustomerInfo): void {
    const rest = { ...this.state };
    delete rest.managementURL;
    this.state = { ...rest, ...customerState(info) };
  }
}

function customerStateFromExisting(
  state: PurchaseState,
): Pick<PurchaseState, "isPro" | "managementURL"> {
  return {
    isPro: state.isPro,
    ...(state.managementURL ? { managementURL: state.managementURL } : {}),
  };
}

export function createPurchaseService(): PurchaseService {
  if (Capacitor.isNativePlatform()) return new CapacitorRevenueCatPurchaseService();
  return import.meta.env.DEV && import.meta.env.VITE_REVENUECAT_MOCK === "true"
    ? new MockPurchaseService()
    : new UnavailablePurchaseService();
}
