// Public author pages. Every published record already carries its author's
// display name; this is the same name with a count of what they published.
// Nothing here is private: no email, provider, status or join date.

import { CONTENT_NOTICE, type Ctx } from "./common.ts";
import { one } from "./db.ts";
import { GitdexError } from "./errors.ts";
import { Validator } from "./validate.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A user id used as a public filter; anything that is not a UUID is reported on `field`. */
export function userIdFilter(v: Validator, field: string): string | null {
  const raw = v.str(field, { max: 36 });
  if (!raw) return null;
  if (!UUID.test(raw)) {
    v.fail(field, "must be a user id (UUID), as given in submitted_by.id or owner.id");
    return null;
  }
  return raw.toLowerCase();
}

export async function getProfile(ctx: Ctx, input: unknown) {
  const v = new Validator(input);
  const raw = v.str("user_id", { required: true, max: 36 });
  v.done();
  // A malformed id names nobody: the same answer as an unknown one.
  const profile = raw && UUID.test(raw)
    ? await one<{ id: string; display_name: string; software: number; requests: number; accepted_solutions: number }>(
      ctx.db,
      `select p.id, p.display_name,
         (select count(*)::int from software s where s.submitted_by = p.id and s.review_status <> 'removed') as software,
         (select count(*)::int from requests r
            where r.owner_user_id = p.id and r.visibility = 'public' and r.status <> 'removed') as requests,
         (select count(*)::int from solution_proposals sp join software s on s.id = sp.software_id
            where s.submitted_by = p.id and s.review_status <> 'removed' and sp.status = 'accepted') as accepted_solutions
       from profiles p where p.id = $1::uuid`,
      [raw.toLowerCase()],
    )
    : null;
  if (!profile) throw new GitdexError("NOT_FOUND", `No user found for "${raw}".`);
  return {
    user: { id: profile.id, display_name: profile.display_name, url: `${ctx.baseUrl}/users/${profile.id}` },
    counts: {
      software: Number(profile.software),
      requests: Number(profile.requests),
      accepted_solutions: Number(profile.accepted_solutions),
    },
    notice:
      "A display name is chosen by the user and proves no identity. Publishing many records is not verification of any of them. " +
      CONTENT_NOTICE,
  };
}
