//! Credential boundary shared by the runner, persistence and diagnostic export.
//!
//! The generic runner must never execute authentication-secret commands. Output is
//! redacted before it becomes an event, result, log record, journal record or export.

use regex::{Captures, Regex};
use serde_json::Value;
use std::sync::OnceLock;
use thiserror::Error;

pub const REDACTED: &str = "[REDACTED]";
pub const TERMINAL_RECOVERY: &str =
    "Credential-sensitive P4 commands are blocked in Terminal; use Settings > Connection authentication.";

#[derive(Debug, Error, Eq, PartialEq)]
pub enum CredentialPolicyError {
    #[error("{TERMINAL_RECOVERY}")]
    ControlledAuthenticationRequired,
    #[error("Password and ticket arguments are forbidden in the generic P4 runner.")]
    SecretArgument,
    #[error("Generic P4 commands cannot receive credential input on stdin.")]
    SecretInput,
}

/// Holds explicit secrets only for the lifetime of one command. Intentionally not
/// Clone, Debug, Serialize or Deserialize.
pub struct CredentialRedactor {
    known_secrets: Vec<String>,
}

#[derive(Default)]
pub struct RedactionState {
    redact_next_line: bool,
}

impl CredentialRedactor {
    pub fn for_command(command: &str, args: &[String], input: Option<&str>) -> Self {
        let mut known_secrets = Vec::new();
        collect_token_secrets(command, args, &mut known_secrets);
        if let Some(input) = input {
            collect_labeled_values(input, &mut known_secrets);
        }
        known_secrets.sort_by_key(|value| std::cmp::Reverse(value.len()));
        known_secrets.dedup();
        Self { known_secrets }
    }

    pub fn redact(&self, value: &str) -> String {
        let mut result = redact_structured_or_text(value);
        for secret in &self.known_secrets {
            if secret.len() >= 4 {
                result = result.replace(secret, REDACTED);
            }
        }
        result
    }

    pub fn redact_line(&self, value: &str, state: &mut RedactionState) -> String {
        if state.redact_next_line {
            state.redact_next_line = false;
            return REDACTED.into();
        }
        let trimmed = value.trim();
        if credential_label_only(trimmed) {
            state.redact_next_line = true;
            return value.to_owned();
        }
        self.redact(value)
    }
}

pub fn validate_generic_command(
    command: &str,
    args: &[String],
    input: Option<&str>,
    argument_input: Option<&[String]>,
) -> Result<(), CredentialPolicyError> {
    let mut tokens = Vec::with_capacity(args.len() + 1);
    tokens.push(command);
    tokens.extend(args.iter().map(String::as_str));

    if contains_secret_option(&tokens) {
        return Err(CredentialPolicyError::SecretArgument);
    }
    let rendered = tokens.join(" ");
    if credential_value().is_match(&rendered) || bearer().is_match(&rendered) {
        return Err(CredentialPolicyError::SecretArgument);
    }
    if input.is_some_and(contains_credential_material)
        || argument_input.is_some_and(|values| {
            values
                .iter()
                .any(|value| contains_credential_material(value))
        })
    {
        return Err(CredentialPolicyError::SecretInput);
    }

    if effective_command(&tokens).is_some_and(is_controlled_command) {
        return Err(CredentialPolicyError::ControlledAuthenticationRequired);
    }
    Ok(())
}

pub fn redact_text(value: &str) -> String {
    CredentialRedactor::for_command("", &[], None).redact(value)
}

pub fn redact_command(command: &str, args: &[String]) -> String {
    let redactor = CredentialRedactor::for_command(command, args, None);
    let rendered = std::iter::once(command)
        .chain(args.iter().map(String::as_str))
        .map(|token| shellish_token(&redactor.redact(token)))
        .collect::<Vec<_>>()
        .join(" ");
    format!("p4 {rendered}").trim().to_owned()
}

