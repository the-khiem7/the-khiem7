import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSections,
  decodeHtml,
  loadConfig,
  renderBadgeBlock,
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

const awsPartner = (name, extra = {}) =>
  badge(name, { typeCategory: "learning", ownerSlug: "amazon-web-services", ...extra });

const solace = (name) => badge(name, { provider: "Solace" });

test("buildSections splits AWS, external, and other badges", () => {
  const sections = buildSections(
    {
      credlyBadges: [
        awsCert("saa", { provider: "AWS" }),
        awsPartner("AWS Partner: x"),
        badge("zeta", { provider: "Zed" }),
        badge("alpha", { provider: "Acme" }),
        badge("nameless"),
      ],
      externalBadges: [solace("ext-b"), solace("ext-a")],
    },
    config,
  );

  assert.deepEqual(
    sections.map((s) => [s.title, s.badges.map((b) => b.name)]),
    [
      ["AWS Certified", ["saa"]],
      ["AWS Partner Credentials", ["AWS Partner: x"]],
      ["Solace Certified", ["ext-a", "ext-b"]],
      ["Other Credentials", ["alpha", "zeta", "nameless"]],
    ],
  );
  assert.equal(sections[0].columns, 1);
  assert.equal(sections[0].centered, true);
});

test("the AWS Partner rule needs the AWS owner and the prefix", () => {
  const sections = buildSections(
    {
      credlyBadges: [
        awsPartner("AWS Partner: a"),
        awsPartner("AWS Partner: other-owner", { ownerSlug: "someone-else" }),
        awsPartner("Well-Architected Proficient"),
        awsCert("AWS Partner: cert"),
      ],
      externalBadges: [],
    },
    config,
  );

  assert.deepEqual(
    sections.map((s) => [s.title, s.badges.map((b) => b.name)]),
    [
      ["AWS Certified", ["AWS Partner: cert"]],
      ["AWS Partner Credentials", ["AWS Partner: a"]],
      ["Other Credentials", ["AWS Partner: other-owner", "Well-Architected Proficient"]],
    ],
  );
});

test("AWS Partner Credentials uses the normal grid", () => {
  const [section] = buildSections(
    { credlyBadges: [awsPartner("AWS Partner: a"), awsPartner("AWS Partner: b")], externalBadges: [] },
    config,
  );

  assert.equal(section.columns, config.badgesPerRow);
  assert.equal(section.centered, undefined);
  assert.equal(section.imageWidth, undefined);
});

test("Solace Associate and Ambassador lead as a centered row", () => {
  const sections = buildSections(
    {
      credlyBadges: [],
      externalBadges: [
        solace("Solace Certified Developer Practitioner"),
        solace("Solace Certified Integration Associate"),
        solace("Solace Certified Partner Ambassador"),
        solace("Solace Certified Solutions Consultant"),
      ],
    },
    config,
  );

  assert.deepEqual(
    sections.map((s) => [s.title, s.badges.map((b) => b.name)]),
    [
      [
        "Solace Certified",
        ["Solace Certified Integration Associate", "Solace Certified Partner Ambassador"],
      ],
      [
        "Solace Certified",
        ["Solace Certified Developer Practitioner", "Solace Certified Solutions Consultant"],
      ],
    ],
  );
  assert.equal(sections[0].columns, 2);
  assert.equal(sections[0].centered, true);
  assert.equal(sections[0].imageWidth, 200);
  assert.equal(sections[1].columns, config.badgesPerRow);
  assert.equal(sections[1].centered, undefined);
});

test("Solace without lead badges or without the rest has no empty section", () => {
  const titles = (externalBadges) =>
    buildSections({ credlyBadges: [], externalBadges }, config).map((s) => s.badges.length);

  assert.deepEqual(titles([solace("Solace Certified Developer Practitioner")]), [1]);
  assert.deepEqual(titles([solace("Solace Certified Partner Ambassador")]), [1]);
});

test("renderBadgeBlock prints one heading for consecutive sections with the same title", () => {
  const sections = [
    { title: "Solace Certified", badges: [badge("a")], columns: 1 },
    { title: "Solace Certified", badges: [badge("b")], columns: 1 },
    { title: "Other Credentials", badges: [badge("c")], columns: 1 },
  ];
  const html = renderBadgeBlock(sections, { count: 3, profileUrl: "https://x" });

  assert.equal(html.match(/## Solace Certified/g).length, 1);
  assert.equal(html.match(/## Other Credentials/g).length, 1);
  assert.equal(html.match(/<table/g).length, 3);
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
