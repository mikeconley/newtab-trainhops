/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { LitElement, html } from "../vendor/lit3/lit-all.min.js";
import {
  resolveRevision,
  getRevisionData,
  getMergeDates,
  buildLocalesReport,
  shorten,
} from "./api.js";
import "./jobs-report.js";
import "./locales-results.js";
import "./rollouts-report.js";

const SHA_TYPE_HG = "hg";
const SHA_TYPE_GIT = "git";

class TrainCheckApp extends LitElement {
  static properties = {
    sha: { type: String },
    loading: { type: Boolean },
    results: { type: Object },
    shaType: { type: String },
    refreshingLocales: { type: Boolean },
    localesProgress: { type: String },
  };

  constructor() {
    super();
    this.sha = "";
    this.loading = false;
    this.results = null;
    this.shaType = SHA_TYPE_HG;
    this.refreshingLocales = false;
    this.localesProgress = "";
  }

  connectedCallback() {
    super.connectedCallback();

    // Support deep-linking to a revision, so a check can be shared as a URL.
    const params = new URLSearchParams(location.search);
    const sha = params.get("sha");
    if (sha) {
      this.sha = sha;
      this.shaType = params.get("type") === SHA_TYPE_GIT ? SHA_TYPE_GIT : SHA_TYPE_HG;
      this.updateComplete.then(() => this.#checkTrainStatus());
    }
  }

  render() {
    return html`
      <link rel="stylesheet" href="./styles/train-check-app.css" />
      <h1>New Tab Train-hop Station</h1>

      <div class="input-section">
        <label for="sha-input">Revision SHA (leave empty for latest):</label>
        <input
          id="sha-input"
          type="text"
          .value=${this.sha}
          @input=${this.#onShaInput}
          @keydown=${this.#onShaKeydown}
          placeholder="Enter Firefox ${this.shaType == SHA_TYPE_HG
            ? "Mercurial"
            : "Git"} commit SHA or leave empty for latest"
        />
        <fieldset id="sha-type-holder">
          <label
            ><input
              type="radio"
              name="sha-type"
              value="${SHA_TYPE_HG}"
              @change=${this.#onChangeSHAType}
              .checked=${this.shaType == SHA_TYPE_HG}
            />Use Mercurial SHA</label
          >
          <label
            ><input
              type="radio"
              name="sha-type"
              value="${SHA_TYPE_GIT}"
              @change=${this.#onChangeSHAType}
              .checked=${this.shaType == SHA_TYPE_GIT}
            />Use GitHub SHA</label
          >
        </fieldset>
        <div class="actions">
          <button @click=${this.#checkTrainStatus} ?disabled=${this.loading}>
            ${this.loading ? "Checking..." : "Check Train Status"}
          </button>
          <a
            href="https://mikeconley.github.io/newtab-train-hop-station/"
            target="_blank"
            rel="noopener"
            >See trainhop history</a
          >
        </div>
        ${this.loading
          ? html`<p class="progress">${this.progressMessage ?? "Working..."}</p>`
          : ""}
      </div>

      ${this.results ? this.#renderResults() : ""}
    `;
  }

  #renderResults() {
    const { gitSha, hgSha, error, revisionData } = this.results;

    return html`
      <div class="results">
        <h2>Train Check Results</h2>
        <dl class="revision">
          ${gitSha
            ? html`<dt>Git SHA</dt>
                <dd>
                  <a
                    href="https://github.com/mozilla-firefox/firefox/commit/${gitSha}"
                    target="_blank"
                    rel="noopener"
                    >${shorten(gitSha)}</a
                  >
                </dd>`
            : ""}
          ${hgSha
            ? html`<dt>Mercurial SHA</dt>
                <dd>
                  <a
                    href="https://hg.mozilla.org/mozilla-central/rev/${hgSha}"
                    target="_blank"
                    rel="noopener"
                    >${shorten(hgSha)}</a
                  >
                </dd>`
            : ""}
        </dl>

        ${error
          ? html`<p class="error">${error}</p>`
          : html`
              <jobs-report .pushData=${revisionData.pushData}></jobs-report>
              <rollouts-report
                .rollouts=${revisionData.rolloutData}
              ></rollouts-report>
              <locales-results
                .localesReport=${revisionData.localesReport}
                .newtabFtlLastModified=${revisionData.newtabFtlLastModified}
                .sha=${revisionData.gitSha}
                .refreshing=${this.refreshingLocales}
                .refreshProgress=${this.localesProgress}
                @refresh-locales=${this.#refreshLocales}
              ></locales-results>
            `}
      </div>
    `;
  }

  /**
   * Handles input changes for the SHA type radio fields.
   * @param {Event} e - The change event
   */
  #onChangeSHAType(e) {
    this.shaType = e.target.value;
  }

