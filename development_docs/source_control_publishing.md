# Source-control publishing

marimohub can publish edits from a git-synced notebook as a provider change request. The first
implementation opens a draft GitHub pull request through a GitHub App and writes back only the
configured entry notebook.

## Trust boundary

The notebook sandbox is an untrusted content producer. It can supply changed file bytes, but it
never receives a GitHub private key, installation token, or repository write credential. The
control plane validates the session and project role, records an immutable proposal, and asks a
server-side publisher adapter to perform the provider API calls.

Opening a change request requires all of the following:

- the caller has the project `manager` or `admin` role;
- the session is a running, persistent edit session;
- the session was created from an immutable git-synced version;
- the edited entry notebook differs from that version; and
- a publisher for the version's provider is configured.

The API uses the session's source version and commit, not the notebook's current head. A push that
lands while someone is editing therefore cannot silently move the proposed change onto a different
base.

The endpoint is
`POST /api/v1/projects/{pid}/notebooks/{nid}/sessions/{sid}/change-requests`. It requires an
`Idempotency-Key` header. The key determines a stable proposal id and provider branch, so retrying
after a timeout or partial provider failure resumes the same publication instead of creating a
second provider change request. By default, the endpoint creates a new change request. Supplying a
published proposal as `target_proposal_id` captures a new immutable proposal and publishes it to
that proposal's existing change request.

## GitHub App setup

Create a GitHub App with these repository permissions:

- Contents: read and write
- Pull requests: read and write

Install the app only on repositories marimohub may publish to. Configure
`MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID` and
`MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY` on the server. Set both variables to enable
GitHub publishing; setting only one fails startup. The key may be PEM or a single-line base64
encoding of the PEM. No GitHub App webhook is required.

The installation's selected repositories are the v1 repository authorization boundary. The
adapter discovers the installation from the notebook's stored repository coordinate; marimohub
does not maintain a second allowlist that binds projects or tenants to installations. A project
manager who can configure a git-synced notebook can therefore publish to any repository on which
this App is installed. Multi-tenant deployments should use narrowly selected installations and
must not install this App across repositories that project managers should not share.

For each request, the adapter discovers the installation for the target repository and mints a
short-lived token restricted to that repository and those two permissions. It creates blobs, a
tree and commit based on the exact synced commit, then creates a deterministic
`marimohub/<notebook-id>/<proposal-id>` branch and draft pull request. Retrying publication of the
same proposal returns the existing pull request.

An update normally appends a commit to the existing pull-request branch. If the captured file
operations no longer apply to that branch, the adapter rebuilds the proposal from its original
base and attempts a force update. The force update is conditional on the branch still pointing to
the commit marimohub previously published, so collaborator or automation changes are never
overwritten. A closed pull request or deleted branch must be replaced with a new pull request.

## Stored proposal

Proposal content is separate from provider state:

```text
projects/<project-id>/notebooks/<notebook-id>/proposals/<proposal-id>/
  proposal.json       immutable manifest, provenance, and content hashes
  changes/<index>      temporary changed file bytes
  publication.json    CAS-managed publication result

_system/proposal-payloads/<project-id>/<notebook-id>/<proposal-id>.json
  immutable expiry marker for the temporary change bytes
```

The manifest already supports multiple `add`, `modify`, and `delete` changes even though the first
capture path emits one `modify` for the entry notebook. `publication.json` is the only mutable
record and makes completed publication retries cheap.

Capture creates `proposal.json`, each change object, and the initial publication state with
create-if-absent writes. `proposal.json` is the atomic claim for an idempotency key. A concurrent
loser reuses that manifest only when its session, author, source version, and content hash match.
Interrupted captures leave their immutable objects for a matching retry to complete; they never
delete or overwrite objects that another attempt may own.

Change bytes expire 24 hours after capture. An expired pending proposal rejects capture and
publication with `PROPOSAL_RETRY_REQUIRED`. The same response protects a proposal whose provider
branch no longer has the captured base parent and content tree. The maintenance sweep waits one
additional hour for in-flight requests, then deletes only `changes/<index>` and its expiry marker.
It retains `proposal.json` and `publication.json` as audit metadata.

## V1 boundaries

V1 exposes only the combined capture-and-publish endpoint. It does not expose proposal list,
detail, discard, or patch-download endpoints, so a deployment without a configured publisher
cannot use proposal storage independently. Those APIs are deferred rather than implied by the
stored format.

The required idempotency key protects retries of one operation. The web client reuses its key
after transient failures. It uses a new key after success and when the server returns
`PROPOSAL_RETRY_REQUIRED`. The provider branch is stable for that proposal. Choosing Update creates
a new proposal that targets the displayed change request; choosing Create new omits the target and
replaces the displayed link without closing or deleting the old provider change request. A later
operation with a new key creates another proposal even when the sandbox content is unchanged. Content-level
deduplication needs an atomic object-store uniqueness claim; scanning proposal manifests would
still race under concurrent requests and is not used as a substitute.

The combined endpoint requires a project manager. A future standalone capture endpoint can permit
editors to save proposals while retaining manager approval for publication. Provider commits use
the GitHub App identity; the marimohub user remains in the proposal manifest and audit event rather
than being sent to GitHub as a commit author.

## Extension path

Provider support lives behind `SourceControlPublisher`; the API and proposal service do not import
the GitHub adapter. The port has a required create operation and an optional update operation. A
GitLab, Bitbucket, or other provider adds an adapter and registers it in the configuration
composition root. The provider owns authentication and API-specific branch/merge request
operations, while the proposal format and authorization remain unchanged.

Full-workspace sync is a capture-policy extension, not a provider rewrite. It should compare the
sandbox workspace against the immutable version workspace, enforce file-count and total-byte
limits, and emit a multi-file proposal. Before enabling deletes, the capture policy must define
ignored paths and generated/runtime files so scratch state cannot be removed from a repository by
accident.