pub fn contains_credential_material(value: &str) -> bool {
    if credential_value().is_match(value)
        || bearer().is_match(value)
        || p4_password_option().is_match(value)
    {
        return true;
    }
    let mut lines = value.lines();
    while let Some(line) = lines.next() {
        if credential_label_only(line.trim())
            && lines.next().is_some_and(|next| !next.trim().is_empty())
        {
            return true;
        }
    }
    false
}

fn is_controlled_command(command: &str) -> bool {
    matches!(
        command.to_ascii_lowercase().as_str(),
        "login" | "login2" | "logout" | "trust" | "tickets" | "passwd" | "set" | "configure"
    )
}

fn effective_command<'a>(tokens: &'a [&'a str]) -> Option<&'a str> {
    let mut index = usize::from(
        tokens
            .first()
            .is_some_and(|value| value.eq_ignore_ascii_case("p4")),
    );
    while index < tokens.len() {
        let token = trim_quotes(tokens[index]);
        if token.is_empty() {
            index += 1;
            continue;
        }
        if !token.starts_with('-') && !looks_like_assignment(token) {
            return Some(token);
        }
        if global_option_takes_value(token) && !global_option_has_attached_value(token) {
            index += 2;
        } else {
            index += 1;
        }
    }
    None
}

fn global_option_takes_value(token: &str) -> bool {
    matches!(
        token,
        "-p" | "-u" | "-c" | "-C" | "-d" | "-H" | "-L" | "-P" | "-x"
    ) || matches!(
        token.to_ascii_lowercase().as_str(),
        "--port"
            | "--user"
            | "--client"
            | "--charset"
            | "--directory"
            | "--host"
            | "--password"
            | "--tickets"
    )
}

fn global_option_has_attached_value(token: &str) -> bool {
    (token.starts_with("-P") && token.len() > 2)
        || token.starts_with("--password=")
        || token.starts_with("--tickets=")
}

fn contains_secret_option(tokens: &[&str]) -> bool {
    tokens.iter().enumerate().any(|(index, raw)| {
        let token = trim_quotes(raw);
        token == "-P"
            || (token.starts_with("-P") && token.len() > 2)
            || token.to_ascii_lowercase().starts_with("--password")
            || token.to_ascii_lowercase().starts_with("--ticket")
            || is_secret_assignment(token)
            || (index > 0
                && matches!(
                    trim_quotes(tokens[index - 1]).to_ascii_lowercase().as_str(),
                    "--password" | "--ticket" | "--tickets"
                ))
    })
}

fn looks_like_assignment(value: &str) -> bool {
    value.contains('=') && !value.starts_with('=')
}

fn is_secret_assignment(value: &str) -> bool {
    let Some((name, _)) = value.split_once('=') else {
        return false;
    };
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "p4passwd" | "p4tickets" | "password" | "passwd" | "ticket" | "authorization"
    )
}

fn collect_token_secrets(command: &str, args: &[String], output: &mut Vec<String>) {
    let tokens = std::iter::once(command)
        .chain(args.iter().map(String::as_str))
        .collect::<Vec<_>>();
    for (index, raw) in tokens.iter().enumerate() {
        let token = trim_quotes(raw);
        if token == "-P" {
            if let Some(value) = tokens.get(index + 1).map(|value| trim_quotes(value)) {
                push_secret(output, value);
            }
        } else if token.starts_with("-P") && token.len() > 2 {
            push_secret(output, &token[2..]);
        } else if let Some((name, value)) = token.split_once('=') {
            if is_sensitive_key(name) {
                push_secret(output, trim_quotes(value));
            }
        }
        let label = token.trim_end_matches([':', '=']);
        if is_sensitive_key(label) {
            if label.eq_ignore_ascii_case("authorization")
                && tokens
                    .get(index + 1)
                    .is_some_and(|value| trim_quotes(value).eq_ignore_ascii_case("bearer"))
            {
                if let Some(value) = tokens.get(index + 2).map(|value| trim_quotes(value)) {
                    push_secret(output, value);
                }
            } else if let Some(value) = tokens.get(index + 1).map(|value| trim_quotes(value)) {
                push_secret(output, value);
            }
        } else if token.eq_ignore_ascii_case("bearer") {
            if let Some(value) = tokens.get(index + 1).map(|value| trim_quotes(value)) {
                push_secret(output, value);
            }
        }
    }
}

