// Input validation and normalization. Pure functions, no I/O.

import { GitdexError } from "./errors.ts";

export type Input = Record<string, unknown>;

export interface FieldIssue {
  field: string;
  issue: string;
}

/** Collects field problems so a caller gets every issue in one response. */
export class Validator {
  input: Input;
  issues: FieldIssue[] = [];

  constructor(input: unknown) {
    this.input = input && typeof input === "object" && !Array.isArray(input) ? (input as Input) : {};
  }

  fail(field: string, issue: string): void {
    this.issues.push({ field, issue });
  }

  str(field: string, opts: { required?: boolean; min?: number; max: number }): string | null {
    const raw = this.input[field];
    if (raw === undefined || raw === null || raw === "") {
      if (opts.required) this.fail(field, "required");
      return null;
    }
    if (typeof raw !== "string") {
      this.fail(field, "must be a string");
      return null;
    }
    const value = cleanText(raw);
    if (!value) {
      if (opts.required) this.fail(field, "required");
      return null;
    }
    if (opts.min && value.length < opts.min) this.fail(field, `must be at least ${opts.min} characters`);
    if (value.length > opts.max) this.fail(field, `must be at most ${opts.max} characters`);
    return value;
  }

  list(field: string, opts: { required?: boolean; maxItems: number; maxLen: number; lower?: boolean }): string[] {
    let raw = this.input[field];
    if (raw === undefined || raw === null || raw === "") {
      if (opts.required) this.fail(field, "required (at least one item)");
      return [];
    }
    // REST query strings deliver lists as "a,b"
    if (typeof raw === "string") raw = raw.split(",");
    if (!Array.isArray(raw)) {
      this.fail(field, "must be an array of strings");
      return [];
    }
    const out: string[] = [];
    for (const item of raw) {
      if (typeof item !== "string") {
        this.fail(field, "must be an array of strings");
        return [];
      }
      let value = cleanText(item);
      if (!value) continue;
      if (opts.lower) value = value.toLowerCase();
      if (value.length > opts.maxLen) {
        this.fail(field, `each item must be at most ${opts.maxLen} characters`);
        return [];
      }
      if (!out.includes(value)) out.push(value);
    }
    if (out.length > opts.maxItems) this.fail(field, `at most ${opts.maxItems} items`);
    if (opts.required && out.length === 0) this.fail(field, "required (at least one item)");
    return out;
  }

  oneOf<T extends string>(field: string, allowed: readonly T[], opts: { required?: boolean } = {}): T | null {
    const raw = this.input[field];
    if (raw === undefined || raw === null || raw === "") {
      if (opts.required) this.fail(field, `required (one of: ${allowed.join(", ")})`);
      return null;
    }
    if (typeof raw !== "string" || !allowed.includes(raw as T)) {
      this.fail(field, `must be one of: ${allowed.join(", ")}`);
      return null;
    }
    return raw as T;
  }

  int(field: string, opts: { min: number; max: number; fallback: number }): number {
    const raw = this.input[field];
    if (raw === undefined || raw === null || raw === "") return opts.fallback;
    const value = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(value) || value < opts.min || value > opts.max) {
      this.fail(field, `must be an integer between ${opts.min} and ${opts.max}`);
      return opts.fallback;
    }
    return value;
  }

  bool(field: string): boolean | null {
    const raw = this.input[field];
    if (raw === undefined || raw === null || raw === "") return null;
    if (raw === true || raw === "true") return true;
    if (raw === false || raw === "false") return false;
    this.fail(field, "must be true or false");
    return null;
  }

  url(field: string, opts: { required?: boolean } = {}): NormalizedUrl | null {
    const raw = this.input[field];
    if (raw === undefined || raw === null || raw === "") {
      if (opts.required) this.fail(field, "required");
      return null;
    }
    if (typeof raw !== "string") {
      this.fail(field, "must be a URL string");
      return null;
    }
    const result = normalizeUrl(raw);
    if (typeof result === "string") {
      this.fail(field, result);
      return null;
    }
    return result;
  }

  done(): void {
    if (this.issues.length) {
      throw new GitdexError("VALIDATION_FAILED", "Some fields are invalid.", { fields: this.issues });
    }
  }
}

/** Trim, collapse whitespace runs, and strip control characters. */
export function cleanText(value: string): string {
  // deno-lint-ignore no-control-regex
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/[ \t]+/g, " ").trim();
}

export interface NormalizedUrl {
  /** Cleaned URL for display and linking. */
  url: string;
  /** host + path identity used for de-duplication. */
  key: string;
  host: string;
  /** owner/repo identity when the URL points at a known code host. */
  repoKey: string | null;
}

const REPO_HOSTS = ["github.com", "gitlab.com", "codeberg.org", "bitbucket.org"];
const BLOCKED_HOST_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home", ".test", ".example", ".invalid"];

/**
 * Validates and normalizes a public http(s) URL. Returns an error message
 * string when the URL must be rejected. The server never fetches these URLs;
 * the checks keep obviously unsafe or non-public links out of the directory.
 */
