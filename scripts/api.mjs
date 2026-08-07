/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const FIREFOX_REPO_API = "https://api.github.com/repos/mozilla-firefox/firefox";

// hg.mozilla.org sits behind a Fastly bot challenge that serves an HTML
// "Client Challenge" page (with no CORS headers) to anything sending a browser
// User-Agent, which a page's fetch() can never avoid. Requesting
// Accept: application/json from the hg-edge origin directly returns real JSON
// with Access-Control-Allow-Origin. Accept is a CORS-safelisted header, so
// this still avoids a preflight. Going through hg.mozilla.org does not work:
// it challenges the redirect itself.
const HGMO_API = "https://hg-edge.mozilla.org/mozilla-central";
const HGMO_HEADERS = { Accept: "application/json" };
const TREEHERDER_API = "https://treeherder.mozilla.org/api";
const TRAIN_SCHEDULE_API = "https://whattrainisitnow.com/api/release/schedule";
const EXPERIMENTER_API =
  "https://experimenter.services.mozilla.com/api/v8/experiments/?status=Live&application=firefox-desktop&feature_config=newtabTrainhopAddon";

export const RELEASE_JOB_GROUP_SYMBOL = "M-trainhop-rel";
export const BETA_JOB_GROUP_SYMBOL = "M-trainhop-beta";

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * The git <-> hg mapping for a landed changeset never changes, so it is safe
 * to cache forever. Replaces the browser.storage.local cache used by the
 * WebExtension version.
 */
const shaCache = {
  get(key) {
    try {
      return localStorage.getItem(`trainhop:${key}`);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`trainhop:${key}`, value);
    } catch {
      /* Private browsing or a full quota is not fatal here. */
    }
  },
};

async function fetchJSON(url, description, headers) {
  const response = await fetch(url, { credentials: "omit", headers });
  if (!response.ok) {
    throw new Error(`Failed to ${description}: ${response.status}`);
  }
  return response.json();
}

function fetchHgJSON(path, description) {
  return fetchJSON(`${HGMO_API}/${path}`, description, HGMO_HEADERS);
}

/**
 * Looks up a Mercurial changeset on hg.mozilla.org. The JSON includes a
 * git_commit field, which is how we map Mercurial SHAs back to git without
 * needing Lando (which does not send CORS headers).
 * @param {string} hgSha - The Mercurial commit SHA
 * @returns {Promise<Object>} The changeset JSON from hgweb
 */
