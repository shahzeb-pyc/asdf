//! Pure validators shared by every handler (spec §7–§11).
//! No window, no I/O, no Tauri — unit-tested here and in CI.

use crate::errors::{BridgeError, BridgeResult};

/// http(s) only, no embedded userinfo. Mirrors the existing main.rs rule
/// (kept verbatim) and the TS `isCleanHttpUrl` helper.
pub fn is_clean_http_url(url: &str) -> bool {
    let (scheme, rest) = match url.split_once("://") {
        Some((s, r)) => (s, r),
        None => return false,
    };
    if scheme != "https" && scheme != "http" {
        return false;
    }
    let authority = rest.split('/').next().unwrap_or("");
    !(authority.is_empty() || authority.contains('@'))
}

pub fn validate_clean_http_url(url: &str) -> BridgeResult<()> {
    if is_clean_http_url(url) {
        Ok(())
    } else {
        Err(BridgeError::validation("URL must be http(s) without embedded credentials"))
    }
}

/// Host (no port) of a clean http URL, lowercased.
pub fn url_host(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let authority = rest.split('/').next()?;
    // IPv6 literals are bracketed: the host runs to ']', NOT to the first
    // ':' (splitting on ':' returns "[" and silently defeats the
    // private-host check for [::1] and other v6 literals).
    if let Some(bracketed) = authority.strip_prefix('[') {
        let end = bracketed.find(']')?;
        Some(bracketed[..end].to_ascii_lowercase())
    } else {
        Some(authority.split(':').next()?.to_ascii_lowercase())
    }
}

fn is_ipv4(s: &str) -> Option<[u8; 4]> {
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut out = [0u8; 4];
    for (i, p) in parts.iter().enumerate() {
        if p.is_empty() || p.len() > 3 || !p.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        out[i] = p.parse().ok()?;
    }
    Some(out)
}

/// True for localhost / private / loopback / link-local IP literals (v4; v6
/// loopback + unique-local + link-local are matched textually).
pub fn is_private_ip_literal(host: &str) -> bool {
    if host == "localhost" {
        return true;
    }
    if let Some(ip) = is_ipv4(host) {
        return ip[0] == 10
            || (ip[0] == 172 && (16..=31).contains(&ip[1]))
            || (ip[0] == 192 && ip[1] == 168)
            || ip[0] == 127
            || (ip[0] == 169 && ip[1] == 254)
            || (ip[0] == 0);
    }
    // IPv6 checks only apply to colon-containing hosts: without the guard,
    // a DNS name such as "fcloud.example.com" would false-positive on the
    // "fc" prefix.
    let h = host.trim_matches(|c| c == '[' || c == ']');
    h.contains(':') && (h == "::1" || h.starts_with("fc") || h.starts_with("fd") || h.starts_with("fe8") || h.starts_with("fe9") || h.starts_with("fea") || h.starts_with("feb"))
}

/// §9 URL rule: clean http(s) + not a private/loopback host.
pub fn validate_media_url(url: &str) -> BridgeResult<()> {
    if !is_clean_http_url(url) {
        return Err(BridgeError::media_url_invalid());
    }
    if let Some(host) = url_host(url) {
        if is_private_ip_literal(&host) {
            return Err(BridgeError::media_url_invalid());
        }
    }
    Ok(())
}

fn matches_pattern(value: &str, first_ok: impl Fn(char) -> bool, rest_ok: impl Fn(char) -> bool, min_len: usize, max_len: usize) -> bool {
    let mut chars = value.chars();
    let first = match chars.next() {
        Some(c) => c,
        None => return false,
    };
    if !first_ok(first) {
        return false;
    }
    if !chars.clone().all(&rest_ok) {
        return false;
    }
    let len = value.chars().count();
    len >= min_len && len <= max_len
}

