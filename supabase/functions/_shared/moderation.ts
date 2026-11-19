// Moderation (PRD 5.5). Content is published first and handled afterwards:
// anyone signed in can report a record, a moderator works through the reports
// and the newest listings. Every action here is limited to administrators in a
// browser session, is audited, and tells the author what happened.

import { type Actor, audit, type Ctx, notify, paged, pageOf, requireActor } from "./common.ts";
import { one, rows } from "./db.ts";
import { GitdexError } from "./errors.ts";
import { recomputeRequestStatus } from "./requests.ts";
import type { WriteOptions } from "./software.ts";
import { Validator } from "./validate.ts";

export const MODERATED_ENTITIES = ["software", "request", "solution"] as const;
type Entity = (typeof MODERATED_ENTITIES)[number];

/** What a moderator can do to each kind of record. */
export const MODERATION_ACTIONS: Record<Entity, readonly string[]> = {
  software: ["mark_reviewed", "flag", "remove", "restore", "clear_images", "clear_history"],
  request: ["remove", "restore", "clear_history"],
  solution: ["remove", "clear_history"],
};
const ALL_ACTIONS = [...new Set(Object.values(MODERATION_ACTIONS).flat())];

/** Distinct reporters after which an unreviewed software record is flagged automatically. */
export const AUTO_FLAG_REPORTERS = 3;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireAdmin(ctx: Ctx): Actor {
  const actor = requireActor(ctx);
  if (!actor.isAdmin) throw new GitdexError("FORBIDDEN", "This action is limited to GitDex moderators.");
  // A leaked API token or a connected AI client must never be able to moderate.
  if (actor.via !== "session") {
    throw new GitdexError("FORBIDDEN", "Moderation is only available from a signed-in browser session at /admin.");
  }
  return actor;
}

const AUTHOR = (alias: string) =>
  `jsonb_build_object('id', ${alias}.id, 'display_name', ${alias}.display_name, 'status', ${alias}.status)`;

export async function listReports(ctx: Ctx, input: unknown) {
  requireAdmin(ctx);
  const v = new Validator(input);
  const status = v.oneOf("status", ["open", "actioned", "dismissed", "all"] as const) ?? "open";
  const page = pageOf(v);
  v.done();
  const total = await ctx.db.query(
    `select count(*)::int as n from reports rp where ($1::text = 'all' or rp.status = $1::text)`,
    [status],
  );
  const items = await rows(
    ctx.db,
    `select rp.id, rp.entity_type, rp.entity_id, rp.reason, rp.status, rp.created_at,
       jsonb_build_object('id', p.id, 'display_name', p.display_name) as reporter,
       case rp.entity_type
         when 'software' then (
           select jsonb_build_object('label', s.name, 'state', s.review_status, 'path', '/software/' || s.slug,
             'text', s.description, 'author', ${AUTHOR("a")})
           from software s join profiles a on a.id = s.submitted_by where s.id = rp.entity_id)
         when 'request' then (
           select jsonb_build_object('label', r.title, 'state', r.status, 'path', '/requests/' || r.id,
             'text', r.goal, 'author', ${AUTHOR("a")})
           from requests r join profiles a on a.id = r.owner_user_id where r.id = rp.entity_id)
         else (
           select jsonb_build_object('label', s.name || ' → ' || r.title, 'state', sp.status, 'path', '/solutions/' || sp.id,
             'text', sp.coverage_notes, 'author', ${AUTHOR("a")})
           from solution_proposals sp
           join software s on s.id = sp.software_id join requests r on r.id = sp.request_id
           join profiles a on a.id = sp.proposed_by where sp.id = rp.entity_id)
       end as record
     from reports rp join profiles p on p.id = rp.reporter_user_id
     where ($1::text = 'all' or rp.status = $1::text)
     order by rp.created_at desc, rp.id limit $2::int offset $3::int`,
    [status, page.limit, page.offset],
  );
  return paged(items, Number(total[0].n), page);
}

