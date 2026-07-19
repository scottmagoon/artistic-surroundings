// Bridges manifest photo entries (plain filesystem paths) to Astro's
// astro:assets image pipeline, which needs a Vite-resolved module. The glob
// below must stay a literal string — Vite statically analyzes it.

import { relative, sep } from "node:path";
import { PROJECT_ROOT } from "./settings.mjs";

const modules = import.meta.glob("/content/**/*.{jpg,jpeg,png}");

/** Resolve a manifest photo's absolute contentPath to an Astro ImageMetadata. */
export async function resolveImage(contentPath) {
  const key = "/" + relative(PROJECT_ROOT, contentPath).split(sep).join("/");
  const loader = modules[key];
  if (!loader) {
    throw new Error(`No Vite module found for image at ${key} — did content/ change since the dev server started?`);
  }
  const mod = await loader();
  return mod.default;
}
