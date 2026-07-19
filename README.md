# Artistic Surroundings

Watercolor gallery site for Mary Jane Magoon — built with Astro, using the
same "museum wall" design as scottmag.photos. Deployed on Vercel; every push
to `main` republishes the site automatically.

## Adding or changing paintings

Each room is a folder inside `content/`:

```
content/
  landscape/
  still-life/
  people/
  animals/
```

- **Add a painting:** drop a `.jpg` into the room's folder, named after the
  painting — the filename (minus `.jpg`) becomes the title on the placard,
  e.g. `Parrot Tulip.jpg`. Paintings hang in alphabetical order.
- **Remove a painting:** delete the file.
- **Change a room's doorway image:** replace that folder's `cover.jpg`
  (the cover never hangs on the wall itself).
- Then commit and push — Vercel rebuilds the site.

## Site text, colors, rooms

Everything lives in `site-settings.yaml` — bio, contact email, room names
and descriptions, theme colors. Edit values, commit, push.

## Running locally

```
npm install
npm run dev       # local preview at http://localhost:4321
npm run build     # full production build into dist/
```

## Reminders

- `siteUrl` in `site-settings.yaml` and the `Sitemap:` line in
  `public/robots.txt` should be updated when the custom domain is connected.
- `contactEmail` is a placeholder — set Mary Jane's preferred address.
