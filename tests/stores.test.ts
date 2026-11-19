// Store listings on software records. The page puts the store's own badge on
// these links, so the service accepts nothing but the store's listing address.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { guideDocs } from "../supabase/functions/_shared/guide.ts";
import { BASE, createHarness, type Harness, newKey, publishSoftware, SAMPLE_SOFTWARE } from "./helpers.ts";

let h: Harness;
before(async () => {
  h = await createHarness();
});
after(async () => {
  await h.close();
});

const submit = (extra: Record<string, unknown>, as: string | null = "bob", key = newKey()) =>
  h.api("POST", "/software", { as, key, body: { ...SAMPLE_SOFTWARE, ...extra } });
const patch = (path: string, as: string | null, body: Record<string, unknown>, key = newKey()) =>
  h.api("PATCH", path, { as, key, body });

const APPLE = "https://apps.apple.com/us/app/store-tool/id1234567890";
const PLAY = "https://play.google.com/store/apps/details?id=com.example.storetool";

describe("store listings", () => {
  test("a submission previews the normalized listings, then publishes them once", async () => {
    const body = {
      name: "Store Tool",
      url: "https://store-tool.example.com",
      app_store_url: `${APPLE}?pt=119&ct=campaign&mt=8#reviews`,
      google_play_url: `${PLAY}&hl=en&referrer=utm_source%3Dx`,
    };
    const preview = await submit(body);
    assert.equal(preview.status, 428);
    assert.equal(preview.body.error.details.preview.will_be_public.app_store_url, APPLE);
    assert.equal(preview.body.error.details.preview.will_be_public.google_play_url, PLAY);
    assert.equal((await h.api("GET", "/software?q=store-tool")).body.total, 0);

    const key = newKey();
    const created = await submit({ ...body, confirmed: true }, "bob", key);
    assert.equal(created.status, 200);
    assert.equal((await submit({ ...body, confirmed: true }, "bob", key)).body.idempotent_replay, true);
    assert.equal((await submit({ ...body, confirmed: true })).body.error.code, "DUPLICATE_CANDIDATE");

    const detail = (await h.api("GET", `/software/${created.body.software_id}`)).body.software;
    assert.equal(detail.app_store_url, APPLE);
    assert.equal(detail.google_play_url, PLAY);
    const listed = (await h.api("GET", "/software?q=store-tool")).body.items[0];
    assert.equal(listed.app_store_url, APPLE);
    assert.equal(listed.google_play_url, PLAY);
  });

  test("a record without listings has none, and signing in is required", async () => {
    const id = await publishSoftware(h, "bob", { name: "No Store Tool", url: "https://no-store-tool.example.com" });
    const detail = (await h.api("GET", `/software/${id}`)).body.software;
    assert.equal(detail.app_store_url, null);
    assert.equal(detail.google_play_url, null);
    const anonymous = await submit({ url: "https://anon-store.example.com", app_store_url: APPLE, confirmed: true }, null);
    assert.equal(anonymous.status, 401);
  });

  test("only the store's own listing address is accepted", async () => {
    const bad = {
      app_store_url: [
        "http://apps.apple.com/us/app/x/id123",
        "https://apps.apple.com.evil.example/us/app/x/id123",
        "https://evil.example/?u=https://apps.apple.com/us/app/x/id123",
        "https://user@apps.apple.com/us/app/x/id123",
        "https://apps.apple.com:8443/us/app/x/id123",
        "https://apps.apple.com/us/developer/someone/id123",
        "https://apps.apple.com/us/app/x/id123/../../../story/id9",
        "https://itunes.apple.com/us/app/x/id123",
        "javascript:alert(1)",
        PLAY,
        42,
      ],
      google_play_url: [
        "http://play.google.com/store/apps/details?id=com.example.app",
        "https://play.google.com.evil.example/store/apps/details?id=com.example.app",
        "https://play.google.com/store/apps/dev?id=123",
        "https://play.google.com/store/apps/details",
        "https://play.google.com/store/apps/details?id=not a package",
        "https://play.google.com/store/apps/details?id=com.example.app%26url%3Dhttps://evil.example",
        APPLE,
      ],
    };
    for (const [field, values] of Object.entries(bad)) {
      for (const value of values) {
        const res = await submit({ url: "https://bad-store.example.com", [field]: value, confirmed: true });
        assert.equal(res.status, 422, `${field}: ${value}`);
        assert.equal(res.body.error.details.fields[0].field, field, String(value));
      }
    }
    assert.equal((await h.api("GET", "/software?q=bad-store")).body.total, 0);

    // The short forms Apple itself hands out are listings too.
    for (const [given, stored] of [
      ["https://apps.apple.com/app/id1234567890", "https://apps.apple.com/app/id1234567890"],
      ["https://apps.apple.com/cn/app/%E9%A2%84%E6%B5%8B/id1234567890/", "https://apps.apple.com/cn/app/%E9%A2%84%E6%B5%8B/id1234567890"],
    ]) {
      const res = await submit({ url: "https://short-form.example.com", app_store_url: given });
      assert.equal(res.body.error.details.preview.will_be_public.app_store_url, stored);
    }
  });

  test("the submitter adds, changes and removes a listing; each edit is a version", async () => {
    const id = await publishSoftware(h, "bob", { name: "Later Store Tool", url: "https://later-store-tool.example.com" });

    const stranger = await patch(`/software/${id}`, "carol", { app_store_url: APPLE, confirmed: true });
    assert.equal(stranger.status, 403);
    const invalid = await patch(`/software/${id}`, "bob", { google_play_url: "https://evil.example/app", confirmed: true });
    assert.equal(invalid.status, 422);
    assert.equal(invalid.body.error.details.fields[0].field, "google_play_url");

    const preview = await patch(`/software/${id}`, "bob", { app_store_url: `${APPLE}?mt=8` });
    assert.equal(preview.status, 428);
    assert.equal(preview.body.error.details.preview.will_be_public.app_store_url, APPLE);
    assert.equal(preview.body.error.details.preview.replaces.app_store_url, null);
    assert.equal((await h.api("GET", `/software/${id}`)).body.software.app_store_url, null);

    const key = newKey();
    const body = { app_store_url: APPLE, google_play_url: PLAY, confirmed: true };
    const added = await patch(`/software/${id}`, "bob", body, key);
    assert.equal(added.status, 200);
    assert.deepEqual(added.body.changed, ["app_store_url", "google_play_url"]);
    assert.equal((await patch(`/software/${id}`, "bob", body, key)).body.idempotent_replay, true);
    assert.equal((await patch(`/software/${id}`, "bob", body)).body.error.code, "INVALID_STATE");

    const removed = await patch(`/software/${id}`, "bob", { google_play_url: null, confirmed: true });
    assert.deepEqual(removed.body.changed, ["google_play_url"]);
    const detail = (await h.api("GET", `/software/${id}`)).body.software;
    assert.equal(detail.app_store_url, APPLE);
    assert.equal(detail.google_play_url, null);
    assert.equal(detail.version, 3);

    const past = (await h.api("GET", `/history?entity_type=software&entity_id=${id}`)).body.earlier_versions;
    assert.equal(past[0].content.google_play_url, PLAY);
    assert.equal(past[1].content.app_store_url, null);
  });

  test("agents are told about the fields and not to guess them", async () => {
    const tools = (await h.mcp("tools/list", {}, { as: "bob" })).body.result.tools;
    const schema = (name: string) => tools.find((t: any) => t.name === name).inputSchema.properties;
    for (const name of ["submit_software", "update_software"]) {
      assert.match(schema(name).app_store_url.description, /apps\.apple\.com/);
      assert.match(schema(name).google_play_url.description, /play\.google\.com/);
    }
    assert.match(guideDocs(BASE).submit, /app_store_url/);
    assert.match(guideDocs(BASE).submit, /Never guess one/);
  });
});
