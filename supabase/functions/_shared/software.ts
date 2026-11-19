// Software directory service (PRD 5.1).

import {
  audit,
  CONTENT_NOTICE,
  type Ctx,
  insertEvidence,
  keywordSql,
  paged,
  pageOf,
  parseSources,
  replaceOwnEvidence,
  requireActor,
} from "./common.ts";
import { one, type Param, rows, textArray } from "./db.ts";
import { GitdexError } from "./errors.ts";
import {
  type Language,
  MAX_SCREENSHOTS,
  parseLanguage,
  parseTranslations,
  translationHint,
  translationTexts,
} from "./languages.ts";
import { userIdFilter } from "./profiles.ts";
import { changedFields, pick, requireAuthor, saveRevision } from "./revisions.ts";
import { imageUrl, likePattern, searchTerms, searchText, softwareSlug, storeUrl, Validator } from "./validate.ts";

export const PRICING_TYPES = ["free", "freemium", "paid", "subscription", "open_source", "unknown"] as const;

const SOFTWARE_COLUMNS = `
  s.id, s.slug, s.name, s.canonical_url, s.repository_url, s.app_store_url, s.google_play_url, s.description,
  s.capabilities, s.platforms, s.pricing_type, s.pricing_notes, s.license, s.category,
  s.icon_url, s.screenshots, s.language, s.translations, s.version,
  s.source_refs, s.review_status, s.created_at, s.updated_at,
  jsonb_build_object('id', p.id, 'display_name', p.display_name) as submitted_by`;

const SOFTWARE_FROM = `from software s join profiles p on p.id = s.submitted_by`;

export interface SoftwareRecord {
  id: string;
  slug: string;
  name: string;
  canonical_url: string;
  description: string;
  capabilities: string[];
  platforms: string[];
  pricing_type: string;
  category: string[];
  [key: string]: unknown;
}

export async function searchSoftware(ctx: Ctx, input: unknown) {
  const v = new Validator(input);
  const query = v.str("query", { max: 200 });
  const platforms = v.list("platforms", { maxItems: 10, maxLen: 40, lower: true });
  const pricing = v.list("pricing", { maxItems: 6, maxLen: 20, lower: true });
  const category = v.str("category", { max: 40 });
  const sort = v.oneOf("sort", ["relevance", "newest", "updated", "name", "solved"] as const) ?? "relevance";
  const submittedBy = userIdFilter(v, "submitted_by");
  const page = pageOf(v);
  for (const p of pricing) {
    if (!(PRICING_TYPES as readonly string[]).includes(p)) {
      v.fail("pricing", `each value must be one of: ${PRICING_TYPES.join(", ")}`);
    }
  }
  v.done();

  const params: Param[] = [];
  const terms = searchTerms(query);
  const keyword = keywordSql("s.search_text", terms, params, likePattern);
  const where = [`s.review_status <> 'removed'`, keyword.where];
  if (platforms.length) {
    params.push(JSON.stringify(platforms));
    where.push(`s.platforms && ${textArray(params.length)}`);
  }
  if (pricing.length) {
    params.push(JSON.stringify(pricing));
    where.push(`s.pricing_type = any(${textArray(params.length)})`);
  }
  if (category) {
    params.push(category.toLowerCase());
    where.push(`$${params.length}::text = any(s.category)`);
  }
  if (submittedBy) {
    params.push(submittedBy);
    where.push(`s.submitted_by = $${params.length}::uuid`);
  }
  const whereSql = where.join(" and ");
  const order = {
    relevance: `score desc, s.updated_at desc`,
    newest: `s.created_at desc`,
    updated: `s.updated_at desc`,
    name: `lower(s.name) asc`,
    // requests whose own requester accepted this software; never proposals alone
    solved: `accepted_solution_count desc, s.updated_at desc`,
  }[sort];

  const totalRow = await ctx.db.query(`select count(*)::int as total ${SOFTWARE_FROM} where ${whereSql}`, params);
  const total = Number(totalRow[0].total);
  const listParams = [...params, page.limit, page.offset];
  const list = await rows<SoftwareRecord & { score: number }>(
    ctx.db,
    `select ${SOFTWARE_COLUMNS}, ${keyword.score} as score,
       (select count(*)::int from solution_proposals sp where sp.software_id = s.id and sp.status = 'accepted') as accepted_solution_count
     ${SOFTWARE_FROM} where ${whereSql}
     order by ${order}, s.id
     limit $${listParams.length - 1}::int offset $${listParams.length}::int`,
    listParams,
  );

  const items = list.map(({ score: _score, ...item }) => ({
    ...item,
    matched_fields: matchedFields(item, terms),
  }));
  return {
    ...paged(items, total, page),
    notice:
      "GitDex only lists software that someone has submitted. An empty or weak result does not mean suitable software does not exist. " +
      CONTENT_NOTICE,
  };
}

