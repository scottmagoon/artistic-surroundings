import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import { loadSettings } from "./src/lib/settings.mjs";

// Settings are validated up front so a bad site-settings.yaml fails the build
// with a readable message instead of a stack trace deep inside page rendering.
const settings = loadSettings();

export default defineConfig({
  site: settings.siteUrl,
  integrations: [sitemap()],
});
