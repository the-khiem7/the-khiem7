import { readFile, writeFile } from "node:fs/promises";

const README_PATH = process.env.README_PATH || "README.md";
const PROFILE_URL = (
  process.env.CREDLY_PROFILE_URL || "https://www.credly.com/users/duy-khiem"
).trim();
const BADGE_LIMIT = parsePositiveInteger(process.env.CREDLY_BADGE_LIMIT);
const BADGES_PER_ROW = parsePositiveInteger(process.env.CREDLY_BADGES_PER_ROW, 6);
const NAME_FILTER = (process.env.CREDLY_BADGE_FILTER || "").trim().toLowerCase();
const START_MARKER = "<!-- credly-badges:start -->";
const END_MARKER = "<!-- credly-badges:end -->";

async function main() {
  const readme = await readFile(README_PATH, "utf8");

  if (!readme.includes(START_MARKER) || !readme.includes(END_MARKER)) {
    throw new Error(`Missing ${START_MARKER} or ${END_MARKER} in ${README_PATH}`);
  }

  if (!PROFILE_URL) {
    console.log("CREDLY_PROFILE_URL is not set. Leaving README unchanged.");
    return;
  }

  const badges = await fetchCredlyBadges(PROFILE_URL);
  const filteredBadges = NAME_FILTER
    ? badges.filter((badge) => badge.name.toLowerCase().includes(NAME_FILTER))
    : badges;
  const selectedBadges = [
    ...(BADGE_LIMIT > 0 ? filteredBadges.slice(0, BADGE_LIMIT) : filteredBadges),
  ].sort(compareBadgesByName);

  if (selectedBadges.length === 0) {
    throw new Error("No public badges found from the Credly profile.");
  }

  const block = renderBadgeBlock(selectedBadges, {
    profileUrl: PROFILE_URL,
    count: selectedBadges.length,
    filter: NAME_FILTER,
    limit: BADGE_LIMIT,
  });

  const updated = replaceSection(readme, START_MARKER, END_MARKER, block);
  if (updated === readme) {
    console.log("README is already up to date.");
    return;
  }

  await writeFile(README_PATH, updated, "utf8");
  console.log(`Updated ${README_PATH} with ${selectedBadges.length} Credly badge(s).`);
}

async function fetchCredlyBadges(profileUrl) {
  const badgesApiUrl = buildBadgesApiUrl(profileUrl);
  const badges = await fetchCredlyBadgesFromApi(badgesApiUrl);
  if (badges.length === 0) {
    throw new Error(`No public badges found from ${badgesApiUrl}`);
  }

  return badges;
}

async function fetchCredlyBadgesFromApi(badgesApiUrl) {
  const response = await fetch(badgesApiUrl, {
    headers: {
      "user-agent": "github-actions-credly-badge-sync",
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Credly API request failed with HTTP ${response.status}: ${badgesApiUrl}`);
  }

  const payload = await response.json();
  const records = Array.isArray(payload?.data) ? payload.data : [];

  return records
    .map((record) => {
      const badgeId = typeof record?.id === "string" ? record.id.trim() : "";
      const badgeName =
        pickNestedString(record, [
          ["badge_template", "name"],
          ["name"],
          ["title"],
        ]) || "";
      const imageUrl =
        pickNestedString(record, [
          ["image_url"],
          ["image", "url"],
          ["badge_template", "image_url"],
          ["badge_template", "image", "url"],
        ]) || "";

      if (!badgeId || !badgeName || !isCredlyImageUrl(imageUrl)) {
        return null;
      }

      return {
        url: `https://www.credly.com/badges/${badgeId}`,
        imageUrl,
        name: decodeHtml(badgeName),
      };
    })
    .filter(Boolean);
}

function replaceSection(source, startMarker, endMarker, replacement) {
  const pattern = new RegExp(
    `${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}`,
    "m",
  );

  return source.replace(pattern, replacement);
}

function renderBadgeBlock(badges, metadata) {
  const columnWidth = formatColumnWidth(BADGES_PER_ROW);
  const rows = chunkArray(badges, BADGES_PER_ROW)
    .map(
      (row) => `  <tr>\n${renderBadgeCells(row, columnWidth)}\n  </tr>`,
    )
    .join("\n");

  const labelPrefix = metadata.limit > 0 ? `Showing ${metadata.count}` : `Showing all ${metadata.count}`;
  const label = metadata.filter
    ? `${labelPrefix} public badge(s) matching "${escapeHtml(metadata.filter)}".`
    : `${labelPrefix} public badge(s) from Credly.`;

  return `${START_MARKER}
## Credly Badges
<table width="100%">
${rows}
</table>
<p align="center">
  <sub>${label} Source: <a href="${escapeHtmlAttribute(metadata.profileUrl)}">Credly profile</a>.</sub>
</p>
${END_MARKER}`;
}

function compareBadgesByName(a, b) {
  return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
}

function pickNestedString(value, paths) {
  for (const path of paths) {
    let current = value;
    let valid = true;

    for (const segment of path) {
      if (!current || typeof current !== "object" || !(segment in current)) {
        valid = false;
        break;
      }

      current = current[segment];
    }

    if (valid && typeof current === "string" && current.trim()) {
      return current.trim();
    }
  }

  return null;
}

function isCredlyImageUrl(value) {
  return /^https:\/\/images\.credly\.com\//i.test(value);
}

function buildBadgesApiUrl(profileUrl) {
  return `${profileUrl.replace(/\/+$/, "")}/badges.json`;
}

function parsePositiveInteger(value, fallback = 0) {
  if (!/^\d+$/.test(value || "")) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function chunkArray(items, size) {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function renderBadgeCells(row, columnWidth) {
  const cells = row.map(
    (badge) =>
      `    <td align="center" valign="top" width="${columnWidth}"><a href="${escapeHtmlAttribute(badge.url)}"><img src="${escapeHtmlAttribute(badge.imageUrl)}" alt="${escapeHtmlAttribute(badge.name)}" /></a></td>`,
  );

  while (cells.length < BADGES_PER_ROW) {
    cells.push(`    <td width="${columnWidth}"></td>`);
  }

  return cells.join("\n");
}

function formatColumnWidth(columns) {
  const width = 100 / columns;
  return Number.isInteger(width) ? `${width}%` : `${width.toFixed(2)}%`;
}

function decodeHtml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

await main();
