//! Moving a finished ESC/POS job to the receipt printer. The receipt itself is drawn by the
//! screens (see `src/renderer/src/tauri-print.ts`); this side only sends the bytes.

use std::io::Write;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use serde::Deserialize;

const NETWORK_TIMEOUT: Duration = Duration::from_secs(5);

/** The printer as the settings screen saves it (`PrinterSettings` in `shared/api.ts`). */
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Printer {
    None,
    #[serde(rename_all = "camelCase")]
    Windows {
        device_name: String,
    },
    Network {
        host: String,
        port: u16,
    },
}

/** Sends the job; the error is what the screens show under "printer_failed". */
pub fn send(printer: &Printer, bytes: &[u8]) -> Result<(), String> {
    match printer {
        Printer::None => Err("No receipt printer is set up".into()),
        Printer::Network { host, port } => send_to_network(host, *port, bytes),
        Printer::Windows { device_name } => send_to_windows(device_name, bytes),
    }
}

fn send_to_network(host: &str, port: u16, bytes: &[u8]) -> Result<(), String> {
    let address = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("Printer at {host}:{port}: {e}"))?
        .next()
        .ok_or_else(|| format!("Printer at {host}:{port} was not found"))?;
    let mut socket = TcpStream::connect_timeout(&address, NETWORK_TIMEOUT)
        .map_err(|e| format!("Printer at {host}:{port} did not answer: {e}"))?;
    socket
        .set_write_timeout(Some(NETWORK_TIMEOUT))
        .map_err(|e| e.to_string())?;
    socket
        .write_all(bytes)
        .and_then(|_| socket.flush())
        .map_err(|e| format!("Printer at {host}:{port}: {e}"))
}

#[cfg(not(windows))]
fn send_to_windows(device_name: &str, _bytes: &[u8]) -> Result<(), String> {
    Err(format!(
        "{device_name}: Windows printers print only on Windows"
    ))
}

/** Printers installed in Windows, for the settings screen. */
#[cfg(not(windows))]
pub fn installed() -> Vec<String> {
    Vec::new()
}

#[cfg(windows)]
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/** A RAW spooler job: the driver passes the ESC/POS bytes to the printer untouched. */
#[cfg(windows)]
fn send_to_windows(device_name: &str, bytes: &[u8]) -> Result<(), String> {
    use windows_sys::Win32::Graphics::Printing::{
        ClosePrinter, EndDocPrinter, EndPagePrinter, OpenPrinterW, StartDocPrinterW,
        StartPagePrinter, WritePrinter, DOC_INFO_1W, PRINTER_HANDLE,
    };
    let name = wide(device_name);
    let mut doc_name = wide("Manager+ receipt");
    let mut datatype = wide("RAW");
    let failed = |what: &str| {
        format!(
            "{device_name}: {what} ({})",
            std::io::Error::last_os_error()
        )
    };
    // SAFETY: every pointer is to a live, NUL-terminated buffer for the length of the call,
    // and the handle is closed on every path once it was opened.
    unsafe {
        let mut handle = PRINTER_HANDLE::default();
        if OpenPrinterW(name.as_ptr(), &mut handle, std::ptr::null()) == 0 {
            return Err(failed("the printer could not be opened"));
        }
        let info = DOC_INFO_1W {
            pDocName: doc_name.as_mut_ptr(),
            pOutputFile: std::ptr::null_mut(),
            pDatatype: datatype.as_mut_ptr(),
        };
        let result = if StartDocPrinterW(handle, 1, &info) == 0 {
            Err(failed("the print job could not start"))
        } else {
            let mut written = 0u32;
            let ok = StartPagePrinter(handle) != 0
                && WritePrinter(
                    handle,
                    bytes.as_ptr().cast(),
                    bytes.len() as u32,
                    &mut written,
                ) != 0
                && written as usize == bytes.len();
            let error = (!ok).then(|| failed("the receipt was not sent"));
            EndPagePrinter(handle);
            EndDocPrinter(handle);
            error.map_or(Ok(()), Err)
        };
        ClosePrinter(handle);
        result
    }
}

/** Printers installed in Windows (local and connected), for the settings screen. */
#[cfg(windows)]
pub fn installed() -> Vec<String> {
    use windows_sys::Win32::Graphics::Printing::{
        EnumPrintersW, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL, PRINTER_INFO_4W,
    };
    let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
    let (mut needed, mut count) = (0u32, 0u32);
    // SAFETY: the first call only asks for the size; the second fills a buffer of that size,
    // aligned for PRINTER_INFO_4W, and the names it points to live inside that buffer.
    unsafe {
        EnumPrintersW(
            flags,
            std::ptr::null(),
            4,
            std::ptr::null_mut(),
            0,
            &mut needed,
            &mut count,
        );
        if needed == 0 {
            return Vec::new();
        }
        let size = std::mem::size_of::<PRINTER_INFO_4W>();
        let mut buffer: Vec<PRINTER_INFO_4W> =
            vec![PRINTER_INFO_4W::default(); (needed as usize).div_ceil(size)];
        if EnumPrintersW(
            flags,
            std::ptr::null(),
            4,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
            &mut count,
        ) == 0
        {
            return Vec::new();
        }
        buffer[..count as usize]
            .iter()
            .filter(|p| !p.pPrinterName.is_null())
            .map(|p| {
                let mut len = 0;
                while *p.pPrinterName.add(len) != 0 {
                    len += 1;
                }
                String::from_utf16_lossy(std::slice::from_raw_parts(p.pPrinterName, len))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;

    #[test]
    fn a_network_printer_gets_the_job_byte_for_byte() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let got = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut all = Vec::new();
            socket.read_to_end(&mut all).unwrap();
            all
        });
        let job: Vec<u8> = (0..=255).cycle().take(100_000).collect();
        send(
            &Printer::Network {
                host: "127.0.0.1".into(),
                port,
            },
            &job,
        )
        .unwrap();
        assert_eq!(got.join().unwrap(), job);
    }

    #[test]
    fn printer_settings_read_as_the_screens_save_them() {
        let p: Printer = serde_json::from_str(
            r#"{"kind":"windows","deviceName":"XP-80C","autoPrint":true,"footer":""}"#,
        )
        .unwrap();
        assert!(matches!(p, Printer::Windows { device_name } if device_name == "XP-80C"));
        let p: Printer = serde_json::from_str(
            r#"{"kind":"network","host":"192.168.1.50","port":9100,"openDrawer":true,"autoPrint":false,"footer":"شكرًا"}"#,
        )
        .unwrap();
        assert!(matches!(p, Printer::Network { port: 9100, .. }));
        assert!(send(&Printer::None, b"x").is_err());
    }
}