/// `^[a-z0-9][a-z0-9-]{1,62}$` (subdomain, §5.2/§7.3).
pub fn is_valid_subdomain(value: &str) -> bool {
    matches_pattern(value, |c| c.is_ascii_lowercase() || c.is_ascii_digit(), |c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-', 2, 63)
}

/// `^[a-z][a-z0-9-]{1,31}$` (namespace + service/key names, §7.2/§8.3).
pub fn is_valid_name(value: &str) -> bool {
    matches_pattern(value, |c| c.is_ascii_lowercase(), |c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-', 2, 32)
}

/// Bare extension: `mp4`, not `.mp4`, not `*` (§7.4).
pub fn is_bare_extension(value: &str) -> bool {
    !value.is_empty() && value.len() <= 10 && value.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// Scoped relative path: never absolute (POSIX or Windows drive), never a
/// `..` segment (§7.4). Symlink escapes are checked separately in paths.rs.
pub fn is_safe_relative_path(value: &str) -> bool {
    if value.starts_with('/') || value.starts_with('\\') {
        return false;
    }
    if value.len() >= 2 && value.as_bytes()[1] == b':' && value.as_bytes()[0].is_ascii_alphabetic() {
        return false;
    }
    !value.split(['/', '\\']).any(|seg| seg == "..")
}

pub fn validate_relative_path(value: &str) -> BridgeResult<()> {
    if is_safe_relative_path(value) {
        Ok(())
    } else {
        Err(BridgeError::validation("relativePath must not be absolute or contain \"..\""))
    }
}

/// Env-key allowlist (§7.5): `^[A-Z][A-Z0-9_]+$`, not PATH/LD_*/DYLD_*, not
/// secret-like names.
pub fn is_allowed_env_key(key: &str) -> bool {
    if key.is_empty() || !key.chars().next().unwrap().is_ascii_uppercase() {
        return false;
    }
    if !key.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_') {
        return false;
    }
    if key == "PATH" || key.starts_with("LD_") || key.starts_with("DYLD_") {
        return false;
    }
    if key.ends_with("_KEY") || key.ends_with("_TOKEN") || key.contains("_SECRET") {
        return false;
    }
    true
}

pub fn validate_env(env: &std::collections::HashMap<String, String>) -> BridgeResult<()> {
    for key in env.keys() {
        if !is_allowed_env_key(key) {
            return Err(BridgeError::validation("env contains a forbidden key (PATH, LD_*, DYLD_*, or secret-like)"));
        }
    }
    Ok(())
}

/// `^[a-z]{2,3}(-[A-Z]{2})?$` language codes (§9 subtitles).
pub fn is_language_code(value: &str) -> bool {
    let (base, region) = match value.split_once('-') {
        Some((b, r)) => (b, Some(r)),
        None => (value, None),
    };
    if !(2..=3).contains(&base.len()) || !base.bytes().all(|b| b.is_ascii_lowercase()) {
        return false;
    }
    if let Some(r) = region {
        if r.len() != 2 || !r.bytes().all(|b| b.is_ascii_uppercase()) {
            return false;
        }
    }
    true
}

/// Model name `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` (§10.4).
pub fn is_valid_model(value: &str) -> bool {
    matches_pattern(
        value,
        |c| c.is_ascii_alphanumeric(),
        |c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-',
        1,
        128,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_validation_keeps_existing_behaviour() {
        assert!(is_clean_http_url("https://example.com"));
        assert!(is_clean_http_url("http://localhost:3000"));
        assert!(!is_clean_http_url("file:///etc/passwd"));
        assert!(!is_clean_http_url("javascript:alert(1)"));
        assert!(!is_clean_http_url("data:text/html,test"));
        assert!(!is_clean_http_url("https://user:password@example.com"));
        assert!(!is_clean_http_url("http://admin@localhost:3000"));
        assert!(!is_clean_http_url("https://"));
    }

    #[test]
    fn media_url_rejects_private_hosts() {
        assert!(validate_media_url("https://example.com/watch?v=1").is_ok());
        assert!(validate_media_url("http://127.0.0.1:8080/v").is_err());
        assert!(validate_media_url("http://10.0.0.5/v").is_err());
        assert!(validate_media_url("http://192.168.1.1/v").is_err());
        assert!(validate_media_url("http://172.16.0.9/v").is_err());
        assert!(validate_media_url("http://169.254.1.2/v").is_err());
        assert!(validate_media_url("http://localhost/v").is_err());
        assert!(validate_media_url("https://[::1]/v").is_err());
        assert!(validate_media_url("https://[::1]:8080/v").is_err());
        assert!(validate_media_url("https://[fd00::1]/v").is_err());
    }

    #[test]
    fn patterns() {
        assert!(is_valid_subdomain("acme"));
        assert!(is_valid_subdomain("a1"));
        assert!(!is_valid_subdomain("Bad_Sub!"));
        assert!(!is_valid_subdomain("a"));
        assert!(!is_valid_subdomain("-acme"));
        assert!(is_valid_name("nicheforge"));
        assert!(!is_valid_name("Bad NS"));
        assert!(is_bare_extension("mp4"));
        assert!(!is_bare_extension(".mp4"));
        assert!(!is_bare_extension("*"));
        assert!(is_safe_relative_path("clips/a.mp4"));
        assert!(!is_safe_relative_path("../escape"));
        assert!(!is_safe_relative_path("a/../../escape"));
        assert!(!is_safe_relative_path("/abs"));
        assert!(!is_safe_relative_path("C:\\abs"));
        assert!(is_allowed_env_key("FFMPEG_FLAGS"));
        assert!(!is_allowed_env_key("PATH"));
        assert!(!is_allowed_env_key("LD_PRELOAD"));
        assert!(!is_allowed_env_key("MY_TOKEN"));
        assert!(!is_allowed_env_key("MY_SECRET_KEY"));
        assert!(is_language_code("en"));
        assert!(is_language_code("pt-BR"));
        assert!(!is_language_code("english"));
        assert!(is_valid_model("gpt-4o-mini"));
        assert!(!is_valid_model("bad model!"));
    }
}
