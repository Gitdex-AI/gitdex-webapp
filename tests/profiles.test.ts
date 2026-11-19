// Public author pages: a display name, counts, and the author's records through
// the ordinary searches. Reads only; nothing private leaves the profile.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createHarness, type Harness, publishProposal, publishRequest, publishSoftware, newKey } from "./helpers.ts";

let h: Harness;
before(async () => {
  h = await createHarness();
});
after(async () => {
  await h.close();
});

describe("author profiles", () => {
  test("a profile shows the name and counts, and the searches list that author's records", async () => {
    const mine = await publishSoftware(h, "bob", { name: "Bob Tool One", url: "https://bob-tool-one.example.com" });
    await publishSoftware(h, "bob", { name: "Bob Tool Two", url: "https://bob-tool-two.example.com" });
    await publishSoftware(h, "carol", { name: "Carol Tool", url: "https://carol-tool.example.com" });
    const request = await publishRequest(h, "alice", { title: "Something only alice asked for" });

    const bob = (await h.api("GET", `/software/${mine}`)).body.software.submitted_by;
    const alice = (await h.api("GET", `/requests/${request}`)).body.request.owner;

    const profile = await h.api("GET", `/users/${bob.id}`);
    assert.equal(profile.status, 200);
    assert.deepEqual(Object.keys(profile.body.user).sort(), ["display_name", "id", "url"]);
    assert.equal(profile.body.user.display_name, bob.display_name);
    assert.deepEqual(profile.body.counts, { software: 2, requests: 0, accepted_solutions: 0 });
    assert.doesNotMatch(JSON.stringify(profile.body), /email|provider|is_admin|suspended/);

    const listed = (await h.api("GET", `/software?submitted_by=${bob.id}&sort=name`)).body;
    assert.deepEqual(listed.items.map((s: any) => s.name), ["Bob Tool One", "Bob Tool Two"]);
    assert.equal((await h.api("GET", `/software?submitted_by=${alice.id}`)).body.total, 0);

    const asked = (await h.api("GET", `/requests?requested_by=${alice.id}&status=all`)).body;
    assert.deepEqual(asked.items.map((r: any) => r.id), [request]);
    assert.equal((await h.api("GET", `/requests?requested_by=${bob.id}&status=all`)).body.total, 0);
    assert.equal((await h.api("GET", `/users/${alice.id}`)).body.counts.requests, 1);

    // Only the requester's acceptance counts as a solved request for the author.
    const proposal = await publishProposal(h, "bob", request, mine);
    assert.equal((await h.api("GET", `/users/${bob.id}`)).body.counts.accepted_solutions, 0);
    const verdict = await h.api("POST", `/solutions/${proposal}/confirm`, { as: "alice", key: newKey(), body: { verdict: "accepted", confirmed: true } });
    assert.equal(verdict.status, 200);
    assert.equal((await h.api("GET", `/users/${bob.id}`)).body.counts.accepted_solutions, 1);
  });

  test("unknown and malformed ids", async () => {
    assert.equal((await h.api("GET", "/users/00000000-0000-4000-8000-000000000000")).status, 404);
    assert.equal((await h.api("GET", "/users/not-a-user")).status, 404);
    for (const path of ["/software?submitted_by=bob", "/requests?requested_by=1%20or%201=1"]) {
      const res = await h.api("GET", path);
      assert.equal(res.status, 422, path);
    }
  });

  test("the same reads are available to agents over MCP without signing in", async () => {
    const id = await publishSoftware(h, "bob", { name: "Bob MCP Tool", url: "https://bob-mcp-tool.example.com" });
    const bob = (await h.api("GET", `/software/${id}`)).body.software.submitted_by;
    const tools = (await h.mcp("tools/list", {}, { publicEndpoint: true })).body.result.tools;
    const tool = tools.find((t: any) => t.name === "get_user");
    assert.match(tool.description, /NO side effects; public/);
    assert.ok(tools.find((t: any) => t.name === "search_software").inputSchema.properties.submitted_by);
    assert.ok(tools.find((t: any) => t.name === "search_requests").inputSchema.properties.requested_by);
    const called = await h.tool("get_user", { user_id: bob.id }, { publicEndpoint: true });
    assert.equal(called.isError, false);
    assert.equal(called.data.user.display_name, bob.display_name);
  });
});
