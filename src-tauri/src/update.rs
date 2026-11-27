//! Self-update for the portable exe: check, download, verify the signature, replace, restart.
//!
//! The latest release carries `latest.json` (written by scripts/sign-release.mjs):
//! `{ "version", "url", "size", "signature" }`. The exe is only installed if its minisign
//! signature matches the public key below; the private key never enters the repository.
//!
//! Replacing works even while the exe is running, because Windows lets a running exe be
//! renamed: CSVSSE.exe -> CSVSSE.exe.old, then the new file takes its name. When the folder
//! is not writable (e.g. Program Files), this exe is started again elevated (UAC) with
//! `--apply-update <file> <signature>` and does only the file operations.

use std::{
    ffi::{OsString, c_void},
    fs,
    io::{self, Write},
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    ptr,
    sync::Mutex,
};

use base64::Engine;
use serde_json::Value;
use windows_sys::Win32::{
    Foundation::{CloseHandle, ERROR_CANCELLED, GetLastError, HWND},
    Networking::WinHttp::*,
    Storage::FileSystem::{MOVEFILE_DELAY_UNTIL_REBOOT, MoveFileExW},
    System::Threading::{GetExitCodeProcess, INFINITE, WaitForSingleObject},
    UI::{
        Shell::{SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW},
        WindowsAndMessaging::SW_SHOWNORMAL,
    },
};

use crate::{dir_writable, tr};

const MANIFEST_URL: &str = "https://github.com/quon-kobo/CSVSSE/releases/latest/download/latest.json";
/// minisign public key as written by `tauri signer generate` (base64 of the .pub file).
const PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDhBMDRDRUE0QjdDMjY1MTYKUldRV1pjSzNwTTRFaXVIdm0wcWVDQ09tRUNJK0g5dlJoQTZsWnJpNkliMk9kYUdDTFdWQWRhY0wK";
const USER_AGENT: &str = concat!("CSVSSE/", env!("CARGO_PKG_VERSION"));
const APPLY_ARG: &str = "--apply-update";
/// Error text the front end recognises as "the user said no to UAC".
pub const CANCELLED: &str = "CANCELLED";

#[derive(Clone)]
struct Manifest {
    version: String,
    url: String,
    size: Option<u64>,
    signature: String,
}

/// The update found by the last check, and the verified download once it exists.
static PENDING: Mutex<Option<(Manifest, Option<PathBuf>)>> = Mutex::new(None);

// ---------------------------------------------------------------- versions

fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let mut it = s.trim().trim_start_matches('v').split('.').map(|p| p.parse::<u64>().ok());
    let v = (it.next()??, it.next().unwrap_or(Some(0))?, it.next().unwrap_or(Some(0))?);
    if it.next().is_some() { None } else { Some(v) }
}

fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some(l), Some(c)) => l > c,
        _ => false,
    }
}

fn parse_manifest(body: &[u8]) -> Option<Manifest> {
    let v: Value = serde_json::from_slice(body).ok()?;
    let s = |k: &str| v.get(k)?.as_str().map(str::to_owned);
    let url = s("url")?;
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return None;
    }
    Some(Manifest { version: s("version")?, url, size: v.get("size").and_then(Value::as_u64), signature: s("signature")? })
}

// ---------------------------------------------------------------- signature

fn verify(data: &[u8], signature: &str) -> Result<(), String> {
    let bad = || tr("ダウンロードしたファイルの署名が正しくありません。", "The downloaded file has an invalid signature.").to_string();
    let text = |b64: &str| {
        let raw = base64::engine::general_purpose::STANDARD.decode(b64.trim()).ok()?;
        String::from_utf8(raw).ok()
    };
    let key = text(PUBLIC_KEY).and_then(|s| minisign_verify::PublicKey::decode(&s).ok()).ok_or_else(bad)?;
    let sig = text(signature).and_then(|s| minisign_verify::Signature::decode(&s).ok()).ok_or_else(bad)?;
    key.verify(data, &sig, false).map_err(|_| bad())
}

