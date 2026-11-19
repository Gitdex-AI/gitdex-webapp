// Requests directory service (PRD 5.2, 5.4, 8.3).

import { userIdFilter } from "./profiles.ts";
import {
  audit,
  CONTENT_NOTICE,
  type Ctx,
  keywordSql,
  notify,
  paged,
  pageOf,
  privacyWarnings,
  requireActor,
} from "./common.ts";
import { one, type Param, rows, textArray } from "./db.ts";
import { GitdexError } from "./errors.ts";
import { type Language, parseLanguage, parseTranslations, translationHint, translationTexts } from "./languages.ts";
import { changedFields, pick, requireAuthor, saveRevision } from "./revisions.ts";
import type { WriteOptions } from "./software.ts";
import { likePattern, searchTerms, searchText, Validator } from "./validate.ts";

export const REQUEST_STATUSES = ["open", "proposals_available", "resolved", "closed", "removed"] as const;
/** Statuses in which a request still accepts support, proposals and verdicts. */
export const ACTIVE_STATUSES = ["open", "proposals_available"];

const REQUEST_COLUMNS = `
  r.id, r.title, r.goal, r.must_have, r.nice_to_have, r.platforms, r.price_constraint,
  r.other_constraints, r.language, r.translations, r.version, r.status, r.visibility, r.resolved_proposal_id, r.created_at, r.updated_at,
  jsonb_build_object('id', p.id, 'display_name', p.display_name) as owner,
  -- the requester plus every distinct supporter; not a measure of purchase intent
  (1 + (select count(*) from interests i where i.request_id = r.id))::int as interest_count,
  (select count(*) from solution_proposals sp where sp.request_id = r.id and sp.status <> 'withdrawn')::int as proposal_count,
  -- the software the requester accepted, once the request is resolved
  (select jsonb_build_object('proposal_id', ap.id, 'software_id', s.id, 'slug', s.slug, 'name', s.name, 'icon_url', s.icon_url)
     from solution_proposals ap join software s on s.id = ap.software_id
     where ap.id = r.resolved_proposal_id and ap.status = 'accepted' and r.status = 'resolved'
       and s.review_status <> 'removed') as resolved_by`;

const REQUEST_FROM = `from requests r join profiles p on p.id = r.owner_user_id`;

export interface RequestRecord {
  id: string;
  title: string;
  status: string;
  visibility: string;
  owner: { id: string; display_name: string };
  [key: string]: unknown;
}

export async function searchRequests(ctx: Ctx, input: unknown) {
  const v = new Validator(input);
  const query = v.str("query", { max: 200 });
  const status = v.oneOf("status", ["active", "all", "open", "proposals_available", "resolved", "closed"] as const) ??
    "active";
  const platform = v.str("platform", { max: 40 });
  const sort = v.oneOf("sort", ["relevance", "newest", "updated", "interest", "proposals"] as const) ?? "relevance";
  const requestedBy = userIdFilter(v, "requested_by");
  const page = pageOf(v);
  v.done();

  const params: Param[] = [];
  const terms = searchTerms(query);
  const keyword = keywordSql("r.search_text", terms, params, likePattern);
  const where = [`r.visibility = 'public'`, `r.status <> 'removed'`, keyword.where];
  if (status === "active") where.push(`r.status in ('open', 'proposals_available')`);
  else if (status !== "all") {
    params.push(status);
    where.push(`r.status = $${params.length}::text`);
  }
  if (platform) {
    params.push(platform.toLowerCase());
    where.push(`$${params.length}::text = any(r.platforms)`);
  }
  if (requestedBy) {
    params.push(requestedBy);
    where.push(`r.owner_user_id = $${params.length}::uuid`);
  }
  const whereSql = where.join(" and ");
  const order = {
    relevance: `score desc, r.created_at desc`,
    newest: `r.created_at desc`,
    updated: `r.updated_at desc`,
    interest: `interest_count desc, r.created_at desc`,
    proposals: `proposal_count desc, r.created_at desc`,
  }[sort];

  const totalRow = await ctx.db.query(`select count(*)::int as total ${REQUEST_FROM} where ${whereSql}`, params);
  const total = Number(totalRow[0].total);
  const listParams = [...params, page.limit, page.offset];
  const list = await rows<RequestRecord & { score: number }>(
    ctx.db,
    `select ${REQUEST_COLUMNS}, ${keyword.score} as score ${REQUEST_FROM} where ${whereSql}
     order by ${order}, r.id
     limit $${listParams.length - 1}::int offset $${listParams.length}::int`,
    listParams,
  );
  const items = list.map(({ score: _score, ...item }) => item);
  return {
    ...paged(items, total, page),
    notice:
      "Similar requests are suggestions only. Compare must_have constraints before treating two requests as the same. " +
      CONTENT_NOTICE,
  };
}

