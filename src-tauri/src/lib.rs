use std::{
    borrow::Cow,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

use encoding_rs::{EncoderResult, Encoding, SHIFT_JIS, UTF_16BE, UTF_16LE};
use serde_json::{Value, json};
use tauri::{
    WebviewWindow,
    ipc::{InvokeBody, Request, Response},
};

#[cfg(windows)]
mod assoc;

/// Settings live next to the exe so the app stays portable.
const SETTINGS_FILE: &str = "csvsse.settings.json";
const UTF8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

// ---------------------------------------------------------------- language

/// UI language for messages sent from Rust. Set from the front end (set_language).
static JAPANESE: AtomicBool = AtomicBool::new(true);

/// Picks the Japanese or English variant of a message.
pub(crate) fn tr<'a>(ja: &'a str, en: &'a str) -> &'a str {
    if JAPANESE.load(Ordering::Relaxed) { ja } else { en }
}

/// "ja" when the Windows display language is Japanese, otherwise "en".
fn os_lang() -> &'static str {
    #[cfg(windows)]
    {
        // SAFETY: no arguments, returns a LANGID.
        let id = unsafe { windows_sys::Win32::Globalization::GetUserDefaultUILanguage() };
        const LANG_JAPANESE: u16 = 0x11;
        if id & 0x3ff == LANG_JAPANESE {
            return "ja";
        }
    }
    "en"
}

#[tauri::command]
fn os_language() -> String {
    os_lang().into()
}

#[tauri::command]
fn set_language(lang: String) {
    JAPANESE.store(lang == "ja", Ordering::Relaxed);
}

// ---------------------------------------------------------------- settings

fn settings_path() -> Option<PathBuf> {
    Some(std::env::current_exe().ok()?.parent()?.join(SETTINGS_FILE))
}

