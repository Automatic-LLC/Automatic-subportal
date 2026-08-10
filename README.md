# Automatic — Sub Bid Portal

The public, sub-facing web page for **Automatic** (the private construction
preconstruction / bid-management desktop app). Invited subcontractors open this
page from the link in their invitation email to view plans, message the general
contractor, and submit or decline bids.

Since v1.21 the repo also carries the **Owner Console** (`owner.html`) — the
app owner's private support page. Same hosting, same security model: the page
source is public but every request needs the owner secret, which lives only in
the backend's `owner_config` row and the owner's password manager.

This repo is **public on purpose** so it can be served by GitHub Pages. It was
split out of the private `Automatic-LLC/Automatic-App` repo so the main app
source stays private while only these static files are exposed.

**This repo is now the only copy.** It began as a mirror of a `docs/subportal/`
folder in the app repo; that folder has since been deleted, so edit the web
files here — there is no other copy to keep in step.

## What's here

Plain HTML/CSS/JS — **no build step, no libraries, no framework.**

| File | Purpose |
|------|---------|
| `index.html` | Page shell (loading / error / plans / messages / submit-bid views). `noindex` so it stays out of search results. |
| `styles.css` | All styling. |
| `app.js` | All behavior. Reads the invite token from the URL hash and talks only to the token-scoped RPCs in the backend. |
| `config.js` | Backend connection (Supabase URL + **publishable** key). |
| `owner.html` / `owner.css` / `owner.js` | Owner Console (v1.21) — companies list, paid flips, owner notes, derived activity timeline, test-company delete. Talks only to the `owner_*` RPCs; inert without the owner secret. |

## Security model

- `config.js` ships the Supabase **publishable** (`anon`) key only. This key is
  *designed* to be public — all data access is guarded server-side by Row-Level
  Security + credential-checked RPC functions (`Cloud/schema.sql` in the main
  repo). **Never** put the `service_role`/secret key here or anywhere in this repo.
- The invite token rides the URL **hash** (`#...`), so it is never sent to any
  web server — only handed to the backend RPCs by `app.js`.
- The owner secret is **never in a URL** — it is typed into `owner.html` and
  kept in the browser's session storage (or local storage when "remember on
  this device" is checked). Every `owner_*` RPC validates it server-side;
  wrong or absent secret = `unauthorized`, so hosting the page publicly
  exposes nothing.

## Keeping in sync (important)

`config.js` here **must match** `Config.py` (`CLOUD_URL` / `CLOUD_ANON_KEY`) in
the main Automatic repo. If the Supabase project or key ever changes, update
**both** places.

`app.js`'s `CSI_NAMES` table mirrors `Config.CSI_DIVISIONS` — the trade names a
sub sees on their invite chips. Regenerate it from `Config.py` rather than
hand-editing; it drifted once and stopped at Division 34, so a sub invited to
bid a Division 40+ trade saw a bare number.

## Enabling GitHub Pages

1. Repo **Settings → Pages**.
2. **Build and deployment → Source:** *Deploy from a branch*.
3. **Branch:** `main`, folder `/ (root)` → **Save**.
4. After it builds, the live URL appears at the top of the same page. Put that
   exact URL into `Config.SUBPORTAL_URL` in the main Automatic repo.

Expected URL: `https://automatic-llc.github.io/Automatic-subportal/`
