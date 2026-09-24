// Generates the contract types from the zod contracts in src/contract: scripts/contract-schema.ts
// prints their JSON Schema, and typify turns each definition into a Rust type in
// $OUT_DIR/contract.rs, which src/contract.rs includes. Every `format: date-time` string maps
// to `crate::contract::Timestamp`, which keeps the text it was given.
use std::path::Path;
use std::process::Command;

use schemars::schema::{InstanceType, RootSchema, SchemaObject, SingleOrVec};
use typify::{TypeSpace, TypeSpaceImpl, TypeSpaceSettings};

fn main() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
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
    let schema: RootSchema =
        serde_json::from_slice(&output.stdout).expect("the contract schema is JSON Schema");

    let date_time = SchemaObject {
        instance_type: Some(SingleOrVec::Single(Box::new(InstanceType::String))),
        format: Some("date-time".to_string()),
        ..SchemaObject::default()
    };
    let mut settings = TypeSpaceSettings::default();
    settings.with_struct_builder(false).with_conversion(
        date_time,
        "crate::contract::Timestamp",
        [TypeSpaceImpl::Display].into_iter(),
    );
    let mut space = TypeSpace::new(&settings);
    space
        .add_root_schema(schema)
        .expect("typify accepts the contract schema");
    let file = syn::parse2::<syn::File>(space.to_stream()).expect("typify emits Rust items");
    let out = Path::new(&std::env::var("OUT_DIR").expect("cargo sets OUT_DIR")).join("contract.rs");
    std::fs::write(out, prettyplease::unparse(&file)).expect("OUT_DIR is writable");
}
