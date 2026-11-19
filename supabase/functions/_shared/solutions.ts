// Solution proposals and acceptance (PRD 5.3).
//
// Invariants enforced here, independent of any prompt or tool description:
//   - proposing never resolves a request
//   - only the original requester's "accepted" verdict resolves it
//   - a proposer can never accept their own proposal
//   - supporters record their own feedback without changing any status

import {
  audit,
  CONTENT_NOTICE,
  type Ctx,
  insertEvidence,
  notify,
  parseSources,
  replaceOwnEvidence,
  requireActor,
} from "./common.ts";
import { one, rows, textArray } from "./db.ts";
import { GitdexError } from "./errors.ts";
import { type Language, parseLanguage, parseTranslations, translationHint } from "./languages.ts";
import { changedFields, pick, requireAuthor, saveRevision } from "./revisions.ts";
import { ACTIVE_STATUSES, loadRequest, recomputeRequestStatus } from "./requests.ts";
import { softwareSummary, type WriteOptions } from "./software.ts";
import { Validator } from "./validate.ts";

export const VERDICTS = ["accepted", "partial", "rejected"] as const;

interface ProposalRow {
  id: string;
  request_id: string;
  software_id: string;
  proposed_by: string;
  status: string;
  coverage_notes: string;
  unmet_requirements: string[];
}

async function loadProposal(ctx: Ctx, proposalId: string): Promise<ProposalRow> {
  const proposal = await one<ProposalRow>(
    ctx.db,
    `select sp.id, sp.request_id, sp.software_id, sp.proposed_by, sp.status, sp.coverage_notes, sp.unmet_requirements
     from solution_proposals sp where sp.id = $1::text`,
    [proposalId],
  );
  if (!proposal) throw new GitdexError("NOT_FOUND", `No solution proposal found for "${proposalId}".`);
  return proposal;
}

export async function proposeSolution(ctx: Ctx, input: unknown, opts: WriteOptions) {
  const actor = requireActor(ctx);
  const v = new Validator(input);
  const requestId = v.str("request_id", { required: true, max: 80 });
  const softwareId = v.str("software_id", { required: true, max: 80 });
  const coverage = v.str("coverage_notes", { required: true, min: 10, max: 2000 });
  const unmet = v.list("unmet_requirements", { maxItems: 20, maxLen: 300 });
  const evidence = parseSources(v, "evidence");
  const text = { coverage_notes: coverage, unmet_requirements: unmet };
  const language = parseLanguage(v, "solution", text);
  const translations = parseTranslations(v, "solution", language, text);
  v.done();

  const request = await loadRequest(ctx, requestId!);
  if (request.visibility !== "public" || !ACTIVE_STATUSES.includes(request.status)) {
    throw new GitdexError("INVALID_STATE", `This request is ${request.status} and does not accept new proposals.`);
  }
  const software = await softwareSummary(ctx, softwareId!);
  if (!software) {
    throw new GitdexError("NOT_FOUND", `No software found for "${softwareId}". Submit it first with submit_software.`);
  }
  const existing = await ctx.db.query(
    `select id from solution_proposals where request_id = $1::text and software_id = $2::text and status <> 'withdrawn'`,
    [request.id, software.id],
  );
  if (existing.length) {
    throw new GitdexError("DUPLICATE_CANDIDATE", "This software has already been proposed for this request.", {
      candidates: [{ proposal_id: String(existing[0].id), url: `${ctx.baseUrl}/solutions/${existing[0].id}` }],
    });
  }

  if (!opts.confirmed) {
    throw new GitdexError(
      "CONFIRMATION_REQUIRED",
      "Show the user exactly what will be published and get explicit approval before proposing.",
      {
        preview: {
          will_be_public: {
            request: { id: request.id, title: request.title, must_have: request.must_have },
            software: { id: software.id, name: software.name, canonical_url: software.canonical_url },
            coverage_notes: coverage,
            unmet_requirements: unmet,
            language,
            translations,
            evidence,
          },
          proposed_as: actor.displayName,
          status_after_submit: "proposed",
        },
        ...translationHint(language, translations),
        user_prompt:
          "The following proposal will be shown publicly on GitDex. Submitting it does not mark the request as resolved.",
      },
    );
  }

  const inserted = await ctx.db.query(
    `insert into solution_proposals (request_id, software_id, proposed_by, coverage_notes, unmet_requirements,
       evidence_refs, proposed_via, language, translations)
     values ($1::text, $2::text, $3::uuid, $4::text, ${textArray(5)}, $6::text::jsonb, $7::text,
       $8::text, $9::text::jsonb)
     returning id`,
    [
      request.id,
      software.id,
      actor.id,
      coverage,
      JSON.stringify(unmet),
      JSON.stringify(evidence),
      ctx.client,
      language,
      JSON.stringify(translations),
    ],
  );
  const id = String(inserted[0].id);
  await insertEvidence(ctx, "solution", id, evidence, `Coverage of request ${request.id} by ${software.name}`);
  const requestStatus = await recomputeRequestStatus(ctx, request.id);

  const supporters = await ctx.db.query(
    `select user_id from interests where request_id = $1::text and notifications_enabled`,
    [request.id],
  );
  const recipients = [request.owner.id, ...supporters.map((s) => String(s.user_id))].filter((u) => u !== actor.id);
  await notify(
    ctx.db,
    recipients,
    "proposal.created",
    request.id,
    id,
    `New proposed solution for "${request.title}": ${software.name}. Try it and record whether it meets your needs.`,
  );
  await audit(ctx, "solution.proposed", "solution", id, `Proposed ${software.name} for request ${request.id}`);
  return {
    proposal_id: id,
    status: "proposed",
    request_status: requestStatus,
    url: `${ctx.baseUrl}/solutions/${id}`,
    message: "Solution submitted and awaiting the requester's evaluation. This does not mean the request is resolved.",
  };
}

