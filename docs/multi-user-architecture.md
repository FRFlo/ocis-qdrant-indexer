# Multi-user architecture decisions

**Status:** agreed MVP target; implementation and deployment compatibility checks are ongoing.

## Authentication options considered

| Option                                                          | Benefits                                                                                                                                                                                    | Costs and risks                                                                                                                                                                                                                                             | Decision                                                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| ownCloud OAuth/OIDC per MCP request                             | Standard delegated authorization; short-lived access tokens and centralized revocation; avoids collecting a long-lived PAT.                                                                 | The MCP client and issuer are not fixed. Token audience, scopes, refresh-token behavior, WebDAV compatibility, and unattended NATS processing would all need validation. OAuth alone does not authorize NATS subscriptions or establish Qdrant isolation.   | Not the MVP. Revisit once the client/issuer and durable delegation flow are selected.                              |
| HTTP Basic with each user's ownCloud username + app token (PAT) | Fits the current ownCloud/WebDAV app-token access pattern and supports durable user-delegated indexing and NATS-triggered work. No shared service account or admin impersonation is needed. | PATs are long-lived secrets; the MCP endpoint must use TLS, verify each credential with ownCloud, encrypt stored PATs, avoid logging them, and provide rotation/revocation handling. Basic authentication is not safe over plaintext HTTP.                  | **Chosen for the MVP as the single user-authentication mode.**                                                     |
| Shared ownCloud service account / admin impersonation           | Potentially centralizes continuous indexing.                                                                                                                                                | A service token only has the account's actual rights; oCIS service-account documentation does not establish general content-read access to every user's private files. Admin impersonation is high risk and bypasses the user's own authorization boundary. | Rejected for private multi-user content. Do not assume that cross-space metadata access permits content downloads. |

### Confirmed identity and access choices

- A user presents their **own ownCloud username and PAT** as HTTP Basic credentials to MCP. There is no shared `MCP_AUTH_TOKEN` as the user's authorization identity.
- The server verifies the credentials against the configured ownCloud Graph API and derives tenant identity from the validated ownCloud user ID, never from a request parameter or path.
- Store each PAT and the user's currently accessible drive/space IDs durably, with AES-256-GCM authenticated encryption at rest and a deployment-managed 32-byte encryption key.
- Include every drive/space returned for that user, including personal, shared, and project spaces, subject to the permissions ownCloud grants that user.
- Use a separate Qdrant collection per validated ownCloud identity, and constrain operations within that collection to currently authorized `space_id` values. Relative paths are not globally unique.
- Add `sync_owncloud_docs` for a user's on-demand backfill. Keep NATS event ingestion for functional parity; NATS authentication remains the deployment's existing `NATS_URL` configuration, independent of ownCloud PAT validation.
- Route NATS events using `SpaceId` and the registered users' ownCloud authorization. A path is never sufficient to identify a tenant. An event without a usable `SpaceId` triggers safe per-user reconciliation.
- Do not use admin impersonation or a service account to silently read private content.

## Qdrant partition alternatives

| Strategy                                      | Advantages                                                                                                                                                    | Disadvantages                                                                                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared collection with tenant payload filters | Fewer collections and simpler collection administration.                                                                                                      | Every query, deletion, hash lookup, and maintenance path must apply a mandatory tenant filter. A missed filter can leak or corrupt another user's data; same-path point IDs can collide. |
| Per-user collection, plus space filters       | Collection boundary gives an additional isolation layer; same path in different users cannot collide; lifecycle and access checks are easier to reason about. | More collections and operational metadata; space-level filtering and collection cleanup are still required.                                                                              |

**Chosen:** per-user collections, with `space_id` filters inside each collection to distinguish accessible drives/spaces belonging to the same user. Collection identity is an opaque hash of the validated ownCloud user ID.

## Continuous indexing and NATS

The first successful MCP authentication automatically starts a background sync for the newly registered user. `sync_owncloud_docs` starts explicit re-syncs in the background and returns immediately rather than holding the MCP tool call open for the duration of indexing; a duplicate request does not start another sync. Completion and failure summaries are logged without credentials or file contents. Startup reconciliation covers users already registered when the service starts.

OAuth for MCP does not automatically authorize NATS subscriptions. NATS has its own authentication and subject-level authorization; the repository's `NATS_URL` credentials are independent from ownCloud PATs. The MVP preserves that deployment-level NATS configuration rather than introducing NATS OAuth/Auth Callout.

For each event with `SpaceId`, only registered users whose ownCloud account currently exposes that space may be considered. Content reads are made with that user's PAT, not a global account. If the event has no `SpaceId`, reconcile registered users individually; never infer ownership from a matching path. This is safer but can create additional load.

## Deployment prerequisites and risks

1. Configure ownCloud Graph API and WebDAV URLs for the deployed oCIS version; validate that the user's app token can call `/me`, enumerate `/me/drives`, and read/download content in each returned drive.
2. Test shared/project drive discovery and WebDAV routing in the actual deployment. API shape and permissions are version/configuration dependent.
3. Serve MCP only over TLS. Basic sends the username and PAT on every request.
4. Set `USER_STORE_ENCRYPTION_KEY` to a stable 32-byte key (base64 or 64-character hex), persist the SQLite file at `USER_STORE_PATH`, and back up the database and key separately. Losing the key makes stored PATs undecryptable.
5. Define PAT rotation/revocation and stale-vector cleanup operationally. A revoked share must immediately stop appearing in the current authorized-space filter; stored vectors should then be removed during reconciliation.
6. Treat NATS event payloads as triggers, not authorization grants. The user's ownCloud access remains the content authorization boundary.

## Confirmed user choices in conversation

The user selected: private ownCloud content per user; own username + PAT (not OAuth refresh tokens) as the single MVP credential mode; all ownCloud-accessible drives/spaces; per-user Qdrant collections; on-demand sync plus NATS parity; existing deployment-level NATS authentication; `SpaceId`-based event routing; and per-user reconciliation when an event has no usable `SpaceId`.
