// Single registry of business operations. The REST adapter, the MCP adapter and
// the OpenAPI document are all generated from this list, so the three surfaces
// cannot drift apart (PRD 10.2).
//
// Every description follows PRD 7.1: when to use, what is needed, side effects,
// who may call, whether confirmation is required, and how to recover.

import {
  createToken,
  getMe,
  getMyActivity,
  getStats,
  listNotifications,
  listTokens,
  markNotificationsRead,
  reportContent,
  revokeToken,
  updateMe,
} from "./account.ts";
import type { Ctx } from "./common.ts";
import { LANGUAGES, TRANSLATABLE, TRANSLATABLE_ENTITIES, type TranslatableEntity } from "./languages.ts";
import {
  listReports,
  listSoftwareForReview,
  moderate,
  MODERATED_ENTITIES,
  MODERATION_ACTIONS,
  resolveReports,
  setUserStatus,
} from "./moderation.ts";
import {
  closeRequest,
  createRequest,
  getRequest,
  searchRequests,
  supportRequest,
  unsupportRequest,
  updateRequest,
} from "./requests.ts";
import { getProfile } from "./profiles.ts";
import { getHistory, VERSIONED_ENTITIES } from "./revisions.ts";
import {
  getSoftware,
  MAX_SCREENSHOTS,
  PRICING_TYPES,
  searchSoftware,
  submitSoftware,
  updateSoftware,
  type WriteOptions,
} from "./software.ts";
import { confirmSolution, getSolution, proposeSolution, updateSolution, withdrawProposal } from "./solutions.ts";
import { setTranslations } from "./translations.ts";

type Schema = Record<string, unknown>;

export interface Operation {
  name: string;
  title: string;
  description: string;
  access: "public" | "user";
  kind: "read" | "write";
  /** Write needs `confirmed: true`; without it the server returns a preview. */
  confirm: boolean;
  /** Write needs an idempotency key (header on REST, argument on MCP). */
  idempotent: boolean;
  /** Exposed as an MCP tool. Account plumbing stays REST/Web only. */
  mcp: boolean;
  /** Write that removes, replaces or irreversibly changes an existing record (MCP destructiveHint). */
  destructive?: boolean;
  /** Write whose text becomes visible to everyone on the public network (MCP openWorldHint). */
  publishes?: boolean;
  /** Moderator write: counted against the moderation allowance instead of the ordinary write limit. */
  moderation?: boolean;
  rest: { method: "GET" | "POST" | "PATCH" | "DELETE"; path: string };
  properties: Record<string, Schema>;
  required: string[];
  run(ctx: Ctx, input: Record<string, unknown>, opts: WriteOptions): Promise<unknown>;
}

const str = (description: string, extra: Schema = {}): Schema => ({ type: "string", description, ...extra });
const list = (description: string): Schema => ({ type: "array", items: { type: "string" }, description });
const limit: Schema = { type: "integer", minimum: 1, maximum: 50, default: 20, description: "Page size (max 50)." };
const offset: Schema = { type: "integer", minimum: 0, default: 0, description: "Items to skip; use next_offset from the previous page." };
const sources = (description: string): Schema => ({
  type: "array",
  description,
  items: {
    type: "object",
    properties: {
      url: str("Public http(s) URL of the source."),
      claim: str("What this source supports, in one sentence."),
      source_type: { type: "string", enum: ["official_site", "repository", "documentation", "store_listing", "review", "other"] },
      verification_level: {
        type: "string",
        enum: ["claimed", "documented", "unknown"],
        description:
          "claimed = the vendor says so; documented = stated in official docs/repo you actually read; unknown = not checked. 'tested' cannot be asserted by a submitter.",
      },
    },
    required: ["url"],
  },
});

const language: Schema = {
  type: "string",
  enum: [...LANGUAGES],
  description:
    "Language the text fields of this call are written in: 'en' or 'zh'. Write in the user's own language. Detected from the text when omitted.",
};

/** Schema of one language version: the translatable fields of a record type. */
function translationFields(entity: TranslatableEntity): Schema {
  const properties: Record<string, Schema> = {};
  for (const spec of TRANSLATABLE[entity]) {
    properties[spec.name] = spec.kind === "text"
      ? { type: "string", maxLength: spec.max }
      : spec.kind === "images"
      ? {
        type: "array",
        items: { type: "string" },
        maxItems: spec.maxItems,
        description:
          "OPTIONAL. Public https URLs of screenshots that show the software in THIS language. Only when such screenshots exist; leave out otherwise and readers of this language see the record's own screenshots.",
      }
      : { type: "array", items: { type: "string" }, description: "Same number of items as the original, in the same order." };
  }
  return { type: "object", properties, additionalProperties: false };
}

/** `translations` argument: the same record in the other language. */
function translations(entity: TranslatableEntity): Schema {
  const fields = TRANSLATABLE[entity].filter((s) => s.kind !== "images").map((s) => s.name).join(", ");
  const version = translationFields(entity);
  return {
    type: "object",
    description:
      `The same text in the other language, keyed by language code: { "zh": { ... } } for a record written in English, { "en": { ... } } for one written in Chinese. ALWAYS provide it unless the user declines: GitDex shows each visitor one language. Translate every one of these fields that the original has: ${fields}. Lists keep the same number of items in the same order. Translate faithfully; add no claims and drop no limits. Never mix two languages inside one field.`,
    properties: Object.fromEntries(LANGUAGES.map((code) => [code, version])),
    additionalProperties: false,
  };
}

