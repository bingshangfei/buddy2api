# buddy2api

English | [简体中文](README.md)

A self-hosted gateway that wraps the **WorkBuddy / CodeBuddy CLI** into OpenAI- and Anthropic-compatible APIs, so any tool that speaks the OpenAI or Anthropic wire format can use it.

buddy2api launches and manages a `codebuddy --serve` process (CodeBuddy's HTTP/ACP service mode) and acts as a translation layer: it turns OpenAI-format `/v1/chat/completions` requests into ACP protocol calls, and streams the output back as OpenAI SSE.

**The backend process is managed by buddy2api itself.** The WorkBuddy desktop app only needs to be installed once (to provide the CLI binary) — it does not need to stay running. During install, the onboarding wizard copies the CLI into the install directory and pins it there, so later WorkBuddy upgrades or uninstalls won't affect it.

> This is an unofficial, community-maintained tool with no affiliation to Tencent. Please read the [Usage Statement](#usage-statement-must-read) before use.

## Usage Statement (must read)

This project has exactly one purpose: **to help individuals manage their own WorkBuddy/CodeBuddy accounts** — providing an OpenAI-compatible endpoint for your own local tools, plus convenient automatic daily check-in. It is free, open source, and provided "as is" for personal use.

1. **Personal accounts only.** This project does not support or authorize any public API resale, account-pool rental, mass account registration, or license-key distribution. Mass registration and reselling API quota violate the target platform's terms of service; any consequences (account bans, terms violations, legal risk) are borne solely by those who do it.
2. **Unofficial tool, use at your own risk.** This project talks to the official CLI by reverse-engineering the ACP protocol. The upstream provider (Tencent) may change interfaces or tighten risk controls at any time, breaking it. Any account risk-control action or ban caused by using a non-official client is your own responsibility.
3. **An honest note on the MIT license.** MIT grants freedom at the code level; it does not grant the right to advertise, sell, or bundle-distribute under this project's name, nor to demand support or endorsement from the author. Do not buy any "paid" or "license-key" edition — any re-packaged, encrypted, or paid distribution is a tampered artifact that cannot be audited and may steal your credentials.
4. **The author reserves the right to cut losses.** If abuse continues, the author may stop maintaining, close, or delete the repository at any time without notice.

## AI-Assistance Disclosure

This project is **developed with deep AI collaboration**: architecture, business intent, and acceptance are held by a human, while the majority of the code was implemented end-to-end by AI coding agents (including reverse-engineering analysis, request-path scheduling, and tests). Merge and release decisions are made by the maintainer. When contributing, follow the disclosure requirements in [CONTRIBUTING.md](CONTRIBUTING.md).

## Contents

- [Features](#features) / [How It Works](#how-it-works)
- [Quick Start](#quick-start) (installer / from source / WorkBuddy prerequisite)
- [Login](#login-first-run) / [Account Pool](#account-pool-rotation--failover) / [Daily Check-in](#daily-check-in)
- [Backend CLI Source & Upgrade](#backend-cli-source--upgrade) / [Environment Variables](#environment-variables) / [Token Usage Stats](#token-usage-stats)
- Clients: [OpenAI Reasoning](#openai-reasoning-content) / [Anthropic Messages](#anthropic-messages-api-compatibility) / [Available Models](#available-models)

## Features

- ✅ OpenAI-compatible `/v1/chat/completions` (`stream: true/false`)
- ✅ **Anthropic Messages-compatible `/v1/messages`** — official `@anthropic-ai/sdk` / Claude Code and similar clients can point at it directly, with streaming SSE event order and a full tool-calling loop
- ✅ OpenAI-compatible `/v1/models` (model list fetched dynamically from the codebuddy session config)
- ✅ Model selection (`auto`, `glm-5.3`, `deepseek-v4-pro`, `kimi-k3-1`, etc.)
- ✅ Multi-turn conversations (full history passed as context)
- ✅ Reasoning echo: the model's chain-of-thought is returned via the `reasoning_content` field (DeepSeek-style), **toggleable per request** (see [OpenAI Reasoning](#openai-reasoning-content))
- ✅ Prompt sanitization: identity strings injected by clients (`ZCode` / `opencode`, etc.) are automatically replaced with `workbuddy`
- ✅ Session isolation: no inherited session context; multi-turn requests for the same conversation reuse the backend session and send only the delta (stable prefix-cache hits)
- ✅ Connection reuse + self-healing: broken connections are rebuilt and retried once; two-level stall guards (first-token / mid-stream) trigger automatic continuation (at most 3 times per request)
- ✅ **Self-hosted backend**: launches `codebuddy --serve` automatically, restarts on crash at the next request
- ✅ Token usage stats: `GET /v1/usage`, aggregated by model/key plus per-request detail, persisted as JSONL
- ✅ No API key required (local service — any key or none works)

## How It Works

```
┌──────────────┐   OpenAI format   ┌──────────────────────┐   ACP protocol  ┌────────────────────┐
│ OpenAI client│ ────────────────> │  buddy2api proxy      │ ──────────────> │ codebuddy --serve  │
│              │ /v1/chat/completions│  (Node.js, :8000)    │   JSON-RPC      │  backend pool (1..5)│
└──────────────┘ <──────────────── └──────────────────────┘ <────────────── └────────────────────┘
                    OpenAI SSE format
```

**Concurrency isolation**: the backend is a process pool. Each concurrent request gets an **independent backend process + independent session** and never interferes with others; serial requests reuse freed backends. When the pool is full (default 5, tunable via `BUDDY2API_MAX_BACKENDS`) new requests queue; backends idle longer than 2 hours are reclaimed (tunable via `BUDDY2API_IDLE_TIMEOUT_MS`).

**Credential injection**: when a backend starts, the accessToken from the login state is explicitly injected into the child process via `CODEBUDDY_AUTH_TOKEN`. Login therefore depends on a single credential file and is unaffected by the CLI's own storage state (we've seen the CLI report `Authentication required` while the same accessToken was still valid).

## Quick Start

### Prerequisite: the Tencent WorkBuddy desktop app

buddy2api's backend is the `codebuddy` CLI, which ships with the Tencent WorkBuddy desktop app and is **not redistributed with this repo** (Tencent proprietary software). Install the WorkBuddy desktop app first. If the CLI is at a non-standard path, set `CODEBUDDY_CLI_PATH` to point at its `bin/codebuddy`.

Where the CLI comes from, by install method:

| Method | CLI source |
|---|---|
| Windows installer | The onboarding wizard copies it from your local WorkBuddy into the install directory (a pinned copy, unaffected by WorkBuddy upgrades) |
| From source | `npm run vendor:update` syncs it from your local WorkBuddy (or skip this and fall back to the system-installed CLI at runtime) |
| macOS dmg | The builder extracts it from the macOS WorkBuddy build on their machine (building the dmg from source likewise requires your own WorkBuddy) |

> ⚠️ Do **not** run `git clean -X` / `git clean -fdX` on this repo: it physically deletes the on-disk `vendor/` copy, which is unrecoverable on a machine where WorkBuddy has been uninstalled (you'd need to reinstall WorkBuddy or re-run `vendor:update`).

### Option A: Installer (recommended, best for a new machine)

Double-click `buddy2api-setup-<version>.exe` and click through:

- **No admin rights needed**: installs to `%LOCALAPPDATA%\Programs\buddy2api` by default (per-user)
- **No Node.js needed**: the installer bundles a portable `runtime\node.exe`; all scripts prefer it automatically
- **WorkBuddy must be installed first**: on the finish page, tick "Configure now" to launch the **onboarding wizard**, which copies the codebuddy CLI from your local WorkBuddy into the install directory (~94MB, one-time), then guides you through login → start service → optional auto-start / daily check-in
- Desktop and Start Menu shortcuts are created automatically
- On uninstall, the service is stopped, leftover backend processes cleaned, scheduled tasks and shortcuts removed; `data\` (account records) and `~/.codebuddy` (login credentials) are kept by default

The installer itself is built by `installer/build.ps1` (run locally, produces a single-file exe):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File installer/build.ps1
# Output: installer/dist/buddy2api-setup-<version>.exe
```

The build toolchain is vendored under `installer/toolchain/` (Inno Setup command-line compiler + Simplified Chinese language pack), so you don't need Inno Setup installed locally.

### Option B: From source (development)

```bash
# 0. Prepare the backend CLI: if WorkBuddy is installed locally, sync a copy into vendor/
npm run vendor:update
# (You can skip this — at runtime it falls back to the system-installed WorkBuddy CLI)

# 1. No third-party dependencies; only Node.js 18+ required
# 2. Start the proxy
npm start
# or
node src/index.js
```

Once started:

```
🚀 buddy2api server running at http://127.0.0.1:8000
   OpenAI-compatible API: http://127.0.0.1:8000/v1
```

The first request triggers backend startup; when these two lines appear in the log it's ready:

```
[gateway-pool] Using CLI: .../vendor/codebuddy-cli/bin/codebuddy (vendor copy)
[gateway-pool] Started backend at http://127.0.0.1:xxxxx (PID xxxx)
```

## Login (first run)

Prerequisite: the backend CLI is in place (the installer wizard does this automatically; for source runs see `npm run vendor:update`). What's missing is just the account credential:

```bash
npm run login              # Check login status; print guidance if not logged in
npm run login -- --open    # Launch the interactive CLI login UI directly when not logged in
npm run account            # Just show account and balance
```

The CLI's `/login` is itself the "switch account" command. To add an account, run `npm run accounts -- add`, type `/login` in the CLI window that opens, complete browser authorization, then close it — the script imports the account automatically.

## Account Pool (rotation + failover)

With multiple accounts configured, requests are **distributed round-robin**; when an account hits a 429 rate limit or auth failure it **enters cooldown** and other accounts are used meanwhile.

| Benefit | Description |
|---|---|
| **Spread quota** | A single account has limited quota; rotating across accounts supports higher request volume |
| **Failover** | When an account is rate-limited (429) or out of quota, it switches automatically with no service interruption |
| **Visible balance** | Balances are probed and shown at startup |
| **Fully optional** | With one account (or none), behavior is identical to single-account mode |

- **Session-level account affinity**: requests for the same **conversation** stick to the same account (hitting the per-account cloud prefix cache). Session identity: the request's `user` field (OpenAI standard, recommended) > the fingerprint of the first user message > the API key as a fallback.
- On cooldown or when the pool is full, it falls back to round-robin automatically and never queues pointlessly.
- All accounts are probed at startup (via the billing API); dead ones enter cooldown immediately — avoiding wasted requests to dead accounts (`expiresAt` is only a nominal validity; a token may be revoked early).
- Cooldown duration varies by failure reason: rate-limit 10 min / auth failure 30 min / other errors 1 min, doubling on repeated failures (capped at 4×).
- When all accounts are cooling down, it picks the **fastest-to-recover** one rather than failing outright.

**Status**: `GET /v1/accounts` returns the account list, available count, and remaining cooldown.

## Daily Check-in

WorkBuddy grants credits for a daily check-in (default 100/day, with streak bonuses). buddy2api can **auto-check-in every account in the pool**.

```bash
npm run checkin                    # Check in all accounts now (already-checked-in ones skipped)
npm run checkin -- --status        # Status only, no claim
npm run checkin:install-task       # Register a Windows scheduled task: auto check-in daily at 09:30
npm run checkin:remove-task        # Remove the scheduled task
```

Auto check-in uses a Windows scheduled task rather than an in-service timer, because buddy2api isn't necessarily running 24/7 — a scheduled task is independent of the service and supports "run missed task after boot".

## Backend CLI Source & Upgrade

The backend selects the `codebuddy` binary by this priority:

1. `CODEBUDDY_CLI_PATH` environment variable (explicit override)
2. **The vendor copy in the project/install directory** `vendor/codebuddy-cli/` (copied by the installer wizard or `npm run vendor:update`)
3. The WorkBuddy install directory (fallback when the vendor copy is missing)
4. `PATH` search

The vendor copy is preferred because a WorkBuddy upgrade may change the install path, uninstall, or auto-update the CLI; pinning the backend to a verified version keeps buddy2api unaffected by those changes. **This is both a feature and a responsibility**: the pinned copy does not follow WorkBuddy's auto-updates, so after upgrading WorkBuddy, remember to re-sync once via the console `[C]` or `vendor:update`.

> `vendor/` is **not committed to the git repo** (Tencent proprietary software) — the level-2 copy above is generated on your machine by the install wizard or `vendor:update`. After a fresh clone, either run `npm run vendor:update` first or rely on the level-3 fallback.

```bash
# Sync/refresh the vendor copy from the WorkBuddy install (staging swap: only replaces
# after the copy self-checks OK; the old copy is backed up as .bak-<timestamp>, and old
# backups are auto-pruned to keep just the newest one)
npm run vendor:update

# Read-only check: compare install-dir vs WorkBuddy CLI version
# (exit 0=up to date, 1=upgradable, 2=missing or corrupt, 3=WorkBuddy not detected)
node scripts/vendor-cli.js --check
```

**Windows console**: choose `[C] CLI check & upgrade` — it compares versions automatically, and when the install-dir copy is older than WorkBuddy it confirms then overwrites (also handles corruption repair and first install); it stops the service before upgrading and offers a one-key restart afterward.

> This English README is a condensed version focused on integration essentials. For the full command reference (`accounts`/`checkin`/`models` subcommands, `--json`, `--from`, etc.), Windows console & shortcuts, scheduled tasks (auto-start / daily check-in), cross-machine credential migration, and the workbuddy compatible-mode config, see the [简体中文 README](README.md).

## Environment Variables

| Variable | Description | Default |
|------|------|--------|
| `PORT` | Proxy listen port | `8000` |
| `HOST` | Listen address | `127.0.0.1` |
| `CODEBUDDY_CLI_PATH` | Path to the codebuddy binary | vendor copy → install dir |
| `CODEBUDDY_AUTH_FILE` | Login-state file path | auto-located (canonical name or latest snapshot) |
| `CODEBUDDY_AUTH_TOKEN` | Inject accessToken directly (overrides auto-read) | read from credential file |
| `GATEWAY_URL` | Backend URL directly, skip auto-start (debug) | auto-start |
| `POOL_WARM_COUNT` | Backends pre-created at startup; defaults to the account count (one bound backend per account, so multi-account concurrency has no cold start) | account count (`2` if none); `0` disables |
| `BUDDY2API_IDLE_TIMEOUT_MS` | Idle-backend reclaim threshold (ms); lower saves memory, higher reduces cold starts | `7200000` (2 hours) |
| `BUDDY2API_DEFAULT_MODEL` | Model used when the client omits `model` (or sends `auto`/`default`) | `hy4-preview-f` |
| `BUDDY2API_ANTHROPIC_MODEL` | Model that Anthropic `claude-*` requests map to | empty → uses `BUDDY2API_DEFAULT_MODEL` |
| `BUDDY2API_ANTHROPIC_THINKING` | Fallback when the request carries **no** `thinking`: `1` = emit `thinking` blocks | `0` |
| `BUDDY2API_OPENAI_REASONING_DEFAULT` | Fallback when an OpenAI request **doesn't state** a preference: `0` = don't echo `reasoning_content`. **A fallback default only, not a kill switch** — an explicit `thinking:{type:'enabled'}` still turns it on | `1` |
| `FIRST_TOKEN_TIMEOUT_MS` | First-token guard threshold; `0` = disabled | `120000` |
| `TOKEN_STATS_FILE` | JSONL persistence path for token usage stats | `data/token-usage.jsonl` (`off` disables) |

## Token Usage Stats

Per-request token detail is available via `GET /v1/usage`, aggregated by model / client key with per-request records:

```bash
curl http://127.0.0.1:8000/v1/usage                       # totals + by-model + by-key
curl "http://127.0.0.1:8000/v1/usage?detail=1&limit=50"   # with per-request detail
curl -X DELETE http://127.0.0.1:8000/v1/usage             # reset (memory + file)
```

- **Model attribution**: prefers the actual model reported by the `usage_update` event; else the client-specified `model`; for `auto`, the session default model.
- **Token counts** (`usage_source`): `reported` = exact value from the WorkBuddy gateway (some versions); `estimated` = text-based estimate when the gateway doesn't report usage (CJK ≈1 token/char, else ≈1 token/4 chars).
- **No double-billing**: one request (including multi-turn tool-call continuations) is recorded once, at a terminal state; requests that produce no model output (e.g. 429) aren't counted.

## Client Configuration

Add an OpenAI-compatible provider to your client — the same three-piece config works for any OpenAI-compatible tool: Base URL (`http://127.0.0.1:8000/v1`), API Key (any value; use `local` where required), and a model ID.

```json
{
  "providers": {
    "workbuddy": {
      "baseUrl": "http://127.0.0.1:8000/v1",
      "apiKey": "local",
      "models": ["auto", "glm-5.3", "deepseek-v4.1-flash", "kimi-k3-1", "hy3"]
    }
  }
}
```

## OpenAI Reasoning Content

Reasoning visibility on `/v1/chat/completions` is decided **per request** — isomorphic to the Anthropic-side contract (single decision point, forwarding-only), but with the **opposite default direction**: OpenAI's existing behavior is "always echo", so the default when unspecified is **on**, to avoid silently breaking existing clients.

| Request field | Behavior |
|---|---|
| `reasoning_effort: "none"` (case/whitespace-insensitive) | do not emit `reasoning_content` |
| `thinking: {type:'disabled'}` | do not emit |
| `thinking: {type:'enabled'}` / `{type:'adaptive'}` | emit (**overrides** the env var) |
| `thinking: {type:'enabled', display:'omitted'}` | do **not** emit (only-signature-no-body is requested; this proxy can't produce a real signature) |
| `reasoning_effort: "low"` / `"high"` / any other value | **no stated preference** → fall back to the env var |
| absent / unknown / non-object | fall back to `BUDDY2API_OPENAI_REASONING_DEFAULT` (echo by default) |

Two rules worth calling out:

- **Arbitration is fail-closed**: when an explicit-off and an explicit-on both appear, **off wins over on**. E.g. `{"reasoning_effort":"none","thinking":{"type":"enabled"}}` — this wire's native knob (`reasoning_effort`) saying "don't send" should not be silently overridden by a foreign field.
- **Known trade-off**: normalization (trim + lowercase) applies **only to `reasoning_effort`**; `thinking.type` / `thinking.display` are enum values compared literally and **case-sensitively** — any non-enum value falls back (same as the Anthropic side). No synonym mapping is done, so `"off"` / `"disable"` fall into "no stated preference" → resolve to **echo** (fail-open). This is deliberate: guessing synonyms for the client is more error-prone than honestly falling back.

When reasoning is off, stage-progress text (e.g. "compacting context…") is forwarded as SSE comment lines (`: progress …`) instead — keeping the connection alive and observable without occupying the `reasoning_content` channel.

> ⚠ This proxy **only controls forwarding**; it does **not** reduce upstream reasoning generation or billing. To actually cut reasoning cost, change the model or backend.

## Anthropic Messages API Compatibility

Besides OpenAI format, the proxy also serves an Anthropic Messages endpoint; official `@anthropic-ai/sdk`, Claude Code, etc. can point `baseURL` at it directly. **Set `baseURL` to `http://127.0.0.1:8000`, without `/v1`** — the SDK appends `/v1/messages` itself, so including `/v1` would request `/v1/v1/messages` and 404. For Claude Code set `ANTHROPIC_BASE_URL=http://127.0.0.1:8000` (also without `/v1`); `x-api-key` / `ANTHROPIC_AUTH_TOKEN` can be any value (used only for session isolation, not validated):

| Endpoint | Description |
|------|------|
| `POST /v1/messages` | Anthropic Messages (`stream: true/false`) |
| `POST /v1/messages/count_tokens` | Context token estimate |

### Model names

**The backend has no Claude models.** `claude-*` (and `anthropic.*`) requests are mapped to the proxy's default model, but the **response echoes back the original name you requested** — so the client thinks it's talking to Claude while actually running on the default model. The server logs a warning naming the actual model used. Change the mapping target with `BUDDY2API_ANTHROPIC_MODEL=<model id>`.

### Auth and session isolation

Both `x-api-key` and `Authorization: Bearer` are read, for **session isolation** (different keys use different session pools; pending tool calls don't interfere). **The service does not validate the key value** — it's local, so any string or none works. Priority: `Authorization: Bearer` > `x-api-key` > `?apiKey=` > shared `default`.

> ⚠️ Sending no key (or the same key for all clients) shares one session pool, where pending tool calls may evict each other.

### Supported scope and known behaviors

**Supported**: text / images (`base64` and `url` sources) / tool-calling loop (`tool_use` ↔ `tool_result`) / `system` (string or block array) / reasoning (decided by the request's `thinking.type`).

**Accepted but semantics ignored** (no error, no effect): `max_tokens` (**no hard cap** — it's a required Anthropic field, so rejecting it would fail every request; don't expect it to truncate output), `temperature` / `top_p` / `top_k`, `stop_sequences`, `tool_choice`, `metadata`.

**Unsupported inputs** (silently ignored): server-side tools (`web_search_*`, `computer_use_*`, `bash_*`, `text_editor_*`, etc. — the proxy has no executor, so requests degrade to plain chat); `document` blocks, citations, `redacted_thinking`; prompt caching (`cache_control`), `anthropic-beta` header; `/v1/messages/batches`, `/v1/files`.

The `signature` field of a `thinking` block is **always an empty string**: a real signature can't be constructed, but the SDK's `ThinkingBlock.signature` is required with no default — **omitting** it makes strict-validation clients (`_strict_response_validation`) throw `APIResponseValidationError`. Empty string is the only legal downgrade, consistent with DashScope's official approach. Streaming responses do **not** include OpenAI's `data: [DONE]` sentinel; in-stream errors terminate with an Anthropic-shaped `event: error`.

Reasoning visibility on the Anthropic side is also **per request** (matching Anthropic's opt-in contract — not a process-level switch, since one proxy serves many clients and "A wants it, B doesn't" must both be expressible):

| Request `thinking` | Behavior |
|---|---|
| `{type:'enabled'}` / `{type:'adaptive'}` | emit `thinking` blocks and `thinking_delta` |
| `{type:'enabled', display:'omitted'}` | do **not** emit (signature-only-no-body requested; can't produce a real signature, so treated as invisible) |
| `{type:'disabled'}` | do not emit (**overrides** the env var) |
| absent / unknown `type` / non-object | fall back to `BUDDY2API_ANTHROPIC_THINKING` (off by default) |

`budget_tokens` is accepted but its semantics are ignored (the backend doesn't support per-token budget allocation).

## Available Models

Set the client's `model` field to any model ID; the proxy **passes it through verbatim** to the gateway with no mapping or substitution. **Billing coefficients** are annotated by the gateway in the model list (`x0.00` = free). Query your account's live list:

```bash
node scripts/models.js          # full table + per-agent integration config
node scripts/models.js --brief  # one-line summary
```

Any OpenAI-compatible tool uses the same three-piece config (Base URL / API Key / model ID). Example models (defer to the runtime query):

| Model ID | Billing coefficient |
|---------|----------|
| `hy4-preview-f` | **free** (x0.00) |
| `hy3` | **free** (x0.00) |
| `deepseek-v4.1-flash` | x0.03 |
| `glm-5.3-flash` | x0.06 |
| `deepseek-v4-pro` | x0.51 |
| `kimi-k3-1` | x1.62 |
| `auto` | not annotated (billed by the model actually routed to) |

> ⚠️ **`hy4-preview` (without `-f`) is not in the list.** It's a legacy hidden ID that `setModel` still accepts, but it **bills as a paid model** — it looks free but actually deducts credits. The free one is `hy4-preview-f`. Likewise, "not annotated" ≠ free: the default `auto` is unannotated but still billed.

### Default model (free by default)

When the client **omits `model`**, or sends `auto` / `default`, the proxy uses **`hy4-preview-f`** (free). Reason: the gateway's `auto` routes to a paid model — a 3.2k-prompt request was measured to cost 0.52 credits. Since most clients omit `model` or send `auto`, leaving it alone means burning credits by default. Requests naming a specific model ID are passed through unchanged.

```bash
BUDDY2API_DEFAULT_MODEL=auto npm start           # back to gateway auto-routing (billed by actual model)
BUDDY2API_DEFAULT_MODEL=glm-5.3-flash npm start  # or pin any model as default
```

The effective default model is printed in the startup banner and can be queried via the `default_model` field of `GET /`. When a request names a model ID that isn't in the list, the proxy logs an explicit warning rather than silently falling back to `auto`.

## Notes

- **The WorkBuddy desktop app doesn't need to be running** — buddy2api manages the backend CLI process itself
- You only need: a codebuddy CLI (in the install dir / project `vendor/`, or a local WorkBuddy install) + one valid account credential
- Concurrent requests each get an independent backend process and never cross-talk; pool cap defaults to 5, excess queues
- The agent carries a system prompt and tool definitions, so `prompt_tokens` has a ~22k baseline overhead (not leaked context)
- Prompt sanitization replaces `ZCode` / `opencode` / `Claude Code` etc. with `workbuddy`
- Port `8000` listens on localhost only; for LAN access set `HOST=0.0.0.0` and mind security. The backend CLI runs with `--auth none` (no auth) on `127.0.0.1` only — don't expose that port to the network
- The accessToken in credentials has a validity period (usually months); re-login once when it expires (`npm run login` will prompt)

## License

MIT — see [LICENSE](LICENSE). Please read the [Usage Statement](#usage-statement-must-read) for the boundaries of that license in this project's context.
