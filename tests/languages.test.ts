// Two-language records and software images, through the real HTTP application.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { guideDocs, mcpInstructions } from "../supabase/functions/_shared/guide.ts";
import { localize } from "../supabase/functions/_shared/languages.ts";
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

const SOFTWARE_ZH = {
  description: "家庭物品收纳工具，支持房间、柜子和抽屉的多级位置。",
  capabilities: ["多级存放位置", "物品搜索", "照片附件"],
};

const REQUEST_ZH = {
  title: "免费的 iOS 家庭物品收纳应用",
  goal: "按房间、柜子和抽屉查找家里的物品",
  must_have: ["多级存放位置", "快速搜索物品", "核心功能免费"],
  nice_to_have: ["iCloud 同步", "照片附件"],
  price_constraint: "不要订阅制",
};

describe("publishing in two languages", () => {
  test("software: the preview shows both versions and nothing is written", async () => {
    const res = await h.api("POST", "/software", {
      as: "bob",
      key: newKey(),
      body: { ...SAMPLE_SOFTWARE, name: "Bilingual Preview", url: "https://bilingual-preview.example.com", translations: { zh: SOFTWARE_ZH } },
    });
    assert.equal(res.status, 428);
    const details = res.body.error.details;
    assert.equal(details.preview.will_be_public.language, "en");
    assert.deepEqual(details.preview.will_be_public.translations.zh, SOFTWARE_ZH);
    assert.equal(details.missing_translations, undefined);
    assert.equal((await h.api("GET", "/software?q=bilingual")).body.total, 0);
  });

  test("a single-language preview tells the caller which language is missing", async () => {
    const software = await h.api("POST", "/software", {
      as: "bob",
      key: newKey(),
      body: { ...SAMPLE_SOFTWARE, url: "https://one-language.example.com" },
    });
    assert.deepEqual(software.body.error.details.missing_translations, ["zh"]);
    assert.match(software.body.error.details.translation_notice, /translations\.zh/);

    const request = await h.api("POST", "/requests", { as: "alice", key: newKey(), body: { ...SAMPLE_REQUEST, ...REQUEST_ZH } });
    assert.equal(request.body.error.details.preview.will_be_public.language, "zh");
    assert.deepEqual(request.body.error.details.missing_translations, ["en"]);

    const requestId = await publishRequest(h, "alice", { title: "Hint check request" });
    const softwareId = await publishSoftware(h, "bob", { name: "Hint Tool", url: "https://hint-tool.example.com" });
    const proposal = await h.api("POST", "/solutions", {
      as: "bob",
      key: newKey(),
      body: { request_id: requestId, software_id: softwareId, coverage_notes: "Covers nested locations and search." },
    });
    assert.deepEqual(proposal.body.error.details.missing_translations, ["zh"]);
  });

  test("both versions are stored, returned and searchable in either language", async () => {
    const id = await publishSoftware(h, "bob", {
      name: "Shelfmate",
      url: "https://shelfmate.example.com",
      pricing_notes: "Free for up to 200 items",
      translations: { zh: { ...SOFTWARE_ZH, pricing_notes: "200 件物品以内免费" } },
    });
    const detail = (await h.api("GET", `/software/${id}`)).body.software;
    assert.equal(detail.language, "en");
    assert.equal(detail.description, SAMPLE_SOFTWARE.description);
    assert.equal(detail.translations.zh.pricing_notes, "200 件物品以内免费");

    const zh = await h.api("GET", `/software?q=${encodeURIComponent("抽屉")}`);
    assert.deepEqual(zh.body.items.map((s: any) => s.id), [id]);
    assert.deepEqual(zh.body.items[0].matched_fields, ["description"]);
    const en = await h.api("GET", "/software?q=shelfmate");
    assert.equal(en.body.items[0].id, id);

    // What a page shows a reader of each language: one version, never a mix.
    const shownZh = localize(detail, "zh");
    assert.equal(shownZh.description, SOFTWARE_ZH.description);
    assert.deepEqual(shownZh.capabilities, SOFTWARE_ZH.capabilities);
    assert.equal(shownZh.shown_language, "zh");
    assert.equal(localize(detail, "en").description, SAMPLE_SOFTWARE.description);
  });

  test("a request written in Chinese carries its English version", async () => {
    const en = {
      title: SAMPLE_REQUEST.title,
      goal: SAMPLE_REQUEST.goal,
      must_have: SAMPLE_REQUEST.must_have,
      nice_to_have: SAMPLE_REQUEST.nice_to_have,
      price_constraint: SAMPLE_REQUEST.price_constraint,
    };
    const id = await publishRequest(h, "alice", { ...REQUEST_ZH, language: "zh", translations: { en } });
    const request = (await h.api("GET", `/requests/${id}`)).body.request;
    assert.equal(request.language, "zh");
    assert.equal(request.title, REQUEST_ZH.title);
    assert.deepEqual(request.translations.en.must_have, SAMPLE_REQUEST.must_have);
    const found = await h.api("GET", "/requests?q=drawer");
    assert.ok(found.body.items.some((r: any) => r.id === id));
    assert.equal(localize(request, "en").title, SAMPLE_REQUEST.title);
  });

  test("a proposal carries both versions and still resolves nothing", async () => {
    const requestId = await publishRequest(h, "alice", { title: "Bilingual proposal request" });
    const softwareId = await publishSoftware(h, "bob", { name: "Proposal Tool", url: "https://proposal-tool.example.com" });
    const res = await h.api("POST", "/solutions", {
      as: "bob",
      key: newKey(),
      body: {
        request_id: requestId,
        software_id: softwareId,
        coverage_notes: "Covers nested locations and search; core features are free.",
        unmet_requirements: ["iCloud sync not verified"],
        translations: { zh: { coverage_notes: "支持多级位置和搜索，核心功能免费。", unmet_requirements: ["iCloud 同步未经验证"] } },
        confirmed: true,
      },
    });
    assert.equal(res.status, 200);
    const detail = await h.api("GET", `/requests/${requestId}`);
    assert.equal(detail.body.request.status, "proposals_available");
    assert.deepEqual(detail.body.proposals[0].translations.zh.unmet_requirements, ["iCloud 同步未经验证"]);
    const solution = (await h.api("GET", `/solutions/${res.body.proposal_id}`)).body.solution;
    assert.equal(solution.language, "en");
    assert.equal(solution.request.language, "en");
  });

  test("a translation must mirror the original", async () => {
    const submit = (translations: unknown, extra: Record<string, unknown> = {}) =>
      h.api("POST", "/software", {
        as: "bob",
        key: newKey(),
        body: { ...SAMPLE_SOFTWARE, url: "https://mirror-check.example.com", ...extra, translations, confirmed: true },
      });
    const fieldsOf = (res: any) => res.body.error.details.fields.map((f: any) => f.field);

    const shortList = await submit({ zh: { ...SOFTWARE_ZH, capabilities: ["多级存放位置"] } });
    assert.equal(shortList.status, 422);
    assert.deepEqual(fieldsOf(shortList), ["translations.zh.capabilities"]);

    const missingText = await submit({ zh: { capabilities: SOFTWARE_ZH.capabilities } });
    assert.deepEqual(fieldsOf(missingText), ["translations.zh.description"]);

    const extraField = await submit({ zh: { ...SOFTWARE_ZH, pricing_notes: "免费", name: "货架通" } });
    assert.deepEqual(fieldsOf(extraField).sort(), ["translations.zh.name", "translations.zh.pricing_notes"]);

    const untranslated = await submit({ zh: { description: SAMPLE_SOFTWARE.description, capabilities: SAMPLE_SOFTWARE.capabilities } });
    assert.deepEqual(fieldsOf(untranslated), ["translations.zh.description"]);

    assert.deepEqual(fieldsOf(await submit({ en: SOFTWARE_ZH })), ["translations.en"]);
    assert.deepEqual(fieldsOf(await submit({ fr: SOFTWARE_ZH })), ["translations.fr"]);
    assert.deepEqual(fieldsOf(await submit(undefined, { language: "zh" })), ["language"]);
    assert.equal((await h.api("GET", "/software?q=mirror-check")).body.total, 0);
  });
});

