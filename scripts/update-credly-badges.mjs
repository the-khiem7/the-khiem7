import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

// Local run: CREDLY_PROFILE_URL=<profile url> CREDLY_USER_ID=<user id> node scripts/update-credly-badges.mjs
// Optional: README_PATH, CREDLY_BADGE_LIMIT, CREDLY_BADGES_PER_ROW, CREDLY_BADGE_FILTER.

/**
 * @typedef {object} Badge
 * @property {string} url
 * @property {string} imageUrl
 * @property {string} name
 * @property {string} provider
 * @property {string} [typeCategory] Credly template category, lowercased (e.g. "certification").
 * @property {string} [ownerSlug] Credly template owner vanity slug.
 */

/**
 * @typedef {object} SectionRule
 * @property {string} title
 * @property {(badge: Badge) => boolean} match
 * @property {number} [imageWidth]
 * @property {boolean} [centered]
 */

const START_MARKER = "<!-- credly-badges:start -->";
const END_MARKER = "<!-- credly-badges:end -->";
const PAGE_SIZE = 48;
const MAX_PAGES = 20;
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_RETRIES = 2;
const RETRY_DELAY_MS = 1_000;
const DEFAULT_BADGES_PER_ROW = 4;
const REQUEST_HEADERS = {
  "user-agent": "github-actions-credly-badge-sync",
  accept: "application/json",
};

// Dedicated sections shown above the general "Other Credentials" one. A badge goes to the
// first rule it matches, so order matters. Add a rule here to highlight another credential type.
/** @type {SectionRule[]} */
const CREDENTIAL_SECTIONS = [
  {
    // Paid AWS certifications are the only AWS badges Credly types as "Certification";
    // learning and training badges from the same owner are typed "Learning".
    title: "AWS Certified",
    match: (badge) =>
      badge.typeCategory === "certification" && badge.ownerSlug === "amazon-web-services",
    // Wide cells would stretch the image to the full cell width; pin it near a normal cell size.
    imageWidth: 200,
    centered: true,
  },
];

const collator = new Intl.Collator("en", { sensitivity: "base" });
const compareText = (a, b) => collator.compare(a, b);

// ---------------------------------------------------------------- config

export function loadConfig(env) {
  const profileUrl = (env.CREDLY_PROFILE_URL || "").trim();
  const userId = (env.CREDLY_USER_ID || "").trim();

  if (!profileUrl || !userId) {
    throw new Error("CREDLY_PROFILE_URL and CREDLY_USER_ID are required.");
  }

  return {
    readmePath: env.README_PATH || "README.md",
    profileUrl,
    userId,
    badgeLimit: parsePositiveInteger(env.CREDLY_BADGE_LIMIT),
    badgesPerRow: parsePositiveInteger(env.CREDLY_BADGES_PER_ROW, DEFAULT_BADGES_PER_ROW),
    nameFilter: (env.CREDLY_BADGE_FILTER || "").trim().toLowerCase(),
  };
}

// 0 is never valid: it means "no limit" for the limit and would loop forever as a row size.
function parsePositiveInteger(value, fallback = 0) {
  const parsed = /^\d+$/.test(value ?? "") ? Number(value) : 0;
  return parsed > 0 ? parsed : fallback;
}

// ------------------------------------------------------------------ http

class HttpError extends Error {
  constructor(status, url) {
    super(`Credly request failed with HTTP ${status}: ${url}`);
    this.status = status;
  }
}

const isRetryable = (error) =>
  !(error instanceof HttpError) || error.status === 429 || error.status >= 500;

async function fetchJson(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, {
        headers: REQUEST_HEADERS,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new HttpError(response.status, url);
      }

      return await response.json();
    } catch (error) {
      if (attempt >= FETCH_RETRIES || !isRetryable(error)) {
        throw error;
      }

      await sleep(RETRY_DELAY_MS * (attempt + 1));
    }
  }
}

async function fetchAllRecords(buildUrl) {
  const records = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const payload = await fetchJson(buildUrl(page));

    if (Array.isArray(payload?.data)) {
      records.push(...payload.data);
    }

    if (page >= (payload?.metadata?.total_pages ?? 1)) {
      return records;
    }
  }

  console.warn(`Stopped after ${MAX_PAGES} pages; later badges are not included.`);
  return records;
}

