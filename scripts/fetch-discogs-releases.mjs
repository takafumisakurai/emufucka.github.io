#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";

const ARTIST_ID = 2192327;
const ARTIST_URL = "https://www.discogs.com/ja/artist/2192327-Emufucka";
const API_ROOT = "https://api.discogs.com";
const USER_AGENT = process.env.DISCOGS_USER_AGENT || "emufucka-archive/1.0 +https://www.emufucka.com";
const ARCHIVE_PATH = "data/discogs-releases.json";
const SLIM_ARCHIVE_PATH = "data/discogs-releases.slim.json";

// The release page is maintained independently; this script only refreshes its JSON inputs.

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanName(value = "") {
  return String(value).replace(/\s+\(\d+\)$/u, "").trim();
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
        Array.isArray(release.tracks)
          ? release.tracks
          : release.roles.includes("Main") || release.roles.includes("UnofficialRelease")
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

async function writeJsonOutputs(archive, { includeFullArchive = false } = {}) {
  await mkdir("data", { recursive: true });
  if (includeFullArchive) {
    await writeFile(ARCHIVE_PATH, `${JSON.stringify(archive, null, 2)}\n`);
  }
  await writeFile(SLIM_ARCHIVE_PATH, `${JSON.stringify(buildSlimArchive(archive))}\n`);
}

async function main() {
  if (process.argv.includes("--render-only")) {
    let archive;
    try {
      archive = JSON.parse(await readFile(ARCHIVE_PATH, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // Fresh clones do not contain the ignored full archive. Re-normalize the
      // tracked slim archive instead, while leaving the release page untouched.
      archive = JSON.parse(await readFile(SLIM_ARCHIVE_PATH, "utf8"));
    }
    await writeJsonOutputs(archive);
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

  await writeJsonOutputs(archive, { includeFullArchive: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
