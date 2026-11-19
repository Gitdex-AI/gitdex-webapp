// Accounts, personal API tokens, notifications, reports and public stats (PRD 5.4, 5.5).

import { type Actor, audit, type Ctx, paged, pageOf, requireActor } from "./common.ts";
import { type Db, one, rows } from "./db.ts";
import { GitdexError } from "./errors.ts";
import { autoFlagSoftware } from "./moderation.ts";
import { cleanText, sha256Hex, Validator } from "./validate.ts";

export interface VerifiedUser {
  id: string;
  provider: string;
  /** Public handle from the identity provider, when it is meant to be public (e.g. GitHub login). */
  handle: string | null;
  /** OAuth client id when the token was issued to a third-party client. */
  oauthClientId: string | null;
}

export const API_TOKEN_PREFIX = "gdx_";

/** Creates the profile on first sight and returns the acting user. */
export async function ensureProfile(db: Db, user: VerifiedUser): Promise<Actor> {
  const fallback = `member-${user.id.replace(/-/g, "").slice(0, 6)}`;
  const displayName = cleanText(user.handle ?? "").slice(0, 60) || fallback;
  await db.query(
    `insert into profiles (id, display_name, auth_provider) values ($1::uuid, $2::text, $3::text)
     on conflict (id) do nothing`,
    [user.id, displayName, user.provider.slice(0, 40)],
  );
  return await actorById(db, user.id, user.oauthClientId ? "oauth" : "session");
}

async function actorById(db: Db, id: string, via: Actor["via"]): Promise<Actor> {
  const result = await db.query(`select display_name, status, is_admin from profiles where id = $1::uuid`, [id]);
  const profile = result[0];
  if (!profile) throw new GitdexError("AUTH_REQUIRED", "Account not found.");
  if (profile.status !== "active") throw new GitdexError("FORBIDDEN", "This account is suspended.");
  return { id, displayName: String(profile.display_name), isAdmin: Boolean(profile.is_admin), via };
}

export async function actorFromApiToken(db: Db, token: string): Promise<Actor> {
  const hash = await sha256Hex(token);
  const result = await db.query(
    `update api_tokens set last_used_at = now() where token_hash = $1::text and revoked_at is null returning user_id`,
    [hash],
  );
  if (!result.length) throw new GitdexError("AUTH_REQUIRED", "This API token is invalid or has been revoked.");
  return await actorById(db, String(result[0].user_id), "api_token");
}

function requireSession(ctx: Ctx): Actor {
  const actor = requireActor(ctx);
  if (actor.via !== "session") {
    throw new GitdexError("FORBIDDEN", "API tokens can only be managed from a signed-in browser session at /account.");
  }
  return actor;
}

export async function getMe(ctx: Ctx) {
  const actor = requireActor(ctx);
  const profile = await one(
    ctx.db,
    `select p.id, p.display_name, p.auth_provider, p.status, p.is_admin, p.notification_preferences, p.created_at,
       (select count(*)::int from notifications n where n.user_id = p.id and n.read_at is null) as unread_notifications
     from profiles p where p.id = $1::uuid`,
    [actor.id],
  );
  return { user: profile, authenticated_via: actor.via };
}

export async function updateMe(ctx: Ctx, input: unknown) {
  const actor = requireActor(ctx);
  const v = new Validator(input);
  const displayName = v.str("display_name", { min: 2, max: 60 });
  const prefs = v.input.notification_preferences;
  let prefsJson: string | null = null;
  if (prefs !== undefined && prefs !== null) {
    const pv = new Validator(prefs);
    const inApp = pv.bool("in_app");
    const email = pv.bool("email");
    for (const issue of pv.issues) v.fail(`notification_preferences.${issue.field}`, issue.issue);
    const next: Record<string, boolean> = {};
    if (inApp !== null) next.in_app = inApp;
    if (email !== null) next.email = email;
    prefsJson = JSON.stringify(next);
  }
  v.done();
  await ctx.db.query(
    `update profiles set
       display_name = coalesce($2::text, display_name),
       notification_preferences = notification_preferences || coalesce($3::text::jsonb, '{}'::jsonb),
       updated_at = now()
     where id = $1::uuid`,
    [actor.id, displayName, prefsJson],
  );
  await audit(ctx, "account.updated", "user", actor.id, "Updated profile or notification preferences");
  return await getMe(ctx);
}

export async function getMyActivity(ctx: Ctx, input: unknown) {
  const actor = requireActor(ctx);
  const v = new Validator(input);
  const type = v.oneOf("type", ["all", "requests", "software", "proposals", "subscriptions"] as const) ?? "all";
  const page = pageOf(v);
  v.done();
  const args = [actor.id, page.limit, page.offset];
  const want = (name: string) => type === "all" || type === name;
  const out: Record<string, unknown> = { limit: page.limit, offset: page.offset };

  if (want("requests")) {
    out.requests = await rows(
      ctx.db,
      `select r.id, r.title, r.status, r.created_at, r.resolved_proposal_id,
         (1 + (select count(*) from interests i where i.request_id = r.id))::int as interest_count,
         (select count(*) from solution_proposals sp where sp.request_id = r.id and sp.status = 'proposed')::int
           as proposals_awaiting_verdict
       from requests r where r.owner_user_id = $1::uuid and r.status <> 'removed'
       order by r.created_at desc limit $2::int offset $3::int`,
      args,
    );
  }
  if (want("software")) {
    out.software = await rows(
      ctx.db,
      `select s.id, s.slug, s.name, s.canonical_url, s.review_status, s.created_at
       from software s where s.submitted_by = $1::uuid and s.review_status <> 'removed'
       order by s.created_at desc limit $2::int offset $3::int`,
      args,
    );
  }
  if (want("proposals")) {
    out.proposals = await rows(
      ctx.db,
      `select sp.id, sp.status, sp.created_at,
         jsonb_build_object('id', r.id, 'title', r.title, 'status', r.status) as request,
         jsonb_build_object('id', s.id, 'slug', s.slug, 'name', s.name) as software
       from solution_proposals sp
       join requests r on r.id = sp.request_id join software s on s.id = sp.software_id
       where sp.proposed_by = $1::uuid
       order by sp.created_at desc limit $2::int offset $3::int`,
      args,
    );
  }
  if (want("subscriptions")) {
    out.subscriptions = await rows(
      ctx.db,
      `select i.notifications_enabled, i.created_at,
         jsonb_build_object('id', r.id, 'title', r.title, 'status', r.status) as request
       from interests i join requests r on r.id = i.request_id
       where i.user_id = $1::uuid and r.status <> 'removed'
       order by i.created_at desc limit $2::int offset $3::int`,
      args,
    );
  }
  return out;
}

