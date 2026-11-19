// Local verification of Supabase access tokens against the project's public
// signing keys (JWKS), so a request does not need a round trip to the Auth
// server. Web Crypto only: runs unchanged on Deno, Workers and Node.
//
// The verifier answers one of three ways:
//   - a claims object: the signature, issuer and expiry are all good
//   - "invalid": the token is definitely bad (forged, expired, wrong issuer)
//   - "unknown": it cannot tell (another algorithm, a key it cannot find, the
//     key set is unreachable) and the caller should ask the Auth server

export type JwtClaims = Record<string, unknown>;
export type JwtVerdict = JwtClaims | "invalid" | "unknown";

export interface JwtVerifierOptions {
  /** `${SUPABASE_URL}/auth/v1`: the expected `iss` and the base of the JWKS URL. */
  issuer: string;
  fetchJwks?: (url: string) => Promise<unknown>;
  now?: () => number;
  /** How long a fetched key set is trusted, in milliseconds. */
  cacheMs?: number;
  /** Minimum time between fetches when a token names a key that is not cached. */
  refetchMs?: number;
}

function base64UrlBytes(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function parseJson(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function defaultFetchJwks(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`JWKS ${response.status}`);
  return await response.json();
}

export function createJwtVerifier(options: JwtVerifierOptions): (token: string) => Promise<JwtVerdict> {
  const issuer = options.issuer.replace(/\/$/, "");
  const fetchJwks = options.fetchJwks ?? defaultFetchJwks;
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? 10 * 60_000;
  const refetchMs = options.refetchMs ?? 60_000;

  let keys = new Map<string, CryptoKey>();
  let fetchedAt = -Infinity;
  let pending: Promise<void> | null = null;

  async function load(): Promise<void> {
    const body = (await fetchJwks(`${issuer}/.well-known/jwks.json`)) as { keys?: unknown };
    const next = new Map<string, CryptoKey>();
    for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
      // Only ES256 public keys are used; anything else is left to the Auth server.
      if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.kid !== "string") continue;
      try {
        next.set(
          jwk.kid,
          await crypto.subtle.importKey(
            "jwk",
            { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
            { name: "ECDSA", namedCurve: "P-256" },
            false,
            ["verify"],
          ),
        );
      } catch {
        // A malformed key is skipped, not fatal.
      }
    }
    keys = next;
  }

  /** One fetch at a time; a failed fetch still counts against the refetch interval. */
  function refresh(): Promise<void> {
    pending ??= (async () => {
      fetchedAt = now();
      try {
        await load();
      } catch {
        // Keep whatever keys were cached; unknown tokens fall back to the Auth server.
      } finally {
        pending = null;
      }
    })();
    return pending;
  }

  async function keyFor(kid: string): Promise<CryptoKey | null> {
    const age = now() - fetchedAt;
    // Refresh a stale set, and look again (rate limited) for a key rotated in since the last fetch.
    if (age > cacheMs || (!keys.has(kid) && age > refetchMs)) await refresh();
    return keys.get(kid) ?? null;
  }

  return async function verify(token: string): Promise<JwtVerdict> {
    const parts = token.split(".");
    if (parts.length !== 3) return "invalid";
    let header: Record<string, unknown> | null;
    let claims: Record<string, unknown> | null;
    let signature: Uint8Array<ArrayBuffer>;
    try {
      header = parseJson(base64UrlBytes(parts[0]));
      claims = parseJson(base64UrlBytes(parts[1]));
      signature = base64UrlBytes(parts[2]);
    } catch {
      return "invalid";
    }
    if (!header || !claims) return "invalid";
    // The algorithm is fixed here and never taken from the token.
    if (header.alg !== "ES256" || typeof header.kid !== "string") return "unknown";

    const key = await keyFor(header.kid);
    if (!key) return "unknown";
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signature,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) return "invalid";

    if (typeof claims.exp !== "number" || claims.exp * 1000 <= now()) return "invalid";
    if (typeof claims.nbf === "number" && claims.nbf * 1000 > now() + 30_000) return "invalid";
    if (claims.iss !== issuer) return "invalid";
    return claims;
  };
}
