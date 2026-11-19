// End-to-end behavior of the V1 acceptance criteria (PRD 14) through the real
// HTTP application and the real schema.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  createHarness,
  type Harness,
  newKey,
  publishProposal,
  publishRequest,
  publishSoftware,
  SAMPLE_REQUEST,
  SAMPLE_SOFTWARE,
} from "./helpers.ts";

let h: Harness;
before(async () => {
  h = await createHarness();
});
after(async () => {
  await h.close();
});

describe("public reads", () => {
  test("anonymous users can browse directories and details", async () => {
    const requestId = await publishRequest(h, "alice", { title: "Browse test request" });
    const softwareId = await publishSoftware(h, "bob", { name: "Browse Tool", url: "https://browse-tool.example.com" });

    const requests = await h.api("GET", "/requests?q=browse");
    assert.equal(requests.status, 200);
    assert.ok(requests.body.items.some((r: any) => r.id === requestId));

    const software = await h.api("GET", "/software?q=browse");
    assert.equal(software.status, 200);
    assert.ok(software.body.items.some((s: any) => s.id === softwareId));

    assert.equal((await h.api("GET", `/requests/${requestId}`)).status, 200);
    assert.equal((await h.api("GET", `/software/${softwareId}`)).status, 200);
    assert.equal((await h.api("GET", "/software/browse-tool")).body.software.id, softwareId);
  });

  test("search never reports absence as non-existence and matches any keyword", async () => {
    const res = await h.api("GET", "/software?q=nonexistent-zzz");
    assert.equal(res.body.total, 0);
    assert.match(res.body.notice, /does not mean suitable software does not exist/);

    await publishSoftware(h, "bob", {
      name: "Quillpad",
      url: "https://quillpad.example.com",
      description: "Offline markdown notes with local storage.",
      platforms: ["android"],
      pricing_type: "open_source",
    });
    const hit = await h.api("GET", "/software?q=offline+notes+for+ios&pricing=open_source,free");
    assert.equal(hit.body.items[0].name, "Quillpad");
    assert.deepEqual(hit.body.items[0].matched_fields, ["description"]);
    const filtered = await h.api("GET", "/software?q=offline+notes&platforms=ios");
    assert.equal(filtered.body.total, 0);
  });

  test("unknown ids return NOT_FOUND", async () => {
    const res = await h.api("GET", "/requests/req_missing");
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "NOT_FOUND");
  });
});

describe("write authorization", () => {
  const writes: [string, string, unknown][] = [
    ["POST", "/requests", SAMPLE_REQUEST],
    ["POST", "/software", SAMPLE_SOFTWARE],
    ["POST", "/solutions", { request_id: "req_x", software_id: "sw_x", coverage_notes: "covers everything needed" }],
    ["POST", "/solutions/sol_x/confirm", { verdict: "accepted" }],
    ["POST", "/requests/req_x/support", {}],
  ];
  for (const [method, path, body] of writes) {
    test(`${method} ${path} is rejected without sign-in`, async () => {
      const res = await h.api(method, path, { body: { ...(body as object), confirmed: true }, key: newKey() });
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, "AUTH_REQUIRED");
    });
  }

  test("invalid tokens are rejected, not treated as anonymous", async () => {
    const res = await h.api("GET", "/software", { as: "jwt-nobody" });
    assert.equal(res.status, 401);
    const bad = await h.api("GET", "/software", { as: "gdx_0000000000000000" });
    assert.equal(bad.status, 401);
  });
});