// ---------------------------------------------------------------- HTTP (WinHTTP: system proxy and certificates)

fn wide(s: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(Some(0)).collect()
}

struct Handle(*mut c_void);
impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: a handle returned by WinHttpOpen / Connect / OpenRequest, closed once.
            unsafe { WinHttpCloseHandle(self.0) };
        }
    }
}

fn net_error() -> String {
    // SAFETY: no arguments.
    let code = unsafe { GetLastError() };
    format!("{} (WinHTTP {code})", tr("インターネットに接続できませんでした。", "Could not connect to the internet."))
}

/// GET `url`, following redirects. Returns (status, body). `progress(done, total)` is called per chunk.
fn http_get(url: &str, mut progress: impl FnMut(u64, Option<u64>)) -> Result<(u32, Vec<u8>), String> {
    let wurl = wide(url);
    // SAFETY: all pointers passed below point into live local buffers; handles are closed by `Handle`.
    unsafe {
        let mut uc: URL_COMPONENTS = std::mem::zeroed();
        uc.dwStructSize = size_of::<URL_COMPONENTS>() as u32;
        uc.dwHostNameLength = u32::MAX;
        uc.dwUrlPathLength = u32::MAX;
        uc.dwExtraInfoLength = u32::MAX;
        if WinHttpCrackUrl(wurl.as_ptr(), 0, 0, &mut uc) == 0 {
            return Err(format!("{}: {url}", tr("URL が正しくありません", "Invalid URL")));
        }
        let part = |p: *const u16, n: u32| if p.is_null() { &[][..] } else { std::slice::from_raw_parts(p, n as usize) };
        let mut host = part(uc.lpszHostName, uc.dwHostNameLength).to_vec();
        host.push(0);
        let mut path = part(uc.lpszUrlPath, uc.dwUrlPathLength).to_vec();
        path.extend_from_slice(part(uc.lpszExtraInfo, uc.dwExtraInfoLength));
        if path.is_empty() {
            path.push(b'/' as u16);
        }
        path.push(0);
        let secure = uc.nScheme == WINHTTP_INTERNET_SCHEME_HTTPS;

        let ua = wide(USER_AGENT);
        let mut session = Handle(WinHttpOpen(ua.as_ptr(), WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, ptr::null(), ptr::null(), 0));
        if session.0.is_null() {
            session = Handle(WinHttpOpen(ua.as_ptr(), WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, ptr::null(), ptr::null(), 0));
        }
        if session.0.is_null() {
            return Err(net_error());
        }
        WinHttpSetTimeouts(session.0, 15_000, 15_000, 15_000, 30_000);
        let conn = Handle(WinHttpConnect(session.0, host.as_ptr(), uc.nPort, 0));
        if conn.0.is_null() {
            return Err(net_error());
        }
        let verb = wide("GET");
        let flags = if secure { WINHTTP_FLAG_SECURE } else { 0 };
        let req = Handle(WinHttpOpenRequest(conn.0, verb.as_ptr(), path.as_ptr(), ptr::null(), ptr::null(), ptr::null(), flags));
        if req.0.is_null() {
            return Err(net_error());
        }
        if WinHttpSendRequest(req.0, ptr::null(), 0, ptr::null(), 0, 0, 0) == 0 || WinHttpReceiveResponse(req.0, ptr::null_mut()) == 0 {
            return Err(net_error());
        }
        let number = |info: u32| {
            let mut v: u32 = 0;
            let mut len = size_of::<u32>() as u32;
            let ok = WinHttpQueryHeaders(
                req.0,
                info | WINHTTP_QUERY_FLAG_NUMBER,
                ptr::null(),
                (&mut v as *mut u32).cast(),
                &mut len,
                ptr::null_mut(),
            );
            (ok != 0).then_some(v)
        };
        let status = number(WINHTTP_QUERY_STATUS_CODE).unwrap_or(0);
        let total = number(WINHTTP_QUERY_CONTENT_LENGTH).map(u64::from);

        let mut body = Vec::with_capacity(total.unwrap_or(0).min(64 << 20) as usize);
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let mut read: u32 = 0;
            if WinHttpReadData(req.0, buf.as_mut_ptr().cast(), buf.len() as u32, &mut read) == 0 {
                return Err(net_error());
            }
            if read == 0 {
                break;
            }
            body.extend_from_slice(&buf[..read as usize]);
            progress(body.len() as u64, total);
        }
        Ok((status, body))
    }
}

