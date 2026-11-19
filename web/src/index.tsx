/** @jsxImportSource hono/jsx */
// Cloudflare Worker: server-rendered directory pages, plus thin proxies that
// put the Supabase-hosted API and MCP server on the site's own origin
// (/api/v1/*, /mcp). No LLM is called anywhere.

import { Hono } from "hono";
import type { Context } from "hono";
import { protectedResourceMetadata } from "../../supabase/functions/_shared/app.ts";
import { GUIDE_NAMES, guideDocs } from "../../supabase/functions/_shared/guide.ts";
import { buildOpenApi } from "../../supabase/functions/_shared/openapi.ts";
import { type Lang, translator } from "./i18n.ts";
import { PrivacyPage, TermsPage } from "./legal.tsx";
import {
  ConnectPage,
  HistoryPage,
  HomePage,
  UserPage,
  MessagePage,
  NewRequestPage,
  type PageCtx,
  RequestListPage,
  RequestPage,
  ShellPage,
  SoftwareListPage,
  SoftwarePage,
  SolutionPage,
} from "./views.tsx";

interface Env {
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  /** Comma-separated social providers enabled in Supabase Auth ("github,google"). */
  AUTH_PROVIDERS?: string;
  /** Google Analytics 4 measurement ID ("G-..."). Analytics is off when unset. */
  GA_MEASUREMENT_ID?: string;
  GITDEX_PROXY_SECRET?: string;
  /** Region of the Supabase database; the API function is run there so its queries stay in-region. */
  SUPABASE_REGION?: string;
  ASSETS: { fetch(req: Request): Promise<Response> };
}

type C = Context<{ Bindings: Env }>;

const app = new Hono<{ Bindings: Env }>();

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
};

function apiBase(c: C): string {
  return `${c.env.SUPABASE_URL}/functions/v1/api`;
}

/** Headers that let the API attribute rate limits to the real visitor. */
function proxyHeaders(c: C): Record<string, string> {
  const headers: Record<string, string> = {};
  // Without this Supabase runs the function near the caller, and every query crosses regions.
  if (c.env.SUPABASE_REGION) headers["x-region"] = c.env.SUPABASE_REGION;
  if (c.env.GITDEX_PROXY_SECRET) {
    headers["x-gitdex-proxy-secret"] = c.env.GITDEX_PROXY_SECRET;
    headers["x-gitdex-client-ip"] = c.req.header("cf-connecting-ip") ?? "unknown";
    headers["x-gitdex-origin"] = new URL(c.req.url).origin;
  }
  return headers;
}

class ApiUnavailable extends Error {}