describe("create_request", () => {
  test("a request with long must-haves still gets its preview", async () => {
    const must_have = [
      "Can be self-hosted on a Linux server with Docker",
      "Full-text search over the content of saved pages",
      "Browser extension or bookmarklet to save the current page",
      "Import and export in the standard bookmarks HTML format",
    ];
    const res = await h.api("POST", "/requests", {
      as: "alice",
      key: newKey(),
      body: { ...SAMPLE_REQUEST, title: "Self-hosted bookmark manager with full-text search", must_have },
    });
    assert.equal(res.status, 428);
    assert.equal(res.body.error.code, "CONFIRMATION_REQUIRED");
    assert.deepEqual(res.body.error.details.preview.will_be_public.must_have, must_have);
  });

  test("without confirmation nothing is written and the public preview is returned", async () => {
    const before = (await h.api("GET", "/requests?status=all&limit=1")).body.total;
    const res = await h.api("POST", "/requests", { as: "alice", key: newKey(), body: SAMPLE_REQUEST });
    assert.equal(res.status, 428);
    assert.equal(res.body.error.code, "CONFIRMATION_REQUIRED");
    const preview = res.body.error.details.preview.will_be_public;
    assert.equal(preview.title, SAMPLE_REQUEST.title);
    assert.deepEqual(preview.platforms, ["ios"]);
    assert.equal(preview.visibility, "public");
    assert.equal((await h.api("GET", "/requests?status=all&limit=1")).body.total, before);
  });

  test("the preview carries privacy warnings and similar requests", async () => {
    const existing = await publishRequest(h, "bob", { title: "Recipe scaling calculator for bakers" });
    const res = await h.api("POST", "/requests", {
      as: "alice",
      key: newKey(),
      body: { ...SAMPLE_REQUEST, title: "Recipe scaling tool", goal: "Scale recipes; email me at alice@example.org" },
    });
    assert.ok(res.body.error.details.privacy_warnings.some((w: string) => /email/.test(w)));
    assert.ok(res.body.error.details.similar_requests.some((r: any) => r.request_id === existing));
  });

  test("confirmed creation publishes an open request", async () => {
    const res = await h.api("POST", "/requests", { as: "alice", key: newKey(), body: { ...SAMPLE_REQUEST, confirmed: true } });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "open");
    const detail = await h.api("GET", `/requests/${res.body.request_id}`);
    assert.equal(detail.body.request.interest_count, 1);
    assert.equal(detail.body.request.owner.display_name, "alice");
  });

  test("a retry with the same idempotency key creates exactly one record", async () => {
    const key = newKey();
    const body = { ...SAMPLE_REQUEST, title: "Idempotent request title", confirmed: true };
    const first = await h.api("POST", "/requests", { as: "alice", key, body });
    const second = await h.api("POST", "/requests", { as: "alice", key, body });
    assert.equal(second.status, 200);
    assert.equal(second.body.request_id, first.body.request_id);
    assert.equal(second.body.idempotent_replay, true);
    const found = await h.api("GET", "/requests?q=idempotent&status=all");
    assert.equal(found.body.total, 1);
  });

  test("reusing a key for a different payload is a conflict", async () => {
    const key = newKey();
    await h.api("POST", "/requests", { as: "alice", key, body: { ...SAMPLE_REQUEST, title: "First payload title", confirmed: true } });
    const res = await h.api("POST", "/requests", { as: "alice", key, body: { ...SAMPLE_REQUEST, title: "Second payload title", confirmed: true } });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "CONFLICT");
  });

  test("writes without an idempotency key are rejected", async () => {
    const res = await h.api("POST", "/requests", { as: "alice", body: { ...SAMPLE_REQUEST, confirmed: true } });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.details.fields[0].field, "idempotency_key");
  });

  test("validation reports every bad field", async () => {
    const res = await h.api("POST", "/requests", { as: "alice", key: newKey(), body: { title: "Hi", must_have: [], confirmed: true } });
    assert.equal(res.status, 422);
    const fields = res.body.error.details.fields.map((f: any) => f.field).sort();
    assert.deepEqual(fields, ["goal", "must_have", "title"]);
  });
});

describe("support_request", () => {
  test("support is counted once per user and can be removed", async () => {
    const id = await publishRequest(h, "alice", { title: "Support counting request" });
    for (let i = 0; i < 3; i += 1) {
      const res = await h.api("POST", `/requests/${id}/support`, { as: "bob", key: newKey(), body: {} });
      assert.equal(res.status, 200);
      assert.equal(res.body.interest_count, 2);
    }
    await h.api("POST", `/requests/${id}/support`, { as: "carol", key: newKey(), body: { notifications_enabled: false } });
    const detail = await h.api("GET", `/requests/${id}`, { as: "carol" });
    assert.equal(detail.body.request.interest_count, 3);
    assert.deepEqual(detail.body.viewer, { is_owner: false, is_supporter: true, notifications_enabled: false });

    await h.api("DELETE", `/requests/${id}/support`, { as: "bob" });
    assert.equal((await h.api("GET", `/requests/${id}`)).body.request.interest_count, 2);
  });

  test("the requester cannot inflate their own request", async () => {
    const id = await publishRequest(h, "alice", { title: "Self support request" });
    const res = await h.api("POST", `/requests/${id}/support`, { as: "alice", key: newKey(), body: {} });
    assert.equal(res.body.error.code, "INVALID_STATE");
  });
});

