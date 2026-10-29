import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { api, musicEndpoint, serviceInfo } from "./api";
import type { ServiceInfo } from "./api";
import type { MusicLibrary, MusicLyrics, MusicPlaylist, MusicRepeatMode, MusicSettings, MusicTrack } from "./types";

const repeatOrder: MusicRepeatMode[] = ["all", "one", "off"];
const repeatLabel: Record<MusicRepeatMode, string> = { all: "列表循环", one: "单曲循环", off: "顺序播放" };

function formatTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return "--:--";
  const total = Math.floor(value);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function readSetting(key: string, fallback: string) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

/* 与项目其它图标一致的线性风格；播放/暂停在按钮内用实心以突出主操作。 */
function MusicNoteIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>; }
function PrevIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 5v14" /><path d="M19 5 8 12l11 7z" /></svg>; }
function NextIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5v14" /><path d="M5 5l11 7-11 7z" /></svg>; }
function PlayIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 4.8 19.2 12 7.5 19.2z" /></svg>; }
function PauseIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.8" y="5" width="3.6" height="14" rx="1.3" /><rect x="13.6" y="5" width="3.6" height="14" rx="1.3" /></svg>; }
function ShuffleIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3h5v5" /><path d="M4 20 21 3" /><path d="M21 16v5h-5" /><path d="m15 15 6 6" /><path d="m4 4 5 5" /></svg>; }
function RepeatIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m17 2 4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="m7 22-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /></svg>; }
function VolumeIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z" /><path d="M15.5 8.6a4.8 4.8 0 0 1 0 6.8" /><path d="M18.4 5.7a8.8 8.8 0 0 1 0 12.6" /></svg>; }
function VolumeOffIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z" /><path d="m16 9.6 5 4.8" /><path d="m21 9.6-5 4.8" /></svg>; }
function ChevronUpIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 14.5 6-6 6 6" /></svg>; }
function ChevronDownIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9.5 6 6 6-6" /></svg>; }
function CloseIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 6.6 17.4 17.4" /><path d="M17.4 6.6 6.6 17.4" /></svg>; }

/**
 * 本机音乐播放器：底部播放条 + 可展开的队列 / 音乐库 / 歌单 / 歌词面板。
 * 全部音频经由本地服务的 Range 流播放，不联网、不消耗任何模型额度。
 */
