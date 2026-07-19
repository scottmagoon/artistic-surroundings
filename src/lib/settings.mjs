// Loads and validates site-settings.yaml. Validation runs before anything
// else touches the settings, and fails with a readable message list —
// never a stack trace — per the build spec.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { parsePattern, referencedTokens, parseSectionSort } from "./folderPattern.mjs";

// Astro's build bundles this module, which moves it under dist/ and breaks
// any import.meta.url-relative path — so we anchor on the working directory
// instead. astro build/dev and `npm run import` are always invoked from the
// project root, matching the spec's documented workflow.
export const PROJECT_ROOT = process.cwd();
export const SETTINGS_PATH = resolve(PROJECT_ROOT, "site-settings.yaml");
export const CONTENT_ROOT = resolve(PROJECT_ROOT, "content");

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const URL_RE = /^https?:\/\/[^\s]+\.[^\s]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const LAYOUTS = ["directory", "sectioned-wall", "single-wall"];
const DISPLAY_MODES = ["scroll", "grid"];
const ANALYTICS_PROVIDERS = ["plausible", "goatcounter"];

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function req(errors, path, value, label) {
  if (value === undefined || value === null || value === "") {
    errors.push(`${path}: ${label || "is required"}`);
    return false;
  }
  return true;
}

function validateWing(wing, index, errors, warnings) {
  const path = `wings > ${wing && wing.name ? wing.name : `#${index + 1}`}`;

  if (!req(errors, path, wing.name, "name is required")) return;
  if (!req(errors, path, wing.slug, "slug is required")) return;
  if (!SLUG_RE.test(wing.slug)) {
    errors.push(`${path}: slug must be lowercase letters, numbers, and hyphens — found "${wing.slug}"`);
  }

  if (!req(errors, path, wing.layout, "layout is required")) return;
  if (!LAYOUTS.includes(wing.layout)) {
    errors.push(`${path}: layout must be one of ${LAYOUTS.map((l) => `'${l}'`).join(", ")} — found '${wing.layout}'`);
  }

  if (!req(errors, path, wing.displayMode, "displayMode is required")) return;
  if (!DISPLAY_MODES.includes(wing.displayMode)) {
    errors.push(`${path}: displayMode must be 'scroll' or 'grid' — found '${wing.displayMode}'`);
  }

  if (wing.published !== undefined && typeof wing.published !== "boolean") {
    errors.push(`${path}: published must be true or false`);
  }

  // single-wall wings hang every painting directly in content/<slug>/ —
  // the folder-pattern machinery never runs for them, so those fields
  // aren't required
  if (wing.layout === "single-wall") return;

  if (!req(errors, path, wing.folderPattern, "folderPattern is required")) return;
  const { tokens, errors: patternErrors } = parsePattern(wing.folderPattern);
  for (const e of patternErrors) errors.push(`${path} > folderPattern: ${e}`);
  const tokenNames = new Set(tokens.map((t) => t.name));

  if (!req(errors, path, wing.sectionTitle, "sectionTitle is required")) return;
  for (const name of referencedTokens(wing.sectionTitle)) {
    if (!tokenNames.has(name)) {
      errors.push(`${path} > sectionTitle: references {${name}}, which is not in folderPattern`);
    }
  }

  if (wing.sectionSort !== undefined) {
    const parsed = parseSectionSort(wing.sectionSort);
    if (!parsed) {
      errors.push(`${path} > sectionSort: must look like "{token} asc" or "{token} desc" — found "${wing.sectionSort}"`);
    } else if (!tokenNames.has(parsed.token)) {
      errors.push(`${path} > sectionSort: references {${parsed.token}}, which is not in folderPattern`);
    }
  }
}