fn read_settings() -> Value {
    settings_path()
        .and_then(|p| fs::read_to_string(p).ok())
        // Tolerate a BOM in case the file was edited by hand (e.g. Notepad / PowerShell).
        .and_then(|s| serde_json::from_str::<Value>(s.trim_start_matches('\u{feff}')).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

#[tauri::command]
fn load_settings() -> Value {
    read_settings()
}

#[tauri::command]
fn save_settings(window: WebviewWindow, settings: Value) -> Result<(), String> {
    let mut all = read_settings();
    let obj = all.as_object_mut().expect("settings is an object");
    if let Value::Object(m) = settings {
        obj.extend(m);
    }
    // Window geometry. When maximized, keep the last normal size so un-maximizing restores it.
    if !window.is_minimized().unwrap_or(false) {
        let maximized = window.is_maximized().unwrap_or(false);
        let mut geo = obj.get("window").cloned().unwrap_or_else(|| json!({}));
        if !maximized {
            if let (Ok(p), Ok(s)) = (window.outer_position(), window.inner_size()) {
                geo = json!({ "x": p.x, "y": p.y, "w": s.width, "h": s.height });
            }
        }
        if let Value::Object(g) = &mut geo {
            g.insert("maximized".into(), Value::Bool(maximized));
        }
        obj.insert("window".into(), geo);
    }
    let path = settings_path().ok_or_else(|| tr("設定ファイルの場所が分かりません", "Cannot locate the settings file").to_string())?;
    // A read-only folder (e.g. a network share) just means settings are not remembered.
    let _ = fs::write(path, serde_json::to_string_pretty(&all).unwrap_or_default());
    Ok(())
}

fn restore_window(win: &WebviewWindow) {
    let s = read_settings();
    let Some(w) = s.get("window") else { return };
    let num = |k: &str| w.get(k).and_then(Value::as_i64);
    if let (Some(wd), Some(ht)) = (num("w"), num("h")) {
        if wd >= 400 && ht >= 300 {
            let _ = win.set_size(tauri::PhysicalSize::new(wd as u32, ht as u32));
        }
    }
    if let (Some(x), Some(y)) = (num("x"), num("y")) {
        // Only restore the position if the title bar would land on a connected monitor.
        let visible = win
            .available_monitors()
            .map(|ms| {
                ms.iter().any(|m| {
                    let (p, sz) = (m.position(), m.size());
                    let (mx, my) = (p.x as i64, p.y as i64);
                    x + 80 >= mx
                        && x + 80 < mx + sz.width as i64
                        && y + 10 >= my
                        && y + 10 < my + sz.height as i64
                })
            })
            .unwrap_or(false);
        if visible {
            let _ = win.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
        }
    }
    if w.get("maximized").and_then(Value::as_bool) == Some(true) {
        let _ = win.maximize();
    }
}

// ---------------------------------------------------------------- binary framing
// [u32 LE header length][header JSON][payload bytes]
// Large files go through IPC as raw bytes instead of JSON strings.

fn pack(header: &Value, payload: &[u8]) -> Vec<u8> {
    let h = serde_json::to_vec(header).unwrap_or_default();
    let mut out = Vec::with_capacity(4 + h.len() + payload.len());
    out.extend_from_slice(&(h.len() as u32).to_le_bytes());
    out.extend_from_slice(&h);
    out.extend_from_slice(payload);
    out
}

fn unpack(body: &[u8]) -> Result<(Value, &[u8]), String> {
    let bad = || tr("不正なデータを受け取りました", "Received invalid data").to_string();
    let n = u32::from_le_bytes(body.get(0..4).ok_or_else(bad)?.try_into().map_err(|_| bad())?) as usize;
    let h = body.get(4..4 + n).ok_or_else(bad)?;
    let header = serde_json::from_slice(h).map_err(|_| bad())?;
    Ok((header, &body[4 + n..]))
}

// ---------------------------------------------------------------- encodings

fn label_of(enc: &'static Encoding) -> String {
    if enc == SHIFT_JIS { "Shift_JIS".into() } else { enc.name().into() }
}

fn lookup(label: &str) -> Result<&'static Encoding, String> {
    Encoding::for_label(label.as_bytes()).ok_or_else(|| format!("{}: {label}", tr("未対応の文字コードです", "Unsupported encoding")))
}

/// Decodes file bytes to text. Returns (text, encoding label).
fn decode(bytes: Vec<u8>, forced: Option<&str>) -> Result<(String, String), String> {
    match forced {
        Some("UTF-8") | Some("UTF-8 BOM") => {
            let bom = bytes.starts_with(UTF8_BOM);
            let body = if bom { &bytes[3..] } else { &bytes[..] };
            let label = if bom { "UTF-8 BOM" } else { "UTF-8" };
            Ok((String::from_utf8_lossy(body).into_owned(), label.into()))
        }
        Some("UTF-16LE") | Some("UTF-16BE") => {
            let le = forced == Some("UTF-16LE");
            let bom: &[u8] = if le { &[0xFF, 0xFE] } else { &[0xFE, 0xFF] };
            let body = bytes.strip_prefix(bom).unwrap_or(&bytes);
            let enc = if le { UTF_16LE } else { UTF_16BE };
            Ok((enc.decode_without_bom_handling(body).0.into_owned(), forced.unwrap().into()))
        }
        Some(label) => {
            let enc = lookup(label)?;
            Ok((enc.decode_without_bom_handling(&bytes).0.into_owned(), label_of(enc)))
        }
        None => Ok(auto_decode(bytes)),
    }
}

fn auto_decode(bytes: Vec<u8>) -> (String, String) {
    if bytes.starts_with(UTF8_BOM) {
        return (String::from_utf8_lossy(&bytes[3..]).into_owned(), "UTF-8 BOM".into());
    }
    if let Some(body) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return (UTF_16LE.decode_without_bom_handling(body).0.into_owned(), "UTF-16LE".into());
    }
    if let Some(body) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return (UTF_16BE.decode_without_bom_handling(body).0.into_owned(), "UTF-16BE".into());
    }
    let bytes = match String::from_utf8(bytes) {
        Ok(s) => return (s, "UTF-8".into()),
        Err(e) => e.into_bytes(),
    };
    let mut det = chardetng::EncodingDetector::new();
    det.feed(&bytes, true);
    let enc = det.guess(Some(b"jp"), true);
    (enc.decode_without_bom_handling(&bytes).0.into_owned(), label_of(enc))
}

enum EncodeError {
    Message(String),
    /// Characters that cannot be represented in the target encoding.
    Unmappable(Vec<String>),
}