/** Software listings for review, newest first, including flagged and removed ones. */
export async function listSoftwareForReview(ctx: Ctx, input: unknown) {
  requireAdmin(ctx);
  const v = new Validator(input);
  const status = v.oneOf("review_status", ["unreviewed", "reviewed", "flagged", "removed", "all"] as const) ?? "unreviewed";
  const page = pageOf(v);
  v.done();
  const total = await ctx.db.query(
    `select count(*)::int as n from software s where ($1::text = 'all' or s.review_status = $1::text)`,
    [status],
  );
  const items = await rows(
    ctx.db,
    `select s.id, s.slug, s.name, s.canonical_url, s.description, s.icon_url, s.screenshots, s.review_status, s.created_at,
       ${AUTHOR("a")} as submitted_by,
       (select count(*)::int from reports rp
         where rp.entity_type = 'software' and rp.entity_id = s.id and rp.status = 'open') as open_reports
     from software s join profiles a on a.id = s.submitted_by
     where ($1::text = 'all' or s.review_status = $1::text)
     order by s.created_at desc, s.id limit $2::int offset $3::int`,
    [status, page.limit, page.offset],
  );
  return paged(items, Number(total[0].n), page);
}

interface Target {
  id: string;
  label: string;
  state: string;
  authorId: string;
  requestId: string | null;
  proposalId: string | null;
  hasImages: boolean;
  resolvedProposalId: string | null;
  /** Earlier versions kept in the public history. */
  revisions: number;
}

async function loadTarget(ctx: Ctx, entity: Entity, id: string): Promise<Target> {
  // Moderators see records in every state, including removed ones.
  // deno-lint-ignore no-explicit-any
  let row: Record<string, any> | null;
  if (entity === "software") {
    row = await one(
      ctx.db,
      `select s.id, s.name as label, s.review_status as state, s.submitted_by as author_id,
         (s.icon_url is not null or jsonb_array_length(s.screenshots) > 0
           or exists (select 1 from jsonb_each(s.translations) t(code, version) where version ? 'screenshots')) as has_images
       from software s where s.id = $1::text or s.slug = $1::text`,
      [id],
    );
  } else if (entity === "request") {
    row = await one(
      ctx.db,
      `select r.id, r.title as label, r.status as state, r.owner_user_id as author_id, r.id as request_id,
         r.resolved_proposal_id
       from requests r where r.id = $1::text`,
      [id],
    );
  } else {
    row = await one(
      ctx.db,
      `select sp.id, s.name || ' → ' || r.title as label, sp.status as state, sp.proposed_by as author_id,
         sp.request_id, sp.id as proposal_id
       from solution_proposals sp
       join software s on s.id = sp.software_id join requests r on r.id = sp.request_id
       where sp.id = $1::text`,
      [id],
    );
  }
  if (!row) throw new GitdexError("NOT_FOUND", `No ${entity} found for "${id}".`);
  const revisions = await ctx.db.query(
    `select count(*)::int as n from record_revisions where entity_type = $1::text and entity_id = $2::text`,
    [entity, String(row.id)],
  );
  return {
    revisions: Number(revisions[0].n),
    id: String(row.id),
    label: String(row.label),
    state: String(row.state),
    authorId: String(row.author_id),
    requestId: row.request_id ? String(row.request_id) : null,
    proposalId: row.proposal_id ? String(row.proposal_id) : null,
    hasImages: Boolean(row.has_images),
    resolvedProposalId: row.resolved_proposal_id ? String(row.resolved_proposal_id) : null,
  };
}

/** The state an action leads to, or an INVALID_STATE error when it would change nothing. */
function stateAfter(entity: Entity, action: string, target: Target): string {
  const same = (state: string) => {
    if (target.state === state) throw new GitdexError("INVALID_STATE", `This ${entity} is already ${state}.`);
    return state;
  };
  if (action === "clear_history") {
    if (!target.revisions) throw new GitdexError("INVALID_STATE", `This ${entity} has no earlier versions.`);
    return target.state;
  }
  if (action === "clear_images") {
    if (!target.hasImages) throw new GitdexError("INVALID_STATE", "This software has no icon or screenshots.");
    return target.state;
  }
  if (action === "restore") {
    if (target.state !== "removed") throw new GitdexError("INVALID_STATE", `This ${entity} is not removed.`);
    if (entity === "software") return "unreviewed";
    return target.resolvedProposalId ? "resolved" : "open";
  }
  if (action === "remove") return same(entity === "solution" ? "withdrawn" : "removed");
  if (action === "mark_reviewed") {
    if (target.state === "removed") throw new GitdexError("INVALID_STATE", "Restore this software before reviewing it.");
    return same("reviewed");
  }
  if (target.state === "removed") throw new GitdexError("INVALID_STATE", "This software is already removed.");
  return same("flagged");
}

