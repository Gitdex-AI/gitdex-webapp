/** @jsxImportSource hono/jsx */
// Privacy policy and terms. Plain statements of what the service actually does;
// keep them in sync with the code when data handling changes.

import type { FC } from "hono/jsx";
import { Layout, type PageCtx, SUPPORT_EMAIL } from "./views.tsx";

const OPERATOR = "Paworld Labs LLC";
const CONTACT = SUPPORT_EMAIL;
const UPDATED = "November 16, 2026";

const Contact: FC = () => <a href={`mailto:${CONTACT}`}>{CONTACT}</a>;

export const PrivacyPage: FC<{ ctx: PageCtx }> = ({ ctx }) => (
  <Layout ctx={ctx} title="Privacy Policy" description="What GitDex collects, what is public, and how to remove your data.">
    <article class="narrow wide legal">
      <h1>Privacy Policy</h1>
      <p class="muted">Last updated: {UPDATED}</p>
      <p>
        GitDex (gitdex.ai) is a public directory of software, software requests and proposed solutions, operated by {OPERATOR}.
        This policy explains what we collect, what becomes public, and the choices you have. Questions: <Contact />.
      </p>

      <h2>What is public</h2>
      <p>
        GitDex exists to publish records. When you publish a request, submit software, propose a solution or record a verdict,
        the content of that record and your display name are visible to everyone and available through our public API and MCP
        server, including to AI clients and search engines. Your display name links to a page listing the records you
        published. Before anything is published you are shown the exact fields that
        will become public. Do not put personal or confidential information in a record.
      </p>

      <h2>What we collect</h2>
      <ul class="bullets">
        <li>
          <b>Account information.</b> When you sign in with email, GitHub or Google we receive your email address and an
          account identifier from that provider, used only to sign you in. If you set a password, our authentication provider
          stores it only in hashed form and we never see it. Your email address is never shown publicly. Your
          public display name is your GitHub username if you sign in with GitHub, otherwise a generated name; you can change
          it at any time.
        </li>
        <li><b>Records you publish</b>, as described above, and the requests you choose to support.</li>
        <li>
          <b>Activity log.</b> For each write we store which account made it, when, a short summary, and a label for the
          client used (for example the name of the AI client or browser). This is used for abuse prevention and dispute
          handling and is not public.
        </li>
        <li><b>IP addresses</b>, used transiently to rate limit requests and kept in standard server logs.</li>
        <li>
          <b>Usage statistics.</b> On public pages of gitdex.ai we use Google Analytics to count visits: which pages are
          viewed (including the page address, so also search keywords you typed into our search), the referring site,
          approximate location, and browser and device type. Sign-in, account and form pages are not measured, and we do not
          send Google your account identifier, email address or display name.
        </li>
        <li><b>API tokens</b> you create are stored only as a one-way hash.</li>
        <li><b>Notification preferences</b> and the in-app notifications generated for you.</li>
      </ul>
      <p>
        We do not receive the conversations you have with your AI client. An AI client connected to GitDex sends us only the
        specific tool calls it makes, such as a search query or the fields of a record you approved.
      </p>

      <h2>Cookies and local storage</h2>
      <p>
        We set one cookie to remember your language choice. Your sign-in session is kept in your browser's local storage.
        Google Analytics sets first-party cookies (names starting with <code>_ga</code>) to tell visits apart. We do not use
        advertising cookies, and advertising features of Google Analytics are turned off. You can block these cookies in your
        browser or with{" "}
        <a href="https://tools.google.com/dlpage/gaoptout" rel="noopener noreferrer">Google's opt-out add-on</a>; the site works
        the same without them.
      </p>

      <h2>How we use information</h2>
      <p>
        To operate the directory, authenticate you, notify you about requests you follow, prevent abuse, and comply with law.
        We do not sell personal information and do not use it for advertising. GitDex does not run AI models on your data.
      </p>

      <h2>Service providers</h2>
      <p>
        Data is stored and processed by Supabase (database and authentication) and Cloudflare (hosting and network), in the
        United States and other countries where they operate. GitHub and Google act as sign-in providers if you choose them.
        Google also provides the usage statistics described above. Icons and screenshots on software pages are loaded
        directly from addresses chosen by whoever submitted the record, so the site hosting an image sees your IP address
        when your browser loads it; we do not send it the page you came from.
      </p>

      <h2>Connected applications</h2>
      <p>
        If you authorize an AI client or other application to access your GitDex account, it can act as you within GitDex:
        search, and with your confirmation publish, propose and confirm. You can stop using a personal API token by revoking
        it on your account page, and you can ask us to revoke an application's access.
      </p>

      <h2>Retention and deletion</h2>
      <ul class="bullets">
        <li>You can withdraw a request from public view, withdraw a proposal, and stop supporting a request at any time.</li>
        <li>
          To correct or remove other records, or to delete your account and associated personal information, email{" "}
          <Contact />. We remove or anonymize personal information within 30 days, except minimal records we must keep for
          security, abuse prevention or legal reasons.
        </li>
        <li>Public records may have been copied by third parties or cached by search engines before removal.</li>
      </ul>

      <h2>Your rights</h2>
      <p>
        Depending on where you live, you may have rights to access, correct, delete or export your personal information, or to
        object to certain processing. Email <Contact /> to exercise them.
      </p>

      <h2>Children</h2>
      <p>GitDex is not directed to children under 13, and we do not knowingly collect their personal information.</p>

      <h2>Changes</h2>
      <p>We will update this page when our practices change and revise the date above.</p>
    </article>
  </Layout>
);

