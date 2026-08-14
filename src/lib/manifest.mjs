// Walks content/, applies metadata.yaml overrides, and builds a fully
// resolved manifest per wing that pages consume to render directories and
// walls. Runs once per build (memoized).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";
import yaml from "js-yaml";
import sharp from "sharp";
import {
  parsePattern,
  matchFolderName,
  buildSectionTitle,
  parseSectionSort,
  compareSections,
} from "./folderPattern.mjs";
import { CONTENT_ROOT } from "./settings.mjs";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);

function isHidden(name) {
  return name.startsWith(".");
}

function listDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !isHidden(e.name))
    .map((e) => e.name)
    .sort();
}

function listImages(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !isHidden(e.name) && IMAGE_EXTENSIONS.has(extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort();
}

function readMetadata(dir) {
  const path = join(dir, "metadata.yaml");
  if (!existsSync(path)) return {};
  try {
    return yaml.load(readFileSync(path, "utf8")) || {};
  } catch (e) {
    console.warn(`[manifest] warning: ${relative(CONTENT_ROOT, path)} is not valid YAML (${e.message}) — ignoring`);
    return {};
  }
}

async function readPhoto(dir, filename, relPathPrefix) {
  const full = join(dir, filename);
  const meta = await sharp(full).metadata();
  return {
    filename,
    src: `/${relative(CONTENT_ROOT, full).split("/").map(encodeURIComponent).join("/")}`,
    contentPath: full,
    width: meta.width,
    height: meta.height,
  };
}

/**
 * A file literally named cover.jpg (or .jpeg/.png) in any folder designates
 * that folder's cover image. It never hangs on a wall itself — it's cover
 * art, not a wall photo. Precedence everywhere a cover is picked:
 * metadata.yaml `cover:` > cover.jpg > first image by filename.
 */
const COVER_FILE_RE = /^cover\.(jpe?g|png)$/i;

function isCoverFile(name) {
  return COVER_FILE_RE.test(name);
}

/** The folder's designated cover photo (cover.jpg), or null. */
async function readCoverFile(dir) {
  const coverName = listImages(dir).find(isCoverFile);
  return coverName ? readPhoto(dir, coverName) : null;
}

/**
 * Build the section list (photos grouped by matched sub-folder) for a
 * wing or artist directory. `dir` contains one folder per section, each
 * full of photo files (plus an optional metadata.yaml).
 */
async function buildSections(dir, wing, warnings, { artistName, artistDir } = {}) {
  const { parts } = parsePattern(wing.folderPattern);
  const sortSpec = parseSectionSort(wing.sectionSort);
  const folderNames = listDirs(dir);

  const sections = [];
  for (const folderName of folderNames) {
    const sectionDir = join(dir, folderName);
    const allImageNames = listImages(sectionDir);
    const coverFileName = allImageNames.find(isCoverFile);
    const photoNames = allImageNames.filter((n) => !isCoverFile(n));
    if (photoNames.length === 0) continue;

    const matched = matchFolderName(wing.folderPattern, folderName);
    if (!matched) {
      warnings.push(
        `${relative(CONTENT_ROOT, sectionDir)} doesn't match the "${wing.slug}" wing's folderPattern ("${wing.folderPattern}") — using the raw folder name as its title`
      );
    }

    if (matched && artistName && matched.values.artist && matched.values.artist !== artistName) {
      warnings.push(
        `${relative(CONTENT_ROOT, sectionDir)}: parsed artist "${matched.values.artist}" doesn't match parent folder "${artistName}"`
      );
    }

    const meta = readMetadata(sectionDir);
    const title = meta.title || (matched ? buildSectionTitle(wing.sectionTitle, matched) : folderName);

    const photos = await Promise.all(photoNames.map((name) => readPhoto(sectionDir, name)));

    let cover = coverFileName ? await readPhoto(sectionDir, coverFileName) : photos[0];
    if (meta.cover) {
      const found = photos.find((p) => p.filename === meta.cover);
      if (found) cover = found;
      else warnings.push(`${relative(CONTENT_ROOT, sectionDir)}: metadata.yaml cover "${meta.cover}" not found among its photos`);
    }

    sections.push({
      folderName,
      title,
      matched,
      photos,
      cover,
      featured: meta.featured ?? false,
      date: matched?.dates?.date ?? null,
      b2Parts: artistDir ? [artistDir, folderName] : [folderName],
    });
  }

  sections.sort((a, b) => compareSections(a, b, sortSpec));
  return sections;
}

async function buildDirectoryWing(wing, warnings) {
  const wingDir = join(CONTENT_ROOT, wing.slug);
  const artistFolders = listDirs(wingDir);

  const artists = [];
  for (const artistFolder of artistFolders) {
    const artistDir = join(wingDir, artistFolder);
    const artistMeta = readMetadata(artistDir);
    const sections = await buildSections(artistDir, wing, warnings, { artistName: artistFolder, artistDir: artistFolder });
    if (sections.length === 0) continue;

    const photoCount = sections.reduce((n, s) => n + s.photos.length, 0);
    artists.push({
      name: artistMeta.title || artistFolder,
      slug: slugify(artistFolder),
      folderName: artistFolder,
      sections,
      cover:
        (artistMeta.cover && findPhotoByFilename(sections, artistMeta.cover)) ||
        (await readCoverFile(artistDir)) ||
        sections[0].cover,
      featured: artistMeta.featured ?? false,
      eventCount: sections.length,
      photoCount,
    });
  }

  assertUsableSlugs(artists, wing.slug);

  artists.sort((a, b) => {
    const aFeatured = a.featured !== false;
    const bFeatured = b.featured !== false;
    if (aFeatured !== bFeatured) return aFeatured ? -1 : 1;
    if (aFeatured && bFeatured && typeof a.featured === "number" && typeof b.featured === "number") {
      if (a.featured !== b.featured) return a.featured - b.featured;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  return { type: "directory", artists };
}

/**
 * A slug becomes the artist's URL, so two folders that reduce to the same
 * slug ("The Blenders" and "The Blenders!") would build the same page and
 * one artist's wall would silently disappear. A name with no Latin
 * alphanumerics at all ("!!!", "東京バンド") reduces to an empty slug and
 * breaks the route outright. Both are loud build failures rather than
 * silent content loss — with a concrete fix in the message.
 */
function assertUsableSlugs(artists, wingSlug) {
  const empties = artists.filter((a) => !a.slug);
  if (empties.length > 0) {
    const names = empties.map((a) => `"${a.folderName}"`).join(", ");
    throw new Error(
      `\nFolder name${empties.length > 1 ? "s" : ""} in content/${wingSlug}/ ` +
        `can't be turned into a web address: ${names}\n\n` +
        `A folder needs at least one letter or number that a URL can use.\n` +
        `Fix: rename the folder (e.g. add a readable name), or add a metadata.yaml\n` +
        `in it with a "title:" line and rename the folder to something plain.\n`
    );
  }

  const bySlug = new Map();
  for (const a of artists) {
    if (!bySlug.has(a.slug)) bySlug.set(a.slug, []);
    bySlug.get(a.slug).push(a.folderName);
  }
  const collisions = [...bySlug.entries()].filter(([, names]) => names.length > 1);
  if (collisions.length > 0) {
    const detail = collisions
      .map(([slug, names]) => `  ${names.map((n) => `"${n}"`).join(" and ")} both become "/${wingSlug}/${slug}"`)
      .join("\n");
    throw new Error(
      `\nTwo folders in content/${wingSlug}/ produce the same web address:\n\n` +
        `${detail}\n\n` +
        `Only one of them could appear on the site, so this is stopped here rather\n` +
        `than silently dropping an artist. Fix: rename one of the folders so they\n` +
        `differ by more than punctuation.\n`
    );
  }
}

function findPhotoByFilename(sections, filename) {
  for (const s of sections) {
    const found = s.photos.find((p) => p.filename === filename);
    if (found) return found;
  }
  return null;
}

function slugify(name) {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function buildSectionedWing(wing, warnings) {
  const wingDir = join(CONTENT_ROOT, wing.slug);
  const sections = await buildSections(wingDir, wing, warnings);
  return { type: "sectioned-wall", sections };
}

async function buildSingleWallWing(wing, warnings) {
  const wingDir = join(CONTENT_ROOT, wing.slug);
  const photoNames = listImages(wingDir).filter((n) => !isCoverFile(n));
  const photos = await Promise.all(photoNames.map((name) => readPhoto(wingDir, name)));
  return { type: "single-wall", photos };
}

/**
 * Build the full manifest: one entry per published wing that has content.
 * Skipped (unpublished or empty) wings are omitted; warnings are collected
 * for the caller to print.
 *
 * Deliberately uncached across calls: walking content/ and reading image
 * metadata is cheap at this catalog's scale, and caching in a module-level
 * variable would keep `astro dev` serving a stale manifest after content/
 * or site-settings.yaml changes on disk (Vite can't see that dependency).
 */
export async function getManifest(settings) {
  const warnings = [];
  const wings = [];

  for (const wing of settings.wings) {
    if (wing.published === false) continue;

    const wingDir = join(CONTENT_ROOT, wing.slug);
    if (!existsSync(wingDir)) {
      warnings.push(`wing "${wing.name}" is published but content/${wing.slug}/ doesn't exist — skipping (no doorway shown)`);
      continue;
    }

    let data;
    if (wing.layout === "directory") data = await buildDirectoryWing(wing, warnings);
    else if (wing.layout === "sectioned-wall") data = await buildSectionedWing(wing, warnings);
    else data = await buildSingleWallWing(wing, warnings);

    const isEmpty =
      (data.type === "directory" && data.artists.length === 0) ||
      (data.type === "sectioned-wall" && data.sections.length === 0) ||
      (data.type === "single-wall" && data.photos.length === 0);

    if (isEmpty) {
      warnings.push(`wing "${wing.name}" is published but content/${wing.slug}/ has no photographs yet — skipping (no doorway shown)`);
      continue;
    }

    const eventCount =
      data.type === "directory"
        ? data.artists.reduce((n, a) => n + a.eventCount, 0)
        : data.type === "sectioned-wall"
        ? data.sections.length
        : 1;
    const photoCount =
      data.type === "directory"
        ? data.artists.reduce((n, a) => n + a.photoCount, 0)
        : data.type === "sectioned-wall"
        ? data.sections.reduce((n, s) => n + s.photos.length, 0)
        : data.photos.length;

    const cover =
      (await readCoverFile(wingDir)) ||
      (data.type === "directory"
        ? data.artists[0]?.cover
        : data.type === "sectioned-wall"
        ? data.sections[0]?.cover
        : data.photos[0]);

    wings.push({ config: wing, data, eventCount, photoCount, cover });
  }

  return { wings, warnings };
}
