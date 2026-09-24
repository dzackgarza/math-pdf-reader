fn main() {
    // src/server.rs runs the bucket server with the PATH of this build (direnv, bun, uv).
    println!("cargo:rerun-if-env-changed=PATH");
    println!(
        "cargo:rustc-env=PDF_BUCKET_BUILD_PATH={}",
        std::env::var("PATH").expect("the build has a PATH")
    );
    tauri_build::build()
}
