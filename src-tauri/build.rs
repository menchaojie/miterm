fn main() {
    // 图标变更时强制重新嵌入资源（icon.ico / png）
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    tauri_build::build()
}
