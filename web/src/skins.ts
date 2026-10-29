// 洛神赋皮肤模型：一套皮肤 = 主题色板 + 壁纸 + 材质 + 圆角。
// 这里只放纯逻辑与内置皮肤，方便单元测试；localStorage 读写留在 App.tsx。

export type ThemeId = "light" | "dark" | "mist" | "violet" | "amber" | "teal" | "custom";
export type SkinMaterial = "glass" | "solid" | "flat";
export type SkinRadius = "sharp" | "soft" | "round";
export type WallpaperId = "none" | "aurora" | "mesh" | "grid" | "dots" | "waves" | "linen" | "custom";

export type Skin = {
  id: string;
  name: string;
  description: string;
  theme: ThemeId;
  background: string;
  accent: string;
  wallpaper: WallpaperId;
  material: SkinMaterial;
  radius: SkinRadius;
};

export type CustomSkin = {
  baseId: string;
  background: string;
  accent: string;
  wallpaper: WallpaperId;
  wallpaperImage: string;
  wallpaperOpacity: number;
  wallpaperBlur: number;
  wallpaperScrim: number;
  material: SkinMaterial;
  radius: SkinRadius;
};

export type SkinState = { skinId: string; custom: CustomSkin };

export type ActiveSkin = Skin & {
  wallpaperImage: string;
  wallpaperOpacity: number;
  wallpaperBlur: number;
  wallpaperScrim: number;
};

// localStorage 各浏览器按字符计配额（WebKit 约 5MB 字节），壁纸使用 data URL，
// 这里限制在约 1.2MB 字符串以内，给头像等其它本机设置留出空间。
export const MAX_WALLPAPER_CHARS = 1_200_000;
export const DEFAULT_SKIN_ID = "hai-yan";
// 壁纸遮罩：在壁纸上叠一层主题底色，把照片细节压下去，保证任何壁纸都能和界面融合。
export const DEFAULT_WALLPAPER_SCRIM = 46;
export const MAX_WALLPAPER_SCRIM = 90;

export const wallpaperIds: WallpaperId[] = ["none", "aurora", "mesh", "grid", "dots", "waves", "linen", "custom"];
export const materialIds: SkinMaterial[] = ["glass", "solid", "flat"];
export const radiusIds: SkinRadius[] = ["sharp", "soft", "round"];
export const themeIds: ThemeId[] = ["light", "dark", "mist", "violet", "amber", "teal", "custom"];

export const wallpaperOptions: { id: WallpaperId; name: string }[] = [
  { id: "none", name: "无" },
  { id: "aurora", name: "极光" },
  { id: "mesh", name: "渐变" },
  { id: "grid", name: "网格" },
  { id: "dots", name: "圆点" },
  { id: "waves", name: "波纹" },
  { id: "linen", name: "亚麻" },
  { id: "custom", name: "自定义图片" },
];

export const materialOptions: { id: SkinMaterial; name: string; hint: string }[] = [
  { id: "glass", name: "玻璃", hint: "半透明 + 模糊" },
  { id: "solid", name: "纯色", hint: "不透明表面" },
  { id: "flat", name: "扁平", hint: "去掉渐变与阴影" },
];

export const radiusOptions: { id: SkinRadius; name: string }[] = [
  { id: "sharp", name: "直角" },
  { id: "soft", name: "圆润" },
  { id: "round", name: "大圆角" },
];

