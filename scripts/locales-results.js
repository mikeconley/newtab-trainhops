/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { LitElement, html } from "../vendor/lit3/lit-all.min.js";

const PENDING_WARNING_THRESHOLD = 10;

class LocalesResults extends LitElement {
  static properties = {
    localesReport: { type: Object },
    newtabFtlLastModified: { type: String },
    sha: { type: String },
    refreshing: { type: Boolean },
    refreshProgress: { type: String },
  };

  constructor() {
    super();
    this.localesReport = null;
    this.newtabFtlLastModified = null;
    this.refreshing = false;
    this.refreshProgress = "";
  }

  /**
   * Asks the host to rebuild this report against the current firefox-l10n
   * HEAD. Translations are pulled from that repository at build time, so the
   * same Firefox revision can produce a different report later in the day.
   */
  #onRefresh() {
    this.dispatchEvent(
      new CustomEvent("refresh-locales", { bubbles: true, composed: true })
    );
  }

  #summary() {
    const entries = Object.entries(this.localesReport.locales);
    return {
      total: entries.length,
      complete: entries.filter(
        ([, r]) => !r.error && !r.missing.length && !r.pending.length
      ).length,
      withMissing: entries.filter(([, r]) => r.missing.length).length,
      errored: entries.filter(([, r]) => r.error).length,
    };
  }

  #renderMeta() {
    const { meta, sourceMessageCount } = this.localesReport;
    const NEWTAB_FTL_HISTORY = `https://github.com/mozilla-firefox/firefox/commits/${this.sha}/browser/locales/en-US/browser/newtab/newtab.ftl`;
    const L10N_COMMIT = `${meta.l10nRepository}/commit/${meta.l10nRevision}`;

    return html`
      <dl class="meta">
        <dt>en-US strings</dt>
        <dd>
          ${sourceMessageCount} messages, last changed
          <a href="${NEWTAB_FTL_HISTORY}" target="_blank" rel="noopener"
            >${formatDate(this.newtabFtlLastModified)}</a
          >
        </dd>
        <dt>Translations from</dt>
        <dd>
          <a href="${L10N_COMMIT}" target="_blank" rel="noopener"
            >firefox-l10n @ ${meta.l10nRevision.slice(0, 12)}</a
          >
          <span class="timestamp" title="${formatUTCTimestamp(meta.l10nUpdated)}"
            >${formatLocalTimestamp(meta.l10nUpdated)}</span
          >
          <span class="note"
            >- strings are pulled from this repository at build time, so this
            result can change as new translations land</span
          >
        </dd>
        <dt>Beta merge</dt>
        <dd>
          ${meta.betaStartDate}
          ${meta.betaThresholdPassed
            ? html`<span class="note">- over 3 weeks ago, fallback applies</span>`
            : html`<span class="note">- under 3 weeks ago</span>`}
        </dd>
        <dt>Release merge-to-beta</dt>
        <dd>${meta.releaseStartDate}</dd>
      </dl>
    `;
  }

  #renderLocaleRow(locale, report) {
    if (report.error) {
      return html`
        <details class="errored">
          <summary>
            <span class="locale">${locale}</span>
            <span class="counts error">parse error</span>
          </summary>
          <p class="error">${report.error}</p>
        </details>
      `;
    }

    const { missing, pending } = report;
    if (!missing.length && !pending.length) {
      return null;
    }

    return html`
      <details>
        <summary>
          <span class="locale">${locale}</span>
          <span class="counts">
            ${missing.length
              ? html`<span class="missing">${missing.length} missing</span>`
              : ""}
            ${pending.length
              ? html`<span
                  class="pending ${pending.length > PENDING_WARNING_THRESHOLD
                    ? "high"
                    : ""}"
                  >${pending.length} pending</span
                >`
              : ""}
          </span>
        </summary>
        ${this.#renderStringList(locale, "Missing", missing)}
        ${this.#renderStringList(locale, "Pending", pending)}
      </details>
    `;
  }

  #renderStringList(locale, label, ids) {
    if (!ids.length) {
      return null;
    }
    return html`
      <p class="list-label">${label} (${ids.length})</p>
      <ol>
        ${ids.map(id => this.#renderFluentKey(locale, id))}
      </ol>
    `;
  }

  #renderFluentKey(localeKey, fluentKey) {
    const pontoonLink = `https://pontoon.mozilla.org/${localeKey}/firefox/browser/browser/newtab/newtab.ftl/?search=${fluentKey}&search_identifiers=true`;
    return html`<li>
      <a href="${pontoonLink}" target="_blank" rel="noopener">${fluentKey}</a>
    </li>`;
  }

  render() {
    if (!this.localesReport) {
      return null;
    }

    const summary = this.#summary();
    const locales = Object.keys(this.localesReport.locales).sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    );
    const complete = locales.filter(
      locale => !this.localesReport.locales[locale].error &&
        !this.localesReport.locales[locale].missing.length &&
        !this.localesReport.locales[locale].pending.length
    );

    return html`
      <link rel="stylesheet" href="./styles/locales-results.css" />
      <div class="report-header">
        <h1>Locales report</h1>
        <button
          class="refresh"
          @click=${this.#onRefresh}
          ?disabled=${this.refreshing}
          title="Rebuild against the current firefox-l10n HEAD"
        >
          ${this.refreshing ? "Refreshing..." : "Refresh from l10n HEAD"}
        </button>
      </div>
      ${this.refreshing && this.refreshProgress
        ? html`<p class="note">${this.refreshProgress}</p>`
        : ""}
      ${this.#renderMeta()}

      <h2 class=${summary.withMissing ? "blocked" : "ok"}>
        ${summary.withMissing
          ? `${summary.withMissing} of ${summary.total} locales have missing strings.`
          : `All ${summary.total} locales are free of missing strings.`}
        ${summary.errored
          ? html`<span class="note">${summary.errored} failed to parse.</span>`
          : ""}
      </h2>

      <section class="fully-translated">
        <h3>Fully translated (${complete.length} of ${summary.total})</h3>
        ${complete.length
          ? html`<ul class="locale-list">
              ${complete.map(locale => html`<li>${locale}</li>`)}
            </ul>`
          : html`<p class="note">None.</p>`}
      </section>

      ${locales.map(locale =>
        this.#renderLocaleRow(locale, this.localesReport.locales[locale])
      )}
    `;
  }
}

function formatDate(value) {
  if (!value) {
    return "unknown";
  }
  return new Date(value).toISOString().slice(0, 10);
}

/**
 * Renders a timestamp in the client's own timezone. The l10n revision moves
 * during the day, so the time of day matters when comparing two runs against
 * the same Firefox revision.
 * @param {string} value - An ISO 8601 timestamp
 * @returns {string} e.g. "7 Aug 2026, 05:10 PM EDT"
 */
function formatLocalTimestamp(value) {
  if (!value) {
    return "unknown";
  }
  return new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/**
 * The same timestamp in UTC, shown as a tooltip so the canonical value stays
 * available regardless of where the page is being viewed.
 * @param {string} value - An ISO 8601 timestamp
 * @returns {string} e.g. "2026-08-07 21:10 UTC"
 */
function formatUTCTimestamp(value) {
  if (!value) {
    return "unknown";
  }
  return `${new Date(value).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

customElements.define("locales-results", LocalesResults);
