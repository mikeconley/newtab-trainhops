/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { LitElement, html } from "../vendor/lit3/lit-all.min.js";
import sheet from "../styles/jobs-report.css" with { type: "css" };
import {
  BETA_JOB_GROUP_SYMBOL,
  RELEASE_JOB_GROUP_SYMBOL,
  getRepo,
} from "./api.js";

const TREEHERDER_JOBS = "https://treeherder.mozilla.org/jobs";

// The platforms the trainhop variants are configured to run on, from
// run-on-projects in taskcluster/kinds/mochitest/kind.yml.
const EXPECTED_PLATFORM_COUNT = 3;

// Selects the trainhop jobs worth running on an autoland push, excluding the
// build types that carry no useful train-hop signal.
//
// The leading apostrophe matters: Treeherder's fuzzy job finder runs Fuse.js
// with threshold 0.4 and the default location/distance, which only accepts
// matches near the start of the task label. "trainhop" sits ~57 characters in,
// so a bare search finds nothing at all. The apostrophe is Fuse's
// extended-search operator for an exact substring match, which skips that
// scoring entirely.
const FUZZY_QUERY =
  "'trainhop opt-mochitest-browser-chrome !asan !ccov !-cf !artifact " +
  "!wayland !debug !windows11-32 !tsan !shippable";

class JobsReport extends LitElement {
  static styles = sheet;

  static properties = {
    pushData: { type: Object },
    copiedQuery: { type: Boolean },
  };

  constructor() {
    super();
    this.pushData = null;
    this.copiedQuery = false;
  }

  get #repo() {
    return getRepo(this.pushData.repo).treeherder;
  }

  #treeherderUrl(searchStr) {
    const params = new URLSearchParams({
      repo: this.#repo,
      revision: this.pushData.push.revision,
    });
    if (searchStr) {
      params.set("searchStr", searchStr);
    }
    return `${TREEHERDER_JOBS}?${params}`;
  }

  #renderStatus(status) {
    return html`<span class="status status-${status}" title="${status}"
      ><span class="dot"></span>${status}</span
    >`;
  }

  #renderPlatformRow(platform, platformSummary) {
    return html`
      <tr>
        <td>
          <a href="${this.#treeherderUrl("trainhop")}" target="_blank" rel="noopener"
            >${platform}</a
          >
        </td>
        <td>${this.#renderStatus(platformSummary[BETA_JOB_GROUP_SYMBOL])}</td>
        <td>${this.#renderStatus(platformSummary[RELEASE_JOB_GROUP_SYMBOL])}</td>
      </tr>
    `;
  }

  #copyFuzzyQuery() {
    navigator.clipboard?.writeText(FUZZY_QUERY);
    this.copiedQuery = true;
    this.requestUpdate();
    setTimeout(() => {
      this.copiedQuery = false;
      this.requestUpdate();
    }, 2000);
  }

  /**
   * On autoland the trainhop variants are in the task graph but are usually
   * optimized away, so a push often has none. They stay schedulable from the
   * push's action menu, which fires a Taskcluster hook needing credentials this
   * page does not have - so link across to Treeherder rather than trying to
   * trigger here.
   * @param {number} platformCount - How many platforms reported jobs
   * @returns {Object|null} A Lit template, or null when nothing to suggest
   */
  #renderScheduling(platformCount) {
    if (this.#repo !== "autoland") {
      return null;
    }

    const none = platformCount === 0;
    if (!none && platformCount >= EXPECTED_PLATFORM_COUNT) {
      return null;
    }

    return html`
      <div class="schedule ${none ? "prominent" : ""}">
        <p>
          ${none
            ? html`No train-hop jobs have run on this autoland push. They are
                part of the task graph but get optimized away unless something
                relevant changed, so they have to be scheduled by hand.`
            : html`Only ${platformCount} of ${EXPECTED_PLATFORM_COUNT}
                platforms have train-hop jobs on this autoland push.`}
        </p>
        <ol class="schedule-steps">
          <li>
            <a
              class="schedule-link"
              href="${this.#treeherderUrl("trainhop")}"
              target="_blank"
              rel="noopener"
              >Open this push on Treeherder</a
            >
            and sign in.
          </li>
          <li>
            From the push's <code>...</code> action menu, choose
            <strong>Add new jobs (Search)</strong>. Treeherder has no way to
            open this dialog from a link, so it has to be done by hand.
          </li>
          <li>
            Paste this query and press Enter, then select the jobs and
            <strong>Trigger New Jobs</strong>:
            <div class="query-row">
              <code class="query">${FUZZY_QUERY}</code>
              <button class="copy" @click=${this.#copyFuzzyQuery}>
                ${this.copiedQuery ? "Copied" : "Copy"}
              </button>
            </div>
            The leading apostrophe is required - searching
            <code>trainhop</code> on its own matches nothing, because the search
            scores matches by how near the start of the task label they are and
            <code>trainhop</code> sits too far in.
          </li>
        </ol>
        <p class="note">
          Alternatively, plain <strong>Add new jobs</strong> lists the
          <code>${BETA_JOB_GROUP_SYMBOL}</code> and
          <code>${RELEASE_JOB_GROUP_SYMBOL}</code> groups directly, with no
          search needed.
        </p>
      </div>
    `;
  }

  render() {
    if (!this.pushData) {
      return null;
    }

    const platforms = Object.keys(this.pushData.summary);

    return html`
      <h1>Train-hop Compatibility Jobs report</h1>
      ${platforms.length
        ? html`
            <table>
              <thead>
                <tr>
                  <th>Platform</th>
                  <th>Beta</th>
                  <th>Release</th>
                </tr>
              </thead>
              <tbody>
                ${platforms.map(platform =>
                  this.#renderPlatformRow(platform, this.pushData.summary[platform])
                )}
              </tbody>
            </table>
          `
        : html`<p class="empty">
            No train-hop compatibility jobs have been reported for this push yet.
          </p>`}
      ${this.#renderScheduling(platforms.length)}
    `;
  }
}

customElements.define("jobs-report", JobsReport);
