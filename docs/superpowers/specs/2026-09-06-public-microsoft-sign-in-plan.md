# Public Microsoft sign-in without per-user tenant configuration

**Status: Implemented in source — owned registration and live-account release gates remain pending.**
**Date:** 2026-09-06. **Baseline:** main `48e13c628198ce3e234ef38fb3a5e2e446aff12d` (0.4.0).
**Implementation:** 2026-09-08. No application was provisioned, no external permissions were granted, and no live-account sign-in or demo was recorded.

## Implementation outcome

The Host now accepts an approved public-client registration for organizational accounts (including Microsoft corporate accounts) and personal Microsoft accounts. `FLEET_ENTRA_CLIENT_ID` selects that registration; an omitted `FLEET_ENTRA_TENANT_ID` selects `common`. An explicit directory GUID retains the enterprise restriction. No approved Fleet-owned client ID is bundled yet: a fresh unconfigured Host shows setup rather than falling back to the borrowed registration.

For wire and backup compatibility, the existing `tenantId` configuration field remains the **authority selector**, not the administrator's identity tenant. The provider separately enforces a concrete GUID restriction for enterprise mode. Administrator keys come exclusively from verified concrete `tid` and `oid` claims; neither `common`, `sub`, email, nor a fallback account identifier becomes an administrator key.

MSAL Node performs token acquisition. `jose` verifies the ID token's RS256 signature against Microsoft's fixed public-cloud JWKS endpoint, signing-key issuer scope, concrete issuer/tenant relationship, audience, validity and transaction nonce. Required identity claims are checked before comparing them with MSAL's result. Cache removal also runs after rejected results. MSAL adds `offline_access` to the identity scopes; no provider cache is persisted.

Previously claimed Hosts pin their effective legacy configuration, and first claim persists the configuration used. Settings offers a verified registration switch: the old configuration stays active until the same administrator's stable identity is authenticated by the replacement registration. Success revokes old sessions, retires pending code/device transactions and disables device flow until reverified. A different guest/home identity, expired initiating session, cancellation or failed sign-in leaves the old configuration intact. Email-based re-enrollment is deliberately not implemented.

Production loopback callbacks follow the browser's localhost forwarding port; the Vite development path retains its explicit API callback port. Public tunnel callbacks and cross-origin session transfer remain out of scope. Portable backups preserve the authority selection and reject malformed configuration before replacing security data; Node identities are unchanged.

Automated coverage includes signed-token negative cases, corporate/personal claim and administrator approval, fixed-tenant refusal, configuration pinning, verified cutover, transaction races, session revocation, localhost callback routing and backup round trips. **Live personal-account, external-organization and corporate-policy results: not tested.** Publishing a registration and completing the real-account matrix below remain release prerequisites.

## 1. Decision requested

Can Copilot Fleet offer Microsoft sign-in to organizational **and personal Microsoft accounts**, without requiring each self-hosting user to create a tenant or provide a tenant ID?

**Proposed answer:** use a maintainer-owned, appropriately registered public client with an account audience covering both kinds of account and the `common` authority. Keep a separate, explicit single-tenant enterprise configuration. This removes per-user tenant configuration, not application registration or Host authorization.

The implementation follows this direction; release review must still confirm registration ownership, consent and live-account behavior for the distributed self-hosted Node.js Host. A client ID is public identification, not proof that a caller is the official Fleet binary.

## 2. Observed problem and baseline behavior

A fresh Host claim with a personal Microsoft account failed with **AADSTS50020**: its `live.com` identity was not in the configured Microsoft tenant. A corporate account had worked (operator report). No account address, authorization code, token, or private organization material is included here.

The baseline source (before the implementation above) established the following:

