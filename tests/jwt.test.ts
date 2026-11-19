// Local verification of Supabase access tokens: a good token is accepted
// without the Auth server, a bad one is refused, and anything the verifier
// cannot decide is handed back as "unknown".

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { createJwtVerifier } from "../supabase/functions/_shared/jwt.ts";

const ISSUER = "https://project.example.com/auth/v1";
const NOW = 1_800_000_000_000;

const b64url = (data: string | ArrayBuffer) =>
  Buffer.from(typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data)).toString("base64url");

interface Signer {
  kid: string;
  jwk: Record<string, unknown>;
  sign(claims: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
}

async function makeSigner(kid: string): Promise<Signer> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, alg: "ES256", use: "sig" };
  return {
    kid,
    jwk,
    async sign(claims, header = {}) {
      const body = `${b64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid, ...header }))}.${b64url(JSON.stringify(claims))}`;
      const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(body));
      return `${body}.${b64url(signature)}`;
    },
  };
}

const claims = (extra: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  sub: "11111111-1111-4111-8111-111111111111",
  role: "authenticated",
  exp: NOW / 1000 + 600,
  app_metadata: { provider: "github" },
  ...extra,
});

let signer: Signer;
let other: Signer;
before(async () => {
  signer = await makeSigner("key-1");
  other = await makeSigner("key-2");
});

function verifierFor(served: () => Signer[], clock = { now: NOW }) {
  const calls = { n: 0 };
  const verify = createJwtVerifier({
    issuer: ISSUER,
    now: () => clock.now,
    fetchJwks: (url) => {
      calls.n++;
      assert.equal(url, `${ISSUER}/.well-known/jwks.json`);
      return Promise.resolve({ keys: served().map((s) => s.jwk) });
    },
  });
  return { verify, calls, clock };
}

describe("local JWT verification", () => {
  test("a valid token returns its claims and the key set is fetched once", async () => {
    const { verify, calls } = verifierFor(() => [signer]);
    const result = await verify(await signer.sign(claims({ client_id: "abc" })));
    assert.notEqual(typeof result, "string");
    assert.equal((result as Record<string, unknown>).sub, claims().sub);
    assert.equal((result as Record<string, unknown>).client_id, "abc");
    await verify(await signer.sign(claims()));
    assert.equal(calls.n, 1);
  });

  test("expired, wrong-issuer, tampered and malformed tokens are invalid", async () => {
    const { verify } = verifierFor(() => [signer]);
    assert.equal(await verify(await signer.sign(claims({ exp: NOW / 1000 - 1 }))), "invalid");
    assert.equal(await verify(await signer.sign(claims({ exp: undefined }))), "invalid");
    assert.equal(await verify(await signer.sign(claims({ iss: "https://evil.example.com/auth/v1" }))), "invalid");

    const [head, , signature] = (await signer.sign(claims())).split(".");
    const forged = `${head}.${b64url(JSON.stringify(claims({ sub: "22222222-2222-4222-8222-222222222222" })))}.${signature}`;
    assert.equal(await verify(forged), "invalid");
    assert.equal(await verify("not-a-jwt"), "invalid");
    assert.equal(await verify("a.b.c"), "invalid");
  });

  test("a token signed by another key under a known kid is invalid", async () => {
    const { verify } = verifierFor(() => [signer]);
    assert.equal(await verify(await other.sign(claims(), { kid: signer.kid })), "invalid");
  });

  test("other algorithms are never verified here", async () => {
    const { verify, calls } = verifierFor(() => [signer]);
    const unsigned = `${b64url(JSON.stringify({ alg: "none", kid: signer.kid }))}.${b64url(JSON.stringify(claims()))}.`;
    assert.equal(await verify(unsigned), "unknown");
    assert.equal(await verify(await signer.sign(claims(), { alg: "HS256" })), "unknown");
    assert.equal(calls.n, 0);
  });

  test("an unknown key is unknown, and is picked up after rotation without refetching on every request", async () => {
    let served = [signer];
    const { verify, calls, clock } = verifierFor(() => served);
    await verify(await signer.sign(claims()));
    const rotated = await other.sign(claims());

    assert.equal(await verify(rotated), "unknown");
    assert.equal(await verify(rotated), "unknown");
    assert.equal(calls.n, 1);

    served = [signer, other];
    clock.now += 61_000;
    assert.notEqual(typeof (await verify(rotated)), "string");
    assert.equal(calls.n, 2);
  });

  test("an unreachable key set is unknown, not an error", async () => {
    const verify = createJwtVerifier({
      issuer: ISSUER,
      now: () => NOW,
      fetchJwks: () => Promise.reject(new Error("down")),
    });
    assert.equal(await verify(await signer.sign(claims())), "unknown");
  });
});
