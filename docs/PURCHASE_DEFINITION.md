# Oculo 1.0 purchase definition

Authority: [PRD](PRD.md). This records the product decision; dashboard setup is not yet verified.

- Free: one saved project on this device. Import, multiple shots, notes, expanded movement editing (up to 24 camera waypoints), PNG shot sheets, and supported video previews are included.
- Oculo Pro: one-time non-consumable, no subscription; no product-imposed saved-project limit. Device storage and scene/export limits apply equally.
- New demo projects, imports, and duplicates consume capacity. Opening a demo in the editor creates a saved project; browsing its catalog card does not.
- Creating another project offers Pro or return to the existing library. Deletion is explicit and can free capacity. Nothing is overwritten automatically.
- Existing projects remain readable, editable, exportable, and deletable when entitlement status changes or is unavailable, including legacy libraries with multiple projects. Remote recovery and conflict preservation retain existing work rather than discarding it to enforce capacity.
- Restore purchases works without Oculo login. It restores the entitlement, not deleted local files.

| Item                      | Value / status                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| Customer-facing name      | Oculo Pro                                                                                     |
| Bundle ID                 | `org.example.oculo.student` in Capacitor and Xcode; confirm matching App Store Connect record             |
| Entitlement               | `oculo_pro` implemented                                                                         |
| Product ID                | Proposed `org.example.oculo.student.pro.lifetime`; confirm/create in App Store Connect before configuring |
| Offering                  | Proposed `default`; confirm in RevenueCat                                                         |
| Package                   | Proposed `$rc_lifetime`; confirm in RevenueCat                                                    |
| Launch price              | **US$9.99 one-time**, approved by the product owner                                               |
| Base currency             | **USD**, approved by the product owner                                                            |
| Base country / storefront | **United States**                                                                                 |

Populate the existing `VITE_REVENUECAT_*` catalog fields with confirmed dashboard values. The app only accepts a non-consumable and displays its store-localized one-time price. Do not replace an existing store product identifier without checking the store record. Native purchase, cancellation, pending payment, restoration, offline access, and account identity recovery are release gates.

## Approved launch pricing

The product owner approved a free app download and a **US$9.99 one-time, non-consumable Oculo Pro unlock**, using **United States / USD** as the base storefront and currency. The full one-project workflow remains free; Pro enables additional saved projects, subject to device storage.

Use Apple's generated regional prices as the starting point and review them before publication. Display the actual store-localized purchase price in the app; this decision does not hard-code a dollar amount into the paywall or confirm dashboard configuration.

The unlock does not include unlimited World Labs generation or cloud storage. Team API credits are a development resource, not an ongoing customer entitlement. Review pricing after 6–8 weeks of real usage using operating costs, second-project attempts, and purchase conversion. US$14.99 for future buyers is a possible later experiment, not an approved or scheduled price increase.
