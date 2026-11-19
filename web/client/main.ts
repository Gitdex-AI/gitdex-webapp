// Browser script: sign-in, and the light forms that call the same REST API
// agents use. Every publishing form goes through the server's preview step
// before anything is written. User-submitted text is only ever inserted with
// textContent.

import { createClient, type Session } from "@supabase/supabase-js";

interface Boot {
  supabaseUrl: string;
  supabaseKey: string;
  providers: string[];
  lang: string;
  s: Record<string, string>;
}

const boot = (window as unknown as { __GITDEX__: Boot }).__GITDEX__;
const S = boot.s;
const supabase = createClient(boot.supabaseUrl, boot.supabaseKey, {
  auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
});

type Child = Node | string | null | undefined | false;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === "function") node.addEventListener(key, value);
    else if (typeof value === "boolean") {
      if (value) node.setAttribute(key, "");
    } else node.setAttribute(key, value);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

/** Internal links only: record IDs and slugs from the API are path-safe. */
function link(path: string, text: string): HTMLAnchorElement {
  return el("a", { href: path.startsWith("/") ? path : "/" }, text);
}

let session: Session | null = null;

async function api(method: string, path: string, body?: unknown, key?: string): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "x-gitdex-client": "web" };
  if (session) headers.authorization = `Bearer ${session.access_token}`;
  if (key) headers["idempotency-key"] = key;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

function goToLogin(): void {
  location.href = `/login?redirect=${encodeURIComponent(location.pathname + location.search)}`;
}

function safeRedirect(): string {
  const target = new URLSearchParams(location.search).get("redirect") ?? "/account";
  return target.startsWith("/") && !target.startsWith("//") ? target : "/account";
}

function show(selector: string, visible: boolean): void {
  document.querySelectorAll<HTMLElement>(selector).forEach((node) => (node.hidden = !visible));
}

// ---- preview dialog -------------------------------------------------------

function humanize(key: string): string {
  return key.replace(/_/g, " ");
}

function renderValue(value: unknown): Node {
  if (value === null || value === undefined || value === "") return document.createTextNode("—");
  if (Array.isArray(value)) {
    if (!value.length) return document.createTextNode("—");
    return el("ul", {}, ...value.map((item) => el("li", {}, renderValue(item))));
  }
  if (typeof value === "object") {
    const list = el("dl", { class: "preview-list" });
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      list.append(el("dt", {}, humanize(key)), el("dd", {}, renderValue(inner)));
    }
    return list;
  }
  return document.createTextNode(String(value));
}

function confirmDialog(details: any): Promise<boolean> {
  const dialog = document.getElementById("dialog") as HTMLDialogElement;
  const preview = details?.preview ?? {};
  const publishing = Boolean(preview.will_be_public);
  return new Promise((resolve) => {
    const close = (answer: boolean) => {
      dialog.close();
      resolve(answer);
    };
    const warnings: string[] = details?.privacy_warnings ?? [];
    const similar: any[] = details?.similar_requests ?? [];
    const sameSite: any[] = details?.same_site_records ?? [];
    const parts: Child[] = [
      el("h2", {}, S.previewTitle),
      el("p", { class: "lead" }, publishing ? S.previewLead : S.confirmLead),
      warnings.length ? el("div", { class: "warn" }, el("b", {}, S.privacy), el("ul", {}, ...warnings.map((w) => el("li", {}, w)))) : null,
      similar.length
        ? el("div", { class: "warn" }, el("p", {}, S.similarRequests), el("ul", {}, ...similar.map((r) => el("li", {}, link(`/requests/${r.request_id}`, r.title)))))
        : null,
      sameSite.length
        ? el("div", { class: "warn" }, el("p", {}, S.sameSite), el("ul", {}, ...sameSite.map((r) => el("li", {}, link(`/software/${r.software_id}`, r.name)))))
        : null,
      el("div", { class: "preview" }, renderValue(publishing ? preview.will_be_public : preview)),
      el(
        "div",
        { class: "dialog-actions" },
        el("button", { class: "button", type: "button", click: () => close(false) }, S.cancel),
        el("button", { class: "button primary", type: "button", click: () => close(true) }, publishing ? S.publish : S.confirm),
      ),
    ];
    dialog.replaceChildren(...(parts.filter(Boolean) as Node[]));
    dialog.addEventListener("cancel", () => resolve(false), { once: true });
    dialog.showModal();
  });
}