async function fetchCredlyBadges(profileUrl) {
  const baseUrl = `${profileUrl.replace(/\/+$/, "")}/badges.json`;
  const records = await fetchAllRecords((page) => `${baseUrl}?page=${page}`);

  return records.flatMap(toCredlyBadge);
}

async function fetchExternalBadges(userId) {
  const baseUrl = `https://www.credly.com/api/v1/users/${encodeURIComponent(userId)}/external_badges/open_badges/public`;
  const records = await fetchAllRecords(
    (page) => `${baseUrl}?page=${page}&page_size=${PAGE_SIZE}`,
  );

  return records.flatMap(toExternalBadge);
}

// ------------------------------------------------------------- normalize
// The to*Badge functions return [] for unusable records so callers can flatMap.

const str = (value) => (typeof value === "string" ? value.trim() : "");

const firstString = (...values) => values.map(str).find(Boolean) || "";

function toCredlyBadge(record) {
  const template = record?.badge_template;
  const id = str(record?.id);
  const name = firstString(template?.name, record?.name, record?.title);
  const imageUrl = firstString(
    record?.image_url,
    record?.image?.url,
    template?.image_url,
    template?.image?.url,
  );

  if (!id || !name || !isCredlyImageUrl(imageUrl)) {
    return [];
  }

  return [
    {
      url: `https://www.credly.com/badges/${encodeURIComponent(id)}`,
      imageUrl,
      name: decodeHtml(name),
      provider: pickBadgeProvider(record),
      typeCategory: str(template?.type_category).toLowerCase(),
      ownerSlug: str(template?.owner_vanity_slug),
    },
  ];
}

function toExternalBadge(record) {
  const badge = record?.external_badge;
  const name = str(badge?.badge_name);
  const imageUrl = str(badge?.image_url);
  const badgeUrl = str(badge?.badge_url);
  const provider = str(badge?.issuer_name);

  if (
    record?.public === false ||
    !name ||
    !provider ||
    !/^https:\/\//i.test(badgeUrl) ||
    !isCredlyImageUrl(imageUrl)
  ) {
    return [];
  }

  return [{ url: badgeUrl, imageUrl, name: decodeHtml(name), provider: decodeHtml(provider) }];
}

function pickBadgeProvider(record) {
  const issuerName =
    pickIssuerName(record?.issuer) || pickIssuerName(record?.badge_template?.issuer);

  return issuerName
    ? decodeHtml(str(issuerName))
    : firstString(record?.badge_template?.owner_vanity_slug);
}

function pickIssuerName(issuer) {
  const entities = Array.isArray(issuer?.entities) ? issuer.entities : [];
  const named = entities.filter((entry) => entry?.entity?.name);

  return (named.find((entry) => entry.primary) ?? named[0])?.entity.name ?? null;
}

function isCredlyImageUrl(value) {
  return /^https:\/\/images\.credly\.com\//i.test(value);
}

// -------------------------------------------------------------- sections

// Rule-matched badges and externally uploaded badges are always shown; the
// filter and limit only shape the general "Other Credentials" section.
export function buildSections(
  { credlyBadges, externalBadges },
  config,
  rules = CREDENTIAL_SECTIONS,
) {
  const sections = [];
  let remaining = credlyBadges;

  for (const rule of rules) {
    const matched = [];
    const rest = [];

    for (const badge of remaining) {
      (rule.match(badge) ? matched : rest).push(badge);
    }

    remaining = rest;

    if (matched.length > 0) {
      sections.push({
        title: rule.title,
        badges: matched.sort(compareBadges),
        // Fewer badges than a full row: shrink the table to the badge count so the cells stay centered.
        columns: Math.min(matched.length, config.badgesPerRow),
        imageWidth: rule.imageWidth,
        centered: rule.centered,
      });
    }
  }

  const filtered = config.nameFilter
    ? remaining.filter((badge) => badge.name.toLowerCase().includes(config.nameFilter))
    : remaining;
  const other = (config.badgeLimit > 0 ? filtered.slice(0, config.badgeLimit) : filtered).sort(
    compareBadges,
  );

  for (const [issuer, badges] of groupByProvider(externalBadges)) {
    sections.push({
      title: `${issuer} Certified`,
      badges: badges.sort((a, b) => compareText(a.name, b.name)),
      columns: config.badgesPerRow,
    });
  }

  if (other.length > 0) {
    sections.push({ title: "Other Credentials", badges: other, columns: config.badgesPerRow });
  }

  return sections;
}

