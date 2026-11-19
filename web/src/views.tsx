/** @jsxImportSource hono/jsx */
// Server-rendered pages. A browsable directory in the shape of an app store:
// shelves, cards and details. No AI, no semantic search, only keyword filters
// (PRD 9), and every shelf is ordered by a rule a reader can name.

import type { Child, FC } from "hono/jsx";
import { raw } from "hono/html";
import { localize } from "../../supabase/functions/_shared/languages.ts";
import { CLIENT_STRINGS, type Key, label, type Lang, type T } from "./i18n.ts";

export interface PageCtx {
  t: T;
  lang: Lang;
  /** The request asked for Chinese in its address (`?lang=zh`), the indexable address of the Chinese version. */
  langInUrl: boolean;
  origin: string;
  path: string;
  supabaseUrl: string;
  supabaseKey: string;
  /** Social sign-in providers that are configured in Supabase, e.g. ["github", "google"]. */
  providers: string[];
  /** Google Analytics 4 measurement ID, or null when this request is not measured. */
  analyticsId: string | null;
}

const PLATFORMS = ["web", "ios", "android", "macos", "windows", "linux", "cli", "browser-extension"];
const PRICING = ["free", "freemium", "open_source", "paid", "subscription", "unknown"];

function day(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 10) : "";
}

