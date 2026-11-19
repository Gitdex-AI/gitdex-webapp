// Moderation: reports, moderator actions and account suspension, through the
// real HTTP application. `dave` is the moderator in this file.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createHarness, type Harness, newKey, publishProposal, publishRequest, publishSoftware } from "./helpers.ts";

let h: Harness;
before(async () => {
  h = await createHarness();
  for (const name of ["alice", "bob", "carol", "dave"]) await h.api("GET", "/me", { as: name });
  await h.db.query(`update profiles set is_admin = true where id = $1::uuid`, [h.userId("dave")]);
});
after(async () => {
  await h.close();
});

const report = (as: string, entity_type: string, entity_id: string, reason = "Looks like spam to me") =>
  h.api("POST", "/reports", { as, key: newKey(), body: { entity_type, entity_id, reason } });

const moderate = (body: Record<string, unknown>, opts: { as?: string | null; key?: string; confirmed?: boolean } = {}) =>
  h.api("POST", "/admin/moderate", {
    as: opts.as === undefined ? "dave" : opts.as,
    key: opts.key ?? newKey(),
    body: { ...body, ...(opts.confirmed === false ? {} : { confirmed: true }) },
  });

const softwareState = async (id: string) =>
  String((await h.db.query(`select review_status from software where id = $1::text`, [id]))[0].review_status);

describe("who may moderate", () => {
  const calls: [string, string, unknown][] = [
    ["GET", "/admin/reports", undefined],
    ["GET", "/admin/software", undefined],
    ["POST", "/admin/moderate", { entity_type: "software", entity_id: "sw_x", action: "remove", confirmed: true }],
    ["POST", "/admin/reports/resolve", { entity_type: "software", entity_id: "sw_x", resolution: "dismissed" }],
    ["POST", `/admin/users/00000000-0000-4000-8000-00000000000b/status`, { status: "suspended", confirmed: true }],
  ];

  for (const [method, path, body] of calls) {
    test(`${method} ${path} needs sign-in and the moderator role`, async () => {
      const anonymous = await h.api(method, path, { body, key: newKey() });
      assert.equal(anonymous.status, 401);
      const member = await h.api(method, path, { as: "alice", body, key: newKey() });
      assert.equal(member.status, 403);
      assert.equal(member.body.error.code, "FORBIDDEN");
    });
  }

  test("a moderator's API token or connected AI client cannot moderate", async () => {
    const token = (await h.api("POST", "/me/tokens", { as: "dave", body: { name: "script" } })).body.token;
    for (const as of [token, "dave-oauth"]) {
      const res = await h.api("GET", "/admin/reports", { as });
      assert.equal(res.status, 403);
      assert.match(res.body.error.message, /browser session/);
    }
    assert.equal((await h.api("GET", "/admin/reports", { as: "dave" })).status, 200);
  });

  test("moderation is never exposed as an MCP tool, and only the user sees their own role", async () => {
    const tools = (await h.mcp("tools/list", {}, { as: "dave" })).body.result.tools.map((t: any) => t.name);
    assert.equal(tools.some((name: string) => name.startsWith("admin_")), false);
    assert.equal((await h.api("GET", "/me", { as: "dave" })).body.user.is_admin, true);
    assert.equal((await h.api("GET", "/me", { as: "alice" })).body.user.is_admin, false);
  });
});