// ---- generic write forms --------------------------------------------------

function formBody(form: HTMLFormElement): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of Array.from(form.elements) as (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[]) {
    if (!field.name) continue;
    if (field instanceof HTMLInputElement && field.type === "radio" && !field.checked) continue;
    const value = field.value.trim();
    if (!value) continue;
    const kind = field.dataset.kind;
    if (kind === "lines") body[field.name] = value.split("\n").map((v) => v.trim()).filter(Boolean);
    else if (kind === "csv") body[field.name] = value.split(/[,，]/).map((v) => v.trim()).filter(Boolean);
    else body[field.name] = value;
  }
  return body;
}

function showError(form: HTMLFormElement, error: any): void {
  let box = form.querySelector<HTMLElement>(".form-error");
  if (!box) {
    box = el("div", { class: "form-error", role: "alert" });
    form.append(box);
  }
  const children: Child[] = [];
  if (error?.code === "DUPLICATE_CANDIDATE") {
    children.push(el("p", {}, S.duplicate));
    const list = el("ul", {});
    for (const candidate of error.details?.candidates ?? []) {
      const path = candidate.software_id ? `/software/${candidate.software_id}` : `/solutions/${candidate.proposal_id}`;
      list.append(el("li", {}, link(path, candidate.name ?? candidate.proposal_id)));
    }
    children.push(list);
  } else {
    children.push(el("p", {}, error?.message ?? S.error));
    const fields: any[] = error?.details?.fields ?? [];
    if (fields.length) children.push(el("ul", {}, ...fields.map((f) => el("li", {}, `${humanize(f.field)}: ${f.issue}`))));
  }
  box.replaceChildren(...children.filter(Boolean) as Node[]);
}

async function runWrite(form: HTMLFormElement): Promise<void> {
  if (!session) return goToLogin();
  const [method, path] = (form.dataset.write ?? "").split(" ");
  const body = formBody(form);
  const key = crypto.randomUUID();
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
  form.querySelector(".form-error")?.remove();
  if (button) button.disabled = true;
  try {
    let res = await api(method, path, method === "DELETE" ? undefined : body, key);
    if (res.status === 428 && res.body?.error?.code === "CONFIRMATION_REQUIRED") {
      // Nothing has been written yet: show exactly what would become public.
      const approved = await confirmDialog(res.body.error.details);
      if (!approved) return;
      res = await api(method, path, { ...body, confirmed: true }, key);
    }
    if (res.status === 401) return goToLogin();
    if (res.status >= 400) return showError(form, res.body?.error);

    const success = form.dataset.success ?? "reload";
    if (success === "redirect" && typeof res.body?.url === "string") {
      location.href = new URL(res.body.url).pathname;
    } else if (success.startsWith("goto:")) {
      location.href = success.slice("goto:".length);
    } else if (success.startsWith("message:")) {
      form.replaceWith(el("p", { class: "notice" }, S[success.slice("message:".length)] ?? S.saved));
    } else {
      location.reload();
    }
  } catch {
    showError(form, null);
  } finally {
    if (button) button.disabled = false;
  }
}

function bindForms(): void {
  document.querySelectorAll<HTMLFormElement>("form[data-write]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void runWrite(form);
    });
  });
  document.querySelectorAll<HTMLInputElement>("input[data-software-picker]").forEach((input) => {
    let timer = 0;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = window.setTimeout(async () => {
        const query = input.value.trim();
        if (query.length < 2) return;
        const res = await api("GET", `/software?q=${encodeURIComponent(query)}&limit=8`);
        const list = document.getElementById(input.getAttribute("list") ?? "");
        if (!list || res.status !== 200) return;
        list.replaceChildren(...res.body.items.map((s: any) => el("option", { value: s.slug, label: `${s.name} (${s.canonical_url})` })));
      }, 250);
    });
  });
}

// ---- copy-a-prompt buttons and the screenshot viewer -----------------------

