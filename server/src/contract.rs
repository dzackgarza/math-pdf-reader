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

mod generated {
    include!(concat!(env!("OUT_DIR"), "/contract.rs"));
}

pub use generated::*;

/// A contract type read from JSON: `DEF` names its definition under `$defs` in the schema.
pub trait Contract: serde::de::DeserializeOwned {
    const DEF: &'static str;
}

macro_rules! contract_types {
    ($($name:ident),* $(,)?) => {
        $(impl Contract for $name {
            const DEF: &'static str = stringify!($name);
        })*
    };
}

// The documents the server reads: request bodies and the files beside the stored PDFs.
contract_types!(
    BulkCollectionsRequest,
    BulkTagsRequest,
    CollectionUpdateRequest,
    FolderImportRequest,
    ImportUrlRequest,
    IndexExport,
    MirrorRequest,
    NewCollectionRequest,
    NewSavedSearchRequest,
    NoteRequest,
    Organization,
    PreferencesUpdateRequest,
    ReadingRequest,
    ReadingSessionReport,
    RemovedKeys,
    SavedSearchUpdateRequest,
    Sessions,
);

/// The validator of the definition DEF: the whole contract schema, entered at `#/$defs/DEF`.
fn validator(def: &str) -> jsonschema::Validator {
    let mut schema: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("OUT_DIR"),
        "/contract-schema.json"
    )))
    .expect("the contract schema is JSON");
    schema["$ref"] = serde_json::Value::String(format!("#/$defs/{def}"));
    jsonschema::options()
        .build(&schema)
        .expect("the contract schema compiles")
}

/// Why a document is not the contract type it should be: its first violation of the schema.
#[derive(Debug)]
pub struct ContractViolation(String);

impl fmt::Display for ContractViolation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// TEXT as the contract type T: checked against every constraint of T's schema (including those
/// typify cannot type, such as `minItems`, `minimum` and `minProperties`), then typed.
pub fn from_json<T: Contract>(text: &[u8]) -> Result<T, ContractViolation> {
    let value: serde_json::Value =
        serde_json::from_slice(text).map_err(|error| ContractViolation(error.to_string()))?;
    if let Err(error) = validator(T::DEF).validate(&value) {
        return Err(ContractViolation(format!(
            "{} at {}: {error}",
            T::DEF,
            error.instance_path()
        )));
    }
    serde_json::from_value(value).map_err(|error| ContractViolation(error.to_string()))
}