fn manifest_url() -> String {
    // Test hook (e.g. a local server). Harmless: whatever it points to must still be signed.
    std::env::var("CSVSSE_UPDATE_URL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| MANIFEST_URL.into())
}

// ---------------------------------------------------------------- check / download

/// Returns the newer version number, or None when this exe is up to date.
pub fn check() -> Result<Option<String>, String> {
    let (status, body) = http_get(&manifest_url(), |_, _| {})?;
    // 404: no release with update information yet.
    if status == 404 {
        return Ok(None);
    }
    if status != 200 {
        return Err(format!("{} (HTTP {status})", tr("更新情報を取得できませんでした。", "Could not get the update information.")));
    }
    let m = parse_manifest(&body).ok_or_else(|| tr("更新情報の形式が正しくありません。", "The update information is malformed.").to_string())?;
    let newer = is_newer(&m.version, env!("CARGO_PKG_VERSION"));
    let version = m.version.clone();
    *PENDING.lock().unwrap() = newer.then(|| (m, None));
    Ok(newer.then_some(version))
}

/// Downloads and verifies the update found by `check`. Progress goes to `progress(done, total)`.
pub fn download(progress: impl FnMut(u64, Option<u64>)) -> Result<(), String> {
    let m = PENDING
        .lock()
        .unwrap()
        .as_ref()
        .map(|(m, _)| m.clone())
        .ok_or_else(|| tr("更新が見つかっていません。", "No update has been found.").to_string())?;
    let (status, data) = http_get(&m.url, progress)?;
    if status != 200 {
        return Err(format!("{} (HTTP {status})", tr("ダウンロードできませんでした。", "Could not download the update.")));
    }
    if m.size.is_some_and(|n| n != data.len() as u64) {
        return Err(tr("ダウンロードしたファイルの大きさが合いません。", "The downloaded file has the wrong size.").into());
    }
    verify(&data, &m.signature)?;
    let dir = std::env::temp_dir().join("CSVSSE-update");
    let file = dir.join(format!("CSVSSE-{}.exe", m.version));
    let save = || -> io::Result<()> {
        fs::create_dir_all(&dir)?;
        let mut f = fs::File::create(&file)?;
        f.write_all(&data)?;
        f.sync_all()
    };
    save().map_err(|e| format!("{}\n{e}", tr("ダウンロードしたファイルを保存できませんでした。", "Could not save the download.")))?;
    *PENDING.lock().unwrap() = Some((m, Some(file)));
    Ok(())
}

// ---------------------------------------------------------------- install

fn old_names(target: &Path) -> impl Iterator<Item = PathBuf> + '_ {
    let name = target.file_name().unwrap_or_default().to_string_lossy().into_owned();
    (0..10).map(move |i| target.with_file_name(if i == 0 { format!("{name}.old") } else { format!("{name}.{i}.old") }))
}