function bindCopy(): void {
  document.querySelectorAll<HTMLButtonElement>("button[data-copy]").forEach((button) => {
    const label = button.textContent ?? "";
    let timer = 0;
    button.addEventListener("click", async () => {
      const text = button.dataset.copy ?? "";
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // No clipboard access (permission, older browser): show the text selected, ready to copy by hand.
        let box = button.parentElement?.parentElement?.querySelector<HTMLTextAreaElement>("textarea.copy-fallback");
        if (!box) {
          box = el("textarea", { class: "copy-fallback", readonly: true, rows: "4", "aria-label": label });
          button.parentElement?.after(box);
        }
        box.value = text;
        box.focus();
        box.select();
        return;
      }
      button.textContent = S.copied;
      clearTimeout(timer);
      timer = window.setTimeout(() => (button.textContent = label), 2500);
    });
  });
}

/** Screenshots open in place. The image is still loaded straight from the submitter's URL, without a referrer. */
function bindLightbox(): void {
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>(".shots a")).filter((a) => a.href.startsWith("https://"));
  if (!links.length) return;
  let index = 0;
  const image = el("img", { alt: "", referrerpolicy: "no-referrer" });
  const count = el("span", { class: "lightbox-count" });
  const go = (to: number) => {
    index = (to + links.length) % links.length;
    image.src = links[index].href;
    image.alt = links[index].querySelector("img")?.alt ?? "";
    count.textContent = `${index + 1} / ${links.length}`;
  };
  const many = links.length > 1;
  const dialog = el(
    "dialog",
    { class: "lightbox" },
    many ? el("button", { class: "lightbox-nav", type: "button", "aria-label": S.previous, click: () => go(index - 1) }, "‹") : null,
    el("figure", {}, image, el("figcaption", {}, count)),
    many ? el("button", { class: "lightbox-nav", type: "button", "aria-label": S.next, click: () => go(index + 1) }, "›") : null,
    el("button", { class: "lightbox-close", type: "button", "aria-label": S.close, click: () => dialog.close() }, "×"),
  );
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("keydown", (event) => {
    if (!many) return;
    if (event.key === "ArrowLeft") go(index - 1);
    if (event.key === "ArrowRight") go(index + 1);
  });
  document.body.append(dialog);
  links.forEach((a, i) => {
    a.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      go(i);
      dialog.showModal();
    });
  });
}

// ---- record pages ---------------------------------------------------------

function showVerdictForms(viewer: { owner: boolean; supporter: boolean }, userId: string): void {
  document.querySelectorAll<HTMLElement>("form[data-verdict-for]").forEach((form) => {
    const ownProposal = form.dataset.proposer === userId;
    const asOwner = viewer.owner && form.dataset.requestActive === "1";
    form.hidden = ownProposal || !(asOwner || viewer.supporter);
  });
}

async function initRequestPage(page: HTMLElement): Promise<void> {
  if (!session) return;
  const res = await api("GET", `/requests/${page.dataset.requestId}`);
  const viewer = res.body?.viewer;
  if (!viewer) return;
  show('[data-show="can-support"]', !viewer.is_owner && !viewer.is_supporter);
  show('[data-show="supporter"]', viewer.is_supporter);
  show('[data-show="owner"]', viewer.is_owner);
  showVerdictForms({ owner: viewer.is_owner, supporter: viewer.is_supporter }, session.user.id);
}

async function initSolutionPage(page: HTMLElement): Promise<void> {
  if (!session) return;
  const res = await api("GET", `/solutions/${page.dataset.proposalId}`);
  const viewer = res.body?.viewer;
  if (!viewer) return;
  show('[data-show="proposer"]', viewer.is_proposer);
  showVerdictForms({ owner: viewer.is_requester, supporter: viewer.is_supporter }, session.user.id);
}

// ---- login ----------------------------------------------------------------

// Official provider marks (static markup, no user data). The GitHub mark follows
// the text color; the Google "G" keeps its four brand colors.
const PROVIDER_ICONS: Record<string, string> = {
  github:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>',
  google:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="20" height="20" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 7.293C4.672 5.163 6.656 3.58 9 3.58z"/></svg>',
};

function providerIcon(id: string): Node {
  const holder = document.createElement("span");
  holder.className = "provider-icon";
  holder.innerHTML = PROVIDER_ICONS[id] ?? "";
  return holder;
}