// 壁纸使用完整的 background 简写，位置 / 尺寸都写在值里，方便同一份数据同时用于实况背景与预览。
export const wallpaperBackgrounds: Record<Exclude<WallpaperId, "custom">, string> = {
  none: "transparent",
  aurora:
    "radial-gradient(120% 90% at 12% 8%, rgba(124, 108, 240, .55), transparent 60%), radial-gradient(90% 80% at 88% 22%, rgba(34, 211, 238, .40), transparent 62%), radial-gradient(120% 120% at 60% 110%, rgba(217, 79, 131, .34), transparent 60%)",
  mesh:
    "radial-gradient(70% 70% at 20% 20%, rgba(80, 120, 255, .34), transparent 60%), radial-gradient(60% 60% at 78% 30%, rgba(20, 184, 166, .28), transparent 60%), radial-gradient(90% 90% at 55% 92%, rgba(147, 51, 234, .26), transparent 60%)",
  grid:
    "linear-gradient(rgba(120, 140, 190, .24) 1px, transparent 1px) 0 0 / 34px 34px, linear-gradient(90deg, rgba(120, 140, 190, .24) 1px, transparent 1px) 0 0 / 34px 34px",
  dots: "radial-gradient(rgba(140, 160, 205, .40) 1.2px, transparent 1.4px) 0 0 / 22px 22px",
  waves:
    "repeating-linear-gradient(115deg, rgba(56, 189, 200, .16) 0 2px, transparent 2px 26px), repeating-linear-gradient(65deg, rgba(99, 102, 241, .14) 0 2px, transparent 2px 30px)",
  linen:
    "repeating-linear-gradient(0deg, rgba(150, 140, 120, .12) 0 1px, transparent 1px 4px), repeating-linear-gradient(90deg, rgba(150, 140, 120, .12) 0 1px, transparent 1px 4px)",
};

export const wallpaperDefaults: Record<WallpaperId, { opacity: number; blur: number }> = {
  none: { opacity: 0, blur: 0 },
  aurora: { opacity: 60, blur: 0 },
  mesh: { opacity: 52, blur: 0 },
  grid: { opacity: 34, blur: 0 },
  dots: { opacity: 30, blur: 0 },
  waves: { opacity: 46, blur: 0 },
  linen: { opacity: 42, blur: 0 },
  custom: { opacity: 55, blur: 0 },
};

export const builtinSkins: Skin[] = [
  { id: "hai-yan", name: "海盐", description: "清爽冷调的默认皮肤", theme: "mist", background: "#dfeaf7", accent: "#2878d0", wallpaper: "none", material: "glass", radius: "soft" },
  { id: "yao-bai", name: "曜白", description: "明亮干净的纯色界面", theme: "light", background: "#f3f6fb", accent: "#6757e8", wallpaper: "grid", material: "solid", radius: "soft" },
  { id: "xing-ye", name: "星夜", description: "深邃玻璃质感", theme: "dark", background: "#060914", accent: "#8b5cf6", wallpaper: "aurora", material: "glass", radius: "round" },
  { id: "qing-mo", name: "青墨", description: "墨绿与波纹", theme: "teal", background: "#0d2b31", accent: "#16b8b2", wallpaper: "waves", material: "glass", radius: "soft" },
  { id: "nuan-xing", name: "暖杏", description: "温暖米色与亚麻纹理", theme: "amber", background: "#f3e7d8", accent: "#d97832", wallpaper: "linen", material: "solid", radius: "round" },
  { id: "ying-fen", name: "樱粉", description: "柔和粉调与圆点", theme: "violet", background: "#f3e4ec", accent: "#d34f83", wallpaper: "dots", material: "glass", radius: "round" },
  { id: "chen-wu", name: "晨雾", description: "冷调晨光渐变", theme: "mist", background: "#e8eef7", accent: "#4a6cf7", wallpaper: "mesh", material: "solid", radius: "soft" },
  { id: "mo-yun", name: "墨韵", description: "水墨留白的极简风格", theme: "light", background: "#eef2f8", accent: "#2f4858", wallpaper: "linen", material: "flat", radius: "sharp" },
];

export function skinById(id: string): Skin | undefined {
  return builtinSkins.find((skin) => skin.id === id);
}

// 预览与实况都复用同一份壁纸数据；自定义图片壁纸返回透明，由调用方决定是否叠加图片。
export function wallpaperPreviewBackground(wallpaper: WallpaperId): string {
  return wallpaper === "custom" ? "transparent" : wallpaperBackgrounds[wallpaper];
}

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

export function isDarkColor(value: string): boolean {
  if (!isHexColor(value)) return false;
  const color = Number.parseInt(value.slice(1), 16);
  return ((color >> 16) * 299 + ((color >> 8) & 255) * 587 + (color & 255) * 114) / 1000 < 155;
}

