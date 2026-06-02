# collab — a shared Claude Code session

Two (or more) people drive **one** Claude conversation from their own terminals.
One person hosts; everyone else mirrors the live thread and can type into it,
attributed. Claude runs on the **host's** machine with the host's credentials —
so the host needs Claude Code installed and authenticated, and **nobody needs an
API key**: the Agent SDK reuses the host's existing login.

> ⚠️ A guest with the link + join code can make Claude **edit files and run
> commands on the host's machine**. The link is a remote-control credential, like
> an SSH invite — not a screen share. Only the host approves tool use.

## Architecture

```
  host terminal                cloud relay                 guest terminal(s)
  ┌───────────────┐   ws    ┌──────────────────┐   ws    ┌────────────────┐
  │ Agent SDK loop│◀───────▶│ sequencer +      │◀───────▶│ live mirror +  │
  │ (runs Claude) │ host_evt│ broadcast +      │ events  │ input (no LLM) │
  │ edits land    │ user_msg│ replay log       │         │                │
  │ here          │         └──────────────────┘         └────────────────┘
  └───────────────┘
```

- **Host** runs the single `query()` loop fed by a never-returning `AsyncQueue`.
  Every human prompt (host's own included) round-trips through the relay so the
  SDK consumes in one globally-sequenced order — no host/guest race.
- **Relay** runs no Claude. It mints sessions, checks credentials, assigns a
  monotonic `seq` to durable events, fans them out, and replays history to late
  joiners. Token deltas are broadcast live but excluded from the replay log.
- **Guest** renders entirely from relay events and sends prompts. The host-only
  `canUseTool` callback is the real safety boundary.

## Packages

| package | name | role |
| --- | --- | --- |
| `packages/protocol` | `@claude-collab/protocol` | wire types + zod schemas (the contract) |
| `packages/relay` | `@claude-collab/relay` | the cloud broker |
| `packages/cli` | `@claude-collab/cli` | the `collab share` / `collab join` binary |

## Install

`claude-collab` is a Node app (one cross-platform tarball; needs **Node 20+**).
It drives **your own installed Claude Code** — install that first
(<https://claude.com/claude-code>) and be logged in.

```bash
# curl | sh — downloads the latest GitHub Release, verifies its checksum
curl -fsSL https://raw.githubusercontent.com/spinal-labs/claude-collab/main/release/cli/install.sh | sh
```

> Pin a version with `CLAUDE_COLLAB_VERSION=x.y.z`, or point at a fork with
> `CLAUDE_COLLAB_REPO=owner/repo`.

The host resolves the Claude executable via `COLLAB_CLAUDE_PATH`, else `claude`
on `PATH`, else the SDK's bundled copy. Release tooling lives in
[release/cli](release/cli) (pnpm-deploy tarball + installer); the workflow
[.github/workflows/collab-cli-release.yaml](.github/workflows/collab-cli-release.yaml)
builds the tarball and publishes it as a **GitHub Release** (no external infra,
no secrets — just the built-in `GITHUB_TOKEN`).

## Run it (3 terminals, localhost)

```bash
# Installed CLI:
claude-collab share --name Alice                 # host: prints a share link + join code
claude-collab join "<share-link>" --name Bob --code <JOINCODE>   # guest

# The relay is a separate service. For local dev, run from source (pnpm):
pnpm install
pnpm relay                          # → ws://localhost:8787
pnpm share -- --name Alice          # host (from source, via tsx)
pnpm join  -- "<share-link>" --name Bob --code <JOINCODE>
```

Then on the host, type a prompt and press Enter — the guest sees the attributed
prompt, streaming tokens, the finalized message, and any tool use. The guest can
type back; both see the same answer and Claude can address each person by name.
When Claude wants to run a tool, only the **host** is asked `y/N`.

`/end` (host) stops the session; `/quit` (guest) leaves it; `/readonly on|off`
(host) toggles whether guests may type.

**Full how-to:** [USAGE.md](USAGE.md) — roles, every flag and env var,
in-session commands, recipes (observe-only, resume, remote relay), and
troubleshooting. Or run `claude-collab help` (and `help share` / `help join`).

## Deploy the relay (one host, auto-HTTPS)

The relay needs `wss://` for anyone off localhost (the CLI refuses plaintext to a
remote relay). [docker-compose.prod.yml](docker-compose.prod.yml) runs it behind
[Caddy](infrastructure/caddy/Caddyfile), which fetches and renews a Let's Encrypt
cert automatically. On a Docker host (e.g. EC2) with a domain pointed at it and
ports 80+443 open:

```bash
cp .env.example .env            # then set COLLAB_DOMAIN + COLLAB_CONTROL_TOKEN
# (generate a token with: openssl rand -hex 32)
docker compose -f docker-compose.prod.yml up -d --build
```

That's the whole deploy — `wss://relay.yourdomain.com`, TLS handled, minting gated.
Hosts then point at it (guests just use the share link the host prints):

```bash
COLLAB_RELAY=wss://relay.yourdomain.com COLLAB_CONTROL_TOKEN=<same token> \
  claude-collab share --name Alice
```

Caveats: sessions are in-memory (a relay restart drops active ones) and it's a
single node (no horizontal scale yet) — fine for a team, see the plan for beyond.

## Test

```bash
pnpm test
```

- `inputQueue.test.ts` — the load-bearing `AsyncQueue`: FIFO ordering and the
  critical "does not terminate while momentarily empty" invariant.
- `terminal.test.ts` — the control-sequence sanitizer (no approval-UI spoofing)
  and the renderer: the Claude nameplate streams once per line, a committed line
  redraws the sticky status bar, identity colors stay disjoint from status colors,
  and the status bar truncates to width.
- `sessionStore.test.ts` — idle reaping, the join-code throttle, and the durable
  log's ring-buffer cap + `replay_gap` signal (with an injected clock).
- `server.test.ts` — the full host↔relay↔guest path over real WebSockets:
  header-based credential checks, sequencing, attribution, fan-out, the permission
  boundary (a guest cannot forge a `host_event`), late-join replay with the
  explicit `replay:true` flag, stable guest identity across reconnects, `/end` →
  `session.state: ended` (terminal — the token can't reopen it), the mid-turn
  `(queued)` marker, protocol-version mismatch rejection, and read-only-guest
  enforcement. A synthetic host stands in for the SDK loop.
