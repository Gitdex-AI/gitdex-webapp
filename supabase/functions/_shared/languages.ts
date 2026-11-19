// Two-language records. A record is written in one language and may carry the
// other one in `translations`; readers are shown exactly one version.
// Pure functions, shared by the services and by the web pages.

import { imageUrl, Validator } from "./validate.ts";

export const LANGUAGES = ["en", "zh"] as const;
export type Language = (typeof LANGUAGES)[number];

export const TRANSLATABLE_ENTITIES = ["software", "request", "solution"] as const;
export type TranslatableEntity = (typeof TRANSLATABLE_ENTITIES)[number];

export const MAX_SCREENSHOTS = 8;

type FieldSpec =
  | { name: string; kind: "text"; min?: number; max: number }
  | { name: string; kind: "list"; maxItems: number; maxLen: number }
  // Optional per-language images: a translation may bring its own, and falls back to the original's.
  | { name: string; kind: "images"; maxItems: number };

/** The free-text fields of each record type. Everything else is shared by all languages. */
export const TRANSLATABLE: Record<TranslatableEntity, FieldSpec[]> = {
  software: [
    { name: "description", kind: "text", min: 10, max: 2000 },
    { name: "capabilities", kind: "list", maxItems: 30, maxLen: 200 },
    { name: "pricing_notes", kind: "text", max: 500 },
    { name: "screenshots", kind: "images", maxItems: MAX_SCREENSHOTS },
  ],
  request: [
    { name: "title", kind: "text", min: 5, max: 140 },
    { name: "goal", kind: "text", min: 10, max: 2000 },
    { name: "must_have", kind: "list", maxItems: 20, maxLen: 300 },
    { name: "nice_to_have", kind: "list", maxItems: 20, maxLen: 300 },
    { name: "price_constraint", kind: "text", max: 300 },
    { name: "other_constraints", kind: "list", maxItems: 20, maxLen: 300 },
  ],
  solution: [
    { name: "coverage_notes", kind: "text", min: 10, max: 2000 },
    { name: "unmet_requirements", kind: "list", maxItems: 20, maxLen: 300 },
  ],
};

/** Fields whose text decides which language a version is written in. */
const MAIN_FIELDS: Record<TranslatableEntity, string[]> = {
  software: ["description"],
  request: ["title", "goal"],
  solution: ["coverage_notes"],
};

export type Translation = Record<string, string | string[]>;
export type Translations = Partial<Record<Language, Translation>>;
type Fields = Record<string, unknown>;

const HAN = /[㐀-鿿]/g;
const LATIN = /[a-z]/gi;

function counts(texts: unknown[]): { han: number; latin: number } {
  const text = texts.filter((t) => typeof t === "string").join(" ");
  return { han: text.match(HAN)?.length ?? 0, latin: text.match(LATIN)?.length ?? 0 };
}

/** Best guess for text that came without a declared language. */
export function detectLanguage(texts: unknown[]): Language {
  const { han, latin } = counts(texts);
  return han >= 2 && han * 4 >= latin ? "zh" : "en";
}

/**
 * Whether text can pass as the declared language. Deliberately lenient (Chinese
 * text is often full of Latin product names); it only catches a version that
 * is plainly in the other language, such as an untranslated copy.
 */
function readsAs(code: Language, texts: unknown[]): boolean {
  const { han, latin } = counts(texts);
  return code === "zh" ? han >= 2 : !(han >= 2 && han * 2 >= latin);
}

function mainTexts(entity: TranslatableEntity, fields: Fields): unknown[] {
  return MAIN_FIELDS[entity].map((name) => fields[name]);
}

/** The record's own language: the declared one, checked against the text, or detected. */
export function parseLanguage(v: Validator, entity: TranslatableEntity, fields: Fields): Language {
  const texts = mainTexts(entity, fields);
  const declared = v.oneOf("language", LANGUAGES);
  if (!declared) return detectLanguage(texts);
  if (!readsAs(declared, texts)) {
    v.fail("language", `is "${declared}" but the text is not written in it; set it to the language the fields are written in`);
  }
  return declared;
}

/**
 * Parses `translations`: { "<lang>": { <translatable fields> } }.
 * A translation must mirror the original: every text field the original has,
 * and every list with the same number of items, so a reader of either
 * language sees the same record.
 */
