// Generates the contract types from the zod contracts in src/contract: scripts/contract-schema.ts
// prints their JSON Schema, and typify turns each definition into a Rust type in
// $OUT_DIR/contract.rs, which src/contract.rs includes. Every `format: date-time` string maps
// to `crate::contract::Timestamp`, which keeps the text it was given; records are BTreeMaps, so
// a document is written in key order.
//
// typify types what JSON Schema can type and drops the rest (array `minItems`, number bounds;
// typify-impl's convert_array and convert_number, oxidecomputer/typify#169), so the schema
// itself is written to $OUT_DIR/contract-schema.json, and src/contract.rs checks every document
// against it before typing it. Constants the server needs from the contract are read out of the
// same schema here.
use std::path::Path;
use std::process::Command;

use schemars::schema::{InstanceType, RootSchema, SchemaObject, SingleOrVec};
use typify::{TypeSpace, TypeSpaceImpl, TypeSpaceSettings};

fn main() {
    // The checkout this crate lies in, as config::CHECKOUT names it at run time.
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .canonicalize()
        .expect("the crate lies in a checkout");
    println!("cargo:rustc-env=PDF_BUCKET_CHECKOUT={}", repo.display());
    println!("cargo:rerun-if-changed=../src/contract");
    println!("cargo:rerun-if-changed=../scripts/contract-schema.ts");
    let output = Command::new("bun")
        .arg(repo.join("scripts/contract-schema.ts"))
        .current_dir(&repo)
        .output()
        .expect("bun runs scripts/contract-schema.ts");
    assert!(
        output.status.success(),
        "scripts/contract-schema.ts failed ({}):\n{}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    let out_dir = std::env::var("OUT_DIR").expect("cargo sets OUT_DIR");
    let out = Path::new(&out_dir);
    std::fs::write(out.join("contract-schema.json"), &output.stdout).expect("OUT_DIR is writable");
    let document: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("the contract schema is JSON");
    let schema: RootSchema =
        serde_json::from_value(document.clone()).expect("the contract schema is JSON Schema");

    let date_time = SchemaObject {
        instance_type: Some(SingleOrVec::Single(Box::new(InstanceType::String))),
        format: Some("date-time".to_string()),
        ..SchemaObject::default()
    };
    let mut settings = TypeSpaceSettings::default();
    settings
        .with_struct_builder(false)
        .with_map_type("::std::collections::BTreeMap")
        .with_derive("PartialEq".to_string())
        .with_conversion(
            date_time,
            "crate::contract::Timestamp",
            [TypeSpaceImpl::Display].into_iter(),
        );
    let mut space = TypeSpace::new(&settings);
    space
        .add_root_schema(schema)
        .expect("typify accepts the contract schema");
    let file = syn::parse2::<syn::File>(space.to_stream()).expect("typify emits Rust items");
    let mut types = prettyplease::unparse(&file);

    // The seconds a page must be read to count in a reading session: the `minimum` of a reported
    // page's seconds (MIN_PAGE_SECONDS in src/contract/library.ts).
    let min_page_seconds = document
        .pointer("/$defs/ReadingSessionReport/properties/pages/items/properties/seconds/minimum")
        .and_then(serde_json::Value::as_f64)
        .expect("a reported page's seconds have a minimum");
    types.push_str(&format!(
        "\npub const MIN_PAGE_SECONDS: f64 = {min_page_seconds:?};\n"
    ));
    std::fs::write(out.join("contract.rs"), types).expect("OUT_DIR is writable");
}
