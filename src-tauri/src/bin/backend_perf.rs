fn main() {
    if let Err(error) = p4deck_lib::backend_perf::run() {
        eprintln!("backend performance benchmark failed: {error}");
        std::process::exit(1);
    }
}