const VERBS: Record<string, string> = {
  mark_reviewed: "reviewed",
  flag: "flagged",
  remove: "removed",
  restore: "restored",
  clear_images: "removed the images from",
  clear_history: "deleted the earlier versions of",
};

/** How acting on a record settles the open reports about it. */
const REPORT_OUTCOME: Record<string, "actioned" | "dismissed" | null> = {
  mark_reviewed: "dismissed",
  flag: "actioned",
  remove: "actioned",
  clear_images: "actioned",
  clear_history: "actioned",
  restore: null,
};

export async function moderate(ctx: Ctx, input: unknown, opts: WriteOptions) {
  const actor = requireAdmin(ctx);
  const v = new Validator(input);
  const entity = v.oneOf("entity_type", MODERATED_ENTITIES, { required: true });
  const entityId = v.str("entity_id", { required: true, max: 80 });
  const action = v.oneOf("action", ALL_ACTIONS, { required: true });
  const note = v.str("note", { max: 300 });
  if (entity && action && !MODERATION_ACTIONS[entity].includes(action)) {
    v.fail("action", `for a ${entity} must be one of: ${MODERATION_ACTIONS[entity].join(", ")}`);
  }
  v.done();

  const target = await loadTarget(ctx, entity!, entityId!);
  const after = stateAfter(entity!, action!, target);
  const outcome = REPORT_OUTCOME[action!];
  const openReports = await ctx.db.query(
    `select count(*)::int as n from reports where entity_type = $1::text and entity_id = $2::text and status = 'open'`,
    [entity, target.id],
  );

  if (!opts.confirmed) {
    throw new GitdexError("CONFIRMATION_REQUIRED", "Confirm this moderation action.", {
      preview: {
        entity_type: entity,
        entity_id: target.id,
        record: target.label,
        action,
        state_before: target.state,
        state_after: after,
        open_reports_settled: outcome ? Number(openReports[0].n) : 0,
        note_to_author: note,
      },
    });
  }

  if (action === "clear_history") {
    // For private or unlawful text an author edited out: the current record stays as it is.
    await ctx.db.query(`delete from record_revisions where entity_type = $1::text and entity_id = $2::text`, [
      entity,
      target.id,
    ]);
  } else if (entity === "software") {
    await ctx.db.query(
      action === "clear_images"
        ? `update software set icon_url = null, screenshots = '[]'::jsonb,
             translations = (select coalesce(jsonb_object_agg(t.code, t.version - 'screenshots'), '{}'::jsonb)
                             from jsonb_each(translations) t(code, version)),
             updated_at = now()
           where id = $1::text`
        : `update software set review_status = $2::text, updated_at = now() where id = $1::text`,
      action === "clear_images" ? [target.id] : [target.id, after],
    );
  } else if (entity === "request") {
    await ctx.db.query(`update requests set status = $2::text, updated_at = now() where id = $1::text`, [target.id, after]);
    // A restored request gets back the status its proposals imply.
    if (action === "restore") await recomputeRequestStatus(ctx, target.id);
  } else {
    // Removing the accepted proposal takes the resolution with it: the request
    // is no longer solved by anything a visitor can see.
    await ctx.db.query(
      `update requests set status = 'open', resolved_proposal_id = null, updated_at = now()
       where id = $1::text and resolved_proposal_id = $2::text and status = 'resolved'`,
      [target.requestId, target.id],
    );
    await ctx.db.query(`update solution_proposals set status = 'withdrawn', updated_at = now() where id = $1::text`, [
      target.id,
    ]);
    await recomputeRequestStatus(ctx, target.requestId!);
  }

  if (outcome) {
    await ctx.db.query(
      `update reports set status = $3::text where entity_type = $1::text and entity_id = $2::text and status = 'open'`,
      [entity, target.id, outcome],
    );
  }
  if (target.authorId !== actor.id) {
    await notify(
      ctx.db,
      [target.authorId],
      `moderation.${action}`,
      entity === "software" || action === "remove" ? null : target.requestId,
      null,
      `A GitDex moderator ${VERBS[action!]} your ${entity} "${target.label}".${note ? ` Note: ${note}` : ""}`,
    );
  }
  await audit(ctx, `moderation.${action}`, entity!, target.id, `Moderator ${VERBS[action!]} ${entity} "${target.label}"${note ? `: ${note}` : ""}`);
  return { entity_type: entity, entity_id: target.id, action, state: after };
}

