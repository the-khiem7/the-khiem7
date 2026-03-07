import { readFile, writeFile } from "node:fs/promises";

const README_PATH = process.env.README_PATH || "README.md";
const PROFILE_URL =
  process.env.CREDLY_PROFILE_URL || "https://www.credly.com/users/duy-khiem";
const BADGE_LIMIT = Number.parseInt(process.env.CREDLY_BADGE_LIMIT || "6", 10);
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
  const selectedBadges = filteredBadges.slice(0, BADGE_LIMIT);

  if (selectedBadges.length === 0) {
    throw new Error("No public badges found from the Credly profile.");
  }

  const block = renderBadgeBlock(selectedBadges, {
    profileUrl: PROFILE_URL,
    count: selectedBadges.length,
    filter: NAME_FILTER,
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
  const response = await fetch(profileUrl, {
    headers: {
      "user-agent": "github-actions-credly-badge-sync",
      accept: "text/html,application/xhtml+xml",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Credly profile: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const badges = extractBadges(html);

  if (badges.length === 0) {
    throw new Error("Unable to extract badges from the Credly profile HTML.");
  }

  return badges;
}

function extractBadges(html) {
  const ordered = [];
  const seen = new Set();

  const pushBadge = (badge) => {
    if (!badge || !badge.url || !badge.imageUrl || !badge.name) {
      return;
    }

    const key = badge.url;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    ordered.push({
      url: badge.url,
      imageUrl: badge.imageUrl,
      name: badge.name,
      issuedAt: badge.issuedAt || null,
    });
  };

  for (const jsonText of extractJsonScripts(html)) {
    const parsed = safeJsonParse(jsonText);
    if (!parsed) {
      continue;
    }

    walk(parsed, (value) => {
      const badge = toBadge(value);
      if (badge) {
        pushBadge(badge);
      }
    });
  }

  for (const badge of extractBadgeAnchors(html)) {
    pushBadge(badge);
  }

  return ordered.sort(compareBadges);
}

function extractJsonScripts(html) {
  const matches = html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi);
  const results = [];

  for (const match of matches) {
    const content = match[1]?.trim();
    if (!content) {
      continue;
    }

    if (content.startsWith("{") || content.startsWith("[")) {
      results.push(content);
      continue;
    }

    const nextDataMatch = content.match(/__NEXT_DATA__\s*=\s*({[\s\S]*})\s*;?\s*$/);
    if (nextDataMatch) {
      results.push(nextDataMatch[1]);
    }
  }

  return results;
}

function extractBadgeAnchors(html) {
  const results = [];
  const anchorRegex =
    /<a\b[^>]*href="(https:\/\/www\.credly\.com\/badges\/[a-z0-9-]+[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(anchorRegex)) {
    const url = normalizeBadgeUrl(match[1]);
    const innerHtml = match[2];
    const srcMatch = innerHtml.match(/<img\b[^>]*src="([^"]+)"[^>]*alt="([^"]+)"/i);
    if (!srcMatch) {
      continue;
    }

    results.push({
      url,
      imageUrl: srcMatch[1],
      name: decodeHtml(srcMatch[2]),
      issuedAt: null,
    });
  }

  return results;
}

function toBadge(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const url =
    pickString(value, [
      "url",
      "public_url",
      "badge_url",
      "absolute_url",
      "publicUrl",
      "badgeUrl",
    ]) || "";
  const imageUrl =
    pickString(value, [
      "image_url",
      "imageUrl",
      "image",
      "image_large",
      "image_small",
      "badge_image_url",
      "badge_image",
    ]) || "";
  const name = pickString(value, ["name", "title"]) || "";
  const issuedAt =
    pickString(value, ["issued_at", "issuedAt", "created_at", "published_at", "updated_at"]) || null;

  if (!isCredlyBadgeUrl(url) || !isCredlyImageUrl(imageUrl) || !name) {
    return null;
  }

  return {
    url: normalizeBadgeUrl(url),
    imageUrl,
    name: decodeHtml(name),
    issuedAt,
  };
}

function replaceSection(source, startMarker, endMarker, replacement) {
  const pattern = new RegExp(
    `${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}`,
    "m",
  );

  return source.replace(pattern, replacement);
}

function renderBadgeBlock(badges, metadata) {
  const items = badges
    .map(
      (badge) =>
        `  <a href="${badge.url}">\n    <img src="${badge.imageUrl}" width="80" height="80" alt="${escapeHtmlAttribute(badge.name)}" />\n  </a>`,
    )
    .join("\n");

  const label = metadata.filter
    ? `Showing the latest ${metadata.count} public badge(s) matching "${escapeHtml(metadata.filter)}".`
    : `Showing the latest ${metadata.count} public badge(s) from Credly.`;

  return `${START_MARKER}
## Credly Badges
<p align="center">
${items}
</p>
<p align="center">
  <sub>${label} Source: <a href="${metadata.profileUrl}">Credly profile</a>.</sub>
</p>
${END_MARKER}`;
}

function compareBadges(a, b) {
  if (a.issuedAt && b.issuedAt) {
    return Date.parse(b.issuedAt) - Date.parse(a.issuedAt);
  }

  if (a.issuedAt) {
    return -1;
  }

  if (b.issuedAt) {
    return 1;
  }

  return 0;
}

function walk(value, visitor) {
  visitor(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, visitor);
    }
    return;
  }

  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) {
      walk(nested, visitor);
    }
  }
}

function pickString(value, keys) {
  for (const key of keys) {
    const current = value[key];
    if (typeof current === "string" && current.trim()) {
      return current.trim();
    }
  }

  return null;
}

function isCredlyBadgeUrl(value) {
  return /^https:\/\/www\.credly\.com\/badges\/[a-z0-9-]+/i.test(value);
}

function normalizeBadgeUrl(value) {
  const match = value.match(/^https:\/\/www\.credly\.com\/badges\/[a-z0-9-]+/i);
  return match ? match[0] : value;
}

function isCredlyImageUrl(value) {
  return /^https:\/\/images\.credly\.com\//i.test(value);
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
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
