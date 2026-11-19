// Runtime-agnostic HTTP application: auth, rate limiting, idempotency, and the
// REST and MCP adapters over the shared operation registry.

import { actorFromApiToken, API_TOKEN_PREFIX, ensureProfile, type VerifiedUser } from "./account.ts";
import { type Actor, type Ctx, enforceRateLimit, requireActor } from "./common.ts";
import type { Db } from "./db.ts";
import { GitdexError, toGitdexError } from "./errors.ts";
import { GUIDE_NAMES, guideDocs, mcpInstructions, PROMPTS } from "./guide.ts";
import { buildOpenApi } from "./openapi.ts";
import { MCP_TOOLS, type Operation, OPERATIONS, toolInputSchema } from "./operations.ts";
import { sha256Hex, stableStringify } from "./validate.ts";

export const VERSION = "1.0.0";

export interface AppDeps {
  db: Db;
  /** Validates a Supabase-issued access token (browser session or OAuth client). */
  verifyJwt(token: string): Promise<VerifiedUser | null>;
  /** Public site origin, e.g. https://gitdex.ai */
  baseUrl: string;
  /** OAuth authorization server issuer, e.g. https://<ref>.supabase.co/auth/v1 */
  authServer: string;
  /** Shared secret proving a request came through the web worker (trusts its client IP header). */
  proxySecret?: string;
  onError?(err: unknown): void;
}

const LIMITS = {
  anonReadsPerMinute: 120,
  userReadsPerMinute: 600,
  writesPerHour: 120,
  // A moderator works through a queue; every action is two writes (preview, then confirm).
  moderationWritesPerHour: 1200,
};

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, idempotency-key, x-gitdex-client, mcp-protocol-version, mcp-session-id",
  "access-control-expose-headers": "www-authenticate",
  "access-control-max-age": "86400",
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS, ...headers },
  });
}

export function protectedResourceMetadata(deps: { baseUrl: string; authServer: string }) {
  return {
    resource: `${deps.baseUrl}/mcp`,
    authorization_servers: [deps.authServer],
    bearer_methods_supported: ["header"],
    resource_name: "GitDex",
    resource_documentation: `${deps.baseUrl}/connect`,
  };
}

interface Compiled {
  op: Operation;
  regex: RegExp;
  params: string[];
}

const ROUTES: Compiled[] = OPERATIONS.map((op) => {
  const params: string[] = [];
  const pattern = op.rest.path.replace(/\{(\w+)\}/g, (_m, name) => {
    params.push(name);
    return "([^/]+)";
  });
  return { op, regex: new RegExp(`^${pattern}$`), params };
});