export async function confirmSolution(ctx: Ctx, input: unknown, opts: WriteOptions) {
  const actor = requireActor(ctx);
  const v = new Validator(input);
  const proposalId = v.str("proposal_id", { required: true, max: 80 });
  const requestId = v.str("request_id", { max: 80 });
  const verdict = v.oneOf("verdict", VERDICTS, { required: true });
  const feedback = v.str("feedback", { max: 2000 });
  v.done();

  const proposal = await loadProposal(ctx, proposalId!);
  if (requestId && requestId !== proposal.request_id) {
    throw new GitdexError("VALIDATION_FAILED", "Some fields are invalid.", {
      fields: [{ field: "request_id", issue: "does not match the proposal's request" }],
    });
  }
  const request = await loadRequest(ctx, proposal.request_id);
  const isOwner = request.owner.id === actor.id;
  const isSupporter = !isOwner &&
    (await ctx.db.query(`select 1 as x from interests where user_id = $1::uuid and request_id = $2::text`, [
        actor.id,
        request.id,
      ])).length > 0;

  if (!isOwner && !isSupporter) {
    throw new GitdexError(
      "FORBIDDEN",
      "Only the original requester can accept or reject a proposal. Supporters of the request can add their own feedback.",
    );
  }
  if (proposal.status === "withdrawn") {
    throw new GitdexError("INVALID_STATE", "This proposal was withdrawn by its proposer.");
  }
  if (proposal.proposed_by === actor.id) {
    throw new GitdexError("FORBIDDEN", "You cannot record a verdict on your own proposal.");
  }
  if (isOwner && !ACTIVE_STATUSES.includes(request.status)) {
    throw new GitdexError("INVALID_STATE", `This request is already ${request.status}.`);
  }

  if (!opts.confirmed) {
    const software = await softwareSummary(ctx, proposal.software_id);
    throw new GitdexError(
      "CONFIRMATION_REQUIRED",
      "Ask the user for their verdict in their own words before recording it. Never infer acceptance.",
      {
        preview: {
          request: { id: request.id, title: request.title, must_have: request.must_have },
          software: software ? { id: software.id, name: software.name, canonical_url: software.canonical_url } : null,
          coverage_notes: proposal.coverage_notes,
          unmet_requirements: proposal.unmet_requirements,
          verdict,
          feedback,
          recorded_as: isOwner ? "requester" : "supporter",
          effect: isOwner
            ? verdict === "accepted"
              ? "The request will be marked resolved."
              : "The request stays open."
            : "Recorded as your individual feedback; it does not change the request status.",
        },
        user_prompt: "Does this solution meet all of the required conditions you set out? Feedback is public.",
      },
    );
  }

  const saved = await ctx.db.query(
    `insert into acceptance_feedback (proposal_id, request_id, user_id, verdict, feedback, is_owner)
     values ($1::text, $2::text, $3::uuid, $4::text, $5::text, $6::boolean)
     on conflict (proposal_id, user_id) do update
       set verdict = excluded.verdict, feedback = excluded.feedback, updated_at = now()
     returning id`,
    [proposal.id, request.id, actor.id, verdict, feedback, isOwner],
  );
  const feedbackId = String(saved[0].id);

  let proposalStatus = proposal.status;
  let requestStatus = request.status;
  if (isOwner) {
    // V1: only a full "accepted" from the original requester resolves the request.
    proposalStatus = verdict === "accepted" ? "accepted" : verdict === "rejected" ? "rejected" : "proposed";
    await ctx.db.query(`update solution_proposals set status = $2::text, updated_at = now() where id = $1::text`, [
      proposal.id,
      proposalStatus,
    ]);
    if (verdict === "accepted") {
      await ctx.db.query(
        `update requests set status = 'resolved', resolved_proposal_id = $2::text, updated_at = now() where id = $1::text`,
        [request.id, proposal.id],
      );
      requestStatus = "resolved";
    } else {
      requestStatus = await recomputeRequestStatus(ctx, request.id);
    }
    const recipients = [proposal.proposed_by];
    if (verdict === "accepted") {
      const supporters = await ctx.db.query(
        `select user_id from interests where request_id = $1::text and notifications_enabled`,
        [request.id],
      );
      recipients.push(...supporters.map((s) => String(s.user_id)));
    }
    await notify(
      ctx.db,
      recipients,
      `proposal.${verdict}`,
      request.id,
      proposal.id,
      verdict === "accepted"
        ? `The requester confirmed a solution for "${request.title}". Check whether it also works for you.`
        : `The requester marked a proposal for "${request.title}" as ${verdict === "partial" ? "partially meeting" : "not meeting"} their needs.`,
    );
  }
  await audit(
    ctx,
    "solution.feedback",
    "solution",
    proposal.id,
    `${isOwner ? "Requester" : "Supporter"} verdict "${verdict}" on proposal ${proposal.id}`,
  );
  return {
    feedback_id: feedbackId,
    proposal_id: proposal.id,
    request_id: request.id,
    verdict,
    recorded_as: isOwner ? "requester" : "supporter",
    proposal_status: proposalStatus,
    request_status: requestStatus,
    message: isOwner
      ? verdict === "accepted"
        ? "Recorded. The request is now resolved."
        : "Recorded. The request stays open for other proposals."
      : "Recorded as your individual feedback. Only the original requester's acceptance resolves the request.",
  };
}

