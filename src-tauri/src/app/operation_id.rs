//! The single source of truth for operation ids that cross the IPC boundary.
//!
//! Every mutation service used to carry its own, slightly different operation id
//! validator, and two of them (`workflow_service`, plus the `safe_operation_id`
//! / `safe_operation_prefix` helpers) silently replaced an id they did not like
//! with a freshly generated UUID. The frontend kept using the id *it* sent, so
//! `cancelOperation` could not reach the command that actually ran, and nothing
//! reported the mismatch.
//!
//! The rule lives here once:
//!
//! * non-empty, at most [`MAX_OPERATION_ID_LEN`] bytes (all allowed characters
//!   are ASCII, so this is also a character limit);
//! * only ASCII letters, digits, `-`, `_`, `:` and `.`.
//!
//! `:` and `.` are allowed because the backend derives internal child ids such
//! as `<id>:retry1`, `<id>:history` or `<id>:write` from the caller's id, and the
//! frontend's `crypto.randomUUID()` output must be accepted as-is. Control
//! characters, whitespace and path separators are rejected: an id is echoed in
//! logs, journals and cancellation lookups, never used as a path.
//!
//! A *missing* id is not an error — callers that did not supply one still get a
//! generated id. A supplied id that is not valid **is** an error: no service may
//! substitute another id behind the caller's back.

use std::fmt;

use uuid::Uuid;

/// Longest operation id any service accepts, in bytes.
pub const MAX_OPERATION_ID_LEN: usize = 128;

/// Why a caller-supplied operation id was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum OperationIdErrorKind {
    /// The id is longer than [`MAX_OPERATION_ID_LEN`].
    TooLong,
    /// The id contains a character outside `[A-Za-z0-9._:-]`.
    ForbiddenCharacter(char),
}

/// A caller-supplied operation id that cannot be used as-is.
///
/// [`fmt::Display`] starts with `invalidOperationId: ` so a service can forward
/// the message unchanged (or map it onto its own failure/rejection code).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OperationIdError {
    kind: OperationIdErrorKind,
}

impl OperationIdError {
    fn too_long() -> Self {
        Self {
            kind: OperationIdErrorKind::TooLong,
        }
    }

    fn forbidden(character: char) -> Self {
        Self {
            kind: OperationIdErrorKind::ForbiddenCharacter(character),
        }
    }
}

impl fmt::Display for OperationIdError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.kind {
            OperationIdErrorKind::TooLong => write!(
                formatter,
                "invalidOperationId: the operation id must be at most {MAX_OPERATION_ID_LEN} ASCII characters"
            ),
            OperationIdErrorKind::ForbiddenCharacter(character) => write!(
                formatter,
                "invalidOperationId: character {character:?} is not allowed; use ASCII letters, digits, '-', '_', ':' or '.'"
            ),
        }
    }
}

impl std::error::Error for OperationIdError {}

/// Whether `value` is a usable operation id (UUIDs and internal child ids both).
pub fn is_valid_operation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_OPERATION_ID_LEN
        && value.chars().all(is_valid_character)
}

/// Normalise a caller-supplied id without ever inventing a replacement.
///
/// * `None`, `""`, or a whitespace-only id → `Ok(None)`: the caller did not give
///   an id, so the caller of this function may generate one.
/// * a real id that breaks the rule → `Err`: the caller *did* give an id and it
///   must not be swapped for another one.
pub fn accept_operation_id(value: Option<&str>) -> Result<Option<String>, OperationIdError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.trim().is_empty() {
        return Ok(None);
    }
    if value.len() > MAX_OPERATION_ID_LEN {
        return Err(OperationIdError::too_long());
    }
    if let Some(character) = value
        .chars()
        .find(|character| !is_valid_character(*character))
    {
        return Err(OperationIdError::forbidden(character));
    }
    Ok(Some(value.to_owned()))
}

/// Resolve the id a service should use.
///
/// Uses the caller's id when it supplied a valid one, and only mints a fresh
/// UUID when the caller supplied none. A supplied-but-invalid id is an error.
pub fn resolve_operation_id(value: Option<&str>) -> Result<String, OperationIdError> {
    match accept_operation_id(value)? {
        Some(id) => Ok(id),
        None => Ok(Uuid::new_v4().to_string()),
    }
}

