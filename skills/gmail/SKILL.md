---
name: gmail
description: Read, search, send, and manage Gmail emails. Use this whenever the user wants to send an email, check inbox, search messages, read unread mail, download attachments, reply to emails, or manage email threads. Also use when the user mentions email-related tasks like "email my boss", "send a message to", "check my mail", "reply to that email", or any task involving Gmail or email communication.
version: 0.4.0
---

# Gmail Plugin

Send, receive, search, and manage Gmail emails via IMAP/SMTP with OAuth 2.0 authentication.

## Critical: Check Authorization First

**Gmail tools require OAuth 2.0 authorization. This is a user-interactive process — the plugin will NOT authorize itself automatically.**

Before calling ANY email tool (`gmail_messages_search`, `gmail_message_send`, etc.):

1. Try the tool — if it returns an authorization error, you will see a message like "Gmail is not authorized"
2. When you get that error, **ask the user for confirmation** using **AskUserQuestion**: "Gmail needs authorization. Open browser to log in?"
3. After the user confirms, call `gmail_authorize` — it opens a browser and **returns immediately** with `status: "oauth_pending"`. It does NOT wait for completion.
4. Tell the user: "已在浏览器中打开 Google 授权页面，请完成授权后告诉我。"
5. After the user says they are done, retry the original tool

**Never skip step 2.** Authorization must be user-initiated — do not call `gmail_authorize` without asking first.

## Available Tools

| Tool | Purpose |
|------|---------|
| `gmail_authorize` | Start OAuth 2.0 authorization flow — opens browser, returns immediately with `oauth_pending`. Requires AskUserQuestion first. |
| `gmail_mailboxes_list` | List all folders/labels on the Gmail account |
| `gmail_messages_search` | Server-side IMAP search across the entire mailbox |
| `gmail_message_get` | Fetch a single message by mailbox + UID |
| `gmail_thread_get` | Fetch all messages in a thread by any UID in it |
| `gmail_message_attachments_save` | Download attachments from a message to disk |
| `gmail_message_update` | Mark message as read/unread or flagged/starred |
| `gmail_message_move` | Move a message between mailboxes |
| `gmail_message_send` | Send a new email (requires confirm: true) |
| `gmail_message_reply` | Reply to a message with proper threading (requires confirm: true) |

## Send Confirmation Guardrail

`gmail_message_send` and `gmail_message_reply` require `confirm: true` in the same call. This prevents accidental sends. You must include this field — the tool will refuse otherwise.

## Search Examples

```json
// Simple keyword search
{ "query": "invoice 2026" }

// With filters
{ "from": "boss@company.com", "unread": true, "since": "2026-04-01" }

// Gmail-style inline operators in query
{ "query": "from:stripe.com has:attachment is:unread after:2026/04/01" }

// Pagination
{ "from": "newsletter@", "limit": 20, "beforeUid": 4093 }
```

## Common Workflows

### Send an email
1. Try `gmail_message_send` with `{ to: "...", subject: "...", text: "...", confirm: true }`
2. If auth error: AskUserQuestion → `gmail_authorize` → tell user to complete in browser → user says done → retry

### Check for new mail
1. Try `gmail_messages_search` with `{ unread: true, limit: 10 }`
2. If auth error: AskUserQuestion → `gmail_authorize` → tell user to complete in browser → user says done → retry
3. For more detail on a message, call `gmail_message_get` with its `{ mailbox: "INBOX", uid: 123 }`

### Reply to an email
1. First get or search for the message to find its UID
2. Call `gmail_message_reply` with `{ mailbox: "INBOX", uid: 123, body: "...", confirm: true }`
   - For reply-all, add `replyAll: true`

### Download attachments
1. Call `gmail_message_get` to see attachment metadata
2. Call `gmail_message_attachments_save` with `{ mailbox: "INBOX", uid: 123 }`
3. Returns absolute file paths you can pass to `read` or other tools

## Constraints

- Always use the configured account — do not ask the user for credentials
- **Authorization is user-interactive**: always use AskUserQuestion before calling `gmail_authorize`
- For sending: always include `confirm: true` in the tool call
- For search: prefer server-side queries — never fetch all messages and filter locally
- Thread fetching requires Gmail accounts (X-GM-EXT-1 IMAP extension)
- Attachments are saved to disk; the tool returns absolute paths for chaining with other tools