export async function withdrawProposal(ctx: Ctx, input: unknown, opts: WriteOptions) {
  const actor = requireActor(ctx);
  const v = new Validator(input);
  const proposalId = v.str("proposal_id", { required: true, max: 80 });
  v.done();
  const proposal = await loadProposal(ctx, proposalId!);
  if (proposal.proposed_by !== actor.id) {
    throw new GitdexError("FORBIDDEN", "Only the proposer can withdraw this proposal.");
  }
  if (proposal.status === "withdrawn") throw new GitdexError("INVALID_STATE", "This proposal is already withdrawn.");
  if (proposal.status === "accepted") {
    throw new GitdexError("INVALID_STATE", "An accepted proposal cannot be withdrawn; it resolved the request.");
  }
  if (!opts.confirmed) {
    throw new GitdexError("CONFIRMATION_REQUIRED", "Ask the user to confirm withdrawing this proposal.", {
      preview: { proposal_id: proposal.id, request_id: proposal.request_id, status_after: "withdrawn" },
      user_prompt: "Withdraw this proposal? It will no longer be shown on the request.",
    });
  }
  await ctx.db.query(`update solution_proposals set status = 'withdrawn', updated_at = now() where id = $1::text`, [
    proposal.id,
  ]);
  const requestStatus = await recomputeRequestStatus(ctx, proposal.request_id);
  await audit(ctx, "solution.withdrawn", "solution", proposal.id, `Withdrew proposal ${proposal.id}`);
  return { proposal_id: proposal.id, status: "withdrawn", request_status: requestStatus };
}