/// Resolve a *prefix* for the ids a service derives (`<prefix>:recheck`, …).
///
/// Same rules as [`resolve_operation_id`], except the generated fallback is
/// `"{fallback}-{uuid}"` so a log can tell which inspection produced an id.
pub fn resolve_operation_prefix(
    value: Option<&str>,
    fallback: &str,
) -> Result<String, OperationIdError> {
    match accept_operation_id(value)? {
        Some(id) => Ok(id),
        None => Ok(format!("{fallback}-{}", Uuid::new_v4())),
    }
}

fn is_valid_character(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':' | '.')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_rejected(value: &str) {
        let error =
            accept_operation_id(Some(value)).expect_err(&format!("{value:?} must be rejected"));
        assert!(
            error.to_string().starts_with("invalidOperationId: "),
            "unexpected message: {error}"
        );
        assert!(!is_valid_operation_id(value));
    }

    #[test]
    fn frontend_uuids_are_accepted_unchanged() {
        let id = Uuid::new_v4().to_string();
        assert_eq!(id.len(), 36);
        assert!(is_valid_operation_id(&id));
        assert_eq!(
            accept_operation_id(Some(&id)).unwrap().as_deref(),
            Some(id.as_str())
        );
        assert_eq!(resolve_operation_id(Some(&id)).unwrap(), id);
    }

    #[test]
    fn internal_child_ids_are_accepted() {
        for id in [
            "abc:retry1",
            "abc:history",
            "f0e1d2c3-0000-4000-8000-000000000000:write",
            "f0e1d2c3-0000-4000-8000-000000000000:resolve",
            "rename.v2",
            "A-Z_9",
            "..",
        ] {
            assert!(is_valid_operation_id(id), "{id} must be valid");
            assert_eq!(accept_operation_id(Some(id)).unwrap().as_deref(), Some(id));
        }
    }

    #[test]
    fn missing_and_blank_ids_mean_absent_not_invalid() {
        assert_eq!(accept_operation_id(None), Ok(None));
        assert_eq!(accept_operation_id(Some("")), Ok(None));
        assert_eq!(accept_operation_id(Some("   ")), Ok(None));
        assert_eq!(accept_operation_id(Some("\t\r\n")), Ok(None));

        let generated = resolve_operation_id(None).unwrap();
        assert_eq!(generated.len(), 36);
        assert!(is_valid_operation_id(&generated));
    }

    #[test]
    fn overlong_ids_are_rejected() {
        let longest = "a".repeat(MAX_OPERATION_ID_LEN);
        assert!(is_valid_operation_id(&longest));
        assert_eq!(
            accept_operation_id(Some(&longest)).unwrap().as_deref(),
            Some(longest.as_str())
        );

        let too_long = "a".repeat(MAX_OPERATION_ID_LEN + 1);
        assert_eq!(
            accept_operation_id(Some(&too_long)).unwrap_err().kind,
            OperationIdErrorKind::TooLong
        );
        assert_rejected(&too_long);
    }

    #[test]
    fn whitespace_control_and_path_characters_are_rejected() {
        for value in [
            "abc def",
            " abc",
            "abc ",
            "abc\tdef",
            "abc\ndef",
            "abc\u{7f}def",
            "abc/def",
            "abc\\def",
            "abc?def",
            "abc*def",
            "abc%d",
        ] {
            assert_rejected(value);
        }
    }

    #[test]
    fn forbidden_characters_report_the_character() {
        let error = accept_operation_id(Some("abc def")).unwrap_err();
        assert_eq!(error.kind, OperationIdErrorKind::ForbiddenCharacter(' '));
        assert!(error.to_string().contains("' '"));
        let error = accept_operation_id(Some("abc/def")).unwrap_err();
        assert_eq!(error.kind, OperationIdErrorKind::ForbiddenCharacter('/'));
    }

    #[test]
    fn prefix_helper_falls_back_only_when_the_caller_gave_nothing() {
        assert_eq!(
            resolve_operation_prefix(Some("abc:retry1"), "resolve-preflight").unwrap(),
            "abc:retry1"
        );
        let generated = resolve_operation_prefix(None, "resolve-preflight").unwrap();
        assert!(generated.starts_with("resolve-preflight-"));
        assert!(is_valid_operation_id(&generated));
        assert!(resolve_operation_prefix(Some("bad id"), "resolve-preflight").is_err());
    }
}
