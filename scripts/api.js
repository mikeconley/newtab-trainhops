/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { buildLocalesReport } from "./locales.js";

export { buildLocalesReport };

const FIREFOX_REPO_API = "https://api.github.com/repos/mozilla-firefox/firefox";

// hg.mozilla.org sits behind a Fastly bot challenge that serves an HTML
// "Client Challenge" page (with no CORS headers) to anything sending a browser
// User-Agent, which a page's fetch() can never avoid. Requesting
// Accept: application/json from the hg-edge origin directly returns real JSON
// with Access-Control-Allow-Origin. Accept is a CORS-safelisted header, so
// this still avoids a preflight. Going through hg.mozilla.org does not work:
// it challenges the redirect itself.
const HGMO_ORIGIN = "https://hg-edge.mozilla.org";
const HGMO_HEADERS = { Accept: "application/json" };
const TREEHERDER_API = "https://treeherder.mozilla.org/api";
const TRAIN_SCHEDULE_API = "https://whattrainisitnow.com/api/release/schedule";
const EXPERIMENTER_API =
  "https://experimenter.services.mozilla.com/api/v8/experiments/?status=Live&application=firefox-desktop&feature_config=newtabTrainhopAddon";

export const RELEASE_JOB_GROUP_SYMBOL = "M-trainhop-rel";
export const BETA_JOB_GROUP_SYMBOL = "M-trainhop-beta";

const EN_US_NEWTAB_FTL = "browser/locales/en-US/browser/newtab/newtab.ftl";

const SHA_RE = /^[0-9a-f]{7,40}$/i;

// Real mozilla-central work lands on "default"; ffxbld's tagging changesets go
// to "tags-unified" and exist only in Mercurial.
const DEFAULT_BRANCH = "default";

// How far back to reach per request when skipping over runs of tagging pushes.
const PUSH_PAGE_SIZE = 20;

/**
 * The repositories a revision may live in, in the order they are searched.
 * A revision that has not yet merged to mozilla-central can still be assessed
 * from autoland, which GitHub mirrors as its own branch of the same repo, so
 * git SHAs resolve there without any extra work.
 */
export const REPOS = [
  {
    name: "mozilla-central",
    hgPath: "mozilla-central",
    treeherder: "mozilla-central",
  },
  {
    name: "autoland",
    hgPath: "integration/autoland",
    treeherder: "autoland",
  },
];

const DEFAULT_REPO = REPOS[0].name;

/**
 * @param {string} name - A repository name from REPOS
 * @returns {Object} The matching repository descriptor
 */
export function getRepo(name) {
  return REPOS.find(repo => repo.name === name) ?? REPOS[0];
}

/**
 * Builds a link to a changeset on hg.mozilla.org for the right repository.
 * @param {string} hgSha - The Mercurial commit SHA
 * @param {string} repoName - A repository name from REPOS
 * @returns {string} The hgweb URL
 */
export function hgRevisionUrl(hgSha, repoName) {
  return `https://hg.mozilla.org/${getRepo(repoName).hgPath}/rev/${hgSha}`;
}

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

function fetchHgJSON(path, description, repoName = DEFAULT_REPO) {
  const { hgPath } = getRepo(repoName);
  return fetchJSON(
    `${HGMO_ORIGIN}/${hgPath}/${path}`,
    description,
    HGMO_HEADERS
  );
}

/**
 * Looks up a Mercurial changeset on hg.mozilla.org. The JSON includes a
 * git_commit field, which is how we map Mercurial SHAs back to git without
 * needing Lando (which does not send CORS headers).
 * @param {string} hgSha - The Mercurial commit SHA
 * @param {string} repoName - A repository name from REPOS
 * @returns {Promise<Object|null>} The changeset JSON, or null if not in this repo
 */
