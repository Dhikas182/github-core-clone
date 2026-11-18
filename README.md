# makefun-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Dhikas182/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Dhikas182/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Built for [make.fun bounty github-core-clone-01](https://make.fun/bounty/github-core-clone-01).

A GitHub-compatible git forge in a single Node 22 process, using only the
Node standard library. No git binary, no dependencies, no outside service,
no UI.

## What it serves

From one process and one in-memory store:

1. **Git smart HTTP** at `/{owner}/{repo}.git`
   - upload-pack protocol v2 (`ls-refs`, `fetch`, shallow/deepen) and v0
   - receive-pack v0 with report-status, side-band-64k, delete-refs
   - Full pack reading and writing (plain objects, OFS_DELTA and REF_DELTA),
     fast-forward enforcement, branch/tag create, update and delete.
2. **REST v3** under `/api/v3` — repositories, issues, pull requests,
   contents, labels, comments, git refs and branches, with GitHub-style
   pagination (`Link` headers), error shapes (`{"message": ...}`) and the
   `X-GitHub-Request-Id` header on every reply.
3. **GraphQL** at `/api/graphql` — the documents `gh` and
   `github-mcp-server` send: viewer, repository, issue/issues (cursor
   pagination), pullRequests/pullRequest, `__type` introspection, `node(id:)`,
   batched documents, and the createIssue / closeIssue / createPullRequest /
   mergePullRequest / addComment mutations.
4. **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP: `server/discover`
   (2026-07-28), the legacy `initialize` handshake, `tools/list` and
   `tools/call` for `create_repo`, `get_repo`, `create_issue`, `list_issues`,
   `create_pull_request`, `merge_pull_request`, `get_issue` and
   `list_pull_requests`.

## How to run it

```sh
node main.ts
```

Environment (set by the grading suite):

- `MAKEFUN_ENV_URL` — the suite env to register with and poll for `/done`.
  When unset, the forge runs standalone on `127.0.0.1:18080` (or `$PORT`).
- `MAKEFUN_SHOP_TOKEN` — the bearer token the forge expects on every
  request except `/healthz`.

Lifecycle: bind an ephemeral port, `POST {"port": n}` to
`$MAKEFUN_ENV_URL/register`, serve, long-poll `GET $MAKEFUN_ENV_URL/done`
until `{"done": true}`, then exit 0.

## Determinism

The store keeps no clock and no randomness. Every timestamp is a fixed base
epoch plus a monotonic creation-sequence counter, so two runs on the same
instance leave the same state export byte for byte.

## Layout

- `main.ts` — the whole forge (HTTP server, git pack protocol, REST,
  GraphQL, MCP).
- `.makefun/owner.json` — the entry owner's wallet.
- `LICENSE` — MIT.