function groupByProvider(badges) {
  const groups = new Map();

  for (const badge of badges) {
    const group = groups.get(badge.provider);

    if (group) {
      group.push(badge);
    } else {
      groups.set(badge.provider, [badge]);
    }
  }

  return [...groups].sort(([a], [b]) => compareText(a, b));
}

// Badges with a provider sort before those without, then by provider, then by name.
function compareBadges(a, b) {
  if (Boolean(a.provider) !== Boolean(b.provider)) {
    return a.provider ? -1 : 1;
  }

  return compareText(a.provider, b.provider) || compareText(a.name, b.name);
}

// ---------------------------------------------------------------- render

export function renderBadgeBlock(sections, metadata) {
  const body = sections
    .map((section) => `## ${escapeHtml(section.title)}\n${renderBadgeTable(section.badges, section)}`)
    .join("\n\n");

  return `${START_MARKER}
${body}
<p align="center">
  <sub>Showing ${metadata.count} public badge(s) from Credly. Source: <a href="${escapeHtmlAttribute(metadata.profileUrl)}">Credly profile</a>.</sub>
</p>
${END_MARKER}`;
}

export function renderBadgeTable(badges, { columns, imageWidth = 0, centered = false }) {
  const columnWidth = formatColumnWidth(columns);
  const rows = chunkArray(badges, columns)
    .map((row) => `  <tr>\n${renderBadgeCells(row, columnWidth, columns, imageWidth)}\n  </tr>`)
    .join("\n");

  // GitHub sizes tables to their content, so a narrow table hugs the left edge unless align="center" is set.
  const alignAttribute = centered ? ' align="center"' : "";

  return `<table${alignAttribute} width="100%">
${rows}
</table>`;
}

function renderBadgeCells(row, columnWidth, columns, imageWidth) {
  const widthAttribute = imageWidth > 0 ? ` width="${imageWidth}"` : "";
  const cells = row.map(
    (badge) =>
      `    <td align="center" valign="top" width="${columnWidth}"><a href="${escapeHtmlAttribute(badge.url)}"><img src="${escapeHtmlAttribute(badge.imageUrl)}" alt="${escapeHtmlAttribute(badge.name)}"${widthAttribute} /></a></td>`,
  );

  while (cells.length < columns) {
    cells.push(`    <td width="${columnWidth}"></td>`);
  }

  return cells.join("\n");
}

function formatColumnWidth(columns) {
  const width = 100 / columns;
  return Number.isInteger(width) ? `${width}%` : `${width.toFixed(2)}%`;
}

function chunkArray(items, size) {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

// ---------------------------------------------------------------- readme

// Slices instead of String.replace so "$&"-style sequences in the replacement stay literal.
export function replaceSection(source, startMarker, endMarker, replacement) {
  const start = source.indexOf(startMarker);
  const end = start === -1 ? -1 : source.indexOf(endMarker, start + startMarker.length);

  if (end === -1) {
    throw new Error(`Missing ${startMarker} or ${endMarker}`);
  }

  return source.slice(0, start) + replacement + source.slice(end + endMarker.length);
}

// ------------------------------------------------------------------ html

// "&amp;" goes last so an escaped entity such as "&amp;quot;" is decoded only once.
export function decodeHtml(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

// ------------------------------------------------------------------ main

async function main() {
  const config = loadConfig(process.env);
  const readme = await readFile(config.readmePath, "utf8");

  const [credlyBadges, externalBadges] = await Promise.all([
    fetchCredlyBadges(config.profileUrl),
    fetchExternalBadges(config.userId),
  ]);

  const sections = buildSections({ credlyBadges, externalBadges }, config);

  if (sections.length === 0) {
    throw new Error("No public badges found from the Credly profile.");
  }

  const block = renderBadgeBlock(sections, {
    profileUrl: config.profileUrl,
    count: sections.reduce((total, section) => total + section.badges.length, 0),
  });

  const updated = replaceSection(readme, START_MARKER, END_MARKER, block);
  if (updated === readme) {
    console.log("README is already up to date.");
    return;
  }

  await writeFile(config.readmePath, updated, "utf8");
  console.log(
    `Updated ${config.readmePath}: ${sections.map((s) => `${s.title} ${s.badges.length}`).join(", ")}.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