- [`apps/host/src/auth/entra.ts`](../../../apps/host/src/auth/entra.ts) defines `MICROSOFT_CORP_TENANT_ID`, `VISUAL_STUDIO_PUBLIC_CLIENT_ID`, and `BUILT_IN_ENTRA_CONFIG`. Its comment describes reuse of the public client used by KYC for local development. That comment is not evidence of permission to redistribute the registration for an unrelated application.
- `EntraConfigSchema` accepts a tenant **GUID only**. `common`, `organizations`, and `consumers` are rejected today.
- `loadMsalNode` constructs `https://login.microsoftonline.com/${config.tenantId}`.
- `checkTenant` requires the returned tenant ID to equal the configured GUID. Merely relaxing the configuration schema is not sufficient.
- `createMsalAdapter` currently derives the identity from `result.tenantId` and `result.uniqueId || result.account?.localAccountId`. The suitability and stability of this mapping for personal accounts must be verified, not assumed.
- [`apps/host/src/routes/auth.ts`](../../../apps/host/src/routes/auth.ts) deliberately uses `/` as the callback path for the borrowed client, but `/api/auth/entra/callback` for a different client ID.
- `entraConfigFrom` prefers stored configuration over environment configuration. A changed environment variable alone may therefore not migrate an existing Host.
- [`apps/host/src/server.ts`](../../../apps/host/src/server.ts) supplies the built-in registration by default. Claim still requires console possession plus Microsoft identity; the Host's own administrator list controls subsequent access.

**Terminology:** a public repository does not have a universally usable public tenant. The current tenant is Microsoft's corporate directory. OAuth **public client** means a client that cannot keep a client secret; it does not mean unrestricted use of another publisher's application registration. Public IDs are not secrets, but audience, registration ownership, policy, and supported usage still matter.

## 3. Goals and non-goals

### Goals

1. A personal Microsoft account can claim a fresh Host under the public configuration.
2. Organizational accounts from different directories can authenticate, subject to their own consent and Conditional Access policies.
3. Ordinary users do not create an Entra tenant, paste a tenant ID, or become guests of Microsoft's corporate tenant.
4. Authentication never grants implicit administrator access; Host possession and the Host administrator workflow remain mandatory.
5. Existing enterprise deployments keep their tenant restriction and administrator identities during upgrade.
6. Errors distinguish unsupported audience, organization policy, invalid configuration, and lack of Fleet administrator access without leaking tokens or detailed account data.

### Non-goals

- Bypassing an organization's tenant policy or asking Microsoft to invite unrelated users into its corporate directory.
- Reusing a different product's client ID solely because it is visible in public source.
- Making Graph calls, uploading Copilot credentials, changing Node enrollment, changing orchestrator execution policy, or introducing a hosted Fleet control plane.
- Adding a shared secret to distributed source, enabling anonymous operation, or enabling legacy password login as an automatic fallback.
- Shipping a new GitHub/passkey provider in the same patch.

## 4. Options

| Option | User setup | Advantages | Limits / recommendation |
| --- | --- | --- | --- |
| Maintainer-owned app, organizational + personal accounts, `common` | No tenant setup for ordinary users | Fits public project onboarding; honest Fleet branding | Requires registration ownership, policy/security review, correct validation and migration. **Recommended candidate.** |
| Bring your own app + fixed directory GUID | Tenant admin configures Host | Explicit enterprise boundary; existing design mostly fits | Keep supported for enterprise use; not the default public onboarding path. |
| Existing borrowed app + `common` | Apparently little setup | Could be investigated if the app owner explicitly supports the use case | Audience, callback, publisher restrictions, consent and lifecycle are not ours to control. **Not an approved solution; do not ship based on a successful experiment alone.** |
| Own single-tenant app + invited guests | Every outside user needs guest enrollment | Can serve a controlled private installation | Not equivalent to direct personal-account support; not a scalable public default. |
| GitHub login or local passkeys | Different enrollment/recovery model | May suit Copilot users or remove an Entra dependency | Separate design; GitHub still needs app registration, and passkeys need secure bootstrap/recovery. |

If internal reviewers know a formally supported Microsoft-provided registration for this exact use case, identify the public support contract and restrictions. Do not publish internal-only documentation or client credentials into this repository.