/// Returns (optional BOM, encoded bytes).
fn encode<'a>(text: &'a str, label: &str, force: bool) -> Result<(&'static [u8], Cow<'a, [u8]>), EncodeError> {
    match label {
        "UTF-8" => Ok((&[], Cow::Borrowed(text.as_bytes()))),
        "UTF-8 BOM" => Ok((UTF8_BOM, Cow::Borrowed(text.as_bytes()))),
        "UTF-16LE" => {
            let mut v = Vec::with_capacity(text.len() * 2);
            text.encode_utf16().for_each(|u| v.extend_from_slice(&u.to_le_bytes()));
            Ok((&[0xFF, 0xFE], Cow::Owned(v)))
        }
        "UTF-16BE" => {
            let mut v = Vec::with_capacity(text.len() * 2);
            text.encode_utf16().for_each(|u| v.extend_from_slice(&u.to_be_bytes()));
            Ok((&[0xFE, 0xFF], Cow::Owned(v)))
        }
        other => {
            let enc = lookup(other).map_err(EncodeError::Message)?.output_encoding();
            encode_legacy(enc, text, force).map(|v| (&[][..], Cow::Owned(v)))
        }
    }
}

/// Encodes into a legacy encoding such as Shift_JIS. Unmappable characters become '?'
/// when `force` is set; otherwise up to 8 of them are reported back.
fn encode_legacy(enc: &'static Encoding, text: &str, force: bool) -> Result<Vec<u8>, EncodeError> {
    let mut encoder = enc.new_encoder();
    let mut out = Vec::with_capacity(text.len());
    let mut buf = vec![0u8; 64 * 1024];
    let mut src = text;
    let mut bad: Vec<String> = Vec::new();
    loop {
        let (res, read, written) = encoder.encode_from_utf8_without_replacement(src, &mut buf, true);
        out.extend_from_slice(&buf[..written]);
        src = &src[read..];
        match res {
            EncoderResult::InputEmpty => break,
            EncoderResult::OutputFull => {}
            EncoderResult::Unmappable(ch) => {
                if !force {
                    let s = ch.to_string();
                    if !bad.contains(&s) {
                        bad.push(s);
                        if bad.len() >= 8 {
                            break;
                        }
                    }
                }
                out.push(b'?');
            }
        }
    }
    if bad.is_empty() { Ok(out) } else { Err(EncodeError::Unmappable(bad)) }
}

// ---------------------------------------------------------------- file commands

#[tauri::command]
async fn read_file(path: String, encoding: Option<String>) -> Result<Response, String> {
    let bytes = fs::read(&path).map_err(|e| format!("{}\n{e}", tr("ファイルを開けませんでした。", "Could not open the file.")))?;
    let (text, label) = decode(bytes, encoding.as_deref())?;
    Ok(Response::new(pack(&json!({ "encoding": label }), text.as_bytes())))
}

#[tauri::command]
async fn write_file(request: Request<'_>) -> Result<Value, String> {
    let InvokeBody::Raw(body) = request.body() else {
        return Err(tr("不正なリクエストです", "Invalid request").into());
    };
    let (header, payload) = unpack(body)?;
    let path = header["path"].as_str().ok_or_else(|| tr("保存先が指定されていません", "No destination path").to_string())?;
    let label = header["encoding"].as_str().unwrap_or("UTF-8");
    let force = header["force"].as_bool().unwrap_or(false);
    let text = std::str::from_utf8(payload).map_err(|_| tr("文字データが壊れています", "The text data is corrupted").to_string())?;
    let (bom, data) = match encode(text, label, force) {
        Ok(v) => v,
        Err(EncodeError::Unmappable(chars)) => return Ok(json!({ "unmappable": chars })),
        Err(EncodeError::Message(m)) => return Err(m),
    };
    write_atomic(Path::new(path), bom, &data).map_err(|e| {
        format!(
            "{}\n{e}",
            tr(
                "保存できませんでした。ファイルが他のアプリ（Excel など）で開かれていないか確認してください。",
                "Could not save. Check that the file is not open in another app (such as Excel)."
            )
        )
    })?;
    Ok(json!({ "ok": true }))
}

