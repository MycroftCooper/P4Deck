//! External documentation links opened from the Settings About card.
//!
//! The frontend only names a URL; this module decides whether that URL is an
//! allowlisted product-site page before the operating system sees it. Keeping
//! the allowlist here (not in the webview) means a compromised renderer cannot
//! turn the About card into an arbitrary-URL/executable launcher.

use url::Url;

/// Origin of the public project site and its wiki (GitHub Pages).
const PRODUCT_HOST: &str = "mycroftcooper.github.io";
/// Repository sub-path that GitHub Pages serves the site from.
const PRODUCT_PATH_PREFIX: &str = "/P4Deck/";
const MAX_URL_LEN: usize = 2048;

pub fn validate(raw: &str) -> Result<Url, String> {
    if raw.len() > MAX_URL_LEN
        || raw != raw.trim()
        || raw.chars().any(char::is_control)
        || raw.contains('\\')
    {
        return Err("The link is invalid.".into());
    }
    let target = Url::parse(raw).map_err(|_| "The link is invalid.".to_string())?;
    if target.scheme() != "https"
        || target.host_str() != Some(PRODUCT_HOST)
        || target.port().is_some()
        || !target.username().is_empty()
        || target.password().is_some()
        || target.query().is_some()
        || target.fragment().is_some()
        || !target.path().starts_with(PRODUCT_PATH_PREFIX)
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

    #[test]
    fn allowlists_the_product_site_and_its_wiki() {
        for url in [
            "https://mycroftcooper.github.io/P4Deck/",
            "https://mycroftcooper.github.io/P4Deck/wiki/",
            "https://mycroftcooper.github.io/P4Deck/wiki/index.html",
        ] {
            assert!(validate(url).is_ok(), "{url}");
        }
    }

    #[test]
    fn rejects_every_other_origin_scheme_and_shape() {
        for url in [
            "http://mycroftcooper.github.io/P4Deck/",
            "https://evil.example/P4Deck/",
            "https://mycroftcooper.github.io/",
            "https://mycroftcooper.github.io/OtherProject/",
            "https://user:secret@mycroftcooper.github.io/P4Deck/",
            "https://mycroftcooper.github.io:8443/P4Deck/",
            "https://mycroftcooper.github.io/P4Deck/?x=1",
            "https://mycroftcooper.github.io/P4Deck/#top",
            "javascript:alert(1)",
            "file:///C:/Windows/System32/cmd.exe",
            "data:text/html,x",
            " https://mycroftcooper.github.io/P4Deck/",
            "https://mycroftcooper.github.io/P4Deck/\r\nhttps://evil.example",
            "https://mycroftcooper.github.io\\P4Deck\\",
        ] {
            assert!(validate(url).is_err(), "{url}");
        }
    }

    #[test]
    fn rejects_oversized_links_without_echoing_them() {
        let long = format!(
            "https://mycroftcooper.github.io/P4Deck/{}",
            "a".repeat(4096)
        );
        let error = validate(&long).unwrap_err();
        assert_eq!(error, "The link is invalid.");
        assert!(!error.contains("aaaa"));
    }
}