/** Server-side read of public data. Returns null for 404. */
async function read(c: C, path: string): Promise<any | null> {
  const res = await fetch(`${apiBase(c)}/v1${path}`, { headers: { ...proxyHeaders(c), "x-gitdex-client": "web-ssr" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new ApiUnavailable(`API ${res.status} for ${path}`);
  return await res.json();
}

const CANONICAL_HOST = "gitdex.ai";
/** 50 records per page: up to 1,000 software records and 1,000 requests in the sitemap. */
const SITEMAP_PAGES = 20;

function pageCtx(c: C): PageCtx {
  const url = new URL(c.req.url);
  // Only the real site is measured: local dev and workers.dev previews stay out of the numbers.
  const gaId = c.env.GA_MEASUREMENT_ID ?? "";
  const analyticsId = url.hostname === CANONICAL_HOST && /^G-[A-Z0-9]{4,20}$/.test(gaId) ? gaId : null;
  const cookie = /(?:^|;\s*)lang=(en|zh)/.exec(c.req.header("cookie") ?? "");
  // `?lang=zh` is the Chinese version's own address, so a crawler without cookies can reach it.
  const asked = url.searchParams.get("lang") === "zh";
  const lang = (asked ? "zh" : cookie?.[1] ?? "en") as Lang;
  url.searchParams.delete("lang");
  const search = url.searchParams.toString();
  return {
    t: translator(lang),
    lang,
    langInUrl: asked,
    origin: url.origin,
    path: `${url.pathname}${search ? `?${search}` : ""}`,
    supabaseUrl: c.env.SUPABASE_URL,
    supabaseKey: c.env.SUPABASE_PUBLISHABLE_KEY,
    providers: (c.env.AUTH_PROVIDERS ?? "").split(",").map((p) => p.trim()).filter(Boolean),
    analyticsId,
  };
}

function forwardQuery(c: C, allowed: string[]): string {
  const source = new URL(c.req.url).searchParams;
  const out = new URLSearchParams();
  for (const key of allowed) {
    const value = source.get(key);
    if (value) out.set(key, value);
  }
  const text = out.toString();
  return text ? `?${text}` : "";
}

// ---- canonical origin ------------------------------------------------------

// One public origin: http -> https and www -> apex. Other hosts (workers.dev,
// local dev) are left alone. 308 keeps the method and body for API/MCP calls.
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  const isSite = url.hostname === CANONICAL_HOST || url.hostname === `www.${CANONICAL_HOST}`;
  if (isSite && (url.protocol === "http:" || url.hostname !== CANONICAL_HOST)) {
    const target = `https://${CANONICAL_HOST}${url.pathname}${url.search}`;
    const status = c.req.method === "GET" || c.req.method === "HEAD" ? 301 : 308;
    return new Response(null, { status, headers: { location: target, "cache-control": "public, max-age=3600" } });
  }
  await next();
});

// ---- language switch ------------------------------------------------------

app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  const lang = url.searchParams.get("lang");
  // English is the address without the parameter: `?lang=en` goes there. Chinese is served at
  // `?lang=zh` itself (below), so each language has one address a search engine can index.
  if (c.req.method === "GET" && lang === "en") {
    url.searchParams.delete("lang");
    return new Response(null, {
      status: 302,
      headers: {
        location: `${url.pathname}${url.search}`,
        "set-cookie": `lang=${lang}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`,
      },
    });
  }
  await next();
  if (c.res.headers.get("content-type")?.startsWith("text/html")) {
    if (c.req.method === "GET" && lang === "zh") {
      c.res.headers.append("set-cookie", "lang=zh; Path=/; Max-Age=31536000; SameSite=Lax; Secure");
    }
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(key, value);
    c.res.headers.set("cache-control", "private, no-cache");
  }
});

// ---- agent-facing surfaces ------------------------------------------------

async function proxy(c: C, target: string): Promise<Response> {
  const headers = new Headers(c.req.raw.headers);
  headers.delete("host");
  headers.delete("cookie");
  headers.delete("x-gitdex-proxy-secret");
  headers.delete("x-gitdex-client-ip");
  headers.delete("x-gitdex-origin");
  headers.delete("x-region");
  for (const [key, value] of Object.entries(proxyHeaders(c))) headers.set(key, value);
  const hasBody = !["GET", "HEAD"].includes(c.req.method);
  const upstream = await fetch(target, {
    method: c.req.method,
    headers,
    body: hasBody ? await c.req.raw.arrayBuffer() : undefined,
    redirect: "manual",
  });
  const responseHeaders = new Headers(upstream.headers);
  // Supabase's edge sets its own cookies; they have no business on this origin.
  responseHeaders.delete("set-cookie");
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

app.all("/api/v1/*", (c) => {
  const url = new URL(c.req.url);
  return proxy(c, `${apiBase(c)}${url.pathname.slice("/api".length)}${url.search}`);
});
app.all("/api/v1", (c) => proxy(c, `${apiBase(c)}/v1`));
app.all("/mcp", (c) => proxy(c, `${apiBase(c)}/mcp`));
app.all("/mcp/public", (c) => proxy(c, `${apiBase(c)}/mcp/public`));

const metadata = (c: C) =>
  c.json(protectedResourceMetadata({ baseUrl: new URL(c.req.url).origin, authServer: `${c.env.SUPABASE_URL}/auth/v1` }), 200, {
    "access-control-allow-origin": "*",
    "cache-control": "public, max-age=300",
  });
app.get("/.well-known/oauth-protected-resource", metadata);
app.get("/.well-known/oauth-protected-resource/mcp", metadata);
// Older MCP clients look for authorization server metadata on the MCP origin.
app.get("/.well-known/oauth-authorization-server", async (c) => {
  const upstream = await fetch(`${c.env.SUPABASE_URL}/.well-known/oauth-authorization-server/auth/v1`);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "public, max-age=300" },
  });
});

app.get("/openapi.json", (c) =>
  c.json(buildOpenApi(new URL(c.req.url).origin), 200, { "access-control-allow-origin": "*", "cache-control": "public, max-age=300" }));