  /**
   * Handles input changes for the SHA text field.
   * @param {Event} e - The input event
   */
  #onShaInput(e) {
    this.sha = e.target.value;
  }

  #onShaKeydown(e) {
    if (e.key === "Enter" && !this.loading) {
      this.#checkTrainStatus();
    }
  }

  /**
   * Prompts the user for a date with validation.
   * @param {string} description - Description of the date being requested
   * @returns {string|null} The validated date or null if cancelled
   */
  #promptForDate(description) {
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

    while (true) {
      const dateInput = prompt(
        `Failed to fetch ${description} automatically. Please enter the ${description} (YYYY-MM-DD):`
      );

      if (dateInput === null) {
        return null;
      }

      if (dateRegex.test(dateInput)) {
        const date = new Date(dateInput + "T00:00:00Z");
        if (!isNaN(date.getTime())) {
          return dateInput;
        }
      }

      alert("Invalid date format. Please use YYYY-MM-DD format (e.g., 2024-01-15).");
    }
  }

  #setProgress(message) {
    this.progressMessage = message;
    this.requestUpdate();
  }

  /**
   * Rebuilds just the locales report against the current firefox-l10n HEAD,
   * leaving the CI and rollout sections alone.
   */
  async #refreshLocales() {
    const { revisionData } = this.results ?? {};
    if (!revisionData || this.refreshingLocales) {
      return;
    }

    this.refreshingLocales = true;
    this.localesProgress = "Refreshing...";
    this.requestUpdate();

    try {
      const localesReport = await buildLocalesReport({
        gitSha: revisionData.gitSha,
        betaStartDate: revisionData.betaStartDate,
        releaseStartDate: revisionData.releaseStartDate,
        onProgress: message => {
          this.localesProgress = message;
          this.requestUpdate();
        },
      });

      // Replace results wholesale so Lit sees a new object and re-renders.
      this.results = {
        ...this.results,
        revisionData: { ...revisionData, localesReport },
      };
    } catch (error) {
      this.localesProgress = `Refresh failed: ${error.message}`;
      this.refreshingLocales = false;
      this.requestUpdate();
      return;
    }

    this.refreshingLocales = false;
    this.localesProgress = "";
    this.requestUpdate();
  }

  /**
   * Initiates the train-hop status check for the provided or latest SHA.
   */
  async #checkTrainStatus() {
    this.loading = true;
    this.results = null;
    this.#setProgress("Resolving revision...");

    let gitSha = null;
    let hgSha = null;

    try {
      ({ gitSha, hgSha } = await resolveRevision(this.sha, this.shaType));

      // If no SHA was provided, populate the input with the one we resolved.
      if (!this.sha.trim()) {
        this.sha = this.shaType == SHA_TYPE_GIT ? gitSha : hgSha;
      }

      // The locales report needs both merge dates up front, so resolve them
      // (prompting if the schedule API is unreachable) before doing the work.
      this.#setProgress("Fetching merge dates...");
      let { betaStartDate, releaseStartDate } = await getMergeDates();

      if (betaStartDate === null) {
        betaStartDate = this.#promptForDate("Beta start date");
        if (betaStartDate === null) {
          throw new Error("Beta start date required for locales analysis");
        }
      }

      if (releaseStartDate === null) {
        releaseStartDate = this.#promptForDate(
          "Release start date (when current release version first merged to Beta)"
        );
        if (releaseStartDate === null) {
          throw new Error("Release start date required for locales analysis");
        }
      }

      this.#setProgress("Fetching CI, locales and rollout data...");
      const revisionData = await getRevisionData(gitSha, hgSha, {
        betaStartDate,
        releaseStartDate,
        onProgress: message => this.#setProgress(message),
      });

      this.results = { gitSha, hgSha, revisionData };
      this.#updateLocationBar(gitSha, hgSha);
    } catch (error) {
      this.results = { gitSha, hgSha, error: error.message };
    } finally {
      this.loading = false;
    }
  }

  #updateLocationBar(gitSha, hgSha) {
    const url = new URL(location.href);
    url.searchParams.set("sha", this.shaType == SHA_TYPE_GIT ? gitSha : hgSha);
    url.searchParams.set("type", this.shaType);
    history.replaceState(null, "", url);
  }
}

customElements.define("train-check-app", TrainCheckApp);