export async function loadRequest(ctx: Ctx, requestId: string): Promise<RequestRecord> {
  const request = await one<RequestRecord>(
    ctx.db,
    `select ${REQUEST_COLUMNS} ${REQUEST_FROM} where r.id = $1::text and r.status <> 'removed'`,
    [requestId],
  );
  const visible = request && (request.visibility === "public" || request.owner.id === ctx.actor?.id);
  if (!request || !visible) throw new GitdexError("NOT_FOUND", `No request found for "${requestId}".`);
  return request;
}

export async function getRequest(ctx: Ctx, input: unknown) {
  const v = new Validator(input);
  const id = v.str("request_id", { required: true, max: 80 });
  v.done();
  const request = await loadRequest(ctx, id!);

  const proposals = await rows(
    ctx.db,
    `select sp.id, sp.status, sp.coverage_notes, sp.unmet_requirements, sp.language, sp.translations, sp.version,
       sp.evidence_refs, sp.created_at,
       jsonb_build_object('id', s.id, 'slug', s.slug, 'name', s.name, 'canonical_url', s.canonical_url,
         'icon_url', s.icon_url, 'platforms', s.platforms, 'pricing_type', s.pricing_type, 'review_status', s.review_status) as software,
       jsonb_build_object('id', pp.id, 'display_name', pp.display_name) as proposed_by,
       (select f.verdict from acceptance_feedback f where f.proposal_id = sp.id and f.is_owner) as requester_verdict,
       (select coalesce(jsonb_object_agg(t.verdict, t.n), '{}'::jsonb) from (
          select f.verdict, count(*)::int as n from acceptance_feedback f
          where f.proposal_id = sp.id and not f.is_owner group by f.verdict) t) as supporter_feedback
     from solution_proposals sp
     join software s on s.id = sp.software_id
     join profiles pp on pp.id = sp.proposed_by
     where sp.request_id = $1::text and sp.status <> 'withdrawn' and s.review_status <> 'removed'
     order by (sp.status = 'accepted') desc, sp.created_at desc`,
    [request.id],
  );

  let viewer: Record<string, unknown> | null = null;
  if (ctx.actor) {
    const interest = await ctx.db.query(
      `select notifications_enabled from interests where user_id = $1::uuid and request_id = $2::text`,
      [ctx.actor.id, request.id],
    );
    viewer = {
      is_owner: request.owner.id === ctx.actor.id,
      is_supporter: interest.length > 0,
      notifications_enabled: interest.length ? Boolean(interest[0].notifications_enabled) : null,
    };
  }
  return {
    request: { ...request, url: `${ctx.baseUrl}/requests/${request.id}` },
    proposals,
    viewer,
    notice:
      "A proposal is only a candidate until the original requester accepts it. interest_count is not purchase intent. " +
      CONTENT_NOTICE,
  };
}

