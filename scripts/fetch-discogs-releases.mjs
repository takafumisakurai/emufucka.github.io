#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";

const ARTIST_ID = 2192327;
const ARTIST_URL = "https://www.discogs.com/ja/artist/2192327-Emufucka";
const API_ROOT = "https://api.discogs.com";
const USER_AGENT = process.env.DISCOGS_USER_AGENT || "emufucka-archive/1.0 +https://www.emufucka.com";
const CSS_VERSION = "discogs-releases-20260530";
const AEP_TAG = "//assets.adobedtm.com/launch-EN55cd23628bbd44698a353b23d0bac718.min.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanName(value = "") {
  return String(value).replace(/\s+\(\d+\)$/u, "").trim();
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function compact(value) {
  return value.filter(Boolean);
}

function uniq(values) {
  return [
    ...new Set(
      values
        .filter((value) => value !== undefined && value !== null)
        .map((value) => String(value).trim())
        .filter((value) => value && value !== "undefined" && value !== "null"),
    ),
  ];
}

async function fetchJson(url, attempt = 1) {
  const headers = {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };

  if (process.env.DISCOGS_TOKEN) {
    headers.Authorization = `Discogs token=${process.env.DISCOGS_TOKEN}`;
  }

  const response = await fetch(url, { headers });

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 65000;
    if (attempt > 6) {
      throw new Error(`Discogs rate limit did not clear for ${url}`);
    }
    await wait(waitMs);
    return fetchJson(url, attempt + 1);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discogs API ${response.status} for ${url}: ${text.slice(0, 240)}`);
  }

  const text = await response.text();
  if (!text.trim()) {
    if (attempt > 3) {
      throw new Error(`Empty Discogs response for ${url}`);
    }
    await wait(5000);
    return fetchJson(url, attempt + 1);
  }

  const remaining = Number(response.headers.get("x-discogs-ratelimit-remaining"));
  if (Number.isFinite(remaining) && remaining < 2) {
    await wait(65000);
  }

  return JSON.parse(text);
}

function trackMentionsEmufucka(track) {
  const haystack = [
    track.title,
    ...(track.artists || []).map((artist) => artist.name),
    ...(track.extraartists || []).map((artist) => artist.name),
  ]
    .join(" ")
    .toLowerCase();

  return haystack.includes("emufucka") || haystack.includes("emuf.cka");
}

function normalizeTrack(track, release) {
  const artists = uniq((track.artists || []).map((artist) => cleanName(artist.name)));
  const emufuckaCredits = uniq(
    (track.extraartists || [])
      .filter((artist) => cleanName(artist.name).toLowerCase().includes("emufucka"))
      .map((artist) => compact([cleanName(artist.name), artist.role]).join(" / ")),
  );

  return {
    position: track.position || "",
    title: track.title || "Untitled",
    artist: artists.join(", "),
    duration: track.duration || "",
    credits: emufuckaCredits,
    release_id: release.id,
  };
}

function normalizeRelease(item, detail) {
  const roles = uniq(item.roles || [item.role]);
  const allTracks = (detail.tracklist || []).map((track) => normalizeTrack(track, item));
  const isPrimary = roles.includes("Main") || roles.includes("UnofficialRelease");
  const featuredTracks = isPrimary
    ? allTracks
    : (detail.tracklist || [])
        .filter(trackMentionsEmufucka)
        .map((track) => normalizeTrack(track, item));

  return {
    id: item.id,
    type: item.type,
    roles,
    artist: item.artist || detail.artists_sort || "",
    title: item.title || detail.title || "",
    year: item.year || detail.year || "",
    released: detail.released || (detail.year ? String(detail.year) : ""),
    label: uniq([
      ...(detail.labels || []).map((label) => cleanName(label.name)),
      item.label,
    ]).join(", "),
    format: item.format || (detail.formats || []).map((format) => format.name).join(", "),
    discogs_url: detail.uri || `${ARTIST_URL}?release=${item.id}`,
    resource_url: item.resource_url,
    all_tracks: allTracks,
    featured_tracks: featuredTracks,
  };
}

function releaseSort(a, b) {
  const yearDiff = Number(b.year || 0) - Number(a.year || 0);
  if (yearDiff) return yearDiff;
  const released = String(b.released || "").localeCompare(String(a.released || ""));
  if (released) return released;
  return String(a.title).localeCompare(String(b.title));
}

function renderTrackRows(tracks) {
  if (!tracks.length) {
    return '<p class="release-empty">Discogs track rows unavailable.</p>';
  }

  return `<ol class="track-list">
${tracks
  .map((track) => {
    const artist = track.artist
      ? `\n              <span class="track-artist">${escapeHtml(track.artist)}</span>`
      : "";
    const credits = track.credits.length
      ? `\n              <span class="track-credit">${escapeHtml(track.credits.join(", "))}</span>`
      : "";
    const duration = track.duration
      ? `\n            <span class="track-duration">${escapeHtml(track.duration)}</span>`
      : "";
    return `          <li>
            <span class="track-position">${escapeHtml(track.position || " ")}</span>
            <span class="track-body">
              <strong>${escapeHtml(track.title)}</strong>${artist}${credits}
            </span>${duration}
          </li>`;
  })
  .join("\n")}
        </ol>`;
}

function renderNav(current = "releases") {
  const links = [
    ["provenance", "Provenance", "/provenance/"],
    ["documents", "Documents", "/documents/"],
    ["collection", "Collection", "/collection/"],
    ["press", "Press", "/press/"],
    ["video", "Video", "/video/"],
    ["audio", "Audio", "/audio/"],
    ["releases", "Releases", "/releases/"],
    ["timeline", "Timeline", "/timeline/"],
  ];

  return links
    .map(([key, label, href]) => {
      const currentAttr = key === current ? ' aria-current="page"' : "";
      return `      <a href="${href}"${currentAttr}>${label}</a>`;
    })
    .join("\n");
}

function renderFooter() {
  return `  <footer class="site-footer">
    <nav class="social-links" aria-label="Social links">
      <a href="https://soundcloud.com/emufucka" aria-label="Emufucka on SoundCloud" target="_blank" rel="noopener">
        <span class="social-icon social-icon-soundcloud" aria-hidden="true"></span>
      </a>
      <a href="https://open.spotify.com/intl-ja/artist/1bqkaruezjnwOHxd4HUyx1" aria-label="Emufucka on Spotify" target="_blank" rel="noopener">
        <span class="social-icon social-icon-spotify" aria-hidden="true"></span>
      </a>
      <a href="https://music.apple.com/us/artist/emufucka/424908075" aria-label="Emufucka on Apple Music" target="_blank" rel="noopener">
        <span class="social-icon social-icon-applemusic" aria-hidden="true"></span>
      </a>
      <a href="https://www.facebook.com/emuf.cka" aria-label="Emufucka on Facebook" target="_blank" rel="noopener">
        <span class="social-icon social-icon-facebook" aria-hidden="true"></span>
      </a>
      <a href="https://x.com/emufucka" aria-label="Emufucka on X" target="_blank" rel="noopener">
        <span class="social-icon social-icon-x" aria-hidden="true"></span>
      </a>
      <a href="${ARTIST_URL}" aria-label="Emufucka on Discogs" target="_blank" rel="noopener">
        <span class="social-icon social-icon-discogs" aria-hidden="true"></span>
      </a>
    </nav>
  </footer>`;
}

function buildSlimArchive(archive) {
  const primaryCount = archive.releases.filter((release) => release.roles.includes("Main")).length;
  const years = uniq(archive.releases.map((release) => release.year)).sort((a, b) => Number(b) - Number(a));
  const yearRange = `${years.at(-1)}-${years[0]}`;

  return {
    generated_at: archive.generated_at,
    generated_label: archive.generated_label,
    source: archive.source,
    artist_url: ARTIST_URL,
    release_count: archive.releases.length,
    primary_count: primaryCount,
    track_count: archive.track_count,
    year_range: yearRange,
    releases: archive.releases.map((release, index) => {
      const tracks =
        release.roles.includes("Main") || release.roles.includes("UnofficialRelease")
          ? release.all_tracks
          : release.featured_tracks;

      return {
        code: `REL-${String(index + 1).padStart(2, "0")}`,
        id: release.id,
        type: release.type,
        roles: release.roles,
        artist: release.artist,
        title: release.title,
        year: release.year,
        released: release.released,
        label: release.label,
        format: release.format,
        discogs_url: release.discogs_url,
        tracks,
      };
    }),
  };
}

function renderReleasesPage(archive) {
  const primaryCount = archive.releases.filter((release) => release.roles.includes("Main")).length;
  const years = uniq(archive.releases.map((release) => release.year)).sort((a, b) => Number(b) - Number(a));
  const yearRange = `${years.at(-1)}-${years[0]}`;

  return `<!doctype html>
<html lang="en">

<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="EMUFUCKA Releases: Discogs API generated release and track index.">
  <meta name="keywords" content="Emufucka, discography, releases, tracks, Discogs, future beat, bass, Tokyo, electronic music">
  <!-- Adobe Launch -->
  <script src="${AEP_TAG}" async></script>
  <!-- End Adobe Launch -->

  <title>EMUFUCKA / Releases</title>
  <link rel="shortcut icon" href="/image/avatars-000119125128-2ywodh-t500x500.jpg">
  <link rel="apple-touch-icon" href="/image/avatars-000119125128-2ywodh-t500x500.jpg">
  <link rel="stylesheet" href="/stylesheets/styles.css?v=${CSS_VERSION}">
</head>

<body class="room-page">
  <header class="site-nav" aria-label="Site navigation">
    <a class="nav-mark" href="/" aria-label="EMUFUCKA home">EMUFUCKA / ARCHIVE</a>
    <nav class="nav-links" aria-label="Primary">
${renderNav("releases")}
    </nav>
  </header>

  <main>
    <section class="releases-section" id="releases" aria-labelledby="releases-heading">
      <div class="section-number">07</div>
      <div class="section-heading">
        <p class="kicker">Discography</p>
        <h2 id="releases-heading">Release and track ledger.</h2>
      </div>
      <div class="release-board">
        <dl class="release-summary" aria-label="Discogs release summary">
          <div>
            <dt>Discogs entries</dt>
            <dd>${archive.releases.length}</dd>
          </div>
          <div>
            <dt>Main releases</dt>
            <dd>${primaryCount}</dd>
          </div>
          <div>
            <dt>Track rows</dt>
            <dd>${archive.track_count}</dd>
          </div>
          <div>
            <dt>Years</dt>
            <dd>${escapeHtml(yearRange)}</dd>
          </div>
        </dl>

        <div class="release-source-panel">
          <span>Source / Discogs API</span>
          <a href="${ARTIST_URL}" target="_blank" rel="noopener">Artist Page</a>
          <time datetime="${escapeHtml(archive.generated_at)}">${escapeHtml(archive.generated_label)}</time>
        </div>

        <div class="release-grid" aria-label="Discogs release and track index">
${archive.releases
  .map((release, index) => {
    const number = String(index + 1).padStart(2, "0");
    const tracks =
      release.roles.includes("Main") || release.roles.includes("UnofficialRelease")
        ? release.all_tracks
        : release.featured_tracks;
    const roleTags = release.roles
      .map((role) => `<span>${escapeHtml(role)}</span>`)
      .join("");
    const meta = [
      ["Released", release.released || release.year],
      ["Label", release.label],
      ["Format", release.format],
      ["Discogs", `${release.type.toUpperCase()} / ${release.id}`],
    ].filter(([, value]) => value);

    return `          <article class="release-card">
            <header>
              <div class="release-code">
                <span>REL-${number}</span>
                <span>${escapeHtml(String(release.year || "----"))}</span>
              </div>
              <h3>${escapeHtml(release.title)}</h3>
              <p>${escapeHtml(release.artist)}</p>
            </header>
            <div class="role-list" aria-label="Discogs roles">${roleTags}</div>
            <dl class="release-meta">
${meta
  .map(([label, value]) => `              <div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
  .join("\n")}
            </dl>
            ${renderTrackRows(tracks)}
            <a class="release-link" href="${escapeHtml(release.discogs_url)}" target="_blank" rel="noopener">Open on Discogs</a>
          </article>`;
  })
  .join("\n")}
        </div>
      </div>
    </section>

    <nav class="room-pagination" aria-label="Room sequence">
      <a href="/audio/">Previous / Audio</a>
      <a href="/">Index</a>
      <a href="/timeline/">Next / Timeline</a>
    </nav>
  </main>

${renderFooter()}
</body>

</html>
`;
}

async function main() {
  if (process.argv.includes("--render-only")) {
    const archive = JSON.parse(await readFile("data/discogs-releases.json", "utf8"));
    await mkdir("data", { recursive: true });
    await mkdir("releases", { recursive: true });
    await writeFile("data/discogs-releases.slim.json", `${JSON.stringify(buildSlimArchive(archive))}\n`);
    await writeFile("releases/index.html", renderReleasesPage(archive));
    return;
  }

  const listUrl = `${API_ROOT}/artists/${ARTIST_ID}/releases?per_page=100&page=1&sort=year&sort_order=desc`;
  const artistReleases = await fetchJson(listUrl);
  const byRelease = new Map();

  for (const item of artistReleases.releases || []) {
    const key = `${item.type}:${item.id}`;
    if (!byRelease.has(key)) {
      byRelease.set(key, { ...item, roles: [] });
    }
    byRelease.get(key).roles.push(item.role);
  }

  const releases = [];
  for (const item of byRelease.values()) {
    const detail = await fetchJson(item.resource_url);
    releases.push(normalizeRelease(item, detail));
    await wait(process.env.DISCOGS_TOKEN ? 750 : 2700);
  }

  releases.sort(releaseSort);

  const tracks = releases.flatMap((release) =>
    release.featured_tracks.map((track) => ({
      ...track,
      release_title: release.title,
      release_artist: release.artist,
      year: release.year,
      roles: release.roles,
      discogs_url: release.discogs_url,
    })),
  );

  const generated = new Date();
  const archive = {
    generated_at: generated.toISOString(),
    generated_label: generated.toISOString().slice(0, 10),
    source: {
      artist_id: ARTIST_ID,
      artist_url: ARTIST_URL,
      api_url: listUrl,
    },
    release_count: releases.length,
    track_count: tracks.length,
    releases,
    tracks,
  };

  await mkdir("data", { recursive: true });
  await mkdir("releases", { recursive: true });
  await writeFile("data/discogs-releases.json", `${JSON.stringify(archive, null, 2)}\n`);
  await writeFile("data/discogs-releases.slim.json", `${JSON.stringify(buildSlimArchive(archive))}\n`);
  await writeFile("releases/index.html", renderReleasesPage(archive));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
