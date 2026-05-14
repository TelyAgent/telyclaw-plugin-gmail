import { Type } from "@sinclair/typebox";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import { HttpsProxyAgent } from "https-proxy-agent";
// @ts-ignore - resolved at runtime by the OpenClaw host
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
// ─── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_IMAP_HOST = "imap.gmail.com";
const DEFAULT_IMAP_PORT = 993;
const DEFAULT_MAILBOX = "INBOX";
const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_SINCE_DAYS = 30;
const BODY_TEXT_LIMIT = 4000;
const FETCH_CANDIDATES_CAP = 1000;
const SEARCH_FETCH_TIMEOUT_MS = 30_000;
const IMAP_CONNECT_TIMEOUT_MS = 10_000;
const IMAP_RETRY_ATTEMPTS = 3;
const IMAP_RETRY_DELAYS_MS = [100, 500, 2000];
const AUTH_REQUIRED_ERROR = 'Gmail is not authorized. Ask the user for confirmation via AskUserQuestion, then call gmail_authorize to start the OAuth flow.';

const GOOGLE_APP_CLIENT_ID ="166854276552-euk0006iphou9bvqplmgmpc0vde8v1in.apps.googleusercontent.com";                                                      
const GOOGLE_APP_CLIENT_SECRET="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";                                                                                
const GOOGLE_API_KEY ="AIzaSyB5MU4npnKKOLaygbrI4pPH7-QbpIfNfwk";

function requireAuth(cfg) {
    if (!cfg.username || !cfg.accessToken) {
        throw new Error(AUTH_REQUIRED_ERROR);
    }
}
function normalizeConfig(input) {
    return {
        username: input.username || "",
        accessToken: input.accessToken || "",
        from: input.from ?? input.username ?? "",
        fromName: input.fromName,
        replyTo: input.replyTo,
        imap: {
            host: input.imap?.host ?? DEFAULT_IMAP_HOST,
            port: input.imap?.port ?? DEFAULT_IMAP_PORT,
            secure: input.imap?.secure ?? true,
        },
        defaultMailbox: input.defaultMailbox ?? DEFAULT_MAILBOX,
        defaultSearchLimit: input.defaultSearchLimit ?? DEFAULT_SEARCH_LIMIT,
        attachmentsDir: input.attachmentsDir ?? join(homedir(), ".openclaw", "inbox", "gmail"),
        requireExplicitSendConfirmation: input.requireExplicitSendConfirmation ?? true,
    };
}
// ─── Utilities ────────────────────────────────────────────────────────────────
function sanitizeFsName(name, fallback) {
    const cleaned = (name ?? "").replace(/[\/\\\0]/g, "_").replace(/^\.+/, "_").trim();
    if (!cleaned || cleaned === "." || cleaned === "..")
        return fallback;
    return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
}
function truncate(text, max) {
    if (text.length <= max)
        return text;
    return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}