/// Puts `data` in place of `target` (which may be running). Returns where the old exe went.
fn replace(target: &Path, data: &[u8]) -> io::Result<PathBuf> {
    let name = target.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let staged = target.with_file_name(format!("{name}.new"));
    let write = || -> io::Result<()> {
        let mut f = fs::File::create(&staged)?;
        f.write_all(data)?;
        f.sync_all()
    };
    if let Err(e) = write() {
        let _ = fs::remove_file(&staged);
        return Err(e);
    }
    // A previous .old may still be running (another window); then use the next free name.
    let old = old_names(target)
        .find(|p| !p.exists() || fs::remove_file(p).is_ok())
        .ok_or_else(|| io::Error::other("no free name for the old exe"))?;
    if let Err(e) = fs::rename(target, &old) {
        let _ = fs::remove_file(&staged);
        return Err(e);
    }
    if let Err(e) = fs::rename(&staged, target) {
        let _ = fs::rename(&old, target);
        let _ = fs::remove_file(&staged);
        return Err(e);
    }
    Ok(old)
}

/// Runs this exe elevated with `--apply-update` and waits. Err(CANCELLED) if UAC was declined.
fn replace_elevated(hwnd: HWND, file: &Path, signature: &str) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let verb = wide("runas");
    let exe_w = wide(&exe);
    let params = wide(format!("{APPLY_ARG} \"{}\" \"{}\"", file.display(), signature));
    // SAFETY: the strings outlive the call; the process handle is closed below.
    unsafe {
        let mut info: SHELLEXECUTEINFOW = std::mem::zeroed();
        info.cbSize = size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
        info.hwnd = hwnd;
        info.lpVerb = verb.as_ptr();
        info.lpFile = exe_w.as_ptr();
        info.lpParameters = params.as_ptr();
        info.nShow = SW_SHOWNORMAL;
        if ShellExecuteExW(&mut info) == 0 {
            let code = GetLastError();
            return Err(if code == ERROR_CANCELLED { CANCELLED.into() } else { format!("ShellExecuteEx ({code})") });
        }
        if info.hProcess.is_null() {
            return Err("ShellExecuteEx: no process".into());
        }
        WaitForSingleObject(info.hProcess, INFINITE);
        let mut code: u32 = 1;
        GetExitCodeProcess(info.hProcess, &mut code);
        CloseHandle(info.hProcess);
        if code != 0 {
            return Err(format!("{} ({code})", tr("管理者として exe を置き換えられませんでした。", "Could not replace the exe as administrator.")));
        }
    }
    Ok(())
}

/// Installs the verified download in place of this exe. Returns the path to start next.
pub fn install(hwnd: HWND) -> Result<PathBuf, String> {
    let (m, file) = PENDING
        .lock()
        .unwrap()
        .clone()
        .and_then(|(m, f)| Some((m, f?)))
        .ok_or_else(|| tr("更新がダウンロードされていません。", "The update has not been downloaded.").to_string())?;
    let target = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = target.parent().ok_or("no exe folder")?;
    if dir_writable(dir) {
        let data = fs::read(&file).map_err(|e| e.to_string())?;
        verify(&data, &m.signature)?;
        replace(&target, &data).map_err(|e| format!("{}\n{e}", tr("exe を置き換えられませんでした。", "Could not replace the exe.")))?;
    } else {
        replace_elevated(hwnd, &file, &m.signature)?;
    }
    let _ = fs::remove_file(&file);
    *PENDING.lock().unwrap() = None;
    Ok(target)
}

// ---------------------------------------------------------------- process entry hooks

/// `CSVSSE.exe --apply-update <file> <signature>`: the elevated half of `install`.
/// Returns the exit code when this process was started for that, otherwise None.
pub fn helper_main() -> Option<i32> {
    let args: Vec<OsString> = std::env::args_os().collect();
    if args.get(1).is_none_or(|a| a != APPLY_ARG) {
        return None;
    }
    let run = || -> Result<(), String> {
        let (file, sig) = (args.get(2).ok_or("file")?, args.get(3).ok_or("signature")?);
        // Verify again here: the file sat in a user-writable folder before this elevated step.
        let data = fs::read(file).map_err(|e| e.to_string())?;
        verify(&data, &sig.to_string_lossy())?;
        let target = std::env::current_exe().map_err(|e| e.to_string())?;
        let old = replace(&target, &data).map_err(|e| e.to_string())?;
        // The old exe is still running; as administrator we can have Windows delete it on reboot.
        let old_w = wide(&old);
        // SAFETY: valid NUL-terminated path; a null destination means delete.
        unsafe { MoveFileExW(old_w.as_ptr(), ptr::null(), MOVEFILE_DELAY_UNTIL_REBOOT) };
        Ok(())
    };
    Some(if run().is_ok() { 0 } else { 2 })
}

