/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { LitElement, html } from "../vendor/lit3/lit-all.min.js";
import { BETA_JOB_GROUP_SYMBOL, RELEASE_JOB_GROUP_SYMBOL } from "./api.mjs";

const TREEHERDER_URL =
  "https://treeherder.mozilla.org/jobs?repo=mozilla-central&searchStr=trainhop&revision=";

class JobsReport extends LitElement {
  static properties = {
    pushData: { type: Object },
  };

  constructor() {
    super();
    this.pushData = null;
  }

  #renderStatus(status) {
    return html`<span class="status status-${status}" title="${status}"
      ><span class="dot"></span>${status}</span
    >`;
  }

  #renderPlatformRow(platform, platformSummary) {
    const PUSH_URL = `${TREEHERDER_URL}${this.pushData.push.revision}`;
    return html`
      <tr>
        <td>
          <a href="${PUSH_URL}" target="_blank" rel="noopener">${platform}</a>
        </td>
        <td>${this.#renderStatus(platformSummary[BETA_JOB_GROUP_SYMBOL])}</td>
        <td>${this.#renderStatus(platformSummary[RELEASE_JOB_GROUP_SYMBOL])}</td>
      </tr>
    `;
  }

  render() {
    if (!this.pushData) {
      return null;
    }

    const platforms = Object.keys(this.pushData.summary);

    return html`
      <link rel="stylesheet" href="./styles/jobs-report.css" />
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
    `;
  }
}

customElements.define("jobs-report", JobsReport);
