fn main() {
    #[cfg(windows)]
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
    )
    .expect("failed to run Tauri build script");

    #[cfg(not(windows))]
    tauri_build::build();

    // `tauri_build` embeds the application manifest only in binary targets. The libtest harness
    // links the same Tauri/Windows dependencies, including TaskDialogIndirect, so every final
    // PE target also needs the Common Controls v6 dependency. Generate Tauri's default manifest
    // as a linker input for every target; the resource builder above deliberately omits its copy
    // so application and test targets each receive exactly one manifest.
    #[cfg(windows)]
    {
        let manifest = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"))
            .join("common-controls-v6.manifest");
        std::fs::write(
            &manifest,
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*" />
    </dependentAssembly>
  </dependency>
</assembly>
"#,
        )
        .expect("write Common Controls v6 manifest");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
}