## 5. Proposed registration and authority model

### Publisher setup (once, not once per user)

1. Use a directory the project publisher legitimately controls. An existing eligible directory is sufficient; creating another tenant is not inherently required. Current Microsoft tenant-creation eligibility may restrict free/trial accounts; do not promise universal free tenant creation.
2. Register **Copilot Fleet** with the supported account type **Any Entra ID Tenant + Personal Microsoft accounts** (the portal may use equivalent wording).
3. Evaluate the **Mobile and desktop applications / public-client** platform for Fleet's authorization-code + PKCE flow. For a new client ID, current code emits `http://localhost:<port>/api/auth/entra/callback`, **not** the borrowed client's root callback. Register and test the exact applicable localhost path, platform, and port-matching behavior against Microsoft's documented restrictions, including MSA-specific restrictions. Do not assume a wildcard or arbitrary public tunnel URL is accepted.
4. Use only the identity scopes required for sign-in; inspect actual consent and remove unnecessary API permissions from the registration. No Graph access is required by this proposal. Document any SDK-added scopes and distinguish requesting them from persisting tokens.
5. Publish only the application/client ID and non-secret metadata. No client secret is needed by the proposed public-client flow. Do not blanket-enable device flow as a prerequisite for PKCE; determine the precise registration flags for each flow separately.
6. Assign durable maintainers, a recovery/ownership process, user-facing privacy/support information, and a plan for registration suspension or retirement. Review publisher verification and organization consent requirements; neither verification nor `common` overrides organizational policy.

### Host configuration (conceptual — names are not implemented settings)

Represent **login audience** separately from **a concrete tenant restriction**:

- `public`: approved Fleet client ID + authority `common`; organizational and personal identities permitted to authenticate.
- `enterprise`: operator-owned compatible client ID + authority for a specified directory GUID; preserve strict returned-tenant equality.
- Optional custom multi-tenant registration support can follow the same public rules if approved; it need not be exposed in the initial UI.

`common` is an authority selector, **never an administrator's tenant identity**. Derive identity from a correctly validated result. Do not save `common` in the administrator table or replace the returned tenant with the registration's home tenant.

Keep configuration schema, authority construction, identity validation, and administrator authorization as separate responsibilities. Reject invalid combinations early. Only trusted local configuration or an appropriately reauthenticated administrator may change the registration/audience; never let a pre-claim anonymous browser freely select an arbitrary identity provider.

## 6. Security invariants and feasibility gates

### Token and identity validation

- Document exactly what the installed `@azure/msal-node` version validates during authorization-code and device redemption. Existing source comments are not proof of cryptographic validation behavior. Establish a complete signature/key, issuer, audience/client, expiry, state, nonce, PKCE, and transaction-binding validation contract using supported libraries. If any required validation is absent, fix the design before release; never simply remove `checkTenant` and trust decoded claims.
- Multi-tenant issuer validation must accept only legitimate Microsoft issuer/tenant relationships for the approved audience. Do not treat a literal `common` issuer as valid or accept any token that happens to contain `tid`.
- Verify the personal-account claim and MSAL result shape with a real authorized test account. Explicitly establish which stable principal fields are present, how guest identities behave, and whether the current `(tenantId, objectId)` key remains correct. Fail closed on absent or inconsistent identifiers. Do not merge accounts by email, display name, or a convenient fallback string.
- Preserve state/nonce/PKCE, single-use transactions, expiry, browser binding, rate limits, and cancellation. Test replay and cross-browser claim attempts.
- Keep provider tokens out of database, logs, URLs exposed to third parties, backups, and recordings. Account selection and consent happen in the user's browser, not via credentials passed to agents.

### Authentication is not Fleet authorization

