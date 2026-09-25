//! The checks every state-changing request passes before its route runs, so that a web page
//! open in the user's browser cannot drive the bucket (send an item to Zotero and remove it,
//! delete it, rewrite its PDF):
//!
//! - It comes from the bucket's own pages, from the capture extension, or from a client that is
//!   not a browser. Browsers mark every request with `Sec-Fetch-Site` and `Origin`; a page on
//!   another site can make a POST but cannot forge those headers.
//! - Its body is in the type its route reads: the capture form as `multipart/form-data`, the
//!   reader's save as `application/pdf`, every other body as `application/json`. A page on
//!   another site can send a form or `text/plain` body without asking, but not these types.
use axum::body::{Body, HttpBody};
use axum::extract::{MatchedPath, Request};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use url::Url;

use crate::contract::ApiErrorErrorKind;
use crate::error::AppError;

/// The origins of browser extensions: the capture extension's background script posts captures
/// from one. Firefox gives each installation its own random extension origin, so the origin is
/// trusted by its scheme.
const EXTENSION_SCHEMES: [&str; 2] = ["chrome-extension", "moz-extension"];

fn header_text(headers: &HeaderMap, name: header::HeaderName) -> Option<&str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn from_extension(headers: &HeaderMap) -> bool {
    header_text(headers, header::ORIGIN)
        .and_then(|origin| Url::parse(origin).ok())
        .is_some_and(|origin| EXTENSION_SCHEMES.contains(&origin.scheme()))
}

/// Whether a state-changing request may come from where the browser says it comes from. The
/// decision is Go's `net/http.CrossOriginProtection.Check` (Go 1.25, src/net/http/csrf.go),
/// with extension origins as its trusted origins: `Sec-Fetch-Site` of `same-origin` or `none`
/// passes; any other value is cross-origin; without it (a browser older than 2023, or no
/// browser), a missing `Origin` passes and an `Origin` whose host and port are the `Host`
/// header's passes.
fn same_origin(headers: &HeaderMap) -> bool {
    let sec_fetch_site = header::HeaderName::from_static("sec-fetch-site");
    // A browser writes both headers as ASCII; one that is not text is not a browser's.
    let unreadable = [&sec_fetch_site, &header::ORIGIN]
        .into_iter()
        .any(|name| headers.get(name).is_some_and(|value| value.to_str().is_err()));
    if unreadable {
        return false;
    }
    match header_text(headers, sec_fetch_site) {
        Some("same-origin" | "none") => return true,
        Some(_) => return from_extension(headers),
        None => {}
    }
    let Some(origin) = header_text(headers, header::ORIGIN) else {
        return true;
    };
    let host = header_text(headers, header::HOST);
    let same_host = Url::parse(origin).ok().is_some_and(|origin| {
        let origin_host = match (origin.host_str(), origin.port()) {
            (Some(host), Some(port)) => format!("{host}:{port}"),
            (Some(host), None) => host.to_string(),
            (None, _) => return false,
        };
        host == Some(origin_host.as_str())
    });
    same_host || from_extension(headers)
}

/// The media type a route's body must have.
fn body_type(route: Option<&str>) -> &'static str {
    match route {
        Some("/capture-bytes") => "multipart/form-data",
        Some("/api/items/{key}/pdf") => "application/pdf",
        _ => "application/json",
    }
}

fn media_type(headers: &HeaderMap) -> Option<&str> {
    header_text(headers, header::CONTENT_TYPE)
        .and_then(|value| value.split(';').next())
        .map(str::trim)
}

pub async fn guard(request: Request<Body>, next: Next) -> Response {
    if matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    ) {
        return next.run(request).await;
    }
    let headers = request.headers();
    if !same_origin(headers) {
        return AppError::api(
            StatusCode::FORBIDDEN,
            ApiErrorErrorKind::CrossOriginRequest,
            format!(
                "{} {} came from another site ({})",
                request.method(),
                request.uri().path(),
                header_text(headers, header::ORIGIN).unwrap_or("no Origin header")
            ),
        )
        .into_response();
    }
    let has_body = request.body().size_hint().exact() != Some(0);
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(MatchedPath::as_str);
    let expected = body_type(route);
    let given = media_type(headers);
    if has_body && !given.is_some_and(|given| given.eq_ignore_ascii_case(expected)) {
        return AppError::api(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ApiErrorErrorKind::UnsupportedMediaType,
            format!(
                "{} {} takes a {expected} body, not {}",
                request.method(),
                request.uri().path(),
                given.unwrap_or("a body with no Content-Type")
            ),
        )
        .into_response();
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use axum::http::{HeaderMap, HeaderValue};

    use super::same_origin;

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(*name, HeaderValue::from_static(value));
        }
        map
    }

    #[test]
    fn requests_pass_by_fetch_metadata_or_by_origin_and_host() {
        assert!(same_origin(&headers(&[("sec-fetch-site", "same-origin")])));
        assert!(same_origin(&headers(&[("sec-fetch-site", "none")])));
        assert!(!same_origin(&headers(&[
            ("sec-fetch-site", "cross-site"),
            ("origin", "https://evil.example")
        ])));
        assert!(same_origin(&headers(&[
            ("sec-fetch-site", "cross-site"),
            ("origin", "moz-extension://6f1c2d3e-0000-4000-8000-000000000000")
        ])));
        assert!(same_origin(&headers(&[])));
        assert!(same_origin(&headers(&[
            ("origin", "http://127.0.0.1:43117"),
            ("host", "127.0.0.1:43117")
        ])));
        assert!(!same_origin(&headers(&[
            ("origin", "http://127.0.0.1:9999"),
            ("host", "127.0.0.1:43117")
        ])));
        assert!(!same_origin(&headers(&[
            ("origin", "null"),
            ("host", "127.0.0.1:43117")
        ])));
    }
}