describe("set_translations", () => {
  const body = (entityId: string, extra: Record<string, unknown> = {}) => ({
    entity_type: "software",
    entity_id: entityId,
    translations: { zh: SOFTWARE_ZH },
    ...extra,
  });

  test("is rejected without sign-in", async () => {
    const res = await h.api("POST", "/translations", { key: newKey(), body: body("sw_x", { confirmed: true }) });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "AUTH_REQUIRED");
  });

  test("without confirmation nothing is written and the preview shows original and translation", async () => {
    const id = await publishSoftware(h, "bob", { name: "Later Tool", url: "https://later-tool.example.com" });
    const res = await h.api("POST", "/translations", { as: "bob", key: newKey(), body: body(id) });
    assert.equal(res.status, 428);
    const preview = res.body.error.details.preview;
    assert.equal(preview.will_be_public.original.description, SAMPLE_SOFTWARE.description);
    assert.deepEqual(preview.will_be_public.translations.zh, SOFTWARE_ZH);
    assert.deepEqual(preview.replaces_existing, []);
    assert.deepEqual((await h.api("GET", `/software/${id}`)).body.software.translations, {});
  });

  test("only the author can translate a record", async () => {
    const softwareId = await publishSoftware(h, "bob", { name: "Owned Tool", url: "https://owned-tool.example.com" });
    const stranger = await h.api("POST", "/translations", { as: "carol", key: newKey(), body: body(softwareId, { confirmed: true }) });
    assert.equal(stranger.status, 403);
    assert.equal(stranger.body.error.code, "FORBIDDEN");
    assert.deepEqual((await h.api("GET", `/software/${softwareId}`)).body.software.translations, {});

    const requestId = await publishRequest(h, "alice", { title: "Owned request title" });
    const proposalId = await publishProposal(h, "bob", requestId, softwareId);
    // The requester owns the request, not the proposer's text.
    const requester = await h.api("POST", "/translations", {
      as: "alice",
      key: newKey(),
      body: {
        entity_type: "solution",
        entity_id: proposalId,
        translations: { zh: { coverage_notes: "支持多级位置和搜索，核心功能免费。", unmet_requirements: ["iCloud 同步未经验证"] } },
        confirmed: true,
      },
    });
    assert.equal(requester.status, 403);
  });

  test("a confirmed translation is published, searchable, and applied once on retry", async () => {
    const id = await publishSoftware(h, "bob", { name: "Retry Tool", url: "https://retry-tool.example.com" });
    const key = newKey();
    const first = await h.api("POST", "/translations", { as: "bob", key, body: body(id, { confirmed: true }) });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.translations.zh, SOFTWARE_ZH);
    const second = await h.api("POST", "/translations", { as: "bob", key, body: body(id, { confirmed: true }) });
    assert.equal(second.status, 200);
    assert.equal(second.body.idempotent_replay, true);
    const audits = await h.db.query(`select 1 as x from audit_events where event_type = 'translations.set' and entity_id = $1`, [id]);
    assert.equal(audits.length, 1);

    const detail = (await h.api("GET", `/software/${id}`)).body.software;
    assert.equal(detail.description, SAMPLE_SOFTWARE.description);
    assert.equal(detail.translations.zh.description, SOFTWARE_ZH.description);
    const found = await h.api("GET", `/software?q=${encodeURIComponent("柜子")}`);
    assert.ok(found.body.items.some((s: any) => s.id === id));
    assert.ok((await h.api("GET", "/software?q=retry")).body.items.some((s: any) => s.id === id));
  });

  test("a second translation in the same language replaces the first", async () => {
    const id = await publishSoftware(h, "bob", { name: "Replace Tool", url: "https://replace-tool.example.com", translations: { zh: SOFTWARE_ZH } });
    const corrected = { ...SOFTWARE_ZH, description: "家庭物品收纳工具，可按房间、柜子、抽屉逐级整理。" };
    const preview = await h.api("POST", "/translations", { as: "bob", key: newKey(), body: body(id, { translations: { zh: corrected } }) });
    assert.deepEqual(preview.body.error.details.preview.replaces_existing, ["zh"]);
    const res = await h.api("POST", "/translations", { as: "bob", key: newKey(), body: body(id, { translations: { zh: corrected }, confirmed: true }) });
    assert.equal(res.status, 200);
    assert.equal((await h.api("GET", `/software/${id}`)).body.software.translations.zh.description, corrected.description);
  });

  test("the same rules hold for requests and over MCP", async () => {
    const requestId = await publishRequest(h, "alice", { title: "Translate me later request" });
    const zh = { ...REQUEST_ZH };
    const args = { entity_type: "request", entity_id: requestId, translations: { zh }, idempotency_key: newKey() };
    const preview = await h.tool("set_translations", args, { as: "alice" });
    assert.equal(preview.data.error.code, "CONFIRMATION_REQUIRED");
    const wrong = await h.tool("set_translations", { ...args, translations: { zh: { ...zh, must_have: ["多级存放位置"] } }, confirmed: true }, { as: "alice" });
    assert.equal(wrong.data.error.code, "VALIDATION_FAILED");
    assert.equal(wrong.data.error.details.fields[0].field, "translations.zh.must_have");
    const done = await h.tool("set_translations", { ...args, confirmed: true }, { as: "alice" });
    assert.equal(done.isError, false);
    const request = (await h.api("GET", `/requests/${requestId}`)).body.request;
    assert.equal(request.status, "open");
    assert.equal(request.translations.zh.title, REQUEST_ZH.title);
    const found = await h.api("GET", `/requests?q=${encodeURIComponent("抽屉")}`);
    assert.ok(found.body.items.some((r: any) => r.id === requestId));
  });

  test("unknown and withdrawn records cannot be translated", async () => {
    const missing = await h.api("POST", "/translations", { as: "bob", key: newKey(), body: body("sw_missing", { confirmed: true }) });
    assert.equal(missing.status, 404);
    const requestId = await publishRequest(h, "alice", { title: "Withdrawn proposal request" });
    const softwareId = await publishSoftware(h, "bob", { name: "Withdrawn Tool", url: "https://withdrawn-tool.example.com" });
    const proposalId = await publishProposal(h, "bob", requestId, softwareId);
    await h.api("POST", `/solutions/${proposalId}/withdraw`, { as: "bob", key: newKey(), body: { confirmed: true } });
    const res = await h.api("POST", "/translations", {
      as: "bob",
      key: newKey(),
      body: { entity_type: "solution", entity_id: proposalId, translations: { zh: { coverage_notes: "支持多级位置和搜索，核心功能免费。", unmet_requirements: ["未验证"] } }, confirmed: true },
    });
    assert.equal(res.body.error.code, "INVALID_STATE");
  });
});

