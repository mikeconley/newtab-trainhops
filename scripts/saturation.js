/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Reads how far each active rollout has saturated, by asking BigQuery (through
 * the Quick platform's read-only /api/query), of the clients that reported on a
 * given day, how many had that rollout's add-on version enabled.
 *
 * Two things shape this module:
 *
 * - The uptake dashboard's `firefox_desktop.metrics` cannot be read from Quick
 *   at all: every query against it, even a LIMIT 1, hits Quick's fixed 40s read
 *   timeout, because that table's schema is vast enough that planning alone
 *   overruns it. The `addons` ping carries the same
 *   metrics.object.addons_active_addons JSON with a small schema, and answers
 *   in seconds.
 * - A run reads ~10GB, and the warehouse only publishes one complete UTC day at
 *   a time, so the answer is cached site-wide in quick.data and recomputed at
 *   most once a day. Everything here runs after the report has painted.
 */

const ADDONS_TABLE = "`mozdata.firefox_desktop.addons`";
const NEWTAB_ADDON_ID = "newtab@mozilla.org";

// quick.data keys are restricted to [A-Za-z0-9_]. The version suffix is here so
// that changing the query shape invalidates every cached reading at once.
const CACHE_PREFIX = "rollout_saturation_v2_";

// How long to wait before probing again when the warehouse has not yet
// published a day newer than the one already cached.
const STALE_RECHECK_MS = 60 * 60 * 1000;

// How far back to look for the newest published day.
const FRESHNESS_WINDOW_DAYS = 4;

// Rather than escape values into SQL, anything not matching these is dropped.
const SLUG_RE = /^[A-Za-z0-9_-]+$/;
const VERSION_RE = /^[0-9][0-9A-Za-z._-]*$/;

// release is far too large to read whole, so it is read at the same 1% sample
// the uptake dashboard uses. The other channels are small enough to read fully.
const SAMPLED_CHANNELS = new Set(["release"]);
const KNOWN_CHANNELS = new Set(["release", "beta", "nightly", "aurora", "esr"]);

let inFlight = null;

/**
 * Fetches the saturation reading for a set of rollouts, preferring the
 * site-wide cached value. Concurrent callers share one request.
 *
 * @param {Array<Object>} rollouts - Rollouts from getRolloutData()
 * @returns {Promise<Object|null>} `{ day, bySlug: { slug: { reporting,
 *   onVersion } } }`, or null if unavailable (no Quick platform, no readable
 *   rollouts, or the query failed)
 */
export function getRolloutSaturation(rollouts) {
  inFlight ??= fetchSaturation(rollouts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function fetchSaturation(rollouts) {
  if (typeof quick === "undefined") {
    return null;
  }

  const targets = (rollouts ?? []).filter(
    rollout =>
      SLUG_RE.test(rollout.slug ?? "") &&
      VERSION_RE.test(rollout.addonVersion ?? "") &&
      (rollout.channels ?? []).some(channel => KNOWN_CHANNELS.has(channel))
  );

  if (!targets.length) {
    return null;
  }

  const key = cacheKeyFor(targets);

  try {
    const cached = await quick.data.get(key);

    // The common case: a reading for the newest day the warehouse could
    // possibly have published, so there is nothing to ask BigQuery.
    if (cached?.day >= previousUtcDay()) {
      return cached;
    }

    if (cached && Date.now() - (cached.checkedAt ?? 0) < STALE_RECHECK_MS) {
      return cached;
    }

    const day = await latestPublishedDay();
    if (!day) {
      return cached ?? null;
    }

    // The warehouse has not moved on since the cached reading was taken, so
    // just push the recheck out rather than paying for the same answer again.
    if (cached?.day === day) {
      const refreshed = { ...cached, checkedAt: Date.now() };
      await quick.data.set(key, refreshed);
      return refreshed;
    }

    const result = {
      day,
      bySlug: await runSaturationQuery(targets, day),
      checkedAt: Date.now(),
    };
    await quick.data.set(key, result);
    return result;
  } catch (e) {
    console.warn("Could not read rollout saturation:", e);
    return null;
  }
}

/**
 * Finds the newest complete day the addons ping has published. Today is always
 * excluded: the warehouse publishes a whole UTC day at a time, so a current-day
 * partition is either absent or partial.
 *
 * Reads only submission_timestamp on one small channel, so this costs a few
 * megabytes next to the ~11GB of the reading itself.
 *
 * @returns {Promise<string|null>} A YYYY-MM-DD day, or null if none was found
 */
async function latestPublishedDay() {
  const res = await quick.query(`
    SELECT FORMAT_DATE('%Y-%m-%d', DATE(submission_timestamp)) AS day
    FROM ${ADDONS_TABLE}
    WHERE submission_timestamp >=
            TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${FRESHNESS_WINDOW_DAYS} DAY)
      AND DATE(submission_timestamp) < CURRENT_DATE()
      AND normalized_channel = 'beta'
    GROUP BY day
    ORDER BY day DESC
    LIMIT 1
  `);

  return quick.rows(res)[0]?.day ?? null;
}

/**
 * Counts, per rollout, the clients that reported on a day and how many of those
 * had the add-on version that rollout deploys enabled.
 *
 * The denominator is every client that sent an addons ping on the rollout's
 * channels that day, so the reading answers "how much of the channel is on this
 * version" rather than "how far through its enrolled population is this
 * rollout". A rollout at less than 100% therefore cannot reach 100% here.
 *
 * One STRUCT per rollout/channel pair keeps the join key scalar; counting
 * DISTINCT client_id grouped by slug then unions a multi-channel rollout's
 * channels back together.
 *
 * @param {Array<Object>} targets - Validated rollouts
 * @param {string} day - The YYYY-MM-DD day to measure
 * @returns {Promise<Object>} Keyed by slug: `{ reporting, onVersion }`
 */
async function runSaturationQuery(targets, day) {
  const channels = new Set(targets.flatMap(target => target.channels));
  const structs = targets
    .flatMap(target =>
      target.channels
        .filter(channel => KNOWN_CHANNELS.has(channel))
        .map(
          channel =>
            `STRUCT('${target.slug}' AS slug, '${channel}' AS channel, ` +
            `'${target.addonVersion}' AS version)`
        )
    )
    .join(",\n      ");

  const res = await quick.query(`
    WITH base AS (
      SELECT
        normalized_channel AS channel,
        client_info.client_id AS client_id,
        ARRAY(SELECT JSON_VALUE(addon, '$.version')
              FROM UNNEST(JSON_QUERY_ARRAY(metrics.object.addons_active_addons)) AS addon
              WHERE JSON_VALUE(addon, '$.id') = '${NEWTAB_ADDON_ID}') AS newtab_versions
      FROM ${ADDONS_TABLE}
      WHERE DATE(submission_timestamp) = DATE '${day}'
        AND (${channelClause(channels)})
    ),
    rollouts AS (
      SELECT * FROM UNNEST([
      ${structs}
      ])
    )
    SELECT
      r.slug,
      COUNT(DISTINCT IF(b.channel = r.channel, b.client_id, NULL)) AS reporting,
      COUNT(DISTINCT IF(b.channel = r.channel
                        AND r.version IN UNNEST(b.newtab_versions),
                        b.client_id, NULL)) AS on_version
    FROM base b
    CROSS JOIN rollouts r
    GROUP BY r.slug
  `);

  const bySlug = {};
  for (const row of quick.rows(res)) {
    // Quick hands back every BigQuery number as a string.
    bySlug[row.slug] = {
      reporting: Number(row.reporting),
      onVersion: Number(row.on_version),
    };
  }
  return bySlug;
}

/**
 * @param {Set<string>} channels - The channels the rollouts target
 * @returns {string} A SQL predicate selecting those channels' rows
 */
function channelClause(channels) {
  const clauses = [];

  for (const channel of channels) {
    if (!KNOWN_CHANNELS.has(channel)) {
      continue;
    }
    clauses.push(
      SAMPLED_CHANNELS.has(channel)
        ? `(normalized_channel = '${channel}' AND sample_id = 0)`
        : `normalized_channel = '${channel}'`
    );
  }

  return clauses.join("\n          OR ");
}

/** @returns {string} Yesterday, UTC, as YYYY-MM-DD */
function previousUtcDay() {
  return Temporal.Now.plainDateISO("UTC").subtract({ days: 1 }).toString();
}

/**
 * Builds the quick.data key a set of rollouts is cached under. The key digests
 * the slugs and add-on versions being measured, so that a new rollout (or a
 * rollout repointed at a new add-on version) cannot read a stale reading.
 * FNV-1a is plenty here: this only has to change when the inputs do.
 *
 * @param {Array<Object>} targets - Validated rollouts
 * @returns {string} A key matching quick.data's [A-Za-z0-9_] restriction
 */
function cacheKeyFor(targets) {
  const input = targets
    .map(target => `${target.slug}@${target.addonVersion}`)
    .sort()
    .join(",");

  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return CACHE_PREFIX + (hash >>> 0).toString(16).padStart(8, "0");
}