export async function createRequest(ctx: Ctx, input: unknown, opts: WriteOptions) {
  const actor = requireActor(ctx);
  const v = new Validator(input);
  const title = v.str("title", { required: true, min: 5, max: 140 });
  const goal = v.str("goal", { required: true, min: 10, max: 2000 });
  const mustHave = v.list("must_have", { required: true, maxItems: 20, maxLen: 300 });
  const niceToHave = v.list("nice_to_have", { maxItems: 20, maxLen: 300 });
  const platforms = v.list("platforms", { maxItems: 15, maxLen: 40, lower: true });
  const priceConstraint = v.str("price_constraint", { max: 300 });
  const otherConstraints = v.list("other_constraints", { maxItems: 20, maxLen: 300 });
  const text = {
    title,
    goal,
    must_have: mustHave,
    nice_to_have: niceToHave,
    price_constraint: priceConstraint,
    other_constraints: otherConstraints,
  };
  const language = parseLanguage(v, "request", text);
  const translations = parseTranslations(v, "request", language, text);
  v.done();
  if (!title || !goal) throw new GitdexError("VALIDATION_FAILED", "Some fields are invalid.");

  const record = { ...text, title, goal, platforms, language, translations, visibility: "public" };

  if (!opts.confirmed) {
    // Server-side "search before create": the preview always carries similar
    // open requests so the agent can offer support_request instead.
    // Search queries are capped at 200 characters; a long request must still get its preview.
    const similar = await searchRequests(ctx, { query: `${title} ${mustHave.join(" ")}`.slice(0, 200), limit: 5 });
    throw new GitdexError(
      "CONFIRMATION_REQUIRED",
      "Show the user exactly what will be published and get explicit approval before creating the request.",
      {
        preview: { will_be_public: record, published_as: actor.displayName },
        privacy_warnings: privacyWarnings([
          title,
          goal,
          priceConstraint,
          ...mustHave,
          ...niceToHave,
          ...otherConstraints,
          ...translationTexts(translations),
        ]),
        ...translationHint(language, translations),
        similar_requests: similar.items.map((r) => ({
          request_id: r.id,
          title: r.title,
          must_have: r.must_have,
          platforms: r.platforms,
          status: r.status,
          language: r.language,
          translations: r.translations,
        })),
        user_prompt: "The following will be shown publicly on GitDex. Please confirm it contains no private information.",
      },
    );
  }

  const inserted = await ctx.db.query(
    `insert into requests (owner_user_id, title, goal, must_have, nice_to_have, platforms,
       price_constraint, other_constraints, created_via, search_text, language, translations)
     values ($1::uuid, $2::text, $3::text, ${textArray(4)}, ${textArray(5)}, ${textArray(6)},
       $7::text, ${textArray(8)}, $9::text, $10::text, $11::text, $12::text::jsonb)
     returning id`,
    [
      actor.id,
      title,
      goal,
      JSON.stringify(mustHave),
      JSON.stringify(niceToHave),
      JSON.stringify(platforms),
      priceConstraint,
      JSON.stringify(otherConstraints),
      ctx.client,
      requestSearchText(record),
      language,
      JSON.stringify(translations),
    ],
  );
  const id = String(inserted[0].id);
  await audit(ctx, "request.created", "request", id, `Created request "${title}"`);
  return {
    request_id: id,
    status: "open",
    url: `${ctx.baseUrl}/requests/${id}`,
    message: "Request published. Creators can now propose existing or newly built software for it.",
  };
}

/** Lowercase text the keyword search runs over: the shared facts plus every language version. */
export function requestSearchText(r: {
  title: string;
  goal: string;
  must_have: string[];
  nice_to_have: string[];
  platforms: string[];
  price_constraint?: string | null;
  other_constraints: string[];
  translations?: unknown;
}): string {
  return searchText([
    r.title,
    r.goal,
    r.must_have,
    r.nice_to_have,
    r.platforms,
    r.price_constraint ?? null,
    r.other_constraints,
    translationTexts(r.translations),
  ]);
}

/**
 * Edits a request. Only its requester may, and only before anyone has proposed
 * a solution: after that, changing the conditions would change what proposers
 * and supporters already answered to. The replaced version stays in the history.
 */