describe("software images", () => {
  test("icon and screenshots are previewed, stored and returned in order", async () => {
    const images = {
      icon_url: "https://cdn.picturetool.example.com/icon.png?v=2",
      screenshots: ["https://github.com/acme/picturetool/raw/main/docs/home.png", "https://cdn.picturetool.example.com/shots/search.png"],
    };
    const base = { ...SAMPLE_SOFTWARE, name: "Picture Tool", url: "https://picturetool.example.com", ...images };
    const preview = await h.api("POST", "/software", { as: "bob", key: newKey(), body: base });
    assert.equal(preview.body.error.details.preview.will_be_public.icon_url, images.icon_url);
    assert.deepEqual(preview.body.error.details.preview.will_be_public.screenshots, images.screenshots);

    const id = await publishSoftware(h, "bob", base);
    const detail = (await h.api("GET", `/software/${id}`)).body.software;
    assert.equal(detail.icon_url, images.icon_url);
    assert.deepEqual(detail.screenshots, images.screenshots);
    const listed = (await h.api("GET", "/software?q=picture")).body.items[0];
    assert.equal(listed.icon_url, images.icon_url);
  });

  test("a translation can bring screenshots in its own language; without them readers see the original's", async () => {
    const screenshots = ["https://imgcdn-zzq.example.com/en/home.png", "https://imgcdn-zzq.example.com/en/search.png"];
    const zhShots = ["https://imgcdn-zzq.example.com/zh/home.png"];
    const id = await publishSoftware(h, "bob", {
      name: "Local Shots",
      url: "https://localshots.example.com",
      screenshots,
      translations: { zh: { ...SOFTWARE_ZH, screenshots: zhShots } },
    });
    const software = (await h.api("GET", `/software/${id}`)).body.software;
    assert.deepEqual(software.screenshots, screenshots);
    assert.deepEqual(localize(software, "zh").screenshots, zhShots);
    assert.deepEqual(localize(software, "en").screenshots, screenshots);
    // Image URLs are not search text.
    assert.equal((await h.api("GET", "/software?q=imgcdn-zzq")).body.total, 0);

    const shared = await publishSoftware(h, "bob", { name: "Shared Shots", url: "https://sharedshots.example.com", screenshots, translations: { zh: SOFTWARE_ZH } });
    const fallback = (await h.api("GET", `/software/${shared}`)).body.software;
    assert.equal(fallback.translations.zh.screenshots, undefined);
    assert.deepEqual(localize(fallback, "zh").screenshots, screenshots);

    const bad = await h.api("POST", "/software", {
      as: "bob",
      key: newKey(),
      body: { ...SAMPLE_SOFTWARE, url: "https://badlocalshots.example.com", translations: { zh: { ...SOFTWARE_ZH, screenshots: ["http://cdn.example.com/zh.png"] } }, confirmed: true },
    });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error.details.fields[0].field, "translations.zh.screenshots[0]");
  });

  test("software without images is still accepted", async () => {
    const id = await publishSoftware(h, "bob", { name: "Plain Tool", url: "https://plain-tool.example.com" });
    const detail = (await h.api("GET", `/software/${id}`)).body.software;
    assert.equal(detail.icon_url, null);
    assert.deepEqual(detail.screenshots, []);
  });

  test("only public https image URLs are accepted, at most eight screenshots", async () => {
    const submit = (extra: Record<string, unknown>) =>
      h.api("POST", "/software", { as: "bob", key: newKey(), body: { ...SAMPLE_SOFTWARE, url: "https://bad-images.example.com", ...extra, confirmed: true } });
    for (const icon_url of ["http://cdn.example.com/icon.png", "javascript:alert(1)", "data:image/png;base64,AAAA", "https://192.168.1.4/icon.png", "https://localhost/icon.png"]) {
      const res = await submit({ icon_url });
      assert.equal(res.status, 422, icon_url);
      assert.equal(res.body.error.details.fields[0].field, "icon_url");
    }
    const mixed = await submit({ screenshots: ["https://cdn.example.com/a.png", "http://cdn.example.com/b.png"] });
    assert.equal(mixed.body.error.details.fields[0].field, "screenshots[1]");
    const many = await submit({ screenshots: Array.from({ length: 9 }, (_v, i) => `https://cdn.example.com/${i}.png`) });
    assert.equal(many.body.error.details.fields[0].field, "screenshots");
    assert.equal((await h.api("GET", "/software?q=bad-images")).body.total, 0);
  });
});

