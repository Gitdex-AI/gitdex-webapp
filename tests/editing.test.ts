// Editing published records: author only, two-step, and never erasing. Every
// edit keeps the version it replaces in the public history.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { guideDocs } from "../supabase/functions/_shared/guide.ts";
import {
  BASE,
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

const patch = (path: string, as: string | null, body: Record<string, unknown>, key = newKey()) =>
  h.api("PATCH", path, { as, key, body });
const history = (type: string, id: string, as: string | null = null) =>
  h.api("GET", `/history?entity_type=${type}&entity_id=${id}`, { as });

const ZH = {
  description: "家庭物品收纳工具，支持房间、柜子和抽屉的多级位置。",
  capabilities: ["多级存放位置", "物品搜索", "照片附件"],
};

describe("update_software", () => {
  test("requires sign-in and the submitter", async () => {
    const id = await publishSoftware(h, "bob", { name: "Owner Edit Tool", url: "https://owner-edit-tool.example.com" });
    const anonymous = await patch(`/software/${id}`, null, { pricing_type: "free", confirmed: true });
    assert.equal(anonymous.status, 401);
    const stranger = await patch(`/software/${id}`, "carol", { pricing_type: "free", confirmed: true });
    assert.equal(stranger.status, 403);
    assert.equal((await h.api("GET", `/software/${id}`)).body.software.pricing_type, "freemium");
  });

  test("without confirmation nothing changes and the preview shows new next to old", async () => {
    const id = await publishSoftware(h, "bob", { name: "Preview Edit Tool", url: "https://preview-edit-tool.example.com" });
    const res = await patch(`/software/${id}`, "bob", { pricing_type: "paid", pricing_notes: "$5 once", change_note: "New pricing" });
    assert.equal(res.status, 428);
    const preview = res.body.error.details.preview;
    assert.equal(preview.will_be_public.version, 2);
    assert.equal(preview.will_be_public.pricing_type, "paid");
    assert.deepEqual(preview.replaces, { pricing_type: "freemium", pricing_notes: null });
    assert.match(preview.history, /Version 1 stays publicly visible/);
    const software = (await h.api("GET", `/software/${id}`)).body.software;
    assert.equal(software.version, 1);
    assert.equal(software.pricing_type, "freemium");
    assert.deepEqual((await history("software", id)).body.earlier_versions, []);
  });

  test("an edit publishes a new version, keeps the old one readable, and applies once on retry", async () => {
    const id = await publishSoftware(h, "bob", { name: "Versioned Tool", url: "https://versioned-tool.example.com", translations: { zh: ZH } });
    const key = newKey();
    const body = { pricing_type: "paid", pricing_notes: "$5 once", icon_url: "https://cdn.example.com/v2.png", change_note: "Now a paid app", confirmed: true };
    const first = await patch(`/software/${id}`, "bob", body, key);
    assert.equal(first.status, 200);
    assert.equal(first.body.version, 2);
    assert.deepEqual(first.body.changed, ["pricing_type", "pricing_notes", "icon_url", "translations"]);
    assert.equal((await patch(`/software/${id}`, "bob", body, key)).body.idempotent_replay, true);

    const software = (await h.api("GET", `/software/${id}`)).body.software;
    assert.equal(software.version, 2);
    assert.equal(software.pricing_notes, "$5 once");
    assert.equal(software.description, SAMPLE_SOFTWARE.description);

    const past = (await history("software", id)).body;
    assert.equal(past.current_version, 2);
    assert.equal(past.earlier_versions.length, 1);
    assert.equal(past.earlier_versions[0].version, 1);
    assert.equal(past.earlier_versions[0].change_note, "Now a paid app");
    assert.equal(past.earlier_versions[0].content.pricing_type, "freemium");
    assert.equal(past.earlier_versions[0].content.icon_url, null);
    assert.deepEqual(past.earlier_versions[0].content.translations.zh, ZH);

    // The same edit again changes nothing; a second real edit appends version 3.
    assert.equal((await patch(`/software/${id}`, "bob", body)).body.error.code, "INVALID_STATE");
    assert.equal((await patch(`/software/${id}`, "bob", { license: "MIT", confirmed: true })).body.version, 3);
    assert.deepEqual((await history("software", id)).body.earlier_versions.map((r: any) => r.version), [2, 1]);
  });

  test("changing the text drops a translation that no longer matches unless a new one is sent", async () => {
    const id = await publishSoftware(h, "bob", { name: "Retranslate Tool", url: "https://retranslate-tool.example.com", translations: { zh: ZH } });
    const description = "Home inventory tracker with nested rooms, cabinets, drawers and boxes.";
    const preview = await patch(`/software/${id}`, "bob", { description });
    assert.deepEqual(preview.body.error.details.missing_translations, ["zh"]);

    const zh = { ...ZH, description: "家庭物品收纳工具，支持房间、柜子、抽屉和箱子的多级位置。" };
    const withTranslation = await patch(`/software/${id}`, "bob", { description, translations: { zh }, confirmed: true });
    assert.equal(withTranslation.status, 200);
    const software = (await h.api("GET", `/software/${id}`)).body.software;
    assert.equal(software.translations.zh.description, zh.description);
    assert.ok((await h.api("GET", `/software?q=${encodeURIComponent("箱子")}`)).body.items.some((s: any) => s.id === id));

    const dropped = await patch(`/software/${id}`, "bob", { capabilities: ["nested storage locations", "item search"], confirmed: true });
    assert.equal(dropped.status, 200);
    assert.deepEqual((await h.api("GET", `/software/${id}`)).body.software.translations, {});
    // Fields that are not text leave the translation alone.
    const kept = await publishSoftware(h, "bob", { name: "Keep Translation Tool", url: "https://keep-translation.example.com", translations: { zh: ZH } });
    await patch(`/software/${kept}`, "bob", { platforms: ["android"], confirmed: true });
    assert.deepEqual((await h.api("GET", `/software/${kept}`)).body.software.translations.zh, ZH);
  });

  test("the record's URLs cannot be changed, and a reviewed record goes back to unreviewed", async () => {
    const id = await publishSoftware(h, "bob", { name: "Identity Tool", url: "https://identity-tool.example.com" });
    const moved = await patch(`/software/${id}`, "bob", { url: "https://somewhere-else.example.com", confirmed: true });
    assert.equal(moved.status, 422);
    assert.equal(moved.body.error.details.fields[0].field, "url");

    await h.db.query(`update software set review_status = 'reviewed' where id = $1::text`, [id]);
    const res = await patch(`/software/${id}`, "bob", { name: "Identity Tool Pro", confirmed: true });
    assert.equal(res.body.review_status, "unreviewed");
    const software = (await h.api("GET", `/software/${id}`)).body.software;
    assert.equal(software.review_status, "unreviewed");
    assert.equal(software.name, "Identity Tool Pro");
    assert.equal(software.canonical_url, "https://identity-tool.example.com");
  });
});

describe("sources on edits", () => {
  test("an edit can replace the submitter's sources; tested evidence and history survive", async () => {
    const id = await publishSoftware(h, "bob", { name: "Sourced Edit Tool", url: "https://sourced-edit.example.com" });
    // Evidence from an independent test, which no submitter can assert or remove.
    await h.db.query(
      `insert into evidence (entity_type, entity_id, claim, source_url, verification_level) values ('software', $1::text, 'Search works offline', 'https://lab.example.org/report', 'tested')`,
      [id],
    );
    const sources = [{ url: "https://sourced-edit.example.com/pricing-2027", claim: "Costs $5 once", source_type: "official_site", verification_level: "documented" }];
    const tested = await patch(`/software/${id}`, "bob", { sources: [{ ...sources[0], verification_level: "tested" }], confirmed: true });
    assert.equal(tested.status, 422);
    assert.equal(tested.body.error.details.fields[0].field, "sources[0].verification_level");

    const preview = await patch(`/software/${id}`, "bob", { pricing_type: "paid", sources });
    assert.equal(preview.body.error.details.preview.will_be_public.source_refs[0].claim, "Costs $5 once");
    assert.equal(preview.body.error.details.preview.replaces.source_refs[0].claim, "Core features are free");

    const done = await patch(`/software/${id}`, "bob", { pricing_type: "paid", sources, confirmed: true });
    assert.deepEqual(done.body.changed, ["pricing_type", "source_refs"]);
    const detail = (await h.api("GET", `/software/${id}`)).body;
    assert.equal(detail.software.source_refs[0].url, sources[0].url);
    assert.deepEqual(detail.evidence.map((e: any) => [e.claim, e.verification_level]), [
      ["Search works offline", "tested"],
      ["Costs $5 once", "documented"],
    ]);
    const past = (await history("software", id)).body.earlier_versions[0].content;
    assert.equal(past.source_refs[0].claim, "Core features are free");

    // Leaving `sources` out keeps them.
    await patch(`/software/${id}`, "bob", { license: "MIT", confirmed: true });
    assert.equal((await h.api("GET", `/software/${id}`)).body.evidence.length, 2);
  });

  test("a proposal's evidence can be replaced before a verdict", async () => {
    const requestId = await publishRequest(h, "alice", { title: "Request for evidence edits" });
    const softwareId = await publishSoftware(h, "bob", { name: "Evidence Edit Tool", url: "https://evidence-edit.example.com" });
    const id = await publishProposal(h, "bob", requestId, softwareId);
    const evidence = [{ url: "https://evidence-edit.example.com/docs/locations", claim: "Nested locations are documented" }];
    const done = await patch(`/solutions/${id}`, "bob", { evidence, confirmed: true });
    assert.equal(done.status, 200);
    assert.deepEqual(done.body.changed, ["evidence_refs"]);
    const solution = (await h.api("GET", `/solutions/${id}`)).body.solution;
    assert.equal(solution.evidence_refs[0].claim, "Nested locations are documented");
    assert.equal(solution.evidence_refs[0].verification_level, "claimed");
    assert.deepEqual((await history("solution", id)).body.earlier_versions[0].content.evidence_refs, []);
  });
});

describe("update_request", () => {
  test("only the requester can edit, after a preview, and supporters are told", async () => {
    const id = await publishRequest(h, "alice", { title: "Editable request title" });
    await h.api("POST", `/requests/${id}/support`, { as: "carol", key: newKey(), body: {} });
    assert.equal((await patch(`/requests/${id}`, null, { title: "Changed by nobody", confirmed: true })).status, 401);
    assert.equal((await patch(`/requests/${id}`, "bob", { title: "Changed by a stranger", confirmed: true })).status, 403);

    const must_have = [...SAMPLE_REQUEST.must_have, "works offline"];
    const preview = await patch(`/requests/${id}`, "alice", { must_have });
    assert.equal(preview.status, 428);
    assert.deepEqual(preview.body.error.details.preview.replaces.must_have, SAMPLE_REQUEST.must_have);
    assert.equal((await h.api("GET", `/requests/${id}`)).body.request.version, 1);

    const key = newKey();
    const done = await patch(`/requests/${id}`, "alice", { must_have, change_note: "Added offline use", confirmed: true }, key);
    assert.equal(done.status, 200);
    assert.equal(done.body.version, 2);
    assert.equal((await patch(`/requests/${id}`, "alice", { must_have, change_note: "Added offline use", confirmed: true }, key)).body.idempotent_replay, true);

    const request = (await h.api("GET", `/requests/${id}`)).body.request;
    assert.deepEqual(request.must_have, must_have);
    assert.equal(request.status, "open");
    const past = (await history("request", id)).body;
    assert.deepEqual(past.earlier_versions[0].content.must_have, SAMPLE_REQUEST.must_have);
    assert.equal(past.earlier_versions.length, 1);
    assert.ok((await h.api("GET", "/requests?q=offline")).body.items.some((r: any) => r.id === id));
    const notes = (await h.api("GET", "/me/notifications", { as: "carol" })).body.items;
    assert.equal(notes.filter((n: any) => n.type === "request.updated" && n.request_id === id).length, 1);
  });

  test("a request with a proposal, or a closed one, can no longer be edited", async () => {
    const id = await publishRequest(h, "alice", { title: "Request frozen by a proposal" });
    const softwareId = await publishSoftware(h, "bob", { name: "Freezer Tool", url: "https://freezer-tool.example.com" });
    await publishProposal(h, "bob", id, softwareId);
    const res = await patch(`/requests/${id}`, "alice", { title: "Quietly different conditions", confirmed: true });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "INVALID_STATE");
    assert.match(res.body.error.message, /publish a new request/);
    assert.equal((await h.api("GET", `/requests/${id}`)).body.request.title, "Request frozen by a proposal");

    const closed = await publishRequest(h, "alice", { title: "Request closed before editing" });
    await h.api("POST", `/requests/${closed}/close`, { as: "alice", key: newKey(), body: { confirmed: true } });
    assert.equal((await patch(`/requests/${closed}`, "alice", { title: "Edited after closing", confirmed: true })).body.error.code, "INVALID_STATE");
  });
});

