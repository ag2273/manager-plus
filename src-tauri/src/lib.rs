//! The Manager+ window. The screens call `desktop(channel, args)`, the Tauri side of the
//! `DesktopApi` in `shared/api.ts`; every business rule is in `manager-core`.

mod desktop;
mod printing;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(desktop::State::default())
        .invoke_handler(tauri::generate_handler![desktop::desktop])
        .setup(|app| {
            // The lock stays fresh and the daily backup runs while the app is open.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(5 * 60));
                handle.state::<desktop::State>().tick();
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the Manager+ window opens")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<desktop::State>().release();
            }
        });
}