/** Validate a raw parsed settings object. Returns { errors, warnings }. */
export function validateSettings(raw) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(raw)) {
    return { errors: ["site-settings.yaml: file is empty or not a valid YAML mapping"], warnings };
  }

  req(errors, "siteUrl", raw.siteUrl);
  if (raw.siteUrl && !URL_RE.test(raw.siteUrl)) {
    errors.push(`siteUrl: doesn't look like a valid URL — found "${raw.siteUrl}"`);
  }

  req(errors, "locale", raw.locale);
  req(errors, "contactEmail", raw.contactEmail);
  if (raw.contactEmail && !EMAIL_RE.test(raw.contactEmail)) {
    errors.push(`contactEmail: doesn't look like a valid email — found "${raw.contactEmail}"`);
  }
  if (raw.obfuscateEmail !== undefined && typeof raw.obfuscateEmail !== "boolean") {
    errors.push("obfuscateEmail: must be true or false");
  }

  if (raw.socialLinks !== undefined) {
    if (!Array.isArray(raw.socialLinks)) {
      errors.push("socialLinks: must be a list");
    } else {
      raw.socialLinks.forEach((link, i) => {
        const path = `socialLinks > #${i + 1}`;
        req(errors, path, link && link.label, "label is required");
        req(errors, path, link && link.url, "url is required");
        if (link && link.url && !URL_RE.test(link.url)) {
          errors.push(`${path}: url doesn't look valid — found "${link.url}"`);
        }
      });
    }
  }

  const REQUIRED_UI_TEXT = [
    "siteName", "lobbyKicker", "lobbyIntro", "searchPlaceholder",
    "backToLobby", "backToDirectory", "featuredTierLabel", "allArtistsTierLabel",
    "noSearchResults", "countWords", "notFoundTitle", "notFoundMessage",
  ];
  if (!isPlainObject(raw.uiText)) {
    errors.push("uiText: is required");
  } else {
    for (const key of REQUIRED_UI_TEXT) {
      req(errors, `uiText > ${key}`, raw.uiText[key]);
    }
  }

  if (!Array.isArray(raw.wings) || raw.wings.length === 0) {
    errors.push("wings: must be a non-empty list");
  } else {
    const slugs = new Set();
    raw.wings.forEach((wing, i) => {
      validateWing(wing || {}, i, errors, warnings);
      if (wing && wing.slug) {
        if (slugs.has(wing.slug)) errors.push(`wings > ${wing.name || wing.slug}: slug "${wing.slug}" is used by more than one wing`);
        slugs.add(wing.slug);
      }
    });
  }

  if (raw.analytics !== undefined) {
    if (!isPlainObject(raw.analytics)) {
      errors.push("analytics: must be a mapping");
    } else {
      if (typeof raw.analytics.enabled !== "boolean") {
        errors.push("analytics > enabled: must be true or false");
      }
      if (raw.analytics.enabled) {
        if (!ANALYTICS_PROVIDERS.includes(raw.analytics.provider)) {
          errors.push(`analytics > provider: must be one of ${ANALYTICS_PROVIDERS.map((p) => `'${p}'`).join(", ")} — found '${raw.analytics.provider}'`);
        }
        req(errors, "analytics > siteId", raw.analytics.siteId);
      }
    }
  }

  if (!isPlainObject(raw.theme)) {
    errors.push("theme: is required (wallColor, frameColor, matColor)");
  } else {
    for (const key of ["wallColor", "frameColor", "matColor"]) {
      const val = raw.theme[key];
      if (!req(errors, `theme > ${key}`, val)) continue;
      if (!HEX_COLOR_RE.test(val)) {
        errors.push(`theme > ${key}: must be a valid hex color — found "${val}"`);
      }
    }
  }

  if (!isPlainObject(raw.advanced)) {
    errors.push("advanced: is required (wallImageWidth, lightboxImageWidth, imageQuality)");
  } else {
    for (const key of ["wallImageWidth", "lightboxImageWidth"]) {
      const val = raw.advanced[key];
      if (!req(errors, `advanced > ${key}`, val)) continue;
      if (typeof val !== "number" || val <= 0) {
        errors.push(`advanced > ${key}: must be a positive number — found "${val}"`);
      }
    }
    const q = raw.advanced.imageQuality;
    if (!req(errors, "advanced > imageQuality", q)) {
      // already reported
    } else if (typeof q !== "number" || q < 1 || q > 100) {
      errors.push(`advanced > imageQuality: must be a number between 1 and 100 — found "${q}"`);
    }
  }

  return { errors, warnings };
}

/** Apply documented defaults after validation has passed. */
function applyDefaults(raw) {
  const settings = structuredClone(raw);
  settings.wings = settings.wings.map((wing) => ({
    published: true,
    sectionSort: "{date} desc",
    ...wing,
  }));
  settings.socialLinks = settings.socialLinks || [];
  settings.analytics = settings.analytics || { enabled: false };
  return settings;
}

/**
 * Read, validate, and return settings. On validation failure, prints every
 * error and exits the process — the caller never sees a stack trace.
 *
 * Deliberately uncached: re-reads site-settings.yaml from disk on every
 * call. Parsing + validating this file is cheap, and caching it in a
 * module-level variable would keep `astro dev` serving stale settings after
 * an edit, since Vite has no way to know this fs.readFileSync() call
 * depends on site-settings.yaml.
 */
export function loadSettings({ quiet = false } = {}) {
  if (!existsSync(SETTINGS_PATH)) {
    console.error(`\nsite-settings.yaml not found at ${SETTINGS_PATH}\n`);
    process.exit(1);
  }

  let raw;
  try {
    raw = yaml.load(readFileSync(SETTINGS_PATH, "utf8"));
  } catch (e) {
    console.error(`\nsite-settings.yaml is not valid YAML:\n  ${e.message}\n`);
    process.exit(1);
  }

  const { errors, warnings } = validateSettings(raw);

  if (!quiet) {
    for (const w of warnings) {
      console.warn(`[settings] warning: ${w}`);
    }
  }

  if (errors.length > 0) {
    console.error(`\nsite-settings.yaml has ${errors.length} problem${errors.length === 1 ? "" : "s"}:\n`);
    for (const e of errors) console.error(`  - ${e}`);
    console.error("\nFix the values above, then re-run the build.\n");
    process.exit(1);
  }

  return applyDefaults(raw);
}
