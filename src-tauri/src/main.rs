#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::{
    fs::{create_dir_all, OpenOptions},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{Manager, State};
use uuid::Uuid;

mod dictation;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceInfo {
    base_url: String,
    token: String,
}

struct ServiceState {
    info: ServiceInfo,
    child: Arc<Mutex<Option<Child>>>,
    // 正常退出流程先置位再取走 child，守护线程据此停止重启。
    stopping: Arc<AtomicBool>,
}

#[tauri::command]
fn service_info(state: State<'_, ServiceState>) -> ServiceInfo {
    state.info.clone()
}

/// 直接走 UNUserNotificationCenter：通知会以「洛神赋」自己的身份投递，因此能带上应用图标。
/// 之前退化成 osascript 只是因为它在 ad-hoc 签名下最稳，代价是来源变成「脚本编辑器」、图标也不对。
/// task_id 直接当作通知 identifier，点击时由下面的 delegate 取出来回传前端，用来打开对应任务详情。
#[cfg(target_os = "macos")]
fn post_notification(title: &str, body: &str, task_id: &str) -> Result<(), String> {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_user_notifications::{UNAuthorizationOptions, UNMutableNotificationContent, UNNotificationRequest, UNUserNotificationCenter};
    use std::sync::mpsc;

    let center = UNUserNotificationCenter::currentNotificationCenter();
    // 首次调用会由系统弹授权框；已授权时立即回调。授权回调不在当前线程，
    // 所以这里可以安全地阻塞等待，但必须给超时兜底。
    let (sender, receiver) = mpsc::channel();
    let handler = RcBlock::new(move |granted: Bool, _error: *mut NSError| {
        let _ = sender.send(granted.as_bool());
    });
    center.requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
        &handler,
    );
    if !receiver.recv_timeout(Duration::from_secs(5)).unwrap_or(false) {
        return Err("系统未授予通知权限，请在「系统设置 → 通知」中允许洛神赋".to_string());
    }

    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    let fallback = Uuid::new_v4().to_string();
    let identifier_value = if task_id.trim().is_empty() { fallback.as_str() } else { task_id };
    let identifier = NSString::from_str(identifier_value);
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&identifier, &content, None);
    center.addNotificationRequest_withCompletionHandler(&request, None);
    Ok(())
}

#[tauri::command]
async fn notify(title: String, body: String, task_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || post_notification(&title, &body, &task_id))
        .await
        .map_err(|error| error.to_string())?
}

// 说明：这里曾尝试用 objc 清掉 WKWebView 的 underPageBackgroundColor，但 Tauri 里
// NSWindow 的 contentView 是普通 NSView 而不是 WKWebView，发送该 selector 会抛
// unrecognized selector 并让整个 App 崩溃。透明窗口的系统底色改用前端方案处理，
// 不再走 objc：无法在真机验证的平台专属调用不该出现在交付物里。

