import { readFile, writeFile } from "node:fs/promises";

const README_PATH = process.env.README_PATH || "README.md";
const PROFILE_URL =
  process.env.CREDLY_PROFILE_URL || "https://www.credly.com/users/duy-khiem";
const BADGE_LIMIT = parseBadgeLimit(process.env.CREDLY_BADGE_LIMIT);
const BADGES_PER_ROW = parseBadgeLimit(process.env.CREDLY_BADGES_PER_ROW) || 6;
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
  const selectedBadges = (BADGE_LIMIT > 0 ? filteredBadges.slice(0, BADGE_LIMIT) : filteredBadges)
    .sort(compareBadgesByProvider);

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
    return [];
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
  const rows = packBadgeRows(badges, BADGES_PER_ROW)
    .map((row) => {
      const cells = row
        .map(
          (badge) =>
            `    <td align="center"><a href="${badge.url}"><img src="${badge.imageUrl}" width="80" height="80" alt="${escapeHtmlAttribute(badge.name)}" /></a></td>`,
        )
        .join("\n");

      return `  <tr>\n${cells}\n  </tr>`;
    })
    .join("\n");

  const labelPrefix = metadata.limit > 0 ? `Showing the latest ${metadata.count}` : `Showing all ${metadata.count}`;
  const label = metadata.filter
    ? `${labelPrefix} public badge(s) matching "${escapeHtml(metadata.filter)}".`
    : `${labelPrefix} public badge(s) from Credly.`;

  return `${START_MARKER}
## Credly Badges
<table align="center">
${rows}
</table>
<p align="center">
  <sub>${label} Source: <a href="${metadata.profileUrl}">Credly profile</a>.</sub>
</p>
${END_MARKER}`;
}

function compareBadgesByProvider(a, b) {
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

function parseBadgeLimit(value) {
  const parsed = Number.parseInt(value || "0", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function chunkArray(items, size) {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function packBadgeRows(badges, capacity) {
  const groupedBadges = groupBadgesByProvider(badges);
  const units = groupedBadges.flatMap((group) => {
    if (group.length <= capacity) {
      return [group];
    }

    return chunkArray(group, capacity);
  });

  units.sort(compareBadgeUnits);

  const rows = [];

  for (const unit of units) {
    let placed = false;

    for (const row of rows) {
      if (row.count + unit.length <= capacity) {
        row.units.push(unit);
        row.count += unit.length;
        placed = true;
        break;
      }
    }

    if (!placed) {
      rows.push({
        count: unit.length,
        units: [unit],
      });
    }
  }

  return rows.map((row) => row.units.flat());
}

function groupBadgesByProvider(badges) {
  const groups = [];
  let currentGroup = [];
  let currentProvider = null;

  for (const badge of badges) {
    const provider = badge.provider || "";
    if (currentGroup.length === 0 || provider === currentProvider) {
      currentGroup.push(badge);
      currentProvider = provider;
      continue;
    }

    groups.push(currentGroup);
    currentGroup = [badge];
    currentProvider = provider;
  }

  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  return groups;
}

function compareBadgeUnits(a, b) {
  if (b.length !== a.length) {
    return b.length - a.length;
  }

  const aProvider = a[0]?.provider || "";
  const bProvider = b[0]?.provider || "";
  const providerOrder = aProvider.localeCompare(bProvider, "en", { sensitivity: "base" });
  if (providerOrder !== 0) {
    return providerOrder;
  }

  return (a[0]?.name || "").localeCompare(b[0]?.name || "", "en", { sensitivity: "base" });
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
