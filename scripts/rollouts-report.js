/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { LitElement, html } from "../vendor/lit3/lit-all.min.js";
import sheet from "../styles/rollouts-report.css" with { type: "css" };
import { getRolloutSaturation } from "./saturation.js";

// The Redash dashboard the saturation reading corresponds to, which breaks the
// same numbers out by version and over time. This is the shorter-window
// dashboard rather than the original, because it reads the same addons ping
// this page does; the original reads the metrics ping, whose
// addons_active_addons snapshot trails it by roughly a session.
const UPTAKE_DASHBOARD_URL =
  "https://sql.telemetry.mozilla.org/dashboard/new-tab-train-hop-uptake---shorter-window";

class RolloutsReport extends LitElement {
  static styles = sheet;

  static properties = {
    rollouts: { type: Object },
    saturation: { type: Object, state: true },
    saturationPending: { type: Boolean, state: true },
  };

  /** The rollout list a saturation request has already been made for. */
  #requestedSaturationFor = null;

  constructor() {
    super();
    this.rollouts = null;
    this.saturation = null;
    this.saturationPending = false;
  }

  updated() {
    // Saturation costs a BigQuery read, so it is only ever asked for once the
    // rollouts themselves have painted, and never blocks that paint.
    if (!this.rollouts || this.#requestedSaturationFor === this.rollouts) {
      return;
    }

    this.#requestedSaturationFor = this.rollouts;
    this.saturationPending = true;
    getRolloutSaturation(this.rollouts).then(saturation => {
      this.saturation = saturation;
      this.saturationPending = false;
    });
  }

  /**
   * Renders how far a rollout has saturated: the share of the clients that
   * reported on the measured day which had its add-on version enabled. Absent
   * until the reading arrives, and omitted entirely if it is unavailable.
   *
   * @param {Object} rollout - The rollout being reported on
   * @returns {import("../vendor/lit3/lit-all.min.js").TemplateResult|string}
   */
  #saturationFor(rollout) {
    if (this.saturationPending) {
      // A cold read is a ~8s BigQuery query; a cached one is a single fetch.
      // The throbber fades in late enough that the cached case does not flash.
      return html`<span
        class="saturation-pending"
        title="Reading saturation from BigQuery..."
        role="progressbar"
        aria-label="Reading saturation"
      ></span>`;
    }

    if (!this.saturation) {
      return "";
    }

    const counts = this.saturation.bySlug?.[rollout.slug];
    if (!counts?.reporting) {
      return "";
    }

    const PERCENTAGE = (counts.onVersion / counts.reporting) * 100;
    const TOOLTIP =
      `${counts.onVersion.toLocaleString()} of the ` +
      `${counts.reporting.toLocaleString()} clients reporting on ` +
      `${this.saturation.day} had add-on version ${rollout.addonVersion} ` +
      `enabled`;

    return html`<a
      class="saturation"
      href="${UPTAKE_DASHBOARD_URL}"
      target="_blank"
      rel="noopener"
      title="${TOOLTIP} — see the full uptake dashboard"
      >${PERCENTAGE.toFixed(1)}% saturated</a
    >`;
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
            at <strong>${PERCENTAGE}%</strong>${this.#saturationFor(rollout)}
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
      ${this.saturation
        ? html`<p class="saturation-note">
            Saturation is the share of the clients that reported on
            ${this.saturation.day} — the newest day the warehouse has published
            — which had the rollout's add-on version enabled. It is measured
            against the whole channel, so a rollout below 100% cannot reach
            100% here. Release is measured from a 1% sample.
          </p>`
        : ""}
    `;
  }
}

customElements.define("rollouts-report", RolloutsReport);
