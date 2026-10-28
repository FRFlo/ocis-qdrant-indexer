# Multi-user behavior and acceptance plan

**Status:** target contract for implementation and integration tests.

## Scope

Affected flows:

- MCP HTTP authentication and MCP session ownership.
- ownCloud identity validation, accessible-drive discovery, and PAT persistence.
- `search_owncloud_docs` and the new `sync_owncloud_docs` tool.
- Qdrant collection creation, search, upsert, hash/reuse checks, metadata updates, deletion, and stale-path cleanup.
- NATS event routing and recovery/reconciliation.
- Container configuration and durable storage/key management.

The existing single-account global collection and shared bearer token are not acceptable authorization boundaries for private multi-user retrieval. Shared parsing, embeddings, document limits, retries, and NATS decoding must remain regression-tested.

## Target request behavior

1. MCP requests require HTTP Basic credentials containing an ownCloud username and that user's PAT. Missing, malformed, empty, or invalid credentials fail closed.
2. Validate credentials through ownCloud Graph. The server—not the caller—derives canonical user ID, opaque tenant ID, and accessible drives.
3. Bind an MCP session to the validated ownCloud identity. A different identity presenting the same session ID is rejected.
4. On the first successful authentication of an identity, persist its encrypted credentials and start one background initial sync. Do not block MCP initialization on the full scan; log sanitized start, completion, and failure summaries. Concurrent first requests must not start duplicate scans.
5. Before a search, refresh/validate the user's accessible drive list. Search only the matching per-user Qdrant collection and the IDs in that current list. An empty list yields no results.
6. `sync_owncloud_docs` enumerates and reads files only through that user's ownCloud credentials and authorized drives, then writes to that user's collection with a drive/space ID on every point.
7. On an ACL/share revocation, removed spaces are immediately excluded from search and are purged from that user's collection during synchronization/reconciliation.
8. NATS events are routed by `SpaceId` only to users whose ownCloud account can access that space. Same relative paths in different users or spaces must not collide. Missing `SpaceId` causes per-user reconciliation; it never causes global path-only indexing/deletion.
9. A failed ownCloud credential check, missing/unknown identity, unauthorized space, or failed content read must not fall back to a global collection, service account, admin impersonation, or caller-provided tenant ID.

## Realistic isolation scenario

Create ownCloud users **Alice** and **Bob**, each with a distinct PAT and at least one accessible drive. Put `Notes/plan.md` in both drives with different content. Give Alice access to one shared/project drive as well; do not grant Bob access to it.

Expected observations:

- Alice's first MCP authentication validates as Alice, creates/uses only Alice's Qdrant collection, and triggers her initial background sync.
- Alice's sync indexes her personal and authorized shared/project drive; Bob's sync indexes only Bob's personal drive.
- Searching for Alice-only content as Alice returns Alice's matching file. Searching as Bob returns no Alice result, including for the identical relative path.
- Bob cannot add Alice's `space_id`, path, or tenant ID to a tool argument to retrieve Alice's data.
- Alice's and Bob's writes, content-hash checks, updates, and deletes are scoped to separate collections and correct `space_id`; an event for one drive cannot mutate the other drive's same-path file.
- Reusing Alice's MCP session ID with Bob's valid PAT is rejected.
- Removing Alice's shared-drive permission removes that drive from her current search scope and removes its vectors on reconciliation.
- A NATS event with `SpaceId` routes only to users whose current ownCloud grants include that space. An event without `SpaceId` starts safe per-user reconciliation and never applies a path-only global mutation.
- Invalid/revoked PATs fail closed and do not expose stale search results.

## Observable acceptance criteria

| Area                   | Acceptance evidence                                                                                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication         | Unit tests cover missing/non-Basic/malformed credentials, ownCloud validation, server-derived identity, invalid PAT, and cross-user session rejection.                                                                       |
| Secret persistence     | Tests prove PAT round-trip after restart, no plaintext PAT bytes in the SQLite file, authenticated-encryption tamper failure, wrong-key failure, and key format validation.                                                  |
| Qdrant isolation       | Tests assert different users select different collections; each point has `space_id`; search uses only currently authorized drive IDs; cleanup/hash/metadata/upsert operations target the user collection and correct space. |
| OwnCloud authorization | Mocked client tests verify per-user Basic authorization, `/me` identity, `/me/drives` enumeration, and each drive's WebDAV root. Deployment verification must additionally test the deployed oCIS version.                   |
| NATS routing           | Tests cover known `SpaceId`, unknown space, missing `SpaceId`, duplicate relative paths, deletion, failed upload, revoked access, and per-user reconciliation.                                                               |
| End-to-end             | Two simulated users run MCP auth, sync, search, and NATS-triggered changes concurrently; no cross-user result or mutation is observed.                                                                                       |
| Regression             | Run the full `bun test` suite, formatter, and lint/check command; retain existing parsing, embedding, Qdrant, ownCloud, NATS, and MCP behavior tests that remain applicable.                                                 |

## Failure and security cases to exercise

- A malicious or buggy client sends `tenantId`, `userId`, or `spaceId` parameters: they are ignored for authorization or rejected; only validated server context controls scope.
- Alice and Bob use the same path or filename: their data and deletes remain independent.
- A valid user supplies a different user's session ID: reject before dispatching MCP tools.
- A PAT is wrong, revoked, rotated, or Graph is unavailable: do not fall back to another credential or return global data.
- A drive disappears from `/me/drives`: exclude it from the next search and reconcile its collection data.
- A NATS event has no `SpaceId`, an unknown ID, or a path that exists in multiple spaces: perform safe reconciliation or no-op; never guess by path.
- Encryption key is missing, malformed, changed, or the ciphertext/tag is modified: startup or decryption fails closed without returning a PAT.

## Test execution sequence

1. Unit-test Basic parsing and ownCloud-validated identity/session ownership.
2. Unit-test encrypted SQLite storage and key/tamper failure behavior.
3. Unit-test per-user collection and per-space Qdrant filters for every operation.
4. Unit-test ownCloud user/drive discovery and per-drive WebDAV access.
5. Unit-test sync, stale-path removal, and NATS `SpaceId` routing/reconciliation.
6. Run the two-user end-to-end scenario with mocked ownCloud/NATS/Qdrant boundaries.
7. Run all repository tests and static checks; separately validate API/token behavior against the deployed oCIS version before production rollout.
