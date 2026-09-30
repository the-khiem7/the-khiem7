import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSections,
  decodeHtml,
  loadConfig,
  renderBadgeTable,
  replaceSection,
} from "./update-credly-badges.mjs";

const badge = (name, extra = {}) => ({
  url: `https://www.credly.com/badges/${name}`,
  imageUrl: `https://images.credly.com/${name}.png`,
  name,
  provider: "",
  ...extra,
});

const awsCert = (name, extra = {}) =>
  badge(name, { typeCategory: "certification", ownerSlug: "amazon-web-services", ...extra });

const config = { badgeLimit: 0, badgesPerRow: 4, nameFilter: "" };

test("replaceSection keeps $ sequences in the replacement literal", () => {
  const source = "a<!-- s -->old<!-- e -->b";
  const result = replaceSection(source, "<!-- s -->", "<!-- e -->", "<!-- s -->$& $' $1<!-- e -->");

  assert.equal(result, "a<!-- s -->$& $' $1<!-- e -->b");
});

test("replaceSection throws when a marker is missing", () => {
  assert.throws(() => replaceSection("no markers", "<!-- s -->", "<!-- e -->", "x"), /Missing/);
  assert.throws(() => replaceSection("<!-- s -->", "<!-- s -->", "<!-- e -->", "x"), /Missing/);
});

test("decodeHtml decodes an escaped entity only once", () => {
  assert.equal(decodeHtml("&amp;quot;"), "&quot;");
  assert.equal(decodeHtml("R&amp;D &lt;b&gt; &quot;x&quot; &#39;y&#39;"), "R&D <b> \"x\" 'y'");
});

test("loadConfig requires profile url and user id", () => {
  assert.throws(() => loadConfig({}), /required/);
  assert.throws(() => loadConfig({ CREDLY_PROFILE_URL: "https://x" }), /required/);
});

test("loadConfig treats 0 and junk as defaults", () => {
  const env = { CREDLY_PROFILE_URL: "https://x", CREDLY_USER_ID: "id" };

  assert.equal(loadConfig({ ...env, CREDLY_BADGES_PER_ROW: "0" }).badgesPerRow, 4);
  assert.equal(loadConfig({ ...env, CREDLY_BADGES_PER_ROW: "abc" }).badgesPerRow, 4);
  assert.equal(loadConfig({ ...env, CREDLY_BADGES_PER_ROW: "3" }).badgesPerRow, 3);
  assert.equal(loadConfig({ ...env, CREDLY_BADGE_LIMIT: "5" }).badgeLimit, 5);
  assert.equal(loadConfig(env).badgeLimit, 0);
});

test("buildSections splits AWS, external, and other badges", () => {
  const sections = buildSections(
    {
      credlyBadges: [
        awsCert("saa", { provider: "AWS" }),
        badge("zeta", { provider: "Zed" }),
        badge("alpha", { provider: "Acme" }),
        badge("nameless"),
      ],
      externalBadges: [badge("ext-b", { provider: "Solace" }), badge("ext-a", { provider: "Solace" })],
    },
    config,
  );

  assert.deepEqual(
    sections.map((s) => [s.title, s.badges.map((b) => b.name)]),
    [
      ["AWS Certified", ["saa"]],
      ["Solace Certified", ["ext-a", "ext-b"]],
      ["Other Credentials", ["alpha", "zeta", "nameless"]],
    ],
  );
  assert.equal(sections[0].columns, 1);
  assert.equal(sections[0].centered, true);
});

test("buildSections applies filter and limit only to other credentials", () => {
  const credlyBadges = [
    awsCert("saa"),
    badge("Cloud One"),
    badge("Cloud Two"),
    badge("Security"),
  ];
  const externalBadges = [badge("ext", { provider: "Solace" })];

  const filtered = buildSections(
    { credlyBadges, externalBadges },
    { ...config, nameFilter: "cloud", badgeLimit: 1 },
  );

  assert.deepEqual(
    filtered.map((s) => s.badges.map((b) => b.name)),
    [["saa"], ["ext"], ["Cloud One"]],
  );
});

test("the AWS rule needs certification type and AWS owner", () => {
  const sections = buildSections(
    {
      credlyBadges: [
        awsCert("saa"),
        awsCert("training", { typeCategory: "learning" }),
        awsCert("other-owner", { ownerSlug: "someone-else" }),
      ],
      externalBadges: [],
    },
    config,
  );

  assert.deepEqual(
    sections.map((s) => [s.title, s.badges.map((b) => b.name)]),
    [
      ["AWS Certified", ["saa"]],
      ["Other Credentials", ["other-owner", "training"]],
    ],
  );
});

test("buildSections gives each badge to the first matching rule", () => {
  const rules = [
    { title: "First", match: (b) => b.name.startsWith("a") },
    { title: "Second", match: (b) => b.name.includes("b") },
  ];
  const sections = buildSections(
    { credlyBadges: [badge("ab"), badge("xb"), badge("zz")], externalBadges: [] },
    config,
    rules,
  );

  assert.deepEqual(
    sections.map((s) => [s.title, s.badges.map((b) => b.name)]),
    [
      ["First", ["ab"]],
      ["Second", ["xb"]],
      ["Other Credentials", ["zz"]],
    ],
  );
});

test("renderBadgeTable pads the last row and centers on request", () => {
  const html = renderBadgeTable([badge("a"), badge("b"), badge("c")], {
    columns: 2,
    imageWidth: 200,
    centered: true,
  });

  assert.match(html, /^<table align="center" width="100%">/);
  assert.equal(html.match(/<tr>/g).length, 2);
  assert.equal(html.match(/<td width="50%"><\/td>/g).length, 1);
  assert.match(html, /alt="a" width="200" \/>/);
});