export function normalizeUrl(raw: string): NormalizedUrl | string {
  const text = raw.trim();
  if (text.length > 500) return "URL is too long";
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return "must be a valid absolute URL";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "must be an http(s) URL";
  if (parsed.username || parsed.password) return "must not contain credentials";
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".")) return "must be a public hostname";
  if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) return "must be a public hostname";
  if (/^[0-9.]+$/.test(host) || host.includes(":") || host.startsWith("[")) return "IP addresses are not allowed";

  const bareHost = host.replace(/^www\./, "");
  let path = parsed.pathname.replace(/\/+/g, "/").replace(/\/$/, "");
  let repoKey: string | null = null;
  if (REPO_HOSTS.includes(bareHost)) {
    const parts = path.split("/").filter(Boolean);
    if (parts.length >= 2) {
      const repo = parts[1].replace(/\.git$/i, "");
      repoKey = `${bareHost}/${parts[0]}/${repo}`.toLowerCase();
      path = `/${parts[0]}/${repo}`;
    }
  }
  const key = repoKey ?? `${bareHost}${path}`.toLowerCase();
  const port = parsed.port ? `:${parsed.port}` : "";
  const url = `https://${host}${port}${repoKey ? path : parsed.pathname.replace(/\/$/, "")}${repoKey ? "" : parsed.search}`;
  return { url, key, host: bareHost, repoKey };
}

/**
 * A public https image URL, kept exactly as given (unlike a product URL it is
 * not reduced to a site or repository identity). The server never fetches it.
 */
export function imageUrl(raw: unknown): string | { error: string } {
  if (typeof raw !== "string") return { error: "must be a URL string" };
  const checked = normalizeUrl(raw);
  if (typeof checked === "string") return { error: checked };
  const parsed = new URL(raw.trim());
  if (parsed.protocol !== "https:") return { error: "must be an https URL" };
  return `https://${parsed.host.toLowerCase()}${parsed.pathname}${parsed.search}`;
}

export const STORES = ["app_store", "google_play"] as const;
export type Store = (typeof STORES)[number];

/**
 * The address of a product's own listing in a store, reduced to the store's
 * canonical form. The page puts the store's badge on this link, so nothing but
 * the store's own host and listing path is accepted, and campaign parameters
 * are dropped.
 */
export function storeUrl(raw: unknown, store: Store): string | { error: string } {
  if (typeof raw !== "string") return { error: "must be a URL string" };
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { error: "must be a valid URL" };
  }
  const plain = parsed.protocol === "https:" && !parsed.port && !parsed.username && !parsed.password;
  const host = parsed.hostname.toLowerCase();
  if (store === "app_store") {
    // /us/app/some-name/id123456789, with or without the country and the name
    const path = parsed.pathname.replace(/\/$/, "");
    if (!plain || host !== "apps.apple.com" || path.length > 300 || !/^(\/[a-z]{2}(-[a-z]{2,4})?)?\/app(\/[^/]+)?\/id\d{1,20}$/i.test(path)) {
      return { error: "must be an App Store listing: https://apps.apple.com/<country>/app/<name>/id<number>" };
    }
    return `https://apps.apple.com${path}`;
  }
  const id = parsed.searchParams.get("id") ?? "";
  if (
    !plain || host !== "play.google.com" || parsed.pathname !== "/store/apps/details" ||
    id.length > 150 || !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(id)
  ) {
    return { error: "must be a Google Play listing: https://play.google.com/store/apps/details?id=<package>" };
  }
  return `https://play.google.com/store/apps/details?id=${id}`;
}

const STOPWORDS = new Set([
  "a", "an", "the", "for", "to", "of", "and", "or", "with", "that", "in", "on", "is", "it", "my", "me",
  "app", "apps", "software", "tool", "tools", "need", "want", "find", "looking",
]);

/** Splits a free-text query into at most 8 lowercase keyword terms. */
export function searchTerms(query: string | null): string[] {
  if (!query) return [];
  const terms: string[] = [];
  for (const piece of query.toLowerCase().split(/[\s,.;:!?()[\]{}"'`/\\|<>]+/)) {
    if (!piece || STOPWORDS.has(piece) || terms.includes(piece)) continue;
    terms.push(piece.slice(0, 40));
    if (terms.length === 8) break;
  }
  return terms;
}

export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** The Latin letters and digits of `name` as a URL slug; empty when it has none (a Chinese name, say). */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
}

/**
 * The slug a new software record asks for: its name, or, for a name with no
 * Latin letters or digits, its Google Play package or App Store id. The caller
 * still makes it unique.
 */
export function softwareSlug(
  name: string,
  stores: { app_store_url: string | null; google_play_url: string | null },
): string {
  const fromName = slugify(name);
  if (fromName) return fromName;
  const pkg = stores.google_play_url ? new URL(stores.google_play_url).searchParams.get("id") : null;
  if (pkg) return slugify(pkg);
  const appId = stores.app_store_url?.match(/\/id(\d+)$/)?.[1];
  if (appId) return `app-${appId}`;
  return "software";
}

export function searchText(parts: (string | null | string[])[]): string {
  return parts
    .flatMap((p) => (Array.isArray(p) ? p : p ? [p] : []))
    .join(" \n ")
    .toLowerCase();
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Deterministic JSON for idempotency hashing. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
