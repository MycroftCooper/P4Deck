import { describe, expect, it } from "vitest";
import manifest from "./productSite.json";
import {
  PRODUCT_PAGE_URL,
  PRODUCT_SITE_ORIGIN,
  PRODUCT_SITE_PATH_PREFIX,
  WIKI_URL,
} from "./productSite";

/**
 * These assertions pin the contract the Rust allowlist embeds the very same
 * JSON for: a bare https origin, one repository sub-path, and pages relative to
 * it. A URL that breaks one of these rules would be rejected by the host even
 * though the renderer offered the button.
 */
describe("product-site manifest", () => {
  it("uses a bare https origin without a path, port or trailing slash", () => {
    const origin = new URL(PRODUCT_SITE_ORIGIN);
    expect(origin.protocol).toBe("https:");
    expect(origin.port).toBe("");
    expect(origin.username).toBe("");
    expect(origin.password).toBe("");
    expect(origin.search).toBe("");
    expect(origin.hash).toBe("");
    expect(origin.pathname).toBe("/");
    expect(PRODUCT_SITE_ORIGIN).not.toMatch(/\/$/);
  });

  it("serves every page under one slash-delimited repository prefix", () => {
    expect(PRODUCT_SITE_PATH_PREFIX.startsWith("/")).toBe(true);
    expect(PRODUCT_SITE_PATH_PREFIX.endsWith("/")).toBe(true);
    for (const [intent, href] of Object.entries(manifest.pages)) {
      expect(href.startsWith(PRODUCT_SITE_PATH_PREFIX), intent).toBe(true);
      // The host allowlist rejects query strings and fragments, so a link that
      // carries either could never be opened.
      expect(href).not.toMatch(/[?#]/);
      expect(href.endsWith("/")).toBe(true);
    }
  });

  it("builds the product and wiki links the UI opens", () => {
    expect(PRODUCT_PAGE_URL).toBe(
      `${PRODUCT_SITE_ORIGIN}${PRODUCT_SITE_PATH_PREFIX}`,
    );
    // Both links stay inside the allowlisted repository sub-path.
    for (const url of [PRODUCT_PAGE_URL, WIKI_URL]) {
      expect(url.startsWith(PRODUCT_SITE_ORIGIN)).toBe(true);
      const parsed = new URL(url);
      expect(parsed.pathname.startsWith(PRODUCT_SITE_PATH_PREFIX)).toBe(true);
      expect(parsed.protocol).toBe("https:");
      expect(parsed.port).toBe("");
      expect(parsed.search).toBe("");
      expect(parsed.hash).toBe("");
    }
    expect(WIKI_URL).not.toBe(PRODUCT_PAGE_URL);
  });
});
