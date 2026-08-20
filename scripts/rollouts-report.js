/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { LitElement, html } from "../vendor/lit3/lit-all.min.js";
import sheet from "../styles/rollouts-report.css" with { type: "css" };

class RolloutsReport extends LitElement {
  static styles = sheet;

  static properties = {
    rollouts: { type: Object },
  };

  constructor() {
    super();
    this.rollouts = null;
  }

  #rolloutsFor(channel) {
    let matchingRollouts = (this.rollouts ?? []).filter(rollout =>
      rollout.channels.includes(channel)
    );

    if (!matchingRollouts.length) {
      return html`<strong>NONE</strong>`;
    }

    return html`
      <ol>
        ${matchingRollouts.map(rollout => {
          const NIMBUS_URL = `https://experimenter.services.mozilla.com/nimbus/${rollout.slug}/summary/`;
          const PERCENTAGE =
            (rollout.bucketConfig.count / rollout.bucketConfig.total) * 100;
          return html`<li>
            <a href="${NIMBUS_URL}" target="_blank" rel="noopener" title="${rollout.slug} - ${rollout.userFacingName}"
              >${rollout.userFacingName}</a
            >${rollout.legacy
              ? html`<sup
                  class="legacy"
                  title="Uses the legacy newtabTrainhopAddon feature"
                  >legacy</sup
                >`
              : ""}
            at <strong>${PERCENTAGE}%</strong>
          </li>`;
        })}
      </ol>
    `;
  }

  render() {
    return html`
      <h1>Active rollouts</h1>
      <p class="legacy-note">
        A <sup class="legacy">legacy</sup> tag means that the rollout uses the
        legacy, non-co-enrolling <code>newtabTrainhopAddon</code> feature. This
        is being replaced with the co-enrolling
        <code>newtabTrainhopAddonDeployment</code> feature once Firefox 155 hits
        release.
      </p>
      <h2>Release</h2>
      <div>${this.#rolloutsFor("release")}</div>
      <h2>Beta</h2>
      <div>${this.#rolloutsFor("beta")}</div>
    `;
  }
}

customElements.define("rollouts-report", RolloutsReport);