app.get("/ai/:file", (c) => {
  const name = c.req.param("file").replace(/\.md$/, "");
  const docs = guideDocs(new URL(c.req.url).origin);
  if (!c.req.param("file").endsWith(".md") || !(GUIDE_NAMES as readonly string[]).includes(name)) return c.notFound();
  return c.body(docs[name], 200, {
    "content-type": "text/markdown; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "public, max-age=300",
  });
});

app.get("/llms.txt", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.text(
    `# GitDex

> Public network of software records, software requests, and solutions confirmed by the people who asked. GitDex runs no AI model; AI clients search and write through MCP or REST.

## For agents
- [Agent Guide](${origin}/ai/guide.md): rules, write protocol, error codes
- [FIND](${origin}/ai/find.md) · [REQUEST](${origin}/ai/request.md) · [SUBMIT](${origin}/ai/submit.md) · [SOLVE](${origin}/ai/solve.md) · [CONFIRM](${origin}/ai/confirm.md)
- [OpenAPI](${origin}/openapi.json)
- MCP (sign-in): ${origin}/mcp
- MCP (read-only): ${origin}/mcp/public

## For people
- [Software directory](${origin}/software)
- [Requests directory](${origin}/requests)
- [Connect an AI client](${origin}/connect)
`,
    200,
    { "cache-control": "public, max-age=300" },
  );
});

app.get("/robots.txt", (c) =>
  c.text(`User-agent: *\nAllow: /\nDisallow: /account\nDisallow: /admin\nDisallow: /history/\nDisallow: /login\nDisallow: /oauth/\nDisallow: /api/\nSitemap: ${new URL(c.req.url).origin}/sitemap.xml\n`));