fn collect_labeled_values(value: &str, output: &mut Vec<String>) {
    for captures in credential_value().captures_iter(value) {
        if let Some(value) = captures.name("value") {
            push_secret(output, value.as_str().trim_matches(['\"', '\'', ',', ';']));
        }
    }
    for captures in bearer().captures_iter(value) {
        if let Some(value) = captures.name("value") {
            push_secret(output, value.as_str().trim_matches(['\"', '\'', ',', ';']));
        }
    }
}

fn push_secret(output: &mut Vec<String>, value: &str) {
    if !value.is_empty() && value != REDACTED {
        output.push(value.to_owned());
    }
}

fn redact_structured_or_text(value: &str) -> String {
    if let Ok(mut json) = serde_json::from_str::<Value>(value) {
        redact_json(&mut json);
        return serde_json::to_string(&json).unwrap_or_else(|_| redact_plain(value));
    }
    redact_plain(value)
}

fn redact_json(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                if is_sensitive_key(key) {
                    *value = Value::String(REDACTED.into());
                } else {
                    redact_json(value);
                }
            }
        }
        Value::Array(values) => values.iter_mut().for_each(redact_json),
        Value::String(value) => *value = redact_plain(value),
        _ => {}
    }
}

fn redact_plain(value: &str) -> String {
    let with_option = p4_password_option()
        .replace_all(value, |captures: &Captures<'_>| {
            format!("{}{REDACTED}", &captures["prefix"])
        })
        .into_owned();
    let with_bearer = bearer()
        .replace_all(&with_option, |captures: &Captures<'_>| {
            format!("{}{REDACTED}", &captures["prefix"])
        })
        .into_owned();
    credential_value()
        .replace_all(&with_bearer, |captures: &Captures<'_>| {
            format!("{}{REDACTED}", &captures["prefix"])
        })
        .into_owned()
}

fn p4_password_option() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?P<prefix>(?:^|\s)-P(?:\s+)?)(?P<value>\"[^\"]*\"|'[^']*'|[^\s,;}\]]+)"#)
            .expect("P4 password option regex")
    })
}

fn credential_label_only(value: &str) -> bool {
    let normalized = value
        .trim_end_matches([':', '='])
        .trim()
        .to_ascii_lowercase();
    is_sensitive_key(&normalized) || normalized == "ticket value"
}

fn is_sensitive_key(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "ticket"
            | "ticketvalue"
            | "ticket_value"
            | "password"
            | "passwd"
            | "p4passwd"
            | "p4tickets"
            | "authorization"
            | "auth"
            | "access_token"
            | "accesstoken"
    )
}

fn trim_quotes(value: &str) -> &str {
    value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .or_else(|| {
            value
                .strip_prefix('\'')
                .and_then(|value| value.strip_suffix('\''))
        })
        .unwrap_or(value)
}

fn shellish_token(value: &str) -> String {
    if value.chars().any(char::is_whitespace) {
        format!("\"{}\"", value.replace('"', "\\\""))
    } else {
        value.to_owned()
    }
}

fn credential_value() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"(?i)(?P<prefix>\b(?:p4passwd|p4tickets|password|passwd|authorization)\b\s*(?::|=)\s*|\bticket\b\s*(?::|=)\s*|\bticket\s+value\s*(?::|=|\s)\s*)(?P<value>\"[^\"]*\"|'[^']*'|[^\s,;}\]]+)"#,
        )
        .expect("credential value regex")
    })
}

