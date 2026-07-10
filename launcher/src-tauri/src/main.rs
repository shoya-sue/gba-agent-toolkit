// GBA Agent Launcher ― Tauri v2 バックエンド
//
// 「ROM 選択 → Start」で mGBA + bridge.lua + MCP 疎通を一括起動する。
// 実オーケストレーションは launcher/start-session.sh に委譲し、
// Rust コマンドはその実行・結果パース・設定永続化を担う。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone)]
struct Config {
    rom_path: String,
    port: String,
    bind: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            rom_path: String::new(),
            port: "8765".into(),
            bind: "127.0.0.1".into(),
        }
    }
}

/// リソース（スクリプト・bridge.lua）を解決する。
/// 配布バンドルでは Tauri resources（`<App>.app/Contents/Resources/`）から、
/// 開発実行では `CARGO_MANIFEST_DIR/..`(=launcher/) 起点で解決する。
///   bundled_rel: バンドル Resources 内の相対パス（例 "scripts/start-session.sh"）
///   dev_rel    : launcher/ からの相対パス（例 "start-session.sh"）
fn resolve_resource(app: &tauri::AppHandle, bundled_rel: &str, dev_rel: &str) -> PathBuf {
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join(bundled_rel);
        if p.exists() {
            return p;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join(dev_rel)
}

fn config_dir() -> PathBuf {
    let base = std::env::var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".config")
        });
    base.join("gba-agent-toolkit")
}

fn config_path() -> PathBuf {
    config_dir().join("launcher.json")
}

/// 同梱 bridge.lua / json.lua を **スペースを含まない**作業ディレクトリへ複製し、
/// 複製した bridge.lua のパスを返す。
/// 理由: mGBA の Lua が `require("json")` を解決する際、バンドルパス
/// （`.../GBA Agent Launcher.app/...`）に含まれる空白でロードが破綻するため、
/// `~/.config/gba-agent-toolkit/mgba-bridge/`（空白なし）へ退避してから読み込ませる。
fn stage_bridge(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let src_bridge = resolve_resource(app, "mgba-bridge/bridge.lua", "../mcp-server/mgba-bridge/bridge.lua");
    if !src_bridge.exists() {
        return Err(format!("bridge.lua が見つかりません: {}", src_bridge.display()));
    }
    let src_json = resolve_resource(app, "mgba-bridge/json.lua", "../mcp-server/mgba-bridge/json.lua");
    let dest_dir = config_dir().join("mgba-bridge");
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    std::fs::copy(&src_bridge, dest_dir.join("bridge.lua")).map_err(|e| e.to_string())?;
    if src_json.exists() {
        // bridge.lua は同フォルダの json.lua を require するため必ず同居させる
        std::fs::copy(&src_json, dest_dir.join("json.lua")).map_err(|e| e.to_string())?;
    }
    Ok(dest_dir.join("bridge.lua"))
}

/// macOS ネイティブのファイル選択ダイアログ（プラグイン不要・osascript）。
#[tauri::command]
fn pick_rom() -> Result<String, String> {
    let script = r#"try
  set f to choose file with prompt "GBA/GB/GBC ROM を選択"
  return POSIX path of f
on error
  return ""
end try"#;
    let out = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| e.to_string())?;
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if p.is_empty() {
        Err("キャンセルされました".into())
    } else {
        Ok(p)
    }
}

/// Start 一発: start-session.sh を実行し RESULT 行で成否を判定。
#[tauri::command]
fn start_session(
    app: tauri::AppHandle,
    rom: String,
    port: String,
    bind: String,
) -> Result<String, String> {
    let script = resolve_resource(&app, "scripts/start-session.sh", "start-session.sh");
    // bridge.lua を空白なしパスへ退避（バンドルパスの空白による Lua ロード破綻を回避）
    let bridge = stage_bridge(&app)?;
    let out = Command::new("bash")
        .arg(&script)
        .arg("--rom")
        .arg(&rom)
        .arg("--port")
        .arg(&port)
        .arg("--bind")
        .arg(&bind)
        .arg("--bridge")
        .arg(&bridge)
        .output()
        .map_err(|e| format!("start-session.sh 実行失敗: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    let last = stdout.lines().last().unwrap_or("").trim().to_string();
    if last.starts_with("RESULT: OK") {
        Ok(format!("{last}\n\n{}", stderr.trim()))
    } else {
        let head = if last.is_empty() { stderr.trim().to_string() } else { last };
        Err(format!("{head}\n\n{}", stderr.trim()))
    }
}

/// セッション停止: mGBA を終了（bridge も停止）。
#[tauri::command]
fn stop_session(app: tauri::AppHandle) -> Result<String, String> {
    let script = resolve_resource(&app, "scripts/stop-session.sh", "stop-session.sh");
    let out = Command::new("bash")
        .arg(&script)
        .output()
        .map_err(|e| format!("stop-session.sh 実行失敗: {e}"))?;
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .last()
        .unwrap_or("")
        .trim()
        .to_string())
}

#[tauri::command]
fn load_config() -> Config {
    std::fs::read_to_string(config_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn save_config(config: Config) -> Result<(), String> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(config_path(), json).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            pick_rom,
            start_session,
            stop_session,
            load_config,
            save_config
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