describe("update_solution", () => {
  test("the proposer can edit before any verdict; the request stays unresolved", async () => {
    const requestId = await publishRequest(h, "alice", { title: "Request for an edited proposal" });
    const softwareId = await publishSoftware(h, "bob", { name: "Edited Proposal Tool", url: "https://edited-proposal.example.com" });
    const id = await publishProposal(h, "bob", requestId, softwareId);
    assert.equal((await patch(`/solutions/${id}`, null, { unmet_requirements: [], confirmed: true })).status, 401);
    assert.equal((await patch(`/solutions/${id}`, "alice", { unmet_requirements: [], confirmed: true })).status, 403);

    const body = { unmet_requirements: ["iCloud sync not verified", "no Android app"], change_note: "Found another gap" };
    assert.equal((await patch(`/solutions/${id}`, "bob", body)).status, 428);
    const key = newKey();
    const done = await patch(`/solutions/${id}`, "bob", { ...body, confirmed: true }, key);
    assert.equal(done.body.version, 2);
    assert.equal(done.body.status, "proposed");
    assert.equal((await patch(`/solutions/${id}`, "bob", { ...body, confirmed: true }, key)).body.idempotent_replay, true);

    const solution = (await h.api("GET", `/solutions/${id}`)).body.solution;
    assert.deepEqual(solution.unmet_requirements, body.unmet_requirements);
    assert.equal((await h.api("GET", `/requests/${requestId}`)).body.request.status, "proposals_available");
    assert.deepEqual((await history("solution", id)).body.earlier_versions[0].content.unmet_requirements, ["iCloud sync not verified"]);
    const notes = (await h.api("GET", "/me/notifications", { as: "alice" })).body.items;
    assert.equal(notes.filter((n: any) => n.type === "proposal.updated" && n.proposal_id === id).length, 1);
  });

  test("once a verdict exists the judged text cannot change", async () => {
    const requestId = await publishRequest(h, "alice", { title: "Request with a judged proposal" });
    const softwareId = await publishSoftware(h, "bob", { name: "Judged Tool", url: "https://judged-tool.example.com" });
    const id = await publishProposal(h, "bob", requestId, softwareId);
    await h.api("POST", `/solutions/${id}/confirm`, { as: "alice", key: newKey(), body: { verdict: "partial", confirmed: true } });
    const res = await patch(`/solutions/${id}`, "bob", { unmet_requirements: [], confirmed: true });
    assert.equal(res.body.error.code, "INVALID_STATE");
    assert.match(res.body.error.message, /Withdraw it and propose again/);
    assert.deepEqual((await h.api("GET", `/solutions/${id}`)).body.solution.unmet_requirements, ["iCloud sync not verified"]);
  });
});