/** Only ever link out to https URLs, and never pass ranking or referrer to them. */
const Outbound: FC<{ href: unknown; children?: Child }> = ({ href, children }) => {
  if (typeof href !== "string" || !href.startsWith("https://")) return <span>{String(href ?? "")}</span>;
  return (
    <a href={href} rel="nofollow ugc noopener noreferrer" target="_blank">
      {children ?? href.replace(/^https:\/\//, "")}
    </a>
  );
};

/** A search-result snippet: one line, cut at a word or sentence boundary. */
function snippet(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const stop = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf(". ") + 1, cut.lastIndexOf("，"), cut.lastIndexOf(" "));
  return `${(stop > max * 0.6 ? cut.slice(0, stop) : cut).replace(/[\s，,;；:：]+$/, "")}…`;
}

/** JSON-LD for search engines. Record text goes in as JSON strings; `<` is escaped so it cannot close the script. */
const JsonLd: FC<{ data: unknown }> = ({ data }) => (
  <script type="application/ld+json">{raw(JSON.stringify(data).replace(/</g, "\\u003c"))}</script>
);

export const Layout: FC<
  { ctx: PageCtx; title: string; description?: string; noindex?: boolean; jsonLd?: unknown[]; ogType?: string; children?: Child }
> = (
  { ctx, title, description, noindex, jsonLd, ogType, children },
) => {
  const { t, lang } = ctx;
  // One address per language: English without a parameter, Chinese at `?lang=zh`. Filters and
  // paging are not part of either address.
  const basePath = `${ctx.origin}${ctx.path.split("?")[0]}`;
  const canonical = ctx.langInUrl ? `${basePath}?lang=zh` : basePath;
  const fullTitle = title === "GitDex" ? `GitDex · ${t("homeTitle")}` : `${title} · GitDex`;
  const summary = snippet(description ?? t("metaDescription"));
  const boot = JSON.stringify({
    supabaseUrl: ctx.supabaseUrl,
    supabaseKey: ctx.supabaseKey,
    providers: ctx.providers,
    lang,
    s: CLIENT_STRINGS[lang],
  }).replace(/</g, "\\u003c");
  const other = lang === "en" ? "zh" : "en";
  const join = ctx.path.includes("?") ? "&" : "?";
  // Public pages only. Sign-in, account, consent and form pages are `noindex`
  // and can carry tokens or drafts in their URL, so they are never measured.
  // Advertising features stay off; the ID is validated before it gets here.
  const ga = noindex ? null : ctx.analyticsId;
  return (
    <html lang={lang === "zh" ? "zh-CN" : "en"}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{fullTitle}</title>
        <meta name="description" content={summary} />
        {noindex ? <meta name="robots" content="noindex" /> : <link rel="canonical" href={canonical} />}
        {noindex ? null : <link rel="alternate" hreflang="en" href={basePath} />}
        {noindex ? null : <link rel="alternate" hreflang="zh-Hans" href={`${basePath}?lang=zh`} />}
        {noindex ? null : <link rel="alternate" hreflang="x-default" href={basePath} />}
        <meta property="og:site_name" content="GitDex" />
        <meta property="og:type" content={ogType ?? "website"} />
        <meta property="og:title" content={fullTitle} />
        <meta property="og:description" content={summary} />
        {noindex ? null : <meta property="og:url" content={canonical} />}
        <meta property="og:locale" content={lang === "zh" ? "zh_CN" : "en_US"} />
        <meta property="og:image" content={`${ctx.origin}/assets/logo.png`} />
        <meta name="twitter:card" content="summary" />
        {noindex ? null : (jsonLd ?? []).map((data) => <JsonLd data={data} />)}
        <link rel="icon" href="/assets/favicon.png" type="image/png" />
        <link rel="apple-touch-icon" href="/assets/logo.png" />
        <link rel="stylesheet" href="/assets/site.css" />
        <link rel="alternate" type="text/markdown" href="/ai/guide.md" title="GitDex Agent Guide" />
        {ga ? <script async src={`https://www.googletagmanager.com/gtag/js?id=${ga}`}></script> : null}
        {ga
          ? (
            <script>
              {raw(
                `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}` +
                  `gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:'granted'});` +
                  `gtag('js',new Date());gtag('config','${ga}',{allow_google_signals:false,allow_ad_personalization_signals:false});`,
              )}
            </script>
          )
          : null}
      </head>
      <body>
        <header class="masthead">
          <div class="wrap masthead-row">
            <a class="brand" href="/">
              <img class="brand-mark" src="/assets/logo-120.png" alt="" width="36" height="36" />
              <span class="brand-name">GitDex</span>
            </a>
            <nav class="nav" aria-label="Primary">
              <a href="/software" aria-current={ctx.path.startsWith("/software") ? "page" : undefined}>{t("navSoftware")}</a>
              <a href="/requests" aria-current={ctx.path.startsWith("/requests") ? "page" : undefined}>{t("navRequests")}</a>
              <a href="/connect" aria-current={ctx.path.startsWith("/connect") ? "page" : undefined}>{t("navConnect")}</a>
            </nav>
            <div class="nav-end">
              <a class="lang" href={`${ctx.path}${join}lang=${other}`} hreflang={other === "zh" ? "zh-Hans" : "en"}>
                {other === "zh" ? "中文" : "EN"}
              </a>
              <a class="auth-link" id="auth-link" href="/login">{t("navSignIn")}</a>
            </div>
          </div>
        </header>
        <main class="wrap">{children}</main>
        <footer class="footer">
          <div class="wrap footer-row">
            <p>{t("footerNote")} {t("noServerAi")}</p>
            <ul class="footer-links">
              <li><a href="/ai/guide.md">Agent Guide</a></li>
              <li><a href="/openapi.json">OpenAPI</a></li>
              <li><a href="/connect">MCP</a></li>
              <li><a href="/privacy">{t("footerPrivacy")}</a></li>
              <li><a href="/terms">{t("footerTerms")}</a></li>
              <li><a href="https://github.com/Gitdex-AI/gitdex">{t("footerLegacy")}</a></li>
            </ul>
          </div>
        </footer>
        <dialog id="dialog" class="dialog"></dialog>
        <script>{raw(`window.__GITDEX__=${boot};`)}</script>
        <script type="module" src="/assets/app.js"></script>
      </body>
    </html>
  );
};

/** Small tag on a record that has no version in the reader's language. */
const OnlyIn: FC<{ ctx: PageCtx; v: any }> = ({ ctx, v }) =>
  v.shown_language === ctx.lang ? null : <span class="tag">{label(ctx.t, "onlyIn", v.shown_language)}</span>;

/** Line under a detail page's text saying whether the reader sees the original or the submitter's translation. */
const VersionNote: FC<{ ctx: PageCtx; v: any }> = ({ ctx, v }) => {
  if (v.shown_language !== ctx.lang) return <p class="muted version-note">{label(ctx.t, "onlyIn", v.shown_language)}</p>;
  if (v.shown_language !== v.language) return <p class="muted version-note">{label(ctx.t, "translatedFrom", v.language)}</p>;
  return null;
};

/** "Version 3 · Earlier versions" under a record that has been edited. */
const VersionLine: FC<{ ctx: PageCtx; type: string; id: string; version: unknown }> = ({ ctx, type, id, version }) =>
  Number(version) > 1
    ? (
      <p class="muted version-note">
        {ctx.t("versionLabel")} {Number(version)} · <a href={`/history/${type}/${id}`}>{ctx.t("historyLink")}</a>
      </p>
    )
    : null;

/** App-style icon. The image is the submitter's own https URL; without one, the name's first letter. */
const AppIcon: FC<{ s: any; large?: boolean }> = ({ s, large }) => {
  const cls = `app-icon${large ? " lg" : ""}`;
  if (typeof s.icon_url === "string" && s.icon_url.startsWith("https://")) {
    return <img class={cls} src={s.icon_url} alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />;
  }
  return <span class={cls} aria-hidden="true">{[...String(s.name ?? "")][0]?.toUpperCase() ?? ""}</span>;
};

const Screenshots: FC<{ ctx: PageCtx; s: any }> = ({ ctx, s }) => {
  const shots = (Array.isArray(s.screenshots) ? s.screenshots : []).filter(
    (u: unknown) => typeof u === "string" && u.startsWith("https://"),
  ) as string[];
  if (!shots.length) return null;
  return (
    <section class="shots-section" aria-label={ctx.t("screenshots")}>
      <ul class="shots">
        {shots.map((url, i) => (
          <li>
            <a href={url} rel="nofollow ugc noopener noreferrer" target="_blank">
              <img src={url} alt={`${s.name} · ${ctx.t("screenshots")} ${i + 1}`} loading="lazy" decoding="async" referrerpolicy="no-referrer" />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
};

const Badge: FC<{ kind: string; children?: Child }> = ({ kind, children }) => <span class={`badge badge-${kind}`}>{children}</span>;

const Tags: FC<{ items: unknown }> = ({ items }) => {
  const list = Array.isArray(items) ? (items as string[]) : [];
  if (!list.length) return null;
  return (
    <span class="tags">
      {list.map((item) => <span class="tag">{item}</span>)}
    </span>
  );
};

const Bullets: FC<{ items: unknown }> = ({ items }) => {
  const list = Array.isArray(items) ? (items as string[]) : [];
  if (!list.length) return <p class="muted">—</p>;
  return (
    <ul class="bullets">
      {list.map((item) => <li>{item}</li>)}
    </ul>
  );
};

const Select: FC<{ name: string; value: string; options: [string, string][]; labelText: string }> = (
  { name, value, options, labelText },
) => (
  <label class="field">
    <span>{labelText}</span>
    <select name={name}>
      {options.map(([v, text]) => <option value={v} selected={v === value}>{text}</option>)}
    </select>
  </label>
);

const Pager: FC<{ ctx: PageCtx; page: any; query: URLSearchParams }> = ({ ctx, page, query }) => {
  const link = (offset: number) => {
    const q = new URLSearchParams(query);
    q.delete("lang");
    if (offset > 0) q.set("offset", String(offset));
    else q.delete("offset");
    const text = q.toString();
    return `${ctx.path.split("?")[0]}${text ? `?${text}` : ""}`;
  };
  return (
    <nav class="pager" aria-label="Pagination">
      <span class="muted">{page.total} {ctx.t("results")}</span>
      <span class="pager-links">
        {page.offset > 0 ? <a href={link(Math.max(0, page.offset - page.limit))} rel="prev">{ctx.t("previous")}</a> : null}
        {page.next_offset !== null ? <a href={link(page.next_offset)} rel="next">{ctx.t("next")}</a> : null}
      </span>
    </nav>
  );
};

/** An author's display name, linking to everything they published. The name is user text: rendered as text. */
const Author: FC<{ user: any }> = ({ user }) =>
  user && typeof user.id === "string"
    ? <a class="author" href={`/users/${encodeURIComponent(user.id)}`} rel="nofollow">{user.display_name}</a>
    : <>{user?.display_name ?? ""}</>;

const RequestRow: FC<{ ctx: PageCtx; r: any }> = ({ ctx, r: record }) => {
  const r = localize(record, ctx.lang);
  return (
    <li class="row">
      <div class="row-main">
        <a class="row-title" href={`/requests/${r.id}`}>{r.title}</a>
        <p class="row-text">{r.goal}</p>
        <p class="row-meta">
          <Badge kind={r.status}>{label(ctx.t, "status", r.status)}</Badge>
          <Tags items={r.platforms} />
          {r.price_constraint ? <span class="muted">{r.price_constraint}</span> : null}
          {r.resolved_by ? <a class="solved" href={`/software/${r.resolved_by.slug}`}>{r.resolved_by.name}</a> : null}
          <OnlyIn ctx={ctx} v={r} />
        </p>
      </div>
      <div class="row-side">
        <span><b>{r.interest_count}</b> {ctx.t("interest")}</span>
        <span><b>{r.proposal_count}</b> {ctx.t("proposals")}</span>
        <span class="muted">{day(r.created_at)}</span>
      </div>
    </li>
  );
};

/** How many requests this software was accepted for by the requester. The directory's only trust number. */
const Solved: FC<{ ctx: PageCtx; n: unknown; href?: string }> = ({ ctx, n, href }) => {
  const count = Number(n) || 0;
  if (!count) return null;
  const text = <><b>{count}</b> {ctx.t(count === 1 ? "solvedOne" : "solvedMany")}</>;
  return href ? <a class="solved" href={href}>{text}</a> : <span class="solved">{text}</span>;
};

const SoftwareCard: FC<{ ctx: PageCtx; s: any }> = ({ ctx, s: record }) => {
  const s = localize(record, ctx.lang);
  return (
    <li class="card">
      <AppIcon s={s} />
      <div class="card-main">
        <a class="card-title" href={`/software/${s.slug}`}>{s.name}</a>
        <p class="card-text">{s.description}</p>
        <p class="card-meta">
          <Badge kind={`pricing-${s.pricing_type}`}>{label(ctx.t, "pricing", s.pricing_type)}</Badge>
          <Tags items={Array.isArray(s.platforms) ? s.platforms.slice(0, 3) : []} />
          {s.review_status === "flagged" ? <Badge kind="review-flagged">{label(ctx.t, "review", "flagged")}</Badge> : null}
          <OnlyIn ctx={ctx} v={s} />
        </p>
        <Solved ctx={ctx} n={s.accepted_solution_count} />
      </div>
    </li>
  );
};

const SoftwareGrid: FC<{ ctx: PageCtx; items: any[] }> = ({ ctx, items }) => (
  <ul class="cards">{items.map((s) => <SoftwareCard ctx={ctx} s={s} />)}</ul>
);

/** One filter as a row of links: works without script, and each state has its own URL. */
const Chips: FC<{ ctx: PageCtx; query: URLSearchParams; name: string; labelText: string; options: [string, string][] }> = (
  { ctx, query, name, labelText, options },
) => {
  const current = query.get(name) ?? "";
  const link = (value: string) => {
    const q = new URLSearchParams(query);
    q.delete("lang");
    q.delete("offset");
    if (value) q.set(name, value);
    else q.delete(name);
    const text = q.toString();
    return `${ctx.path.split("?")[0]}${text ? `?${text}` : ""}`;
  };
  return (
    <div class="chip-row" role="group" aria-label={labelText} data-active={current ? "" : undefined}>
      <span class="chip-label">{labelText}</span>
      <a class="chip all" href={link("")} aria-current={current ? undefined : "true"} rel="nofollow">{ctx.t("all")}</a>
      {options.map(([value, text]) => (
        // The selected chip links to its own removal, so a narrow screen can clear it without opening the panel.
        <a class="chip" href={link(current === value ? "" : value)} aria-current={current === value ? "true" : undefined} rel="nofollow">
          {text}
        </a>
      ))}
    </div>
  );
};

/**
 * Narrow screens keep only the keyword row open; sort and chips fold behind this switch.
 * A checkbox and CSS, so it works without script. Wide screens hide it and show everything.
 */
const FilterToggle: FC<{ ctx: PageCtx; query: URLSearchParams; names: string[]; defaults?: Record<string, string> }> = (
  { ctx, query, names, defaults = {} },
) => {
  const count = names.filter((name) => query.get(name) && query.get(name) !== defaults[name]).length;
  return (
    <>
      <input class="filter-toggle" type="checkbox" id="filter-toggle" />
      <label class="filter-summary" for="filter-toggle">
        {ctx.t("sortAndFilters")}
        {count ? <span class="filter-count">{count}</span> : null}
      </label>
    </>
  );
};

/**
 * The stores' own badges, unaltered, on the product's own listing. The service only stores
 * listing addresses on the store's host; the prefix is checked again here so a badge can
 * never sit on any other link.
 */
const STORE_BADGES = [
  { field: "app_store_url", prefix: "https://apps.apple.com/", file: "app-store", ext: "svg", alt: "storeApple", width: { en: 120, zh: 109 } },
  {
    field: "google_play_url",
    prefix: "https://play.google.com/store/apps/details?id=",
    file: "google-play",
    ext: "png",
    alt: "storeGoogle",
    width: { en: 134, zh: 135 },
  },
] as const;

const storeLinks = (s: any) =>
  STORE_BADGES.filter((b) => typeof s[b.field] === "string" && s[b.field].startsWith(b.prefix));

const StoreBadges: FC<{ ctx: PageCtx; s: any }> = ({ ctx, s }) => {
  const badges = storeLinks(s);
  if (!badges.length) return null;
  return (
    <p class="store-badges">
      {badges.map((b) => (
        <a href={s[b.field]} rel="nofollow ugc noopener noreferrer" target="_blank">
          <img src={`/assets/badges/${b.file}-${ctx.lang}.${b.ext}`} alt={ctx.t(b.alt)} width={b.width[ctx.lang]} height={40} />
        </a>
      ))}
    </p>
  );
};

/** Keeps the active chip filters when the keyword form is submitted. */
const Carry: FC<{ query: URLSearchParams; names: string[] }> = ({ query, names }) => (
  <>
    {names.filter((name) => query.get(name)).map((name) => <input type="hidden" name={name} value={query.get(name) ?? ""} />)}
  </>
);

/** Empty directory result: the need itself is worth publishing. Carries the keywords into the request form. */
const EmptyToRequest: FC<{ ctx: PageCtx; query: URLSearchParams; hint: Key }> = ({ ctx, query, hint }) => {
  const q = (query.get("q") ?? "").trim().slice(0, 140);
  return (
    <div class="empty">
      <p>{ctx.t("noResults")} {ctx.t(hint)}</p>
      <p>
        <a class="button primary" href={q ? `/requests/new?title=${encodeURIComponent(q)}` : "/requests/new"} rel="nofollow">
          {q ? ctx.t("publishQueryAsRequest").replace("{q}", q) : ctx.t("newRequest")}
        </a>
      </p>
    </div>
  );
};

export const HomePage: FC<{ ctx: PageCtx; stats: any; solved: any[]; requests: any[]; software: any[] }> = (
  { ctx, stats, solved, requests, software },
) => {
  const { t } = ctx;
  const confirmed = solved.filter((r) => r.resolved_by);
  return (
    <Layout
      ctx={ctx}
      title="GitDex"
      jsonLd={[
        { "@context": "https://schema.org", "@type": "Organization", name: "GitDex", url: `${ctx.origin}/`, logo: `${ctx.origin}/assets/logo.png` },
        {
          "@context": "https://schema.org",
          "@type": "WebSite",
          name: "GitDex",
          url: `${ctx.origin}/`,
          inLanguage: ["en", "zh-Hans"],
          potentialAction: {
            "@type": "SearchAction",
            target: { "@type": "EntryPoint", urlTemplate: `${ctx.origin}/software?q={search_term_string}` },
            "query-input": "required name=search_term_string",
          },
        },
      ]}
    >
      <section class="hero">
        <div>
          <h1>{t("heroTitle")}</h1>
          <p class="lead">{t("heroBody")}</p>
          <form class="hero-search" method="get" action="/software" role="search">
            <input type="search" name="q" maxlength={200} placeholder={t("searchPlaceholder")} aria-label={t("searchSoftware")} />
            <button class="button primary" type="submit">{t("search")}</button>
          </form>
          <p class="actions">
            <a class="button" href="/connect">{t("heroConnect")}</a>
            <a class="button" href="/requests">{t("heroBrowse")}</a>
          </p>
          <p class="mcp-line">
            <span class="muted">{t("heroMcp")}</span> <code>{ctx.origin}/mcp</code>
          </p>
        </div>
        <div class="exchange">
          <div class="x-card x-request">
            <span class="x-kind">{t("xRequest")}</span>
            <strong>{t("xRequestTitle")}</strong>
            <ul>
              <li>{t("xMust1")}</li>
              <li>{t("xMust2")}</li>
              <li>{t("xMust3")}</li>
            </ul>
            <span class="x-meta">{t("xInterest")}</span>
          </div>
          <div class="x-link">{t("xProposes")}</div>
          <div class="x-card x-solution">
            <span class="x-kind">{t("xSolution")}</span>
            <strong>Shelfwise</strong>
            <span class="x-covers">{t("xCovers")}</span>
            <span class="x-verdict">{t("xAccepted")}</span>
          </div>
          <p class="x-caption">{t("xCaption")}</p>
        </div>
      </section>

      {stats && stats.software + stats.open_requests + stats.proposals + stats.verified_resolved_requests > 0
        ? (
          <dl class="stats">
            <div class="stat stat-key"><dt>{t("statResolved")}</dt><dd>{stats.verified_resolved_requests}</dd></div>
            <div class="stat"><dt>{t("statOpen")}</dt><dd>{stats.open_requests}</dd></div>
            <div class="stat"><dt>{t("statProposals")}</dt><dd>{stats.proposals}</dd></div>
            <div class="stat"><dt>{t("statSoftware")}</dt><dd>{stats.software}</dd></div>
          </dl>
        )
        : null}

      {confirmed.length
        ? (
          <section>
            <div class="section-head">
              <div>
                <h2>{t("shelfSolved")}</h2>
                <p class="muted">{t("shelfSolvedNote")}</p>
              </div>
              <a href="/requests?status=resolved&sort=updated">{t("viewAll")}</a>
            </div>
            <ul class="pairs">
              {confirmed.map((record) => {
                const r = localize(record, ctx.lang);
                return (
                  <li class="pair">
                    <span class="x-kind">{t("xRequest")}</span>
                    <a class="pair-request" href={`/requests/${r.id}`}>{r.title}</a>
                    <div class="pair-software">
                      <AppIcon s={r.resolved_by} />
                      <a href={`/software/${r.resolved_by.slug}`}>{r.resolved_by.name}</a>
                      <Badge kind="proposal-accepted">{label(t, "proposal", "accepted")}</Badge>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )
        : null}

      <section>
        <div class="section-head">
          <h2>{t("latestSoftware")}</h2>
          <a href="/software">{t("viewAll")}</a>
        </div>
        {software.length
          ? <SoftwareGrid ctx={ctx} items={software} />
          : <p class="empty">{t("noResults")} <a href="/connect">{t("newSoftware")}</a></p>}
      </section>

      <section>
        <div class="section-head">
          <h2>{t("shelfWanted")}</h2>
          <a href="/requests?sort=interest">{t("viewAll")}</a>
        </div>
        {requests.length
          ? <ul class="rows">{requests.map((r) => <RequestRow ctx={ctx} r={r} />)}</ul>
          : <p class="empty">{t("noRequestsHint")} <a href="/requests/new">{t("newRequest")}</a></p>}
      </section>

      <section class="split">
        <div>
          <h2>{t("forSeekers")}</h2>
          <p>{t("forSeekersBody")}</p>
          <ol class="steps">
            <li>{t("stepSearch")}</li>
            <li>{t("stepRequest")}</li>
            <li>{t("stepVerdict")}</li>
          </ol>
        </div>
        <div>
          <h2>{t("forCreators")}</h2>
          <p>{t("forCreatorsBody")}</p>
          <ol class="steps">
            <li>{t("stepDiscover")}</li>
            <li>{t("stepBuild")}</li>
            <li>{t("stepPropose")}</li>
          </ol>
        </div>
      </section>
      <p class="notice">{t("noServerAi")}</p>
    </Layout>
  );
};

/** Everything one author published. Not indexed: it is a way through the directory, not a page about a person. */
export const UserPage: FC<{ ctx: PageCtx; profile: any; software: any; requests: any }> = ({ ctx, profile, software, requests }) => {
  const { t } = ctx;
  const { user, counts } = profile;
  const more = (shown: any, total: number) => (shown?.items?.length ?? 0) < total;
  return (
    <Layout ctx={ctx} title={user.display_name} noindex>
      <div class="page-head">
        <div>
          <p class="crumbs">{t("authorLabel")}</p>
          <h1>{user.display_name}</h1>
          <p class="lead">{t("authorIntro")}</p>
        </div>
      </div>
      <dl class="stats">
        <div class="stat"><dt>{t("authorSoftware")}</dt><dd>{counts.software}</dd></div>
        <div class="stat stat-key"><dt>{t("authorSolved")}</dt><dd>{counts.accepted_solutions}</dd></div>
        <div class="stat"><dt>{t("authorRequests")}</dt><dd>{counts.requests}</dd></div>
      </dl>
      <section>
        <div class="section-head"><h2>{t("authorSoftware")}</h2></div>
        {software?.items?.length ? <SoftwareGrid ctx={ctx} items={software.items} /> : <p class="empty">{t("authorNoSoftware")}</p>}
        {more(software, counts.software) ? <p class="muted">{t("authorShowingFirst").replace("{n}", String(software.items.length))}</p> : null}
      </section>
      <section>
        <div class="section-head"><h2>{t("authorRequests")}</h2></div>
        {requests?.items?.length
          ? <ul class="rows">{requests.items.map((r: any) => <RequestRow ctx={ctx} r={r} />)}</ul>
          : <p class="empty">{t("authorNoRequests")}</p>}
        {more(requests, counts.requests) ? <p class="muted">{t("authorShowingFirst").replace("{n}", String(requests.items.length))}</p> : null}
      </section>
    </Layout>
  );
};

export const SoftwareListPage: FC<{ ctx: PageCtx; page: any; query: URLSearchParams }> = ({ ctx, page, query }) => {
  const { t } = ctx;
  const category = query.get("category") ?? "";
  const withoutCategory = new URLSearchParams(query);
  for (const name of ["category", "offset", "lang"]) withoutCategory.delete(name);
  const clearCategory = `/software${withoutCategory.toString() ? `?${withoutCategory}` : ""}`;
  return (
    <Layout ctx={ctx} title={t("softwareTitle")} description={t("softwareIntro")}>
      <div class="page-head">
        <div>
          <h1>{t("softwareTitle")}</h1>
          <p class="lead">{t("softwareIntro")}</p>
        </div>
        <a class="button primary" href="/connect">{t("newSoftware")}</a>
      </div>
      <div class="filters">
        <FilterToggle ctx={ctx} query={query} names={["sort", "platforms", "pricing", "category"]} defaults={{ sort: "relevance" }} />
        <form class="filter-form" method="get" action="/software" role="search">
          <label class="field grow">
            <span>{t("keyword")}</span>
            <input type="search" name="q" value={query.get("q") ?? ""} maxlength={200} placeholder={t("searchPlaceholder")} />
          </label>
          <Select
            name="sort"
            value={query.get("sort") ?? "relevance"}
            labelText={t("sort")}
            options={[
              ["relevance", t("sortRelevance")],
              ["solved", t("sortSolved")],
              ["newest", t("sortNewest")],
              ["updated", t("sortUpdated")],
              ["name", t("sortName")],
            ]}
          />
          <Carry query={query} names={["platforms", "pricing", "category"]} />
          <button class="button" type="submit">{t("search")}</button>
        </form>
        <div class="filter-chips">
        <Chips ctx={ctx} query={query} name="platforms" labelText={t("platform")} options={PLATFORMS.map((p) => [p, p] as [string, string])} />
        <Chips ctx={ctx} query={query} name="pricing" labelText={t("pricing")} options={PRICING.map((p) => [p, label(t, "pricing", p)] as [string, string])} />
        {category
          ? (
            <div class="chip-row" data-active="">
              <span class="chip-label">{t("category")}</span>
              <a class="chip removable" href={clearCategory} aria-current="true" rel="nofollow" title={t("removeFilter")}>
                {category} <span aria-hidden="true">×</span>
              </a>
            </div>
          )
          : null}
        </div>
      </div>
      {page.items.length ? <SoftwareGrid ctx={ctx} items={page.items} /> : <EmptyToRequest ctx={ctx} query={query} hint="noSoftwareHint" />}
      <Pager ctx={ctx} page={page} query={query} />
    </Layout>
  );
};

export const RequestListPage: FC<{ ctx: PageCtx; page: any; query: URLSearchParams }> = ({ ctx, page, query }) => {
  const { t } = ctx;
  return (
    <Layout ctx={ctx} title={t("requestsTitle")} description={t("requestsIntro")}>
      <div class="page-head">
        <div>
          <h1>{t("requestsTitle")}</h1>
          <p class="lead">{t("requestsIntro")}</p>
        </div>
        <a class="button primary" href="/requests/new">{t("newRequest")}</a>
      </div>
      <div class="filters">
      <FilterToggle
        ctx={ctx}
        query={query}
        names={["status", "sort", "platform"]}
        defaults={{ status: "active", sort: "relevance" }}
      />
      <form class="filter-form" method="get" action="/requests" role="search">
        <label class="field grow">
          <span>{t("keyword")}</span>
          <input type="search" name="q" value={query.get("q") ?? ""} maxlength={200} placeholder={t("keyword")} />
        </label>
        <Select
          name="status"
          value={query.get("status") ?? "active"}
          labelText={t("status")}
          options={[
            ["active", t("statusActive")],
            ["open", t("status_open")],
            ["proposals_available", t("status_proposals_available")],
            ["resolved", t("status_resolved")],
            ["closed", t("status_closed")],
            ["all", t("statusAll")],
          ]}
        />
        <Select
          name="sort"
          value={query.get("sort") ?? "relevance"}
          labelText={t("sort")}
          options={[
            ["relevance", t("sortRelevance")],
            ["newest", t("sortNewest")],
            ["updated", t("sortUpdated")],
            ["interest", t("sortInterest")],
            ["proposals", t("sortProposals")],
          ]}
        />
        <Carry query={query} names={["platform"]} />
        <button class="button" type="submit">{t("search")}</button>
      </form>
      <div class="filter-chips">
        <Chips ctx={ctx} query={query} name="platform" labelText={t("platform")} options={PLATFORMS.map((p) => [p, p] as [string, string])} />
      </div>
      </div>
      {page.items.length
        ? <ul class="rows">{page.items.map((r: any) => <RequestRow ctx={ctx} r={r} />)}</ul>
        : <EmptyToRequest ctx={ctx} query={query} hint="noRequestsHint" />}
      <Pager ctx={ctx} page={page} query={query} />
    </Layout>
  );
};

const Report: FC<{ ctx: PageCtx; type: string; id: string }> = ({ ctx, type, id }) => (
  <details class="report">
    <summary>{ctx.t("report")}</summary>
    <form data-write="POST /reports" data-success="message:reportSent">
      <input type="hidden" name="entity_type" value={type} />
      <input type="hidden" name="entity_id" value={id} />
      <label class="field">
        <span>{ctx.t("reportReason")}</span>
        <textarea name="reason" rows={2} required minlength={5} maxlength={1000}></textarea>
      </label>
      <button class="button small" type="submit">{ctx.t("report")}</button>
    </form>
  </details>
);

const VerdictForm: FC<{ ctx: PageCtx; proposal: any; requestActive: boolean }> = ({ ctx, proposal, requestActive }) => (
  <form
    class="verdict-form"
    data-write={`POST /solutions/${proposal.id}/confirm`}
    data-success="reload"
    data-verdict-for={proposal.id}
    data-proposer={proposal.proposed_by.id}
    data-request-active={requestActive ? "1" : "0"}
    hidden
  >
    <fieldset>
      <legend>{ctx.t("verdictQuestion")}</legend>
      {(["accepted", "partial", "rejected"] as const).map((v) => (
        <label class="radio">
          <input type="radio" name="verdict" value={v} required /> {label(ctx.t, "verdict", v)}
        </label>
      ))}
    </fieldset>
    <label class="field">
      <span>{ctx.t("feedbackLabel")}</span>
      <textarea name="feedback" rows={2} maxlength={2000}></textarea>
    </label>
    <button class="button small primary" type="submit">{ctx.t("recordVerdict")}</button>
  </form>
);

export const RequestPage: FC<{ ctx: PageCtx; data: any }> = ({ ctx, data }) => {
  const { t } = ctx;
  const r = localize(data.request, ctx.lang);
  const active = r.status === "open" || r.status === "proposals_available";
  return (
    <Layout ctx={ctx} title={r.title} description={r.goal} ogType="article" jsonLd={[crumbs(ctx, t("requestsTitle"), "/requests", r.title)]}>
      <article class="detail" data-page="request" data-request-id={r.id} data-owner={r.owner.id} data-active={active ? "1" : "0"}>
        <p class="crumbs"><a href="/requests">{t("requestsTitle")}</a> / <code>{r.id}</code></p>
        <h1>{r.title}</h1>
        <p class="row-meta">
          <Badge kind={r.status}>{label(t, "status", r.status)}</Badge>
          <span><b>{r.interest_count}</b> {t("interest")}</span>
          <span><b>{r.proposal_count}</b> {t("proposals")}</span>
          <span class="muted">{t("requestedBy")} <Author user={r.owner} />, {day(r.created_at)}</span>
        </p>

        <div class="detail-grid">
          <div>
            <h2>{t("goal")}</h2>
            <p class="prose">{r.goal}</p>
            <h2>{t("mustHave")}</h2>
            <Bullets items={r.must_have} />
            {r.nice_to_have.length ? <><h2>{t("niceToHave")}</h2><Bullets items={r.nice_to_have} /></> : null}
            {r.other_constraints.length ? <><h2>{t("otherConstraints")}</h2><Bullets items={r.other_constraints} /></> : null}
            <VersionNote ctx={ctx} v={r} />
            <VersionLine ctx={ctx} type="request" id={r.id} version={r.version} />
          </div>
          <aside class="facts">
            <dl>
              <dt>{t("platforms")}</dt>
              <dd>{r.platforms.length ? <Tags items={r.platforms} /> : "—"}</dd>
              <dt>{t("priceConstraint")}</dt>
              <dd>{r.price_constraint ?? "—"}</dd>
            </dl>
            <div class="action-stack">
              {active
                ? (
                  <>
                    <form data-write={`POST /requests/${r.id}/support`} data-success="reload" data-show="can-support">
                      <button class="button primary" type="submit">{t("support")}</button>
                    </form>
                    <form data-write={`DELETE /requests/${r.id}/support`} data-success="reload" data-show="supporter" hidden>
                      <p class="muted">{t("supporting")}</p>
                      <button class="button small" type="submit">{t("unsupport")}</button>
                    </form>
                    <form data-write={`POST /requests/${r.id}/close`} data-success="reload" data-show="owner" hidden>
                      <button class="button small" type="submit">{t("closeRequest")}</button>
                    </form>
                  </>
                )
                : null}
              <form data-write={`POST /requests/${r.id}/close`} data-success="goto:/account" data-show="owner" hidden>
                <input type="hidden" name="unpublish" value="true" />
                <button class="button small" type="submit">{t("withdrawRequest")}</button>
              </form>
            </div>
            <Report ctx={ctx} type="request" id={r.id} />
          </aside>
        </div>

        <section>
          <h2>{t("proposedSolutions")}</h2>
          <p class="muted">{t("proposalNotResolved")}</p>
          {data.proposals.length
            ? (
              <ul class="proposals">
                {data.proposals.map((proposal: any) => localize(proposal, ctx.lang)).map((p: any) => (
                  <li class={`proposal proposal-${p.status}`}>
                    <div class="proposal-head">
                      <AppIcon s={p.software} />
                      <a class="row-title" href={`/software/${p.software.slug}`}>{p.software.name}</a>
                      <Badge kind={`proposal-${p.status}`}>{label(t, "proposal", p.status)}</Badge>
                      <a class="muted" href={`/solutions/${p.id}`}><code>{p.id}</code></a>
                    </div>
                    <p class="prose">{p.coverage_notes}</p>
                    {p.unmet_requirements.length ? <><h3>{t("unmet")}</h3><Bullets items={p.unmet_requirements} /></> : null}
                    <p class="row-meta">
                      <span class="muted">{t("proposedBy")} <Author user={p.proposed_by} />, {day(p.created_at)}</span>
                      <span>{t("requesterVerdict")}: {p.requester_verdict ? label(t, "verdict", p.requester_verdict) : t("noVerdict")}</span>
                      <OnlyIn ctx={ctx} v={p} />
                    </p>
                    <VerdictForm ctx={ctx} proposal={p} requestActive={active} />
                  </li>
                ))}
              </ul>
            )
            : <p class="empty">{t("noProposals")}</p>}
        </section>

        {active
          ? (
            <details class="panel" data-show="can-propose">
              <summary>{t("proposeSolution")}</summary>
              <p class="muted">{t("proposeIntro")} <a href="/connect">{t("newSoftware")}</a></p>
              <form data-write="POST /solutions" data-success="redirect">
                <input type="hidden" name="request_id" value={r.id} />
                <label class="field">
                  <span>{t("softwareIdLabel")}</span>
                  <input type="text" name="software_id" list="software-options" data-software-picker required autocomplete="off" />
                  <datalist id="software-options"></datalist>
                </label>
                <label class="field">
                  <span>{t("coverageLabel")}</span>
                  <textarea name="coverage_notes" rows={4} required minlength={10} maxlength={2000}></textarea>
                </label>
                <label class="field">
                  <span>{t("unmetLabel")}</span>
                  <textarea name="unmet_requirements" rows={3} data-kind="lines"></textarea>
                </label>
                <button class="button primary" type="submit">{t("submit")}</button>
              </form>
            </details>
          )
          : null}
      </article>
    </Layout>
  );
};

const crumbs = (ctx: PageCtx, parent: string, parentPath: string, name: string) => ({
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [
    { "@type": "ListItem", position: 1, name: "GitDex", item: `${ctx.origin}/` },
    { "@type": "ListItem", position: 2, name: parent, item: `${ctx.origin}${parentPath}` },
    { "@type": "ListItem", position: 3, name },
  ],
});

/** "Paworld for iOS, Android and Web": what someone searching for the product types. */
function softwareTitle(ctx: PageCtx, s: any): string {
  const names: Record<string, string> = { ios: "iOS", android: "Android", web: "Web", macos: "macOS", windows: "Windows", linux: "Linux", cli: "CLI" };
  const platforms = (Array.isArray(s.platforms) ? s.platforms : []).map((p: string) => names[p]).filter(Boolean).slice(0, 4);
  if (!platforms.length) return s.name;
  return ctx.lang === "zh" ? `${s.name}（${platforms.join("、")}）` : `${s.name} for ${platforms.join(", ")}`;
}

/** Only what the record states: no price, rating or review is invented for a rich result. */
function softwareJsonLd(ctx: PageCtx, s: any): unknown[] {
  const https = (value: unknown) => (typeof value === "string" && value.startsWith("https://") ? value : undefined);
  const shots = (Array.isArray(s.screenshots) ? s.screenshots : []).map(https).filter(Boolean);
  const stores = storeLinks(s).map((b) => s[b.field]);
  return [
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: s.name,
      description: s.description,
      url: `${ctx.origin}/software/${s.slug}`,
      sameAs: [https(s.canonical_url), https(s.repository_url), ...stores].filter(Boolean),
      operatingSystem: Array.isArray(s.platforms) && s.platforms.length ? s.platforms.join(", ") : undefined,
      applicationCategory: Array.isArray(s.category) && s.category.length ? s.category.join(", ") : undefined,
      image: https(s.icon_url),
      screenshot: shots.length ? shots : undefined,
      installUrl: stores[0],
      license: typeof s.license === "string" && s.license ? s.license : undefined,
      isAccessibleForFree: s.pricing_type === "free" || s.pricing_type === "open_source" ? true : undefined,
      inLanguage: ctx.lang === "zh" ? "zh-Hans" : "en",
      dateModified: typeof s.updated_at === "string" ? s.updated_at : undefined,
    },
    crumbs(ctx, ctx.t("softwareTitle"), "/software", s.name),
  ];
}

export const SoftwarePage: FC<{ ctx: PageCtx; data: any }> = ({ ctx, data }) => {
  const { t } = ctx;
  const s = localize(data.software, ctx.lang);
  const website = typeof s.canonical_url === "string" && s.canonical_url.startsWith("https://") ? s.canonical_url : null;
  const solved = data.solutions.filter((p: any) => p.proposal_status === "accepted").length;
  // Only the record's own URL goes into the prompt: no submitter-written text.
  const prompt = `${t("askAgentPrompt")}\n${ctx.origin}/software/${s.slug}\n${t("askAgentNeeds")} `;
  return (
    <Layout ctx={ctx} title={softwareTitle(ctx, s)} description={s.description} jsonLd={softwareJsonLd(ctx, s)}>
      <article class="detail" data-page="software">
        <p class="crumbs"><a href="/software">{t("softwareTitle")}</a> / <code>{s.id}</code></p>
        <header class="app-head">
          <AppIcon s={s} large />
          <div class="app-head-main">
            <h1>{s.name}</h1>
            <p class="row-meta">
              <Badge kind={`pricing-${s.pricing_type}`}>{label(t, "pricing", s.pricing_type)}</Badge>
              <Badge kind={`review-${s.review_status}`}>{label(t, "review", s.review_status)}</Badge>
              <Tags items={s.platforms} />
            </p>
            <p class="app-actions">
              {website
                ? <a class="button primary" href={website} rel="nofollow ugc noopener noreferrer" target="_blank">{t("visitWebsite")}</a>
                : null}
              <button class="button" type="button" data-copy={prompt} title={t("askAgentHint")}>{t("askAgent")}</button>
              <Solved ctx={ctx} n={solved} href="#used-for" />
            </p>
            <StoreBadges ctx={ctx} s={s} />
            <p class="muted app-byline">{t("submittedBy")} <Author user={s.submitted_by} />, {day(s.created_at)}</p>
          </div>
        </header>
        {s.review_status === "unreviewed" ? <p class="notice">{t("unreviewedNote")}</p> : null}
        {s.review_status === "reviewed" ? <p class="notice">{t("reviewedNote")}</p> : null}
        {s.review_status === "flagged" ? <p class="warn">{t("flaggedNote")}</p> : null}
        <Screenshots ctx={ctx} s={s} />

        <div class="detail-grid">
          <div>
            <p class="prose">{s.description}</p>
            <h2>{t("capabilities")}</h2>
            <Bullets items={s.capabilities} />
            <VersionNote ctx={ctx} v={s} />
            <VersionLine ctx={ctx} type="software" id={s.id} version={s.version} />
          </div>
          <aside class="facts">
            <dl>
              <dt>{t("website")}</dt>
              <dd><Outbound href={s.canonical_url} /></dd>
              {s.repository_url && s.repository_url !== s.canonical_url ? <><dt>{t("repository")}</dt><dd><Outbound href={s.repository_url} /></dd></> : null}
              <dt>{t("platforms")}</dt>
              <dd>{s.platforms.length ? <Tags items={s.platforms} /> : "—"}</dd>
              <dt>{t("pricing")}</dt>
              <dd>{label(t, "pricing", s.pricing_type)}{s.pricing_notes ? `. ${s.pricing_notes}` : ""}</dd>
              <dt>{t("license")}</dt>
              <dd>{s.license ?? "—"}</dd>
              <dt>{t("category")}</dt>
              <dd>
                {s.category.length
                  ? (
                    <span class="tags">
                      {s.category.map((c: string) => <a class="tag" href={`/software?category=${encodeURIComponent(c)}`}>{c}</a>)}
                    </span>
                  )
                  : "—"}
              </dd>
            </dl>
            <Report ctx={ctx} type="software" id={s.id} />
          </aside>
        </div>

        <section id="used-for">
          <h2>{t("usedFor")}</h2>
          {data.solutions.length
            ? (
              <ul class="rows">
                {data.solutions.map((solution: any) => localize(solution, ctx.lang)).map((p: any) => (
                  <li class="row">
                    <div class="row-main">
                      <a class="row-title" href={`/requests/${p.request.id}`}>{localize(p.request, ctx.lang).title}</a>
                      <p class="row-text">{p.coverage_notes}</p>
                    </div>
                    <div class="row-side">
                      <Badge kind={`proposal-${p.proposal_status}`}>{label(t, "proposal", p.proposal_status)}</Badge>
                      <a class="muted" href={`/solutions/${p.proposal_id}`}><code>{p.proposal_id}</code></a>
                    </div>
                  </li>
                ))}
              </ul>
            )
            : <p class="empty">{t("notProposedYet")} <a href="/requests">{t("requestsTitle")}</a></p>}
        </section>

        <section>
          <h2>{t("evidence")}</h2>
          <p class="muted">{t("evidenceIntro")}</p>
          {data.evidence.length
            ? (
              <ul class="evidence">
                {data.evidence.map((e: any) => (
                  <li>
                    <Badge kind={`level-${e.verification_level}`}>{label(t, "level", e.verification_level)}</Badge>
                    <span>{e.claim}</span>
                    {e.source_url ? <Outbound href={e.source_url} /> : null}
                  </li>
                ))}
              </ul>
            )
            : <p class="empty">{t("noEvidence")}</p>}
        </section>
        {storeLinks(s).length ? <p class="trademarks">{t("storeTrademarks")}</p> : null}
      </article>
    </Layout>
  );
};

export const SolutionPage: FC<{ ctx: PageCtx; data: any }> = ({ ctx, data }) => {
  const { t } = ctx;
  const p = localize(data.solution, ctx.lang);
  p.request = localize(p.request, ctx.lang);
  const active = p.request.status === "open" || p.request.status === "proposals_available";
  return (
    <Layout ctx={ctx} title={`${p.software.name} → ${p.request.title}`} description={p.coverage_notes}>
      <article class="detail" data-page="solution" data-request-id={p.request.id} data-owner={p.request.owner_id} data-proposal-id={p.id} data-proposer={p.proposed_by.id} data-proposal-status={p.status}>
        <p class="crumbs"><a href={`/requests/${p.request.id}`}>{p.request.title}</a> / <code>{p.id}</code></p>
        <h1>{t("solutionTitle")}</h1>
        <p class="row-meta">
          <Badge kind={`proposal-${p.status}`}>{label(t, "proposal", p.status)}</Badge>
          <span class="muted">{t("proposedBy")} <Author user={p.proposed_by} />, {day(p.created_at)}</span>
        </p>
        <p class="notice">{t("proposalNotResolved")}</p>

        <div class="detail-grid">
          <div>
            <h2>{t("coverage")}</h2>
            <p class="prose">{p.coverage_notes}</p>
            <h2>{t("unmet")}</h2>
            <Bullets items={p.unmet_requirements} />
            <VersionNote ctx={ctx} v={p} />
            <VersionLine ctx={ctx} type="solution" id={p.id} version={p.version} />
            {p.evidence_refs.length
              ? (
                <>
                  <h2>{t("evidence")}</h2>
                  <ul class="evidence">
                    {p.evidence_refs.map((e: any) => (
                      <li>
                        <Badge kind={`level-${e.verification_level}`}>{label(t, "level", e.verification_level)}</Badge>
                        <span>{e.claim ?? ""}</span>
                        <Outbound href={e.url} />
                      </li>
                    ))}
                  </ul>
                </>
              )
              : null}
          </div>
          <aside class="facts">
            <dl>
              <dt>{t("forRequest")}</dt>
              <dd>
                <a href={`/requests/${p.request.id}`}>{p.request.title}</a>{" "}
                <Badge kind={p.request.status}>{label(t, "status", p.request.status)}</Badge>
              </dd>
              <dt>{t("mustHave")}</dt>
              <dd><Bullets items={p.request.must_have} /></dd>
              <dt>{t("software")}</dt>
              <dd class="fact-app"><AppIcon s={p.software} /><a href={`/software/${p.software.slug}`}>{p.software.name}</a></dd>
              <dt>{t("website")}</dt>
              <dd><Outbound href={p.software.canonical_url} /></dd>
            </dl>
            {p.status === "proposed" || p.status === "rejected"
              ? (
                <form data-write={`POST /solutions/${p.id}/withdraw`} data-success="reload" data-show="proposer" hidden>
                  <button class="button small" type="submit">{t("withdraw")}</button>
                </form>
              )
              : null}
            <Report ctx={ctx} type="solution" id={p.id} />
          </aside>
        </div>

        <section>
          <h2>{t("feedback")}</h2>
          {data.feedback.length
            ? (
              <ul class="feedback">
                {data.feedback.map((f: any) => (
                  <li>
                    <Badge kind={`verdict-${f.verdict}`}>{label(t, "verdict", f.verdict)}</Badge>
                    <b>{f.is_owner ? t("requester") : t("supporter")}</b>
                    <span class="muted"><Author user={f.user} />, {day(f.updated_at)}</span>
                    {f.feedback ? <p class="prose">{f.feedback}</p> : null}
                  </li>
                ))}
              </ul>
            )
            : <p class="empty">{t("noFeedback")}</p>}
          {p.status !== "withdrawn" ? <VerdictForm ctx={ctx} proposal={p} requestActive={active} /> : null}
        </section>
      </article>
    </Layout>
  );
};

const Field: FC<{ ctx: PageCtx; name: string; k: Key; kind?: string; area?: number; required?: boolean; min?: number; max?: number; type?: string; value?: string }> = (
  { ctx, name, k, kind, area, required, min, max, type, value },
) => (
  <label class="field">
    <span>{ctx.t(k)}{required ? " *" : ""}</span>
    {area
      ? <textarea name={name} rows={area} data-kind={kind} required={required} minlength={min} maxlength={max}></textarea>
      : <input type={type ?? "text"} name={name} value={value} data-kind={kind} required={required} minlength={min} maxlength={max} />}
  </label>
);

export const NewRequestPage: FC<{ ctx: PageCtx; title?: string }> = ({ ctx, title }) => (
  <Layout ctx={ctx} title={ctx.t("newRequest")} noindex>
    <div class="narrow" data-requires-auth>
      <h1>{ctx.t("newRequest")}</h1>
      <p class="lead">{ctx.t("formRequestIntro")}</p>
      <p class="notice">{ctx.t("formLanguageNote")}</p>
      <form class="form" data-write="POST /requests" data-success="redirect">
        <Field ctx={ctx} name="title" k="fTitle" required min={5} max={140} value={title || undefined} />
        <Field ctx={ctx} name="goal" k="fGoal" area={3} required min={10} max={2000} />
        <Field ctx={ctx} name="must_have" k="fMustHave" area={4} kind="lines" required />
        <Field ctx={ctx} name="nice_to_have" k="fNiceToHave" area={3} kind="lines" />
        <Field ctx={ctx} name="platforms" k="fPlatforms" kind="csv" />
        <Field ctx={ctx} name="price_constraint" k="fPrice" max={300} />
        <Field ctx={ctx} name="other_constraints" k="fOther" area={2} kind="lines" />
        <button class="button primary" type="submit">{ctx.t("submit")}</button>
      </form>
    </div>
  </Layout>
);

const HISTORY_LABELS: Record<string, Key> = {
  description: "description",
  capabilities: "capabilities",
  platforms: "platforms",
  pricing_type: "pricing",
  pricing_notes: "pricing",
  license: "license",
  category: "category",
  screenshots: "screenshots",
  goal: "goal",
  must_have: "mustHave",
  nice_to_have: "niceToHave",
  price_constraint: "priceConstraint",
  other_constraints: "otherConstraints",
  coverage_notes: "coverage",
  unmet_requirements: "unmet",
  source_refs: "evidence",
  evidence_refs: "evidence",
};

/** Earlier versions of a record, newest first, each shown in the reader's language when it had that version. */
export const HistoryPage: FC<{ ctx: PageCtx; data: any }> = ({ ctx, data }) => {
  const { t } = ctx;
  const back = new URL(data.url).pathname;
  return (
    <Layout ctx={ctx} title={`${t("historyTitle")}: ${data.label}`} noindex>
      <article class="detail">
        <p class="crumbs"><a href={back}>{data.label}</a> / {t("historyTitle")}</p>
        <h1>{t("historyTitle")}</h1>
        <p class="lead">{t("historyIntro")}</p>
        <p class="row-meta">
          <a class="button small" href={back}>{t("historyCurrent")}: {t("versionLabel")} {data.current_version}</a>
        </p>
        {data.earlier_versions.length
          ? data.earlier_versions.map((revision: any) => {
            const content = localize(revision.content, ctx.lang);
            return (
              <section class="revision">
                <h2>{t("versionLabel")} {revision.version}{content.title || content.name ? `: ${content.title ?? content.name}` : ""}</h2>
                <p class="muted">
                  {t("historyPublished")} {day(revision.published_at)}, {t("historyReplaced")} {day(revision.replaced_at)}
                </p>
                {revision.change_note ? <p class="notice">{t("historyNote")}: {revision.change_note}</p> : null}
                <dl class="revision-fields">
                  {Object.keys(HISTORY_LABELS).filter((key) => key in content).map((key) => {
                    const value = content[key];
                    const empty = value === null || value === "" || (Array.isArray(value) && !value.length);
                    return (
                      <>
                        <dt>{t(HISTORY_LABELS[key])}</dt>
                        <dd>
                          {empty
                            ? "—"
                            : key === "pricing_type"
                            ? label(t, "pricing", value)
                            : key === "screenshots"
                            ? <ul class="bullets">{value.map((url: string) => <li><Outbound href={url} /></li>)}</ul>
                            : key === "source_refs" || key === "evidence_refs"
                            ? (
                              <ul class="evidence">
                                {value.map((e: any) => (
                                  <li>
                                    <Badge kind={`level-${e.verification_level}`}>{label(t, "level", e.verification_level)}</Badge>
                                    <span>{e.claim ?? ""}</span>
                                    <Outbound href={e.url} />
                                  </li>
                                ))}
                              </ul>
                            )
                            : key === "platforms" || key === "category"
                            ? <Tags items={value} />
                            : Array.isArray(value)
                            ? <Bullets items={value} />
                            : <span class="prose">{value}</span>}
                        </dd>
                      </>
                    );
                  })}
                </dl>
                <VersionNote ctx={ctx} v={content} />
              </section>
            );
          })
          : <p class="empty">{t("historyEmpty")}</p>}
      </article>
    </Layout>
  );
};

/** Public support address, shown on /connect and the legal pages. */
export const SUPPORT_EMAIL = "support@gitdex.ai";

const Code: FC<{ children?: Child }> = ({ children }) => <pre class="code"><code>{children}</code></pre>;

export const ConnectPage: FC<{ ctx: PageCtx }> = ({ ctx }) => {
  const { t, origin } = ctx;
  return (
    <Layout ctx={ctx} title={t("connectTitle")} description={t("connectIntro")}>
      <div class="narrow wide">
        <h1>{t("connectTitle")}</h1>
        <p class="lead">{t("connectIntro")}</p>

        <div class="endpoints">
          <div class="endpoint">
            <h2>{t("connectSignedIn")}</h2>
            <Code>{`${origin}/mcp`}</Code>
            <p>{t("connectSignedInBody")}</p>
          </div>
          <div class="endpoint">
            <h2>{t("connectPublic")}</h2>
            <Code>{`${origin}/mcp/public`}</Code>
            <p>{t("connectPublicBody")}</p>
          </div>
        </div>

        <h2>{t("connectClaudeCode")}</h2>
        <Code>{`claude mcp add --transport http gitdex ${origin}/mcp`}</Code>

        <h2>{t("connectClaudeApp")}</h2>
        <p>{t("connectClaudeAppBody")}</p>

        <h2>{t("connectChatgpt")}</h2>
        <p>{t("connectChatgptBody")}</p>

        <h2>{t("connectOther")}</h2>
        <p>{t("connectOtherBody")}</p>
        <Code>{`# ~/.codex/config.toml
[mcp_servers.gitdex]
url = "${origin}/mcp"
bearer_token_env_var = "GITDEX_TOKEN"`}</Code>

        <h2>{t("connectToken")}</h2>
        <p>{t("connectTokenBody")} <a href="/account">{t("navAccount")}</a></p>
        <Code>{`Authorization: Bearer gdx_...`}</Code>

        <h2>{t("connectTry")}</h2>
        <ul class="bullets">
          <li>{t("connectTry1")}</li>
          <li>{t("connectTry2")}</li>
          <li>{t("connectTry3")}</li>
        </ul>

        <h2>{t("connectRest")}</h2>
        <p>{t("connectRestBody")}</p>
        <Code>{`curl "${origin}/api/v1/software?q=offline+notes&platforms=ios"
curl "${origin}/api/v1/requests?status=open"`}</Code>
        <p><a href="/openapi.json">/openapi.json</a></p>

        <h2>{t("connectDocs")}</h2>
        <p>{t("connectDocsBody")}</p>
        <ul class="bullets docs">
          {["guide", "find", "request", "submit", "solve", "confirm"].map((name) => <li><a href={`/ai/${name}.md`}>/ai/{name}.md</a></li>)}
        </ul>
        <p class="notice">{t("connectCaveat")}</p>

        <h2 id="help">{t("connectHelp")}</h2>
        <p>{t("connectHelpBody")} <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a></p>
      </div>
    </Layout>
  );
};

export const ShellPage: FC<{ ctx: PageCtx; title: string; lead?: string; root: string; wide?: boolean }> = (
  { ctx, title, lead, root, wide },
) => (
  <Layout ctx={ctx} title={title} noindex>
    <div class={wide ? "narrow wide" : "narrow"}>
      <h1>{title}</h1>
      {lead ? <p class="lead">{lead}</p> : null}
      <div id={root}></div>
    </div>
  </Layout>
);

export const MessagePage: FC<{ ctx: PageCtx; title: string; body: string }> = ({ ctx, title, body }) => (
  <Layout ctx={ctx} title={title} noindex>
    <div class="narrow">
      <h1>{title}</h1>
      <p class="lead">{body}</p>
      <p><a href="/">GitDex</a></p>
    </div>
  </Layout>
);
