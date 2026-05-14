# Gmail Plugin for TelyClaw

> Gmail plugin with OAuth 2.0 authentication, IMAP/SMTP email operations, and first-class attachment download.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

The Gmail plugin enables the AI assistant to read, search, send, and manage Gmail emails. Built on [`imapflow`](https://imapflow.com/) + [`mailparser`](https://nodemailer.com/extras/mailparser/) + [`nodemailer`](https://nodemailer.com/) — battle-tested IMAP/SMTP libraries with OAuth 2.0 (XOAUTH2) authentication.

---

## Table of contents

- [Architecture](#architecture)
- [Quick start](#quick-start)
  - [1. Configure Google Cloud OAuth](#1-configure-google-cloud-oauth)
  - [2. Set environment credentials](#2-set-environment-credentials)
  - [3. Authorize Gmail access](#3-authorize-gmail-access)
- [Configuration reference](#configuration-reference)
- [Tools exposed to the agent](#tools-exposed-to-the-agent)
- [Send confirmation guardrail](#send-confirmation-guardrail)
- [Skill file](#skill-file)
- [Development](#development)
- [Security model](#security-model)

---

## Architecture

```
Agent asks to send email
  → AI reads SKILL.md (auto-routed from skill description)
  → AI calls gmail_message_send tool
  → Frontend dispatches to pluginHandlers.ts
  → Tauri Rust backend spawns: node run-tool.mjs gmail_message_send '{...}'
  → run-tool.mjs imports dist/index.js, resolves tokens, executes tool
  → Prints JSON result to stdout → Rust returns to frontend → Agent
```

- **`openclaw.plugin.json`** — Manifest: tool contracts, config schema, OAuth config, skill paths
- **`plugins.config.json`** — Global static config: Google Cloud OAuth credentials (`environment.gmail`)
- **`config.json`** — Runtime dynamic config: OAuth tokens (auto-managed by dist/index.js resolveAuth)
- **`run-tool.mjs`** — Thin CLI bridge: imports plugin, resolves auth, dispatches tool (~50 lines)
- **`dist/index.js`** — Plugin core: tool registration, auth helpers (resolveAuth, refreshTokenIfExpired), requireAuth guard
- **`skills/gmail/SKILL.md`** — AI skill instructions (auth-first workflow, when/how to use gmail tools)

---

## Quick start

### 1. Configure Google Cloud OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create an OAuth 2.0 Client ID (Web application type)
3. Add `http://127.0.0.1:18080/oauth/callback` as an authorized redirect URI
4. Copy the **Client ID** and **Client Secret**

### 2. Set environment credentials

Edit `src/openclaw/PLUGINs/plugins.config.json`:

```jsonc
{
  "environment": {
    "gmail": {
      "GOOGLE_APP_CLIENT_ID": "your-client-id.apps.googleusercontent.com",
      "GOOGLE_APP_CLIENT_SECRET": "GOCSPX-your-client-secret",
      "GOOGLE_API_KEY": "your-api-key"
    }
  }
}
```

These are injected as environment variables into the plugin child process.

### 3. Authorize Gmail access

The AI agent will prompt you to authorize Gmail when it first tries to use an email tool:

1. The agent asks for confirmation via `AskUserQuestion`
2. Agent calls `gmail_authorize` — opens a browser window for Google OAuth consent
3. After you grant access, tokens are saved to `config.json` automatically
4. `run-tool.mjs` calls `resolveAuth()` + `refreshTokenIfExpired()` from `dist/index.js` before each tool call

Tokens in `config.json` are managed automatically — do not edit them manually.

---

## Configuration reference

### `plugins.config.json` (static — checked into the project)

| Field | Description |
|-------|-------------|
| `environment.gmail.GOOGLE_APP_CLIENT_ID` | Google Cloud OAuth client ID |
| `environment.gmail.GOOGLE_APP_CLIENT_SECRET` | Google Cloud OAuth client secret |
| `environment.gmail.GOOGLE_API_KEY` | Google API key |

### `config.json` (dynamic — auto-managed by dist/index.js auth helpers)

| Field | Description |
|-------|-------------|
| `accessToken` | Google OAuth 2.0 access token |
| `refreshToken` | OAuth refresh token for token renewal |
| `tokenExpiry` | Access token expiry (ms since epoch) |

### `openclaw.plugin.json` `configSchema` (user-facing config)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `username` | string | **from OAuth** | Full Gmail address |
| `from` | string | `username` | Override `From:` address |
| `fromName` | string | — | Display name on outgoing mail |
| `replyTo` | string | — | Default `Reply-To:` header |
| `imap.host` | string | `imap.gmail.com` | IMAP host |
| `imap.port` | int | `993` | IMAP port |
| `imap.secure` | bool | `true` | Use TLS for IMAP |
| `smtp.host` | string | `smtp.gmail.com` | SMTP host |
| `smtp.port` | int | `465` | SMTP port |
| `smtp.secure` | bool | `true` | Use TLS for SMTP |
| `defaultMailbox` | string | `INBOX` | Default mailbox |
| `defaultSearchLimit` | int | `10` | Default search limit |
| `attachmentsDir` | string | `~/.openclaw/inbox/gmail` | Attachment save directory |
| `requireExplicitSendConfirmation` | bool | `true` | Require `confirm: true` for send/reply |

---

## Tools exposed to the agent

| Tool | Purpose |
|------|---------|
| `gmail_mailboxes_list` | List folders/labels on the account |
| `gmail_messages_search` | Server-side IMAP search with Gmail-style operators |
| `gmail_message_get` | Fetch one message by `mailbox`+`uid`. Returns body text, attachment metadata, thread info |
| `gmail_thread_get` | Fetch every message in the same Gmail thread as a UID |
| `gmail_message_attachments_save` | Download attachments to disk, return absolute paths |
| `gmail_message_update` | Set `read` and/or `flagged` (starred) on a message |
| `gmail_message_move` | Move a message between mailboxes |
| `gmail_message_send` | Send a new email. Requires `confirm: true` |
| `gmail_message_reply` | Reply to a message by UID. Supports `replyAll`. Requires `confirm: true` |
| `gmail_authorize` | Start OAuth 2.0 authorization flow |

### Search examples

```jsonc
// Multi-term AND search
{ "query": "stripe invoice 2026" }

// Inline Gmail operators
{ "query": "from:accountant@firm.com has:attachment is:unread after:2026-04-25" }

// Explicit filters (override inline operators)
{ "from": "boss@company.com", "unread": true, "since": "2026-04-01", "hasAttachment": true }

// Full Gmail raw syntax
{ "gmailRaw": "from:stripe.com subject:invoice has:attachment after:2026/04/01" }
```

---

## Send confirmation guardrail

`gmail_message_send` and `gmail_message_reply` refuse to run unless the agent passes `confirm: true` in the same call:

```jsonc
{ "to": "boss@company.com", "subject": "Report", "body": "...", "confirm": true }
```

Set `requireExplicitSendConfirmation: false` to disable this guardrail.

---

## Skill file

The AI assistant discovers Gmail capabilities through the skill file at `skills/gmail/SKILL.md` (also mirrored at `src/openclaw/SKILLs/gmail/SKILL.md`). The skill's description tells the agent when to trigger Gmail tools. If the agent says it can't send email, the skill file may be missing or disabled — check that `gmail` appears in the skills list and is enabled.

---

## Development

```sh
npm install
npm run build       # compile src/ → dist/
npm run typecheck   # tsc --noEmit
```

Layout:

```
gmail/
├── openclaw.plugin.json    # Manifest (contracts.tools, configSchema, OAuth, skills)
├── package.json            # npm metadata
├── run-tool.mjs            # Thin CLI bridge (~50 lines): import → resolveAuth → dispatch
├── config.json             # Runtime tokens (auto-managed by resolveAuth/refreshTokenIfExpired)
├── dist/
│   └── index.js            # Plugin core: tool registration, requireAuth guard, auth helpers
├── skills/
│   └── gmail/
│       └── SKILL.md        # AI skill instructions
└── src/                    # Plugin source code
```

## Security model

- OAuth 2.0 credentials (`GOOGLE_APP_CLIENT_ID`, `GOOGLE_APP_CLIENT_SECRET`) live in `plugins.config.json`
- Dynamic tokens (`accessToken`, `refreshToken`) are in `config.json` — auto-refreshed, never manually edited
- All IMAP/SMTP traffic uses TLS
- Outgoing mail requires `confirm: true` (with default `requireExplicitSendConfirmation`)
- The plugin never stores received content beyond explicitly downloaded attachments
- No third-party service calls — all I/O goes to Gmail's IMAP/SMTP servers

---

## License

MIT — see [LICENSE](./LICENSE).

Not affiliated with Google or Gmail. "Gmail" is a trademark of Google LLC.
