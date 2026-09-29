import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const html = await readFile(new URL("../discography/index.html", import.meta.url), "utf8");
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];

// Execute the page's actual renderer with local data; no external requests or tags.
async function render(releases) {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) {
      const children = new Map();
      nodes.set(id, {
        innerHTML: "", textContent: "",
        querySelector: (selector) => {
          if (!children.has(selector)) children.set(selector, {});
          return children.get(selector);
        },
        querySelectorAll: () => {
          if (!children.has("dd")) children.set("dd", Array.from({ length: 5 }, () => ({})));
          return children.get("dd");
        }
      });
    }
    return nodes.get(id);
  };
  vm.runInNewContext(script, {
    document: { getElementById: node },
    fetch: async (url) => ({ json: async () => url.split("?")[0].endsWith("discogs-artwork.json") ? { images: {} } : releases })
  });
  await new Promise(setImmediate);
  const sections = node("release-sections").innerHTML;
  assert.ok(sections.includes('class="release-shelf"'), "page should render instead of entering its error fallback");
  return { sections, summary: node("release-summary").querySelectorAll("dd").map((dd) => dd.textContent) };
}

const archive = (releases) => ({ releases, release_count: releases.length, year_range: "2010-2025" });
const producerRelease = (overrides = {}) => ({
  id: 1, type: "release", roles: ["Producer"], artist: "Artist", title: "Producer record", year: 2010,
  discogs_url: "https://www.discogs.com/release/1", tracks: [], ...overrides
});
const track = (position, credit = "Emufucka / Producer") => ({ position, title: `Track ${position}`, credits: [credit] });

// The live regression: one album was counted once per track, then again as an empty album credit.
test("current archive renders one album card with both credited tracks", async () => {
  const data = JSON.parse(await readFile(new URL("../data/discogs-releases.slim.json", import.meta.url), "utf8"));
  const { sections, summary } = await render(data);
  assert.deepEqual(summary.slice(0, 4), [17, 10, 1, 8]);
  assert.equal((sections.match(/<h3>◎≠-<\/h3>/g) || []).length, 1);
  assert.ok(sections.includes("あまりに或蜂的な。"));
  assert.ok(sections.includes("元少年ライカ"));
  assert.ok(sections.includes("2 releases / 4 credits"));
  assert.equal((sections.match(/class="release-card(?: release-card-credit)?"/g) || []).length, 34);
});

test("artist capitalization does not split a production card or discard tracks", async () => {
  const { sections, summary } = await render(archive([
    producerRelease({ tracks: [track("1"), track("2", "EMUFUCKA / Producer")] })
  ]));
  assert.equal(summary[3], 2);
  assert.equal((sections.match(/class="release-card release-card-credit"/g) || []).length, 1);
  assert.ok(sections.includes("Track 1"));
  assert.ok(sections.includes("Track 2"));
});

test("album-only producer credits survive, including appearances and colliding master IDs", async () => {
  const { sections, summary } = await render(archive([
    producerRelease({ type: "master", title: "Master with tracks", tracks: [track("1")] }),
    producerRelease({ title: "Release without tracks" }),
    producerRelease({ id: 2, title: "Appearance without tracks", roles: ["Producer", "TrackAppearance"] })
  ]));
  assert.equal(summary[3], 3);
  assert.equal((sections.match(/class="release-card release-card-credit"/g) || []).length, 3);
  assert.ok(sections.includes("Release without tracks"));
  assert.ok(sections.includes("Appearance without tracks"));
});