async function getHgRevision(hgSha, repoName) {
  const { hgPath } = getRepo(repoName);
  const response = await fetch(`${HGMO_ORIGIN}/${hgPath}/json-rev/${hgSha}`, {
    credentials: "omit",
    headers: HGMO_HEADERS,
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to look up ${hgSha}: ${response.status}`);
  }
  return response.json();
}

/**
 * Converts a Mercurial SHA to its corresponding Git SHA, searching
 * mozilla-central first and falling back to autoland.
 * @param {string} hgSha - The Mercurial commit SHA
 * @returns {Promise<{gitSha: string, repo: string}>} The Git SHA and its repo
 */
export async function getGitSha(hgSha) {
  const cached = shaCache.get(`hg2git:${hgSha}`);
  if (cached) {
    return {
      gitSha: cached,
      repo: shaCache.get(`hgrepo:${hgSha}`) ?? DEFAULT_REPO,
    };
  }

  let taggingBranch = null;

  for (const { name } of REPOS) {
    const revision = await getHgRevision(hgSha, name);
    if (!revision) {
      continue;
    }

    // Tagging changesets exist only in Mercurial. hgweb still reports a
    // git_commit, but it is not present on GitHub, so remember this and fail
    // with something more useful than the 404 a later request would produce.
    if (revision.branch && revision.branch !== DEFAULT_BRANCH) {
      taggingBranch = revision.branch;
      continue;
    }

    if (!revision.git_commit) {
      throw new Error(`No git commit recorded for Mercurial SHA ${hgSha}`);
    }

    shaCache.set(`hg2git:${hgSha}`, revision.git_commit);
    shaCache.set(`git2hg:${revision.git_commit}`, revision.node);
    shaCache.set(`hgrepo:${hgSha}`, name);
    shaCache.set(`gitrepo:${revision.git_commit}`, name);
    return { gitSha: revision.git_commit, repo: name };
  }

  if (taggingBranch) {
    throw new Error(
      `${shorten(hgSha)} is on the "${taggingBranch}" branch, not ` +
        `${DEFAULT_BRANCH}. Automated tagging changesets have no counterpart ` +
        `on GitHub and cannot be assessed.`
    );
  }

  throw new Error(
    `Revision ${shorten(hgSha)} was not found in ` +
      `${REPOS.map(r => r.name).join(" or ")}`
  );
}

/**
 * Converts a Git SHA to its corresponding Mercurial SHA.
 *
 * hgweb cannot be queried by git SHA, so we find the commit's date on GitHub
 * and scan the hg pushlog around that date for a changeset whose git_node
 * matches. mozilla-central is mirrored to Mercurial in batched pushes and
 * autoland lands one or two changesets at a time, so a few days of pushlog is
 * a small, bounded amount of data in both cases.
 *
 * mozilla-central is searched first, then autoland, so a revision that has
 * merged is always reported against the repository it merged into.
 *
 * @param {string} gitSha - The Git commit SHA
 * @returns {Promise<{hgSha: string, repo: string}>} The Mercurial SHA and repo
 */
export async function getHgSha(gitSha) {
  const cached = shaCache.get(`git2hg:${gitSha}`);
  if (cached) {
    return {
      hgSha: cached,
      repo: shaCache.get(`gitrepo:${gitSha}`) ?? DEFAULT_REPO,
    };
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
    const window =
      `json-pushes?version=2&full=1` +
      `&startdate=${toHgDate(start)}&enddate=${toHgDate(end)}`;

    for (const { name } of REPOS) {
      const pushes = await fetchHgJSON(
        window,
        `fetch the ${name} pushlog`,
        name
      );

      for (const push of Object.values(pushes.pushes ?? {})) {
        for (const changeset of push.changesets) {
          if (changeset.git_node === fullGitSha) {
            shaCache.set(`git2hg:${fullGitSha}`, changeset.node);
            shaCache.set(`hg2git:${changeset.node}`, fullGitSha);
            shaCache.set(`gitrepo:${fullGitSha}`, name);
            shaCache.set(`hgrepo:${changeset.node}`, name);
            return { hgSha: changeset.node, repo: name };
          }
        }
      }
    }
  }

  throw new Error(
    `Could not find ${shorten(fullGitSha)} in the ` +
      `${REPOS.map(r => r.name).join(" or ")} Mercurial mirrors. Very recent ` +
      `commits may not be mirrored yet.`
  );
}

function toHgDate(date) {
  return date.toISOString().slice(0, 10);
}

export function shorten(sha) {
  return sha ? sha.slice(0, 12) : sha;
}

/**
 * Resolves whatever the user typed into both SHA flavours, along with the
 * repository it was found in.
 * @param {string} sha - A Git or Mercurial commit SHA, or empty for the latest
 * @param {string} shaType - Either "git" or "hg"
 * @returns {Promise<{gitSha: string, hgSha: string, repo: string}>} The revision
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
    const { gitSha, repo } = await getGitSha(trimmed);
    // getGitSha resolves short SHAs via hgweb, so re-read the canonical node.
    const hgSha = shaCache.get(`git2hg:${gitSha}`) ?? trimmed;
    return { gitSha, hgSha, repo };
  }

  const { hgSha, repo } = await getHgSha(trimmed);
  return { gitSha: shaCache.get(`hg2git:${hgSha}`) ?? trimmed, hgSha, repo };
}

/**
 * Gets the most recent mozilla-central revision worth assessing.
 *
 * Automated tagging pushes (ffxbld touching only .hgtags) land on the
 * tags-unified branch rather than default. They exist only in Mercurial, so
 * although hgweb reports a git_node for them, that SHA is absent from GitHub
 * and every subsequent lookup 404s. Runs of four or more such pushes in a row
 * are common, so walk back until a real default-branch push turns up.
 *
 * @returns {Promise<{gitSha: string, hgSha: string, repo: string}>} The revision
 */
export async function getLatestRevision() {
  // tipsonly keeps this to one changeset per push, so full detail is cheap.
  let query = "json-pushes?version=2&full=1&tipsonly=1";

  for (let attempt = 0; attempt < 4; attempt++) {
    const pushes = (await fetchHgJSON(query, "fetch the latest pushes")).pushes;
    const ids = Object.keys(pushes ?? {})
      .map(Number)
      .sort((a, b) => b - a);

    if (!ids.length) {
      break;
    }

    for (const id of ids) {
      const tip = pushes[id].changesets[pushes[id].changesets.length - 1];
      if (tip.branch === DEFAULT_BRANCH) {
        const hgSha = tip.node;
        const gitSha = tip.git_node ?? (await getGitSha(hgSha)).gitSha;
        shaCache.set(`hg2git:${hgSha}`, gitSha);
        shaCache.set(`git2hg:${gitSha}`, hgSha);
        shaCache.set(`hgrepo:${hgSha}`, DEFAULT_REPO);
        shaCache.set(`gitrepo:${gitSha}`, DEFAULT_REPO);
        return { gitSha, hgSha, repo: DEFAULT_REPO };
      }
    }

    // Every push in this batch was a tagging push, so page further back. endID
    // is ignored unless startID is given too, and the range it returns is
    // exclusive of startID and inclusive of endID.
    const end = Math.min(...ids) - 1;
    if (end < 1) {
      break;
    }
    const start = Math.max(0, end - PUSH_PAGE_SIZE);
    query =
      `json-pushes?version=2&full=1&tipsonly=1` +
      `&startID=${start}&endID=${end}`;
  }

  throw new Error(
    "Could not find a recent mozilla-central push on the default branch"
  );
}

/**
 * Gets push data and trainhop jobs from Treeherder for a Mercurial SHA.
 * @param {string} hgSha - The Mercurial commit SHA
 * @param {string} repoName - A repository name from REPOS
 * @returns {Promise<Object>} The push data, trainhop jobs and a summary
 */
export async function getPushData(hgSha, repoName = DEFAULT_REPO) {
  const project = getRepo(repoName).treeherder;
  const pushData = await fetchJSON(
    `${TREEHERDER_API}/project/${project}/push/?full=true&count=10&revision=${hgSha}`,
    `fetch push data from Treeherder (${project})`
  );

  if (!pushData.results?.length) {
    throw new Error(
      `No push data found for Mercurial SHA ${shorten(hgSha)} on ${project}`
    );
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

  return {
    push,
    trainhopJobs,
    summary: summarizeJobs(trainhopJobs),
    repo: repoName,
  };
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
 *
 * These gate the locales report, so they are fetched before the rest of the
 * revision data in order to give the caller a chance to supply them by hand.
 *
 * @returns {Promise<{betaStartDate: string|null, releaseStartDate: string|null}>}
 */
export async function getMergeDates() {
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

    // mach_commands.py guesstimates this one by taking the first beta build of
    // the release version and walking back to the previous Monday, because the
    // endpoint used not to report a merge date for the release channel. It does
    // now, and the guess is usually wrong: merge day has been a Tuesday for
    // most recent cycles and a Thursday for 155, so read it directly instead.
    if (releaseResponse.ok) {
      const releaseData = await releaseResponse.json();
      releaseStartDate = Temporal.PlainDate.from(releaseData.merge_day).toString();
    }

    return { betaStartDate, releaseStartDate };
  } catch (error) {
    console.warn("Failed to fetch merge dates from API:", error);
    return { betaStartDate: null, releaseStartDate: null };
  }
}

/**
 * Gets all revision data for train-hop assessment.
 *
 * The locales report is recomputed from firefox-l10n rather than read from the
 * checked-in locales-report.json, because non-en-US strings are now pulled from
 * that repository at build time and can change between builds of the same
 * Firefox revision.
 *
 * @param {string} gitSha - The Git commit SHA
 * @param {string} hgSha - The matching Mercurial commit SHA
 * @param {Object} options
 * @param {string} options.betaStartDate - Beta merge date (YYYY-MM-DD)
 * @param {string} options.releaseStartDate - Release merge-to-beta date
 * @param {function(string): void} [options.onProgress] - Progress callback
 * @returns {Promise<Object>} All revision data
 */
export async function getRevisionData(
  gitSha,
  hgSha,
  { repo = DEFAULT_REPO, betaStartDate, releaseStartDate, onProgress }
) {
  const [pushData, newtabFtlInfo, rolloutData, localesReport] =
    await Promise.all([
      getPushData(hgSha, repo),
      getGitHubFileInfo(gitSha, EN_US_NEWTAB_FTL),
      getRolloutData(),
      buildLocalesReport({
        gitSha,
        betaStartDate,
        releaseStartDate,
        onProgress,
      }),
    ]);

  return {
    gitSha,
    hgSha,
    repo,
    pushData,
    newtabFtlLastModified: newtabFtlInfo.lastModifiedDate,
    localesReport,
    betaStartDate,
    releaseStartDate,
    rolloutData,
  };
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
