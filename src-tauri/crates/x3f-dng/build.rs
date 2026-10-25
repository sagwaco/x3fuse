//! Build the vendored LibRaw 0.22.2 and the C ABI shim as one static library.

use std::{env, path::Path};

fn sources(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("LibRaw source directory") {
        let path = entry.expect("LibRaw source entry").path();
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().is_some_and(|e| e == "cpp") {
            out.push(path);
        }
    }
}

fn main() {
    let root = Path::new("libraw");
    let mut files = vec![Path::new("src/shim.cpp").to_path_buf()];
    sources(&root.join("src"), &mut files);
    files.sort();

    let mut build = cc::Build::new();
    build
        .cpp(true)
        .std("c++14")
        .include(root)
        .define("USE_ZLIB", None)
        .define("USE_JPEG", None)
        .define("LIBRAW_NODLL", None)
        .warnings(false)
        .files(&files);
    for var in ["DEP_Z_INCLUDE", "DEP_JPEG_INCLUDE"] {
        let paths = env::var_os(var).unwrap_or_else(|| panic!("{var} is not set"));
        for path in env::split_paths(&paths) {
            build.include(path);
        }
    }
    if env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        // LibRaw throws from libjpeg error callbacks through C frames, so
        // extern "C" calls may throw. cc adds no other /EH flag.
        build.flag("/EHs").flag("/EHc-").define("WIN32", None);
    }
    build.compile("x3fdng_libraw");

    println!("cargo:rerun-if-changed=src/shim.cpp");
    println!("cargo:rerun-if-changed=libraw");
}