function initLogin(root: HTMLElement): void {
  if (session) {
    location.replace(safeRedirect());
    return;
  }
  const redirectTo = `${location.origin}/login?redirect=${encodeURIComponent(safeRedirect())}`;
  const status = el("p", { class: "notice", hidden: true });
  const email = el("input", { type: "email", name: "email", required: true, autocomplete: "email" });
  const form = el(
    "form",
    {
      class: "form",
      submit: async (event: Event) => {
        event.preventDefault();
        status.hidden = false;
        status.textContent = S.working;
        const { error } = await supabase.auth.signInWithOtp({ email: email.value.trim(), options: { emailRedirectTo: redirectTo } });
        status.textContent = error ? error.message : S.emailSent;
      },
    },
    el("label", { class: "field" }, el("span", {}, S.emailLabel), email),
    el("button", { class: "button primary", type: "submit" }, S.emailSend),
  );
  const provider = (id: "github" | "google", name: string) =>
    el(
      "button",
      {
        class: "button provider",
        type: "button",
        click: async () => {
          const { error } = await supabase.auth.signInWithOAuth({ provider: id, options: { redirectTo } });
          if (error) {
            status.hidden = false;
            status.textContent = error.message;
          }
        },
      },
      providerIcon(id),
      el("span", {}, `${S.continueWith} ${name}`),
    );
  // Password sign-in for accounts that set one on /account. Collapsed: the link is the default.
  const passwordEmail = el("input", { type: "email", name: "email", required: true, autocomplete: "email" });
  const password = el("input", { type: "password", name: "password", required: true, autocomplete: "current-password" });
  const passwordForm = el(
    "form",
    {
      class: "form",
      submit: async (event: Event) => {
        event.preventDefault();
        status.hidden = false;
        status.textContent = S.working;
        const { error } = await supabase.auth.signInWithPassword({ email: passwordEmail.value.trim(), password: password.value });
        if (error) {
          status.textContent = S.passwordWrong;
          return;
        }
        location.replace(safeRedirect());
      },
    },
    el("label", { class: "field" }, el("span", {}, S.emailLabel), passwordEmail),
    el("label", { class: "field" }, el("span", {}, S.passwordLabel), password),
    el("button", { class: "button", type: "submit" }, S.signIn),
  );
  const withPassword = el("details", { class: "password-login" }, el("summary", {}, S.passwordToggle), passwordForm);
  // Only offer social sign-in for providers that are actually configured.
  const names: Record<string, string> = { github: "GitHub", google: "Google" };
  const buttons = boot.providers.filter((id) => id in names).map((id) => provider(id as "github" | "google", names[id]));
  root.replaceChildren(
    ...(buttons.length ? [el("div", { class: "providers" }, ...buttons), el("p", { class: "divider" }, S.or)] : []),
    form,
    withPassword,
    status,
  );
}

// ---- OAuth consent (remote MCP clients) -----------------------------------

async function initConsent(root: HTMLElement): Promise<void> {
  const id = new URLSearchParams(location.search).get("authorization_id");
  if (!id) {
    root.replaceChildren(el("p", { class: "notice" }, S.consentMissing));
    return;
  }
  if (!session) return goToLogin();
  // deno-lint-ignore no-explicit-any
  const oauth = (supabase.auth as any).oauth;
  const { data, error } = await oauth.getAuthorizationDetails(id);
  if (error || !data) {
    root.replaceChildren(el("p", { class: "notice" }, error?.message ?? S.consentMissing));
    return;
  }
  // Already-approved clients come back with only a redirect.
  if (!data.authorization_id && data.redirect_url) {
    location.href = data.redirect_url;
    return;
  }
  const decide = async (approve: boolean) => {
    const result = approve ? await oauth.approveAuthorization(id) : await oauth.denyAuthorization(id);
    if (result.error || !result.data?.redirect_url) {
      root.append(el("p", { class: "form-error" }, result.error?.message ?? S.error));
      return;
    }
    location.href = result.data.redirect_url;
  };
  root.replaceChildren(
    el("p", { class: "lead" }, el("b", {}, String(data.client?.name ?? data.client?.client_id ?? "An application")), ` ${S.consentLead}`),
    el("div", { class: "preview" }, renderValue({ client: data.client?.name, redirect_uri: data.redirect_uri ?? data.client?.redirect_uris, scope: data.scope })),
    el(
      "div",
      { class: "dialog-actions" },
      el("button", { class: "button", type: "button", click: () => void decide(false) }, S.deny),
      el("button", { class: "button primary", type: "button", click: () => void decide(true) }, S.approve),
    ),
  );
}

// ---- account --------------------------------------------------------------

