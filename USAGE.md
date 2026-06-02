# Using collab

A task-oriented guide to driving a shared Claude Code session. For the
architecture and the security rationale, see the [README](README.md).

> **The one thing to internalize:** Claude runs on the **host's** machine, with the
> host's login, and edits the host's files. A guest with the link **and** join code
> can steer it — but **every tool call stops for the host's `y/N`**. The host is the
> only safety boundary; treat the link the way you'd treat an SSH invite.

---

## Roles

| | Host (`share`) | Guest (`join`) |
| --- | --- | --- |
| Runs Claude? | **Yes** — on this machine, with your login | No — pure mirror + input |
| Needs Claude Code installed + logged in? | **Yes** | No |
| Needs an API key? | No (reuses your Claude login) | No |
| Approves tool calls? | **Yes** (`y/N`) | No |
| Can end the session? | Yes (`/end`) | No (only `/quit` to leave) |

Anyone — host included — can type prompts into the one shared thread; the relay
puts them in a single global order so there's no race.

---

## Prerequisites

- **Node 20+** on every machine (`node -v`).
- **Host only:** Claude Code installed and logged in
  (<https://claude.com/claude-code>). The host drives *your* install — no API key.
- A **relay** both sides can reach (a WebSocket broker that runs no Claude). For
  local dev, run your own (see [Running your own relay](#running-your-own-relay)).

---

## Host a session

```bash
claude-collab share --name Alice
```

You'll see a banner with a **share link** and a **6-char join code**, the audit-log
path, then a status bar pinned at the bottom:

```
  ┌─ collab: shared Claude Code session ─────────────────
  │ share link : https://relay.example/claude-code/abx12kc9q1/
  │ join code  : 7QF3KP
  │ you        : Alice (host)
  └──────────────────────────────────────────────────────
  • audit log: ~/.collab/audit/abx12kc9q1.jsonl

  Alice*  ·  active  ·  host
```

Send the **link and the code** to your guests (the code is separate on purpose —
a leaked link alone can't join). Then type a prompt and press Enter. You'll see
Claude stream its reply under a `[claude] ▸` nameplate, and when Claude wants to
run a tool the prompt pauses for your approval:

```
🔐 Bash wants to run. Approve? [y/N]
   {"command":"npm test"}
```

Type `y` (or `yes`) to allow, anything else to deny. Parallel tool calls are asked
**one at a time**, and the decision line names the tool so you always know what you
answered.

End the session for everyone with `/end`.

## Join a session

```bash
claude-collab join "https://relay.example/claude-code/abx12kc9q1/" --name Bob --code 7QF3KP
```

Omit `--name`/`--code` and you'll be prompted. You'll see the live thread —
prompts (each person in their own color), Claude's streamed replies, tool activity
(metadata only, never raw output), and a status bar showing who's connected and
whether you can type. Type to add a prompt to the shared thread; leave with `/quit`.

Join late and you'll get a dimmed `— history —` replay to catch up, then live
events.

---

## In-session commands

| Command | Who | Effect |
| --- | --- | --- |
| `<text>` + Enter | anyone | send a prompt into the shared thread |
| `y` / `N` | host | approve / deny the tool Claude wants to run |
| `/readonly on` / `/readonly off` | host | lock guests to observe-only / reopen typing |
| `/end` | host | end the session for everyone (`ended` is final) |
| `/quit` | guest | leave the session |
| `Ctrl-C` | anyone | host: ends the session; guest: leaves |

## Recipes

**Lock guests to observe-only.** Start with `claude-collab share --readonly-guests`,
or flip it live with `/readonly on` (`/readonly off` reopens). Guests see the change
and their prompts are rejected by the relay while locked — handy for a demo where you
want an audience, not co-drivers.

**Resume yesterday's conversation.** `claude-collab share --resume` continues your
previous SDK conversation (the id is remembered in `~/.collab/last-session.json`).
It mints a *new* relay session (new link + code).

**Point at a remote relay.** `claude-collab share --relay wss://relay.example` (or
export `COLLAB_RELAY`). Plaintext `ws://` to a non-local host is **refused**; use
`wss://`, or `COLLAB_ALLOW_INSECURE=1` on a trusted private network.

---

## Options

### `share`

| Flag | Default | Meaning |
| --- | --- | --- |
| `--name <name>` | prompted | your display name |
| `--relay <url>` | `$COLLAB_RELAY` or `ws://localhost:8787` | relay to use |
| `--resume` | off | continue your previous SDK conversation |
| `--readonly-guests` | off | start with guests observe-only |
| `-h, --help` | | show help |

### `join`

| Arg / Flag | Default | Meaning |
| --- | --- | --- |
| `<share-link>` | required | the `http(s)://` link the host gave you |
| `--name <name>` | prompted | your display name |
| `--code <code>` | prompted | the 6-char join code |
| `-h, --help` | | show help |

## Environment variables

| Var | Used by | Effect |
| --- | --- | --- |
| `COLLAB_RELAY` | host | default relay URL |
| `COLLAB_CONTROL_TOKEN` | host, relay | if set on the relay, `POST /sessions` requires `Authorization: Bearer <token>`; the host sends it from this same var when minting |
| `COLLAB_ALLOW_INSECURE=1` | host, guest | allow plaintext `ws://` to a non-local relay (dev only) |
| `COLLAB_CLAUDE_PATH` | host | path to the `claude` binary to drive (else found on `PATH`, else the SDK's bundled copy) |

## Files on the host

| Path | What |
| --- | --- |
| `~/.collab/last-session.json` | last SDK session id, for `--resume` |
| `~/.collab/audit/<sessionId>.jsonl` | append-only audit log — every prompt (attributed) and every tool request + decision; `0600`, owner-only |

---

## Running your own relay

The relay is a separate service that runs **no Claude** — it mints sessions, checks
credentials, sequences and fans out events, and replays history to late joiners.

From source (local dev):

```bash
pnpm install
pnpm relay                      # → ws://localhost:8787
pnpm share -- --name Alice
pnpm join  -- "<share-link>" --name Bob --code <JOINCODE>
```

For anything beyond localhost: terminate **TLS** so clients connect over `wss://`,
and set **`COLLAB_CONTROL_TOKEN`** so not just anyone can mint sessions. See the
README's **Relay hardening** section for the full list.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Claude Code executable not found` (host) | Install Claude Code and log in, or set `COLLAB_CLAUDE_PATH` to the binary. |
| `refusing to send credentials over insecure ws://…` | You pointed at a non-local relay over `ws://`. Use `wss://`, or `COLLAB_ALLOW_INSECURE=1` on a trusted network. |
| `version_mismatch … update collab` | Host and guest (or relay) are on different protocol versions. Update everyone to the same release. |
| `observe-only: the host has disabled guest typing` | The host set `/readonly on`. Ask them for `/readonly off`. |
| `host is away; message not delivered` | The host disconnected — the session is paused. Your prompt lands once they reconnect. |
| `too many attempts; try again shortly` (guest) | Too many wrong join codes hit this session; it's briefly locked. Wait ~15s and re-check the code. |
| `bad join code` / `unknown session` | Wrong code, or the link/session expired (idle sessions are reaped after ~10 min empty; `/end` deletes immediately). |
| Guest's session just ended | The host ran `/end` (or disconnected and the session was reaped). Re-join a fresh session. |