/// Writes to a temp file next to the target, then swaps it in, so a failed save
/// never leaves a half-written CSV behind.
fn write_atomic(path: &Path, prefix: &[u8], data: &[u8]) -> io::Result<()> {
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, tr("ファイル名がありません", "No file name")))?;
    let tmp = path.with_file_name(format!("{}.csvsse-tmp", name.to_string_lossy()));
    let result = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(prefix)?;
        f.write_all(data)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// File passed on the command line ("Open with", drag onto the exe, file association).
#[tauri::command]
fn initial_file() -> Option<String> {
    let arg = std::env::args_os().skip(1).find(|a| !a.to_string_lossy().starts_with('-'))?;
    let p = std::path::absolute(PathBuf::from(arg)).ok()?;
    Some(p.to_string_lossy().into_owned())
}

/// Starts another instance of this exe (one window per file, no tabs).
#[tauri::command]
fn new_window(path: Option<String>) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new(exe);
    if let Some(p) = path {
        cmd.arg(p);
    }
    cmd.spawn().map(|_| ()).map_err(|e| format!("{}\n{e}", tr("新しいウィンドウを開けませんでした。", "Could not open a new window.")))
}

// ---------------------------------------------------------------- file association

#[tauri::command]
fn association_status() -> bool {
    #[cfg(windows)]
    return assoc::status();
    #[cfg(not(windows))]
    false
}

#[tauri::command]
fn set_association(enable: bool) -> Result<(), String> {
    #[cfg(windows)]
    return if enable { assoc::register() } else { assoc::unregister() };
    #[cfg(not(windows))]
    {
        let _ = enable;
        Err(tr("Windows 専用の機能です", "Windows only").into())
    }
}

#[tauri::command]
fn choose_default_app() -> Result<(), String> {
    #[cfg(windows)]
    return assoc::choose_default();
    #[cfg(not(windows))]
    Err(tr("Windows 専用の機能です", "Windows only").into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_shift_jis() {
        let (bytes, _, _) = SHIFT_JIS.encode("社員番号,氏名\r\n1001,山田 太郎\r\n");
        let (text, label) = decode(bytes.into_owned(), None).unwrap();
        assert_eq!(label, "Shift_JIS");
        assert!(text.starts_with("社員番号,氏名"));
    }

    #[test]
    fn detects_utf8_and_bom() {
        let (t, l) = decode("名前,値\n".as_bytes().to_vec(), None).unwrap();
        assert_eq!((t.as_str(), l.as_str()), ("名前,値\n", "UTF-8"));
        let mut b = UTF8_BOM.to_vec();
        b.extend_from_slice("a,b".as_bytes());
        let (t, l) = decode(b, None).unwrap();
        assert_eq!((t.as_str(), l.as_str()), ("a,b", "UTF-8 BOM"));
    }

    #[test]
    fn shift_jis_round_trip_and_unmappable() {
        let (_, data) = encode("①髙橋,ｶﾅ", "Shift_JIS", false).ok().unwrap();
        let (text, _) = decode(data.into_owned(), Some("Shift_JIS")).unwrap();
        assert_eq!(text, "①髙橋,ｶﾅ");
        match encode("絵文字😀と한글", "Shift_JIS", false) {
            Err(EncodeError::Unmappable(chars)) => assert_eq!(chars, vec!["😀", "한", "글"]),
            _ => panic!("expected unmappable"),
        }
        let (_, data) = encode("A😀B", "Shift_JIS", true).ok().unwrap();
        assert_eq!(&data[..], b"A?B");
    }

    #[test]
    fn utf16_round_trip() {
        let (bom, data) = encode("表,1", "UTF-16LE", false).ok().unwrap();
        let mut all = bom.to_vec();
        all.extend_from_slice(&data);
        assert_eq!(decode(all, None).unwrap(), ("表,1".to_string(), "UTF-16LE".to_string()));
    }

    #[test]
    fn frame_round_trip() {
        let packed = pack(&json!({"path": "C:\\a.csv"}), b"xyz");
        let (h, p) = unpack(&packed).unwrap();
        assert_eq!(h["path"], "C:\\a.csv");
        assert_eq!(p, b"xyz");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            use tauri::Manager;
            if let Some(win) = app.get_webview_window("main") {
                restore_window(&win);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            initial_file,
            new_window,
            load_settings,
            save_settings,
            association_status,
            set_association,
            choose_default_app,
            os_language,
            set_language
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