describe("reports", () => {
  test("the queue shows each report with its record and author, and dismissing changes nothing else", async () => {
    const requestId = await publishRequest(h, "alice", { title: "Reported but fine request" });
    await report("bob", "request", requestId, "I think this is a duplicate");
    const queue = await h.api("GET", "/admin/reports", { as: "dave" });
    const item = queue.body.items.find((r: any) => r.entity_id === requestId);
    assert.equal(item.reason, "I think this is a duplicate");
    assert.equal(item.reporter.id, h.userId("bob"));
    assert.equal(item.record.label, "Reported but fine request");
    assert.equal(item.record.author.id, h.userId("alice"));

    const body = { entity_type: "request", entity_id: requestId, resolution: "dismissed" };
    const key = newKey();
    const dismissed = await h.api("POST", "/admin/reports/resolve", { as: "dave", key, body });
    assert.equal(dismissed.body.reports, 1);
    assert.equal((await h.api("POST", "/admin/reports/resolve", { as: "dave", key, body })).body.idempotent_replay, true);
    assert.equal((await h.api("GET", `/requests/${requestId}`)).body.request.status, "open");
    const open = await h.api("GET", "/admin/reports", { as: "dave" });
    assert.equal(open.body.items.some((r: any) => r.entity_id === requestId), false);
    const again = await h.api("POST", "/admin/reports/resolve", { as: "dave", key: newKey(), body });
    assert.equal(again.status, 404);
  });

  test("three different reporters flag unreviewed software; one loud reporter does not", async () => {
    const id = await publishSoftware(h, "bob", { name: "Suspicious Tool", url: "https://suspicious-tool.example.com" });
    await report("alice", "software", id);
    await report("alice", "software", id);
    await report("alice", "software", id);
    assert.equal(await softwareState(id), "unreviewed");
    await report("carol", "software", id);
    assert.equal(await softwareState(id), "unreviewed");
    await report("dave", "software", id);
    assert.equal(await softwareState(id), "flagged");
    // Flagged is a warning, not a removal.
    assert.equal((await h.api("GET", `/software/${id}`)).body.software.review_status, "flagged");
  });

  test("software a moderator already reviewed is not flagged automatically", async () => {
    const id = await publishSoftware(h, "bob", { name: "Vetted Tool", url: "https://vetted-tool.example.com" });
    await moderate({ entity_type: "software", entity_id: id, action: "mark_reviewed" });
    for (const name of ["alice", "carol", "dave"]) await report(name, "software", id);
    assert.equal(await softwareState(id), "reviewed");
  });
});