function section(title: string, ...children: Child[]): HTMLElement {
  return el("section", { class: "account-section" }, el("h2", {}, title), ...children);
}

function listOrEmpty(items: Node[]): Node {
  return items.length ? el("ul", { class: "rows compact" }, ...items) : el("p", { class: "empty" }, S.empty);
}

async function initAccount(root: HTMLElement): Promise<void> {
  if (!session) return goToLogin();
  root.replaceChildren(el("p", { class: "muted" }, S.working));
  const [me, activity, notifications, tokens] = await Promise.all([
    api("GET", "/me"),
    api("GET", "/me/activity?limit=50"),
    api("GET", "/me/notifications?limit=30"),
    api("GET", "/me/tokens"),
  ]);
  if (me.status !== 200) {
    root.replaceChildren(el("p", { class: "form-error" }, me.body?.error?.message ?? S.error));
    return;
  }
  const user = me.body.user;
  const prefs = user.notification_preferences ?? {};

  const name = el("input", { type: "text", name: "display_name", value: user.display_name, minlength: "2", maxlength: "60", required: true });
  const inApp = el("input", { type: "checkbox", checked: prefs.in_app !== false });
  const email = el("input", { type: "checkbox", checked: prefs.email === true });
  const saved = el("span", { class: "muted" });
  const profile = el(
    "form",
    {
      class: "form",
      submit: async (event: Event) => {
        event.preventDefault();
        const res = await api("PATCH", "/me", {
          display_name: name.value.trim(),
          notification_preferences: { in_app: inApp.checked, email: email.checked },
        });
        saved.textContent = res.status === 200 ? S.saved : (res.body?.error?.message ?? S.error);
      },
    },
    el("label", { class: "field" }, el("span", {}, S.displayName), name),
    el("label", { class: "radio" }, inApp, ` ${S.notifInApp}`),
    el("label", { class: "radio" }, email, ` ${S.notifEmail}`),
    el("div", { class: "dialog-actions start" }, el("button", { class: "button primary", type: "submit" }, S.save), saved),
  );

  const row = (path: string, title: string, meta: string) =>
    el("li", { class: "row" }, el("div", { class: "row-main" }, link(path, title)), el("div", { class: "row-side" }, el("span", { class: "muted" }, meta)));
  const a = activity.body ?? {};
  const requests = (a.requests ?? []).map((r: any) =>
    row(`/requests/${r.id}`, r.title, r.proposals_awaiting_verdict ? `${r.status} · ${r.proposals_awaiting_verdict} ${S.awaiting}` : r.status));
  const software = (a.software ?? []).map((s: any) => row(`/software/${s.slug}`, s.name, s.review_status));
  const proposals = (a.proposals ?? []).map((p: any) => row(`/solutions/${p.id}`, `${p.software.name} → ${p.request.title}`, p.status));
  const subscriptions = (a.subscriptions ?? []).map((i: any) => row(`/requests/${i.request.id}`, i.request.title, i.request.status));

  const notes = (notifications.body?.items ?? []).map((n: any) =>
    el(
      "li",
      { class: n.read_at ? "row" : "row unread" },
      el("div", { class: "row-main" }, n.proposal_id ? link(`/solutions/${n.proposal_id}`, n.message) : n.request_id ? link(`/requests/${n.request_id}`, n.message) : n.message),
      el("div", { class: "row-side" }, el("span", { class: "muted" }, String(n.created_at).slice(0, 10))),
    ));
  const markRead = el(
    "button",
    {
      class: "button small",
      type: "button",
      click: async () => {
        await api("POST", "/me/notifications/read", {});
        location.reload();
      },
    },
    S.markRead,
  );

  const tokenList = el("ul", { class: "rows compact" });
  const renderTokens = (items: any[]) => {
    tokenList.replaceChildren(
      ...items.map((token) =>
        el(
          "li",
          { class: "row" },
          el("div", { class: "row-main" }, el("b", {}, token.name), " ", el("code", {}, `${token.token_prefix}…`)),
          el(
            "div",
            { class: "row-side" },
            el(
              "button",
              {
                class: "button small",
                type: "button",
                click: async () => {
                  await api("DELETE", `/me/tokens/${token.id}`);
                  const fresh = await api("GET", "/me/tokens");
                  renderTokens(fresh.body?.items ?? []);
                },
              },
              S.revoke,
            ),
          ),
        )
      ),
    );
  };
  renderTokens(tokens.body?.items ?? []);
  const tokenName = el("input", { type: "text", placeholder: S.tokenName, maxlength: "60", required: true });
  const tokenOut = el("div", {});
  const tokenForm = el(
    "form",
    {
      class: "form inline",
      submit: async (event: Event) => {
        event.preventDefault();
        const res = await api("POST", "/me/tokens", { name: tokenName.value.trim() });
        if (res.status !== 200) {
          tokenOut.replaceChildren(el("p", { class: "form-error" }, res.body?.error?.message ?? S.error));
          return;
        }
        tokenOut.replaceChildren(el("p", { class: "warn" }, S.tokenOnce), el("pre", { class: "code" }, el("code", {}, res.body.token)));
        tokenName.value = "";
        const fresh = await api("GET", "/me/tokens");
        renderTokens(fresh.body?.items ?? []);
      },
    },
    tokenName,
    el("button", { class: "button", type: "submit" }, S.createToken),
  );

  const signOut = el(
    "button",
    {
      class: "button small",
      type: "button",
      click: async () => {
        await supabase.auth.signOut();
        location.href = "/";
      },
    },
    S.signOut,
  );

  // Optional password, so the account can sign in without an email link.
  const newPassword = el("input", { type: "password", name: "new_password", required: true, minlength: "8", maxlength: "72", autocomplete: "new-password" });
  const passwordSaved = el("span", { class: "muted" });
  const passwordForm = el(
    "form",
    {
      class: "form",
      submit: async (event: Event) => {
        event.preventDefault();
        passwordSaved.textContent = S.working;
        const { error } = await supabase.auth.updateUser({ password: newPassword.value });
        passwordSaved.textContent = error ? error.message : S.passwordSaved;
        if (!error) newPassword.value = "";
      },
    },
    el("label", { class: "field" }, el("span", {}, S.passwordNew), newPassword),
    el("p", { class: "dialog-actions start" }, el("button", { class: "button small", type: "submit" }, S.passwordSet), passwordSaved),
  );

  root.replaceChildren(
    section(S.account, profile),
    section(S.notifications, notes.length ? markRead : null, listOrEmpty(notes)),
    section(S.myRequests, listOrEmpty(requests)),
    section(S.myProposals, listOrEmpty(proposals)),
    section(S.mySoftware, listOrEmpty(software)),
    section(S.mySubscriptions, listOrEmpty(subscriptions)),
    section(S.passwordSection, el("p", { class: "muted" }, S.passwordIntro), passwordForm),
    section(S.tokens, el("p", { class: "muted" }, S.tokensIntro), tokenList, tokenForm, tokenOut),
    el("p", { class: "dialog-actions start" }, signOut, user.is_admin ? link("/admin", S.adminLink) : null),
  );
}

