//! Per-user file association for .csv / .tsv (HKCU only, no admin rights).
//!
//! The app stays portable: nothing is registered until the user asks for it,
//! and `unregister` removes everything again. Windows does not let apps make
//! themselves the default silently, so after registering we open Windows'
//! own "How do you want to open this file?" dialog for the user to choose.

use std::{fs, path::PathBuf};

use winreg::{RegKey, enums::HKEY_CURRENT_USER};

use crate::tr;

const PROGID: &str = "CSVSSE.csv";
const APP_KEY: &str = r"Software\Classes\Applications\CSVSSE.exe";
const EXTS: [&str; 2] = [".csv", ".tsv"];
/// Icon shown on CSV files once CSVSSE is their default app.
const FILE_ICON: &[u8] = include_bytes!("../icons/csv-file.ico");

fn data_dir() -> Result<PathBuf, String> {
    let base = std::env::var_os("LOCALAPPDATA").ok_or_else(|| tr("LOCALAPPDATA が見つかりません", "LOCALAPPDATA not found").to_string())?;
    Ok(PathBuf::from(base).join("CSVSSE"))
}

fn exe() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| e.to_string())
}

fn open_command() -> Result<String, String> {
    Ok(format!("\"{}\" \"%1\"", exe()?.display()))
}

fn err(e: std::io::Error) -> String {
    format!("{}\n{e}", tr("レジストリを書き換えられませんでした。", "Could not write to the registry."))
}

/// True when the registration exists and points at this exe.
pub fn status() -> bool {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(k) = hkcu.open_subkey(format!(r"Software\Classes\{PROGID}\shell\open\command")) else {
        return false;
    };
    let cmd: String = k.get_value("").unwrap_or_default();
    open_command().map(|c| c.eq_ignore_ascii_case(&cmd)).unwrap_or(false)
}

pub fn register() -> Result<(), String> {
    let dir = data_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let icon = dir.join("csv-file.ico");
    fs::write(&icon, FILE_ICON).map_err(|e| e.to_string())?;
    let icon = icon.display().to_string();
    let command = open_command()?;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (prog, _) = hkcu.create_subkey(format!(r"Software\Classes\{PROGID}")).map_err(err)?;
    prog.set_value("", &tr("CSV ファイル", "CSV file")).map_err(err)?;
    prog.create_subkey("DefaultIcon").map_err(err)?.0.set_value("", &icon).map_err(err)?;
    prog.create_subkey(r"shell\open\command").map_err(err)?.0.set_value("", &command).map_err(err)?;

    // Listed in "Open with" for these extensions.
    for ext in EXTS {
        let (k, _) = hkcu.create_subkey(format!(r"Software\Classes\{ext}\OpenWithProgids")).map_err(err)?;
        k.set_value(PROGID, &"").map_err(err)?;
    }

    // Application entry, used when the user picks CSVSSE from the "Open with" list.
    let (app, _) = hkcu.create_subkey(APP_KEY).map_err(err)?;
    app.set_value("FriendlyAppName", &"CSVSSE").map_err(err)?;
    app.create_subkey("DefaultIcon").map_err(err)?.0.set_value("", &icon).map_err(err)?;
    app.create_subkey(r"shell\open\command").map_err(err)?.0.set_value("", &command).map_err(err)?;
    let (types, _) = app.create_subkey("SupportedTypes").map_err(err)?;
    for ext in EXTS {
        types.set_value(ext, &"").map_err(err)?;
    }

    notify_shell();
    Ok(())
}

pub fn unregister() -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let _ = hkcu.delete_subkey_all(format!(r"Software\Classes\{PROGID}"));
    let _ = hkcu.delete_subkey_all(APP_KEY);
    for ext in EXTS {
        if let Ok(k) = hkcu.open_subkey_with_flags(
            format!(r"Software\Classes\{ext}\OpenWithProgids"),
            winreg::enums::KEY_SET_VALUE,
        ) {
            let _ = k.delete_value(PROGID);
        }
    }
    if let Ok(dir) = data_dir() {
        let _ = fs::remove_dir_all(dir);
    }
    notify_shell();
    Ok(())
}

/// Opens Windows' "How do you want to open .csv files?" dialog.
pub fn choose_default() -> Result<(), String> {
    let dir = data_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let sample = dir.join("CSVSSE.csv");
    if !sample.exists() {
        fs::write(&sample, b"").map_err(|e| e.to_string())?;
    }
    std::process::Command::new("rundll32.exe")
        .arg("shell32.dll,OpenAs_RunDLL")
        .arg(&sample)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("{}\n{e}", tr("Windows の設定画面を開けませんでした。", "Could not open the Windows dialog.")))
}

/// Tells Explorer that associations changed so file icons refresh.
fn notify_shell() {
    use windows_sys::Win32::UI::Shell::{SHCNE_ASSOCCHANGED, SHCNF_IDLIST, SHChangeNotify};
    // SAFETY: documented call with null item pointers for SHCNE_ASSOCCHANGED.
    unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED as _, SHCNF_IDLIST, std::ptr::null(), std::ptr::null()) };
}