function matchedFields(item: SoftwareRecord, terms: string[]): string[] {
  if (!terms.length) return [];
  // A term may have matched either language version of a field.
  const translated = (field: string) =>
    Object.values((item.translations ?? {}) as Record<string, Record<string, string | string[]>>)
      .flatMap((t) => t?.[field] ?? [])
      .join(" ");
  const fields: [string, string][] = [
    ["name", item.name],
    ["description", `${item.description} ${translated("description")}`],
    ["capabilities", `${item.capabilities.join(" ")} ${translated("capabilities")}`],
    ["platforms", item.platforms.join(" ")],
    ["category", item.category.join(" ")],
    ["pricing", `${item.pricing_type} ${item.pricing_notes ?? ""} ${translated("pricing_notes")}`],
  ];
  return fields
    .filter(([, text]) => {
      const lower = text.toLowerCase();
      return terms.some((t) => lower.includes(t));
    })
    .map(([name]) => name);
}

export async function getSoftware(ctx: Ctx, input: unknown) {
  const v = new Validator(input);
  const id = v.str("software_id", { required: true, max: 80 });
  v.done();
  const software = await one<SoftwareRecord>(
    ctx.db,
    `select ${SOFTWARE_COLUMNS} ${SOFTWARE_FROM}
     where (s.id = $1::text or s.slug = $1::text) and s.review_status <> 'removed'`,
    [id],
  );
  if (!software) throw new GitdexError("NOT_FOUND", `No software found for "${id}".`);

  const evidence = await rows(
    ctx.db,
    `select e.id, e.claim, e.source_url, e.source_type, e.verification_level, e.observed_at, e.last_checked_at
     from evidence e where e.entity_type = 'software' and e.entity_id = $1::text order by e.created_at`,
    [software.id],
  );
  const solutions = await rows(
    ctx.db,
    `select sp.id as proposal_id, sp.status as proposal_status, sp.coverage_notes, sp.unmet_requirements,
       sp.language, sp.translations, sp.created_at,
       jsonb_build_object('id', r.id, 'title', r.title, 'status', r.status,
         'language', r.language, 'translations', r.translations) as request
     from solution_proposals sp join requests r on r.id = sp.request_id
     where sp.software_id = $1::text and sp.status <> 'withdrawn'
       and r.visibility = 'public' and r.status <> 'removed'
     order by sp.created_at desc limit 50`,
    [software.id],
  );
  return {
    software: { ...software, url: `${ctx.baseUrl}/software/${software.slug}` },
    evidence,
    solutions,
    notice:
      "review_status 'unreviewed' means nobody has independently verified this record; 'reviewed' means a moderator found no rule violation, not that its claims were checked; 'flagged' means it was reported and should be treated with caution. Evidence levels: claimed < documented < tested. " +
      CONTENT_NOTICE,
  };
}

export interface WriteOptions {
  confirmed: boolean;
}

export { MAX_SCREENSHOTS };

export function parseImages(v: Validator): { icon: string | null; screenshots: string[] } {
  let icon: string | null = null;
  const rawIcon = v.input.icon_url;
  if (rawIcon !== undefined && rawIcon !== null && rawIcon !== "") {
    const result = imageUrl(rawIcon);
    if (typeof result === "string") icon = result;
    else v.fail("icon_url", result.error);
  }
  const screenshots: string[] = [];
  const rawShots = v.input.screenshots;
  if (rawShots !== undefined && rawShots !== null && rawShots !== "") {
    if (!Array.isArray(rawShots)) v.fail("screenshots", "must be an array of image URLs");
    else {
      if (rawShots.length > MAX_SCREENSHOTS) v.fail("screenshots", `at most ${MAX_SCREENSHOTS} items`);
      rawShots.slice(0, MAX_SCREENSHOTS).forEach((item, i) => {
        const result = imageUrl(item);
        if (typeof result !== "string") v.fail(`screenshots[${i}]`, result.error);
        else if (!screenshots.includes(result)) screenshots.push(result);
      });
    }
  }
  return { icon, screenshots };
}