export async function updateRequest(ctx: Ctx, input: unknown, opts: WriteOptions) {
  requireActor(ctx);
  const v = new Validator(input);
  const id = v.str("request_id", { required: true, max: 80 });
  const note = v.str("change_note", { max: 300 });
  const has = (field: string) => v.input[field] !== undefined;
  if (!id) v.done();

  // deno-lint-ignore no-explicit-any
  const current = (await loadRequest(ctx, id!)) as RequestRecord & Record<string, any>;
  requireAuthor(ctx, current.owner.id);
  if (!ACTIVE_STATUSES.includes(current.status) || current.visibility !== "public") {
    throw new GitdexError("INVALID_STATE", `This request is ${current.status} and can no longer be edited.`);
  }
  if (Number(current.proposal_count) > 0) {
    throw new GitdexError(
      "INVALID_STATE",
      "This request already has proposed solutions, so its conditions can no longer change. Close it and publish a new request instead.",
    );
  }

  // deno-lint-ignore no-explicit-any
  const next: Record<string, any> = {
    title: has("title") ? v.str("title", { required: true, min: 5, max: 140 }) : current.title,
    goal: has("goal") ? v.str("goal", { required: true, min: 10, max: 2000 }) : current.goal,
    must_have: has("must_have") ? v.list("must_have", { required: true, maxItems: 20, maxLen: 300 }) : current.must_have,
    nice_to_have: has("nice_to_have") ? v.list("nice_to_have", { maxItems: 20, maxLen: 300 }) : current.nice_to_have,
    platforms: has("platforms") ? v.list("platforms", { maxItems: 15, maxLen: 40, lower: true }) : current.platforms,
    price_constraint: has("price_constraint") ? v.str("price_constraint", { max: 300 }) : current.price_constraint,
    other_constraints: has("other_constraints")
      ? v.list("other_constraints", { maxItems: 20, maxLen: 300 })
      : current.other_constraints,
  };
  const { platforms: _platforms, ...text } = next;
  const textChanged = changedFields("request", current, { ...current, ...text }).length > 0;
  next.language = textChanged || has("language") ? parseLanguage(v, "request", text) : current.language;
  next.translations = textChanged || has("translations")
    ? parseTranslations(v, "request", next.language as Language, text)
    : current.translations;
  v.done();

  const changed = changedFields("request", current, next);
  if (!changed.length) throw new GitdexError("INVALID_STATE", "The request already has these values; nothing to change.");
  const version = Number(current.version) + 1;

  if (!opts.confirmed) {
    throw new GitdexError(
      "CONFIRMATION_REQUIRED",
      "Show the user exactly what will change and get explicit approval before editing.",
      {
        preview: {
          will_be_public: { request_id: current.id, version, ...pick(next, changed), change_note: note },
          replaces: pick(current, changed),
          history: `Version ${current.version} stays publicly visible in the request's history.`,
        },
        privacy_warnings: privacyWarnings([
          next.title,
          next.goal,
          next.price_constraint,
          ...next.must_have,
          ...next.nice_to_have,
          ...next.other_constraints,
          ...translationTexts(next.translations),
          note,
        ]),
        ...translationHint(next.language as Language, next.translations),
        user_prompt: "This edit will be shown publicly on GitDex. The previous version remains visible in the history.",
      },
    );
  }

  await saveRevision(ctx, "request", current as never, note);
  await ctx.db.query(
    `update requests set title = $2::text, goal = $3::text, must_have = ${textArray(4)}, nice_to_have = ${textArray(5)},
       platforms = ${textArray(6)}, price_constraint = $7::text, other_constraints = ${textArray(8)},
       language = $9::text, translations = $10::text::jsonb, search_text = $11::text, version = $12::int, updated_at = now()
     where id = $1::text`,
    [
      current.id,
      next.title,
      next.goal,
      JSON.stringify(next.must_have),
      JSON.stringify(next.nice_to_have),
      JSON.stringify(next.platforms),
      next.price_constraint,
      JSON.stringify(next.other_constraints),
      next.language,
      JSON.stringify(next.translations),
      requestSearchText(next as never),
      version,
    ],
  );
  const supporters = await ctx.db.query(
    `select user_id from interests where request_id = $1::text and notifications_enabled`,
    [current.id],
  );
  await notify(
    ctx.db,
    supporters.map((s) => String(s.user_id)),
    "request.updated",
    current.id,
    null,
    `The request "${next.title}" was edited by its requester. Check that it still matches what you need.`,
  );
  await audit(ctx, "request.updated", "request", current.id, `Edited request "${next.title}" to version ${version} (${changed.join(", ")})`);
  return {
    request_id: current.id,
    version,
    changed,
    status: current.status,
    url: `${ctx.baseUrl}/requests/${current.id}`,
    message: `Edit published as version ${version}. Version ${current.version} remains visible in the history.`,
  };
}

