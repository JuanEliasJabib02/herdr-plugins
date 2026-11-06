// The OAuth token of an account, read-only (D3, D4). Owner: T3. Tokens are
// never refreshed, logged or written anywhere: Claude Code owns them. Nothing
// here puts a token, or any text that could hold one (the item's JSON, a
// parse error quoting it, `security`'s stdout), into an error or a message.
//
// - keychainService(configDir): the Keychain item's service name.
//   `Claude Code-credentials` for System default (configDir null), else
//   `Claude Code-credentials-` plus the first 8 hex of sha256(configDir),
//   hashed from the exact string (D2's invariant), in Unicode NFC as Claude
//   Code 2.1+ and Orca hash it (main/claude-accounts/keychain.ts).
// - readCredentials(configDir, { signal, env }): `security
//   find-generic-password -s <item> -a <user> -w` with Orca's 3 s timeout
//   (main/macos-keychain/generic-password.ts), then
//   <configDir>/.credentials.json (~/.claude's for System default) when the
//   item holds no token, as Orca's readClaudeOAuthCredentials does. Resolves
//   to one of:
//     { accessToken, hasRefreshToken, refreshTokenExpiresAt }  a token
//     { needsSignIn: true }   no token anywhere: the item is absent (exit
//                             44) and so is the file, or neither has one
//     { error: "keychain" }   the item couldn't be read (a timeout, any
//                             other failure, unreadable JSON) and the file
//                             gave no token either
//   refreshTokenExpiresAt is epoch ms or null. `signal` aborts the read (the
//   `security` child is killed); the caller checks signal.aborted.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { defaultConfigDir } from "./paths.mjs";

const SERVICE = "Claude Code-credentials";
// Orca's KEYCHAIN_COMMAND_TIMEOUT_MS.
const SECURITY_TIMEOUT_MS = 3_000;
// `security`'s exit code for "The specified item could not be found".
const ITEM_ABSENT = 44;
// Claude 2.1+ names the item's account after the user, or this fallback when
// the name isn't a plain one (an SSO email, say): Orca's getKeychainUser.
const KEYCHAIN_ACCOUNT_PATTERN = /^[a-zA-Z0-9._-]+$/;
const FALLBACK_USER = "claude-code-user";

export function keychainService(configDir) {
  if (!configDir) return SERVICE;
  const suffix = createHash("sha256").update(configDir.normalize("NFC")).digest("hex").slice(0, 8);
  return `${SERVICE}-${suffix}`;
}

function keychainUser(env) {
  let user;
  try {
    user = env.USER || env.USERNAME || userInfo().username;
  } catch {
    return FALLBACK_USER;
  }
  return KEYCHAIN_ACCOUNT_PATTERN.test(user ?? "") ? user : FALLBACK_USER;
}

// One `security` read: { status: "found", text } | { status: "absent" } |
// { status: "failed" }. The outer timer settles even when the callback never
// comes (a grandchild holding stdout open), as Orca's execSecurityCommand does.
function readItem(service, account, signal) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child?.kill();
      settle({ status: "failed" });
    }, SECURITY_TIMEOUT_MS);
    try {
      child = execFile(
        "security",
        ["find-generic-password", "-s", service, "-a", account, "-w"],
        { timeout: SECURITY_TIMEOUT_MS, signal, encoding: "utf8", maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (!error) {
            const text = stdout.trim();
            settle(text ? { status: "found", text } : { status: "failed" });
            return;
          }
          const absent = error.code === ITEM_ABSENT || /could not be found/i.test(String(stderr ?? ""));
          settle({ status: absent ? "absent" : "failed" });
        },
      );
    } catch {
      settle({ status: "failed" });
    }
  });
}

// Claude's credentials JSON (the item, or .credentials.json):
// { claudeAiOauth: { accessToken, refreshToken, refreshTokenExpiresAt, … } }.
// Never echoes the text: a JSON.parse message quotes it.
function parseCredentials(text) {
  let oauth;
  try {
    oauth = JSON.parse(text)?.claudeAiOauth;
  } catch {
    return { unreadable: true };
  }
  const accessToken = typeof oauth?.accessToken === "string" && oauth.accessToken ? oauth.accessToken : null;
  const expires = oauth?.refreshTokenExpiresAt;
  return {
    accessToken,
    hasRefreshToken: typeof oauth?.refreshToken === "string" && oauth.refreshToken !== "",
    refreshTokenExpiresAt: typeof expires === "number" && Number.isFinite(expires) ? expires : null,
  };
}

export async function readCredentials(configDir, { signal, env = process.env } = {}) {
  const item = await readItem(keychainService(configDir), keychainUser(env), signal);
  let keychainFailed = item.status === "failed";
  if (item.status === "found") {
    const fromItem = parseCredentials(item.text);
    if (fromItem.accessToken) return fromItem;
    if (fromItem.unreadable) keychainFailed = true;
  }
  const noToken = () => (keychainFailed ? { error: "keychain" } : { needsSignIn: true });
  let text;
  try {
    text = await readFile(join(configDir ?? defaultConfigDir(env), ".credentials.json"), "utf8");
  } catch (e) {
    return e.code === "ENOENT" || e.code === "ENOTDIR" ? noToken() : { error: "keychain" };
  }
  const fromFile = parseCredentials(text);
  if (fromFile.accessToken) return fromFile;
  return fromFile.unreadable ? { error: "keychain" } : noToken();
}
