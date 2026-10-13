# Development checkpoint

Checkpoint: 2026-10-13. Package version remains 0.5.1; the photo workflow changes are unfinished and have not been released as 0.5.2.

## Photo preparation

`src/commerce-photos.cjs` introduces `preparePhotos(engine, planId, { setId, signal, validateImage })` and `readPreparedPhotos(engine, planId)`.

The intended flow persists the selected photo set, exact claim body and idempotency key before claiming, saves the claim receipt before reacting to cancellation, and validates same-origin JPEG downloads, decoded dimensions and file hashes. `preparePhotos` calls `engine.configure` internally: the caller must not wrap it in another configuration transaction.

`src/commerce-engine.cjs` includes photo-preparation summaries and history/identity checks. Remaining work includes behavior tests, restart-state migration, stricter persisted-record validation, main-process image decoding, IPC/UI integration, and profile deletion/cleanup guards for photo history. Treat this implementation as unverified until those checks are complete.

## Photo upload

`src/vinted-photo-upload.cjs` provides trusted manifest validation and read-only photo-control diagnostics. `src/vinted-adapter.cjs` exposes `inspectPhotoControls` and `uploadPhotos`; uploading currently stops with `PHOTO_UPLOAD_UNVERIFIED`.

The manifest is a process-local capability. After a restart, verify the persisted files again before creating a new trusted manifest. Do not accept arbitrary local paths from a renderer.

Next steps: inspect the real upload control; select one unambiguous file input; verify successful thumbnails and errors rather than only the selected-file count; stop on unrelated existing photos; handle navigation, cancellation and retries without duplicate uploads. Saving or publishing requires its own explicit, verified flow.

## Commerce integration

The adapter readiness guard and incomplete polling remain in place. Each capability needs real page evidence and a durable receipt before enabling it. Verify account/listing identity, price, quantity and buyer/order identity at the relevant steps. An accepted offer is not a paid sale. Procurement requires a verified paid order, matching shipping label, exact supplier quote and authorized purchase limits. Unknown results must be reconciled instead of replayed with fresh identifiers.

Supplier photo claims use fixed set IDs and idempotency keys. Do not assume a particular idempotency retention window unless the supplier contract states one. A supplier photo claim supports one immutable listing association; later reuse needs separate local history.

## Runtime audit

`test/runtime-audit-v052.cjs` contains an unrun Electron audit for repeated proxy authentication, CacheStorage/ServiceWorker isolation, SharedWorker isolation and page/worker/frame parameter observations.

The lifetime `authAttempts` counter in `src/main.cjs` may reject later legitimate proxy authentication challenges. Reproduce this before changing it; consider Electron's `authenticationResponseDetails.firstAuthAttempt` while continuing to reject repeated failed credentials.

## Validation record

The 0.5.1 checkpoint had 178 passing unit tests, 108 checks in a full desktop regression run, 41 checks in a later core run and 16 final form checks. These runs overlap and should not be added into a unique-test total. Live marketplace evidence covered eight listing fields, not publishing or transactions.

Photo manifest/diagnostic tests and the existing adapter tests passed 58 checks together. The photo preparation implementation has only been syntax checked. Re-run relevant checks after integration and record the exact revision under test.

## Contributions

Keep changes scoped and preserve evidence of incomplete external actions. Add meaningful regression coverage for duplicate claims/orders, interrupted operations, stale pages and profile ownership. Do not commit real credentials, screenshots containing personal data, browser profiles or private transaction records. Do not label a mock test or a single detection website result as proof of universal real-world behavior.
