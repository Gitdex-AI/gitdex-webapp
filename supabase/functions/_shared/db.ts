// Minimal database port so the domain services run unchanged on postgres.js
// (Supabase Edge Functions) and PGlite (tests).
//
// Conventions that keep both drivers behaving identically:
//   - params are only string | number | boolean | null
//   - every param is cast explicitly in SQL ($1::text, $2::int, ...)
//   - arrays/objects travel as JSON text and are cast with $n::text::jsonb
//   - rows come back as one jsonb column named "row" (see `rows`)

export type Param = string | number | boolean | null;

export interface Db {
  query(sql: string, params?: Param[]): Promise<Record<string, unknown>[]>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

/** Run `select to_jsonb(x) as row from (<inner>) x` and return the decoded rows. */
export async function rows<T>(db: Db, inner: string, params: Param[] = []): Promise<T[]> {
  const result = await db.query(`select to_jsonb(x) as row from (${inner}) x`, params);
  return result.map((r) => {
    const value = r.row;
    return (typeof value === "string" ? JSON.parse(value) : value) as T;
  });
}

export async function one<T>(db: Db, inner: string, params: Param[] = []): Promise<T | null> {
  const list = await rows<T>(db, inner, params);
  return list[0] ?? null;
}

/** SQL fragment turning a JSON-array text param into text[]. */
export function textArray(index: number): string {
  return `array(select jsonb_array_elements_text($${index}::text::jsonb))`;
}