export async function supportRequest(ctx: Ctx, input: unknown) {
  const actor = requireActor(ctx);
  const v = new Validator(input);
  const id = v.str("request_id", { required: true, max: 80 });
  const notifications = v.bool("notifications_enabled") ?? true;
  v.done();
  const request = await loadRequest(ctx, id!);
  if (request.owner.id === actor.id) {
    throw new GitdexError("INVALID_STATE", "You are the requester; you already follow this request.");
  }
  if (!ACTIVE_STATUSES.includes(request.status)) {
    throw new GitdexError("INVALID_STATE", `This request is ${request.status} and no longer accepts support.`);
  }
  // One row per (user, request): repeating the call never inflates the count.
  await ctx.db.query(
    `insert into interests (user_id, request_id, notifications_enabled) values ($1::uuid, $2::text, $3::boolean)
     on conflict (user_id, request_id) do update set notifications_enabled = excluded.notifications_enabled`,
    [actor.id, request.id, notifications],
  );
  await audit(ctx, "request.supported", "request", request.id, `Supported request "${request.title}"`);
  const count = await ctx.db.query(
    `select (1 + count(*))::int as n from interests where request_id = $1::text`,
    [request.id],
  );
  return {
    request_id: request.id,
    supporting: true,
    notifications_enabled: notifications,
    interest_count: Number(count[0].n),
  };
}

export async function unsupportRequest(ctx: Ctx, input: unknown) {
  const actor = requireActor(ctx);
  const v = new Validator(input);
  const id = v.str("request_id", { required: true, max: 80 });
  v.done();
  await ctx.db.query(`delete from interests where user_id = $1::uuid and request_id = $2::text`, [actor.id, id]);
  await audit(ctx, "request.unsupported", "request", id!, "Removed support");
  return { request_id: id, supporting: false };
}

export async function closeRequest(ctx: Ctx, input: unknown, opts: WriteOptions) {
  const actor = requireActor(ctx);
  const v = new Validator(input);
  const id = v.str("request_id", { required: true, max: 80 });
  // unpublish = also take the request off every public surface (PRD 11.8).
  const unpublish = v.bool("unpublish") ?? false;
  v.done();
  const request = await loadRequest(ctx, id!);
  if (request.owner.id !== actor.id) {
    throw new GitdexError("FORBIDDEN", "Only the original requester can close or withdraw this request.");
  }
  const active = ACTIVE_STATUSES.includes(request.status);
  if (!active && !unpublish) {
    throw new GitdexError("INVALID_STATE", `This request is already ${request.status}.`);
  }
  if (unpublish && request.visibility !== "public") {
    throw new GitdexError("INVALID_STATE", "This request has already been withdrawn from public view.");
  }
  const statusAfter = active ? "closed" : request.status;
  if (!opts.confirmed) {
    throw new GitdexError(
      "CONFIRMATION_REQUIRED",
      unpublish ? "Ask the user to confirm withdrawing this request." : "Ask the user to confirm closing this request.",
      {
        preview: {
          request_id: request.id,
          title: request.title,
          status_after: statusAfter,
          visibility_after: unpublish ? "private (no longer shown publicly, including its proposals)" : "public",
        },
        user_prompt: unpublish
          ? "Withdraw this request? It will be closed and removed from public view."
          : "Close this request? It will stop accepting proposals and will be shown as closed (not resolved).",
      },
    );
  }
  await ctx.db.query(
    `update requests set status = $2::text, visibility = $3::text, updated_at = now() where id = $1::text`,
    [request.id, statusAfter, unpublish ? "private" : "public"],
  );
  if (active) {
    const supporters = await ctx.db.query(
      `select user_id from interests where request_id = $1::text and notifications_enabled`,
      [request.id],
    );
    await notify(
      ctx.db,
      supporters.map((s) => String(s.user_id)),
      "request.closed",
      request.id,
      null,
      `The request "${request.title}" was closed by its requester.`,
    );
  }
  await audit(
    ctx,
    unpublish ? "request.withdrawn" : "request.closed",
    "request",
    request.id,
    `${unpublish ? "Withdrew" : "Closed"} request "${request.title}"`,
  );
  return { request_id: request.id, status: statusAfter, visibility: unpublish ? "private" : "public" };
}

/** Request status derived from its proposals, for requests that are not resolved/closed/removed. */
export async function recomputeRequestStatus(ctx: Ctx, requestId: string): Promise<string> {
  const result = await ctx.db.query(
    `update requests r set
       status = case when exists (
         select 1 from solution_proposals sp where sp.request_id = r.id and sp.status = 'proposed'
       ) then 'proposals_available' else 'open' end,
       updated_at = now()
     where r.id = $1::text and r.status in ('open', 'proposals_available')
     returning status`,
    [requestId],
  );
  if (result.length) return String(result[0].status);
  const current = await ctx.db.query(`select status from requests where id = $1::text`, [requestId]);
  return String(current[0]?.status ?? "removed");
}