/**
 * Edits a proposal. Only its proposer may, and only until someone has recorded
 * a verdict on it: a verdict must keep referring to the text that was judged.
 * The replaced version stays in the history.
 */
export async function updateSolution(ctx: Ctx, input: unknown, opts: WriteOptions) {
  requireActor(ctx);
  const v = new Validator(input);
  const id = v.str("proposal_id", { required: true, max: 80 });
  const note = v.str("change_note", { max: 300 });
  const has = (field: string) => v.input[field] !== undefined;
  if (!id) v.done();

  // deno-lint-ignore no-explicit-any
  const current = await one<Record<string, any>>(
    ctx.db,
    `select sp.id, sp.request_id, sp.proposed_by, sp.status, sp.coverage_notes, sp.unmet_requirements, sp.language,
       sp.translations, sp.evidence_refs, sp.version, sp.created_at, sp.updated_at,
       (select count(*)::int from acceptance_feedback f where f.proposal_id = sp.id) as verdicts
     from solution_proposals sp where sp.id = $1::text`,
    [id],
  );
  if (!current) throw new GitdexError("NOT_FOUND", `No solution proposal found for "${id}".`);
  requireAuthor(ctx, String(current.proposed_by));
  const request = await loadRequest(ctx, String(current.request_id));
  if (current.status !== "proposed" || Number(current.verdicts) > 0) {
    throw new GitdexError(
      "INVALID_STATE",
      current.status === "proposed"
        ? "A verdict has already been recorded on this proposal, so its text can no longer change. Withdraw it and propose again instead."
        : `This proposal is ${current.status} and can no longer be edited.`,
    );
  }

  // deno-lint-ignore no-explicit-any
  const next: Record<string, any> = {
    coverage_notes: has("coverage_notes")
      ? v.str("coverage_notes", { required: true, min: 10, max: 2000 })
      : current.coverage_notes,
    unmet_requirements: has("unmet_requirements")
      ? v.list("unmet_requirements", { maxItems: 20, maxLen: 300 })
      : current.unmet_requirements,
  };
  const text = { ...next };
  next.evidence_refs = has("evidence") ? parseSources(v, "evidence") : current.evidence_refs;
  const textChanged = changedFields("solution", current, { ...current, ...text }).length > 0;
  next.language = textChanged || has("language") ? parseLanguage(v, "solution", text) : current.language;
  next.translations = textChanged || has("translations")
    ? parseTranslations(v, "solution", next.language as Language, text)
    : current.translations;
  v.done();

  const changed = changedFields("solution", current, next);
  if (!changed.length) throw new GitdexError("INVALID_STATE", "The proposal already has these values; nothing to change.");
  const version = Number(current.version) + 1;

  if (!opts.confirmed) {
    throw new GitdexError(
      "CONFIRMATION_REQUIRED",
      "Show the user exactly what will change and get explicit approval before editing.",
      {
        preview: {
          will_be_public: { proposal_id: current.id, version, ...pick(next, changed), change_note: note },
          replaces: pick(current, changed),
          status_after_edit: "proposed",
          history: `Version ${current.version} stays publicly visible in the proposal's history.`,
        },
        ...translationHint(next.language as Language, next.translations),
        user_prompt: "This edit will be shown publicly on GitDex. It does not mark the request as resolved.",
      },
    );
  }

  await saveRevision(ctx, "solution", current as never, note);
  await ctx.db.query(
    `update solution_proposals set coverage_notes = $2::text, unmet_requirements = ${textArray(3)},
       language = $4::text, translations = $5::text::jsonb, version = $6::int, evidence_refs = $7::text::jsonb,
       updated_at = now()
     where id = $1::text`,
    [
      current.id,
      next.coverage_notes,
      JSON.stringify(next.unmet_requirements),
      next.language,
      JSON.stringify(next.translations),
      version,
      JSON.stringify(next.evidence_refs),
    ],
  );
  if (changed.includes("evidence_refs")) {
    await replaceOwnEvidence(ctx, "solution", current.id, next.evidence_refs, `Coverage of request ${request.id}`);
  }
  if (request.owner.id !== ctx.actor?.id) {
    await notify(
      ctx.db,
      [request.owner.id],
      "proposal.updated",
      request.id,
      current.id,
      `A proposed solution for "${request.title}" was edited by its proposer.`,
    );
  }
  await audit(ctx, "solution.updated", "solution", current.id, `Edited proposal ${current.id} to version ${version} (${changed.join(", ")})`);
  return {
    proposal_id: current.id,
    version,
    changed,
    status: "proposed",
    url: `${ctx.baseUrl}/solutions/${current.id}`,
    message: `Edit published as version ${version}. Version ${current.version} remains visible in the history. The request is not resolved by this.`,
  };
}