describe("agent-facing contract", () => {
  test("the guide tells agents to publish both languages and how", () => {
    const docs = guideDocs(BASE);
    for (const name of ["guide", "request", "submit", "solve"]) {
      assert.match(docs[name], /## Two languages/, name);
      assert.match(docs[name], /Never put two languages in one field/, name);
    }
    assert.match(docs.submit, /icon_url/);
    assert.match(docs.submit, /Never invent, generate or borrow images/);
    assert.match(mcpInstructions(BASE), /Publish in two languages/);
  });

  test("publishing tools expose language, translations and images", async () => {
    const tools = (await h.mcp("tools/list", {}, { as: "alice" })).body.result.tools;
    const schema = (name: string) => tools.find((t: any) => t.name === name).inputSchema.properties;
    assert.deepEqual(schema("submit_software").language.enum, ["en", "zh"]);
    assert.deepEqual(Object.keys(schema("submit_software").translations.properties.zh.properties), ["description", "capabilities", "pricing_notes", "screenshots"]);
    assert.ok(schema("create_request").translations.properties.en.properties.must_have);
    assert.ok(schema("propose_solution").translations.properties.zh.properties.unmet_requirements);
    assert.ok(schema("submit_software").icon_url);
    assert.equal(schema("submit_software").screenshots.maxItems, 8);
    const set = tools.find((t: any) => t.name === "set_translations");
    assert.match(set.description, /REQUIRES sign-in as the user who published the record/);
    assert.ok(set.inputSchema.properties.confirmed);
    assert.ok(set.inputSchema.required.includes("idempotency_key"));
  });
});