export async function listNotifications(ctx: Ctx, input: unknown) {
  const actor = requireActor(ctx);
  const v = new Validator(input);
  const page = pageOf(v);
  v.done();
  const total = await ctx.db.query(`select count(*)::int as n from notifications where user_id = $1::uuid`, [actor.id]);
  const items = await rows(
    ctx.db,
    `select n.id, n.type, n.request_id, n.proposal_id, n.message, n.read_at, n.created_at
     from notifications n where n.user_id = $1::uuid
     order by n.created_at desc limit $2::int offset $3::int`,
    [actor.id, page.limit, page.offset],
  );
  return paged(items, Number(total[0].n), page);
}

export async function markNotificationsRead(ctx: Ctx) {
  const actor = requireActor(ctx);
  await ctx.db.query(`update notifications set read_at = now() where user_id = $1::uuid and read_at is null`, [
    actor.id,
  ]);
  return { ok: true };
}

export async function listTokens(ctx: Ctx) {
  const actor = requireSession(ctx);
  const items = await rows(
    ctx.db,
    `select t.id, t.name, t.token_prefix, t.last_used_at, t.created_at
     from api_tokens t where t.user_id = $1::uuid and t.revoked_at is null order by t.created_at desc`,
    [actor.id],
  );
  return { items };
}

export async function createToken(ctx: Ctx, input: unknown) {
  const actor = requireSession(ctx);
  const v = new Validator(input);
  const name = v.str("name", { required: true, min: 1, max: 60 });
  v.done();
  const existing = await ctx.db.query(
    `select count(*)::int as n from api_tokens where user_id = $1::uuid and revoked_at is null`,
    [actor.id],
  );
  if (Number(existing[0].n) >= 10) {
    throw new GitdexError("CONFLICT", "You can have at most 10 active API tokens. Revoke one first.");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = API_TOKEN_PREFIX + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const inserted = await ctx.db.query(
    `insert into api_tokens (user_id, name, token_hash, token_prefix)
     values ($1::uuid, $2::text, $3::text, $4::text) returning id`,
    [actor.id, name, await sha256Hex(token), token.slice(0, 10)],
  );
  await audit(ctx, "token.created", "token", String(inserted[0].id), `Created API token "${name}"`);
  // The plaintext token is returned exactly once and never stored.
  return { id: String(inserted[0].id), name, token };
}

export async function revokeToken(ctx: Ctx, input: unknown) {
  const actor = requireSession(ctx);
  const v = new Validator(input);
  const id = v.str("token_id", { required: true, max: 80 });
  v.done();
  const result = await ctx.db.query(
    `update api_tokens set revoked_at = now() where id = $1::text and user_id = $2::uuid and revoked_at is null returning id`,
    [id, actor.id],
  );
  if (!result.length) throw new GitdexError("NOT_FOUND", "No active API token with that ID.");
  await audit(ctx, "token.revoked", "token", id!, "Revoked API token");
  return { id, revoked: true };
}

export async function reportContent(ctx: Ctx, input: unknown) {
  const actor = requireActor(ctx);
  const v = new Validator(input);
  const entityType = v.oneOf("entity_type", ["software", "request", "solution"] as const, { required: true });
  const entityId = v.str("entity_id", { required: true, max: 80 });
  const reason = v.str("reason", { required: true, min: 5, max: 1000 });
  v.done();
  const table = { software: "software", request: "requests", solution: "solution_proposals" }[entityType!];
  const exists = await ctx.db.query(`select 1 as x from ${table} where id = $1::text`, [entityId]);
  if (!exists.length) throw new GitdexError("NOT_FOUND", `No ${entityType} found for "${entityId}".`);
  const inserted = await ctx.db.query(
    `insert into reports (reporter_user_id, entity_type, entity_id, reason)
     values ($1::uuid, $2::text, $3::text, $4::text) returning id`,
    [actor.id, entityType, entityId, reason],
  );
  await audit(ctx, "content.reported", entityType!, entityId!, "Reported content for review");
  if (entityType === "software") await autoFlagSoftware(ctx, entityId!);
  return { report_id: String(inserted[0].id), status: "open", message: "Report received. A moderator will review it." };
}

export async function getStats(ctx: Ctx) {
  const result = await ctx.db.query(
    `select
       (select count(*)::int from software where review_status <> 'removed') as software,
       (select count(*)::int from requests where visibility = 'public' and status in ('open', 'proposals_available')) as open_requests,
       (select count(*)::int from requests where visibility = 'public' and status = 'resolved') as verified_resolved_requests,
       (select count(*)::int from solution_proposals where status <> 'withdrawn') as proposals`,
  );
  return result[0];
}
