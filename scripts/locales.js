/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  FluentParser,
  FluentSerializer,
  Junk,
  Message,
  Term,
} from "../vendor/fluent-syntax/index.js";

const GITHUB_API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const FIREFOX_REPO = "mozilla-firefox/firefox";
const L10N_REPO = "mozilla-l10n/firefox-l10n";

const SHIPPED_LOCALES_PATH = "browser/locales/shipped-locales";
const EN_US_NEWTAB_FTL = "browser/locales/en-US/browser/newtab/newtab.ftl";
const EN_US_PREFERENCES_FTL =
  "browser/locales/en-US/browser/preferences/preferences.ftl";

// The l10n repo mirrors browser/locales/en-US/** under <locale>/browser/**, so
// the "browser" component name is duplicated. Mirrors the ancestry constants in
// browser/extensions/newtab/mach_commands.py.
const l10nNewtabPath = locale => `${locale}/browser/browser/newtab/newtab.ftl`;
const l10nPreferencesPath = locale =>
  `${locale}/browser/browser/preferences/preferences.ftl`;

// @backward-compat { version 155 }
// The 13 homepage-settings strings live in preferences.ftl but are appended
// into the XPI's bundled newtab.ftl, so they count toward the locale report.
const PREFERENCES_EXTRACT_IDS = new Set([
  "home-homepage-title",
  "home-homepage-new-windows",
  "home-homepage-new-tabs",
  "home-homepage-custom-homepage-button",
  "home-custom-homepage-card-header",
  "home-custom-homepage-address",
  "home-custom-homepage-address-button",
  "home-custom-homepage-no-results",
  "home-custom-homepage-delete-address-button",
  "home-custom-homepage-replace-with-prompt",
  "home-custom-homepage-current-pages-button",
  "home-custom-homepage-bookmarks-button",
  "home-prefs-homepage-extension-option",
]);

// raw.githubusercontent.com is not subject to the api.github.com rate limit, so
// all file content is fetched from there. Only commit listings use the API.
const FETCH_CONCURRENCY = 12;

const parser = new FluentParser({ withSpans: false });
const serializer = new FluentSerializer({ withJunk: false });

/**
 * Runs tasks with a bounded number in flight at once.
 * @param {Array<*>} items - The items to process
 * @param {function(*, number): Promise<*>} worker - Called per item
 * @param {function(number, number): void} [onProgress] - done/total callback
 * @returns {Promise<Array<*>>} Results, in the same order as items
 */
async function mapWithConcurrency(items, worker, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;

  async function run() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
      onProgress?.(++done, items.length);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, items.length) }, run)
  );
  return results;
}