/** The product's own store listings; an absent, null or empty field means no listing. */
export function parseStoreLinks(v: Validator): { app_store_url: string | null; google_play_url: string | null } {
  const read = (field: "app_store_url" | "google_play_url", store: "app_store" | "google_play") => {
    const raw = v.input[field];
    if (raw === undefined || raw === null || raw === "") return null;
    const result = storeUrl(raw, store);
    if (typeof result === "string") return result;
    v.fail(field, result.error);
    return null;
  };
  return { app_store_url: read("app_store_url", "app_store"), google_play_url: read("google_play_url", "google_play") };
}

/** Lowercase text the keyword search runs over: the shared facts plus every language version. */
export function softwareSearchText(s: {
  name: string;
  canonical_url: string;
  description: string;
  capabilities: string[];
  platforms: string[];
  category: string[];
  pricing_type: string;
  pricing_notes?: string | null;
  license?: string | null;
  translations?: unknown;
}): string {
  const host = new URL(s.canonical_url).hostname.replace(/^www[.]/, "");
  return searchText([
    s.name,
    s.description,
    s.capabilities,
    s.platforms,
    s.category,
    s.pricing_type,
    s.pricing_notes ?? null,
    s.license ?? null,
    host,
    translationTexts(s.translations),
  ]);
}

export async function submitSoftware(ctx: Ctx, input: unknown, opts: WriteOptions) {
  const actor = requireActor(ctx);
  const v = new Validator(input);
  const name = v.str("name", { required: true, min: 2, max: 120 });
  const url = v.url("url", { required: true });
  const repository = v.url("repository_url");
  const description = v.str("description", { required: true, min: 10, max: 2000 });
  const capabilities = v.list("capabilities", { maxItems: 30, maxLen: 200 });
  const platforms = v.list("platforms", { maxItems: 15, maxLen: 40, lower: true });
  const pricingType = v.oneOf("pricing_type", PRICING_TYPES) ?? "unknown";
  const pricingNotes = v.str("pricing_notes", { max: 500 });
  const license = v.str("license", { max: 100 });
  const category = v.list("category", { maxItems: 8, maxLen: 40, lower: true });
  const sources = parseSources(v, "sources");
  const images = parseImages(v);
  const stores = parseStoreLinks(v);
  const text = { description, capabilities, pricing_notes: pricingNotes };
  const language = parseLanguage(v, "software", text);
  const translations = parseTranslations(v, "software", language, text);
  if (repository && !repository.repoKey) {
    v.fail("repository_url", "must be a repository URL on github.com, gitlab.com, codeberg.org or bitbucket.org");
  }
  v.done();
  if (!name || !url || !description) throw new GitdexError("VALIDATION_FAILED", "Some fields are invalid.");

  const repoKey = repository?.repoKey ?? url.repoKey;

  // De-duplicate on normalized URL / repository identity before anything else,
  // so agents learn about the existing record before asking the user to confirm.
  const candidates = await rows<SoftwareRecord>(
    ctx.db,
    `select ${SOFTWARE_COLUMNS} ${SOFTWARE_FROM}
     where s.url_key = $1::text
        or ($2::text is not null and (s.repo_key = $2::text or s.url_key = $2::text))
     limit 5`,
    [url.key, repoKey],
  );
  if (candidates.length) {
    throw new GitdexError("DUPLICATE_CANDIDATE", "This software already appears to be listed on GitDex.", {
      candidates: candidates.map((c) => ({
        software_id: c.id,
        name: c.name,
        canonical_url: c.canonical_url,
        url: `${ctx.baseUrl}/software/${c.slug}`,
      })),
    });
  }

  const record = {
    name,
    canonical_url: url.url,
    repository_url: repository?.url ?? (url.repoKey ? url.url : null),
    ...stores,
    description,
    capabilities,
    platforms,
    pricing_type: pricingType,
    pricing_notes: pricingNotes,
    license,
    category,
    icon_url: images.icon,
    screenshots: images.screenshots,
    language,
    translations,
    sources,
  };

  if (!opts.confirmed) {
    const sameSite = await rows<SoftwareRecord>(
      ctx.db,
      `select s.id, s.name, s.canonical_url, s.slug from software s
       where s.review_status <> 'removed' and (s.url_key = $1::text or s.url_key like $2::text) limit 5`,
      [url.host, `${likePattern(url.host).slice(1, -1)}/%`],
    );
    throw new GitdexError(
      "CONFIRMATION_REQUIRED",
      "Show the user exactly what will be published and get explicit approval before submitting.",
      {
        preview: {
          will_be_public: record,
          submitted_as: actor.displayName,
          review_status_after_submit: "unreviewed",
        },
        ...translationHint(language, translations),
        same_site_records: sameSite.map((c) => ({ software_id: c.id, name: c.name, canonical_url: c.canonical_url })),
        user_prompt: "The following will be shown publicly on GitDex. Please confirm it contains no private information.",
      },
    );
  }

  let slug = softwareSlug(name, stores);
  const taken = await ctx.db.query(`select 1 as x from software where slug = $1::text`, [slug]);
  if (taken.length) slug = `${slug}-${crypto.randomUUID().slice(0, 5)}`;

  const inserted = await ctx.db.query(
    `insert into software (slug, name, canonical_url, url_key, repository_url, repo_key, description,
       capabilities, platforms, pricing_type, pricing_notes, license, category, source_refs,
       submitted_by, submitted_via, search_text, icon_url, screenshots, language, translations,
       app_store_url, google_play_url)
     values ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text,
       ${textArray(8)}, ${textArray(9)}, $10::text, $11::text, $12::text, ${textArray(13)}, $14::text::jsonb,
       $15::uuid, $16::text, $17::text, $18::text, $19::text::jsonb, $20::text, $21::text::jsonb,
       $22::text, $23::text)
     returning id`,
    [
      slug,
      name,
      record.canonical_url,
      url.key,
      record.repository_url,
      repoKey,
      description,
      JSON.stringify(capabilities),
      JSON.stringify(platforms),
      pricingType,
      pricingNotes,
      license,
      JSON.stringify(category),
      JSON.stringify(sources),
      actor.id,
      ctx.client,
      softwareSearchText(record),
      images.icon,
      JSON.stringify(images.screenshots),
      language,
      JSON.stringify(translations),
      stores.app_store_url,
      stores.google_play_url,
    ],
  );
  const id = String(inserted[0].id);
  await insertEvidence(ctx, "software", id, sources, `Listing details for ${name}`);
  await audit(ctx, "software.submitted", "software", id, `Submitted software "${name}" (${record.canonical_url})`);
  return {
    software_id: id,
    slug,
    review_status: "unreviewed",
    url: `${ctx.baseUrl}/software/${slug}`,
    message: "Software submitted. It is listed as unreviewed: submission is not independent verification.",
  };
}