describe("history", () => {
  test("is as visible as the record, and a moderator can delete earlier versions", async () => {
    const id = await publishSoftware(h, "bob", { name: "Private Slip Tool", url: "https://private-slip.example.com", pricing_notes: "Ask bob at 555 0100 200" });
    await patch(`/software/${id}`, "bob", { pricing_notes: null, change_note: "Removed a phone number", confirmed: true });
    assert.equal((await history("software", id)).body.earlier_versions[0].content.pricing_notes, "Ask bob at 555 0100 200");
    assert.equal((await history("software", "sw_missing")).status, 404);

    await h.api("GET", "/me", { as: "dave" });
    await h.db.query(`update profiles set is_admin = true where id = $1::uuid`, [h.userId("dave")]);
    const cleared = await h.api("POST", "/admin/moderate", { as: "dave", key: newKey(), body: { entity_type: "software", entity_id: id, action: "clear_history", confirmed: true } });
    assert.equal(cleared.status, 200);
    const past = (await history("software", id)).body;
    assert.deepEqual(past.earlier_versions, []);
    assert.equal(past.current_version, 2);

    await h.db.query(`update software set review_status = 'removed' where id = $1::text`, [id]);
    assert.equal((await history("software", id)).status, 404);

    const requestId = await publishRequest(h, "alice", { title: "Withdrawn request with history" });
    await patch(`/requests/${requestId}`, "alice", { title: "Withdrawn request with a history", confirmed: true });
    await h.api("POST", `/requests/${requestId}/close`, { as: "alice", key: newKey(), body: { unpublish: true, confirmed: true } });
    assert.equal((await history("request", requestId)).status, 404);
    assert.equal((await history("request", requestId, "alice")).status, 200);
  });

  test("agents are told that an edit appends a version and erases nothing", async () => {
    const docs = guideDocs(BASE);
    for (const name of ["guide", "request", "submit", "solve"]) assert.match(docs[name], /Editing appends a version; it never erases/, name);
    const tools = (await h.mcp("tools/list", {}, { as: "alice" })).body.result.tools;
    for (const name of ["update_software", "update_request", "update_solution"]) {
      const tool = tools.find((t: any) => t.name === name);
      assert.match(tool.description, /NOTHING IS ERASED/, name);
      assert.ok(tool.inputSchema.properties.confirmed, name);
      assert.ok(tool.inputSchema.required.includes("idempotency_key"), name);
    }
    assert.equal(tools.find((t: any) => t.name === "get_history").annotations.readOnlyHint, true);
  });
});
