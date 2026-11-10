import manifest from "./productSite.json";

/**
 * The published product pages, in one place for both sides of the app.
 *
 * `productSite.json` is the single source of truth: the renderer imports it
 * here, and the Rust host embeds the very same file
 * (`include_str!` in `src-tauri/src/app/url_open.rs`) to decide which URLs may
 * leave the webview. Editing the JSON therefore changes the renderer and the
 * host's allowlist together; there is no second copy to forget.
 *
 * The JSON shape:
 *   origin      scheme://host of the published site (no path, no trailing slash)
 *   pathPrefix  repository sub-path GitHub Pages serves from, with both slashes
 *   pages       site-relative paths opened from the UI, keyed by intent
 */
export const PRODUCT_SITE_ORIGIN: string = manifest.origin;
export const PRODUCT_SITE_PATH_PREFIX: string = manifest.pathPrefix;
export const PRODUCT_PAGE_URL = `${manifest.origin}${manifest.pages.product}`;
export const WIKI_URL = `${manifest.origin}${manifest.pages.wiki}`;