export async function softwareSummary(ctx: Ctx, softwareId: string) {
  return await one<{ id: string; slug: string; name: string; canonical_url: string; review_status: string }>(
    ctx.db,
    `select s.id, s.slug, s.name, s.canonical_url, s.review_status from software s
     where (s.id = $1::text or s.slug = $1::text) and s.review_status <> 'removed'`,
    [softwareId],
  );
}

/**
 * Edits a software record. Only its submitter may; the site and repository
 * URLs are the record's identity and cannot change. The replaced version is
 * kept in the public history, and a moderator's "reviewed" no longer applies
 * to text they have not seen.
 */
export async function updateSoftware(ctx: Ctx, input: unknown, opts: WriteOptions) {
  requireActor(ctx);
  const v = new Validator(input);
  const id = v.str("software_id", { required: true, max: 80 });
  const note = v.str("change_note", { max: 300 });
  const has = (field: string) => v.input[field] !== undefined;
  if (!id) v.done();

  // deno-lint-ignore no-explicit-any
  const current = await one<Record<string, any>>(
    ctx.db,
    `select s.id, s.slug, s.name, s.canonical_url, s.description, s.capabilities, s.platforms, s.pricing_type,
       s.pricing_notes, s.license, s.category, s.icon_url, s.screenshots, s.language, s.translations, s.version,
       s.source_refs, s.app_store_url, s.google_play_url, s.review_status, s.submitted_by, s.created_at, s.updated_at
     from software s where (s.id = $1::text or s.slug = $1::text) and s.review_status <> 'removed'`,
    [id],
  );
  if (!current) throw new GitdexError("NOT_FOUND", `No software found for "${id}".`);
  requireAuthor(ctx, String(current.submitted_by));

  for (const field of ["url", "repository_url"]) {
    if (has(field)) v.fail(field, "cannot be changed: it identifies the record. Submit a different product as a new record.");
  }
  const images = parseImages(v);
  const stores = parseStoreLinks(v);
  // deno-lint-ignore no-explicit-any
  const next: Record<string, any> = {
    name: has("name") ? v.str("name", { required: true, min: 2, max: 120 }) : current.name,
    description: has("description") ? v.str("description", { required: true, min: 10, max: 2000 }) : current.description,
    capabilities: has("capabilities") ? v.list("capabilities", { maxItems: 30, maxLen: 200 }) : current.capabilities,
    platforms: has("platforms") ? v.list("platforms", { maxItems: 15, maxLen: 40, lower: true }) : current.platforms,
    pricing_type: has("pricing_type") ? v.oneOf("pricing_type", PRICING_TYPES, { required: true }) : current.pricing_type,
    pricing_notes: has("pricing_notes") ? v.str("pricing_notes", { max: 500 }) : current.pricing_notes,
    license: has("license") ? v.str("license", { max: 100 }) : current.license,
    category: has("category") ? v.list("category", { maxItems: 8, maxLen: 40, lower: true }) : current.category,
    icon_url: has("icon_url") ? images.icon : current.icon_url,
    screenshots: has("screenshots") ? images.screenshots : current.screenshots,
    // The sources behind the listed facts: an edit that changes a fact should bring its source.
    source_refs: has("sources") ? parseSources(v, "sources") : current.source_refs,
    app_store_url: has("app_store_url") ? stores.app_store_url : current.app_store_url,
    google_play_url: has("google_play_url") ? stores.google_play_url : current.google_play_url,
  };
  const text = { description: next.description, capabilities: next.capabilities, pricing_notes: next.pricing_notes };
  // A translation of text that has changed is stale: it must come with the edit or it is dropped.
  const textChanged = changedFields("software", current, { ...current, ...text }).length > 0;
  next.language = textChanged || has("language") ? parseLanguage(v, "software", text) : current.language;
  next.translations = textChanged || has("translations")
    ? parseTranslations(v, "software", next.language as Language, text)
    : current.translations;
  v.done();

  const changed = changedFields("software", current, next);
  if (!changed.length) throw new GitdexError("INVALID_STATE", "The record already has these values; nothing to change.");
  const reviewAfter = current.review_status === "reviewed" ? "unreviewed" : current.review_status;
  const version = Number(current.version) + 1;

  if (!opts.confirmed) {
    throw new GitdexError(
      "CONFIRMATION_REQUIRED",
      "Show the user exactly what will change and get explicit approval before editing.",
      {
        preview: {
          will_be_public: { software_id: current.id, name: next.name, version, ...pick(next, changed), change_note: note },
          replaces: pick(current, changed),
          review_status_after_edit: reviewAfter,
          history: `Version ${current.version} stays publicly visible in the record's history.`,
        },
        ...translationHint(next.language as Language, next.translations),
        user_prompt: "This edit will be shown publicly on GitDex. The previous version remains visible in the history.",
      },
    );
  }

  await saveRevision(ctx, "software", current as never, note);
  await ctx.db.query(
    `update software set name = $2::text, description = $3::text, capabilities = ${textArray(4)},
       platforms = ${textArray(5)}, pricing_type = $6::text, pricing_notes = $7::text, license = $8::text,
       category = ${textArray(9)}, icon_url = $10::text, screenshots = $11::text::jsonb, language = $12::text,
       translations = $13::text::jsonb, search_text = $14::text, review_status = $15::text,
       version = $16::int, source_refs = $17::text::jsonb, app_store_url = $18::text, google_play_url = $19::text,
       updated_at = now()
     where id = $1::text`,
    [
      current.id,
      next.name,
      next.description,
      JSON.stringify(next.capabilities),
      JSON.stringify(next.platforms),
      next.pricing_type,
      next.pricing_notes,
      next.license,
      JSON.stringify(next.category),
      next.icon_url,
      JSON.stringify(next.screenshots),
      next.language,
      JSON.stringify(next.translations),
      softwareSearchText({ ...(next as never as Parameters<typeof softwareSearchText>[0]), canonical_url: current.canonical_url }),
      reviewAfter,
      version,
      JSON.stringify(next.source_refs),
      next.app_store_url,
      next.google_play_url,
    ],
  );
  if (changed.includes("source_refs")) {
    await replaceOwnEvidence(ctx, "software", current.id, next.source_refs, `Listing details for ${next.name}`);
  }
  await audit(ctx, "software.updated", "software", current.id, `Edited software "${next.name}" to version ${version} (${changed.join(", ")})`);
  return {
    software_id: current.id,
    version,
    changed,
    review_status: reviewAfter,
    url: `${ctx.baseUrl}/software/${current.slug}`,
    message: `Edit published as version ${version}. Version ${current.version} remains visible in the history.`,
  };
}