- Fresh claim requires both a valid console claim proof and an allowed Microsoft identity; consume the claim atomically so only one first administrator wins.
- On an already claimed Host, an arbitrary successfully authenticated account gets no Fleet session or data access unless approved as a Host administrator.
- Preserve candidate invitation + explicit administrator approval, last-admin protection, revocation of sessions/live browser connections, and recent appropriate reauthentication for sensitive operations.
- Test current invitation and administrator-removal rules under cross-tenant identities; do not inadvertently add a tenant-wide allow rule.
- Keep Microsoft sign-in separate from GitHub Copilot auth and Dev Tunnels auth. Supporting personal Fleet login does not prove either of those other products accepts that account or policy.

### Remote self-hosted deployments

A loopback redirect executes on the **browser's machine**. A Host reached through a public tunnel is not automatically reachable there. Preserve the supported local-forward path and test the exact callback port, route, cookies, and origin behavior on another machine. Do not derive an unchecked redirect from an untrusted Host header. Dynamic public tunnel callbacks and session-cookie sharing across origins are not implied by this proposal.

Device sign-in stays off until its supported verification succeeds. Conditional Access denial is a supported outcome, not a reason to weaken policy. Existing operations requiring fresh authorization-code authentication must not quietly accept device authentication instead.

## 7. Upgrade and recovery plan

1. Inventory the effective configuration source (stored, environment, built-in fallback), configured audience, current administrators and active sessions without logging credentials.
2. Preserve existing fixed-tenant configurations on upgrade. A Host previously relying on the built-in corporate default must not silently become public merely because the packaged default changes. Introduce an explicit configuration version / legacy pinning migration if needed.
3. First validate the new registration on a separate fresh Host with test accounts. Do not experiment by rewriting a production administrator table or changing a claimed Host's sole authentication route.
4. For an existing Host, require an explicit, authenticated migration flow. Verify the new sign-in and stable account mapping before retiring the old configuration. A change in client ID can affect subject identifiers: if a mapping cannot be proven, design a possession-protected/admin-approved re-enrollment instead of assuming identity equality.
5. Define configuration precedence and rollback behavior. Retire pending old-configuration OAuth transactions and decide/document session revocation on cutover; no transaction may complete under a different audience/client than it started with.
6. Test upgrade and rollback with existing session, administrator, invitation, Node and backup data. Preserve Node identity/placements; no Node key rewrite is necessary for this feature.
7. Only make the maintainer-owned registration the fresh-install default after the real-account, policy and migration gates pass. If registration is not ready, show setup-required guidance; do not ship an unverified client ID or silently fall back to the borrowed one.

## 8. Implementation sequence (after review only)

1. **Feasibility spike:** approved registration; PKCE round-trip for personal and organizational accounts; document SDK validation, claims, consent, callback behavior and private remote forwarding. Use disposable data; never commit tokens or internal evidence.
2. **Configuration model:** versioned audience/registration representation, validation, conservative legacy migration and clear setup errors. Keep old enterprise behavior covered by tests.
3. **Provider boundary:** authority selection, complete validated identity contract, correct MSA/guest handling and transaction binding. Add negative security tests before broadening accepted identities.
4. **Host authorization regression:** fresh claim, existing-user denial, invitation/approval, reauthentication, administrator removal and websocket revocation.
5. **UX/docs:** explain who can sign in versus who can administer; owned registration setup; enterprise override; localhost forwarding; clear tenant-policy failures and token-free diagnostics.
6. **Release gate:** review migration/rollback evidence, run repository checks and real-account matrix, then update the default. Resume the tutorial only once its demonstrated flow actually works.

Likely touch points: `apps/host/src/auth/entra.ts`, `auth/service.ts`, `routes/auth.ts`, `server.ts`, auth-related protocol/UI schemas, their tests, `.env.example`, README/README.zh-CN, and migration/backup handling where configuration is persisted. Confirm actual dependencies before editing; no refactor of unrelated Node crypto or orchestration.

## 9. Verification matrix

