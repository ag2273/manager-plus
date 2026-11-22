//! The Manager+ window. The screens call `desktop(channel, args)`, the Tauri side of the
//! `DesktopApi` in `shared/api.ts`; every business rule is in `manager-core`.

mod desktop;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(desktop::State::default())
        .invoke_handler(tauri::generate_handler![desktop::desktop])
        .run(tauri::generate_context!())
        .expect("the Manager+ window opens");
}