app.get("/sitemap.xml", async (c) => {
  const origin = new URL(c.req.url).origin;
  const urls: { path: string; updated?: string }[] = ["/", "/software", "/requests", "/connect", "/privacy", "/terms"].map((path) => ({ path }));
  // Every public record, newest change first, up to SITEMAP_PAGES pages per directory.
  const all = async (base: string, toUrl: (item: any) => string) => {
    for (let page = 0; page < SITEMAP_PAGES; page++) {
      const data = await read(c, `${base}&limit=50&offset=${page * 50}`);
      for (const item of data?.items ?? []) {
        const updated = typeof item.updated_at === "string" ? item.updated_at.slice(0, 10) : undefined;
        urls.push({ path: toUrl(item), updated: updated && /^\d{4}-\d{2}-\d{2}$/.test(updated) ? updated : undefined });
      }
      if (data?.next_offset == null) break;
    }
  };
  try {
    await Promise.all([
      all("/software?sort=updated", (s) => `/software/${s.slug}`),
      all("/requests?status=all&sort=updated", (r) => `/requests/${r.id}`),
    ]);
  } catch {
    // Static entries are still worth serving.
  }
  const entry = ({ path, updated }: { path: string; updated?: string }) => {
    const en = `${origin}${path}`;
    const zh = `${en}?lang=zh`;
    return `  <url><loc>${en}</loc>${updated ? `<lastmod>${updated}</lastmod>` : ""}` +
      `<xhtml:link rel="alternate" hreflang="en" href="${en}"/>` +
      `<xhtml:link rel="alternate" hreflang="zh-Hans" href="${zh}"/>` +
      `<xhtml:link rel="alternate" hreflang="x-default" href="${en}"/></url>`;
  };
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${
      urls.map(entry).join("\n")
    }\n</urlset>\n`;
  return c.body(body, 200, { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=600" });
});

// ---- pages ----------------------------------------------------------------

app.get("/", async (c) => {
  const ctx = pageCtx(c);
  // Every shelf is a plain, named ordering of public records: nothing editorial, nothing personalised.
  const [stats, solved, requests, software] = await Promise.all([
    read(c, "/stats"),
    read(c, "/requests?status=resolved&sort=updated&limit=3"),
    read(c, "/requests?sort=interest&limit=5"),
    read(c, "/software?sort=newest&limit=6"),
  ]);
  return c.html(
    <HomePage ctx={ctx} stats={stats} solved={solved?.items ?? []} requests={requests?.items ?? []} software={software?.items ?? []} />,
  );
});

app.get("/software", async (c) => {
  const page = await read(c, `/software${forwardQuery(c, ["q", "platforms", "pricing", "category", "sort", "offset"])}`);
  return c.html(<SoftwareListPage ctx={pageCtx(c)} page={page} query={new URL(c.req.url).searchParams} />);
});
// Software is submitted through an AI client (icon, screenshots, two languages), not a web form.
app.get("/software/new", (c) => c.redirect("/connect", 302));
app.get("/software/:id", async (c) => {
  const data = await read(c, `/software/${encodeURIComponent(c.req.param("id"))}`);
  if (!data) return c.notFound();
  // One canonical URL per record: IDs redirect to the slug.
  if (c.req.param("id") !== data.software.slug) return c.redirect(`/software/${data.software.slug}`, 301);
  return c.html(<SoftwarePage ctx={pageCtx(c)} data={data} />);
});

app.get("/users/:id", async (c) => {
  const id = encodeURIComponent(c.req.param("id"));
  const profile = await read(c, `/users/${id}`);
  if (!profile) return c.notFound();
  const [software, requests] = await Promise.all([
    read(c, `/software?submitted_by=${id}&sort=newest&limit=50`),
    read(c, `/requests?requested_by=${id}&status=all&sort=newest&limit=20`),
  ]);
  return c.html(<UserPage ctx={pageCtx(c)} profile={profile} software={software} requests={requests} />);
});

app.get("/requests", async (c) => {
  const page = await read(c, `/requests${forwardQuery(c, ["q", "status", "platform", "sort", "offset"])}`);
  return c.html(<RequestListPage ctx={pageCtx(c)} page={page} query={new URL(c.req.url).searchParams} />);
});
// A search that found nothing can hand its keywords over as the draft title.
app.get("/requests/new", (c) => c.html(<NewRequestPage ctx={pageCtx(c)} title={(c.req.query("title") ?? "").trim().slice(0, 140)} />));
app.get("/requests/:id", async (c) => {
  const data = await read(c, `/requests/${encodeURIComponent(c.req.param("id"))}`);
  if (!data) return c.notFound();
  return c.html(<RequestPage ctx={pageCtx(c)} data={data} />);
});

app.get("/solutions/:id", async (c) => {
  const data = await read(c, `/solutions/${encodeURIComponent(c.req.param("id"))}`);
  if (!data) return c.notFound();
  return c.html(<SolutionPage ctx={pageCtx(c)} data={data} />);
});

app.get("/history/:type/:id", async (c) => {
  const type = c.req.param("type");
  if (!["software", "request", "solution"].includes(type)) return c.notFound();
  const data = await read(c, `/history?entity_type=${type}&entity_id=${encodeURIComponent(c.req.param("id"))}`);
  if (!data) return c.notFound();
  return c.html(<HistoryPage ctx={pageCtx(c)} data={data} />);
});

app.get("/connect", (c) => c.html(<ConnectPage ctx={pageCtx(c)} />));
app.get("/privacy", (c) => c.html(<PrivacyPage ctx={pageCtx(c)} />));
app.get("/terms", (c) => c.html(<TermsPage ctx={pageCtx(c)} />));
app.get("/account", (c) => {
  const ctx = pageCtx(c);
  return c.html(<ShellPage ctx={ctx} title={ctx.t("accountTitle")} root="account-root" />);
});
app.get("/admin", (c) => {
  const ctx = pageCtx(c);
  return c.html(<ShellPage ctx={ctx} title={ctx.t("adminTitle")} root="admin-root" wide />);
});
app.get("/login", (c) => {
  const ctx = pageCtx(c);
  return c.html(<ShellPage ctx={ctx} title={ctx.t("loginTitle")} lead={ctx.t("loginIntro")} root="login-root" />);
});
app.get("/oauth/consent", (c) => {
  const ctx = pageCtx(c);
  return c.html(<ShellPage ctx={ctx} title={ctx.t("consentTitle")} root="consent-root" />);
});

app.notFound((c) => {
  const accept = c.req.header("accept") ?? "";
  if (!accept.includes("text/html")) return c.json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
  const ctx = pageCtx(c);
  return c.html(<MessagePage ctx={ctx} title={ctx.t("notFound")} body={ctx.t("notFoundBody")} />, 404);
});

app.onError((err, c) => {
  console.error(err);
  const ctx = pageCtx(c);
  const status = err instanceof ApiUnavailable ? 503 : 500;
  return c.html(<MessagePage ctx={ctx} title="GitDex" body={ctx.t("unavailable")} />, status);
});

export default app;