/// 贾维斯粒子窗口：透明、无边框、置顶。界面完全由前端 WebGL 自绘，
/// 窗口本身不画背景，避免破坏"全息投影"的观感。
#[tauri::command]
async fn open_avatar(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("avatar") {
        let _ = window.show();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(&app, "avatar", tauri::WebviewUrl::App("avatar.html".into()))
        .title("贾维斯")
        .inner_size(420.0, 420.0)
        .min_inner_size(220.0, 220.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .shadow(false)
        .resizable(true)
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn close_avatar(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("avatar") {
        window.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// 开始语音听写：识别结果通过 `dictation` 事件实时推给贾维斯窗口。
#[tauri::command]
fn start_dictation(
    app: tauri::AppHandle,
    state: State<'_, dictation::DictationState>,
    locale: Option<String>,
) -> Result<(), String> {
    let receiver = state.begin()?;
    let handle = app.clone();
    thread::spawn(move || {
        dictation::run(handle, receiver, locale.unwrap_or_else(|| "zh-CN".to_string()));
    });
    Ok(())
}

/// 结束当前听写；没有进行中的听写时什么也不做。
#[tauri::command]
fn stop_dictation(state: State<'_, dictation::DictationState>) -> Result<(), String> {
    state.stop();
    Ok(())
}

/// 侧边栏按钮用：已打开就收起，否则打开。
#[tauri::command]
async fn toggle_avatar(app: tauri::AppHandle) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window("avatar") {
        window.close().map_err(|error| error.to_string())?;
        return Ok(false);
    }
    open_avatar(app).await?;
    Ok(true)
}

#[cfg(target_os = "macos")]
use objc2::DefinedClass;
#[cfg(target_os = "macos")]
use objc2_foundation::{NSObject, NSObjectProtocol};
#[cfg(target_os = "macos")]
use objc2_user_notifications::{UNNotificationResponse, UNUserNotificationCenter, UNUserNotificationCenterDelegate};

/// 通知点击回调：从 identifier 取回 taskId 并抛给前端，用来打开对应任务详情。
/// 没有它时，点击通知只会把 app 唤到前台（macOS 默认行为）。
#[cfg(target_os = "macos")]
struct NotifyDelegateIvars {
    app: tauri::AppHandle,
}

#[cfg(target_os = "macos")]
objc2::define_class!(
    #[unsafe(super(NSObject))]
    #[name = "LuoshenfuNotifyDelegate"]
    #[ivars = NotifyDelegateIvars]
    struct NotifyDelegate;

    unsafe impl NSObjectProtocol for NotifyDelegate {}

    unsafe impl UNUserNotificationCenterDelegate for NotifyDelegate {
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion_handler: &block2::DynBlock<dyn Fn()>,
        ) {
            use tauri::Emitter;
            let task_id = response.notification().request().identifier().to_string();
            if !task_id.trim().is_empty() {
                let _ = self.ivars().app.emit("notification-open-task", task_id);
            }
            completion_handler.call(());
        }
    }
);

#[cfg(target_os = "macos")]
impl NotifyDelegate {
    fn new(app: tauri::AppHandle) -> objc2::rc::Retained<Self> {
        use objc2::AllocAnyThread;
        let this = Self::alloc().set_ivars(NotifyDelegateIvars { app });
        unsafe { objc2::msg_send![super(this), init] }
    }
}

/// 注册 delegate 并故意让它活到进程结束（setDelegate 不持有它）。
#[cfg(target_os = "macos")]
fn install_notify_delegate(app: tauri::AppHandle) {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_user_notifications::UNUserNotificationCenter;
    let center = UNUserNotificationCenter::currentNotificationCenter();
    let delegate: Retained<NotifyDelegate> = NotifyDelegate::new(app);
    center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    std::mem::forget(delegate);
}

fn available_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .expect("cannot reserve a local port")
        .port()
}

fn stop_child(mut child: Child) {
    unsafe { libc::kill(child.id() as i32, libc::SIGTERM); }
    for _ in 0..20 {
        if child.try_wait().ok().flatten().is_some() { return; }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// 启动本地服务进程；stdout/stderr 一律追加到日志文件。
/// 之前这里是 Stdio::null()，sidecar 崩溃（例如未处理的 Promise 拒绝）什么线索都没留下。
fn spawn_server(
    node: &Path,
    server: &Path,
    port: u16,
    token: &str,
    data_dir: &Path,
    resources: &Path,
    log_path: &Path,
) -> std::io::Result<Child> {
    let log = OpenOptions::new().create(true).append(true).open(log_path)?;
    let log_error = log.try_clone()?;
    Command::new(node)
        .arg(server)
        .env("LUOSHENFU_PORT", port.to_string())
        .env("LUOSHENFU_TOKEN", token)
        .env("LUOSHENFU_DATA_DIR", data_dir)
        .env("LUOSHENFU_RESOURCE_DIR", resources.join("app"))
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_error))
        .spawn()
}

/// 重启本地服务所需的一切；复用同一个端口与令牌，前端缓存的 service_info 不会失效。
struct GuardConfig {
    node: PathBuf,
    server: PathBuf,
    port: u16,
    token: String,
    data_dir: PathBuf,
    resources: PathBuf,
    log_path: PathBuf,
}

/// 守护线程：本地服务意外退出时自动拉起。
/// 之前 sidecar 一旦退出就再也没人重启，界面所有请求变成 Load failed，只能靠重开 App 恢复。
fn watch_service(config: GuardConfig, slot: Arc<Mutex<Option<Child>>>, stopping: Arc<AtomicBool>) {
    let mut failures: u32 = 0;
    loop {
        thread::sleep(Duration::from_millis(1000));
        let mut guard = match slot.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        // 正常退出会先置 stopping 再取走 child：这里再查一次，避免把正在关闭的服务又拉起来。
        if stopping.load(Ordering::SeqCst) { return; }
        let exited = match guard.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(Some(_))),
            // 重启失败时槽位为空，下一轮继续重试。
            None => true,
        };
        if !exited {
            failures = 0;
            continue;
        }
        eprintln!("[luoshenfu] 本地服务已退出，正在自动重启（第 {} 次）", failures + 1);
        match spawn_server(&config.node, &config.server, config.port, &config.token, &config.data_dir, &config.resources, &config.log_path) {
            Ok(child) => {
                *guard = Some(child);
                failures = 0;
            }
            Err(error) => {
                eprintln!("[luoshenfu] 本地服务自动重启失败：{error}");
                failures = failures.saturating_add(1);
            }
        }
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            install_notify_delegate(app.handle().clone());
            let port = available_port();
            let token = Uuid::new_v4().to_string();
            let resources = app.path().resource_dir()?;
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;

            let node = std::env::current_exe()?
                .parent()
                .ok_or_else(|| std::io::Error::other("cannot locate app executable directory"))?
                .join("node");
            let server: PathBuf = resources.join("app/server/index.mjs");
            let log_path = data_dir.join("logs/server.log");
            if let Some(parent) = log_path.parent() { create_dir_all(parent)?; }
            let child = spawn_server(&node, &server, port, &token, &data_dir, &resources, &log_path)?;

            let child_slot = Arc::new(Mutex::new(Some(child)));
            let stopping = Arc::new(AtomicBool::new(false));
            app.manage(ServiceState {
                info: ServiceInfo {
                    base_url: format!("http://127.0.0.1:{port}"),
                    token: token.clone(),
                },
                child: Arc::clone(&child_slot),
                stopping: Arc::clone(&stopping),
            });
            app.manage(dictation::DictationState::default());

            // 守护线程随 App 一起长驻：sidecar 意外退出就自动重启，界面不需要用户手动重开 App。
            let guard = GuardConfig { node, server, port, token, data_dir, resources, log_path };
            thread::spawn(move || watch_service(guard, child_slot, stopping));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![service_info, notify, open_avatar, close_avatar, toggle_avatar, start_dictation, stop_dictation])
        .build(tauri::generate_context!())
        .expect("failed to build 洛神赋");

    app.run(|handle, event| match event {
        // 主窗口关掉时一并收起贾维斯，否则进程会被一个孤立窗口留着不退出。
        tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::CloseRequested { .. }, .. } => {
            if label == "main" {
                if let Some(avatar) = handle.get_webview_window("avatar") {
                    let _ = avatar.close();
                }
            }
        }
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            let state = handle.state::<ServiceState>();
            // 先置位再取走 child：守护线程看到 stopping 就不会把服务重新拉起来。
            state.stopping.store(true, Ordering::SeqCst);
            if let Some(child) = state.child.lock().ok().and_then(|mut slot| slot.take()) {
                stop_child(child);
            }
        }
        _ => {}
    });
}
