// 语音听写：用 macOS 自带的 Speech.framework（SFSpeechRecognizer）把说话转成文字。
// 音频来自 AVAudioEngine 的输入节点，识别结果通过 Tauri 事件实时推给贾维斯窗口。
//
// 为什么放在 Rust 而不是前端：WKWebView 里没有可用的 Web Speech API，
// 而 Speech.framework 是系统自带、可离线的能力，不需要新依赖也不需要 API Key。

use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::AllocAnyThread;
use objc2_avf_audio::{AVAudioEngine, AVAudioPCMBuffer, AVAudioTime};
use objc2_foundation::{NSError, NSLocale, NSString};
use objc2_speech::{
    SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionResult, SFSpeechRecognitionTask,
    SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// 一次听写最多持续多久：够说完一句话，又不会在用户忘记关闭时一直占用麦克风。
const MAX_SESSION: Duration = Duration::from_secs(60);

/// 同一时刻只允许一个听写会话：上一次必须完全释放麦克风之后，下一次才能启动。
/// 否则第二次会拿不到音频，表现就是「没有听到说话声」。
static SESSION_LOCK: Mutex<()> = Mutex::new(());
/// 等待系统授权框的时限。
const AUTH_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationEvent {
    /// partial / final / error / done
    pub kind: String,
    pub text: String,
    pub message: Option<String>,
}

/// Tauri 托管状态：只保存"停止当前听写"的通道，ObjC 对象都留在听写线程里。
#[derive(Default)]
pub struct DictationState {
    stop: Mutex<Option<Sender<()>>>,
}

impl DictationState {
    /// 开始一次新听写，返回给听写线程的停止信号接收端；同时通知上一次听写结束。
    pub fn begin(&self) -> Result<Receiver<()>, String> {
        let (sender, receiver) = mpsc::channel();
        let mut slot = self.stop.lock().map_err(|_| "听写状态不可用".to_string())?;
        if let Some(previous) = slot.replace(sender) {
            let _ = previous.send(());
        }
        Ok(receiver)
    }

    pub fn stop(&self) {
        if let Ok(mut slot) = self.stop.lock() {
            if let Some(sender) = slot.take() {
                let _ = sender.send(());
            }
        }
    }
}

fn emit(app: &AppHandle, kind: &str, text: String, message: Option<String>) {
    let _ = app.emit(
        "dictation",
        DictationEvent { kind: kind.to_string(), text, message },
    );
}

/// 把系统英文报错翻成能照着做的中文提示，并保留原文便于排查未知错误。
fn friendly_error(error: &NSError) -> String {
    let raw = error.localizedDescription().to_string();
    let lower = raw.to_lowercase();
    if lower.contains("siri and dictation are disabled") {
        return "系统还没开启「听写」：请到「系统设置 → 键盘 → 听写」打开，并勾选中文（普通话）".to_string();
    }
    if lower.contains("no speech detected") {
        return "没有听到说话声：确认麦克风输入设备能拾音、对着麦克风说话；刚开启听写时请等系统下载完中文语音资源".to_string();
    }
    if lower.contains("not authorized") || lower.contains("denied") || lower.contains("permission") {
        return "语音识别权限被拒绝：请到「系统设置 → 隐私与安全性 → 语音识别」允许洛神赋".to_string();
    }
    format!("语音识别失败：{raw}")
}

/// 请求语音识别授权。未决定时由系统弹框，已授权则立即返回。
fn ensure_authorized() -> Result<(), String> {
    unsafe {
        let status = SFSpeechRecognizer::authorizationStatus();
        if status == SFSpeechRecognizerAuthorizationStatus::Authorized {
            return Ok(());
        }
        if status == SFSpeechRecognizerAuthorizationStatus::Denied {
            return Err("系统未授予语音识别权限，请在「系统设置 → 隐私与安全性 → 语音识别」中允许洛神赋".to_string());
        }
        if status == SFSpeechRecognizerAuthorizationStatus::Restricted {
            return Err("这台电脑限制了语音识别功能".to_string());
        }
        // 回调不在当前线程，所以要阻塞等待，并且必须有超时兜底。
        let (sender, receiver) = mpsc::channel();
        let handler = RcBlock::new(move |granted: SFSpeechRecognizerAuthorizationStatus| {
            let _ = sender.send(granted);
        });
        SFSpeechRecognizer::requestAuthorization(&handler);
        match receiver.recv_timeout(AUTH_TIMEOUT) {
            Ok(granted) if granted == SFSpeechRecognizerAuthorizationStatus::Authorized => Ok(()),
            Ok(_) => Err("未获得语音识别授权".to_string()),
            Err(_) => Err("等待语音识别授权超时".to_string()),
        }
    }
}

type Session = (
    Retained<AVAudioEngine>,
    Retained<SFSpeechAudioBufferRecognitionRequest>,
    Retained<SFSpeechRecognitionTask>,
);

/// 建立识别会话并开始采集麦克风。必须在听写线程里调用——ObjC 对象不跨线程传递。
unsafe fn start_session(
    app: &AppHandle,
    locale: &str,
    finished: &Arc<AtomicBool>,
) -> Result<Session, String> {
    ensure_authorized()?;

    let identifier = NSString::from_str(locale);
    let ns_locale = NSLocale::localeWithLocaleIdentifier(&identifier);
    let recognizer = SFSpeechRecognizer::initWithLocale(SFSpeechRecognizer::alloc(), &ns_locale)
        .ok_or_else(|| format!("系统没有 {locale} 的语音识别支持"))?;
    if !recognizer.isAvailable() {
        return Err("语音识别服务当前不可用，请稍后重试".to_string());
    }

    let request = SFSpeechAudioBufferRecognitionRequest::new();
    // 边说边出字，用户能看到自己的话在输入框里长出来。
    request.setShouldReportPartialResults(true);
    // 不强制离线：中文离线语音资源没下载完时，强制离线会直接失败（表现就是「没听到说话声」）。
    // 交给系统自己挑——本机资源可用就走本机，不可用自动走系统在线识别。

    // tap 回调在音频线程执行，Request 的 append 是线程安全的（Apple 官方用法）。
    let request_for_tap = request.clone();
    let tap: RcBlock<dyn Fn(NonNull<AVAudioPCMBuffer>, NonNull<AVAudioTime>)> =
        RcBlock::new(
            move |buffer: NonNull<AVAudioPCMBuffer>, _when: NonNull<AVAudioTime>| {
                unsafe { request_for_tap.appendAudioPCMBuffer(buffer.as_ref()) };
            },
        );

    let engine = AVAudioEngine::new();
    let input = engine.inputNode();
    let format = input.outputFormatForBus(0);
    if format.channelCount() == 0 {
        return Err("没有可用的麦克风输入，请检查「系统设置 → 声音 → 输入」".to_string());
    }
    input.installTapOnBus_bufferSize_format_block(0, 1024, Some(&format), RcBlock::as_ptr(&tap));

    let app_for_results = app.clone();
    let finished_for_results = finished.clone();
    let handler = RcBlock::new(
        move |result: *mut SFSpeechRecognitionResult, error: *mut NSError| {
            if let Some(error) = unsafe { error.as_ref() } {
                emit(
                    &app_for_results,
                    "error",
                    String::new(),
                    Some(friendly_error(error)),
                );
                finished_for_results.store(true, Ordering::SeqCst);
                return;
            }
            let Some(result) = (unsafe { result.as_ref() }) else { return };
            let text = result.bestTranscription().formattedString().to_string();
            let is_final = result.isFinal();
            if is_final {
                emit(&app_for_results, "final", text, None);
                finished_for_results.store(true, Ordering::SeqCst);
            } else {
                emit(&app_for_results, "partial", text, None);
            }
        },
    );

    let task = recognizer.recognitionTaskWithRequest_resultHandler(&request, &handler);

    engine.prepare();
    engine
        .startAndReturnError()
        .map_err(|error| format!("无法启动麦克风：{}", error.localizedDescription()))?;

    Ok((engine, request, task))
}

/// 听写线程主体：先建会话，再等到用户停止、识别完成或超时，最后释放麦克风。
pub fn run(app: AppHandle, receiver: Receiver<()>, locale: String) {
    // 等上一个会话彻底退出（engine 已停、任务已释放）再开新的，避免抢麦克风。
    let _session = SESSION_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let finished = Arc::new(AtomicBool::new(false));
    let session = unsafe { start_session(&app, &locale, &finished) };
    let (engine, request, _task) = match session {
        Ok(value) => value,
        Err(message) => {
            emit(&app, "error", String::new(), Some(message));
            emit(&app, "done", String::new(), None);
            return;
        }
    };

    let deadline = Instant::now() + MAX_SESSION;
    loop {
        if finished.load(Ordering::SeqCst) || Instant::now() >= deadline {
            break;
        }
        match receiver.recv_timeout(Duration::from_millis(150)) {
            Ok(()) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
    }

    unsafe {
        // 先摘掉 tap 再停引擎，避免停止过程中还有音频送进已结束的请求。
        engine.inputNode().removeTapOnBus(0);
        engine.stop();
        // 只 endAudio、不 cancel：cancel 会让结果回调带一条其实无关紧要的错误，
        // 界面就会闪出一次"识别失败"。_task 保持存活到收尾完成。
        request.endAudio();
    }
    emit(&app, "done", String::new(), None);
}