export function isWallpaperImage(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= MAX_WALLPAPER_CHARS
    && /^data:image\/(png|jpe?g|webp|gif|avif);base64,/i.test(value);
}

function pickHex(value: unknown, fallback: string): string {
  return isHexColor(value) ? value.toLowerCase() : fallback;
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

export function defaultCustomSkin(base: Skin = builtinSkins[0]): CustomSkin {
  return {
    baseId: base.id,
    background: base.background,
    accent: base.accent,
    wallpaper: base.wallpaper,
    wallpaperImage: "",
    wallpaperOpacity: wallpaperDefaults[base.wallpaper].opacity,
    wallpaperBlur: wallpaperDefaults[base.wallpaper].blur,
    wallpaperScrim: DEFAULT_WALLPAPER_SCRIM,
    material: base.material,
    radius: base.radius,
  };
}

export function customFromSkin(skin: Skin): CustomSkin {
  return defaultCustomSkin(skin);
}

export function normalizeCustomSkin(input: unknown, fallback: CustomSkin): CustomSkin {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const baseId = typeof record.baseId === "string" && skinById(record.baseId) ? record.baseId : fallback.baseId;
  const wallpaper = pickEnum(record.wallpaper, wallpaperIds, fallback.wallpaper);
  const candidateImage = record.wallpaperImage;
  const wallpaperImage = isWallpaperImage(candidateImage)
    ? candidateImage
    : candidateImage === ""
      ? ""
      : fallback.wallpaperImage;
  const defaults = wallpaperDefaults[wallpaper];
  return {
    baseId,
    background: pickHex(record.background, fallback.background),
    accent: pickHex(record.accent, fallback.accent),
    wallpaper,
    wallpaperImage,
    wallpaperOpacity: clampNumber(record.wallpaperOpacity, 0, 100, defaults.opacity),
    wallpaperBlur: clampNumber(record.wallpaperBlur, 0, 40, defaults.blur),
    wallpaperScrim: clampNumber(record.wallpaperScrim, 0, MAX_WALLPAPER_SCRIM, fallback.wallpaperScrim),
    material: pickEnum(record.material, materialIds, fallback.material),
    radius: pickEnum(record.radius, radiusIds, fallback.radius),
  };
}

export function resolveActiveSkin(state: SkinState): ActiveSkin {
  if (state.skinId !== "custom") {
    const preset = skinById(state.skinId) ?? skinById(DEFAULT_SKIN_ID)!;
    const defaults = wallpaperDefaults[preset.wallpaper];
    return { ...preset, wallpaperImage: "", wallpaperOpacity: defaults.opacity, wallpaperBlur: defaults.blur, wallpaperScrim: DEFAULT_WALLPAPER_SCRIM };
  }
  const custom = normalizeCustomSkin(state.custom, defaultCustomSkin(skinById(DEFAULT_SKIN_ID)));
  return {
    id: "custom",
    name: "自定义",
    description: "在本机微调并自动保存",
    theme: "custom",
    background: custom.background,
    accent: custom.accent,
    wallpaper: custom.wallpaper,
    material: custom.material,
    radius: custom.radius,
    wallpaperImage: custom.wallpaperImage,
    wallpaperOpacity: custom.wallpaperOpacity,
    wallpaperBlur: custom.wallpaperBlur,
    wallpaperScrim: custom.wallpaperScrim,
  };
}

// 切换皮肤只改变“当前选中项”，绝不覆盖用户已保存的自定义皮肤（含上传的壁纸）。
export function selectPresetSkin(state: SkinState, id: string): SkinState {
  const preset = skinById(id);
  return preset ? { skinId: preset.id, custom: state.custom } : state;
}

export function selectCustomSkin(state: SkinState): SkinState {
  return state.skinId === "custom" ? state : { ...state, skinId: "custom" };
}

export function patchCustomSkin(state: SkinState, patch: Partial<CustomSkin>): SkinState {
  return { skinId: "custom", custom: { ...state.custom, ...patch } };
}

// 旧版只保存 theme / background / accent，这里把老设置平滑迁移到皮肤状态。
const legacyThemeSkin: Record<string, string> = {
  light: "yao-bai",
  dark: "xing-ye",
  mist: "hai-yan",
  violet: "ying-fen",
  amber: "nuan-xing",
  teal: "qing-mo",
};

export function migrateLegacyAppearance(legacy: { theme?: unknown; background?: unknown; accent?: unknown }): SkinState {
  const fallback = skinById(DEFAULT_SKIN_ID)!;
  const theme = typeof legacy.theme === "string" ? legacy.theme : "";
  if (theme === "custom") {
    const custom = {
      ...defaultCustomSkin(fallback),
      background: pickHex(legacy.background, fallback.background),
      accent: pickHex(legacy.accent, fallback.accent),
    };
    return { skinId: "custom", custom };
  }
  const skin = skinById(legacyThemeSkin[theme] ?? "") ?? fallback;
  const custom = {
    ...defaultCustomSkin(skin),
    background: pickHex(legacy.background, skin.background),
    accent: pickHex(legacy.accent, skin.accent),
  };
  return { skinId: skin.id, custom };
}

export function parseCustomSkin(raw: string | null | undefined): CustomSkin | null {
  if (!raw) return null;
  try {
    return normalizeCustomSkin(JSON.parse(raw), defaultCustomSkin());
  } catch {
    return null;
  }
}

export function serializeCustomSkin(custom: CustomSkin): string {
  return JSON.stringify(normalizeCustomSkin(custom, defaultCustomSkin()));
}

export type SkinFile = {
  format: "luoshenfu.skin";
  version: number;
  name: string;
  theme: ThemeId;
  background: string;
  accent: string;
  wallpaper: WallpaperId;
  material: SkinMaterial;
  radius: SkinRadius;
  wallpaperImage: string;
  wallpaperOpacity: number;
  wallpaperBlur: number;
  wallpaperScrim: number;
};

export function exportSkin(state: SkinState): string {
  const active = resolveActiveSkin(state);
  const file: SkinFile = {
    format: "luoshenfu.skin",
    version: 1,
    name: state.skinId === "custom" ? "自定义皮肤" : active.name,
    theme: active.theme,
    background: active.background,
    accent: active.accent,
    wallpaper: active.wallpaper,
    material: active.material,
    radius: active.radius,
    wallpaperImage: active.wallpaper === "custom" ? active.wallpaperImage : "",
    wallpaperOpacity: active.wallpaperOpacity,
    wallpaperBlur: active.wallpaperBlur,
    wallpaperScrim: active.wallpaperScrim,
  };
  return JSON.stringify(file, null, 2);
}

export function importSkin(text: string): SkinState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("这不是有效的皮肤文件，请选择由“导出当前皮肤”生成的 .json 文件");
  }
  if (!parsed || typeof parsed !== "object" || (parsed as { format?: unknown }).format !== "luoshenfu.skin") {
    throw new Error("这不是洛神赋皮肤文件");
  }
  const record = parsed as Record<string, unknown>;
  const base = skinById(DEFAULT_SKIN_ID)!;
  const wallpaper = pickEnum(record.wallpaper, wallpaperIds, base.wallpaper);
  const wallpaperImage = isWallpaperImage(record.wallpaperImage) ? record.wallpaperImage : "";
  const defaults = wallpaperDefaults[wallpaper];
  const custom: CustomSkin = {
    baseId: base.id,
    background: pickHex(record.background, base.background),
    accent: pickHex(record.accent, base.accent),
    wallpaper,
    wallpaperImage,
    wallpaperOpacity: clampNumber(record.wallpaperOpacity, 0, 100, defaults.opacity),
    wallpaperBlur: clampNumber(record.wallpaperBlur, 0, 40, defaults.blur),
    wallpaperScrim: clampNumber(record.wallpaperScrim, 0, MAX_WALLPAPER_SCRIM, DEFAULT_WALLPAPER_SCRIM),
    material: pickEnum(record.material, materialIds, base.material),
    radius: pickEnum(record.radius, radiusIds, base.radius),
  };
  return { skinId: "custom", custom };
}
