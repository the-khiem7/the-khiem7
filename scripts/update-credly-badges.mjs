import { readFile, writeFile } from "node:fs/promises";

const README_PATH = process.env.README_PATH || "README.md";
const PROFILE_URL = (
  process.env.CREDLY_PROFILE_URL || "https://www.credly.com/users/duy-khiem"
).trim();
const USER_ID = (
  process.env.CREDLY_USER_ID || "789141e9-d22e-40d4-bdf3-a9fd0f603f17"
).trim();
const BADGE_LIMIT = parsePositiveInteger(process.env.CREDLY_BADGE_LIMIT);
const BADGES_PER_ROW = parsePositiveInteger(process.env.CREDLY_BADGES_PER_ROW, 4);
const PAGE_SIZE = 48;
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

  const [credlyBadges, externalBadges] = await Promise.all([
    fetchCredlyBadges(PROFILE_URL),
    fetchExternalBadges(USER_ID),
  ]);

  // Certifications and externally uploaded badges are always shown; the
  // filter and limit only shape the general Credly Badges section.
  const awsCertified = credlyBadges
    .filter((badge) => badge.isAwsCertification)
    .sort(compareBadgesByProviderThenName);
  const generalBadges = credlyBadges.filter((badge) => !badge.isAwsCertification);
  const filteredBadges = NAME_FILTER
    ? generalBadges.filter((badge) => badge.name.toLowerCase().includes(NAME_FILTER))
    : generalBadges;
  const selectedBadges = [
    ...(BADGE_LIMIT > 0 ? filteredBadges.slice(0, BADGE_LIMIT) : filteredBadges),
  ].sort(compareBadgesByProviderThenName);

  const sections = [];
  if (awsCertified.length > 0) {
    // Fewer certs than a full row: shrink the table to the cert count so the cells stay centered.
    sections.push({
      title: "AWS Certified",
      badges: awsCertified,
      columns: Math.min(awsCertified.length, BADGES_PER_ROW),
      // Wide cells would stretch the image to the full cell width; pin it near a normal cell size.
      imageWidth: 200,
      centered: true,
    });
  }
  for (const [issuer, badges] of groupByProvider(externalBadges)) {
    sections.push({
      title: `${issuer} Certified`,
      badges: badges.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" })),
    });
  }
  if (selectedBadges.length > 0) {
    sections.push({ title: "Other Credentials", badges: selectedBadges });
  }

  if (sections.length === 0) {
    throw new Error("No public badges found from the Credly profile.");
  }

  const block = renderBadgeBlock(sections, {
    profileUrl: PROFILE_URL,
    count: sections.reduce((total, section) => total + section.badges.length, 0),
  });

  const updated = replaceSection(readme, START_MARKER, END_MARKER, block);
  if (updated === readme) {
    console.log("README is already up to date.");
    return;
  }

  await writeFile(README_PATH, updated, "utf8");
  console.log(
    `Updated ${README_PATH}: ${awsCertified.length} AWS certified, ${externalBadges.length} external, ${selectedBadges.length} other Credly badge(s).`,
  );
}

async function fetchExternalBadges(userId) {
  if (!userId) {
    return [];
  }

  const url = `https://www.credly.com/api/v1/users/${encodeURIComponent(userId)}/external_badges/open_badges/public?page=1&page_size=${PAGE_SIZE}`;
  const response = await fetch(url, {
    headers: {
      "user-agent": "github-actions-credly-badge-sync",
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Credly external badges request failed with HTTP ${response.status}: ${url}`);
  }

  const payload = await response.json();
  const records = Array.isArray(payload?.data) ? payload.data : [];

  return records
    .map((record) => {
      const badge = record?.external_badge;
      const name = typeof badge?.badge_name === "string" ? badge.badge_name.trim() : "";
      const imageUrl = typeof badge?.image_url === "string" ? badge.image_url.trim() : "";
      const badgeUrl = typeof badge?.badge_url === "string" ? badge.badge_url.trim() : "";
      const provider = typeof badge?.issuer_name === "string" ? badge.issuer_name.trim() : "";

      if (record?.public === false || !name || !provider || !/^https:\/\//i.test(badgeUrl) || !isCredlyImageUrl(imageUrl)) {
        return null;
      }

      return { url: badgeUrl, imageUrl, name: decodeHtml(name), provider: decodeHtml(provider) };
    })
    .filter(Boolean);
}

function groupByProvider(badges) {
  const groups = new Map();

  for (const badge of badges) {
    groups.set(badge.provider, [...(groups.get(badge.provider) || []), badge]);
  }

  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, "en", { sensitivity: "base" }));
}

async function fetchCredlyBadges(profileUrl) {
  const badgesApiUrl = buildBadgesApiUrl(profileUrl);
  const badges = await fetchCredlyBadgesFromApi(badgesApiUrl);
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
      const provider = pickBadgeProvider(record);

      if (!badgeId || !badgeName || !isCredlyImageUrl(imageUrl)) {
        return null;
      }

      return {
        url: `https://www.credly.com/badges/${badgeId}`,
        imageUrl,
        name: decodeHtml(badgeName),
        provider,
        isAwsCertification: isAwsCertification(record),
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

// Paid AWS certifications are the only AWS badges Credly types as "Certification";
// learning and training badges from the same owner are typed "Learning".
function isAwsCertification(record) {
  const category = pickNestedString(record, [["badge_template", "type_category"]]) || "";
  const owner = pickNestedString(record, [["badge_template", "owner_vanity_slug"]]) || "";

  return category.toLowerCase() === "certification" && owner === "amazon-web-services";
}

function renderBadgeTable(badges, options = {}) {
  const columns = options.columns || BADGES_PER_ROW;
  const imageWidth = options.imageWidth || 0;
  const columnWidth = formatColumnWidth(columns);
  const rows = chunkArray(badges, columns)
    .map(
      (row) => `  <tr>\n${renderBadgeCells(row, columnWidth, columns, imageWidth)}\n  </tr>`,
    )
    .join("\n");

  // GitHub sizes tables to their content, so a narrow table hugs the left edge unless align="center" is set.
  const alignAttribute = options.centered ? ' align="center"' : "";

  return `<table${alignAttribute} width="100%">
${rows}
</table>`;
}

function renderBadgeBlock(sections, metadata) {
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

function compareBadgesByProviderThenName(a, b) {
  if (a.provider && b.provider) {
    const providerOrder = a.provider.localeCompare(b.provider, "en", {
      sensitivity: "base",
    });

    if (providerOrder !== 0) {
      return providerOrder;
    }
  } else if (a.provider) {
    return -1;
  } else if (b.provider) {
    return 1;
  }

  return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
}

function pickBadgeProvider(record) {
  const issuerName = pickIssuerName(record?.issuer) || pickIssuerName(record?.badge_template?.issuer);
  if (issuerName) {
    return decodeHtml(issuerName);
  }

  return pickNestedString(record, [["badge_template", "owner_vanity_slug"]]) || "";
}

function pickIssuerName(issuer) {
  const entities = Array.isArray(issuer?.entities) ? issuer.entities : [];
  const primaryEntity = entities.find((entry) => entry?.primary && entry?.entity?.name);
  const firstEntity = entities.find((entry) => entry?.entity?.name);

  return primaryEntity?.entity?.name || firstEntity?.entity?.name || null;
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