describe("moderating records", () => {
  test("without confirmation nothing changes and the effect is previewed", async () => {
    const id = await publishSoftware(h, "bob", { name: "Preview Mod Tool", url: "https://preview-mod-tool.example.com" });
    await report("alice", "software", id);
    const res = await moderate({ entity_type: "software", entity_id: id, action: "remove", note: "Spam" }, { confirmed: false });
    assert.equal(res.status, 428);
    const preview = res.body.error.details.preview;
    assert.equal(preview.state_before, "unreviewed");
    assert.equal(preview.state_after, "removed");
    assert.equal(preview.open_reports_settled, 1);
    assert.equal(await softwareState(id), "unreviewed");
  });

  test("marking reviewed settles reports, tells the author, is audited, and applies once on retry", async () => {
    const id = await publishSoftware(h, "bob", { name: "Good Tool", url: "https://good-tool.example.com" });
    await report("alice", "software", id);
    const key = newKey();
    const body = { entity_type: "software", entity_id: id, action: "mark_reviewed", note: "Looks fine" };
    const first = await moderate(body, { key });
    assert.equal(first.status, 200);
    assert.equal(first.body.state, "reviewed");
    assert.equal((await moderate(body, { key })).body.idempotent_replay, true);

    assert.equal((await h.api("GET", `/software/${id}`)).body.software.review_status, "reviewed");
    const reports = await h.db.query(`select status from reports where entity_id = $1::text`, [id]);
    assert.deepEqual(reports.map((r) => r.status), ["dismissed"]);
    const notes = (await h.api("GET", "/me/notifications", { as: "bob" })).body.items.filter((n: any) => n.type === "moderation.mark_reviewed");
    assert.equal(notes.filter((n: any) => /Good Tool/.test(n.message)).length, 1);
    assert.match(notes.find((n: any) => /Good Tool/.test(n.message)).message, /Note: Looks fine/);
    const audits = await h.db.query(
      `select actor_user_id from audit_events where event_type = 'moderation.mark_reviewed' and entity_id = $1::text`,
      [id],
    );
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actor_user_id, h.userId("dave"));

    const repeat = await moderate(body);
    assert.equal(repeat.status, 409);
    assert.equal(repeat.body.error.code, "INVALID_STATE");
  });

  test("removed software leaves every public surface and can be restored", async () => {
    const id = await publishSoftware(h, "bob", { name: "Takedown Tool", url: "https://takedown-tool.example.com" });
    assert.equal((await moderate({ entity_type: "software", entity_id: id, action: "remove" })).status, 200);
    assert.equal((await h.api("GET", `/software/${id}`)).status, 404);
    assert.equal((await h.api("GET", "/software?q=takedown")).body.total, 0);
    const removed = await h.api("GET", "/admin/software?review_status=removed", { as: "dave" });
    assert.ok(removed.body.items.some((s: any) => s.id === id && s.submitted_by.id === h.userId("bob")));
    assert.equal((await moderate({ entity_type: "software", entity_id: id, action: "mark_reviewed" })).body.error.code, "INVALID_STATE");

    const restored = await moderate({ entity_type: "software", entity_id: id, action: "restore" });
    assert.equal(restored.body.state, "unreviewed");
    assert.equal((await h.api("GET", `/software/${id}`)).status, 200);
  });

  test("a moderator can clear the images of a listing without removing it", async () => {
    const id = await publishSoftware(h, "bob", {
      name: "Wrong Pictures Tool",
      url: "https://wrong-pictures.example.com",
      icon_url: "https://cdn.example.com/icon.png",
      screenshots: ["https://cdn.example.com/shot.png"],
      translations: {
        zh: { description: "一个用来测试图片清理的工具，带有本地化截图。", capabilities: ["多级存放位置", "物品搜索", "照片附件"], screenshots: ["https://cdn.example.com/zh.png"] },
      },
    });
    assert.equal((await moderate({ entity_type: "software", entity_id: id, action: "clear_images" })).status, 200);
    const software = (await h.api("GET", `/software/${id}`)).body.software;
    assert.equal(software.icon_url, null);
    assert.deepEqual(software.screenshots, []);
    assert.equal(software.translations.zh.screenshots, undefined);
    assert.equal(software.translations.zh.capabilities.length, 3);
    assert.equal(software.review_status, "unreviewed");
    assert.equal((await moderate({ entity_type: "software", entity_id: id, action: "clear_images" })).body.error.code, "INVALID_STATE");
  });

  test("requests can be removed and restored; actions that do not apply are rejected", async () => {
    const id = await publishRequest(h, "alice", { title: "Request to moderate away" });
    const softwareId = await publishSoftware(h, "bob", { name: "Request Mod Tool", url: "https://request-mod-tool.example.com" });
    await publishProposal(h, "bob", id, softwareId);

    const flag = await moderate({ entity_type: "request", entity_id: id, action: "flag" });
    assert.equal(flag.status, 422);
    assert.equal(flag.body.error.details.fields[0].field, "action");
    assert.equal((await moderate({ entity_type: "request", entity_id: "req_missing", action: "remove" })).status, 404);

    assert.equal((await moderate({ entity_type: "request", entity_id: id, action: "remove" })).status, 200);
    assert.equal((await h.api("GET", `/requests/${id}`)).status, 404);
    assert.equal((await h.api("GET", `/requests/${id}`, { as: "alice" })).status, 404);

    const restored = await moderate({ entity_type: "request", entity_id: id, action: "restore" });
    assert.equal(restored.status, 200);
    // Restored with the status its proposals imply.
    assert.equal((await h.api("GET", `/requests/${id}`)).body.request.status, "proposals_available");
  });

  test("removing the accepted proposal un-resolves the request", async () => {
    const requestId = await publishRequest(h, "alice", { title: "Request with a bad accepted proposal" });
    const softwareId = await publishSoftware(h, "bob", { name: "Accepted Then Removed", url: "https://accepted-removed.example.com" });
    const proposalId = await publishProposal(h, "bob", requestId, softwareId);
    await h.api("POST", `/solutions/${proposalId}/confirm`, { as: "alice", key: newKey(), body: { verdict: "accepted", confirmed: true } });
    assert.equal((await h.api("GET", `/requests/${requestId}`)).body.request.status, "resolved");

    assert.equal((await moderate({ entity_type: "solution", entity_id: proposalId, action: "remove" })).status, 200);
    const request = (await h.api("GET", `/requests/${requestId}`)).body;
    assert.equal(request.request.status, "open");
    assert.equal(request.request.resolved_proposal_id, null);
    assert.deepEqual(request.proposals, []);
  });
});