export async function getSolution(ctx: Ctx, input: unknown) {
  const v = new Validator(input);
  const id = v.str("proposal_id", { required: true, max: 80 });
  v.done();
  const solution = await one<Record<string, unknown> & { request: { id: string }; proposed_by: { id: string } }>(
    ctx.db,
    `select sp.id, sp.status, sp.coverage_notes, sp.unmet_requirements, sp.language, sp.translations, sp.version,
       sp.evidence_refs, sp.created_at, sp.updated_at,
       jsonb_build_object('id', r.id, 'title', r.title, 'status', r.status, 'must_have', r.must_have,
         'language', r.language, 'translations', r.translations,
         'owner_id', r.owner_user_id, 'resolved_proposal_id', r.resolved_proposal_id) as request,
       jsonb_build_object('id', s.id, 'slug', s.slug, 'name', s.name, 'canonical_url', s.canonical_url,
         'icon_url', s.icon_url, 'description', s.description, 'language', s.language, 'translations', s.translations,
         'platforms', s.platforms, 'pricing_type', s.pricing_type,
         'review_status', s.review_status) as software,
       jsonb_build_object('id', pp.id, 'display_name', pp.display_name) as proposed_by
     from solution_proposals sp
     join requests r on r.id = sp.request_id
     join software s on s.id = sp.software_id
     join profiles pp on pp.id = sp.proposed_by
     where sp.id = $1::text and r.visibility = 'public' and r.status <> 'removed' and s.review_status <> 'removed'`,
    [id],
  );
  if (!solution) throw new GitdexError("NOT_FOUND", `No solution proposal found for "${id}".`);
  const feedback = await rows(
    ctx.db,
    `select f.verdict, f.feedback, f.is_owner, f.updated_at,
       jsonb_build_object('id', p.id, 'display_name', p.display_name) as user
     from acceptance_feedback f join profiles p on p.id = f.user_id
     where f.proposal_id = $1::text order by f.is_owner desc, f.updated_at desc limit 100`,
    [id],
  );
  let viewer: Record<string, unknown> | null = null;
  if (ctx.actor) {
    const request = solution.request as { id: string; owner_id: string };
    const interest = await ctx.db.query(
      `select 1 as x from interests where user_id = $1::uuid and request_id = $2::text`,
      [ctx.actor.id, request.id],
    );
    viewer = {
      is_requester: request.owner_id === ctx.actor.id,
      is_supporter: interest.length > 0,
      is_proposer: solution.proposed_by.id === ctx.actor.id,
    };
  }
  return {
    solution: { ...solution, url: `${ctx.baseUrl}/solutions/${id}` },
    feedback,
    viewer,
    notice:
      "status 'proposed' means awaiting evaluation, not resolved. Only feedback with is_owner=true comes from the original requester. " +
      CONTENT_NOTICE,
  };
}
