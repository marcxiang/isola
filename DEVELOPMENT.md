# Development checkpoint

Checkpoint: 2026-10-14, development version 0.5.2.

## Photo preparation

`src/commerce-photos.cjs` persists the selected set, exact request body and idempotency key before claiming. It saves the supplier receipt before reacting to cancellation, validates same-origin JPEG downloads, decoded dimensions and file hashes, and retains history across restarts. An uncertain claim is reconciled with the original key. `preparePhotos` owns the engine configuration transaction; callers must not wrap it in another one.

`src/commerce-photo-service.cjs` exposes plan-ID-only IPC for inspect, prepare, preview and upload. Trusted paths and capabilities remain in the main process. Previews are decoded, bounded JPEG data URLs. The UI shows preparation progress and separates prepared files from uploaded photos. Profile deletion and data cleanup preserve photo history.

A real free supplier photo claim was prepared and its image uploaded to the France new-item page. Repeated application restarts retained the original claim and prepared files. No extra photo set was claimed for these checks. Private claim IDs, files and browser sessions are not in this repository.

## Photo upload

`src/vinted-photo-upload.cjs` validates a process-local trusted manifest, scopes file selection to the verified photo widget and verifies the upload receipt separately. Native file-input transport is covered with local Electron fixtures. Navigation, cancellation, stale controls, file tampering, timeouts and unrelated existing photos stop the operation. After selection may have begun, a repeated operation only checks the original receipt.

The upload record is tied to the current document and adapter instance. Restarting the application loses that in-memory record; an existing photo must not be adopted automatically from a supplier claim alone. A fresh empty test form can reuse verified local files without claiming another set. Durable cross-restart upload reconciliation remains future work.

Saving or publishing requires a separate verified flow. A thumbnail alone does not establish publication, listing ownership or a paid sale.

## Commerce integration

The adapter readiness guard and incomplete polling remain in place. Publishing, messages, offers, labels and procurement still need real page evidence and durable receipts. Verify account/listing identity, price, quantity and buyer/order identity at the relevant steps. An accepted offer is not a paid sale. Procurement requires a verified paid order, matching shipping label, exact supplier quote and authorized purchase limits. Unknown results must be reconciled instead of replayed with fresh identifiers.

Supplier photo claims use fixed set IDs and idempotency keys. Do not assume a retention window unless the supplier contract states one. A supplier claim supports one immutable listing association; later image reuse needs separate local history. The user confirmed the TEST package fits the Moyen shoe-box-size option. No exact dimensions or weight have been invented. Other products require their own parcel confirmation.

## Operations dashboard and account binding

The workbench groups catalog products by sales environment, separates enabled plans from actual listing receipts, filters by product/environment/state and links to the relevant task records. A listing URL is derived from one matching stored claim receipt and checked against the active listing ID and France origin before opening in the associated environment.

`src/vinted-account.cjs` reads the unique current header account menu twice. Binding is durable; another member ID invalidates cached evidence and does not replace the original identity. This reader and the displayed account binding passed on the real France page. Private account identifiers stay in local application data.

`src/commerce-scheduler.cjs` provides recovery, bounded exponential read retries, per-environment operation leases and queue diagnostics. The engine rejects duplicate job identities and unresolved publication occupancy, isolates orphan and uncertain tasks, persists retry deadlines and enforces the background switch in the main process. Pausing one plan only aborts that plan's active lease. Readiness diagnostics do not enable unverified marketplace capabilities.

## Publication evidence

`src/vinted-publication-evidence.cjs` ties the current account, eight fields, actual category traversal, local claim and current-page upload receipt together. It reads native DOM evidence twice and rejects populated unknown fields, page errors, changed documents and ambiguous publication controls. Empty optional fields are allowed. A read-only workbench check passed all 15 checks on the real TEST form, after clearing the website's unconfirmed automatic material suggestion. Paid Boost stayed unchecked.

`src/vinted-publication.cjs` adds durable preparation/dispatch/uncertain/publication states. One attempt is allowed per submission; restart never replays an uncertain click. Completion still requires a real observed listing, seller, item-only price and photo identity mapping. A passed preflight is not a completed publication.

## Runtime audit

`src/proxy-auth.cjs` replaces the lifetime authentication counter. It releases successful URL attempts while limiting repeated failed credentials and rotating realms. Credentials are restricted to the configured proxy host and port. Main-process request completion is tied to the tab and navigation generation.

The Electron audit passed repeated navigation authentication, 35 successful challenges within one page, wrong credentials, changing realms, origin 401 handling, CacheStorage/ServiceWorker and SharedWorker isolation. The custom-parameter observation found page/worker differences; custom mode is not a universal device-consistency guarantee. Native mode avoids these custom overrides. No test is proof of undetectable automation.

## Validation record

The 2026-10-14 checkpoint passed 337 unit tests and 163 checks in one full Electron desktop suite. The suite includes eight operations-dashboard checks, account-menu and publication-evidence DOM fixtures, native photo transport, proxy/storage audits, navigation guards and AI-control regressions. Separate runs overlap and are not added to these totals. Real France evidence at this checkpoint covers eight filled fields, one uploaded image, current-account binding and 15 read-only prepublication checks; no publish, buyer message, offer, label or purchase has been executed.

## Contributions

Keep changes scoped and preserve evidence of incomplete external actions. Add meaningful regression coverage for duplicate claims/orders, interrupted operations, stale pages and profile ownership. Do not commit credentials, screenshots containing personal data, browser profiles or private transaction records. Do not label a mock test or a single detection website result as proof of universal real-world behavior.