function compactWhitespace(text) {
    return text.replace(/\s+/g, " ").trim();
}
function htmlToText(html) {
    if (!html)
        return "";
    return html
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<\/(?:p|div|li|tr|h[1-6])[^>]*>/gi, "\n")
        .replace(/<br\s*\/?\s*>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
function formatAddress(addr) {
    if (!addr)
        return "";
    if (addr.name && addr.address)
        return `${addr.name} <${addr.address}>`;
    return addr.address ?? addr.name ?? "";
}
function formatAddressList(list) {
    if (!list || list.length === 0)
        return "";
    return list.map(formatAddress).filter(Boolean).join(", ");
}
function normalizeRecipients(value) {
    if (!value)
        return [];
    if (Array.isArray(value))
        return value.flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
    return value.split(",").map((s) => s.trim()).filter(Boolean);
}
function lower(s) {
    return s.toLowerCase();
}
function uniqueStrings(values) {
    const seen = new Set();
    return values.filter((v) => {
        const k = v.trim().toLowerCase();
        if (!k || seen.has(k))
            return false;
        seen.add(k);
        return true;
    });
}
function parseDate(value) {
    if (!value)
        return undefined;
    const d = new Date(value);
    return Number.isNaN(d.valueOf()) ? undefined : d;
}
function isGmailHost(host) {
    return /(?:^|\.)gmail\.com$/i.test(host) || /(?:^|\.)googlemail\.com$/i.test(host);
}
// ─── Proxy-aware Google API helpers ───────────────────────────────────────────
function resolveProxy() {
    return process.env.HTTPS_PROXY || process.env.https_proxy
        || process.env.HTTP_PROXY || process.env.http_proxy
        || process.env.ALL_PROXY || '';
}
/** POST to a Google API with proxy support. Returns parsed JSON. */
function googleApiPost(hostname, path, accessToken, body, contentType = 'application/json') {
    return new Promise((resolve, reject) => {
        const proxy = resolveProxy();
        const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
        const bodyBuf = Buffer.from(body, 'utf-8');
        const req = https.request({
            hostname,
            path,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': contentType,
                'Content-Length': String(bodyBuf.length),
            },
            agent,
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const data = Buffer.concat(chunks).toString('utf-8');
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    try { resolve(JSON.parse(data)); }
                    catch { resolve({ raw: data }); }
                } else {
                    reject(new Error(`Google API ${hostname}${path} failed (HTTP ${res.statusCode}): ${data}`));
                }
            });
        });
        req.on('error', reject);
        req.write(bodyBuf);
        req.end();
    });
}
// ─── IMAP helpers ─────────────────────────────────────────────────────────────
/** Build a compact IMAP UID sequence set, e.g. [1,2,3,7,8] → "1:3,7:8". */
function buildImapSequenceSet(uids) {
    if (!uids.length)
        return "";
    const sorted = [...uids].sort((a, b) => a - b);
    const ranges = [];
    let start = sorted[0];
    let end = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] === end + 1) {
            end = sorted[i];
        }
        else {
            ranges.push(start === end ? String(start) : `${start}:${end}`);
            start = sorted[i];
            end = sorted[i];
        }
    }
    ranges.push(start === end ? String(start) : `${start}:${end}`);
    return ranges.join(",");
}
async function withImapClient(cfg, fn) {
    let lastErr;
    for (let attempt = 0; attempt < IMAP_RETRY_ATTEMPTS; attempt++) {
        if (attempt > 0) {
            await new Promise((r) => setTimeout(r, IMAP_RETRY_DELAYS_MS[attempt - 1]));
        }
        const client = new ImapFlow({
            host: cfg.imap.host,
            port: cfg.imap.port,
            secure: cfg.imap.secure,
            auth: { user: cfg.username, accessToken: cfg.accessToken },
            logger: false,
        });
        try {
            await Promise.race([
                client.connect(),
                new Promise((_, reject) => setTimeout(() => reject(new Error(`IMAP connect timed out after ${IMAP_CONNECT_TIMEOUT_MS}ms`)), IMAP_CONNECT_TIMEOUT_MS)),
            ]);
            try {
                return await fn(client);
            }
            finally {
                try {
                    await client.logout();
                }
                catch { /* best-effort */ }
            }
        }
        catch (err) {
            lastErr = err;
            const msg = err instanceof Error ? err.message : String(err);
            const isRetryable = /connection not available|connect timed out|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|socket|network/i.test(msg);
            if (!isRetryable || attempt === IMAP_RETRY_ATTEMPTS - 1)
                throw err;
            try {
                client.close();
            }
            catch { /* ignore */ }
        }
    }
    throw lastErr;
}
async function withMailboxLock(client, mailbox, fn) {
    const lock = await client.getMailboxLock(mailbox);
    try {
        return await fn();
    }
    finally {
        lock.release();
    }
}
function withTimeout(p, ms, label) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
}
// ─── Gmail IMAP extension helpers ─────────────────────────────────────────────
// imapflow has no typings for Gmail extensions (X-GM-EXT-1).
// All `as any` access is isolated here so business logic stays type-safe.
function getImapCapabilities(client) {
    try {
        const caps = client.serverInfo?.capability;
        return Array.isArray(caps) ? caps.map(String) : [];
    }
    catch {
        return [];
    }
}
function clientHasGmailExt(client) {
    return getImapCapabilities(client).some((c) => /X-GM-EXT-1/i.test(c));
}
function getGmailThreadId(item) {
    const tid = item.threadId;
    return tid != null ? String(tid) : undefined;
}
/** Build a FetchQueryObject, including optional Gmail/non-standard extensions. */
function buildFetchQuery(base, extensions = {}) {
    const q = { ...base };
    if (extensions.bodyStructure)
        q.bodyStructure = true;
    if (extensions.threadId)
        q.threadId = true;
    return q;
}
async function readSourceText(source) {
    if (!source)
        return "";
    if (Buffer.isBuffer(source))
        return source.toString("utf8");
    const chunks = [];
    for await (const chunk of source) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
}
function toSummary(mailbox, item, bodyText, attachmentCount) {
    const flags = Array.from(item.flags ?? []).map(String);
    return {
        mailbox,
        uid: Number(item.uid),
        subject: item.envelope?.subject ?? "",
        from: formatAddressList(item.envelope?.from),
        to: formatAddressList(item.envelope?.to),
        cc: formatAddressList(item.envelope?.cc),
        date: item.internalDate ? new Date(item.internalDate).toISOString() : null,
        preview: truncate(compactWhitespace(bodyText) || compactWhitespace(item.envelope?.subject ?? "") || "", 200),
        flags,
        unread: !flags.includes("\\Seen"),
        flagged: flags.includes("\\Flagged"),
        hasAttachments: typeof attachmentCount === "number" ? attachmentCount > 0 : false,
        messageId: Array.isArray(item.envelope?.messageId) ? item.envelope?.messageId[0] : item.envelope?.messageId,
        threadId: getGmailThreadId(item),
    };
}
async function toFullMessage(mailbox, item) {
    const parsed = await simpleParser(await readSourceText(item.source));
    const textBody = (parsed.text ?? "").trim();
    const html = typeof parsed.html === "string" ? parsed.html : undefined;
    let bodyText = textBody;
    let bodySource = textBody ? "text" : "none";
    if (!bodyText && html) {
        bodyText = htmlToText(html);
        if (bodyText)
            bodySource = "html-fallback";
    }
    const attachments = parsed.attachments ?? [];
    const summary = toSummary(mailbox, item, bodyText, attachments.length);
    const refs = parsed.references;
    return {
        ...summary,
        bodyText,
        html,
        attachments: attachments.map((a) => ({ filename: a.filename ?? undefined, contentType: a.contentType, size: a.size })),
        replyTo: parsed.replyTo?.text ?? "",
        references: Array.isArray(refs) ? refs.map(String) : refs ? [String(refs)] : [],
        bodySource,
    };
}
// ─── Search ───────────────────────────────────────────────────────────────────
function normalizeGmailDate(v) {
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(v))
        return v;
    if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(v))
        return v.replace(/\//g, "-");
    return v;
}
function extractGmailOperators(query) {
    const parsed = {};
    const picked = [];
    const opRe = /(\w+):(?:"([^"]+)"|(\S+))/g;
    const ranges = [];
    let m;
    while ((m = opRe.exec(query)) !== null) {
        const key = m[1].toLowerCase();
        const value = m[2] !== undefined ? m[2] : m[3];
        let consumed = false;
        switch (key) {
            case "from":
                if (parsed.from === undefined) {
                    parsed.from = value;
                    consumed = true;
                }
                break;
            case "to":
                if (parsed.to === undefined) {
                    parsed.to = value;
                    consumed = true;
                }
                break;
            case "subject":
                if (parsed.subject === undefined) {
                    parsed.subject = value;
                    consumed = true;
                }
                break;
            case "has":
                if (/attachment/i.test(value)) {
                    parsed.hasAttachment = true;
                    consumed = true;
                }
                break;
            case "is":
                if (/^unread$/i.test(value)) {
                    parsed.unread = true;
                    consumed = true;
                }
                else if (/^read$/i.test(value)) {
                    parsed.unread = false;
                    consumed = true;
                }
                else if (/^(?:flagged|starred)$/i.test(value)) {
                    parsed.flagged = true;
                    consumed = true;
                }
                break;
            case "in":
            case "label":
                if (parsed.mailbox === undefined) {
                    parsed.mailbox = value;
                    consumed = true;
                }
                break;
            case "before":
                if (parsed.before === undefined) {
                    parsed.before = normalizeGmailDate(value);
                    consumed = true;
                }
                break;
            case "after":
            case "since":
                if (parsed.since === undefined) {
                    parsed.since = normalizeGmailDate(value);
                    consumed = true;
                }
                break;
        }
        if (consumed) {
            ranges.push([m.index, m.index + m[0].length]);
            picked.push(`${key}:${value}`);
        }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    let remaining = "";
    let cursor = 0;
    for (const [start, end] of ranges) {
        if (start > cursor)
            remaining += query.slice(cursor, start);
        cursor = end;
    }
    if (cursor < query.length)
        remaining += query.slice(cursor);
    return { remaining: remaining.replace(/\s+/g, " ").trim(), parsed, picked };
}
function parseQueryGroups(query) {
    if (!query?.trim())
        return [];
    return query
        .trim()
        .split(/\s+OR\s+/i)
        .map((g) => g.split(/\s+/).filter((t) => t && !/^(?:AND|OR)$/i.test(t)))
        .filter((g) => g.length > 0);
}
/** Walk an imapflow bodyStructure tree and return true if any part is an attachment. */
function bsHasAttachment(bs) {
    if (!bs)
        return false;
    if (String(bs.disposition || "").toLowerCase() === "attachment")
        return true;
    const filename = bs.dispositionParameters?.filename ??
        bs.dispositionParameters?.name ??
        bs.parameters?.name ??
        bs.parameters?.filename;
    const type = String(bs.type || "").toLowerCase();
    if (filename && type !== "multipart" && !type.startsWith("text/"))
        return true;
    if (Array.isArray(bs.childNodes) && bs.childNodes.some(bsHasAttachment))
        return true;
    return false;
}
function resolveSearchParams(params) {
    let effective = params;
    let pickedOperators = [];
    if (params.query && !params.gmailRaw) {
        const { remaining, parsed, picked } = extractGmailOperators(params.query);
        if (picked.length > 0) {
            pickedOperators = picked;
            effective = {
                ...params,
                from: params.from ?? parsed.from,
                to: params.to ?? parsed.to,
                subject: params.subject ?? parsed.subject,
                unread: params.unread ?? parsed.unread,
                flagged: params.flagged ?? parsed.flagged,
                hasAttachment: params.hasAttachment ?? parsed.hasAttachment,
                since: params.since ?? parsed.since,
                before: params.before ?? parsed.before,
                mailbox: params.mailbox ?? parsed.mailbox,
                query: remaining || undefined,
            };
        }
    }
    // Default to last DEFAULT_SINCE_DAYS when no temporal filter — prevents full-mailbox scans.
    if (!effective.since && !effective.before && !effective.gmailRaw) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - DEFAULT_SINCE_DAYS);
        effective = { ...effective, since: cutoff.toISOString() };
    }
    return { effective, pickedOperators };
}
function buildServerCriteria(params, client, cfg) {
    if (params.gmailRaw) {
        if (!isGmailHost(cfg.imap.host) || !clientHasGmailExt(client)) {
            throw new Error("gmailRaw was provided but the connected server does not advertise X-GM-EXT-1.");
        }
        return { criteria: { gmailRaw: params.gmailRaw }, gmailRawUsed: true };
    }
    const criteria = {};
    if (params.from)
        criteria.from = params.from;
    if (params.to)
        criteria.to = params.to;
    if (params.subject)
        criteria.subject = params.subject;
    if (params.unread === true)
        criteria.unseen = true;
    if (params.unread === false)
        criteria.seen = true;
    if (params.flagged === true)
        criteria.flagged = true;
    if (params.flagged === false)
        criteria.unflagged = true;
    const sinceDate = parseDate(params.since);
    if (sinceDate)
        criteria.since = sinceDate;
    const beforeDate = parseDate(params.before);
    if (beforeDate)
        criteria.before = beforeDate;
    return { criteria, gmailRawUsed: false };
}
function chooseFetchMode(queryGroups, hasAttachmentFilter) {
    if (queryGroups.length > 0)
        return "source"; // need body text for client-side matching
    if (hasAttachmentFilter)
        return "bodyStructure"; // attachment detection without full source
    return "envelope";
}
// ─── Runtime ──────────────────────────────────────────────────────────────────
function createRuntime(cfg) {
    return {
        async listMailboxes() {
            requireAuth(cfg);
            return withImapClient(cfg, async (client) => {
                const mailboxes = await client.list();
                return mailboxes.map((mb) => ({
                    path: mb.path,
                    name: mb.name,
                    delimiter: mb.delimiter,
                    flags: Array.from(mb.flags ?? []).map(String),
                    specialUse: mb.specialUse,
                }));
            });
        },
        async searchMessages(params) {
            requireAuth(cfg);
            const { effective, pickedOperators } = resolveSearchParams(params);
            const mailbox = effective.mailbox?.trim() || cfg.defaultMailbox;
            const limit = Math.min(effective.limit ?? cfg.defaultSearchLimit, 100);
            const queryGroups = parseQueryGroups(effective.query);
            const fetchMode = chooseFetchMode(queryGroups, effective.hasAttachment !== undefined);
            return withImapClient(cfg, (client) => withMailboxLock(client, mailbox, async () => {
                const { criteria, gmailRawUsed } = buildServerCriteria(effective, client, cfg);
                const matchedRaw = (await client.search(criteria, { uid: true })) ?? [];
                const matchedUids = (Array.isArray(matchedRaw) ? matchedRaw : []).map(Number);
                const baseInfo = {
                    serverSearchUsed: true,
                    matchedTotal: matchedUids.length,
                    gmailRawUsed,
                    fetchMode,
                    effectiveSince: effective.since,
                    pickedOperators: pickedOperators.length ? pickedOperators : undefined,
                    effectiveQuery: effective.query,
                };
                if (!matchedUids.length) {
                    return { messages: [], info: { ...baseInfo, scanned: 0, filteredClientSide: 0 } };
                }
                // Cap to avoid protocol and memory issues. When capped, take the highest UIDs
                // (most recently arrived in folder) as the best approximation of recency.
                const capped = matchedUids.length > FETCH_CANDIDATES_CAP;
                const fetchTargets = capped
                    ? [...matchedUids].sort((a, b) => b - a).slice(0, FETCH_CANDIDATES_CAP)
                    : matchedUids;
                const fetchQuery = buildFetchQuery({ uid: true, envelope: true, flags: true, internalDate: true }, { threadId: true, bodyStructure: fetchMode === "bodyStructure" });
                if (fetchMode === "source")
                    fetchQuery.source = true;
                const matches = [];
                let scanned = 0;
                let filteredClientSide = 0;
                let timedOut = false;
                const deadline = Date.now() + SEARCH_FETCH_TIMEOUT_MS;
                try {
                    for await (const item of client.fetch(buildImapSequenceSet(fetchTargets), fetchQuery, { uid: true })) {
                        if (Date.now() > deadline) {
                            timedOut = true;
                            break;
                        }
                        scanned++;
                        let bodyText = "";
                        let attachmentCount;
                        if (fetchMode === "source" && item.source) {
                            const parsed = await withTimeout(simpleParser(await readSourceText(item.source)), Math.max(1000, deadline - Date.now()), "simpleParser");
                            const textBody = (parsed.text ?? "").trim();
                            bodyText = textBody || (typeof parsed.html === "string" ? htmlToText(parsed.html) : "");
                            attachmentCount = (parsed.attachments ?? []).length;
                        }
                        else if (fetchMode === "bodyStructure") {
                            attachmentCount = bsHasAttachment(item.bodyStructure) ? 1 : 0;
                        }
                        const summary = toSummary(mailbox, item, bodyText, attachmentCount);
                        if (queryGroups.length > 0) {
                            const haystack = lower(`${summary.subject} ${summary.from} ${summary.to} ${summary.cc} ${bodyText}`);
                            if (!queryGroups.some((group) => group.every((term) => haystack.includes(lower(term))))) {
                                filteredClientSide++;
                                continue;
                            }
                        }
                        if (effective.hasAttachment === true && !(attachmentCount && attachmentCount > 0)) {
                            filteredClientSide++;
                            continue;
                        }
                        if (effective.hasAttachment === false && attachmentCount && attachmentCount > 0) {
                            filteredClientSide++;
                            continue;
                        }
                        matches.push(summary);
                    }
                }
                catch (err) {
                    if (err instanceof Error && /timed out/i.test(err.message))
                        timedOut = true;
                    else
                        throw err;
                }
                // Sort by internalDate descending — semantically correct ordering by arrival time.
                matches.sort((a, b) => (parseDate(b.date)?.valueOf() ?? 0) - (parseDate(a.date)?.valueOf() ?? 0));
                return {
                    messages: matches.slice(0, limit),
                    info: {
                        ...baseInfo,
                        scanned,
                        filteredClientSide,
                        partial: timedOut
                            ? { reason: `fetch loop exceeded ${SEARCH_FETCH_TIMEOUT_MS}ms`, processed: scanned, remaining: Math.max(0, fetchTargets.length - scanned) }
                            : capped
                                ? { reason: `server returned ${matchedUids.length} matches; fetched most recent ${FETCH_CANDIDATES_CAP}`, processed: fetchTargets.length, remaining: matchedUids.length - fetchTargets.length }
                                : undefined,
                    },
                };
            }));
        },
        async getMessage(params) {
            requireAuth(cfg);
            const mailbox = params.mailbox?.trim() || cfg.defaultMailbox;
            return withImapClient(cfg, (client) => withMailboxLock(client, mailbox, async () => {
                const fetchQuery = buildFetchQuery({ uid: true, envelope: true, flags: true, internalDate: true, source: true }, { threadId: true });
                const item = await client.fetchOne(String(params.uid), fetchQuery, { uid: true });
                if (!item)
                    throw new Error(`Message uid ${params.uid} not found`);
                return toFullMessage(mailbox, item);
            }));
        },
        async getThread(params) {
            requireAuth(cfg);
            const mailbox = params.mailbox?.trim() || cfg.defaultMailbox;
            return withImapClient(cfg, (client) => withMailboxLock(client, mailbox, async () => {
                if (!isGmailHost(cfg.imap.host) || !clientHasGmailExt(client)) {
                    throw new Error("gmail_thread_get requires the X-GM-EXT-1 IMAP extension (Gmail). Use gmail_message_get for a single message.");
                }
                // Resolve the thread ID from the seed UID (single lightweight fetch)
                const seedQuery = buildFetchQuery({ uid: true }, { threadId: true });
                const seed = await client.fetchOne(String(params.uid), seedQuery, { uid: true });
                const threadId = seed ? getGmailThreadId(seed) : undefined;
                if (!threadId)
                    throw new Error(`Cannot resolve X-GM-THRID for uid ${params.uid}.`);
                // Find all UIDs in the thread, then batch-fetch in a single round-trip
                const matchedRaw = (await client.search({ threadId }, { uid: true })) ?? [];
                const uids = (Array.isArray(matchedRaw) ? matchedRaw : []).map(Number).sort((a, b) => a - b);
                if (!uids.length)
                    return { mailbox, threadId, messages: [] };
                const fetchQuery = buildFetchQuery({ uid: true, envelope: true, flags: true, internalDate: true, source: true }, { threadId: true });
                const messages = [];
                for await (const item of client.fetch(buildImapSequenceSet(uids), fetchQuery, { uid: true })) {
                    messages.push(await toFullMessage(mailbox, item));
                }
                messages.sort((a, b) => (parseDate(a.date)?.valueOf() ?? 0) - (parseDate(b.date)?.valueOf() ?? 0));
                return { mailbox, threadId, messages };
            }));
        },
        async downloadAttachments(params) {
            requireAuth(cfg);
            const mailbox = params.mailbox?.trim() || cfg.defaultMailbox;
            const filterSet = params.filenames?.length ? new Set(params.filenames.map(String)) : null;
            return withImapClient(cfg, (client) => withMailboxLock(client, mailbox, async () => {
                const fetchQuery = buildFetchQuery({ uid: true, envelope: true, flags: true, internalDate: true, source: true }, { threadId: true });
                const item = await client.fetchOne(String(params.uid), fetchQuery, { uid: true });
                if (!item)
                    throw new Error(`Message uid ${params.uid} not found`);
                const parsed = await simpleParser(await readSourceText(item.source));
                const safeMailbox = sanitizeFsName(mailbox, "INBOX");
                const targetDir = join(cfg.attachmentsDir, `${safeMailbox}-${params.uid}`);
                await mkdir(targetDir, { recursive: true });
                const saved = [];
                const skipped = [];
                let i = 0;
                for (const att of (parsed.attachments ?? [])) {
                    i++;
                    const filename = sanitizeFsName(att.filename, `attachment-${i}`);
                    if (filterSet && att.filename && !filterSet.has(att.filename)) {
                        skipped.push({ filename: att.filename, reason: "not in filenames filter" });
                        continue;
                    }
                    if (!att.content || !Buffer.isBuffer(att.content)) {
                        skipped.push({ filename, reason: "no buffer content" });
                        continue;
                    }
                    const path = join(targetDir, filename);
                    await writeFile(path, att.content);
                    saved.push({ filename, path, contentType: att.contentType, size: att.size ?? att.content.length });
                }
                return { mailbox, uid: params.uid, directory: targetDir, saved, skipped };
            }));
        },
        async updateMessage(params) {
            requireAuth(cfg);
            const mailbox = params.mailbox?.trim() || cfg.defaultMailbox;
            return withImapClient(cfg, (client) => withMailboxLock(client, mailbox, async () => {
                if (typeof params.read === "boolean") {
                    const op = params.read ? client.messageFlagsAdd : client.messageFlagsRemove;
                    await op.call(client, String(params.uid), ["\\Seen"], { uid: true });
                }
                if (typeof params.flagged === "boolean") {
                    const op = params.flagged ? client.messageFlagsAdd : client.messageFlagsRemove;
                    await op.call(client, String(params.uid), ["\\Flagged"], { uid: true });
                }
                return { mailbox, uid: params.uid, read: params.read, flagged: params.flagged };
            }));
        },
        async moveMessage(params) {
            requireAuth(cfg);
            const sourceMailbox = params.mailbox?.trim() || cfg.defaultMailbox;
            return withImapClient(cfg, (client) => withMailboxLock(client, sourceMailbox, async () => {
                await client.messageMove(String(params.uid), params.destinationMailbox, { uid: true });
                return { sourceMailbox, destinationMailbox: params.destinationMailbox, uid: params.uid };
            }));
        },
        async sendMessage(params) {
            requireAuth(cfg);
            const mailOptions = {
                from: cfg.fromName ? `${cfg.fromName} <${cfg.from}>` : cfg.from,
                replyTo: cfg.replyTo,
                to: normalizeRecipients(params.to),
                cc: normalizeRecipients(params.cc),
                bcc: normalizeRecipients(params.bcc),
                subject: params.subject,
                text: params.text,
                html: params.html,
                inReplyTo: params.inReplyTo,
                references: params.references,
                attachments: (params.attachments ?? []).map((a) => ({
                    path: a.path,
                    filename: a.filename,
                    contentType: a.contentType,
                })),
            };
            // Build raw MIME message via nodemailer streamTransport
            const raw = await new Promise((resolve, reject) => {
                const builder = nodemailer.createTransport({
                    streamTransport: true,
                    buffer: true,
                });
                builder.sendMail(mailOptions, (err, info) => {
                    if (err) { reject(err); return; }
                    const buf = Buffer.isBuffer(info.message) ? info.message : Buffer.from(info.message);
                    resolve(buf.toString('base64url'));
                });
            });
            // Send via Gmail API with proxy support
            const apiResult = await googleApiPost(
                'gmail.googleapis.com',
                '/gmail/v1/users/me/messages/send',
                cfg.accessToken,
                JSON.stringify({ raw }),
            );
            return {
                accepted: normalizeRecipients(params.to),
                rejected: [],
                response: "Message sent via Gmail API.",
                messageId: apiResult.id,
                threadId: apiResult.threadId,
                subject: params.subject,
                to: normalizeRecipients(params.to),
                cc: normalizeRecipients(params.cc),
                bcc: normalizeRecipients(params.bcc),
            };
        },
    };
}
// ─── Formatters ───────────────────────────────────────────────────────────────
function formatMailboxList(mailboxes) {
    if (!mailboxes.length)
        return "(no mailboxes)";
    return mailboxes
        .map((mb) => `- ${mb.path}${mb.specialUse ? ` [${mb.specialUse}]` : ""}${mb.flags.length ? ` flags=${mb.flags.join(",")}` : ""}`)
        .join("\n");
}
function formatMessageList(messages, info) {
    if (!messages.length) {
        if (!info || info.matchedTotal === 0)
            return "(no messages match)";
        return `(no messages after client-side filters; matched=${info.matchedTotal}, scanned=${info.scanned}, filtered=${info.filteredClientSide})`;
    }
    const parts = info
        ? [
            `${messages.length} of ${info.matchedTotal} server matches`,
            `mode=${info.fetchMode}`,
            `scanned=${info.scanned}`,
            `filtered=${info.filteredClientSide}`,
            info.gmailRawUsed ? "gmailRaw" : null,
            info.effectiveSince ? `since=${info.effectiveSince.slice(0, 10)}` : null,
            info.pickedOperators?.length ? `extracted=[${info.pickedOperators.join(" ")}]` : null,
            info.effectiveQuery ? `q="${info.effectiveQuery}"` : null,
            info.partial ? `PARTIAL: ${info.partial.reason} (${info.partial.processed}/${info.partial.processed + info.partial.remaining})` : null,
        ].filter(Boolean).join(", ")
        : "";
    return ((parts ? `# ${parts}\n\n` : "") +
        messages
            .map((m) => {
            const flags = [m.unread ? "unread" : "", m.flagged ? "flagged" : "", m.hasAttachments ? "attach" : ""].filter(Boolean).join(",");
            return [
                `uid ${m.uid} [${m.mailbox}]${flags ? ` (${flags})` : ""}`,
                `  date: ${m.date ?? "?"}`,
                `  from: ${m.from}`,
                `  subject: ${m.subject}`,
                `  preview: ${m.preview}`,
            ].join("\n");
        })
            .join("\n\n"));
}
function formatMessage(message) {
    const lines = [
        `uid: ${message.uid}`,
        `mailbox: ${message.mailbox}`,
        `date: ${message.date ?? "?"}`,
        `from: ${message.from}`,
        `to: ${message.to}`,
    ];
    if (message.cc)
        lines.push(`cc: ${message.cc}`);
    if (message.replyTo)
        lines.push(`reply-to: ${message.replyTo}`);
    lines.push(`subject: ${message.subject}`, `flags: ${message.flags.join(", ") || "(none)"}`);
    if (message.threadId)
        lines.push(`thread: ${message.threadId}`);
    lines.push(message.attachments.length
        ? `attachments: ${message.attachments.map((a) => `${a.filename || a.contentType || "attachment"}${a.size ? ` (${a.size}B)` : ""}`).join(", ")}`
        : "attachments: (none)");
    const bodyHeader = message.bodySource === "html-fallback" ? "body (extracted from html):" :
        message.bodySource === "none" ? "body: (no text or html)" : "body:";
    lines.push("", bodyHeader, truncate(message.bodyText || "(empty)", BODY_TEXT_LIMIT));
    return lines.join("\n");
}
function formatThread(bundle) {
    return [
        `Thread ${bundle.threadId} in ${bundle.mailbox} — ${bundle.messages.length} message(s)`,
        "",
        ...bundle.messages.map((m, idx) => {
            const flags = [m.unread ? "unread" : "", m.flagged ? "flagged" : "", m.hasAttachments ? "attach" : ""].filter(Boolean).join(",");
            return [
                `--- [${idx + 1}/${bundle.messages.length}] uid ${m.uid}${flags ? ` (${flags})` : ""}`,
                `date: ${m.date ?? "?"}`,
                `from: ${m.from}`,
                `to: ${m.to}`,
                `subject: ${m.subject}`,
                "",
                truncate(m.bodyText || "(empty)", 1500),
            ].join("\n");
        }),
    ].join("\n");
}
function toolTextResult(text, details) {
    return { content: [{ type: "text", text }], details };
}
// ─── Plugin entry ─────────────────────────────────────────────────────────────
const recipientSchema = Type.Union([
    Type.String({ minLength: 1 }),
    Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
]);
const attachmentInputSchema = Type.Object({
    path: Type.String({ minLength: 1 }),
    filename: Type.Optional(Type.String({ minLength: 1 })),
    contentType: Type.Optional(Type.String({ minLength: 1 })),
});
const gmailPlugin = definePluginEntry({
    id: "gmail",
    name: "Gmail",
    description: "Read, search (server-side IMAP + Gmail X-GM-RAW), send, reply, organize, and download attachments using a Gmail App Password.",
    register(api) {
        const cfg = normalizeConfig((api.pluginConfig ?? {}));
        const runtime = createRuntime(cfg);
        api.registerTool({
            name: "gmail_authorize",
            label: "Authorize Gmail",
            description: "Start Gmail OAuth 2.0 authorization. Opens a browser for the user to grant Gmail access, waits for completion, and saves the tokens to disk. Blocks until the browser flow completes. Returns the authorized email on success.",
            parameters: Type.Object({
                forceRelogin: Type.Optional(Type.Boolean({ description: "Force re-authorization even if already authorized" })),
            }),
            async execute(_id, params) {
                const pluginDir = process.cwd();
                const { config, configPath } = resolveAuth(pluginDir);
                if (!params.forceRelogin && config.refreshToken && config.email) {
                    return toolTextResult(`Gmail is already authorized as ${config.email}.`, { status: "ok", email: config.email, alreadyAuthorized: true });
                }
                const clientId = GOOGLE_APP_CLIENT_ID || config.clientId || '';
                const clientSecret = GOOGLE_APP_CLIENT_SECRET || config.clientSecret || '';
                if (!clientId || !clientSecret) {
                    throw new Error('Missing OAuth credentials. Set GOOGLE_APP_CLIENT_ID and GOOGLE_APP_CLIENT_SECRET in plugins.config.json → environment.gmail, or as environment variables.');
                }
                const port = 18080;
                const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
                const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
                authUrl.searchParams.set('client_id', clientId);
                authUrl.searchParams.set('redirect_uri', redirectUri);
                authUrl.searchParams.set('response_type', 'code');
                authUrl.searchParams.set('scope', 'https://mail.google.com/ openid email');
                authUrl.searchParams.set('access_type', 'offline');
                authUrl.searchParams.set('prompt', 'consent');
                return new Promise((resolvePromise, rejectPromise) => {
                    const server = http.createServer(async (req, res) => {
                        const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${port}`);
                        if (reqUrl.pathname !== '/oauth/callback') { res.writeHead(404); res.end('Not found'); return; }
                        const code = reqUrl.searchParams.get('code');
                        const error = reqUrl.searchParams.get('error');
                        if (error) {
                            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                            res.end('<html><body><h3>Authorization Denied</h3><p>You may close this window.</p></body></html>');
                            server.close();
                            resolvePromise(toolTextResult('Authorization was denied by the user.', { status: "error", error: `Authorization denied: ${error}` }));
                            return;
                        }
                        if (!code) {
                            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                            res.end('<html><body><h3>Error</h3><p>No authorization code received.</p></body></html>');
                            server.close();
                            resolvePromise(toolTextResult('No authorization code received.', { status: "error", error: 'No authorization code received.' }));
                            return;
                        }
                        try {
                            const tokenResp = await googleApiPost('oauth2.googleapis.com', '/token', '', new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }).toString(), 'application/x-www-form-urlencoded');
                            const accessToken = tokenResp.access_token || '';
                            const refreshTokenVal = tokenResp.refresh_token || config.refreshToken || '';
                            const expiresIn = tokenResp.expires_in || 3599;
                            let email = '';
                            if (tokenResp.id_token) {
                                try {
                                    const payload = tokenResp.id_token.split('.')[1];
                                    const padded = payload.length % 4 === 2 ? payload + '==' : payload.length % 4 === 3 ? payload + '=' : payload;
                                    email = JSON.parse(Buffer.from(padded, 'base64').toString('utf-8')).email || '';
                                } catch {}
                            }
                            config.accessToken = accessToken;
                            config.refreshToken = refreshTokenVal;
                            config.tokenExpiry = Date.now() + expiresIn * 1000;
                            if (email) config.email = email;
                            try { writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch {}
                            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                            res.end('<html><body><h3>Authorization Successful!</h3><p>You may close this window and return to TelyClaw.</p></body></html>');
                            server.close();
                            resolvePromise(toolTextResult(`Gmail authorization successful! Authorized as ${email || 'unknown'}.`, { status: "ok", email: email || null }));
                        } catch (err) {
                            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                            res.end(`<html><body><h3>Error</h3><p>Token exchange failed: ${err.message}</p></body></html>`);
                            server.close();
                            resolvePromise(toolTextResult(`Token exchange failed: ${err.message}`, { status: "error", error: err.message }));
                        }
                    });
                    server.on('error', (err) => {
                        if (err.code === 'EADDRINUSE') rejectPromise(new Error(`Port ${port} is already in use. Is another OAuth flow or application running on that port?`));
                        else rejectPromise(err);
                    });
                    server.listen(port, '127.0.0.1', () => {
                        const url = authUrl.toString();
                        if (process.platform === 'darwin') spawn('open', [url]);
                        else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', url]);
                        else spawn('xdg-open', [url]);
                    });
                });
            },
        });
        api.registerTool({
            name: "gmail_mailboxes_list",
            label: "List mailboxes",
            description: "List the mailboxes (folders/labels) on the configured account.",
            parameters: Type.Object({}, { additionalProperties: false }),
            async execute() {
                const mailboxes = await runtime.listMailboxes();
                return toolTextResult(formatMailboxList(mailboxes), { status: "ok", count: mailboxes.length, mailboxes });
            },
        });
        api.registerTool({
            name: "gmail_messages_search",
            label: "Search messages",
            description: "Server-side IMAP search. `query` accepts free text (AND by default) or `OR` for alternation. Inline Gmail-style operators are auto-extracted: `from:`, `to:`, `subject:`, `has:attachment`, `is:unread`, `is:starred`, `in:LABEL`, `before:YYYY-MM-DD`, `after:YYYY-MM-DD`. Explicit params win over inline operators. Use `gmailRaw` to pass a raw Gmail search expression (Gmail only). When no date range is provided, defaults to the last 30 days. Paginate by passing `before` with the `date` field of the last seen message.",
            parameters: Type.Object({
                mailbox: Type.Optional(Type.String({ minLength: 1 })),
                query: Type.Optional(Type.String({ minLength: 1 })),
                from: Type.Optional(Type.String({ minLength: 1 })),
                to: Type.Optional(Type.String({ minLength: 1 })),
                subject: Type.Optional(Type.String({ minLength: 1 })),
                unread: Type.Optional(Type.Boolean()),
                flagged: Type.Optional(Type.Boolean()),
                hasAttachment: Type.Optional(Type.Boolean()),
                since: Type.Optional(Type.String({ minLength: 1 })),
                before: Type.Optional(Type.String({ minLength: 1, description: "Upper bound on internalDate (ISO or YYYY-MM-DD). Use as pagination cursor." })),
                limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
                gmailRaw: Type.Optional(Type.String({ minLength: 1 })),
            }),
            async execute(_id, params) {
                const result = await runtime.searchMessages(params);
                return toolTextResult(formatMessageList(result.messages, result.info), {
                    status: "ok",
                    count: result.messages.length,
                    messages: result.messages,
                    info: result.info,
                });
            },
        });
        api.registerTool({
            name: "gmail_message_get",
            label: "Get message",
            description: "Fetch one message by UID with full body and attachment metadata. HTML-only messages are auto-converted to plain text.",
            parameters: Type.Object({
                mailbox: Type.Optional(Type.String({ minLength: 1 })),
                uid: Type.Integer({ minimum: 1 }),
            }),
            async execute(_id, params) {
                const message = await runtime.getMessage(params);
                return toolTextResult(formatMessage(message), { status: "ok", message });
            },
        });
        api.registerTool({
            name: "gmail_thread_get",
            label: "Get thread (Gmail)",
            description: "Fetch all messages in the same Gmail thread as the given UID, ordered chronologically. Requires Gmail (X-GM-EXT-1). All thread messages are fetched in a single IMAP round-trip.",
            parameters: Type.Object({
                mailbox: Type.Optional(Type.String({ minLength: 1 })),
                uid: Type.Integer({ minimum: 1 }),
            }),
            async execute(_id, params) {
                const bundle = await runtime.getThread(params);
                return toolTextResult(formatThread(bundle), { status: "ok", ...bundle });
            },
        });
        api.registerTool({
            name: "gmail_message_attachments_save",
            label: "Save attachments",
            description: "Download all (or filtered) attachments of one message to the configured attachments directory.",
            parameters: Type.Object({
                mailbox: Type.Optional(Type.String({ minLength: 1 })),
                uid: Type.Integer({ minimum: 1 }),
                filenames: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
            }),
            async execute(_id, params) {
                const result = await runtime.downloadAttachments(params);
                const lines = [
                    `mailbox: ${result.mailbox}`,
                    `uid: ${result.uid}`,
                    `directory: ${result.directory}`,
                    `saved: ${result.saved.length}`,
                    ...result.saved.map((a) => `  - ${a.filename} (${a.contentType ?? "?"}, ${a.size}B) -> ${a.path}`),
                ];
                if (result.skipped.length) {
                    lines.push(`skipped: ${result.skipped.length}`);
                    for (const s of result.skipped)
                        lines.push(`  - ${s.filename}: ${s.reason}`);
                }
                return toolTextResult(lines.join("\n"), { status: result.saved.length > 0 ? "ok" : "empty", ...result });
            },
        });
        api.registerTool({
            name: "gmail_message_update",
            label: "Update flags",
            description: "Mark one message as read/unread and/or set/clear its starred state.",
            parameters: Type.Object({
                mailbox: Type.Optional(Type.String({ minLength: 1 })),
                uid: Type.Integer({ minimum: 1 }),
                read: Type.Optional(Type.Boolean()),
                flagged: Type.Optional(Type.Boolean()),
            }),
            async execute(_id, params) {
                if (typeof params.read !== "boolean" && typeof params.flagged !== "boolean") {
                    throw new Error("Provide at least one flag update: read and/or flagged.");
                }
                const result = await runtime.updateMessage(params);
                return toolTextResult(`Updated ${result.mailbox} uid ${result.uid}${typeof result.read === "boolean" ? ` read=${result.read}` : ""}${typeof result.flagged === "boolean" ? ` flagged=${result.flagged}` : ""}`, { status: "updated", ...result });
            },
        });
        api.registerTool({
            name: "gmail_message_move",
            label: "Move message",
            description: "Move one message to another mailbox.",
            parameters: Type.Object({
                mailbox: Type.Optional(Type.String({ minLength: 1 })),
                uid: Type.Integer({ minimum: 1 }),
                destinationMailbox: Type.String({ minLength: 1 }),
            }),
            async execute(_id, params) {
                const result = await runtime.moveMessage(params);
                return toolTextResult(`Moved uid ${result.uid} from ${result.sourceMailbox} to ${result.destinationMailbox}`, { status: "moved", ...result });
            },
        });
        api.registerTool({
            name: "gmail_message_send",
            label: "Send message",
            description: "Send a new email. With requireExplicitSendConfirmation=true (default), must pass confirm=true.",
            parameters: Type.Object({
                to: recipientSchema,
                cc: Type.Optional(recipientSchema),
                bcc: Type.Optional(recipientSchema),
                subject: Type.String({ minLength: 1 }),
                text: Type.Optional(Type.String()),
                html: Type.Optional(Type.String()),
                attachments: Type.Optional(Type.Array(attachmentInputSchema)),
                confirm: Type.Optional(Type.Boolean()),
            }),
            async execute(_id, params) {
                if (cfg.requireExplicitSendConfirmation && params.confirm !== true) {
                    return toolTextResult("Refusing to send: requireExplicitSendConfirmation is enabled and confirm=true was not provided.", { status: "refused", reason: "missing_confirmation" });
                }
                if (!params.text && !params.html)
                    throw new Error("Provide text and/or html body");
                const result = await runtime.sendMessage(params);
                return toolTextResult(`Sent. accepted=[${result.accepted.join(", ")}] rejected=[${result.rejected.join(", ")}] subject="${result.subject}"`, { status: "sent", ...result });
            },
        });
        api.registerTool({
            name: "gmail_message_reply",
            label: "Reply to message",
            description: "Reply to an existing message by UID. replyAll=true CCs all original recipients (excluding self).",
            parameters: Type.Object({
                mailbox: Type.Optional(Type.String({ minLength: 1 })),
                uid: Type.Integer({ minimum: 1 }),
                text: Type.Optional(Type.String()),
                html: Type.Optional(Type.String()),
                replyAll: Type.Optional(Type.Boolean()),
                attachments: Type.Optional(Type.Array(attachmentInputSchema)),
                confirm: Type.Optional(Type.Boolean()),
            }),
            async execute(_id, params) {
                if (cfg.requireExplicitSendConfirmation && params.confirm !== true) {
                    return toolTextResult("Refusing to reply: requireExplicitSendConfirmation is enabled and confirm=true was not provided.", { status: "refused", reason: "missing_confirmation" });
                }
                if (!params.text && !params.html)
                    throw new Error("Provide text and/or html body");
                const original = await runtime.getMessage(params);
                const ownAddresses = uniqueStrings([lower(cfg.from), lower(cfg.username)]);
                const replyTarget = original.replyTo || original.from;
                const subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
                const messageIdRef = original.messageId
                    ? `<${String(original.messageId).replace(/^<|>$/g, "")}>`
                    : undefined;
                const references = uniqueStrings([...(original.references ?? []), messageIdRef ?? ""].filter(Boolean));
                let to;
                let cc = [];
                if (params.replyAll) {
                    const all = uniqueStrings([replyTarget, original.to, original.cc].join(",").split(",").map((s) => s.trim()).filter(Boolean)).filter((addr) => !ownAddresses.includes(lower(addr)));
                    to = all.slice(0, 1);
                    cc = all.slice(1);
                }
                else {
                    to = [replyTarget].filter(Boolean);
                }
                const quoted = original.bodyText
                    ? `\n\nOn ${original.date ?? ""}, ${original.from} wrote:\n${original.bodyText.split("\n").map((l) => `> ${l}`).join("\n")}`
                    : "";
                const result = await runtime.sendMessage({
                    to,
                    cc,
                    subject,
                    text: params.text ? `${params.text}${quoted}` : undefined,
                    html: params.html,
                    inReplyTo: messageIdRef,
                    references,
                    attachments: params.attachments,
                });
                return toolTextResult(`Replied. accepted=[${result.accepted.join(", ")}] subject="${result.subject}"`, { status: "sent", ...result });
            },
        });
    },
});

export default gmailPlugin;

// ─── Auth helper (called by the CLI entry point, not by tools directly) ─────
// Tools check auth via requireAuth(cfg) which throws AUTH_REQUIRED_ERROR.
// It's the AI's job to see that error and guide the user through gmail_authorize.
// This function is exported so the CLI entry point can resolve tokens before
// registering tools — but it never triggers the OAuth flow itself.

export function resolveAuth(pluginDir) {
  const configPath = resolve(pluginDir, 'config.json');
  let config = {};
  try { config = JSON.parse(readFileSync(configPath, 'utf-8')); } catch { /* ok */ }

  const username = config.email || '';
  const accessToken = config.accessToken || '';

  return { username, accessToken, config, configPath };
}

export async function refreshTokenIfExpired({ accessToken, config, configPath }) {
  if (!accessToken) return accessToken;

  const expiry = config.tokenExpiry || 0;
  if (!expiry || Date.now() < expiry - 300_000) return accessToken;

  const refreshToken = config.refreshToken;
  const clientId = config.clientId || GOOGLE_APP_CLIENT_ID;
  const clientSecret = config.clientSecret || GOOGLE_APP_CLIENT_SECRET;
  if (!refreshToken || !clientId || !clientSecret) return accessToken;

  try {
    const resp = await googleApiPost(
      'oauth2.googleapis.com',
      '/token',
      '',
      new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
      'application/x-www-form-urlencoded',
    );
    if (resp.access_token) {
      config.accessToken = resp.access_token;
      config.tokenExpiry = Date.now() + (resp.expires_in || 3599) * 1000;
      try { writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch { /* ok */ }
      return resp.access_token;
    }
  } catch { /* keep existing token */ }

  return accessToken;
}