// ---- moderation -----------------------------------------------------------

const MODERATION_ACTIONS: Record<string, string[]> = {
  software: ["mark_reviewed", "flag", "clear_images", "clear_history", "remove", "restore"],
  request: ["clear_history", "remove", "restore"],
  solution: ["clear_history", "remove"],
};

/** Runs a moderator write, showing the server's preview first when it asks for confirmation. */
async function adminWrite(path: string, body: Record<string, unknown>): Promise<{ cancelled?: boolean; error?: string }> {
  const key = crypto.randomUUID();
  let res = await api("POST", path, body, key);
  if (res.status === 428 && res.body?.error?.code === "CONFIRMATION_REQUIRED") {
    if (!(await confirmDialog(res.body.error.details))) return { cancelled: true };
    res = await api("POST", path, { ...body, confirmed: true }, key);
  }
  return res.status >= 400 ? { error: res.body?.error?.message ?? S.error } : {};
}

async function initAdmin(root: HTMLElement): Promise<void> {
  if (!session) return goToLogin();
  root.replaceChildren(el("p", { class: "muted" }, S.working));
  const me = await api("GET", "/me");
  // The server enforces this on every call; the check here only decides what to draw.
  if (!me.body?.user?.is_admin) {
    root.replaceChildren(el("p", { class: "notice" }, S.adminOnly));
    return;
  }
  const myId = String(me.body.user.id);
  const status = el("p", { class: "notice", hidden: true, role: "status" });
  const reportsBox = el("div", {});
  const softwareBox = el("div", {});
  let softwareFilter = "unreviewed";

  const act = async (path: string, body: Record<string, unknown>) => {
    const result = await adminWrite(path, body);
    if (result.cancelled) return;
    status.hidden = false;
    status.textContent = result.error ?? S.adminDone;
    if (!result.error) await render();
  };

  const noteInput = () => el("input", { type: "text", placeholder: S.adminNote, maxlength: "300", "aria-label": S.adminNote });

  /** Buttons for the actions that make sense in the record's current state. */
  const actionButtons = (type: string, id: string, state: string, note: HTMLInputElement, hasImages = true): Node[] =>
    (MODERATION_ACTIONS[type] ?? [])
      .filter((action) => {
        if (state === "withdrawn") return false;
        if (action === "clear_images" && !hasImages) return false;
        // Offered in the by-ID form only: it is rare and needs no button on every card.
        if (action === "clear_history") return false;
        if (action === "restore") return state === "removed";
        if (state === "removed") return false;
        return !(action === "mark_reviewed" && state === "reviewed") && !(action === "flag" && state === "flagged");
      })
      .map((action) =>
        el(
          "button",
          {
            class: action === "remove" ? "button small danger" : "button small",
            type: "button",
            click: () => void act("/admin/moderate", { entity_type: type, entity_id: id, action, note: note.value.trim() || undefined }),
          },
          S[`act_${action}`] ?? action,
        )
      );

  const suspendButton = (author: any): Node | null =>
    author && author.status === "active" && author.id !== myId
      ? el(
        "button",
        { class: "button small", type: "button", click: () => void act(`/admin/users/${author.id}/status`, { status: "suspended" }) },
        S.adminSuspend,
      )
      : null;

  const card = (title: Node, meta: string, text: string, extra: Child, note: HTMLInputElement, buttons: Child[]) =>
    el(
      "li",
      { class: "admin-card" },
      el("div", { class: "admin-head" }, title, el("span", { class: "muted" }, meta)),
      text ? el("p", { class: "row-text" }, text) : null,
      extra,
      note,
      el("div", { class: "admin-actions" }, ...buttons),
    );

  const renderReports = (items: any[]) => {
    const groups = new Map<string, { type: string; id: string; record: any; reports: any[] }>();
    for (const report of items) {
      const key = `${report.entity_type}:${report.entity_id}`;
      const group = groups.get(key) ?? { type: report.entity_type, id: report.entity_id, record: report.record, reports: [] as any[] };
      group.reports.push(report);
      groups.set(key, group);
    }
    const cards = [...groups.values()].map((group) => {
      const record = group.record ?? {};
      const state = String(record.state ?? "");
      const note = noteInput();
      const title = record.path && state !== "removed" && state !== "withdrawn"
        ? link(record.path, record.label ?? group.id)
        : el("b", {}, record.label ?? group.id);
      const reasons = el(
        "ul",
        { class: "bullets" },
        ...group.reports.map((r) => el("li", {}, `${S.adminReportedBy} ${r.reporter.display_name}, ${String(r.created_at).slice(0, 10)}: ${r.reason}`)),
      );
      return card(
        title,
        `${group.type} · ${state} · ${S.adminBy} ${record.author?.display_name ?? "?"}${record.author?.status === "suspended" ? " (suspended)" : ""}`,
        String(record.text ?? ""),
        reasons,
        note,
        [
          ...actionButtons(group.type, group.id, state, note),
          el(
            "button",
            {
              class: "button small",
              type: "button",
              click: () => void act("/admin/reports/resolve", { entity_type: group.type, entity_id: group.id, resolution: "dismissed" }),
            },
            S.adminDismiss,
          ),
          suspendButton(record.author),
        ],
      );
    });
    reportsBox.replaceChildren(cards.length ? el("ul", { class: "admin-list" }, ...cards) : el("p", { class: "empty" }, S.empty));
  };

  const renderSoftware = (items: any[]) => {
    const cards = items.map((s) => {
      const note = noteInput();
      const title = s.review_status === "removed" ? el("b", {}, s.name) : link(`/software/${s.slug}`, s.name);
      const images = (s.icon_url ? 1 : 0) + (Array.isArray(s.screenshots) ? s.screenshots.length : 0);
      return card(
        title,
        `${s.review_status} · ${S.adminBy} ${s.submitted_by.display_name}${s.submitted_by.status === "suspended" ? " (suspended)" : ""} · ${String(s.created_at).slice(0, 10)}${s.open_reports ? ` · ${s.open_reports} ${S.adminOpenReports}` : ""}`,
        `${s.canonical_url} — ${s.description}`,
        null,
        note,
        [
          ...actionButtons("software", s.id, s.review_status, note, images > 0),
          suspendButton(s.submitted_by),
        ],
      );
    });
    softwareBox.replaceChildren(cards.length ? el("ul", { class: "admin-list" }, ...cards) : el("p", { class: "empty" }, S.empty));
  };

  const render = async () => {
    const [reports, software] = await Promise.all([
      api("GET", "/admin/reports?status=open&limit=50"),
      api("GET", `/admin/software?review_status=${softwareFilter}&limit=50`),
    ]);
    renderReports(reports.body?.items ?? []);
    renderSoftware(software.body?.items ?? []);
  };

  const filter = el(
    "select",
    {
      "aria-label": S.adminSoftware,
      change: (event: Event) => {
        softwareFilter = (event.target as HTMLSelectElement).value;
        void render();
      },
    },
    ...["unreviewed", "flagged", "reviewed", "removed", "all"].map((value) => el("option", { value }, value)),
  );

  const manualType = el("select", { "aria-label": "entity type" }, ...Object.keys(MODERATION_ACTIONS).map((value) => el("option", { value }, value)));
  const manualId = el("input", { type: "text", placeholder: S.adminRecordId, required: true, maxlength: "80" });
  const manualAction = el(
    "select",
    { "aria-label": "action" },
    ...MODERATION_ACTIONS.software.map((value) => el("option", { value }, S[`act_${value}`] ?? value)),
  );
  const manualNote = noteInput();
  const manual = el(
    "form",
    {
      class: "form",
      submit: (event: Event) => {
        event.preventDefault();
        void act("/admin/moderate", {
          entity_type: manualType.value,
          entity_id: manualId.value.trim(),
          action: manualAction.value,
          note: manualNote.value.trim() || undefined,
        });
      },
    },
    el("div", { class: "admin-actions" }, manualType, manualId, manualAction),
    manualNote,
    el("div", { class: "dialog-actions start" }, el("button", { class: "button", type: "submit" }, S.adminApply)),
  );

  const userId = el("input", { type: "text", placeholder: S.adminUserId, required: true, maxlength: "40" });
  const userStatus = el(
    "select",
    { "aria-label": "status" },
    ...["suspended", "active"].map((value) => el("option", { value }, S[`userStatus_${value}`] ?? value)),
  );
  const users = el(
    "form",
    {
      class: "form",
      submit: (event: Event) => {
        event.preventDefault();
        void act(`/admin/users/${encodeURIComponent(userId.value.trim())}/status`, { status: userStatus.value });
      },
    },
    el("div", { class: "admin-actions" }, userId, userStatus, el("button", { class: "button", type: "submit" }, S.adminApply)),
  );

  root.replaceChildren(
    status,
    section(S.adminReports, reportsBox),
    section(S.adminSoftware, filter, softwareBox),
    section(S.adminManual, manual),
    section(S.adminUsers, users),
  );
  await render();
}

// ---- boot -----------------------------------------------------------------

async function main(): Promise<void> {
  session = (await supabase.auth.getSession()).data.session;
  supabase.auth.onAuthStateChange((_event, next) => {
    session = next;
  });

  const authLink = document.getElementById("auth-link") as HTMLAnchorElement | null;
  if (authLink && session) {
    authLink.textContent = S.account;
    authLink.href = "/account";
  }

  bindForms();
  bindCopy();
  bindLightbox();
  if (document.querySelector("[data-requires-auth]") && !session) return goToLogin();

  const page = document.querySelector<HTMLElement>("[data-page]");
  if (page?.dataset.page === "request") void initRequestPage(page);
  if (page?.dataset.page === "solution") void initSolutionPage(page);

  const login = document.getElementById("login-root");
  if (login) initLogin(login);
  const consent = document.getElementById("consent-root");
  if (consent) void initConsent(consent);
  const account = document.getElementById("account-root");
  if (account) void initAccount(account);
  const admin = document.getElementById("admin-root");
  if (admin) void initAdmin(admin);
}

void main();
