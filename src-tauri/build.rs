fn main() {
    // 图标变更时强制重新嵌入资源（icon.ico / png）
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=resources/miterm-agent");
    // 开发时若 agent/dist 有更新，同步到 resources（不覆盖为必需）
    let dist = std::path::Path::new("../agent/dist/miterm-agent-linux-x86_64");
    let dest = std::path::Path::new("resources/miterm-agent/miterm-agent-linux-x86_64");
    if dist.is_file() {
        let _ = std::fs::create_dir_all("resources/miterm-agent");
        let _ = std::fs::copy(dist, dest);
    }
    tauri_build::build()
}
