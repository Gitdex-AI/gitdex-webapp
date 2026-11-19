// Adding or replacing the other-language version of a record its author
// already published. Only the free-text fields are translatable; the record's
// own text, status and relationships are never changed here.

import { audit, type Ctx, privacyWarnings, requireActor } from "./common.ts";
import { one } from "./db.ts";
import { GitdexError } from "./errors.ts";
import {
  type Language,
  parseTranslations,
  TRANSLATABLE,
  TRANSLATABLE_ENTITIES,
  type TranslatableEntity,
  type Translations,
  translationTexts,
} from "./languages.ts";
import { loadRequest, requestSearchText } from "./requests.ts";
import { softwareSearchText, type WriteOptions } from "./software.ts";
import { Validator } from "./validate.ts";

interface Target {
  id: string;
  authorId: string;
  label: string;
  language: Language;
  translations: Translations;
  /** The whole row: the original text to mirror, and what the search text is built from. */
  // deno-lint-ignore no-explicit-any
  row: Record<string, any>;
  url: string;
}

async function loadTarget(ctx: Ctx, entity: TranslatableEntity, id: string): Promise<Target> {
  // deno-lint-ignore no-explicit-any
  let row: Record<string, any> | null;
  let authorId: string;
  let label: string;
  let url: string;
  if (entity === "software") {
    row = await one(
      ctx.db,
      `select s.id, s.slug, s.name, s.canonical_url, s.description, s.capabilities, s.platforms, s.category,
         s.pricing_type, s.pricing_notes, s.license, s.screenshots, s.language, s.translations, s.submitted_by
       from software s where (s.id = $1::text or s.slug = $1::text) and s.review_status <> 'removed'`,
      [id],
    );
    if (!row) throw new GitdexError("NOT_FOUND", `No software found for "${id}".`);
    authorId = String(row.submitted_by);
    label = String(row.name);
    url = `${ctx.baseUrl}/software/${row.slug}`;
  } else if (entity === "request") {
    const request = await loadRequest(ctx, id);
    row = request;
    authorId = request.owner.id;
    label = request.title;
    url = `${ctx.baseUrl}/requests/${request.id}`;
  } else {
    row = await one(
      ctx.db,
      `select sp.id, sp.status, sp.coverage_notes, sp.unmet_requirements, sp.language, sp.translations, sp.proposed_by
       from solution_proposals sp where sp.id = $1::text`,
      [id],
    );
    if (!row) throw new GitdexError("NOT_FOUND", `No solution proposal found for "${id}".`);
    if (row.status === "withdrawn") throw new GitdexError("INVALID_STATE", "This proposal was withdrawn.");
    authorId = String(row.proposed_by);
    label = `proposal ${row.id}`;
    url = `${ctx.baseUrl}/solutions/${row.id}`;
  }
  return {
    id: String(row.id),
    authorId,
    label,
    language: row.language as Language,
    translations: (row.translations ?? {}) as Translations,
    row,
    url,
  };
}

export async function setTranslations(ctx: Ctx, input: unknown, opts: WriteOptions) {
  const actor = requireActor(ctx);
  const v = new Validator(input);
  const entity = v.oneOf("entity_type", TRANSLATABLE_ENTITIES, { required: true });
  const entityId = v.str("entity_id", { required: true, max: 80 });
  if (v.input.translations === undefined || v.input.translations === null) v.fail("translations", "required");
  if (!entity || !entityId) v.done();

  const target = await loadTarget(ctx, entity!, entityId!);
  // Checked before validation so a stranger learns nothing but "not yours".
  if (target.authorId !== actor.id && !actor.isAdmin) {
    throw new GitdexError("FORBIDDEN", "Only the user who published this record can add or change its translations.");
  }
  const incoming = parseTranslations(v, entity!, target.language, target.row);
  v.done();
  if (!Object.keys(incoming).length) {
    throw new GitdexError("VALIDATION_FAILED", "Some fields are invalid.", {
      fields: [{ field: "translations", issue: "must contain at least one language version" }],
    });
  }
  const merged: Translations = { ...target.translations, ...incoming };

  if (!opts.confirmed) {
    const original: Record<string, unknown> = { language: target.language };
    for (const spec of TRANSLATABLE[entity!]) original[spec.name] = target.row[spec.name];
    throw new GitdexError(
      "CONFIRMATION_REQUIRED",
      "Show the user the translation next to the original and get explicit approval before publishing it.",
      {
        preview: {
          will_be_public: { entity_type: entity, entity_id: target.id, original, translations: incoming },
          replaces_existing: Object.keys(incoming).filter((code) => code in target.translations),
          published_as: actor.displayName,
        },
        privacy_warnings: privacyWarnings(translationTexts(incoming)),
        user_prompt: "This translation will be shown publicly on GitDex under your name. Please confirm it says the same as the original.",
      },
    );
  }

  const json = JSON.stringify(merged);
  if (entity === "software") {
    await ctx.db.query(
      `update software set translations = $2::text::jsonb, search_text = $3::text, updated_at = now() where id = $1::text`,
      // deno-lint-ignore no-explicit-any
      [target.id, json, softwareSearchText({ ...(target.row as any), translations: merged })],
    );
  } else if (entity === "request") {
    await ctx.db.query(
      `update requests set translations = $2::text::jsonb, search_text = $3::text, updated_at = now() where id = $1::text`,
      // deno-lint-ignore no-explicit-any
      [target.id, json, requestSearchText({ ...(target.row as any), translations: merged })],
    );
  } else {
    await ctx.db.query(
      `update solution_proposals set translations = $2::text::jsonb, updated_at = now() where id = $1::text`,
      [target.id, json],
    );
  }
  await audit(
    ctx,
    "translations.set",
    entity!,
    target.id,
    `Set ${Object.keys(incoming).join(", ")} translation of ${entity} "${target.label}"`,
  );
  return {
    entity_type: entity,
    entity_id: target.id,
    language: target.language,
    translations: merged,
    url: target.url,
    message: "Translation published. Visitors reading in that language now see it instead of the original.",
  };
}