/// Deletes CSVSSE.exe.old left by a previous update (in the background: the old process may
/// still be exiting). In a read-only folder this quietly fails; the reboot cleans up instead.
pub fn cleanup_old_files() {
    let Ok(target) = std::env::current_exe() else { return };
    if !old_names(&target).any(|p| p.exists()) {
        return;
    }
    std::thread::spawn(move || {
        for _ in 0..20 {
            let left = old_names(&target).filter(|p| p.exists() && fs::remove_file(p).is_err()).count();
            if left == 0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert!(is_newer("0.1.8", "0.1.7"));
        assert!(is_newer("0.2.0", "0.1.17"));
        assert!(is_newer("v1.0", "0.9.9"));
        assert!(!is_newer("0.1.7", "0.1.7"));
        assert!(!is_newer("0.1.6", "0.1.7"));
        assert!(!is_newer("0.1.8-beta", "0.1.7"));
        assert!(!is_newer("", "0.1.7"));
    }

    // Signed with the real key: `node scripts/sign-release.mjs dummy.bin` on b"hello\r\n".
    const SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRV1pjSzNwTTRFaW94ZDNBMXZSRzlZQkdFdnQ1cENJc3V1bE1yWGtJaDdTc3BxSUUrL0J5VDE1citiV0o1ZWFqZ2JyZEMxMUpPcnpyT2d5em53aEhIcldNcjBuUS9WZndrPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk1Nzc0NzU5CWZpbGU6ZHVtbXkuYmluCmxhWHB0elFKdUo3ODdHSC9WTXRMNDN0YlVxY0lmdFRaSFpYbTdNazAzV2ZLYVVLSGloNHA5U2pXcUFLTTFjMzBYbU9LdWFQTGRnUFVReThSM1VZTUNRPT0K";

    #[test]
    fn signature() {
        assert!(verify(b"hello\r\n", SIG).is_ok());
        assert!(verify(b"hellO\r\n", SIG).is_err());
        assert!(verify(b"hello\r\n", "not a signature").is_err());
    }

    #[test]
    fn manifest() {
        let m = parse_manifest(br#"{"version":"0.1.8","url":"https://x/CSVSSE.exe","size":3,"signature":"s"}"#).unwrap();
        assert_eq!((m.version.as_str(), m.size), ("0.1.8", Some(3)));
        assert!(parse_manifest(br#"{"version":"0.1.8","url":"file:///c:/x.exe","signature":"s"}"#).is_none());
        assert!(parse_manifest(b"<html>").is_none());
    }

    #[test]
    fn replace_keeps_old_and_puts_new() {
        let dir = std::env::temp_dir().join(format!("csvsse-replace-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("CSVSSE.exe");
        fs::write(&target, b"old").unwrap();
        let old = replace(&target, b"new").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert_eq!(fs::read(&old).unwrap(), b"old");
        assert_eq!(old.file_name().unwrap(), "CSVSSE.exe.old");
        // With .old held open (like a still-running old exe), the next free name is used.
        use std::os::windows::fs::OpenOptionsExt;
        let _hold = fs::OpenOptions::new().read(true).share_mode(1 /* FILE_SHARE_READ only */).open(&old).unwrap();
        let old2 = replace(&target, b"newer").unwrap();
        assert_eq!(old2.file_name().unwrap(), "CSVSSE.exe.1.old");
        assert_eq!(fs::read(&target).unwrap(), b"newer");
        drop(_hold);
        let _ = fs::remove_dir_all(&dir);
    }
}
