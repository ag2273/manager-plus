//! Saving and opening the files the screens make and read (#97, note 4): Excel exports, the import
//! template and spreadsheets, and A4 pages as PDF. The screens build the bytes and the pages; this
//! side asks where, writes and reads, and prints a page to PDF in a hidden WebView2 window.

use std::path::{Path, PathBuf};

use manager_core::BusinessError;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

fn not_saved(error: impl std::fmt::Display) -> BusinessError {
    BusinessError::new("file_not_saved", error.to_string())
}

/// Where to save a file named `name`, asked in the save dialog; None when cancelled. The
/// end-to-end journeys answer the dialog with `MANAGER_PLUS_E2E_SAVE_DIR`.
fn save_path(
    app: &AppHandle,
    name: &str,
    filter: &str,
    extensions: &[String],
) -> Result<Option<PathBuf>, BusinessError> {
    if let Ok(dir) = std::env::var("MANAGER_PLUS_E2E_SAVE_DIR") {
        return Ok(Some(Path::new(&dir).join(name)));
    }
    let extensions: Vec<&str> = extensions.iter().map(String::as_str).collect();
    match app
        .dialog()
        .file()
        .add_filter(filter, &extensions)
        .set_file_name(name)
        .blocking_save_file()
    {
        None => Ok(None),
        Some(picked) => picked.into_path().map(Some).map_err(not_saved),
    }
}

