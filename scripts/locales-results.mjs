/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { LitElement, html } from "../vendor/lit3/lit-all.min.js";

class LocalesResults extends LitElement {
  static properties = {
    localesReport: { type: Object },
    ftlComparison: { type: Object },
    betaStartDate: { type: String },
    releaseStartDate: { type: String },
    sha: { type: String },
  };

  constructor() {
    super();
    this.localesReport = null;
    this.ftlComparison = null;
  }

  #trainhoppingBlocked() {
    return this.ftlComparison.status == "main-newer";
  }

  #ftlComparison() {
    const NEWTAB_FTL_HISTORY = `https://github.com/mozilla-firefox/firefox/commits/${this.sha}/browser/locales/en-US/browser/newtab/newtab.ftl`;
    return html`
      <div id="ftl-comparison">
        ${this.ftlComparison.status == "main-newer"
          ? html`<a href="${NEWTAB_FTL_HISTORY}" target="_blank" rel="noopener"
                >${this.ftlComparison.message}</a
              >. An engineer must run
              <pre>./mach newtab update-locales</pre>
              and land the resulting change.`
          : "XPI newtab.ftl is new enough."}
      </div>
    `;
  }

  #localesReport() {
    let reportKeys = Object.keys(this.localesReport.locales);
    let releaseStart = Temporal.PlainDate.from(this.releaseStartDate);
    let betaStart = Temporal.PlainDate.from(this.betaStartDate);
    let now = Temporal.Now.plainDateISO();
    let betaFallbackThreshold = Temporal.Duration.from({ weeks: 3 });
    return html`
      ${reportKeys.map(key => {
        let missingOrPendingStrings =
          this.localesReport.locales[key].missing?.["browser/newtab/newtab.ftl"];
        if (missingOrPendingStrings) {
          let missingStrings = [];
          let pendingStrings = [];

          for (let fluentKey of missingOrPendingStrings) {
            let introducedDate = Temporal.PlainDate.from(
              this.localesReport.message_dates[fluentKey]
            );
            if (
              Temporal.PlainDate.compare(introducedDate, releaseStart) == -1 ||
              (Temporal.PlainDate.compare(introducedDate, betaStart) &&
                Temporal.Duration.compare(
                  now.since(betaStart),
                  betaFallbackThreshold,
                  { relativeTo: now }
                ) == 1)
            ) {
              missingStrings.push(fluentKey);
            } else {
              pendingStrings.push(fluentKey);
            }
          }

          return html`
            <details name="locale">
              <summary>
                ${key} - pending: ${pendingStrings.length}, missing:
                ${missingStrings.length}
              </summary>
              <p>Pending strings</p>
              <ol>
                ${pendingStrings.map(fluentKey =>
                  this.#renderFluentKey(key, fluentKey)
                )}
              </ol>
              <p>Missing strings</p>
              <ol>
                ${missingStrings.map(fluentKey =>
                  this.#renderFluentKey(key, fluentKey)
                )}
              </ol>
            </details>
          `;
        }
        return null;
      })}
    `;
  }

  #renderFluentKey(localeKey, fluentKey) {
    const pontoonLink = `https://pontoon.mozilla.org/${localeKey}/firefox/browser/browser/newtab/newtab.ftl/?search=${fluentKey}&search_identifiers=true`;
    return html`<li>
      <a href="${pontoonLink}" target="_blank" rel="noopener">${fluentKey}</a>
    </li>`;
  }

  #fullyTranslated() {
    let reportKeys = Object.keys(this.localesReport.locales);
    let fullyTranslated = reportKeys.filter(localeKey => {
      return (
        this.localesReport.locales[localeKey].errors == null &&
        this.localesReport.locales[localeKey].missing == null
      );
    });
    return html`<ul class="locale-list">
      ${fullyTranslated.map(localeKey => html`<li>${localeKey}</li>`)}
    </ul>`;
  }

  render() {
    if (!this.localesReport || !this.ftlComparison) {
      return null;
    }

    const blocked = this.#trainhoppingBlocked();

    return html`
      <link rel="stylesheet" href="./styles/locales-results.css" />
      <h1>Locales report</h1>
      <h2>The following locales are fully translated</h2>
      ${this.#fullyTranslated()}
      <h2 class=${blocked ? "blocked" : "manual"}>
        ${blocked
          ? "Train-hopping might be blocked."
          : "Manual analysis of translated strings required."}
      </h2>
      ${this.#ftlComparison()} ${this.#localesReport()}
    `;
  }
}

customElements.define("locales-results", LocalesResults);