export const TermsPage: FC<{ ctx: PageCtx }> = ({ ctx }) => (
  <Layout ctx={ctx} title="Terms of Service" description="Rules for using GitDex.">
    <article class="narrow wide legal">
      <h1>Terms of Service</h1>
      <p class="muted">Last updated: {UPDATED}</p>
      <p>
        These terms govern your use of GitDex (gitdex.ai), operated by {OPERATOR}. By using GitDex, including through an AI
        client, API or MCP connection, you agree to them.
      </p>

      <h2>The service</h2>
      <p>
        GitDex is a public record of software, software requests and proposed solutions submitted by its users and their AI
        clients. Listings are not endorsements. Records marked unreviewed have not been independently verified, and evidence
        marked as claimed reflects only what a source says. Evaluate software yourself before relying on it.
      </p>

      <h2>Your account</h2>
      <p>
        You are responsible for activity under your account, including actions taken by AI clients and applications you
        authorize and by API tokens you create. Keep tokens secret and revoke them if they may be exposed.
      </p>

      <h2>Content you publish</h2>
      <ul class="bullets">
        <li>You keep ownership of what you publish.</li>
        <li>
          You grant GitDex and its users a worldwide, royalty-free licence to host, display, reproduce and distribute it as
          part of the public directory, API and MCP server.
        </li>
        <li>
          You confirm it is accurate to the best of your knowledge, that you have the right to publish it, and that it
          contains no private information about you or others.
        </li>
        <li>Submitting a software record does not give you ownership of, or authority over, that software.</li>
      </ul>

      <h2>Acceptable use</h2>
      <p>You agree not to:</p>
      <ul class="bullets">
        <li>publish spam, misleading listings, malware, unsafe links or unlawful content;</li>
        <li>invent facts, prices, capabilities, verification or evidence;</li>
        <li>inflate interest counts or verdicts, or operate accounts to manipulate records;</li>
        <li>place text in records intended to instruct or manipulate AI clients that read them;</li>
        <li>publish other people's personal information;</li>
        <li>bypass rate limits or access controls, or disrupt the service.</li>
      </ul>
      <p>We may remove records, limit access or suspend accounts that break these rules.</p>

      <h2>No warranty</h2>
      <p>
        GitDex is provided "as is" and "as available", without warranties of any kind. We do not warrant the accuracy of any
        record, the quality or safety of any listed software, or that a request will be solved.
      </p>

      <h2>Limitation of liability</h2>
      <p>
        To the fullest extent permitted by law, {OPERATOR} is not liable for indirect, incidental, special or consequential
        damages, or for loss arising from your use of software or information found through GitDex.
      </p>

      <h2>Changes and contact</h2>
      <p>
        We may update these terms and will revise the date above. Continued use after a change means you accept it.
        Questions: <Contact />.
      </p>
    </article>
  </Layout>
);
