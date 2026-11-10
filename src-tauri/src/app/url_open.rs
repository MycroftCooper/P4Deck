//! External documentation links opened from the Settings About card.
//!
//! The frontend only names a URL; this module decides whether that URL is an
//! allowlisted product-site page before the operating system sees it. Keeping
//! the allowlist here (not in the webview) means a compromised renderer cannot
//! turn the About card into an arbitrary-URL/executable launcher.
//!
//! The allowlisted origin and sub-path are not written twice: the host embeds
//! the same manifest the renderer imports (`src/shared/productSite.json`), so a
//! URL the UI can offer is exactly a URL the host will accept. Editing the
//! manifest updates both sides; there is no second constant to forget.

use std::sync::OnceLock;

use url::Url;

/// Shared with `src/shared/productSite.ts` through one JSON file.
const PRODUCT_SITE_MANIFEST: &str = include_str!("../../../src/shared/productSite.json");
const MAX_URL_LEN: usize = 2048;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductSiteManifest {
    origin: String,
    path_prefix: String,
    pages: std::collections::BTreeMap<String, String>,
}

/// The validated subset of the manifest the allowlist actually needs.
#[derive(Debug)]
struct ProductSite {
    origin: Url,
    path_prefix: String,
}

/// Parse the embedded manifest once. A malformed manifest fails closed: every
/// link is rejected instead of widening the allowlist.
fn load_product_site() -> Option<ProductSite> {
    let manifest: ProductSiteManifest = serde_json::from_str(PRODUCT_SITE_MANIFEST).ok()?;
    let origin = Url::parse(&manifest.origin).ok()?;
    if origin.scheme() != "https"
        || origin.host_str().is_none_or(str::is_empty)
        || origin.port().is_some()
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.query().is_some()
        || origin.fragment().is_some()
        || origin.path() != "/"
        || !manifest.path_prefix.starts_with('/')
        || !manifest.path_prefix.ends_with('/')
        || manifest.pages.is_empty()
    {
        return None;
    }
    // Every page the UI can open must live under the allowlisted prefix and must
    // survive the same shape checks `validate` applies, or the button would be
    // offered and then rejected.
    for href in manifest.pages.values() {
        if !href.starts_with(&manifest.path_prefix) || href.contains('?') || href.contains('#') {
            return None;
        }
    }
    Some(ProductSite {
        origin,
        path_prefix: manifest.path_prefix,
    })
}

fn product_site() -> Option<&'static ProductSite> {
    static PRODUCT_SITE: OnceLock<Option<ProductSite>> = OnceLock::new();
    PRODUCT_SITE.get_or_init(load_product_site).as_ref()
}

pub fn validate(raw: &str) -> Result<Url, String> {
    if raw.len() > MAX_URL_LEN
        || raw != raw.trim()
        || raw.chars().any(char::is_control)
        || raw.contains('\\')
    {
        return Err("The link is invalid.".into());
    }
    let target = Url::parse(raw).map_err(|_| "The link is invalid.".to_string())?;
    let Some(site) = product_site() else {
        return Err("The link is invalid.".into());
    };
    if target.scheme() != site.origin.scheme()
        || target.host_str() != site.origin.host_str()
        || target.port().is_some()
        || !target.username().is_empty()
        || target.password().is_some()
        || target.query().is_some()
        || target.fragment().is_some()
        || !target.path().starts_with(&site.path_prefix)
    {
        return Err("The link is outside the product-site allowlist.".into());
    }
    Ok(target)
}

pub fn open(raw: &str) -> Result<(), String> {
    let target = validate(raw)?;
    super::platform_open::open(target.as_str())
        .map_err(|_| "The operating system could not open the link.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn site() -> &'static ProductSite {
        product_site().expect("the embedded product-site manifest must be valid")
    }

    /// Absolute URL for a site-relative path, built from the embedded origin.
    fn site_url(path: &str) -> String {
        format!("{}{path}", site().origin.as_str().trim_end_matches('/'))
    }

    #[test]
    fn the_embedded_manifest_is_well_formed() {
        let site = site();
        assert_eq!(site.origin.scheme(), "https");
        assert!(site.origin.host_str().is_some());
        assert_eq!(site.path_prefix, "/P4Deck/");
        // The product page and every manifest entry pass the same allowlist the
        // renderer relies on.
        for path in ["/P4Deck/", "/P4Deck/wiki/"] {
            assert!(validate(&site_url(path)).is_ok(), "{path}");
        }
        let manifest: ProductSiteManifest =
            serde_json::from_str(PRODUCT_SITE_MANIFEST).expect("manifest parses");
        for (intent, href) in &manifest.pages {
            assert!(validate(&site_url(href)).is_ok(), "page {intent} = {href}");
        }
    }

    #[test]
    fn allowlists_the_product_site_and_its_wiki() {
        for url in [
            site_url("/P4Deck/"),
            site_url("/P4Deck/wiki/"),
            site_url("/P4Deck/wiki/index.html"),
        ] {
            assert!(validate(&url).is_ok(), "{url}");
        }
    }

    #[test]
    fn rejects_every_other_origin_scheme_and_shape() {
        let host = site().origin.host_str().expect("host").to_owned();
        let rejected = [
            format!("http://{host}/P4Deck/"),
            "https://evil.example/P4Deck/".to_string(),
            format!("https://{host}/"),
            format!("https://{host}/OtherProject/"),
            format!("https://user:secret@{host}/P4Deck/"),
            format!("https://{host}:8443/P4Deck/"),
            format!("https://{host}/P4Deck/?x=1"),
            format!("https://{host}/P4Deck/#top"),
            "javascript:alert(1)".to_string(),
            "file:///C:/Windows/System32/cmd.exe".to_string(),
            "data:text/html,x".to_string(),
            format!(" https://{host}/P4Deck/"),
            format!("https://{host}/P4Deck/\r\nhttps://evil.example"),
            format!("https://{host}\\P4Deck\\"),
        ];
        for url in rejected {
            assert!(validate(&url).is_err(), "{url}");
        }
    }

    #[test]
    fn rejects_oversized_links_without_echoing_them() {
        let long = site_url(&format!("/P4Deck/{}", "a".repeat(4096)));
        let error = validate(&long).unwrap_err();
        assert_eq!(error, "The link is invalid.");
        assert!(!error.contains("aaaa"));
    }
}