/// Saves `bytes` where the user picks; the path, or None when cancelled.
pub fn save(
    app: &AppHandle,
    name: &str,
    filter: &str,
    extensions: &[String],
    bytes: &[u8],
) -> Result<Option<String>, BusinessError> {
    let Some(path) = save_path(app, name, filter, extensions)? else {
        return Ok(None);
    };
    std::fs::write(&path, bytes).map_err(not_saved)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// A file the user picks, by its name and bytes; None when cancelled. The end-to-end journeys
/// answer the dialog with `MANAGER_PLUS_E2E_OPEN`.
pub fn open(
    app: &AppHandle,
    filter: &str,
    extensions: &[String],
) -> Result<Option<(String, Vec<u8>)>, BusinessError> {
    let path = match std::env::var("MANAGER_PLUS_E2E_OPEN") {
        Ok(path) => PathBuf::from(path),
        Err(_) => {
            let extensions: Vec<&str> = extensions.iter().map(String::as_str).collect();
            match app
                .dialog()
                .file()
                .add_filter(filter, &extensions)
                .blocking_pick_file()
            {
                None => return Ok(None),
                Some(picked) => picked
                    .into_path()
                    .map_err(|e| BusinessError::new("file_unreadable", e.to_string()))?,
            }
        }
    };
    let bytes =
        std::fs::read(&path).map_err(|e| BusinessError::new("file_unreadable", e.to_string()))?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(Some((name, bytes)))
}

/// Saves the A4 page `html` as a PDF where the user picks; the path, or None when cancelled.
pub async fn save_pdf(
    app: &AppHandle,
    html: &str,
    name: &str,
) -> Result<Option<String>, BusinessError> {
    let Some(path) = save_path(app, name, "PDF", &["pdf".to_string()])? else {
        return Ok(None);
    };
    pdf::print(app, html, &path)
        .await
        .map_err(|e| BusinessError::new("pdf_failed", e))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(windows)]
mod pdf {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    use tauri::webview::PageLoadEvent;
    use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Controller, ICoreWebView2Environment6, ICoreWebView2_2, ICoreWebView2_7,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{Interface, HSTRING};

    static PAGES: AtomicUsize = AtomicUsize::new(0);

    /// Waits on `rx` off the async runtime's threads.
    async fn wait<T: Send + 'static>(rx: mpsc::Receiver<T>, seconds: u64) -> Option<T> {
        tauri::async_runtime::spawn_blocking(move || {
            rx.recv_timeout(Duration::from_secs(seconds)).ok()
        })
        .await
        .ok()
        .flatten()
    }

    /// Loads the page in a hidden window and has WebView2 print it to `target` on A4.
    pub async fn print(app: &AppHandle, html: &str, target: &Path) -> Result<(), String> {
        let n = PAGES.fetch_add(1, Ordering::Relaxed);
        let page =
            std::env::temp_dir().join(format!("manager-plus-a4-{}-{n}.html", std::process::id()));
        // The page is the screens' own drawing; scripts stay off in it.
        let html = html.replacen(
            "<style>",
            "<meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'none'\"><style>",
            1,
        );
        std::fs::write(&page, html).map_err(|e| e.to_string())?;
        let done = render(app, &page, target, n).await;
        let _ = std::fs::remove_file(&page);
        done
    }

    async fn render(app: &AppHandle, page: &Path, target: &Path, n: usize) -> Result<(), String> {
        let url = tauri::Url::from_file_path(page).map_err(|_| "bad page path".to_string())?;
        let (loaded, on_load) = mpsc::channel();
        let window =
            WebviewWindowBuilder::new(app, format!("a4-pdf-{n}"), WebviewUrl::External(url))
                .visible(false)
                .on_page_load(move |_, payload| {
                    if matches!(payload.event(), PageLoadEvent::Finished) {
                        let _ = loaded.send(());
                    }
                })
                .build()
                .map_err(|e| e.to_string())?;
        let printed = async {
            wait(on_load, 20).await.ok_or("the page did not load")?;
            // The embedded font is decoded after the load; give it a moment before printing.
            tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(300)))
                .await
                .ok();
            let (done, on_done) = mpsc::channel::<Result<(), String>>();
            let path = target.to_path_buf();
            window
                .with_webview(move |webview| {
                    let failed = done.clone();
                    // SAFETY: COM calls on the webview's own thread, where `with_webview` runs this.
                    if let Err(e) = unsafe { start(webview.controller(), &path, done) } {
                        let _ = failed.send(Err(e.to_string()));
                    }
                })
                .map_err(|e| e.to_string())?;
            wait(on_done, 60)
                .await
                .ok_or("the PDF was not written in time")?
        }
        .await;
        let _ = window.destroy();
        printed
    }

    unsafe fn start(
        controller: ICoreWebView2Controller,
        path: &PathBuf,
        done: mpsc::Sender<Result<(), String>>,
    ) -> windows::core::Result<()> {
        let core = controller.CoreWebView2()?;
        let environment = core.cast::<ICoreWebView2_2>()?.Environment()?;
        let settings = environment
            .cast::<ICoreWebView2Environment6>()?
            .CreatePrintSettings()?;
        // A4 in inches, with the page's own margins (14 mm by 12 mm).
        settings.SetPageWidth(8.27)?;
        settings.SetPageHeight(11.69)?;
        settings.SetMarginTop(0.55)?;
        settings.SetMarginBottom(0.55)?;
        settings.SetMarginLeft(0.47)?;
        settings.SetMarginRight(0.47)?;
        settings.SetShouldPrintBackgrounds(true)?;
        settings.SetShouldPrintHeaderAndFooter(false)?;
        let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, written| {
            let _ = done.send(match result {
                Ok(()) if written => Ok(()),
                Ok(()) => Err("WebView2 did not write the PDF".to_string()),
                Err(e) => Err(e.to_string()),
            });
            Ok(())
        }));
        core.cast::<ICoreWebView2_7>()?.PrintToPdf(
            &HSTRING::from(path.as_os_str()),
            &settings,
            &handler,
        )
    }
}

#[cfg(not(windows))]
mod pdf {
    use std::path::Path;
    use tauri::AppHandle;

    /// PDFs come from WebView2; the Linux build exists for the end-to-end journeys.
    pub async fn print(_app: &AppHandle, _html: &str, _target: &Path) -> Result<(), String> {
        Err("PDF export is made by WebView2, on Windows".to_string())
    }
}
