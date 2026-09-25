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

// typify lays the types out as the schema reads; a variant that holds a whole stored item is
// larger than one that holds a key, and boxing it would make the generated types differ from
// the schema's shape.
#[expect(
    clippy::large_enum_variant,
    reason = "generated from the contract schema, whose variants differ in size"
)]
mod generated {
    include!(concat!(env!("OUT_DIR"), "/contract.rs"));
}

pub use generated::*;

/// The JSON Schema every contract type is generated from.
const SCHEMA: &str = include_str!(concat!(env!("OUT_DIR"), "/contract-schema.json"));

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

type Validators = std::collections::HashMap<&'static str, std::sync::Arc<jsonschema::Validator>>;

static VALIDATORS: std::sync::LazyLock<std::sync::Mutex<Validators>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(Validators::new()));

fn validator(def: &'static str) -> std::sync::Arc<jsonschema::Validator> {
    let mut validators = VALIDATORS.lock().expect("never poisoned");
    let entry = validators.entry(def).or_insert_with(|| {
        let mut schema: serde_json::Value =
            serde_json::from_str(SCHEMA).expect("the contract schema is JSON");
        schema["$ref"] = serde_json::Value::String(format!("#/$defs/{def}"));
        std::sync::Arc::new(
            jsonschema::options()
                .build(&schema)
                .expect("the contract schema compiles"),
        )
    });
    std::sync::Arc::clone(entry)
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