fn bearer() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"(?i)(?P<prefix>\bauthorization\b\s*(?::|=)\s*bearer\s+|\bbearer\s+)(?P<value>\"[^\"]*\"|'[^']*'|[^\s,;}\]]+)"#,
        )
        .expect("bearer regex")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SENTINEL: &str = "P4DECK_SECRET_7f8bda9c";

    #[test]
    fn blocks_auth_commands_and_hidden_global_variants() {
        for (command, args) in [
            ("tickets", vec![]),
            ("PASSWD", vec![]),
            ("LoGiN", vec![]),
            ("login2", vec![]),
            ("-p", vec!["ssl:host:1666", "tickets"]),
            ("--port", vec!["ssl:host:1666", "logout"]),
            ("configure", vec!["show"]),
            ("set", vec![]),
        ] {
            assert_eq!(
                validate_generic_command(
                    command,
                    &args.into_iter().map(str::to_owned).collect::<Vec<_>>(),
                    None,
                    None,
                ),
                Err(CredentialPolicyError::ControlledAuthenticationRequired)
            );
        }
    }

    #[test]
    fn blocks_secret_argument_and_input_forms_without_echoing_values() {
        for args in [
            vec!["-P".to_owned(), SENTINEL.to_owned()],
            vec![format!("-P{SENTINEL}")],
            vec![format!("P4PASSWD={SENTINEL}")],
            vec![format!("p4tickets={SENTINEL}")],
            vec!["--password".to_owned(), SENTINEL.to_owned()],
        ] {
            let error = validate_generic_command("info", &args, None, None).unwrap_err();
            assert!(!error.to_string().contains(SENTINEL));
        }
        let input = format!("Password: {SENTINEL}");
        assert_eq!(
            validate_generic_command("info", &[], Some(&input), None),
            Err(CredentialPolicyError::SecretInput)
        );
        let argument_input = vec![format!("Authorization: Bearer {SENTINEL}")];
        assert_eq!(
            validate_generic_command("files", &[], None, Some(&argument_input)),
            Err(CredentialPolicyError::SecretInput)
        );
        assert!(validate_generic_command(
            "change",
            &["-i".into()],
            Some("Description:\n\tFix ticket expiry diagnostics\n"),
            None,
        )
        .is_ok());
    }

    #[test]
    fn redacts_contextual_multiline_json_bearer_and_known_values() {
        let args = vec!["-P".into(), SENTINEL.into()];
        let redactor = CredentialRedactor::for_command("info", &args, None);
        let source = format!(
            "Ticket: {SENTINEL}\nticket={SENTINEL}\nTicket value {SENTINEL}\nP4PASSWD={SENTINEL}\nP4TICKETS=C:\\\\secret\\tickets\npassword: {SENTINEL}\npasswd={SENTINEL}\nAuthorization: Bearer {SENTINEL}\nBearer {SENTINEL}"
        );
        let redacted = redactor.redact(&source);
        assert!(!redacted.contains(SENTINEL));
        assert!(!redacted.contains("C:\\\\secret"));
        assert!(redacted.matches(REDACTED).count() >= 9);

        let json = format!(
            r#"{{"ticket":"{SENTINEL}","nested":{{"password":"{SENTINEL}"}},"digest":"0123456789abcdef0123456789abcdef"}}"#
        );
        let redacted = redactor.redact(&json);
        assert!(!redacted.contains(SENTINEL));
        assert!(redacted.contains("0123456789abcdef0123456789abcdef"));

        let mut state = RedactionState::default();
        assert_eq!(redactor.redact_line("Password:", &mut state), "Password:");
        assert_eq!(redactor.redact_line(SENTINEL, &mut state), REDACTED);
    }

    #[test]
    fn keeps_normal_commands_and_digest_output() {
        for command in ["info", "files", "changes"] {
            assert!(validate_generic_command(command, &[], None, None).is_ok());
        }
        let digest = "0123456789abcdef0123456789abcdef";
        assert_eq!(redact_text(digest), digest);
    }
}