| Case | Required result |
| --- | --- |
| Fresh public Host + personal account + valid claim | Exactly one administrator; subsequent authorized login works |
| Fresh public Host + organizational account from a non-publisher directory | Works where organization consent/policy permits; otherwise clear refusal |
| Public Host already claimed + unrelated personal/organizational account | No Fleet session, data access, or automatic administrator enrollment |
| Enterprise fixed-tenant Host + different directory | Refused, including after upgrade |
| Invited cross-tenant candidate | No privileges until explicit approval; wrong recipient can be rejected |
| Guest vs home identity / same email in different identities | No accidental account merge or privilege inheritance |
| Invalid issuer/audience/signature/expiry or missing principal fields | Fail closed; no session |
| State/nonce/PKCE mismatch, replay, concurrent claim | Refused; claim cannot be won twice |
| Client/audience changed while login is pending | Old transaction cannot complete using new policy |
| localhost on alternate port; browser on another machine via local forwarding | Correct registered callback and transaction cookies; no origin leakage |
| Device flow allowed / blocked | Existing explicit verification semantics preserved; blocked policy not bypassed |
| Sensitive action after stale or wrong-kind reauthentication | Rejected until required fresh flow succeeds |
| Administrator removal / last-admin attempt | Sessions and sockets revoked; last-admin protection retained |
| Legacy persisted/env/built-in config upgrade; failed cutover; rollback | No silent audience expansion or administrator lockout; Node state retained |

Automated unit/integration tests are necessary but not enough: MSAL mocks cannot prove live account support, issuer handling, localhost platform compatibility, or tenant consent. Record actual real-account test results as pass/fail/not tested; remove account identifiers before publishing evidence. Run `npm run verify` for any eventual implementation patch.

## 10. Questions for internal review

Please respond **supported / unsupported / needs experiment** with public evidence where possible:

1. Is the borrowed public-client registration (`VISUAL_STUDIO_PUBLIC_CLIENT_ID` in the baseline source) explicitly supported for an unrelated distributed application's identity-only login? What audience/platform/consent restrictions apply? An ID being public is not sufficient evidence.
2. Is a Fleet-owned shared public-client registration appropriate for the current self-hosted Node.js architecture and localhost callback? Does it require a native helper or a different supported topology?
3. For the installed MSAL Node version and both flows, which security checks are performed, and which are Fleet's responsibility?
4. What exact stable principal fields does a personal account return? Can current administrator keys survive a client-ID change, including guests, or is explicit re-enrollment required?
5. What exact registration platform, redirect path/port constraints, supported-account setting and consent scopes are required for both account classes? Is any device-flow flag necessary only for the optional flow?
6. What corporate Conditional Access / publisher verification / user-consent constraints must the UI explain? Do not request exceptions or access-policy changes solely for this demo.
7. Is the conservative legacy pinning and explicit migration plan sufficient to avoid privilege expansion and lockout?
8. If this proposal is unsuitable, recommend the smallest supported alternative and describe its effect on zero-tenant-configuration onboarding.

**Acceptance:** approve only once registration ownership/use is legitimate, real personal + organizational flows work in permitted tenants, validation is complete, and Host authorization remains closed to non-administrators. Otherwise keep the proposal pending and state the blocker. Internal conclusions may be summarized publicly only after removing restricted information; do not paste internal-only sources into this public repo.

## 11. Public references

Consulted 2026-09-06; portal labels and eligibility can change:

- [Register an application and choose supported account types](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app)
- [MSAL client configuration: common, organizations, consumers and authority/audience alignment](https://learn.microsoft.com/en-us/entra/identity-platform/msal-client-application-configuration)
- [Redirect URI restrictions and localhost behavior](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url)
- [Create a tenant and eligibility restrictions](https://learn.microsoft.com/en-us/entra/fundamentals/create-new-tenant)
- [Existing Fleet authentication design](./2026-08-27-microsoft-identity-auth-design.md)
- [Existing cleanup/implementation notes](./2026-08-31-microsoft-identity-auth-cleanup.md)

These references establish general platform capabilities, not approval of this specific architecture or of reusing another publisher's registration.