describe("submit_software", () => {
  test("requires confirmation and shows the exact public record", async () => {
    const res = await h.api("POST", "/software", {
      as: "bob",
      key: newKey(),
      body: { ...SAMPLE_SOFTWARE, name: "Preview Only", url: "https://preview-only.example.com/app/" },
    });
    assert.equal(res.status, 428);
    const preview = res.body.error.details.preview;
    assert.equal(preview.will_be_public.canonical_url, "https://preview-only.example.com/app");
    assert.equal(preview.review_status_after_submit, "unreviewed");
    assert.equal((await h.api("GET", "/software?q=preview")).body.total, 0);
  });

  test("duplicate URLs and repositories return the existing record", async () => {
    const id = await publishSoftware(h, "bob", {
      name: "Dedup Tool",
      url: "https://deduptool.example.com/",
      repository_url: "https://github.com/Acme/Dedup-Tool.git",
    });
    const sameUrl = await h.api("POST", "/software", {
      as: "carol",
      key: newKey(),
      body: { ...SAMPLE_SOFTWARE, name: "Dedup again", url: "http://www.deduptool.example.com", confirmed: true },
    });
    assert.equal(sameUrl.status, 409);
    assert.equal(sameUrl.body.error.code, "DUPLICATE_CANDIDATE");
    assert.equal(sameUrl.body.error.details.candidates[0].software_id, id);

    const sameRepo = await h.api("POST", "/software", {
      as: "carol",
      key: newKey(),
      body: { ...SAMPLE_SOFTWARE, name: "Dedup mirror", url: "https://github.com/acme/dedup-tool/tree/main" },
    });
    assert.equal(sameRepo.body.error.code, "DUPLICATE_CANDIDATE");
  });

  test("same name on a different URL is a different product", async () => {
    const a = await publishSoftware(h, "bob", { name: "Atlas", url: "https://atlas-one.example.com" });
    const b = await publishSoftware(h, "bob", { name: "Atlas", url: "https://atlas-two.example.com" });
    assert.notEqual(a, b);
    const one = await h.api("GET", `/software/${a}`);
    const two = await h.api("GET", `/software/${b}`);
    assert.notEqual(one.body.software.slug, two.body.software.slug);
  });

  test("unsafe URLs are rejected", async () => {
    for (const url of ["javascript:alert(1)", "http://localhost:3000", "http://192.168.1.4/app", "https://user:pw@site.example.com", "ftp://files.example.com"]) {
      const res = await h.api("POST", "/software", { as: "bob", key: newKey(), body: { ...SAMPLE_SOFTWARE, url, confirmed: true } });
      assert.equal(res.status, 422, url);
      assert.equal(res.body.error.details.fields[0].field, "url");
    }
  });

  test("a submitter cannot assert independently tested evidence", async () => {
    const res = await h.api("POST", "/software", {
      as: "bob",
      key: newKey(),
      body: {
        ...SAMPLE_SOFTWARE,
        url: "https://tested-claim.example.com",
        sources: [{ url: "https://tested-claim.example.com/docs", verification_level: "tested" }],
        confirmed: true,
      },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.details.fields[0].field, "sources[0].verification_level");
  });

  test("submitted software is unreviewed and keeps its sources", async () => {
    const id = await publishSoftware(h, "bob", { name: "Sourced Tool", url: "https://sourced-tool.example.com" });
    const detail = await h.api("GET", `/software/${id}`);
    assert.equal(detail.body.software.review_status, "unreviewed");
    assert.equal(detail.body.evidence[0].verification_level, "claimed");
    assert.equal(detail.body.evidence[0].claim, "Core features are free");
  });
});

describe("propose_solution and confirm_solution", () => {
  test("a proposal never resolves the request", async () => {
    const requestId = await publishRequest(h, "alice", { title: "Proposal does not resolve" });
    const softwareId = await publishSoftware(h, "bob", { name: "Candidate A", url: "https://candidate-a.example.com" });

    const preview = await h.api("POST", "/solutions", {
      as: "bob",
      key: newKey(),
      body: { request_id: requestId, software_id: softwareId, coverage_notes: "Covers all the must-haves listed." },
    });
    assert.equal(preview.body.error.code, "CONFIRMATION_REQUIRED");
    assert.equal((await h.api("GET", `/requests/${requestId}`)).body.request.status, "open");

    const proposalId = await publishProposal(h, "bob", requestId, softwareId);
    const detail = await h.api("GET", `/requests/${requestId}`);
    assert.equal(detail.body.request.status, "proposals_available");
    assert.equal(detail.body.proposals[0].id, proposalId);
    assert.equal(detail.body.proposals[0].status, "proposed");
    assert.equal(detail.body.proposals[0].requester_verdict, null);
  });

  test("the same software cannot be proposed twice for one request", async () => {
    const requestId = await publishRequest(h, "alice", { title: "Duplicate proposal request" });
    const softwareId = await publishSoftware(h, "bob", { name: "Candidate B", url: "https://candidate-b.example.com" });
    await publishProposal(h, "bob", requestId, softwareId);
    const res = await h.api("POST", "/solutions", {
      as: "carol",
      key: newKey(),
      body: { request_id: requestId, software_id: softwareId, coverage_notes: "Also think this covers it.", confirmed: true },
    });
    assert.equal(res.body.error.code, "DUPLICATE_CANDIDATE");
  });

  test("only the requester can accept; a stranger and the proposer cannot", async () => {
    const requestId = await publishRequest(h, "alice", { title: "Acceptance authority request" });
    const softwareId = await publishSoftware(h, "bob", { name: "Candidate C", url: "https://candidate-c.example.com" });
    const proposalId = await publishProposal(h, "bob", requestId, softwareId);
    const confirm = (as: string, verdict: string) =>
      h.api("POST", `/solutions/${proposalId}/confirm`, { as, key: newKey(), body: { verdict, confirmed: true } });

    const stranger = await confirm("carol", "accepted");
    assert.equal(stranger.status, 403);
    const proposer = await confirm("bob", "accepted");
    assert.equal(proposer.status, 403);
    assert.equal((await h.api("GET", `/requests/${requestId}`)).body.request.status, "proposals_available");

    const unconfirmed = await h.api("POST", `/solutions/${proposalId}/confirm`, { as: "alice", key: newKey(), body: { verdict: "accepted" } });
    assert.equal(unconfirmed.body.error.code, "CONFIRMATION_REQUIRED");
    assert.equal(unconfirmed.body.error.details.preview.effect, "The request will be marked resolved.");

    const owner = await confirm("alice", "accepted");
    assert.equal(owner.status, 200);
    assert.equal(owner.body.request_status, "resolved");
    assert.equal(owner.body.proposal_status, "accepted");
    const detail = await h.api("GET", `/requests/${requestId}`);
    assert.equal(detail.body.request.status, "resolved");
    assert.equal(detail.body.request.resolved_proposal_id, proposalId);
  });

  test("directories surface the requester's acceptance: resolved_by and the solved sort", async () => {
    const requestId = await publishRequest(h, "alice", { title: "Shelf ranking request" });
    const accepted = await publishSoftware(h, "bob", { name: "Shelfrank Accepted", url: "https://shelfrank-accepted.example.com" });
    const proposedOnly = await publishSoftware(h, "bob", { name: "Shelfrank Proposed", url: "https://shelfrank-proposed.example.com" });
    const proposalId = await publishProposal(h, "bob", requestId, accepted);
    await publishProposal(h, "bob", requestId, proposedOnly);

    // A proposal alone neither counts as solved nor names a resolving software.
    const before = await h.api("GET", "/requests?q=shelf+ranking&status=all");
    assert.equal(before.body.items[0].resolved_by, null);
    const beforeRank = await h.api("GET", "/software?q=shelfrank&sort=solved");
    assert.deepEqual(beforeRank.body.items.map((s: any) => s.accepted_solution_count), [0, 0]);

    const verdict = await h.api("POST", `/solutions/${proposalId}/confirm`, { as: "alice", key: newKey(), body: { verdict: "accepted", confirmed: true } });
    assert.equal(verdict.status, 200);

    const resolved = await h.api("GET", "/requests?status=resolved&sort=updated&limit=1");
    assert.equal(resolved.body.items[0].id, requestId);
    assert.deepEqual(resolved.body.items[0].resolved_by, {
      proposal_id: proposalId,
      software_id: accepted,
      slug: "shelfrank-accepted",
      name: "Shelfrank Accepted",
      icon_url: null,
    });
    const ranked = await h.api("GET", "/software?q=shelfrank&sort=solved");
    assert.deepEqual(ranked.body.items.map((s: any) => [s.id, s.accepted_solution_count]), [[accepted, 1], [proposedOnly, 0]]);
    const viaMcp = await h.tool("search_software", { query: "shelfrank", sort: "solved" }, { publicEndpoint: true });
    assert.equal(viaMcp.data.items[0].id, accepted);
  });

  test("a proposer who owns the request cannot accept their own proposal", async () => {
    const requestId = await publishRequest(h, "alice", { title: "Self acceptance request" });
    const softwareId = await publishSoftware(h, "alice", { name: "Candidate D", url: "https://candidate-d.example.com" });
    const proposalId = await publishProposal(h, "alice", requestId, softwareId);
    const res = await h.api("POST", `/solutions/${proposalId}/confirm`, { as: "alice", key: newKey(), body: { verdict: "accepted", confirmed: true } });
    assert.equal(res.status, 403);
    assert.equal((await h.api("GET", `/requests/${requestId}`)).body.request.status, "proposals_available");
  });

  test("partial and rejected verdicts keep the request open", async () => {
    const requestId = await publishRequest(h, "alice", { title: "Partial and rejected request" });
    const one = await publishSoftware(h, "bob", { name: "Candidate E", url: "https://candidate-e.example.com" });
    const two = await publishSoftware(h, "bob", { name: "Candidate F", url: "https://candidate-f.example.com" });
    const first = await publishProposal(h, "bob", requestId, one);
    const second = await publishProposal(h, "bob", requestId, two);

    const partial = await h.api("POST", `/solutions/${first}/confirm`, { as: "alice", key: newKey(), body: { verdict: "partial", feedback: "No search.", confirmed: true } });
    assert.equal(partial.body.proposal_status, "proposed");
    assert.equal(partial.body.request_status, "proposals_available");

    const rejectedFirst = await h.api("POST", `/solutions/${first}/confirm`, { as: "alice", key: newKey(), body: { verdict: "rejected", confirmed: true } });
    assert.equal(rejectedFirst.body.proposal_status, "rejected");
    assert.equal(rejectedFirst.body.request_status, "proposals_available");

    const rejectedSecond = await h.api("POST", `/solutions/${second}/confirm`, { as: "alice", key: newKey(), body: { verdict: "rejected", confirmed: true } });
    assert.equal(rejectedSecond.body.request_status, "open");
  });

  test("a supporter's verdict is individual feedback and changes no status", async () => {
    const requestId = await publishRequest(h, "alice", { title: "Supporter feedback request" });
    const softwareId = await publishSoftware(h, "bob", { name: "Candidate G", url: "https://candidate-g.example.com" });
    const proposalId = await publishProposal(h, "bob", requestId, softwareId);
    await h.api("POST", `/requests/${requestId}/support`, { as: "carol", key: newKey(), body: {} });

    const res = await h.api("POST", `/solutions/${proposalId}/confirm`, { as: "carol", key: newKey(), body: { verdict: "accepted", confirmed: true } });
    assert.equal(res.status, 200);
    assert.equal(res.body.recorded_as, "supporter");
    assert.equal(res.body.request_status, "proposals_available");
    assert.equal(res.body.proposal_status, "proposed");

    const solution = await h.api("GET", `/solutions/${proposalId}`);
    assert.equal(solution.body.solution.status, "proposed");
    assert.deepEqual(solution.body.feedback.map((f: any) => [f.verdict, f.is_owner]), [["accepted", false]]);
    const detail = await h.api("GET", `/requests/${requestId}`);
    assert.deepEqual(detail.body.proposals[0].supporter_feedback, { accepted: 1 });
  });

  test("resolved requests accept no further proposals or requester verdicts", async () => {
    const requestId = await publishRequest(h, "alice", { title: "Resolved is final request" });
    const one = await publishSoftware(h, "bob", { name: "Candidate H", url: "https://candidate-h.example.com" });
    const two = await publishSoftware(h, "bob", { name: "Candidate I", url: "https://candidate-i.example.com" });
    const first = await publishProposal(h, "bob", requestId, one);
    const second = await publishProposal(h, "bob", requestId, two);
    await h.api("POST", `/solutions/${first}/confirm`, { as: "alice", key: newKey(), body: { verdict: "accepted", confirmed: true } });

    const late = await h.api("POST", `/solutions/${second}/confirm`, { as: "alice", key: newKey(), body: { verdict: "accepted", confirmed: true } });
    assert.equal(late.body.error.code, "INVALID_STATE");
    const three = await publishSoftware(h, "bob", { name: "Candidate J", url: "https://candidate-j.example.com" });
    const proposal = await h.api("POST", "/solutions", { as: "bob", key: newKey(), body: { request_id: requestId, software_id: three, coverage_notes: "Would also cover this need.", confirmed: true } });
    assert.equal(proposal.body.error.code, "INVALID_STATE");
    const withdraw = await h.api("POST", `/solutions/${first}/withdraw`, { as: "bob", key: newKey(), body: { confirmed: true } });
    assert.equal(withdraw.body.error.code, "INVALID_STATE");
  });
});

describe("withdrawal, closing and notifications", () => {
  test("a proposer can withdraw and the request falls back to open", async () => {
    const requestId = await publishRequest(h, "alice", { title: "Withdraw proposal request" });
    const softwareId = await publishSoftware(h, "bob", { name: "Candidate K", url: "https://candidate-k.example.com" });
    const proposalId = await publishProposal(h, "bob", requestId, softwareId);

    const other = await h.api("POST", `/solutions/${proposalId}/withdraw`, { as: "carol", key: newKey(), body: { confirmed: true } });
    assert.equal(other.status, 403);
    const res = await h.api("POST", `/solutions/${proposalId}/withdraw`, { as: "bob", key: newKey(), body: { confirmed: true } });
    assert.equal(res.body.status, "withdrawn");
    assert.equal(res.body.request_status, "open");
    const detail = await h.api("GET", `/requests/${requestId}`);
    assert.equal(detail.body.proposals.length, 0);
    assert.equal(detail.body.request.proposal_count, 0);
  });

  test("only the requester can close; closed is not resolved", async () => {
    const requestId = await publishRequest(h, "alice", { title: "Closing request" });
    const forbidden = await h.api("POST", `/requests/${requestId}/close`, { as: "bob", key: newKey(), body: { confirmed: true } });
    assert.equal(forbidden.status, 403);
    const res = await h.api("POST", `/requests/${requestId}/close`, { as: "alice", key: newKey(), body: { confirmed: true } });
    assert.equal(res.body.status, "closed");
    const listed = await h.api("GET", "/requests?q=closing");
    assert.equal(listed.body.total, 0);
    const all = await h.api("GET", "/requests?q=closing&status=closed");
    assert.equal(all.body.total, 1);
  });

  test("a requester can withdraw a request from every public surface", async () => {
    const requestId = await publishRequest(h, "alice", { title: "Withdrawable request title" });
    const softwareId = await publishSoftware(h, "bob", { name: "Candidate W", url: "https://candidate-w.example.com" });
    const proposalId = await publishProposal(h, "bob", requestId, softwareId);

    const stranger = await h.api("POST", `/requests/${requestId}/close`, { as: "bob", key: newKey(), body: { unpublish: true, confirmed: true } });
    assert.equal(stranger.status, 403);
    const preview = await h.api("POST", `/requests/${requestId}/close`, { as: "alice", key: newKey(), body: { unpublish: true } });
    assert.equal(preview.body.error.code, "CONFIRMATION_REQUIRED");
    assert.equal((await h.api("GET", `/requests/${requestId}`)).status, 200);

    const res = await h.api("POST", `/requests/${requestId}/close`, { as: "alice", key: newKey(), body: { unpublish: true, confirmed: true } });
    assert.deepEqual([res.body.status, res.body.visibility], ["closed", "private"]);

    assert.equal((await h.api("GET", `/requests/${requestId}`)).status, 404);
    assert.equal((await h.api("GET", `/requests/${requestId}`, { as: "bob" })).status, 404);
    assert.equal((await h.api("GET", `/solutions/${proposalId}`)).status, 404);
    assert.equal((await h.api("GET", "/requests?q=withdrawable&status=all")).body.total, 0);
    assert.equal((await h.api("GET", `/software/${softwareId}`)).body.solutions.length, 0);
    // The requester keeps access to their own record.
    assert.equal((await h.api("GET", `/requests/${requestId}`, { as: "alice" })).status, 200);
    const again = await h.api("POST", `/requests/${requestId}/close`, { as: "alice", key: newKey(), body: { unpublish: true, confirmed: true } });
    assert.equal(again.body.error.code, "INVALID_STATE");
  });

  test("a resolved request can still be withdrawn and stops counting publicly", async () => {
    const requestId = await publishRequest(h, "alice", { title: "Resolved then withdrawn" });
    const softwareId = await publishSoftware(h, "bob", { name: "Candidate X", url: "https://candidate-x.example.com" });
    const proposalId = await publishProposal(h, "bob", requestId, softwareId);
    await h.api("POST", `/solutions/${proposalId}/confirm`, { as: "alice", key: newKey(), body: { verdict: "accepted", confirmed: true } });
    const before = (await h.api("GET", "/stats", { as: "alice" })).body.verified_resolved_requests;
    const res = await h.api("POST", `/requests/${requestId}/close`, { as: "alice", key: newKey(), body: { unpublish: true, confirmed: true } });
    assert.deepEqual([res.body.status, res.body.visibility], ["resolved", "private"]);
    assert.equal((await h.api("GET", "/stats", { as: "alice" })).body.verified_resolved_requests, before - 1);
  });

  test("proposals notify the requester and opted-in supporters only", async () => {
    const requestId = await publishRequest(h, "dave", { title: "Notification routing request" });
    await h.api("POST", `/requests/${requestId}/support`, { as: "alice", key: newKey(), body: {} });
    await h.api("POST", `/requests/${requestId}/support`, { as: "carol", key: newKey(), body: { notifications_enabled: false } });
    const softwareId = await publishSoftware(h, "bob", { name: "Candidate L", url: "https://candidate-l.example.com" });
    const proposalId = await publishProposal(h, "bob", requestId, softwareId);

    const forProposal = async (as: string) =>
      (await h.api("GET", "/me/notifications", { as })).body.items.filter((n: any) => n.proposal_id === proposalId);
    assert.equal((await forProposal("dave")).length, 1);
    assert.equal((await forProposal("alice")).length, 1);
    assert.equal((await forProposal("carol")).length, 0);
    assert.equal((await forProposal("bob")).length, 0);
  });

  test("turning off in-app notifications stops them", async () => {
    await h.api("PATCH", "/me", { as: "dave", body: { notification_preferences: { in_app: false } } });
    const requestId = await publishRequest(h, "dave", { title: "Muted notification request" });
    const softwareId = await publishSoftware(h, "bob", { name: "Candidate M", url: "https://candidate-m.example.com" });
    const proposalId = await publishProposal(h, "bob", requestId, softwareId);
    const items = (await h.api("GET", "/me/notifications", { as: "dave" })).body.items;
    assert.equal(items.filter((n: any) => n.proposal_id === proposalId).length, 0);
    await h.api("PATCH", "/me", { as: "dave", body: { notification_preferences: { in_app: true } } });
  });
});

describe("accounts and tokens", () => {
  test("profiles never expose email-derived names", async () => {
    const me = await h.api("GET", "/me", { as: "carol" });
    assert.match(me.body.user.display_name, /^member-[0-9a-f]{6}$/);
    const renamed = await h.api("PATCH", "/me", { as: "carol", body: { display_name: "Carol C" } });
    assert.equal(renamed.body.user.display_name, "Carol C");
  });

  test("a personal API token authenticates writes and can be revoked", async () => {
    const created = await h.api("POST", "/me/tokens", { as: "alice", body: { name: "Claude Code" } });
    assert.match(created.body.token, /^gdx_[0-9a-f]{48}$/);
    const listed = await h.api("GET", "/me/tokens", { as: "alice" });
    assert.equal(listed.body.items[0].name, "Claude Code");
    assert.equal(JSON.stringify(listed.body).includes(created.body.token), false);

    const viaToken = await h.api("GET", "/me", { as: created.body.token });
    assert.equal(viaToken.body.authenticated_via, "api_token");
    const write = await h.api("POST", "/requests", { as: created.body.token, key: newKey(), body: { ...SAMPLE_REQUEST, title: "Created via API token", confirmed: true } });
    assert.equal(write.status, 200);

    const escalate = await h.api("POST", "/me/tokens", { as: created.body.token, body: { name: "nested" } });
    assert.equal(escalate.status, 403);

    await h.api("DELETE", `/me/tokens/${created.body.id}`, { as: "alice" });
    assert.equal((await h.api("GET", "/me", { as: created.body.token })).status, 401);
  });

  test("activity lists only the caller's own records", async () => {
    await publishRequest(h, "carol", { title: "Carol private activity request" });
    const mine = await h.api("GET", "/me/activity", { as: "carol" });
    assert.ok(mine.body.requests.some((r: any) => r.title === "Carol private activity request"));
    const theirs = await h.api("GET", "/me/activity?type=requests", { as: "bob" });
    assert.equal(theirs.body.requests.some((r: any) => r.title === "Carol private activity request"), false);
    assert.equal(theirs.body.software, undefined);
  });

  test("suspended accounts cannot act", async () => {
    await h.api("GET", "/me", { as: "dave" });
    await h.db.query(`update profiles set status = 'suspended' where id = $1::uuid`, [h.userId("dave")]);
    const res = await h.api("GET", "/me", { as: "dave" });
    assert.equal(res.status, 403);
    await h.db.query(`update profiles set status = 'active' where id = $1::uuid`, [h.userId("dave")]);
  });
});

describe("governance", () => {
  test("writes are audited with actor and client", async () => {
    const id = await publishRequest(h, "alice", { title: "Audited request title" });
    const events = await h.db.query(`select actor_user_id, client_id, event_type from audit_events where entity_id = $1::text`, [id]);
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, "request.created");
    assert.equal(events[0].actor_user_id, h.userId("alice"));
    assert.match(String(events[0].client_id), /^rest:session:/);
  });

  test("reports are recorded without changing the record", async () => {
    const id = await publishRequest(h, "alice", { title: "Reported request title" });
    const res = await h.api("POST", "/reports", { as: "bob", key: newKey(), body: { entity_type: "request", entity_id: id, reason: "Contains spam links" } });
    assert.equal(res.body.status, "open");
    assert.equal((await h.api("GET", `/requests/${id}`)).status, 200);
  });

  test("removed records disappear from every public surface", async () => {
    const requestId = await publishRequest(h, "alice", { title: "Moderated away request" });
    const softwareId = await publishSoftware(h, "bob", { name: "Moderated Tool", url: "https://moderated-tool.example.com" });
    await h.db.query(`update requests set status = 'removed' where id = $1::text`, [requestId]);
    await h.db.query(`update software set review_status = 'removed' where id = $1::text`, [softwareId]);
    assert.equal((await h.api("GET", `/requests/${requestId}`)).status, 404);
    assert.equal((await h.api("GET", `/software/${softwareId}`)).status, 404);
    assert.equal((await h.api("GET", "/requests?q=moderated&status=all")).body.total, 0);
    assert.equal((await h.api("GET", "/software?q=moderated")).body.total, 0);
  });

  test("anonymous reads are rate limited per client address", async () => {
    const headers = { "x-gitdex-proxy-secret": "proxy-secret", "x-gitdex-client-ip": "203.0.113.9" };
    let limited = null;
    for (let i = 0; i < 125; i += 1) {
      const res = await h.api("GET", "/stats", { headers });
      if (res.status === 429) {
        limited = res;
        break;
      }
    }
    assert.ok(limited, "expected a 429 within 125 requests");
    assert.equal(limited.body.error.code, "RATE_LIMITED");
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    // A spoofed client-ip header without the proxy secret is ignored.
    const other = await h.api("GET", "/stats", { headers: { "x-gitdex-client-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.7" } });
    assert.equal(other.status, 200);
  });

  test("stats count only requester-verified resolutions", async () => {
    const before = (await h.api("GET", "/stats", { as: "alice" })).body.verified_resolved_requests;
    const requestId = await publishRequest(h, "alice", { title: "North star metric request" });
    const softwareId = await publishSoftware(h, "bob", { name: "Candidate N", url: "https://candidate-n.example.com" });
    const proposalId = await publishProposal(h, "bob", requestId, softwareId);
    assert.equal((await h.api("GET", "/stats", { as: "alice" })).body.verified_resolved_requests, before);
    await h.api("POST", `/solutions/${proposalId}/confirm`, { as: "alice", key: newKey(), body: { verdict: "accepted", confirmed: true } });
    assert.equal((await h.api("GET", "/stats", { as: "alice" })).body.verified_resolved_requests, before + 1);
  });
});
