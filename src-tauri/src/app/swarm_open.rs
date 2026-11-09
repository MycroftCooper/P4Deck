use crate::{domain::OpenSwarmLinkRequest, p4::context::normalize_swarm_base_url};
use url::Url;

pub fn validate_binding(
    profile_id: Option<&str>,
    generation: u64,
    request: &OpenSwarmLinkRequest,
) -> Result<(), String> {
    if profile_id != request.expected_profile_id.as_deref()
        || generation != request.expected_context_generation
    {
        return Err("The active connection changed before the Swarm link was opened.".into());
    }
    Ok(())
}

pub fn validate(configured_base: &str, request: &OpenSwarmLinkRequest) -> Result<Url, String> {
    if request.url.len() > 4096
        || request.url != request.url.trim()
        || request.url.chars().any(char::is_control)
        || request.url.contains('\\')
        || regex::Regex::new("(?i)%(?:0[0-9a-f]|1[0-9a-f]|7f)")
            .expect("static encoded-control regex")
            .is_match(&request.url)
        || regex::Regex::new("(?i)%(?:2e|2f|5c)")
            .expect("static encoded-separator regex")
            .is_match(&request.url)
    {
        return Err("The Swarm link is invalid.".into());
    }
    let normalized = normalize_swarm_base_url(configured_base)
        .map_err(|_| "The active profile has no valid Swarm URL.")?;
    let base = Url::parse(&normalized).map_err(|_| "The active profile has no valid Swarm URL.")?;
    let target = Url::parse(&request.url).map_err(|_| "The Swarm link is invalid.")?;
    if target.scheme() != base.scheme()
        || target.host_str() != base.host_str()
        || target.port_or_known_default() != base.port_or_known_default()
        || !target.username().is_empty()
        || target.password().is_some()
        || target.fragment().is_some()
    {
        return Err("The Swarm link is outside the active profile allowlist.".into());
    }
    let relative = target
        .path()
        .strip_prefix(base.path())
        .ok_or_else(|| "The Swarm link is outside the active profile allowlist.".to_string())?;
    let mut segments = relative.split('/');
    match segments.next() {
        Some("changes") => {
            let change = segments.next().unwrap_or_default();
            if change.is_empty()
                || !change.bytes().all(|byte| byte.is_ascii_digit())
                || change
                    .parse::<u64>()
                    .ok()
                    .filter(|value| *value > 0)
                    .is_none()
                || segments.next().is_some()
                || target.query().is_some()
            {
                return Err("The Swarm changelist link is invalid.".into());
            }
        }
        Some("files") => {
            let file_segments = segments.collect::<Vec<_>>();
            if file_segments.len() < 2
                || file_segments.iter().any(|segment| {
                    if segment.is_empty() {
                        return true;
                    }
                    let decoded = urlencoding::decode(segment).ok();
                    decoded.as_deref().is_none_or(|value| {
                        value.is_empty()
                            || matches!(value, "." | "..")
                            || value.contains('/')
                            || value.contains('\\')
                            || value.chars().any(char::is_control)
                    })
                })
            {
                return Err("The Swarm file link is invalid.".into());
            }
            if let Some(query) = target.query() {
                let pairs = target.query_pairs().collect::<Vec<_>>();
                if pairs.len() != 1
                    || pairs[0].0 != "v"
                    || pairs[0]
                        .1
                        .parse::<u64>()
                        .ok()
                        .filter(|value| *value > 0)
                        .is_none()
                    || query.contains('&')
                {
                    return Err("The Swarm file revision link is invalid.".into());
                }
            }
        }
        _ => return Err("The Swarm route is not allowlisted.".into()),
    }
    Ok(target)
}

pub fn open(configured_base: &str, request: &OpenSwarmLinkRequest) -> Result<(), String> {
    let target = validate(configured_base, request)?;
    super::platform_open::open(target.as_str())
        .map_err(|_| "The operating system could not open Swarm.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(url: &str) -> OpenSwarmLinkRequest {
        OpenSwarmLinkRequest {
            url: url.into(),
            expected_profile_id: Some("profile-a".into()),
            expected_context_generation: 7,
        }
    }

    #[test]
    fn allowlists_supported_routes_under_configured_base() {
        for url in [
            "https://swarm.example/p4/changes/123",
            "https://swarm.example/p4/files/depot/main/a%20b%23%25.txt",
            "https://swarm.example/p4/files/%E9%A1%B9%E7%9B%AE/a.txt?v=9",
        ] {
            assert!(
                validate("https://swarm.example/p4", &request(url)).is_ok(),
                "{url}"
            );
        }
    }

    #[test]
    fn rejects_other_origins_credentials_routes_and_injected_data() {
        for url in [
            "javascript:alert(1)",
            "file:///tmp/x",
            "data:text/plain,x",
            "https://user:secret@swarm.example/p4/changes/1",
            "https://evil.example/p4/changes/1",
            "https://swarm.example/other/changes/1",
            "https://swarm.example/p4/api/v11/reviews",
            "https://swarm.example/p4/changes/0",
            "https://swarm.example/p4/changes/1?token=secret",
            "https://swarm.example/p4/files/depot",
            "https://swarm.example/p4/files/depot/a?v=1&token=secret",
            "https://swarm.example/p4/changes/1\r\nhttps://evil.example",
            "https://swarm.example/p4/files/depot/%2e%2e/secret",
            "https://swarm.example/p4/files/depot/a%2fb",
        ] {
            assert!(
                validate("https://swarm.example/p4/", &request(url)).is_err(),
                "{url}"
            );
        }
    }

    #[test]
    fn validation_errors_do_not_echo_sensitive_urls() {
        let value = request("https://user:secret@swarm.example/p4/changes/1");
        let error = validate("https://swarm.example/p4/", &value).unwrap_err();
        assert!(!error.contains("secret"));
        assert!(!error.contains(&value.url));
    }

    #[test]
    fn rejects_stale_profile_and_generation_bindings() {
        let value = request("https://swarm.example/p4/changes/1");
        assert!(validate_binding(Some("profile-a"), 7, &value).is_ok());
        assert!(validate_binding(Some("profile-b"), 7, &value).is_err());
        assert!(validate_binding(Some("profile-a"), 8, &value).is_err());
        assert!(validate_binding(None, 7, &value).is_err());
    }
}