describe("suspending accounts", () => {
  test("is previewed, blocks the account, and can be undone", async () => {
    const path = `/admin/users/${h.userId("carol")}/status`;
    const preview = await h.api("POST", path, { as: "dave", key: newKey(), body: { status: "suspended" } });
    assert.equal(preview.status, 428);
    assert.equal(preview.body.error.details.preview.status_after, "suspended");
    assert.equal((await h.api("GET", "/me", { as: "carol" })).status, 200);

    const key = newKey();
    const body = { status: "suspended", confirmed: true };
    assert.equal((await h.api("POST", path, { as: "dave", key, body })).status, 200);
    assert.equal((await h.api("POST", path, { as: "dave", key, body })).body.idempotent_replay, true);
    assert.equal((await h.api("GET", "/me", { as: "carol" })).status, 403);
    assert.equal((await publishRequestAs("carol")).status, 403);
    assert.equal((await h.api("POST", path, { as: "dave", key: newKey(), body })).body.error.code, "INVALID_STATE");

    assert.equal((await h.api("POST", path, { as: "dave", key: newKey(), body: { status: "active", confirmed: true } })).status, 200);
    assert.equal((await h.api("GET", "/me", { as: "carol" })).status, 200);
  });

  test("a moderator cannot suspend themselves, and bad IDs are rejected", async () => {
    const self = await h.api("POST", `/admin/users/${h.userId("dave")}/status`, { as: "dave", key: newKey(), body: { status: "suspended", confirmed: true } });
    assert.equal(self.status, 403);
    const bad = await h.api("POST", "/admin/users/not-a-uuid/status", { as: "dave", key: newKey(), body: { status: "suspended", confirmed: true } });
    assert.equal(bad.status, 422);
    const missing = await h.api("POST", "/admin/users/00000000-0000-4000-8000-0000000000ff/status", { as: "dave", key: newKey(), body: { status: "suspended", confirmed: true } });
    assert.equal(missing.status, 404);
  });
});

function publishRequestAs(as: string) {
  return h.api("POST", "/requests", {
    as,
    key: newKey(),
    body: { title: "Should not be published", goal: "A request from a suspended account", must_have: ["anything"], confirmed: true },
  });
}

describe("moderation allowance", () => {
  test("moderation writes have their own hourly limit, ten times the ordinary one", async () => {
    const id = await publishSoftware(h, "bob", { name: "Queue Tool", url: "https://queue-tool.example.com" });
    const dave = h.userId("dave");
    const used = async (prefix: string) =>
      Number((await h.db.query(`select coalesce(sum(count), 0)::int as n from rate_limits where bucket = $1::text`, [`${prefix}:${dave}`]))[0].n);
    const ordinaryBefore = await used("w");

    // More previews than the ordinary write limit allows in an hour.
    for (let i = 0; i < 125; i += 1) {
      const preview = await moderate({ entity_type: "software", entity_id: id, action: "mark_reviewed" }, { confirmed: false });
      assert.equal(preview.status, 428, `preview ${i + 1}`);
    }
    assert.equal((await moderate({ entity_type: "software", entity_id: id, action: "mark_reviewed" })).status, 200);
    // None of it counted against the moderator's ordinary writes.
    assert.equal(await used("w"), ordinaryBefore);

    // The allowance is still a limit.
    await h.db.query(`update rate_limits set count = 1200 where bucket = $1::text`, [`m:${dave}`]);
    const limited = await moderate({ entity_type: "software", entity_id: id, action: "flag" });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, "RATE_LIMITED");
    assert.equal(await softwareState(id), "reviewed");

    // Ordinary writes are unaffected by an exhausted moderation allowance.
    assert.equal((await report("dave", "software", id)).status < 300, true);
    await h.db.query(`delete from rate_limits where bucket = $1::text`, [`m:${dave}`]);
  });
});
