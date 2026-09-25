fn main() {
    // src/process_config.rs gives the commands the bucket runs this build's PATH (direnv, bun, uv).
    println!("cargo:rerun-if-env-changed=PATH");
    println!(
        "cargo:rustc-env=PDF_BUCKET_BUILD_PATH={}",
        std::env::var("PATH").expect("the build has a PATH")
    );
    tauri_build::build()
}