export function MusicPlayer({ settings, onNotify, onOpenSettings, onReloadSettings }: {
  settings: MusicSettings;
  onNotify: (message: string) => void;
  onOpenSettings: () => void;
  onReloadSettings: () => Promise<void> | void;
}) {
  const [service, setService] = useState<ServiceInfo | null>(null);
  const [library, setLibrary] = useState<MusicLibrary | null>(null);
  const [playlists, setPlaylists] = useState<MusicPlaylist[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [panel, setPanel] = useState<"queue" | "library" | "playlists">("queue");
  const [queue, setQueue] = useState<MusicTrack[]>([]);
  const [queueLabel, setQueueLabel] = useState("音乐库");
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(() => Number(readSetting("music.volume", "0.85")) || 0.85);
  const [muted, setMuted] = useState(() => readSetting("music.muted", "false") === "true");
  const [shuffle, setShuffle] = useState(() => readSetting("music.shuffle", "false") === "true");
  const [repeat, setRepeat] = useState<MusicRepeatMode>(() => {
    const saved = readSetting("music.repeat", "all");
    return saved === "one" || saved === "off" ? saved : "all";
  });
  const [lyrics, setLyrics] = useState<MusicLyrics | null>(null);
  const [query, setQuery] = useState("");
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [playRequest, setPlayRequest] = useState(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const shouldPlay = useRef(false);
  const lyricRefs = useRef<(HTMLParagraphElement | null)[]>([]);

  const track = queue[index] || null;
  const trackPath = track?.path || "";
  const src = useMemo(() => (trackPath && service ? musicEndpoint(service, "stream", trackPath) : ""), [trackPath, service]);

  /* ---------------- 数据加载 ---------------- */

  useEffect(() => { void serviceInfo().then(setService).catch(() => {}); }, []);

  const loadLibrary = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<MusicLibrary>("/api/music/library");
      setLibrary(data);
    } catch (error) {
      onNotify((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  const loadPlaylists = useCallback(async () => {
    try { setPlaylists(await api<MusicPlaylist[]>("/api/music/playlists")); }
    catch { /* 歌单读取失败不阻塞播放 */ }
  }, []);

  useEffect(() => { void loadLibrary(); }, [loadLibrary, settings.directory]);
  useEffect(() => { void loadPlaylists(); }, [loadPlaylists]);

  // 首次拿到曲目时填充默认队列，但不自动播放。
  useEffect(() => {
    if (queue.length || !library?.tracks.length) return;
    setQueue(library.tracks);
    setIndex(0);
  }, [library, queue.length]);

  /* ---------------- 播放控制 ---------------- */

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !src || !shouldPlay.current) return;
    const started = audio.play();
    if (started) void started.catch(() => { shouldPlay.current = false; setPlaying(false); onNotify("无法播放这首曲目，系统可能不支持该格式"); });
  }, [src, playRequest, onNotify]);

  // 仅在展开且正在播放时用 requestAnimationFrame 驱动歌词，避免折叠时无谓的重渲染。
  useEffect(() => {
    if (!playing || !expanded) return;
    let frame = 0;
    const tick = () => {
      const audio = audioRef.current;
      if (audio) setCurrentTime(audio.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, expanded]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = Math.min(1, Math.max(0, volume));
    audio.muted = muted;
    try {
      localStorage.setItem("music.volume", String(volume));
      localStorage.setItem("music.muted", String(muted));
    } catch { /* 隐私模式下忽略 */ }
  }, [volume, muted]);

  useEffect(() => { try { localStorage.setItem("music.shuffle", String(shuffle)); } catch { /* 忽略 */ } }, [shuffle]);
  useEffect(() => { try { localStorage.setItem("music.repeat", repeat); } catch { /* 忽略 */ } }, [repeat]);

  const playAt = useCallback((list: MusicTrack[], position: number) => {
    const target = list[position];
    if (!target) return;
    shouldPlay.current = true;
    setQueue(list);
    setIndex(position);
    setPlayRequest((value) => value + 1);
  }, []);

  const goNext = useCallback((auto = false) => {
    if (!queue.length) return;
    shouldPlay.current = true;
    if (shuffle) { setIndex(Math.floor(Math.random() * queue.length)); return; }
    setIndex((current) => {
      if (current + 1 < queue.length) return current + 1;
      if (repeat === "all") return 0;
      if (auto) shouldPlay.current = false;
      return current;
    });
  }, [queue.length, shuffle, repeat]);

  const goPrev = useCallback(() => {
    const audio = audioRef.current;
    if (audio && audio.currentTime > 3) { audio.currentTime = 0; setCurrentTime(0); return; }
    if (!queue.length) return;
    shouldPlay.current = true;
    setIndex((current) => (shuffle ? Math.floor(Math.random() * queue.length) : (current - 1 + queue.length) % queue.length));
  }, [queue.length, shuffle]);

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio || !trackPath) return;
    if (audio.paused) {
      shouldPlay.current = true;
      void audio.play().catch(() => { shouldPlay.current = false; setPlaying(false); onNotify("无法播放这首曲目，系统可能不支持该格式"); });
    } else {
      shouldPlay.current = false;
      audio.pause();
    }
  }

  function handleEnded() {
    if (repeat === "one") {
      const audio = audioRef.current;
      if (audio) { audio.currentTime = 0; void audio.play().catch(() => setPlaying(false)); }
      return;
    }
    goNext(true);
  }

  function seek(time: number) {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(time)) return;
    audio.currentTime = time;
    setCurrentTime(time);
  }

  /* ---------------- 歌单 ---------------- */

  const trackMap = useMemo(() => new Map((library?.tracks || []).map((item) => [item.path, item])), [library]);

  function tracksOfPlaylist(playlist: MusicPlaylist) {
    return playlist.items.map((item) => trackMap.get(item.path)).filter((item): item is MusicTrack => Boolean(item));
  }

  async function addToPlaylist(playlistId: string, item: MusicTrack) {
    try {
      const result = await api<{ added: number }>(`/api/music/playlists/${playlistId}/items`, { method: "POST", body: JSON.stringify({ paths: [item.path] }) });
      await loadPlaylists();
      onNotify(result.added ? `已加入歌单：${item.title}` : "这首歌已经在歌单里了");
    } catch (error) { onNotify((error as Error).message); }
  }

  async function createPlaylist() {
    const name = newPlaylistName.trim();
    if (!name) return;
    try {
      await api("/api/music/playlists", { method: "POST", body: JSON.stringify({ name }) });
      setNewPlaylistName("");
      await loadPlaylists();
      onNotify(`歌单「${name}」已创建`);
    } catch (error) { onNotify((error as Error).message); }
  }

  async function deletePlaylist(playlist: MusicPlaylist) {
    try {
      await api(`/api/music/playlists/${playlist.id}`, { method: "DELETE" });
      await loadPlaylists();
      onNotify(`歌单「${playlist.name}」已删除`);
    } catch (error) { onNotify((error as Error).message); }
  }

  async function removeFromPlaylist(playlist: MusicPlaylist, item: MusicTrack) {
    try {
      await api(`/api/music/playlists/${playlist.id}/items`, { method: "DELETE", body: JSON.stringify({ path: item.path }) });
      await loadPlaylists();
    } catch (error) { onNotify((error as Error).message); }
  }

  /* ---------------- 歌词 ---------------- */

  useEffect(() => {
    if (!trackPath) { setLyrics(null); return; }
    let alive = true;
    api<MusicLyrics>(`/api/music/lyrics?path=${encodeURIComponent(trackPath)}`)
      .then((data) => { if (alive) setLyrics(data); })
      .catch(() => { if (alive) setLyrics(null); });
    return () => { alive = false; };
  }, [trackPath]);

  const activeLine = useMemo(() => {
    const lines = lyrics?.lines || [];
    let found = -1;
    for (let position = 0; position < lines.length; position += 1) {
      if (lines[position].time <= currentTime + 0.12) found = position;
      else break;
    }
    return found;
  }, [lyrics, currentTime]);

  const sungWords = useMemo(() => {
    const words = activeLine >= 0 ? lyrics?.lines[activeLine]?.words : null;
    if (!words) return 0;
    let count = 0;
    for (const word of words) { if (word.time <= currentTime + 0.05) count += 1; else break; }
    return count;
  }, [activeLine, lyrics, currentTime]);

  useEffect(() => {
    if (!expanded || activeLine < 0) return;
    lyricRefs.current[activeLine]?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeLine, expanded]);

  /* ---------------- 列表 ---------------- */

  const filteredTracks = useMemo(() => {
    const source = library?.tracks || [];
    const keyword = query.trim().toLowerCase();
    if (!keyword) return source;
    return source.filter((item) => [item.title, item.artist, item.album, item.name, item.folder]
      .some((value) => typeof value === "string" && value.toLowerCase().includes(keyword)));
  }, [library, query]);

  const coverSrc = track && track.hasCover && service ? musicEndpoint(service, "cover", track.path) : "";
  const progressMax = Math.max(1, duration || track?.duration || 0);
  const progressValue = Math.min(currentTime, progressMax);
  const progressPercent = `${Math.round((progressValue / progressMax) * 1000) / 10}%`;
  const volumePercent = `${Math.round((muted ? 0 : volume) * 100)}%`;
  const status = library?.status || settings.status;
  const emptyMessage = status === "unset" ? "还没有选择音乐目录"
    : status === "missing" ? "音乐目录不可用，可能已被移动或删除"
      : status === "denied" ? "系统拒绝了音乐目录的访问权限，请在设置中重新选择"
        : status === "empty" ? "这个目录里还没有音乐文件"
          : "";

  return <section className={expanded ? "music-player expanded" : "music-player"}>
    {expanded && <div className="music-panel">
      <div className="music-panel-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={panel === "queue"} className={panel === "queue" ? "active" : ""} onClick={() => setPanel("queue")}>正在播放 <small>{queue.length}</small></button>
        <button type="button" role="tab" aria-selected={panel === "library"} className={panel === "library" ? "active" : ""} onClick={() => setPanel("library")}>音乐库 <small>{library?.tracks.length || 0}</small></button>
        <button type="button" role="tab" aria-selected={panel === "playlists"} className={panel === "playlists" ? "active" : ""} onClick={() => setPanel("playlists")}>歌单 <small>{playlists.length}</small></button>
        <div className="music-panel-actions">
          <button type="button" onClick={() => { void loadLibrary(); onReloadSettings(); }} disabled={loading}>{loading ? "扫描中…" : "重新扫描"}</button>
          <button type="button" className="music-icon-button" aria-label="收起播放器" title="收起" onClick={() => setExpanded(false)}><ChevronDownIcon /></button>
        </div>
      </div>
      <div className="music-panel-body">
        {panel === "queue" && <div className="music-list">
          {queue.length ? queue.map((item, position) => <button type="button" key={`${item.path}-${position}`} className={position === index ? "music-row active" : "music-row"} onClick={() => playAt(queue, position)}>
            <span className="music-row-index">{position === index && playing ? "▶" : position + 1}</span>
            <span className="music-row-main"><b>{item.title}</b><small>{item.artist || item.album || item.folder || "未知艺术家"}</small></span>
            <span className="music-row-time">{formatTime(item.duration ?? 0)}</span>
          </button>) : <p className="music-empty">{emptyMessage || "队列为空"}{emptyMessage && <button type="button" onClick={onOpenSettings}>去设置</button>}</p>}
        </div>}
        {panel === "library" && <div className="music-list">
          <div className="music-search"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、艺术家、专辑或文件名" aria-label="搜索音乐" /></div>
          {filteredTracks.length ? filteredTracks.map((item, position) => <div key={item.path} className={item.path === trackPath ? "music-row active" : "music-row"}>
            <button type="button" className="music-row-open" onClick={() => { setQueueLabel("音乐库"); playAt(filteredTracks, position); }}>
              <span className="music-row-main"><b>{item.title}</b><small>{item.artist || item.album || item.folder || "未知艺术家"}</small></span>
              <span className="music-row-time">{formatTime(item.duration ?? 0)}</span>
            </button>
            <select className="music-row-add" value="" aria-label={`把 ${item.title} 加入歌单`} onChange={(event) => { const value = event.target.value; event.target.value = ""; if (value) void addToPlaylist(value, item); }}>
              <option value="">＋</option>
              {playlists.map((playlist) => <option key={playlist.id} value={playlist.id}>{playlist.name}</option>)}
            </select>
          </div>) : <p className="music-empty">{emptyMessage || (query ? "没有匹配的曲目" : "音乐库为空")}{emptyMessage && <button type="button" onClick={onOpenSettings}>去设置</button>}</p>}
        </div>}
        {panel === "playlists" && <div className="music-list">
          <div className="music-search"><input value={newPlaylistName} onChange={(event) => setNewPlaylistName(event.target.value)} placeholder="新建歌单名称" aria-label="新建歌单名称" onKeyDown={(event) => { if (event.key === "Enter") void createPlaylist(); }} /><button type="button" onClick={() => void createPlaylist()} disabled={!newPlaylistName.trim()}>新建</button></div>
          {playlists.length ? playlists.map((playlist) => {
            const items = tracksOfPlaylist(playlist);
            return <div className="music-playlist" key={playlist.id}>
              <div className="music-playlist-head">
                <button type="button" className="music-row-open" onClick={() => { setQueueLabel(playlist.name); playAt(items, 0); }} disabled={!items.length}>
                  <span className="music-row-main"><b>{playlist.name}</b><small>{items.length} 首{playlist.count !== items.length ? `（${playlist.count - items.length} 首不在当前目录）` : ""}</small></span>
                </button>
                <button type="button" className="danger" onClick={() => void deletePlaylist(playlist)}>删除</button>
              </div>
              {items.length > 0 && <div className="music-playlist-items">{items.map((item, position) => <div className="music-row sub" key={item.path}>
                <button type="button" className="music-row-open" onClick={() => { setQueueLabel(playlist.name); playAt(items, position); }}><span className="music-row-main"><b>{item.title}</b><small>{item.artist || "未知艺术家"}</small></span></button>
                <button type="button" className="icon" aria-label="从歌单移除" onClick={() => void removeFromPlaylist(playlist, item)}>×</button>
              </div>)}</div>}
            </div>;
          }) : <p className="music-empty">还没有歌单。在「音乐库」里用 ＋ 把曲目加入歌单。</p>}
        </div>}
        <div className="music-lyrics">
          <header><b>歌词</b>{lyrics?.kind === "word" && <span className="music-badge">逐字跟唱</span>}{lyrics?.kind === "line" && <span className="music-badge plain">逐行歌词</span>}<small>{lyrics?.source === "lrc" ? "同名 .lrc 文件" : lyrics?.source ? "内嵌歌词" : ""}</small></header>
          <div className="music-lyrics-body">
            {lyrics?.lines.length ? lyrics.lines.map((line, position) => <p
              key={`${line.time}-${position}`}
              ref={(element) => { lyricRefs.current[position] = element; }}
              className={position === activeLine ? "music-lyric-line active" : position < activeLine ? "music-lyric-line past" : "music-lyric-line"}
              onClick={() => seek(line.time)}
            >{line.words && position === activeLine
              ? line.words.map((word, wordIndex) => <span key={`${word.time}-${wordIndex}`} className={wordIndex < sungWords ? "sung" : ""}>{word.text}</span>)
              : (line.text || "♪")}</p>)
              : <p className="music-empty">{track ? "这首歌没有歌词。把同名 .lrc 文件放在音频旁边，或用音乐软件写入内嵌歌词即可显示。" : "选择一首歌后显示歌词"}</p>}
          </div>
        </div>
      </div>
    </div>}

    <div className="music-bar">
      <div className="music-now">
        <span className="music-cover">{coverSrc ? <img src={coverSrc} alt="" onError={(event) => { event.currentTarget.style.display = "none"; }} /> : <i><MusicNoteIcon /></i>}</span>
        <div className="music-now-text"><b>{track ? track.title : "洛神赋音乐"}</b><small>{track ? (track.artist || track.album || track.folder || "未知艺术家") : (emptyMessage || "从音乐库选择一首播放")}</small></div>
      </div>
      <div className="music-controls">
        <button type="button" className="music-icon-button" aria-label="上一首" title="上一首" onClick={goPrev} disabled={!queue.length}><PrevIcon /></button>
        <button type="button" className="music-play" aria-label={playing ? "暂停" : "播放"} title={playing ? "暂停" : "播放"} onClick={togglePlay} disabled={!trackPath}>{playing ? <PauseIcon /> : <PlayIcon />}</button>
        <button type="button" className="music-icon-button" aria-label="下一首" title="下一首" onClick={() => goNext(false)} disabled={!queue.length}><NextIcon /></button>
        <div className="music-progress">
          <span>{formatTime(currentTime)}</span>
          <input type="range" min={0} max={progressMax} step={0.1} value={progressValue} style={{ "--music-fill": progressPercent } as CSSProperties} aria-label="播放进度" onChange={(event) => seek(Number(event.target.value))} />
          <span>{formatTime(progressMax)}</span>
        </div>
      </div>
      <div className="music-extra">
        {!trackPath && emptyMessage && <button type="button" className="music-setup" onClick={onOpenSettings}>去设置</button>}
        <button type="button" className={shuffle ? "music-icon-button active" : "music-icon-button"} aria-pressed={shuffle} title="随机播放" onClick={() => setShuffle((value) => !value)}><ShuffleIcon /></button>
        <button type="button" className={repeat !== "off" ? "music-icon-button active" : "music-icon-button"} title={repeatLabel[repeat]} onClick={() => setRepeat((value) => repeatOrder[(repeatOrder.indexOf(value) + 1) % repeatOrder.length])}><RepeatIcon />{repeat === "one" && <em>1</em>}</button>
        <button type="button" className={muted ? "music-icon-button active" : "music-icon-button"} aria-label={muted ? "取消静音" : "静音"} title={muted ? "取消静音" : "静音"} onClick={() => setMuted((value) => !value)}>{muted ? <VolumeOffIcon /> : <VolumeIcon />}</button>
        <input className="music-volume" type="range" min={0} max={1} step={0.02} value={muted ? 0 : volume} style={{ "--music-fill": volumePercent } as CSSProperties} aria-label="音量" onChange={(event) => { setMuted(false); setVolume(Number(event.target.value)); }} />
        <span className="music-divider" aria-hidden="true" />
        <button type="button" className={expanded ? "music-icon-button active" : "music-icon-button"} aria-expanded={expanded} title={expanded ? "收起歌词与列表" : "展开歌词与列表"} onClick={() => setExpanded((value) => !value)}>{expanded ? <ChevronDownIcon /> : <ChevronUpIcon />}</button>
        <button type="button" className="music-icon-button" aria-label="隐藏播放器" title="隐藏播放器（可在设置中重新开启）" onClick={async () => {
          try { await api("/api/music/settings", { method: "POST", body: JSON.stringify({ enabled: false }) }); await onReloadSettings(); onNotify("播放器已隐藏，可在设置中重新开启"); }
          catch (error) { onNotify((error as Error).message); }
        }}><CloseIcon /></button>
        <span className="music-queue-label" title={`队列：${queueLabel}`}>{queueLabel}</span>
      </div>
    </div>
    <audio
      ref={audioRef}
      src={src || undefined}
      preload="metadata"
      onPlay={() => setPlaying(true)}
      onPause={() => setPlaying(false)}
      onEnded={handleEnded}
      onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
      onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
      onError={() => { if (src) { shouldPlay.current = false; setPlaying(false); } }}
    />
  </section>;
}
