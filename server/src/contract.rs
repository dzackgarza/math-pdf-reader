//! The API, store and file contracts, generated at build time from the zod contracts in
//! `src/contract` (see build.rs). The TypeScript library UI, the extension and the test suites
//! read the same schemas, so a contract changes in one place.
use std::fmt;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

/// An ISO 8601 date-time with an offset, kept as the text it was given, so a document written
/// back holds the same string it was read with.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Timestamp(String);

impl Timestamp {
    /// Now, in the form JavaScript's `Date.prototype.toISOString` writes (milliseconds, `Z`).
    pub fn now() -> Self {
        Self(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true))
    }

    pub fn instant(&self) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(&self.0)
            .expect("a Timestamp holds RFC 3339 text")
            .with_timezone(&Utc)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for Timestamp {
    type Error = chrono::ParseError;

    fn try_from(text: String) -> Result<Self, Self::Error> {
        DateTime::parse_from_rfc3339(&text)?;
        Ok(Self(text))
    }
}

impl From<Timestamp> for String {
    fn from(timestamp: Timestamp) -> Self {
        timestamp.0
    }
}

impl fmt::Display for Timestamp {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

include!(concat!(env!("OUT_DIR"), "/contract.rs"));
