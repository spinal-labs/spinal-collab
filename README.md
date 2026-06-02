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

| package             | name                      | role                                      |
| ------------------- | ------------------------- | ----------------------------------------- |
| `packages/protocol` | `@spinal/collab-protocol` | wire types + zod schemas (the contract)   |
| `packages/relay`    | `@spinal/collab-relay`    | the cloud broker                          |
| `packages/cli`      | `@spinal/collab`          | the `collab share` / `collab join` binary |

## Install

`spinal-collab` is a Node app (one cross-platform tarball; needs **Node 20+**).
It drives **your own installed Claude Code** — install that first
(<https://claude.com/claude-code>) and be logged in.

```bash
# curl | sh — downloads the latest GitHub Release, verifies its checksum
curl -fsSL https://raw.githubusercontent.com/spinal-labs/spinal-collab/main/release/cli/install.sh | sh
```

> Pin a version with `SPINAL_COLLAB_VERSION=x.y.z`, or point at a fork with
> `SPINAL_COLLAB_REPO=owner/repo`.

The host resolves the Claude executable via `SPINAL_CLAUDE_PATH`, else `claude`
on `PATH`, else the SDK's bundled copy. Release tooling lives in
[release/cli](release/cli) (pnpm-deploy tarball + installer); the workflow
[.github/workflows/release.yaml](.github/workflows/release.yaml)
builds the tarball and publishes it as a **GitHub Release** (no external infra,
no secrets — just the built-in `GITHUB_TOKEN`).

## Run it (3 terminals, localhost)

```bash
# Installed CLI:
spinal-collab share --name Alice                 # host: prints a share link + join code
spinal-collab join "<share-link>" --name Bob --code <JOINCODE>   # guest

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
troubleshooting. Or run `spinal-collab help` (and `help share` / `help join`).

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
  spinal-collab share --name Alice
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
  <<<<<<< HEAD
  =======

## Status (MVP)

Implemented: shared SDK loop; sequenced relay with replay (flagged `replay:true`);
attribution; host-only tool approval; tool results redacted to metadata-only
(name · ok/error · size — never raw output); presence + whole-message typing;
mid-turn `(queued)` markers; reconnect with resume-from-seq; stable guest
identity via a self-minted `clientId`; `/end` → `ended` for everyone;
`collab share --resume` to continue the previous SDK conversation
(`options.resume`); a `PROTOCOL_VERSION` handshake (mismatched clients are
rejected, not looped); and a terminal UI that gives every speaker — Claude
included — a colored nameplate plus a sticky status bar (roster · state · your
mode). `ws://` for localhost, `wss://` to a remote relay (see Transport security).

**Transport security.** The host token and join code travel as WebSocket upgrade
headers (`x-collab-token` / `x-collab-code`), never in the URL — so they don't
leak via proxy/access logs or `Referer`. Only the session id (already public in
the share link) is a query param. Connecting to a **non-localhost** relay over
plaintext `ws://` is refused; use `wss://`, or set `COLLAB_ALLOW_INSECURE=1` to
override on a trusted private network. All untrusted text (guest prompts, model
output, tool summaries) is stripped of terminal control sequences before display,
so a participant can't repaint the host's screen to spoof the approval prompt.

**Relay hardening.** Frames are capped (`maxPayload` 1 MiB; `user_message`
content 100k chars). A 30s heartbeat pings clients and `terminate()`s any that
stop ponging, so a half-open host doesn't hold its slot. Slow consumers whose
outbound buffer exceeds 4 MiB are dropped (they reconnect + replay). Bad join
codes are throttled per session (lock after 8, 15s cooldown). Idle sessions —
empty for 10 min — are reaped, and `/end` deletes immediately (`ended` is
terminal; the token can't reopen it). Set `COLLAB_CONTROL_TOKEN` on the relay to
require `Authorization: Bearer <token>` on `POST /sessions` (recommended for any
non-local deployment); the host sends it from the same env var when minting.

**Accountability & guest policy.** The host keeps an append-only **audit log** at
`~/.collab/audit/<sessionId>.jsonl` (0600) — every prompt (attributed) and every
tool request + host decision, where the actions actually run. Guests can be made
**observe-only**: `spinal-collab share --readonly-guests`, or toggle at runtime
with `/readonly on` / `/readonly off`. The relay enforces it (a read-only guest's
prompt is soft-rejected), and guests see the policy in their banner and live.

**Not verified end-to-end:** a real three-terminal run with a live model turn —
that needs Claude Code installed + authenticated on the host. The automated tests
exercise everything up to (but not including) the SDK loop itself.

Not yet (see the plan): a real hosted `wss://` relay deploy (the clients already
refuse plaintext to a remote relay, but there's no hosted endpoint yet);
host-approves-join handshake; draft/keystroke mirroring; persistence/DB (sessions
are in-memory; idle ones are reaped and `/end` deletes, but a relay restart still
drops history); per-tool permission formatting + "which guest triggered this"
attribution; an optional git-worktree sandbox for the agent; opt-in
`--share-tool-output`.

## License

MIT © Spinal Labs — see [LICENSE](LICENSE).

spinal-collab is an independent tool for [Claude Code](https://claude.com/claude-code);
it is not affiliated with, sponsored by, or endorsed by Anthropic.