export function createApp(deps: AppDeps): (req: Request) => Promise<Response> {
  const challengeFor = (base: string) => `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`;
  const trustedProxy = (req: Request) =>
    Boolean(deps.proxySecret) && req.headers.get("x-gitdex-proxy-secret") === deps.proxySecret;

  /** The origin the caller used: the web worker's own origin when it proxied the request. */
  function publicOrigin(req: Request): string {
    const forwarded = trustedProxy(req) ? req.headers.get("x-gitdex-origin") : null;
    return forwarded && /^https?:\/\/[^/]+$/.test(forwarded) ? forwarded : deps.baseUrl;
  }

  async function resolveActor(req: Request): Promise<Actor | null> {
    const header = req.headers.get("authorization");
    if (!header) return null;
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (!match) throw new GitdexError("AUTH_REQUIRED", "Malformed Authorization header; expected 'Bearer <token>'.");
    const token = match[1];
    if (token.startsWith(API_TOKEN_PREFIX)) return await actorFromApiToken(deps.db, token);
    const user = await deps.verifyJwt(token);
    if (!user) throw new GitdexError("AUTH_REQUIRED", "The access token is invalid or expired.");
    return await ensureProfile(deps.db, user);
  }

  function clientIp(req: Request): string {
    if (trustedProxy(req)) {
      const forwarded = req.headers.get("x-gitdex-client-ip");
      if (forwarded) return forwarded;
    }
    return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  }

  /** Runs one operation with auth, rate limiting, confirmation and idempotency applied. */
  async function execute(
    op: Operation,
    ctx: Ctx,
    input: Record<string, unknown>,
    confirmed: boolean,
    idempotencyKey: string | null,
  ): Promise<unknown> {
    if (op.access === "user") requireActor(ctx);
    if (op.kind === "read") return await op.run(ctx, input, { confirmed: false });

    const actor = requireActor(ctx);
    // Moderation has its own, larger allowance; the service still refuses anyone who is not a moderator.
    if (op.moderation) await enforceRateLimit(ctx.db, `m:${actor.id}`, LIMITS.moderationWritesPerHour, 3600);
    else await enforceRateLimit(ctx.db, `w:${actor.id}`, LIMITS.writesPerHour, 3600);

    if (op.idempotent && (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200)) {
      throw new GitdexError("VALIDATION_FAILED", "Writes require an idempotency key of 8 to 200 characters.", {
        fields: [{ field: "idempotency_key", issue: "required (Idempotency-Key header on REST, idempotency_key argument on MCP)" }],
      });
    }
    // A preview call writes nothing and must not consume the idempotency key.
    if (op.confirm && !confirmed) return await op.run(ctx, input, { confirmed: false });

    const hash = op.idempotent ? await sha256Hex(stableStringify({ op: op.name, input })) : "";
    return await ctx.db.tx(async (tx) => {
      const txCtx: Ctx = { ...ctx, db: tx };
      if (!op.idempotent) return await op.run(txCtx, input, { confirmed: true });

      const claimed = await tx.query(
        `insert into idempotency_keys (user_id, key, operation, request_hash)
         values ($1::uuid, $2::text, $3::text, $4::text)
         on conflict (user_id, key) do nothing returning key`,
        [actor.id, idempotencyKey, op.name, hash],
      );
      if (!claimed.length) {
        const prior = await tx.query(
          `select operation, request_hash, response from idempotency_keys where user_id = $1::uuid and key = $2::text`,
          [actor.id, idempotencyKey],
        );
        const row = prior[0];
        if (!row || row.operation !== op.name || row.request_hash !== hash) {
          throw new GitdexError("CONFLICT", "This idempotency key was already used for a different write. Use a new key.");
        }
        const stored = typeof row.response === "string" ? JSON.parse(row.response) : row.response;
        if (!stored) throw new GitdexError("CONFLICT", "A write with this idempotency key is still in progress.");
        return { ...(stored as Record<string, unknown>), idempotent_replay: true };
      }
      const result = await op.run(txCtx, input, { confirmed: true });
      await tx.query(
        `update idempotency_keys set response = $3::text::jsonb where user_id = $1::uuid and key = $2::text`,
        [actor.id, idempotencyKey, JSON.stringify(result)],
      );
      return result;
    });
  }

  // ---- REST ---------------------------------------------------------------

  async function handleRest(req: Request, url: URL, path: string, ctx: Ctx): Promise<Response> {
    if (path === "" || path === "/") {
      return json({
        name: "GitDex API",
        version: VERSION,
        openapi: `${ctx.baseUrl}/openapi.json`,
        guide: `${ctx.baseUrl}/ai/guide.md`,
        mcp: `${ctx.baseUrl}/mcp`,
      });
    }
    if (path === "/openapi.json") return json(buildOpenApi(ctx.baseUrl));

    const candidates = ROUTES.filter((r) => r.regex.test(path));
    if (!candidates.length) throw new GitdexError("NOT_FOUND", `No API route for ${path}.`);
    const route = candidates.find((r) => r.op.rest.method === req.method);
    if (!route) {
      return json(
        new GitdexError("VALIDATION_FAILED", `Method ${req.method} is not supported on this route.`).toJSON(),
        405,
        { allow: candidates.map((r) => r.op.rest.method).join(", ") },
      );
    }

    const input: Record<string, unknown> = {};
    let confirmed = false;
    if (req.method === "GET" || req.method === "DELETE") {
      for (const [key, value] of url.searchParams) input[key === "q" ? "query" : key] = value;
    } else {
      const text = await req.text();
      if (text.trim()) {
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          throw new GitdexError("VALIDATION_FAILED", "Request body must be valid JSON.");
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new GitdexError("VALIDATION_FAILED", "Request body must be a JSON object.");
        }
        Object.assign(input, body);
      }
      confirmed = input.confirmed === true;
      delete input.confirmed;
      delete input.idempotency_key;
    }
    const match = route.regex.exec(path)!;
    route.params.forEach((name, i) => (input[name] = decodeURIComponent(match[i + 1])));

    const result = await execute(route.op, ctx, input, confirmed, req.headers.get("idempotency-key"));
    return json(result);
  }

  // ---- MCP ----------------------------------------------------------------

  const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

  function toolList(publicOnly: boolean) {
    return MCP_TOOLS.filter((op) => !publicOnly || (op.access === "public" && op.kind === "read")).map((op) => ({
      name: op.name,
      title: op.title,
      description: op.description,
      inputSchema: toolInputSchema(op),
      annotations: {
        title: op.title,
        readOnlyHint: op.kind === "read",
        destructiveHint: op.destructive === true,
        idempotentHint: op.kind === "read" || op.idempotent,
        openWorldHint: op.publishes === true,
      },
    }));
  }

  async function handleRpc(message: Record<string, unknown>, ctx: Ctx, publicOnly: boolean): Promise<unknown | null> {
    const id = message.id;
    const method = String(message.method ?? "");
    const params = (message.params && typeof message.params === "object" ? message.params : {}) as Record<string, unknown>;
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const fail = (code: number, text: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message: text } });

    if (id === undefined || id === null) return null; // notification: nothing to answer
    const docs = guideDocs(ctx.baseUrl);

    switch (method) {
      case "initialize": {
        const requested = String(params.protocolVersion ?? "");
        return ok({
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {}, prompts: {}, resources: {} },
          serverInfo: { name: "gitdex", title: "GitDex", version: VERSION },
          instructions: mcpInstructions(ctx.baseUrl),
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: toolList(publicOnly) });
      case "tools/call": {
        const name = String(params.name ?? "");
        const op = MCP_TOOLS.find((t) => t.name === name);
        if (!op) return fail(-32602, `Unknown tool: ${name}`);
        const args = { ...((params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>) };
        const confirmed = args.confirmed === true;
        const key = typeof args.idempotency_key === "string" ? args.idempotency_key : null;
        delete args.confirmed;
        delete args.idempotency_key;
        try {
          if (publicOnly && !(op.access === "public" && op.kind === "read")) {
            throw new GitdexError(
              "AUTH_REQUIRED",
              `This is the read-only endpoint. Connect to ${ctx.baseUrl}/mcp and sign in to use ${name}.`,
            );
          }
          const result = await execute(op, ctx, args, confirmed, key);
          return ok({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false });
        } catch (err) {
          const error = toGitdexError(err);
          if (error.code === "INTERNAL") deps.onError?.(err);
          const body = error.toJSON();
          return ok({ content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body, isError: true });
        }
      }
      case "prompts/list":
        return ok({
          prompts: PROMPTS.map((p) => ({
            name: p.name,
            title: p.title,
            description: p.description,
            arguments: [p.argument],
          })),
        });
      case "prompts/get": {
        const prompt = PROMPTS.find((p) => p.name === params.name);
        if (!prompt) return fail(-32602, `Unknown prompt: ${String(params.name)}`);
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const value = typeof args[prompt.argument.name] === "string" ? String(args[prompt.argument.name]).slice(0, 2000) : "";
        return ok({
          description: prompt.description,
          messages: [{
            role: "user",
            content: {
              type: "text",
              text: `${prompt.lead}${value ? `: ${value}` : "."}\n\nFollow this GitDex workflow using the GitDex tools:\n\n${docs[prompt.doc]}`,
            },
          }],
        });
      }
      case "resources/list":
        return ok({
          resources: GUIDE_NAMES.map((name) => ({
            uri: `gitdex://ai/${name}.md`,
            name: `${name}.md`,
            title: name === "guide" ? "GitDex Agent Guide" : `GitDex workflow: ${name.toUpperCase()}`,
            mimeType: "text/markdown",
          })),
        });
      case "resources/templates/list":
        return ok({ resourceTemplates: [] });
      case "resources/read": {
        const match = /^gitdex:\/\/ai\/(\w+)\.md$/.exec(String(params.uri ?? ""));
        const text = match ? docs[match[1]] : undefined;
        if (!text) return fail(-32002, `Unknown resource: ${String(params.uri)}`);
        return ok({ contents: [{ uri: params.uri, mimeType: "text/markdown", text }] });
      }
      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  }

  async function handleMcp(req: Request, ctx: Ctx, publicOnly: boolean): Promise<Response> {
    if (req.method !== "POST") {
      // Stateless server: no SSE stream to open and no session to delete.
      return json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Use POST for MCP requests." } }, 405, {
        allow: "POST, OPTIONS",
      });
    }
    if (!publicOnly && !ctx.actor) {
      return json(
        new GitdexError("AUTH_REQUIRED", `Sign in to use GitDex tools, or use ${ctx.baseUrl}/mcp/public for read-only access.`).toJSON(),
        401,
        { "www-authenticate": challengeFor(ctx.baseUrl) },
      );
    }
    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }
    const messages = Array.isArray(payload) ? payload : [payload];
    const responses: unknown[] = [];
    for (const message of messages) {
      if (!message || typeof message !== "object") {
        responses.push({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
        continue;
      }
      const response = await handleRpc(message as Record<string, unknown>, ctx, publicOnly);
      if (response) responses.push(response);
    }
    if (!responses.length) return new Response(null, { status: 202, headers: CORS });
    return json(Array.isArray(payload) ? responses : responses[0]);
  }

  // ---- entry --------------------------------------------------------------

  return async function handle(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    // Supabase serves this function under /api; accept the bare paths too.
    const path = url.pathname.replace(/^\/functions\/v1/, "").replace(/\/+$/, "") || "/";
    const isMcp = /^(\/api)?\/mcp(\/public)?$/.test(path);
    const baseUrl = publicOrigin(req);
    try {
      const actor = await resolveActor(req);
      await enforceRateLimit(
        deps.db,
        actor ? `r:${actor.id}` : `r:ip:${clientIp(req)}`,
        actor ? LIMITS.userReadsPerMinute : LIMITS.anonReadsPerMinute,
        60,
      );
      const agent = (req.headers.get("x-gitdex-client") ?? req.headers.get("user-agent") ?? "unknown").slice(0, 80);
      const ctx: Ctx = {
        db: deps.db,
        actor,
        baseUrl,
        client: `${isMcp ? "mcp" : "rest"}:${actor?.via ?? "anonymous"}:${agent}`,
      };
      if (isMcp) return await handleMcp(req, ctx, path.endsWith("/public"));
      if (path === "/api/health" || path === "/health") return json({ ok: true, version: VERSION });
      if (path.startsWith("/api/v1")) return await handleRest(req, url, path.slice("/api/v1".length), ctx);
      throw new GitdexError("NOT_FOUND", `Nothing is served at ${path}.`);
    } catch (err) {
      const error = toGitdexError(err);
      if (error.code === "INTERNAL") deps.onError?.(err);
      const headers: Record<string, string> = {};
      if (error.code === "AUTH_REQUIRED") headers["www-authenticate"] = isMcp ? challengeFor(baseUrl) : "Bearer";
      if (error.code === "RATE_LIMITED" && error.details?.retry_after_seconds) {
        headers["retry-after"] = String(error.details.retry_after_seconds);
      }
      return json(error.toJSON(), error.status, headers);
    }
  };
}
