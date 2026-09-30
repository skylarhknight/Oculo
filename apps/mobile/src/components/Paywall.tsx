import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, Sparkles, X } from "lucide-react";
import { ModalDialog } from "./ModalDialog";
import { ReleaseLinks } from "./ReleaseLinks";
import type { PurchaseService, PurchaseState } from "../services/PurchaseService";
import { PURCHASE_DISCLOSURES_READY } from "../config/release";

export function Paywall({
  purchase,
  service,
  onChange,
  onClose,
}: {
  purchase: PurchaseState;
  service: PurchaseService;
  onChange: (state: PurchaseState) => void;
  onClose: () => void;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const workingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const perform = async (operation: () => Promise<PurchaseState>) => {
    if (workingRef.current) return;
    workingRef.current = true;
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const next = await operation();
      if (!mounted.current) return;
      onChange(next);
      if (next.cancelled) setNotice("Purchase cancelled. Your projects are unchanged.");
      else if (next.isPro) setNotice("Oculo Pro is active. You can save additional projects.");
      else setNotice(next.message ?? "No active Oculo Pro purchase was found.");
    } catch (reason) {
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : "Purchase could not be completed.");
    } finally {
      workingRef.current = false;
      if (mounted.current) setWorking(false);
    }
  };
  const canPurchase =
    purchase.available &&
    !purchase.isPro &&
    (PURCHASE_DISCLOSURES_READY || purchase.mode === "demo");
  return (
    <ModalDialog
      className="paywall"
      backdropClassName="paywall-backdrop"
      labelledBy="pro-title"
      describedBy="pro-description"
      onClose={onClose}
      busy={working}
    >
      <button
        className="paywall-close"
        disabled={working}
        aria-label="Close Oculo Pro"
        onClick={onClose}
      >
        <X size={19} />
      </button>
      <div className="paywall-symbol">
        <Sparkles size={30} />
      </div>
      <span className="kicker">
        <span /> Oculo Pro
      </span>
      <h2 id="pro-title">
        Keep your projects
        <br />
        <em>ready for the next shoot.</em>
      </h2>
      <p className="paywall-copy" id="pro-description">
        Free includes one saved project. Unlock additional saved projects with one purchase.
      </p>
      <ul>
        <li style={{ "--i": 0 } as CSSProperties}>
          <Check size={15} /> Unlimited saved projects, subject to device storage
        </li>
        <li style={{ "--i": 1 } as CSSProperties}>
          <Check size={15} /> Keep separate plans for different scenes and shoots
        </li>
        <li style={{ "--i": 2 } as CSSProperties}>
          <Check size={15} /> Existing projects stay accessible if purchase status changes
        </li>
      </ul>
      <p className="purchase-note">
        Import, shots, expanded movement editing, PNG shot sheets, and supported video exports are
        free. Restore purchases restores Pro access, not deleted project or scene files.
      </p>
      {purchase.mode === "demo" && (
        <p className="purchase-note" role="status">
          Development demo only. No payment will be charged.
        </p>
      )}
      {purchase.priceDescription && <p className="purchase-price">{purchase.priceDescription}</p>}
      {purchase.purchaseKind === "one-time" && (
        <p className="purchase-note">One-time purchase. No recurring charge.</p>
      )}
      <button
        className="primary-button purchase-button"
        disabled={working || !canPurchase}
        onClick={() => void perform(() => service.purchasePro())}
      >
        {working ? "Connecting…" : purchase.isPro ? "Oculo Pro active" : "Get Oculo Pro"}
      </button>
      {!canPurchase && !purchase.isPro && (
        <p className="purchase-note">
          {purchase.message ??
            "Purchases are unavailable right now. Your free tools are ready to use."}
        </p>
      )}
      {error && (
        <p className="purchase-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="purchase-note" role="status">
          {notice}
        </p>
      )}
      <div className="purchase-actions">
        <button
          className="restore-button"
          disabled={working || !purchase.restoreAvailable}
          onClick={() => void perform(() => service.restore())}
        >
          Restore purchases
        </button>
        <button
          className="restore-button"
          disabled={working}
          onClick={() => void perform(() => service.refresh())}
        >
          Refresh availability
        </button>
      </div>
      {purchase.managementURL && (
        <a
          className="manage-purchase"
          href={purchase.managementURL}
          target="_blank"
          rel="noopener noreferrer"
        >
          Manage store purchases
        </a>
      )}
      <ReleaseLinks />
    </ModalDialog>
  );
}
