# SearchOpportunityService review follow-up gates

Base: `e33f26ad2ee36889d2d94f09fe5a8924789c1b6e`.

1. A page that cannot be joined uniquely because normalized GSC keys collide or GA4 landing rows collide after normalization exposes `leadOrPurchaseKeyEvents: null`; it must not inherit a page-level outcome count from another ambiguous candidate.
2. `truncated.outcomeEvents` is true only when outcome rows were omitted (`pageInfo.hasMore` or `totalRowCount > rows.length`). Sampling, thresholding, restricted metrics, and invalid/missing values may limit scoring/evidence but must not be described as row truncation.
3. The combined result returns the quota snapshot from the final key-events request when present and falls back to the landing-page report snapshot only when the final snapshot is absent.
4. Focused Vitest coverage reproduces each reviewer case without external calls. The existing service behavior tests continue to pass. No provider schema, credentials, installed runtime, deployment, or API usage changes.
