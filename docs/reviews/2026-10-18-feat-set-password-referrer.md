# Review, feat/set-password-referrer, 2026-10-18

**Reviewed by**: Sonnet 5.5 (author on Opus 5.5)
**Scope**: 7 files, branch vs main
**Verdict**: Approve with nits

## Summary
Switches the set password page from `referrer: "no-referrer"` to `"strict-origin"` so a native form POST (a click before hydration) carries a real `Origin` and passes Next's Server Actions CSRF check. The token stays out of every Referer because only the origin is sent. The change is tiny, correct, and consistently carried through the page, its unit test, both e2e specs, and the spec, rationale and verify docs. No blockers or majors; a few minors about guarding the regression.

## Minor
### 🟡 The e2e regression test does not exercise the real action, `e2e/set-password-public.spec.ts:28`
**Problem**: The native POST test builds a synthetic form against an unknown-token page and checks only the `Origin` and `Referer` headers. It never submits the real "Set my password" form, so it does not prove Next accepts the request (the actual bug was a refusal). The true pre-hydration click was checked once by a throwaway spec that was deleted.
**Why it matters**: If a future change (a `Referrer-Policy` header, a Next upgrade changing the CSRF rule) breaks the pre-hydration path while headers still look right, nothing catches it.
**Suggested fix**: Optionally add a JS-disabled e2e (`javaScriptEnabled: false` context) on a live fixture link that asserts the redirect to hol-recovery. Header-level coverage is a reasonable stopgap.

### 🟡 Header override is documented but unguarded, `docs/specs/0014-set-password-welcome-email/index.md` (Security notes)
**Problem**: The spec says any `Referrer-Policy` response header reaching the route must also be `strict-origin`, because a header overrides the meta tag. Nothing tests the response header. I found no such header in `next.config.ts`, `proxy.ts` or the layout today.
**Why it matters**: A later global security-headers change (commonly `no-referrer` or `same-origin`) would silently reintroduce `Origin: null`. The native POST e2e would catch it only if it runs locally.
**Suggested fix**: Have the e2e (or a unit test) also assert no conflicting `Referrer-Policy` response header on `/set-password/<token>`.

## Nits
- ⚪ `docs/specs/0014-set-password-welcome-email/index.md` Follow-up: the item "The next `/check verify` covers the AC-9 referrer amendment" is ticked `[x]`, yet the same branch's verify.md records that verify run; wording reads as a future task. Reword to past tense or leave unticked.
- ⚪ `e2e/set-password-public.spec.ts:30`: the `page.evaluate` form-submit with `setTimeout` is a bit indirect; `page.waitForRequest` plus `form.requestSubmit()` in the same evaluate would read clearer. Not required.

## Strengths
- Root cause is understood and documented precisely (Fetch spec `Origin: null` under no-referrer, Next's check in `action-handler.js`), and the rejected alternatives (`same-origin`, `origin`, `allowedOrigins: null`) are recorded with reasons; adding `null` to `allowedOrigins` would have weakened CSRF app wide.
- Verified on dev both by e2e and by a real JS-off click that ended the link `used`.
- Token stays out of Referer on all outbound requests (Turnstile, Authentik); `strict-origin` also drops even the origin on https to http downgrades.
- Spec, rationale, verify log, code comment, unit test and both e2e specs all updated together, so nothing still says `no-referrer`.

## Test coverage
Unit test asserts `metadata.referrer === "strict-origin"`; both e2e specs check the meta tag, and a new e2e checks `Origin` and `Referer` on a native POST. Not covered automatically: the full pre-hydration click through the real action (manual only) and absence of a conflicting response header. No other new logic.
