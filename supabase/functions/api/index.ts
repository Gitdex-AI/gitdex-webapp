// Supabase Edge Function entry: REST (/api/v1/*) and MCP (/api/mcp) over the
// shared GitDex application. No LLM is called anywhere in this function.

import postgres from "npm:postgres@3.4.7";
import type { VerifiedUser } from "../_shared/account.ts";
import { createApp } from "../_shared/app.ts";
import type { Db, Param } from "../_shared/db.ts";
import { createJwtVerifier } from "../_shared/jwt.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const BASE_URL = (Deno.env.get("GITDEX_BASE_URL") ?? "https://gitdex.ai").replace(/\/$/, "");

// `prepare: false` keeps this compatible with Supabase's transaction pooler.
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 3, idle_timeout: 20 });

// deno-lint-ignore no-explicit-any
function wrap(client: any): Db {
  return {
    async query(text: string, params: Param[] = []) {
      return [...(await client.unsafe(text, params))] as Record<string, unknown>[];
    },
    tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      // deno-lint-ignore no-explicit-any
      return client.begin((inner: any) => fn(wrap(inner))) as Promise<T>;
    },
  };
}

const verifyLocally = createJwtVerifier({ issuer: `${SUPABASE_URL}/auth/v1` });

// deno-lint-ignore no-explicit-any
function verifiedUser(id: unknown, appMetadata: any, userMetadata: any, clientId: unknown): VerifiedUser {
  const provider = String(appMetadata?.provider ?? "email");
  return {
    id: String(id),
    provider,
    // Only a GitHub login is a public handle; emails and real names stay private.
    handle: provider === "github" ? (userMetadata?.user_name ?? null) : null,
    oauthClientId: typeof clientId === "string" ? clientId : null,
  };
}

/** Asks the Auth server about a token the local check could not decide. */
async function verifyRemotely(token: string): Promise<VerifiedUser | null> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
  });
  if (!response.ok) return null;
  const user = await response.json();
  if (!user?.id) return null;
  let clientId: unknown = null;
  try {
    clientId = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).client_id;
  } catch {
    clientId = null;
  }
  return verifiedUser(user.id, user.app_metadata, user.user_metadata, clientId);
}

/**
 * Validates a Supabase access token (browser session or OAuth client). The
 * signature is checked here against the project's public keys, which saves a
 * call to the Auth server on every request; a token signed out or banned in
 * Supabase Auth therefore keeps working until it expires (an hour at most).
 * Suspending an account in GitDex still applies at once: `profiles.status` is
 * read on every request.
 */
async function verifyJwt(token: string): Promise<VerifiedUser | null> {
  const claims = await verifyLocally(token);
  if (claims === "invalid") return null;
  // A signed-in user's token carries these claims; anything else goes to the Auth server.
  if (
    claims === "unknown" || typeof claims.sub !== "string" || claims.role !== "authenticated" ||
    typeof claims.app_metadata !== "object" || !claims.app_metadata
  ) {
    return await verifyRemotely(token);
  }
  return verifiedUser(claims.sub, claims.app_metadata, claims.user_metadata, claims.client_id);
}

const app = createApp({
  db: wrap(sql),
  verifyJwt,
  baseUrl: BASE_URL,
  authServer: `${SUPABASE_URL}/auth/v1`,
  proxySecret: Deno.env.get("GITDEX_PROXY_SECRET") ?? undefined,
  onError: (err) => console.error("gitdex internal error", err),
});

Deno.serve(app);