const changeNote = str("One sentence saying what changed and why. Shown publicly in the record's history.", { maxLength: 300 });
const EDIT_RULES =
  "Send only the fields that change; everything else stays as it is. If any text field changes, the old translation no longer matches: send `translations` again for the other language or it is dropped. NOTHING IS ERASED: the version being replaced stays publicly visible in the record's history, so an edit cannot be used to hide what was published (to take down private or unlawful text, tell the user to report the record). FLOW: call WITHOUT confirmed to get the preview showing the new values next to the ones they replace, show it, get explicit approval, then call with confirmed=true and the same idempotency_key.";

export const CONFIRMED_SCHEMA: Schema = {
  type: "boolean",
  description:
    "Set true ONLY after the user has seen the exact preview returned by a call without it and explicitly approved. Never set it on your own initiative.",
};
export const IDEMPOTENCY_SCHEMA: Schema = {
  type: "string",
  minLength: 8,
  maxLength: 200,
  description:
    "Unique key for this intended write (e.g. a UUID). Reuse the SAME key when retrying the same write so it is applied once.",
};

export const OPERATIONS: Operation[] = [
  {
    name: "search_software",
    title: "Search software",
    description:
      "Search the GitDex software directory by keyword and static filters. USE WHEN the user is looking for software, or before submitting software to check for an existing record. NEEDS a short keyword query (product type, key capability), optionally platforms and pricing. Matching is plain keyword matching, not semantic: send the distinctive nouns, and try a second phrasing before concluding nothing fits. Records are in English, Chinese or both, and both versions are searched: if the user's language finds nothing, try the keywords in the other one. NO side effects; public, no sign-in. An empty result only means nothing has been submitted to GitDex yet, never that such software does not exist. Searching never implies the user wants to publish a request.",
    access: "public",
    kind: "read",
    confirm: false,
    idempotent: false,
    mcp: true,
    rest: { method: "GET", path: "/software" },
    properties: {
      query: str("Keywords, e.g. 'offline notes markdown'."),
      platforms: list("Match software available on any of these platforms, e.g. ['ios','web','macos','windows','linux','android','cli']."),
      pricing: { type: "array", items: { type: "string", enum: [...PRICING_TYPES] }, description: "Match any of these pricing types." },
      category: str("Exact category tag."),
      submitted_by: str("Only software submitted by this user: the `submitted_by.id` of a record. Lists one author's software."),
      sort: {
        type: "string",
        enum: ["relevance", "newest", "updated", "name", "solved"],
        default: "relevance",
        description:
          "'solved' puts first the software accepted by the most requesters (accepted_solution_count). That counts other people's needs, so still compare capabilities with this user's must-haves.",
      },
      limit,
      offset,
    },
    required: [],
    run: (ctx, input) => searchSoftware(ctx, input),
  },
  {
    name: "get_software",
    title: "Get software details",
    description:
      "Get one software record with its evidence and the requests it has been proposed for. USE WHEN you need details, sources or verification status for a software_id (or slug) from search results. NO side effects; public. Text fields come in the record's own `language`; `translations` holds the other language (English/Chinese) when the submitter provided it, so answer from the version in the user's language. Report unknown fields as unknown; 'unreviewed' records and 'claimed' evidence are not independently verified. Recovery: NOT_FOUND means the ID is wrong; search again.",
    access: "public",
    kind: "read",
    confirm: false,
    idempotent: false,
    mcp: true,
    rest: { method: "GET", path: "/software/{software_id}" },
    properties: { software_id: str("Software ID (sw_...) or slug.") },
    required: ["software_id"],
    run: (ctx, input) => getSoftware(ctx, input),
  },
  {
    name: "get_user",
    title: "Get a public author profile",
    description:
      "Get the public profile of someone who published on GitDex: their display name and how many software records and requests they published. USE WHEN the user asks who submitted a record or what else that author published; then list the records with search_software (submitted_by) or search_requests (requested_by). NEEDS user_id, the `submitted_by.id`, `owner.id` or `proposed_by.id` of a record. NO side effects; public; no confirmation. Returns nothing private: no email or sign-in details. A display name proves no identity. Recovery: NOT_FOUND means the id is wrong; take it from a record.",
    access: "public",
    kind: "read",
    confirm: false,
    idempotent: false,
    mcp: true,
    rest: { method: "GET", path: "/users/{user_id}" },
    properties: { user_id: str("User ID (UUID) from a record's submitted_by.id, owner.id or proposed_by.id.") },
    required: ["user_id"],
    run: (ctx, input) => getProfile(ctx, input),
  },
  {
    name: "search_requests",
    title: "Search requests",
    description:
      "Search public software requests. USE WHEN (a) a user is unsatisfied with existing software and you need to check for a similar request before creating one, or (b) a creator wants to discover demand to find or build software for. Optional keyword query, status and platform filters. NO side effects; public. Similar requests are suggestions: compare must_have constraints before treating two requests as the same need. A resolved request carries `resolved_by`, the software its requester accepted.",
    access: "public",
    kind: "read",
    confirm: false,
    idempotent: false,
    mcp: true,
    rest: { method: "GET", path: "/requests" },
    properties: {
      query: str("Keywords describing the need."),
      status: {
        type: "string",
        enum: ["active", "all", "open", "proposals_available", "resolved", "closed"],
        default: "active",
        description: "'active' = open + proposals_available.",
      },
      platform: str("Only requests targeting this platform, e.g. 'ios'."),
      requested_by: str("Only requests published by this user: the `owner.id` of a request."),
      sort: {
        type: "string",
        enum: ["relevance", "newest", "updated", "interest", "proposals"],
        default: "relevance",
        description: "'updated' = most recently changed first; with status 'resolved' that is the most recently resolved.",
      },
      limit,
      offset,
    },
    required: [],
    run: (ctx, input) => searchRequests(ctx, input),
  },
  {
    name: "get_request",
    title: "Get request details",
    description:
      "Get one request with its goal, must-have and nice-to-have constraints, interest count and all proposals. USE WHEN evaluating whether software satisfies a request, before proposing a solution, or before the requester records a verdict. NO side effects; public. interest_count is the requester plus supporters, not purchase intent. A proposal with status 'proposed' has not been accepted.",
    access: "public",
    kind: "read",
    confirm: false,
    idempotent: false,
    mcp: true,
    rest: { method: "GET", path: "/requests/{request_id}" },
    properties: { request_id: str("Request ID (req_...).") },
    required: ["request_id"],
    run: (ctx, input) => getRequest(ctx, input),
  },
  {
    name: "create_request",
    title: "Publish a software request",
    description:
      "Publish a NEW public software request. USE ONLY WHEN the user explicitly asked to publish a request AND has seen the public preview. A search, a question, or dissatisfaction with results is NOT consent to publish. NEEDS title, goal and at least one must_have; add platforms and price_constraint when known. Write the fields in the user's language and add the other language (English or Chinese) in `translations`, so the request is published in both. Write only what the user wants public: no names, contact details, account data, private code or conversation excerpts. SIDE EFFECT: creates a public record visible to everyone. REQUIRES sign-in. FLOW: call first WITHOUT confirmed to get the exact preview, privacy warnings and similar existing requests; if a similar request fits, offer support_request instead; otherwise show the preview (both language versions), get explicit approval, then call again with confirmed=true and the same idempotency_key. Recovery: VALIDATION_FAILED lists the fields to fix.",
    access: "user",
    kind: "write",
    confirm: true,
    idempotent: true,
    mcp: true,
    publishes: true,
    rest: { method: "POST", path: "/requests" },
    properties: {
      title: str("Short public title, e.g. 'Free iOS home inventory app'.", { minLength: 5, maxLength: 140 }),
      goal: str("The task the user wants to accomplish.", { minLength: 10, maxLength: 2000 }),
      must_have: list("Conditions that must all be met for the request to be solved."),
      nice_to_have: list("Optional preferences."),
      platforms: list("Target platforms, e.g. ['ios']."),
      price_constraint: str("Price limit in plain words, e.g. 'no recurring subscription'."),
      other_constraints: list("Other constraints such as offline use or privacy requirements."),
      language,
      translations: translations("request"),
    },
    required: ["title", "goal", "must_have"],
    run: (ctx, input, opts) => createRequest(ctx, input, opts),
  },
  {
    name: "support_request",
    title: "Support an existing request",
    description:
      "Add the user as a supporter (follower) of an existing request. USE WHEN the user agrees that an existing request matches their need, instead of publishing a duplicate. NEEDS request_id. SIDE EFFECT: increments the public interest count by at most one per user and subscribes the user to updates (set notifications_enabled=false to follow silently). REQUIRES sign-in and the user's agreement to support this specific request. Recovery: INVALID_STATE means the request is resolved/closed or the user owns it.",
    access: "user",
    kind: "write",
    confirm: false,
    idempotent: true,
    mcp: true,
    rest: { method: "POST", path: "/requests/{request_id}/support" },
    properties: {
      request_id: str("Request ID (req_...)."),
      notifications_enabled: { type: "boolean", default: true, description: "Receive updates about this request." },
    },
    required: ["request_id"],
    run: (ctx, input) => supportRequest(ctx, input),
  },
  {
    name: "submit_software",
    title: "Submit software to the directory",
    description:
      "Add a software record to the public directory. USE WHEN a creator (or a user) wants to list existing or newly built software and search_software found no record for it. NEEDS name, the official site or repository URL, and a factual description; add capabilities, platforms, pricing_type and sources when known. Write the text in the user's language and add the other language (English or Chinese) in `translations`, so the listing is published in both. Add icon_url and screenshots when the software has public images of its own; never invent, generate or borrow images. Leave unknown fields out or 'unknown'; never invent pricing, capabilities or verification. How the software was built (AI or not) is irrelevant. Submitting does not make the user the owner of the software. SIDE EFFECT: creates a public record with review_status 'unreviewed'. REQUIRES sign-in. FLOW: call WITHOUT confirmed to get the preview, show it (both language versions and the images), get explicit approval, then call with confirmed=true and the same idempotency_key. Recovery: DUPLICATE_CANDIDATE returns the existing record; use its software_id instead.",
    access: "user",
    kind: "write",
    confirm: true,
    idempotent: true,
    mcp: true,
    publishes: true,
    rest: { method: "POST", path: "/software" },
    properties: {
      name: str("Product name.", { minLength: 2, maxLength: 120 }),
      url: str("Official website or repository URL (public http/https)."),
      repository_url: str("Source repository URL, if any (GitHub, GitLab, Codeberg, Bitbucket)."),
      app_store_url: str(
        "The product's own App Store listing, if it has one: https://apps.apple.com/<country>/app/<name>/id<number>. Shown as the App Store badge. Only this app's listing; leave empty when unsure.",
      ),
      google_play_url: str(
        "The product's own Google Play listing, if it has one: https://play.google.com/store/apps/details?id=<package>. Shown as the Google Play badge. Only this app's listing; leave empty when unsure.",
      ),
      description: str("Factual description of what the software does.", { minLength: 10, maxLength: 2000 }),
      capabilities: list("Concrete capabilities, one per item."),
      platforms: list("Platforms it runs on, e.g. ['ios','web']."),
      pricing_type: str("Pricing model from the official site; use unknown when you could not confirm it.", { enum: [...PRICING_TYPES], default: "unknown" }),
      pricing_notes: str("Pricing details and limits in plain words."),
      license: str("License, if applicable, e.g. 'MIT'."),
      category: list("Category tags."),
      icon_url: str(
        "Public https URL of the product's own icon or logo (square works best), e.g. from its site, repository or store listing. Shown like an app icon. GitDex links to the image; it does not copy it.",
      ),
      screenshots: {
        type: "array",
        items: { type: "string" },
        maxItems: MAX_SCREENSHOTS,
        description:
          `Up to ${MAX_SCREENSHOTS} public https image URLs of real screenshots of this software, in display order. Use images the creator publishes; leave empty when there are none. These are the screenshots for the record's own language and the fallback for every reader; if the product also has screenshots in the other language, put those in translations.<lang>.screenshots.`,
      },
      language,
      translations: translations("software"),
      sources: sources("Where the listed facts come from."),
    },
    required: ["name", "url", "description"],
    run: (ctx, input, opts) => submitSoftware(ctx, input, opts),
  },
  {
    name: "propose_solution",
    title: "Propose software as a solution to a request",
    description:
      "Link a software record to a request as a candidate solution. USE WHEN a creator believes listed software satisfies a request, whether they found it or built it. NEEDS request_id, software_id (submit the software first if it has no record), coverage_notes explaining which must-haves are covered, and unmet_requirements listing every known gap honestly. Write them in the user's language and add the other language (English or Chinese) in `translations`; the translation must list the same gaps. SIDE EFFECT: creates a public proposal with status 'proposed' and notifies the requester and supporters. It does NOT resolve the request and you must not tell the user it did. REQUIRES sign-in. FLOW: call WITHOUT confirmed to get the preview, show it, get explicit approval, then call with confirmed=true and the same idempotency_key. Recovery: DUPLICATE_CANDIDATE means this software is already proposed for this request; INVALID_STATE means the request no longer accepts proposals.",
    access: "user",
    kind: "write",
    confirm: true,
    idempotent: true,
    mcp: true,
    publishes: true,
    rest: { method: "POST", path: "/solutions" },
    properties: {
      request_id: str("Request ID (req_...)."),
      software_id: str("Software ID (sw_...) or slug."),
      coverage_notes: str("How the software covers the request's must-haves.", { minLength: 10, maxLength: 2000 }),
      unmet_requirements: list("Requirements that are not met or not verified."),
      language,
      translations: translations("solution"),
      evidence: sources("Sources supporting the coverage claims."),
    },
    required: ["request_id", "software_id", "coverage_notes"],
    run: (ctx, input, opts) => proposeSolution(ctx, input, opts),
  },
  {
    name: "confirm_solution",
    title: "Record a verdict on a proposed solution",
    description:
      "Record whether a proposed solution meets the user's needs. USE ONLY WHEN the signed-in user is the original requester (or a supporter) of the request AND has told you their verdict in their own words after looking at or trying the software. verdict: 'accepted' = meets ALL must-haves, 'partial' = partly, 'rejected' = does not. Never infer acceptance from a click, from silence, or from the creator's claims. SIDE EFFECT: public feedback. Only the original requester's 'accepted' marks the request resolved; 'partial' and 'rejected' keep it open; a supporter's verdict is recorded as individual feedback and changes no status. A proposer cannot record a verdict on their own proposal. REQUIRES sign-in. FLOW: call WITHOUT confirmed to get the preview and effect, confirm with the user, then call with confirmed=true and the same idempotency_key. Recovery: FORBIDDEN means this user may not judge this proposal; do not retry.",
    access: "user",
    kind: "write",
    confirm: true,
    idempotent: true,
    mcp: true,
    destructive: true,
    publishes: true,
    rest: { method: "POST", path: "/solutions/{proposal_id}/confirm" },
    properties: {
      proposal_id: str("Proposal ID (sol_...)."),
      request_id: str("Request ID the proposal belongs to; checked for consistency when given."),
      verdict: str("The requester's decision: accepted resolves the request; partial or rejected keeps it open.", { enum: ["accepted", "partial", "rejected"] }),
      feedback: str("Optional public feedback explaining the verdict.", { maxLength: 2000 }),
    },
    required: ["proposal_id", "verdict"],
    run: (ctx, input, opts) => confirmSolution(ctx, input, opts),
  },
  {
    name: "get_my_activity",
    title: "Get my GitDex activity",
    description:
      "List the signed-in user's own requests, submitted software, proposals and followed requests. USE WHEN the user asks about their GitDex activity or you need their request/proposal IDs (e.g. to find proposals awaiting their verdict). NO side effects. REQUIRES sign-in; returns only the caller's own data.",
    access: "user",
    kind: "read",
    confirm: false,
    idempotent: false,
    mcp: true,
    rest: { method: "GET", path: "/me/activity" },
    properties: {
      type: str("Which of the user's items to list; all returns every kind.", { enum: ["all", "requests", "software", "proposals", "subscriptions"], default: "all" }),
      limit,
      offset,
    },
    required: [],
    run: (ctx, input) => getMyActivity(ctx, input),
  },
  {
    name: "get_solution",
    title: "Get solution proposal details",
    description:
      "Get one solution proposal with its request, software, and all recorded verdicts. USE WHEN showing a proposal to the requester before confirm_solution, or checking a proposal's acceptance status. NO side effects; public. Only feedback with is_owner=true is from the original requester.",
    access: "public",
    kind: "read",
    confirm: false,
    idempotent: false,
    mcp: true,
    rest: { method: "GET", path: "/solutions/{proposal_id}" },
    properties: { proposal_id: str("Proposal ID (sol_...).") },
    required: ["proposal_id"],
    run: (ctx, input) => getSolution(ctx, input),
  },
  {
    name: "withdraw_proposal",
    title: "Withdraw my proposal",
    description:
      "Withdraw a solution proposal the signed-in user made. USE WHEN the proposer explicitly asks to retract it. SIDE EFFECT: the proposal is hidden from the request. REQUIRES sign-in as the proposer and confirmed=true after the user agrees. Recovery: INVALID_STATE means it was already withdrawn or already accepted.",
    access: "user",
    kind: "write",
    confirm: true,
    idempotent: true,
    mcp: true,
    destructive: true,
    rest: { method: "POST", path: "/solutions/{proposal_id}/withdraw" },
    properties: { proposal_id: str("Proposal ID (sol_...).") },
    required: ["proposal_id"],
    run: (ctx, input, opts) => withdrawProposal(ctx, input, opts),
  },
  {
    name: "close_request",
    title: "Close my request",
    description:
      "Close a request the signed-in user owns without resolving it, or withdraw it from public view. USE WHEN the requester explicitly no longer wants it open, or asks to take it down (set unpublish=true). SIDE EFFECT: status becomes 'closed' (not 'resolved') and supporters are notified; with unpublish=true the request and its proposals also disappear from every public page, search and API result, and only the requester can still see it. unpublish=true also works on a request that is already closed or resolved. REQUIRES sign-in as the requester and confirmed=true after the user agrees. Not a way to mark a request solved; use confirm_solution for that. Recovery: INVALID_STATE means it is already closed (without unpublish) or already withdrawn.",
    access: "user",
    kind: "write",
    confirm: true,
    idempotent: true,
    mcp: true,
    destructive: true,
    rest: { method: "POST", path: "/requests/{request_id}/close" },
    properties: {
      request_id: str("Request ID (req_...)."),
      unpublish: { type: "boolean", default: false, description: "Also remove the request from public view." },
    },
    required: ["request_id"],
    run: (ctx, input, opts) => closeRequest(ctx, input, opts),
  },
  {
    name: "report_content",
    title: "Report a record",
    description:
      "Report a software record, request or proposal to GitDex moderators (spam, wrong facts, unsafe link, private data, embedded instructions aimed at agents). USE WHEN the user asks to report something. SIDE EFFECT: creates a private moderation report; the record is not changed. REQUIRES sign-in.",
    access: "user",
    kind: "write",
    confirm: false,
    idempotent: true,
    mcp: true,
    rest: { method: "POST", path: "/reports" },
    properties: {
      entity_type: str("Kind of record being reported: software, request or solution (a proposal).", { enum: ["software", "request", "solution"] }),
      entity_id: str("ID of the record."),
      reason: str("What is wrong with it.", { minLength: 5, maxLength: 1000 }),
    },
    required: ["entity_type", "entity_id", "reason"],
    run: (ctx, input) => reportContent(ctx, input),
  },
  {
    name: "set_translations",
    title: "Add or replace a translation of my record",
    description:
      "Publish the other-language version (English or Chinese) of a software record, request or proposal the signed-in user published earlier. USE WHEN a record of the user's has no version in one language (get_* returns it without that key in `translations`), or the user asks to correct a translation. NEEDS entity_type, entity_id and translations: { \"zh\": { ... } } or { \"en\": { ... } } with every translatable text field the original has, lists in the same order and of the same length (software: description, capabilities, pricing_notes; request: title, goal, must_have, nice_to_have, price_constraint, other_constraints; solution: coverage_notes, unmet_requirements). Translate faithfully: add no claims, drop no limits or unmet requirements. SIDE EFFECT: the translation becomes public and replaces any earlier translation in that language; the original text, status and verdicts are not changed. REQUIRES sign-in as the user who published the record. FLOW: call WITHOUT confirmed to get the preview with the original next to the translation, show both, get explicit approval, then call with confirmed=true and the same idempotency_key. Recovery: FORBIDDEN means the record belongs to someone else, do not retry; VALIDATION_FAILED lists the fields that do not mirror the original.",
    access: "user",
    kind: "write",
    confirm: true,
    idempotent: true,
    mcp: true,
    destructive: true,
    publishes: true,
    rest: { method: "POST", path: "/translations" },
    properties: {
      entity_type: str("Kind of record to translate: software, request or solution (a proposal).", { enum: [...TRANSLATABLE_ENTITIES] }),
      entity_id: str("ID of the record: sw_... (or slug), req_... or sol_...."),
      translations: {
        type: "object",
        description:
          "Language versions keyed by language code. The key must not be the language the record itself is written in.",
        properties: Object.fromEntries(
          LANGUAGES.map((code) => [code, { type: "object", description: "The translatable fields of this record type, translated." }]),
        ),
        additionalProperties: false,
      },
    },
    required: ["entity_type", "entity_id", "translations"],
    run: (ctx, input, opts) => setTranslations(ctx, input, opts),
  },
  {
    name: "update_software",
    title: "Edit my software record",
    description:
      "Change a software record the signed-in user submitted: name, description, capabilities, platforms, pricing, license, category, icon, screenshots, store listings or sources. USE WHEN the submitter asks to correct or update their listing (new version, new price, better screenshots). The site and repository URLs identify the record and cannot be changed. SIDE EFFECT: publishes a new version; a 'reviewed' record goes back to 'unreviewed' because no moderator has seen the new text. REQUIRES sign-in as the submitter. " +
      EDIT_RULES +
      " Recovery: FORBIDDEN means someone else submitted it, do not retry; INVALID_STATE means nothing would change.",
    access: "user",
    kind: "write",
    confirm: true,
    idempotent: true,
    mcp: true,
    destructive: true,
    publishes: true,
    rest: { method: "PATCH", path: "/software/{software_id}" },
    properties: {
      software_id: str("Software ID (sw_...) or slug."),
      name: str("Product name.", { minLength: 2, maxLength: 120 }),
      description: str("Factual description of what the software does.", { minLength: 10, maxLength: 2000 }),
      capabilities: list("Concrete capabilities, one per item. Replaces the whole list."),
      platforms: list("Platforms it runs on. Replaces the whole list."),
      pricing_type: str("New pricing model from the official site; use unknown when you could not confirm it.", { enum: [...PRICING_TYPES] }),
      pricing_notes: { type: ["string", "null"], description: "Pricing details in plain words; null removes them." },
      license: { type: ["string", "null"], description: "License; null removes it." },
      category: list("Category tags. Replaces the whole list."),
      icon_url: { type: ["string", "null"], description: "Public https URL of the product's own icon; null removes it." },
      app_store_url: {
        type: ["string", "null"],
        description: "The product's own App Store listing (https://apps.apple.com/<country>/app/<name>/id<number>); null removes it.",
      },
      google_play_url: {
        type: ["string", "null"],
        description: "The product's own Google Play listing (https://play.google.com/store/apps/details?id=<package>); null removes it.",
      },
      screenshots: {
        type: "array",
        items: { type: "string" },
        maxItems: MAX_SCREENSHOTS,
        description: "Public https image URLs in display order. Replaces the whole list; [] removes all.",
      },
      sources: sources(
        "Where the listed facts come from. Send it whenever the edit changes a fact (price, capability, license). Replaces the sources this user gave before; [] removes them.",
      ),
      language,
      translations: translations("software"),
      change_note: changeNote,
    },
    required: ["software_id"],
    run: (ctx, input, opts) => updateSoftware(ctx, input, opts),
  },
  {
    name: "update_request",
    title: "Edit my request",
    description:
      "Change a request the signed-in user published: title, goal, must_have, nice_to_have, platforms, price_constraint or other_constraints. USE WHEN the requester asks to correct or sharpen their request. Possible ONLY while the request is open and nobody has proposed a solution yet; after that its conditions are what proposers answered to, so the user must close it (close_request) and publish a new one. SIDE EFFECT: publishes a new version and notifies supporters. REQUIRES sign-in as the requester. " +
      EDIT_RULES +
      " Recovery: INVALID_STATE means it has proposals, is closed or resolved, or nothing would change; FORBIDDEN means it is someone else's request.",
    access: "user",
    kind: "write",
    confirm: true,
    idempotent: true,
    mcp: true,
    destructive: true,
    publishes: true,
    rest: { method: "PATCH", path: "/requests/{request_id}" },
    properties: {
      request_id: str("Request ID (req_...)."),
      title: str("Short public title.", { minLength: 5, maxLength: 140 }),
      goal: str("The task the user wants to accomplish.", { minLength: 10, maxLength: 2000 }),
      must_have: list("Conditions that must all be met. Replaces the whole list."),
      nice_to_have: list("Optional preferences. Replaces the whole list."),
      platforms: list("Target platforms. Replaces the whole list."),
      price_constraint: { type: ["string", "null"], description: "Price limit in plain words; null removes it." },
      other_constraints: list("Other constraints. Replaces the whole list."),
      language,
      translations: translations("request"),
      change_note: changeNote,
    },
    required: ["request_id"],
    run: (ctx, input, opts) => updateRequest(ctx, input, opts),
  },
  {
    name: "update_solution",
    title: "Edit my proposal",
    description:
      "Change the coverage_notes, unmet_requirements or evidence of a proposal the signed-in user made. USE WHEN the proposer asks to correct their proposal. Possible ONLY while it is 'proposed' and nobody has recorded a verdict on it; afterwards the verdict refers to that text, so the user must withdraw it (withdraw_proposal) and propose again. SIDE EFFECT: publishes a new version and notifies the requester. It never resolves the request. REQUIRES sign-in as the proposer. " +
      EDIT_RULES +
      " Recovery: INVALID_STATE means a verdict exists, the proposal is no longer 'proposed', or nothing would change; FORBIDDEN means it is someone else's proposal.",
    access: "user",
    kind: "write",
    confirm: true,
    idempotent: true,
    mcp: true,
    destructive: true,
    publishes: true,
    rest: { method: "PATCH", path: "/solutions/{proposal_id}" },
    properties: {
      proposal_id: str("Proposal ID (sol_...)."),
      coverage_notes: str("How the software covers the request's must-haves.", { minLength: 10, maxLength: 2000 }),
      unmet_requirements: list("Requirements that are not met or not verified. Replaces the whole list."),
      evidence: sources("Sources supporting the coverage claims. Replaces the evidence this user gave before; [] removes it."),
      language,
      translations: translations("solution"),
      change_note: changeNote,
    },
    required: ["proposal_id"],
    run: (ctx, input, opts) => updateSolution(ctx, input, opts),
  },
  {
    name: "get_history",
    title: "Get earlier versions of a record",
    description:
      "List what a software record, request or proposal said before each edit. USE WHEN a record's `version` is above 1 and the user asks what changed, or you need the text a verdict, proposal or earlier answer was based on. NEEDS entity_type and entity_id. NO side effects; public. Returns current_version and earlier_versions (newest first) with their content, when each was published and replaced, and the author's change note. Only the current record is in force. Recovery: NOT_FOUND means the record does not exist or is no longer public.",
    access: "public",
    kind: "read",
    confirm: false,
    idempotent: false,
    mcp: true,
    rest: { method: "GET", path: "/history" },
    properties: {
      entity_type: str("Kind of record whose history to list: software, request or solution (a proposal).", { enum: [...VERSIONED_ENTITIES] }),
      entity_id: str("ID of the record: sw_... (or slug), req_... or sol_...."),
    },
    required: ["entity_type", "entity_id"],
    run: (ctx, input) => getHistory(ctx, input),
  },

  // ---- REST/Web only ------------------------------------------------------
  {
    name: "unsupport_request",
    title: "Stop supporting a request",
    description: "Remove the signed-in user's support and subscription for a request.",
    access: "user",
    kind: "write",
    confirm: false,
    idempotent: false,
    mcp: false,
    rest: { method: "DELETE", path: "/requests/{request_id}/support" },
    properties: { request_id: str("Request ID (req_...).") },
    required: ["request_id"],
    run: (ctx, input) => unsupportRequest(ctx, input),
  },
  {
    name: "get_me",
    title: "Get my account",
    description: "The signed-in user's profile and notification preferences.",
    access: "user",
    kind: "read",
    confirm: false,
    idempotent: false,
    mcp: false,
    rest: { method: "GET", path: "/me" },
    properties: {},
    required: [],
    run: (ctx) => getMe(ctx),
  },
  {
    name: "update_me",
    title: "Update my account",
    description: "Change the public display name or notification preferences.",
    access: "user",
    kind: "write",
    confirm: false,
    idempotent: false,
    mcp: false,
    rest: { method: "PATCH", path: "/me" },
    properties: {
      display_name: str("Public display name.", { minLength: 2, maxLength: 60 }),
      notification_preferences: {
        type: "object",
        properties: { in_app: { type: "boolean" }, email: { type: "boolean" } },
        description: "Notification channels. Turning both off stops all notifications.",
      },
    },
    required: [],
    run: (ctx, input) => updateMe(ctx, input),
  },
  {
    name: "list_notifications",
    title: "List my notifications",
    description: "In-app notifications for the signed-in user, newest first.",
    access: "user",
    kind: "read",
    confirm: false,
    idempotent: false,
    mcp: false,
    rest: { method: "GET", path: "/me/notifications" },
    properties: { limit, offset },
    required: [],
    run: (ctx, input) => listNotifications(ctx, input),
  },
  {
    name: "mark_notifications_read",
    title: "Mark my notifications read",
    description: "Mark all of the signed-in user's notifications as read.",
    access: "user",
    kind: "write",
    confirm: false,
    idempotent: false,
    mcp: false,
    rest: { method: "POST", path: "/me/notifications/read" },
    properties: {},
    required: [],
    run: (ctx) => markNotificationsRead(ctx),
  },
  {
    name: "list_tokens",
    title: "List my API tokens",
    description: "Active personal API tokens (prefix only). Browser session required.",
    access: "user",
    kind: "read",
    confirm: false,
    idempotent: false,
    mcp: false,
    rest: { method: "GET", path: "/me/tokens" },
    properties: {},
    required: [],
    run: (ctx) => listTokens(ctx),
  },
  {
    name: "create_token",
    title: "Create an API token",
    description: "Create a personal API token for agents and scripts. The token is shown once. Browser session required.",
    access: "user",
    kind: "write",
    confirm: false,
    idempotent: false,
    mcp: false,
    rest: { method: "POST", path: "/me/tokens" },
    properties: { name: str("Label for the token, e.g. 'Claude Code'.", { maxLength: 60 }) },
    required: ["name"],
    run: (ctx, input) => createToken(ctx, input),
  },
  {
    name: "revoke_token",
    title: "Revoke an API token",
    description: "Revoke one of the signed-in user's API tokens. Browser session required.",
    access: "user",
    kind: "write",
    confirm: false,
    idempotent: false,
    mcp: false,
    rest: { method: "DELETE", path: "/me/tokens/{token_id}" },
    properties: { token_id: str("Token ID (tok_...).") },
    required: ["token_id"],
    run: (ctx, input) => revokeToken(ctx, input),
  },
  {
    name: "get_stats",
    title: "Public network stats",
    description: "Counts of listed software, open requests, proposals, and requester-verified resolved requests.",
    access: "public",
    kind: "read",
    confirm: false,
    idempotent: false,
    mcp: false,
    rest: { method: "GET", path: "/stats" },
    properties: {},
    required: [],
    run: (ctx) => getStats(ctx),
  },

  // ---- moderation: administrators only, browser session only, never MCP ----
  {
    name: "admin_list_reports",
    title: "List reports (moderators)",
    description:
      "Reports users filed about records, newest first, each with the reported record, its state and its author. Moderators only, from a browser session.",
    access: "user",
    kind: "read",
    confirm: false,
    idempotent: false,
    mcp: false,
    rest: { method: "GET", path: "/admin/reports" },
    properties: {
      status: { type: "string", enum: ["open", "actioned", "dismissed", "all"], default: "open" },
      limit,
      offset,
    },
    required: [],
    run: (ctx, input) => listReports(ctx, input),
  },
  {
    name: "admin_list_software",
    title: "List software for review (moderators)",
    description:
      "Software listings by review status, newest first, including flagged and removed ones, with the submitter and the number of open reports. Moderators only, from a browser session.",
    access: "user",
    kind: "read",
    confirm: false,
    idempotent: false,
    mcp: false,
    rest: { method: "GET", path: "/admin/software" },
    properties: {
      review_status: { type: "string", enum: ["unreviewed", "reviewed", "flagged", "removed", "all"], default: "unreviewed" },
      limit,
      offset,
    },
    required: [],
    run: (ctx, input) => listSoftwareForReview(ctx, input),
  },
  {
    name: "admin_moderate",
    title: "Moderate a record (moderators)",
    description:
      "Change the moderation state of a record. Software: mark_reviewed (a moderator looked and found no violation; not a verification of its claims), flag (adds a public warning), remove, restore, clear_images. Request: remove, restore. Solution: remove (also un-resolves the request if it was the accepted one). SIDE EFFECTS: settles the open reports about the record, notifies its author, is audited. Moderators only, from a browser session; requires confirmed=true after a preview.",
    access: "user",
    kind: "write",
    confirm: true,
    idempotent: true,
    mcp: false,
    moderation: true,
    rest: { method: "POST", path: "/admin/moderate" },
    properties: {
      entity_type: str("Kind of record to moderate.", { enum: [...MODERATED_ENTITIES] }),
      entity_id: str("ID of the record."),
      action: str("Moderation action allowed for that kind of record.", { enum: [...new Set(Object.values(MODERATION_ACTIONS).flat())] }),
      note: str("Optional note sent to the record's author with the notification.", { maxLength: 300 }),
    },
    required: ["entity_type", "entity_id", "action"],
    run: (ctx, input, opts) => moderate(ctx, input, opts),
  },
  {
    name: "admin_resolve_reports",
    title: "Settle reports about a record (moderators)",
    description:
      "Mark every open report about one record as dismissed or actioned without changing the record. Moderators only, from a browser session.",
    access: "user",
    kind: "write",
    confirm: false,
    idempotent: true,
    mcp: false,
    moderation: true,
    rest: { method: "POST", path: "/admin/reports/resolve" },
    properties: {
      entity_type: { type: "string", enum: [...MODERATED_ENTITIES] },
      entity_id: str("ID of the reported record."),
      resolution: { type: "string", enum: ["dismissed", "actioned"] },
    },
    required: ["entity_type", "entity_id", "resolution"],
    run: (ctx, input) => resolveReports(ctx, input),
  },
  {
    name: "admin_set_user_status",
    title: "Suspend or reinstate an account (moderators)",
    description:
      "Suspend an account (it can no longer sign in, write or use API tokens; its records stay until removed) or make it active again. A moderator cannot change their own account. Moderators only, from a browser session; requires confirmed=true after a preview.",
    access: "user",
    kind: "write",
    confirm: true,
    idempotent: true,
    mcp: false,
    moderation: true,
    rest: { method: "POST", path: "/admin/users/{user_id}/status" },
    properties: {
      user_id: str("User ID (UUID)."),
      status: { type: "string", enum: ["active", "suspended"] },
    },
    required: ["user_id", "status"],
    run: (ctx, input, opts) => setUserStatus(ctx, input, opts),
  },
];

export const MCP_TOOLS = OPERATIONS.filter((op) => op.mcp);

export function findOperation(name: string): Operation | undefined {
  return OPERATIONS.find((op) => op.name === name);
}

/** JSON Schema for the MCP tool input, including the confirmation and idempotency arguments. */
export function toolInputSchema(op: Operation): Schema {
  const properties: Record<string, Schema> = { ...op.properties };
  const required = [...op.required];
  if (op.confirm) properties.confirmed = CONFIRMED_SCHEMA;
  if (op.idempotent) {
    properties.idempotency_key = IDEMPOTENCY_SCHEMA;
    required.push("idempotency_key");
  }
  return { type: "object", properties, required, additionalProperties: false };
}