/** Settles the open reports about one record without changing the record. */
export async function resolveReports(ctx: Ctx, input: unknown) {
  requireAdmin(ctx);
  const v = new Validator(input);
  const entity = v.oneOf("entity_type", MODERATED_ENTITIES, { required: true });
  const entityId = v.str("entity_id", { required: true, max: 80 });
  const resolution = v.oneOf("resolution", ["dismissed", "actioned"] as const, { required: true });
  v.done();
  const updated = await ctx.db.query(
    `update reports set status = $3::text
     where entity_type = $1::text and entity_id = $2::text and status = 'open' returning id`,
    [entity, entityId, resolution],
  );
  if (!updated.length) throw new GitdexError("NOT_FOUND", "There are no open reports about this record.");
  await audit(ctx, `reports.${resolution}`, entity!, entityId!, `Moderator ${resolution} ${updated.length} report(s)`);
  return { entity_type: entity, entity_id: entityId, resolution, reports: updated.length };
}

export async function setUserStatus(ctx: Ctx, input: unknown, opts: WriteOptions) {
  const actor = requireAdmin(ctx);
  const v = new Validator(input);
  const userId = v.str("user_id", { required: true, max: 40 });
  const status = v.oneOf("status", ["active", "suspended"] as const, { required: true });
  if (userId && !UUID.test(userId)) v.fail("user_id", "must be a user ID (UUID)");
  v.done();
  if (userId === actor.id) throw new GitdexError("FORBIDDEN", "You cannot change the status of your own account.");
  const user = await one<{ id: string; display_name: string; status: string }>(
    ctx.db,
    `select p.id, p.display_name, p.status from profiles p where p.id = $1::uuid`,
    [userId],
  );
  if (!user) throw new GitdexError("NOT_FOUND", `No user found for "${userId}".`);
  if (user.status === status) throw new GitdexError("INVALID_STATE", `This account is already ${status}.`);
  if (!opts.confirmed) {
    throw new GitdexError("CONFIRMATION_REQUIRED", "Confirm changing this account's status.", {
      preview: {
        user_id: user.id,
        display_name: user.display_name,
        status_before: user.status,
        status_after: status,
        effect: status === "suspended"
          ? "The account can no longer sign in, write, or use its API tokens. Its published records stay until removed."
          : "The account can sign in and write again.",
      },
    });
  }
  await ctx.db.query(`update profiles set status = $2::text, updated_at = now() where id = $1::uuid`, [user.id, status]);
  await audit(ctx, `user.${status}`, "user", user.id, `Moderator set account "${user.display_name}" to ${status}`);
  return { user_id: user.id, display_name: user.display_name, status };
}

/**
 * Called after a report is stored: software nobody has reviewed is flagged
 * once enough different people have reported it. Flagging adds a warning to
 * the page; only a moderator removes a record.
 */
export async function autoFlagSoftware(ctx: Ctx, softwareId: string): Promise<boolean> {
  const flagged = await ctx.db.query(
    `update software set review_status = 'flagged', updated_at = now()
     where id = $1::text and review_status = 'unreviewed'
       and (select count(distinct rp.reporter_user_id) from reports rp
            where rp.entity_type = 'software' and rp.entity_id = $1::text and rp.status = 'open') >= $2::int
     returning id`,
    [softwareId, AUTO_FLAG_REPORTERS],
  );
  if (!flagged.length) return false;
  await audit(ctx, "moderation.auto_flag", "software", softwareId, `Flagged automatically after reports from ${AUTO_FLAG_REPORTERS} users`);
  return true;
}