async function getHgRevision(hgSha) {
  const response = await fetch(`${HGMO_API}/json-rev/${hgSha}`, {
    credentials: "omit",
    headers: HGMO_HEADERS,
  });
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Revision ${hgSha} not found on hg.mozilla.org`);
    }
    throw new Error(`Failed to look up ${hgSha}: ${response.status}`);
  }
  return response.json();
}

/**
 * Converts a Mercurial SHA to its corresponding Git SHA.
 * @param {string} hgSha - The Mercurial commit SHA
 * @returns {Promise<string>} The corresponding Git SHA
 */
export async function getGitSha(hgSha) {
  const cached = shaCache.get(`hg2git:${hgSha}`);
  if (cached) {
    return cached;
  }

  const revision = await getHgRevision(hgSha);
  if (!revision.git_commit) {
    throw new Error(`No git commit recorded for Mercurial SHA ${hgSha}`);
  }

  shaCache.set(`hg2git:${hgSha}`, revision.git_commit);
  shaCache.set(`git2hg:${revision.git_commit}`, revision.node);
  return revision.git_commit;
}

/**
 * Converts a Git SHA to its corresponding Mercurial SHA.
 *
 * hgweb cannot be queried by git SHA, so we find the commit's date on GitHub
 * and scan the hg pushlog around that date for a changeset whose git_node
 * matches. mozilla-central is mirrored to Mercurial in batched pushes, so a
 * few days of pushlog is a small, bounded amount of data.
 *
 * @param {string} gitSha - The Git commit SHA
 * @returns {Promise<string>} The corresponding Mercurial SHA
 */
export async function getHgSha(gitSha) {
  const cached = shaCache.get(`git2hg:${gitSha}`);
  if (cached) {
    return cached;
  }

  const commit = await fetchJSON(
    `${FIREFOX_REPO_API}/commits/${gitSha}`,
    `look up commit ${gitSha} on GitHub`
  );

  // Normalize to the full SHA, since the caller may have given us a short one.
  const fullGitSha = commit.sha;
  const commitDate = new Date(commit.commit.committer.date);

  // Widen the search until we find it. The mirror can lag the git repo, so a
  // very recent commit may simply not be in Mercurial yet.
  for (const daysAfter of [2, 7, 21]) {
    const start = new Date(commitDate);
    start.setUTCDate(start.getUTCDate() - 1);
    const end = new Date(commitDate);
    end.setUTCDate(end.getUTCDate() + daysAfter);

    const pushes = await fetchHgJSON(
      `json-pushes?version=2&full=1` +
        `&startdate=${toHgDate(start)}&enddate=${toHgDate(end)}`,
      "fetch the Mercurial pushlog"
    );

    for (const push of Object.values(pushes.pushes ?? {})) {
      for (const changeset of push.changesets) {
        if (changeset.git_node === fullGitSha) {
          shaCache.set(`git2hg:${fullGitSha}`, changeset.node);
          shaCache.set(`hg2git:${changeset.node}`, fullGitSha);
          return changeset.node;
        }
      }
    }
  }

  throw new Error(
    `Could not find ${shorten(fullGitSha)} in the mozilla-central Mercurial ` +
      `mirror. Very recent commits may not be mirrored yet.`
  );
}

function toHgDate(date) {
  return date.toISOString().slice(0, 10);
}

export function shorten(sha) {
  return sha ? sha.slice(0, 12) : sha;
}

/**
 * Resolves whatever the user typed into both SHA flavours.
 * @param {string} sha - A Git or Mercurial commit SHA, or empty for the latest
 * @param {string} shaType - Either "git" or "hg"
 * @returns {Promise<{gitSha: string, hgSha: string}>} Both SHAs
 */
export async function resolveRevision(sha, shaType) {
  const trimmed = sha.trim();

  if (!trimmed) {
    return getLatestRevision();
  }

  if (!SHA_RE.test(trimmed)) {
    throw new Error(`"${trimmed}" does not look like a commit SHA`);
  }

  if (shaType === "hg") {
    const gitSha = await getGitSha(trimmed);
    // getGitSha resolves short SHAs via hgweb, so re-read the canonical node.
    const hgSha = shaCache.get(`git2hg:${gitSha}`) ?? trimmed;
    return { gitSha, hgSha };
  }

  const hgSha = await getHgSha(trimmed);
  return { gitSha: shaCache.get(`hg2git:${hgSha}`) ?? trimmed, hgSha };
}

/**
 * Gets the most recent mozilla-central revision that has been mirrored to
 * Mercurial. This is the newest revision that can actually have Treeherder
 * results, which is what matters for a train-hop assessment.
 * @returns {Promise<{gitSha: string, hgSha: string}>} Both SHAs
 */
export async function getLatestRevision() {
  const pushes = await fetchHgJSON(
    "json-pushes?version=2&tipsonly=1",
    "fetch the latest push"
  );

  const ids = Object.keys(pushes.pushes ?? {});
  if (!ids.length) {
    throw new Error("No pushes found on mozilla-central");
  }

  const latest = pushes.pushes[Math.max(...ids.map(Number))];
  const hgSha = latest.changesets[latest.changesets.length - 1];
  const gitSha = await getGitSha(hgSha);

  return { gitSha, hgSha };
}

/**
 * Gets push data and trainhop jobs from Treeherder for a Mercurial SHA.
 * @param {string} hgSha - The Mercurial commit SHA
 * @returns {Promise<Object>} The push data, trainhop jobs and a summary
 */
export async function getPushData(hgSha) {
  const pushData = await fetchJSON(
    `${TREEHERDER_API}/project/mozilla-central/push/?full=true&count=10&revision=${hgSha}`,
    "fetch push data from Treeherder"
  );

  if (!pushData.results?.length) {
    throw new Error(`No push data found for Mercurial SHA: ${hgSha}`);
  }

  const push = pushData.results[0];

  // As of bug 2001438, the trainhop jobs are spread out across two
  // job_group_symbols: M-trainhop-rel and M-trainhop-beta.
  const [releaseJobsData, betaJobsData] = await Promise.all([
    fetchJSON(
      `${TREEHERDER_API}/jobs/?job_group_symbol=${RELEASE_JOB_GROUP_SYMBOL}&push_id=${push.id}`,
      "fetch release trainhop jobs from Treeherder"
    ),
    fetchJSON(
      `${TREEHERDER_API}/jobs/?job_group_symbol=${BETA_JOB_GROUP_SYMBOL}&push_id=${push.id}`,
      "fetch beta trainhop jobs from Treeherder"
    ),
  ]);

  const trainhopJobs = transformJobsData(releaseJobsData.job_property_names, [
    ...releaseJobsData.results,
    ...betaJobsData.results,
  ]);

  return { push, trainhopJobs, summary: summarizeJobs(trainhopJobs) };
}

/**
 * Produces a summary of whether the CI jobs look like they are passing.
 *
 * If there are only successes for a platform, then the platform is in the
 * "green" state. If there is 1 or more pending jobs for a platform, it is in
 * the "yellow" state. If there is only 1 failure per job type for a platform,
 * it is in the "yellow" state, unless there is also a green job of that type
 * for the platform (in which case it is green). If there are 2 or more
 * failures per job type for a platform, and no green jobs of that type, then
 * the platform is in the red state.
 *
 * @param {Array<Object>} trainhopJobs - The trainhop jobs for a push
 * @returns {Object} A per-platform, per-job-group status summary
 */
function summarizeJobs(trainhopJobs) {
  let platforms = new Map();

  for (let trainhopJob of trainhopJobs) {
    const PLATFORM_KEY = `${trainhopJob.platform} (${trainhopJob.platform_option})`;
    let status = platforms.get(PLATFORM_KEY) || {
      [BETA_JOB_GROUP_SYMBOL]: { passing: 0, failing: 0, unknown: 0 },
      [RELEASE_JOB_GROUP_SYMBOL]: { passing: 0, failing: 0, unknown: 0 },
    };

    let jobSymbol = status[trainhopJob.job_group_symbol];
    if (trainhopJob.result == "success") {
      jobSymbol.passing++;
    } else if (trainhopJob.result == "testfailed") {
      jobSymbol.failing++;
    } else {
      jobSymbol.unknown++;
    }

    platforms.set(PLATFORM_KEY, status);
  }

  let summary = {};

  for (let [platformKey, status] of platforms) {
    summary[platformKey] = {
      [BETA_JOB_GROUP_SYMBOL]: "unknown",
      [RELEASE_JOB_GROUP_SYMBOL]: "unknown",
    };

    for (let jobSymbol of [BETA_JOB_GROUP_SYMBOL, RELEASE_JOB_GROUP_SYMBOL]) {
      if (status[jobSymbol].passing) {
        summary[platformKey][jobSymbol] = "passing";
      } else if (status[jobSymbol].failing > 1 && !status[jobSymbol].unknown) {
        summary[platformKey][jobSymbol] = "failing";
      } else {
        summary[platformKey][jobSymbol] = "unknown";
      }
    }
  }

  return summary;
}

/**
 * Transforms Treeherder jobs data from array format to object format.
 * @param {Array<string>} jobPropertyNames - Property name for each index
 * @param {Array<Array>} jobsData - The raw jobs data from Treeherder
 * @returns {Array<Object>} Array of job objects with named properties
 */
function transformJobsData(jobPropertyNames, jobsData) {
  return jobsData.map(jobArray => {
    const jobObject = {};
    jobPropertyNames.forEach((propertyName, index) => {
      jobObject[propertyName] = jobArray[index];
    });
    return jobObject;
  });
}

/**
 * Fetches the Beta and Release merge dates from whattrainisitnow.com.
 * @returns {Promise<{betaStartDate: string|null, releaseStartDate: string|null}>}
 */
async function getBetaAndReleaseDates() {
  try {
    const [betaResponse, releaseResponse] = await Promise.all([
      fetch(`${TRAIN_SCHEDULE_API}/?version=beta`, { credentials: "omit" }),
      fetch(`${TRAIN_SCHEDULE_API}/?version=release`, { credentials: "omit" }),
    ]);

    let betaStartDate = null;
    let releaseStartDate = null;

    if (betaResponse.ok) {
      const betaData = await betaResponse.json();
      betaStartDate = Temporal.PlainDate.from(betaData.merge_day).toString();
    }

    // The release query needs to be different because the endpoint doesn't
    // actually tell us the merge-to-beta date for the version on the release
    // channel. We guesstimate it by getting at the build date for the first
    // beta of that version, and finding the last prior Monday.
    if (releaseResponse.ok) {
      const releaseData = await releaseResponse.json();
      let releaseStartDateObj = Temporal.PlainDate.from(releaseData.beta_1);
      const delta = (releaseStartDateObj.dayOfWeek + 6) % 7; // 0 if Monday, ..., 6 if Sunday
      releaseStartDate = releaseStartDateObj.subtract({ days: delta }).toString();
    }

    return { betaStartDate, releaseStartDate };
  } catch (error) {
    console.warn("Failed to fetch merge dates from API:", error);
    return { betaStartDate: null, releaseStartDate: null };
  }
}

/**
 * Gets all revision data in parallel for train-hop assessment.
 * @param {string} gitSha - The Git commit SHA
 * @param {string} hgSha - The matching Mercurial commit SHA
 * @returns {Promise<Object>} All revision data including files and push info
 */
export async function getRevisionData(gitSha, hgSha) {
  const [
    pushData,
    newtabFtlInfo,
    webextGlueFtlInfo,
    localesReport,
    mergeDates,
    rolloutData,
  ] = await Promise.all([
    getPushData(hgSha),
    getGitHubFileInfo(gitSha, "browser/locales/en-US/browser/newtab/newtab.ftl"),
    getGitHubFileInfo(
      gitSha,
      "browser/extensions/newtab/webext-glue/locales/en-US/browser/newtab/newtab.ftl"
    ),
    getGitHubFile(
      gitSha,
      "browser/extensions/newtab/webext-glue/locales/locales-report.json"
    ),
    getBetaAndReleaseDates(),
    getRolloutData(),
  ]);

  return {
    gitSha,
    hgSha,
    pushData,
    ftlComparison: compareNewtabFtlFileInfos(newtabFtlInfo, webextGlueFtlInfo),
    localesReport: JSON.parse(localesReport.decodedContent),
    betaStartDate: mergeDates.betaStartDate,
    releaseStartDate: mergeDates.releaseStartDate,
    rolloutData,
  };
}

/**
 * Fetches a file from the Firefox GitHub repository at a specific commit.
 * @param {string} gitSha - The Git commit SHA
 * @param {string} filePath - The path to the file in the repository
 * @returns {Promise<Object>} The file data from GitHub, with decodedContent
 */
async function getGitHubFile(gitSha, filePath) {
  const response = await fetch(
    `${FIREFOX_REPO_API}/contents/${filePath}?ref=${gitSha}`,
    { credentials: "omit" }
  );
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`File not found: ${filePath} at ${shorten(gitSha)}`);
    }
    throw new Error(`Failed to fetch file ${filePath}: ${response.status}`);
  }

  const fileData = await response.json();

  if (fileData.type === "file") {
    if (fileData.content && fileData.encoding == "base64") {
      fileData.decodedContent = decodeBase64UTF8(fileData.content);
    } else if (fileData.encoding == "none") {
      fileData.decodedContent = await (await fetch(fileData.download_url)).text();
    }
  }

  return fileData;
}

/**
 * atob() yields one byte per character, which mangles any non-ASCII content in
 * the locales report. Re-decode those bytes as UTF-8.
 * @param {string} base64 - Base64 content, possibly with embedded newlines
 * @returns {string} The decoded text
 */
function decodeBase64UTF8(base64) {
  const binary = atob(base64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Fetches file information (as opposed to the file contents) from the Firefox
 * GitHub repository at a specific commit.
 * @param {string} gitSha - The Git commit SHA
 * @param {string} filePath - The path to the file in the repository
 * @returns {Promise<{path: string, lastModifiedDate: string}>} The file info
 */
async function getGitHubFileInfo(gitSha, filePath) {
  const commits = await fetchJSON(
    `${FIREFOX_REPO_API}/commits?sha=${gitSha}&path=${filePath}&per_page=1`,
    `fetch file info for ${filePath}`
  );

  const [commitInfo] = commits;
  if (!commitInfo) {
    throw new Error(`No commits found touching ${filePath} at ${shorten(gitSha)}`);
  }

  return { path: filePath, lastModifiedDate: commitInfo.commit.author.date };
}

/**
 * Compares the last modified dates of the main and webext-glue newtab.ftl files.
 * @param {Object} newtabFtlInfo - Main newtab.ftl file info
 * @param {Object} webextGlueFtlInfo - Webext-glue newtab.ftl file info
 * @returns {Object} Comparison result with dates and sync status
 */
function compareNewtabFtlFileInfos(newtabFtlInfo, webextGlueFtlInfo) {
  const mainLastModified = new Date(newtabFtlInfo.lastModifiedDate);
  const webextLastModified = new Date(webextGlueFtlInfo.lastModifiedDate);

  const timeDiff = mainLastModified.getTime() - webextLastModified.getTime();
  const daysDiff = Math.round(timeDiff / (1000 * 60 * 60 * 24));

  let status = "in-sync";
  let message = "Files are in sync";

  if (timeDiff > 0) {
    status = "main-newer";
    message = `Main newtab.ftl is ${Math.abs(daysDiff)} day(s) newer than webext-glue version`;
  } else if (timeDiff < 0) {
    status = "webext-newer";
    message = `Webext-glue newtab.ftl is ${Math.abs(daysDiff)} day(s) newer than main version`;
  }

  return { status, message, daysDiff };
}

/**
 * Fetches the live Nimbus rollouts using the newtab train-hop add-on feature.
 * @returns {Promise<Array<Object>>} The matching rollouts, or [] on failure
 */
async function getRolloutData() {
  try {
    let response = await fetch(EXPERIMENTER_API, { credentials: "omit" });
    if (!response.ok) {
      return [];
    }

    let responseJSON = await response.json();
    return responseJSON.map(
      ({ slug, userFacingName, bucketConfig, channels }) => ({
        slug,
        userFacingName,
        bucketConfig,
        channels,
      })
    );
  } catch (e) {
    return [];
  }
}