async function fetchText(url) {
  const response = await fetch(url, { credentials: "omit" });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

function rawFirefox(gitSha, path) {
  return fetchText(`${RAW}/${FIREFOX_REPO}/${gitSha}/${path}`);
}

function rawL10n(revision, path) {
  return fetchText(`${RAW}/${L10N_REPO}/${revision}/${path}`);
}

/**
 * Builds the text used to decide whether a message has changed since a
 * snapshot, and so how old it is.
 *
 * The in-tree tool derives message ages from `git blame`, and its regex
 * (`^([a-z-]+[^\s]+) `) only matches the line the message id sits on. Rewording
 * a value therefore resets a string's age, but editing its attributes (indented
 * lines) or the developer comment above it does not. Serializing the whole
 * entry would wrongly reset the age whenever a comment was touched, so compare
 * the id and its value alone.
 *
 * @param {Object} entry - A Fluent Message or Term AST node
 * @param {string} id - The entry's id, with the "-" prefix for terms
 * @returns {string} Text that changes only when the id's own line does
 */
function comparableText(entry, id) {
  if (!entry.value) {
    // Attribute-only messages have just "id =" on the id's line.
    return `${id} =`;
  }

  const bare =
    entry instanceof Term
      ? new Term(entry.id, entry.value)
      : new Message(entry.id, entry.value);
  return serializer.serializeEntry(bare);
}

/**
 * Parses a Fluent file into a map of message id to comparable text.
 *
 * Mirrors moz.l10n's parse_resource + msg_ids: one entry per Message or Term
 * (terms prefixed with "-"), attributes are *not* separate entries, and any
 * Junk makes the whole file an error.
 *
 * @param {string} source - The Fluent file contents
 * @returns {Map<string, string>} Message id to its comparable text
 * @throws {Error} If the file contains Fluent syntax errors
 */
function parseEntries(source) {
  const resource = parser.parse(source);
  const entries = new Map();

  for (const entry of resource.body) {
    if (entry instanceof Junk) {
      const annotation = entry.annotations?.[0];
      throw new Error(annotation?.message || "Fluent parser error");
    }
    if (entry instanceof Message || entry instanceof Term) {
      const id = (entry instanceof Term ? "-" : "") + entry.id.name;
      entries.set(id, comparableText(entry, id));
    }
  }

  return entries;
}

/**
 * Extracts the PREFERENCES_EXTRACT_IDS messages from a preferences.ftl.
 *
 * The in-tree tooling uses fluent.syntax.parse here rather than moz.l10n's
 * stricter parse_resource, so Junk is tolerated instead of failing the file.
 *
 * @param {string|null} source - The preferences.ftl contents, or null if absent
 * @returns {Map<string, string>} Message id to its serialized text
 */
function extractPreferencesEntries(source) {
  const extracted = new Map();
  if (!source) {
    return extracted;
  }

  let resource;
  try {
    resource = parser.parse(source);
  } catch {
    return extracted;
  }

  for (const entry of resource.body) {
    // Messages only - the in-tree extract ignores Terms.
    if (entry instanceof Message && PREFERENCES_EXTRACT_IDS.has(entry.id.name)) {
      extracted.set(entry.id.name, serializer.serializeEntry(entry));
    }
  }

  return extracted;
}

/**
 * Fetches the list of shipped locales at a revision.
 * @param {string} gitSha - The Git commit SHA
 * @returns {Promise<Array<string>>} The shipped locale codes, minus en-US
 */
export async function getShippedLocales(gitSha) {
  const source = await rawFirefox(gitSha, SHIPPED_LOCALES_PATH);
  if (!source) {
    throw new Error(`No shipped-locales file at ${gitSha}`);
  }

  return source
    .split("\n")
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#") && line !== "en-US");
}

/**
 * Finds the newest commit touching a path at or before a date, and returns the
 * file's entries as of that commit.
 * @param {string} path - Repository-relative file path
 * @param {string} isoDate - Cutoff date, as an ISO 8601 string
 * @returns {Promise<Map<string, string>|null>} Entries, or null if unavailable
 */
async function getEntriesAsOf(path, isoDate) {
  // The version suffix retires snapshots cached under an older definition of
  // an entry's comparable text.
  const cacheKey = `snapshot2:${path}@${isoDate}`;
  const cached = readCache(cacheKey);
  if (cached) {
    return new Map(cached);
  }

  const commits = await fetchJSON(
    `${GITHUB_API}/repos/${FIREFOX_REPO}/commits` +
      `?path=${encodeURIComponent(path)}&until=${isoDate}&per_page=1`
  );
  if (!commits.length) {
    return null;
  }

  const source = await rawFirefox(commits[0].sha, path);
  if (!source) {
    return null;
  }

  let entries;
  try {
    entries = parseEntries(source);
  } catch {
    return null;
  }

  writeCache(cacheKey, [...entries]);
  return entries;
}

async function fetchJSON(url) {
  const response = await fetch(url, { credentials: "omit" });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.json();
}

function readCache(key) {
  try {
    const raw = localStorage.getItem(`trainhop:${key}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeCache(key, value) {
  try {
    localStorage.setItem(`trainhop:${key}`, JSON.stringify(value));
  } catch {
    /* Quota or private browsing - caching is best-effort. */
  }
}

/**
 * Buckets each en-US message by how long it has been on the beta channel.
 *
 * The in-tree tool derives this from `git blame`, which GitHub's REST API does
 * not expose. The classification only ever needs to know which side of the
 * release and beta merge dates a message falls on, so comparing the current
 * entries against snapshots taken at those two dates is equivalent, and costs
 * two requests instead of one per commit.
 *
 * An entry counts as unchanged only if its serialized text is identical, which
 * approximates blame's last-modified-line semantics: rewording a string resets
 * its age, just as it would in blame.
 *
 * @param {Map<string, string>} current - Entries at the revision under test
 * @param {Map<string, string>|null} atRelease - Entries at the release merge
 * @param {Map<string, string>|null} atBeta - Entries at the beta merge
 * @returns {Map<string, string>} Message id to "pre-release", "pre-beta" or "new"
 */
function bucketMessageAges(current, atRelease, atBeta) {
  const ages = new Map();

  for (const [id, text] of current) {
    if (atRelease?.get(id) === text) {
      ages.set(id, "pre-release");
    } else if (atBeta?.get(id) === text) {
      ages.set(id, "pre-beta");
    } else {
      ages.set(id, "new");
    }
  }

  return ages;
}

/**
 * Decides whether an untranslated string is missing or merely pending.
 *
 * Mirrors display_report() in mach_commands.py: anything that predates the
 * release merge has clearly had long enough to be translated, and anything that
 * predates the beta merge is also considered missing once the current beta has
 * been out for longer than the three week fallback threshold.
 *
 * @param {string} age - A bucket from bucketMessageAges
 * @param {boolean} betaThresholdPassed - Whether beta has been out over 3 weeks
 * @returns {string} Either "missing" or "pending"
 */
function classify(age, betaThresholdPassed) {
  if (age === "pre-release") {
    return "missing";
  }
  if (age === "pre-beta" && betaThresholdPassed) {
    return "missing";
  }
  return "pending";
}

/**
 * Builds the newtab locales report for a revision.
 *
 * Unlike the checked-in locales-report.json this recomputes everything live,
 * because localizations are now pulled from firefox-l10n at build time and can
 * change between builds of the same Firefox revision.
 *
 * @param {Object} options
 * @param {string} options.gitSha - The Firefox revision under test
 * @param {string} options.betaStartDate - Beta merge date (YYYY-MM-DD)
 * @param {string} options.releaseStartDate - Release merge-to-beta date
 * @param {function(string): void} [options.onProgress] - Progress callback
 * @param {string} [options.pinnedL10nRevision] - Read this firefox-l10n
 *   revision instead of its current HEAD, for reproducible comparisons
 * @returns {Promise<Object>} The locales report
 */
export async function buildLocalesReport({
  gitSha,
  betaStartDate,
  releaseStartDate,
  onProgress,
  pinnedL10nRevision,
}) {
  onProgress?.("Fetching shipped locales and en-US strings...");

  const l10nCommits = await fetchJSON(
    `${GITHUB_API}/repos/${L10N_REPO}/commits?per_page=1` +
      (pinnedL10nRevision ? `&sha=${pinnedL10nRevision}` : "")
  );
  const l10nRevision = l10nCommits[0].sha;
  const l10nUpdated = l10nCommits[0].commit.committer.date;

  const [locales, enUsNewtab, enUsPreferences] = await Promise.all([
    getShippedLocales(gitSha),
    rawFirefox(gitSha, EN_US_NEWTAB_FTL),
    rawFirefox(gitSha, EN_US_PREFERENCES_FTL),
  ]);

  if (!enUsNewtab) {
    throw new Error(`No ${EN_US_NEWTAB_FTL} at ${gitSha}`);
  }

  // The XPI's en-US newtab.ftl is the source file plus the preferences extract.
  const sourceEntries = parseEntries(enUsNewtab);
  const enUsExtract = extractPreferencesEntries(enUsPreferences);
  for (const [id, text] of enUsExtract) {
    sourceEntries.set(id, text);
  }

  onProgress?.("Dating en-US strings against the merge dates...");

  const releaseCutoff = `${releaseStartDate}T00:00:00Z`;
  const betaCutoff = `${betaStartDate}T00:00:00Z`;

  const [
    newtabAtRelease,
    newtabAtBeta,
    prefsAtRelease,
    prefsAtBeta,
  ] = await Promise.all([
    getEntriesAsOf(EN_US_NEWTAB_FTL, releaseCutoff),
    getEntriesAsOf(EN_US_NEWTAB_FTL, betaCutoff),
    getEntriesAsOf(EN_US_PREFERENCES_FTL, releaseCutoff),
    getEntriesAsOf(EN_US_PREFERENCES_FTL, betaCutoff),
  ]);

  const atRelease = mergeSnapshots(newtabAtRelease, prefsAtRelease);
  const atBeta = mergeSnapshots(newtabAtBeta, prefsAtBeta);
  const messageAges = bucketMessageAges(sourceEntries, atRelease, atBeta);

  const betaThresholdPassed =
    Temporal.Duration.compare(
      Temporal.Now.plainDateISO().since(Temporal.PlainDate.from(betaStartDate)),
      Temporal.Duration.from({ weeks: 3 }),
      { relativeTo: Temporal.Now.plainDateISO() }
    ) === 1;

  onProgress?.(`Comparing ${locales.length} locales...`);

  const sourceIds = [...sourceEntries.keys()];
  const results = await mapWithConcurrency(
    locales,
    locale => compareLocale(locale, l10nRevision, sourceIds),
    (done, total) => onProgress?.(`Comparing locales... ${done}/${total}`)
  );

  const localeReports = {};
  for (const [index, locale] of locales.entries()) {
    const result = results[index];
    localeReports[locale] = result.error
      ? { error: result.error, missing: [], pending: [] }
      : splitByAge(result.missing, messageAges, betaThresholdPassed);
  }

  return {
    locales: localeReports,
    sourceMessageCount: sourceEntries.size,
    meta: {
      firefoxRevision: gitSha,
      l10nRepository: `https://github.com/${L10N_REPO}`,
      l10nRevision,
      l10nUpdated,
      betaStartDate,
      releaseStartDate,
      betaThresholdPassed,
    },
  };
}

function mergeSnapshots(newtabEntries, preferencesEntries) {
  if (!newtabEntries && !preferencesEntries) {
    return null;
  }

  const merged = new Map(newtabEntries ?? []);
  if (preferencesEntries) {
    for (const id of PREFERENCES_EXTRACT_IDS) {
      const text = preferencesEntries.get(id);
      if (text !== undefined) {
        merged.set(id, text);
      }
    }
  }
  return merged;
}

/**
 * Fetches one locale's strings and diffs them against the en-US source.
 * @param {string} locale - The locale code
 * @param {string} l10nRevision - firefox-l10n revision to read
 * @param {Array<string>} sourceIds - The en-US message ids
 * @returns {Promise<{missing: Array<string>, error: string|null}>} The diff
 */
async function compareLocale(locale, l10nRevision, sourceIds) {
  let newtabSource;
  let preferencesSource;

  try {
    [newtabSource, preferencesSource] = await Promise.all([
      rawL10n(l10nRevision, l10nNewtabPath(locale)),
      rawL10n(l10nRevision, l10nPreferencesPath(locale)),
    ]);
  } catch (error) {
    return { missing: [], error: error.message };
  }

  // A locale with no newtab.ftl at all is missing every string, which matches
  // compare.py treating FileNotFoundError as a wholly absent file.
  if (!newtabSource) {
    return { missing: [...sourceIds], error: null };
  }

  let targetIds;
  try {
    targetIds = new Set(parseEntries(newtabSource).keys());
  } catch (error) {
    // Fluent Junk invalidates the whole file, as it does in moz.l10n.
    return { missing: [], error: error.message };
  }

  for (const id of extractPreferencesEntries(preferencesSource).keys()) {
    targetIds.add(id);
  }

  return {
    missing: sourceIds.filter(id => !targetIds.has(id)).sort(),
    error: null,
  };
}

function splitByAge(missingIds, messageAges, betaThresholdPassed) {
  const missing = [];
  const pending = [];

  for (const id of missingIds) {
    const age = messageAges.get(id) ?? "pre-release";
    if (classify(age, betaThresholdPassed) === "missing") {
      missing.push(id);
    } else {
      pending.push(id);
    }
  }

  return { missing, pending, error: null };
}