export function parseTranslations(v: Validator, entity: TranslatableEntity, language: Language, original: Fields): Translations {
  const raw = v.input.translations;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    v.fail("translations", 'must be an object keyed by language code, e.g. { "zh": { ... } }');
    return {};
  }
  const specs = TRANSLATABLE[entity];
  const names = specs.map((s) => s.name);
  const out: Translations = {};
  for (const [code, value] of Object.entries(raw as Record<string, unknown>)) {
    const at = `translations.${code}`;
    if (!(LANGUAGES as readonly string[]).includes(code)) {
      v.fail(at, `unsupported language; use one of: ${LANGUAGES.join(", ")}`);
      continue;
    }
    if (code === language) {
      v.fail(at, `"${code}" is the language the record itself is written in; translate into the other language`);
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      v.fail(at, `must be an object with: ${names.join(", ")}`);
      continue;
    }
    const tv = new Validator(value);
    const translation: Translation = {};
    for (const spec of specs) {
      const source = original[spec.name];
      if (spec.kind === "text") {
        const text = tv.str(spec.name, { min: spec.min, max: spec.max });
        if (source && !text) tv.fail(spec.name, "required: the original has this field");
        if (!source && text) tv.fail(spec.name, "the original has no such field; leave it out");
        if (text) translation[spec.name] = text;
      } else if (spec.kind === "images") {
        // Screenshots of the software in this language. Not mirrored: a product may have
        // localized screenshots for one language only, and any number of them.
        const raw = tv.input[spec.name];
        if (raw === undefined || raw === null) continue;
        if (!Array.isArray(raw)) {
          tv.fail(spec.name, "must be an array of image URLs");
          continue;
        }
        if (raw.length > spec.maxItems) tv.fail(spec.name, `at most ${spec.maxItems} items`);
        const urls: string[] = [];
        raw.slice(0, spec.maxItems).forEach((item, i) => {
          const result = imageUrl(item);
          if (typeof result !== "string") tv.fail(`${spec.name}[${i}]`, result.error);
          else if (!urls.includes(result)) urls.push(result);
        });
        if (urls.length) translation[spec.name] = urls;
      } else {
        const items = tv.list(spec.name, { maxItems: spec.maxItems, maxLen: spec.maxLen });
        const count = Array.isArray(source) ? source.length : 0;
        if (items.length !== count) {
          tv.fail(spec.name, `must have ${count} item(s): one per item of the original, in the same order`);
        }
        if (items.length) translation[spec.name] = items;
      }
    }
    for (const key of Object.keys(tv.input)) {
      if (!names.includes(key)) tv.fail(key, `is not a translatable field; translatable fields are: ${names.join(", ")}`);
    }
    if (!tv.issues.length && !readsAs(code as Language, mainTexts(entity, translation))) {
      tv.fail(MAIN_FIELDS[entity][0], `does not read as "${code}"; write this version in that language`);
    }
    for (const issue of tv.issues) v.fail(`${at}.${issue.field}`, issue.issue);
    out[code as Language] = translation;
  }
  return out;
}

/** Preview fields telling the caller which language version is still missing. */
export function translationHint(language: Language, translations: Translations): Record<string, unknown> {
  const missing = LANGUAGES.filter((code) => code !== language && !translations[code]);
  if (!missing.length) return {};
  return {
    missing_translations: missing,
    translation_notice:
      `This record has no ${missing.map((m) => `"${m}"`).join(", ")} version. GitDex shows each visitor one language. ` +
      `Add translations.${missing[0]} with the same fields (lists in the same order) and show the user both versions, unless they decline.`,
  };
}

/** Every translated string, for the keyword search column and the privacy check. */
export function translationTexts(translations: unknown): string[] {
  if (!translations || typeof translations !== "object") return [];
  return Object.values(translations as Record<string, Translation>).flatMap((t) =>
    Object.entries(t ?? {}).filter(([name]) => name !== "screenshots").flatMap(([, value]) => value)
  );
}

/**
 * The version of a record to show a reader of `lang`: the translation laid
 * over the original when there is one, otherwise the original.
 * `shown_language` says which one it is.
 */
// deno-lint-ignore no-explicit-any
export function localize<T extends Record<string, any>>(record: T, lang: string): T & { shown_language: string } {
  const own = typeof record.language === "string" ? record.language : "en";
  const translation = lang !== own ? record.translations?.[lang] : null;
  if (!translation || typeof translation !== "object") return { ...record, shown_language: own };
  return { ...record, ...translation, shown_language: lang };
}
