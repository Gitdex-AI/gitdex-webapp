// Test harness: the real migration applied to in-process Postgres (PGlite),
// and the real HTTP application on top of it.

import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { createApp } from "../supabase/functions/_shared/app.ts";
import type { Db, Param } from "../supabase/functions/_shared/db.ts";

export const BASE = "https://gitdex.test";

const USERS: Record<string, { id: string; provider: string; handle: string | null }> = {
  alice: { id: "00000000-0000-4000-8000-00000000000a", provider: "github", handle: "alice" },
  bob: { id: "00000000-0000-4000-8000-00000000000b", provider: "github", handle: "bob" },
  carol: { id: "00000000-0000-4000-8000-00000000000c", provider: "email", handle: null },
  dave: { id: "00000000-0000-4000-8000-00000000000d", provider: "google", handle: null },
};

// deno-lint-ignore no-explicit-any
function wrap(client: any): Db {
  return {
    async query(text: string, params: Param[] = []) {
      return (await client.query(text, params)).rows as Record<string, unknown>[];
    },
    tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      // deno-lint-ignore no-explicit-any
      return client.transaction((inner: any) => fn(wrap(inner))) as Promise<T>;
    },
  };
}

export interface Harness {
  db: Db;
  userId(name: string): string;
  /** Call the REST API. `as` is a user name from USERS, a raw bearer token, or null for anonymous. */
  api(method: string, path: string, opts?: { as?: string | null; body?: unknown; key?: string; headers?: Record<string, string> }): Promise<{ status: number; body: any; headers: Headers }>;
  /** Call an MCP method on /mcp (or /mcp/public). */
  mcp(method: string, params?: unknown, opts?: { as?: string | null; publicEndpoint?: boolean }): Promise<{ status: number; body: any; headers: Headers }>;
  /** Call an MCP tool and return the decoded structured result. */
  tool(name: string, args: Record<string, unknown>, opts?: { as?: string | null; publicEndpoint?: boolean }): Promise<{ isError: boolean; data: any }>;
  close(): Promise<void>;
}

let keyCounter = 0;
export function newKey(): string {
  keyCounter += 1;
  return `test-key-${keyCounter}-${Math.random().toString(16).slice(2)}`;
}

export async function createHarness(): Promise<Harness> {
  const pg = new PGlite();
  // Minimal stand-ins for the Supabase-managed objects the migration references.
  await pg.exec(`
    create schema auth;
    create table auth.users (id uuid primary key);
    create role anon;
    create role authenticated;
  `);
  const dir = new URL("../supabase/migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) {
    await pg.exec(readFileSync(new URL(file, dir), "utf8"));
  }
  for (const user of Object.values(USERS)) {
    await pg.query(`insert into auth.users (id) values ($1)`, [user.id]);
  }
  const db = wrap(pg);
  const app = createApp({
    db,
    baseUrl: BASE,
    authServer: "https://auth.gitdex.test/auth/v1",
    proxySecret: "proxy-secret",
    verifyJwt: (token) => {
      const user = USERS[token.replace(/^jwt-/, "").replace(/-oauth$/, "")];
      if (!token.startsWith("jwt-") || !user) return Promise.resolve(null);
      return Promise.resolve({ ...user, oauthClientId: token.endsWith("-oauth") ? "client-1" : null });
    },
    onError: (err) => console.error(err),
  });

  const authHeader = (as: string | null | undefined): Record<string, string> => {
    if (!as) return {};
    // "alice" = browser session token, "alice-oauth" = token issued to an OAuth client
    return { authorization: `Bearer ${USERS[as.replace(/-oauth$/, "")] ? `jwt-${as}` : as}` };
  };

  const send = async (req: Request) => {
    const res = await app(req);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };

  const harness: Harness = {
    db,
    userId: (name) => USERS[name].id,
    api: (method, path, opts = {}) => {
      const headers: Record<string, string> = { ...authHeader(opts.as), ...(opts.headers ?? {}) };
      if (opts.key) headers["idempotency-key"] = opts.key;
      if (opts.body !== undefined) headers["content-type"] = "application/json";
      return send(
        new Request(`${BASE}/api/v1${path}`, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        }),
      );
    },
    mcp: (method, params, opts = {}) =>
      send(
        new Request(`${BASE}/mcp${opts.publicEndpoint ? "/public" : ""}`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...authHeader(opts.as) },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        }),
      ),
    tool: async (name, args, opts = {}) => {
      const res = await harness.mcp("tools/call", { name, arguments: args }, opts);
      if (res.status !== 200 || !res.body.result) throw new Error(`MCP call failed: ${res.status} ${JSON.stringify(res.body)}`);
      return { isError: res.body.result.isError, data: res.body.result.structuredContent };
    },
    close: () => pg.close(),
  };
  return harness;
}

export const SAMPLE_REQUEST = {
  title: "Free iOS home inventory app",
  goal: "Find household items by room, cabinet and drawer",
  must_have: ["nested storage locations", "fast item search", "free core functionality"],
  nice_to_have: ["iCloud sync", "photo attachments"],
  platforms: ["iOS"],
  price_constraint: "no recurring subscription",
};

export const SAMPLE_SOFTWARE = {
  name: "Shelfwise",
  url: "https://www.shelfwise.example.com/",
  description: "Home inventory tracker with nested rooms, cabinets and drawers.",
  capabilities: ["nested storage locations", "item search", "photo attachments"],
  platforms: ["iOS", "Web"],
  pricing_type: "freemium",
  sources: [{ url: "https://shelfwise.example.com/pricing", claim: "Core features are free", source_type: "official_site" }],
};

/** Publish helpers that go through the full two-step confirmation over REST. */
export async function publishRequest(h: Harness, as: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await h.api("POST", "/requests", { as, key: newKey(), body: { ...SAMPLE_REQUEST, ...overrides, confirmed: true } });
  if (res.status !== 200) throw new Error(`publishRequest failed: ${JSON.stringify(res.body)}`);
  return res.body.request_id;
}

export async function publishSoftware(h: Harness, as: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await h.api("POST", "/software", { as, key: newKey(), body: { ...SAMPLE_SOFTWARE, ...overrides, confirmed: true } });
  if (res.status !== 200) throw new Error(`publishSoftware failed: ${JSON.stringify(res.body)}`);
  return res.body.software_id;
}

export async function publishProposal(h: Harness, as: string, requestId: string, softwareId: string): Promise<string> {
  const res = await h.api("POST", "/solutions", {
    as,
    key: newKey(),
    body: {
      request_id: requestId,
      software_id: softwareId,
      coverage_notes: "Covers nested locations and search; core features are free.",
      unmet_requirements: ["iCloud sync not verified"],
      confirmed: true,
    },
  });
  if (res.status !== 200) throw new Error(`publishProposal failed: ${JSON.stringify(res.body)}`);
  return res.body.proposal_id;
}
