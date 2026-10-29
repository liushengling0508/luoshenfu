import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SKIN_ID,
  MAX_WALLPAPER_CHARS,
  builtinSkins,
  customFromSkin,
  defaultCustomSkin,
  exportSkin,
  importSkin,
  isDarkColor,
  isHexColor,
  isWallpaperImage,
  materialIds,
  migrateLegacyAppearance,
  normalizeCustomSkin,
  parseCustomSkin,
  patchCustomSkin,
  radiusIds,
  resolveActiveSkin,
  selectCustomSkin,
  selectPresetSkin,
  serializeCustomSkin,
  skinById,
  themeIds,
  wallpaperBackgrounds,
  wallpaperDefaults,
  wallpaperIds,
} from "../web/src/skins.ts";

test("内置皮肤目录完整且唯一", () => {
  const ids = builtinSkins.map((skin) => skin.id);
  assert.equal(new Set(ids).size, ids.length, "皮肤 id 不应重复");
  assert.ok(ids.includes(DEFAULT_SKIN_ID), "默认皮肤必须存在");
  for (const skin of builtinSkins) {
    assert.ok(themeIds.includes(skin.theme), `${skin.id} 的主题非法`);
    assert.ok(wallpaperIds.includes(skin.wallpaper), `${skin.id} 的壁纸非法`);
    assert.ok(materialIds.includes(skin.material), `${skin.id} 的材质非法`);
    assert.ok(radiusIds.includes(skin.radius), `${skin.id} 的圆角非法`);
    assert.ok(isHexColor(skin.background), `${skin.id} 的背景色非法`);
    assert.ok(isHexColor(skin.accent), `${skin.id} 的强调色非法`);
  }
});

test("每套壁纸都有背景值与默认透明度", () => {
  for (const id of wallpaperIds) {
    assert.ok(wallpaperDefaults[id], `${id} 缺少默认透明度`);
    if (id !== "custom") assert.equal(typeof wallpaperBackgrounds[id], "string");
  }
});

test("预置皮肤解析为完整的生效皮肤", () => {
  const preset = builtinSkins.find((skin) => skin.wallpaper !== "none");
  assert.ok(preset, "应存在带壁纸的预置皮肤");
  const active = resolveActiveSkin({ skinId: preset.id, custom: defaultCustomSkin() });
  assert.equal(active.id, preset.id);
  assert.equal(active.theme, preset.theme);
  assert.equal(active.wallpaperOpacity, wallpaperDefaults[preset.wallpaper].opacity);
  assert.equal(active.wallpaperBlur, wallpaperDefaults[preset.wallpaper].blur);
  assert.equal(active.wallpaperImage, "");
});

test("未知皮肤回退到默认皮肤", () => {
  const active = resolveActiveSkin({ skinId: "missing", custom: defaultCustomSkin() });
  assert.equal(active.id, DEFAULT_SKIN_ID);
});

test("自定义皮肤覆盖预置字段并固定为 custom 主题", () => {
  const custom = {
    ...customFromSkin(skinById("ying-fen")),
    background: "#101820",
    accent: "#ff0066",
    material: "flat",
    radius: "sharp",
    wallpaper: "custom",
    wallpaperImage: "data:image/png;base64,AAAA",
    wallpaperOpacity: 33,
    wallpaperBlur: 12,
    wallpaperScrim: 70,
  };
  const active = resolveActiveSkin({ skinId: "custom", custom });
  assert.equal(active.theme, "custom");
  assert.equal(active.background, "#101820");
  assert.equal(active.accent, "#ff0066");
  assert.equal(active.wallpaper, "custom");
  assert.equal(active.wallpaperImage, "data:image/png;base64,AAAA");
  assert.equal(active.wallpaperOpacity, 33);
  assert.equal(active.wallpaperBlur, 12);
  assert.equal(active.wallpaperScrim, 70);
  assert.equal(active.material, "flat");
  assert.equal(active.radius, "sharp");
});

test("自定义皮肤清洗非法字段并收敛数值", () => {
  const fallback = defaultCustomSkin(skinById("hai-yan"));
  const dirty = normalizeCustomSkin(
    { baseId: "nope", background: "red", accent: "#ABCDEF", material: "neon", radius: 7, wallpaperOpacity: 999, wallpaperBlur: -4, wallpaperScrim: 500, wallpaper: "custom", wallpaperImage: "javascript:alert(1)" },
    fallback,
  );
  assert.equal(dirty.baseId, fallback.baseId);
  assert.equal(dirty.background, fallback.background);
  assert.equal(dirty.accent, "#abcdef");
  assert.equal(dirty.material, fallback.material);
  assert.equal(dirty.radius, fallback.radius);
  assert.equal(dirty.wallpaperOpacity, 100);
  assert.equal(dirty.wallpaperBlur, 0);
  assert.equal(dirty.wallpaperScrim, 90);
  assert.equal(dirty.wallpaperImage, "");
  assert.equal(dirty.wallpaper, "custom", "没有图片时保留自定义壁纸选择，等待用户上传");
});

test("壁纸图片必须是受支持的内联图片且不超过体积上限", () => {
  assert.ok(isWallpaperImage("data:image/webp;base64,AAAA"));
  assert.ok(isWallpaperImage("data:image/jpeg;base64,AAAA"));
  assert.ok(!isWallpaperImage("data:text/html;base64,AAAA"));
  assert.ok(!isWallpaperImage("https://example.com/a.png"));
  assert.ok(!isWallpaperImage(`data:image/png;base64,${"A".repeat(MAX_WALLPAPER_CHARS)}`));
});

test("旧版外观设置迁移到皮肤状态", () => {
  assert.equal(migrateLegacyAppearance({ theme: "dark" }).skinId, "xing-ye");
  assert.equal(migrateLegacyAppearance({ theme: "teal" }).skinId, "qing-mo");
  assert.equal(migrateLegacyAppearance({ theme: "" }).skinId, DEFAULT_SKIN_ID);
  const custom = migrateLegacyAppearance({ theme: "custom", background: "#123456", accent: "#654321" });
  assert.equal(custom.skinId, "custom");
  assert.equal(custom.custom.background, "#123456");
  assert.equal(custom.custom.accent, "#654321");
});

test("自定义皮肤序列化可往返且能容忍脏数据", () => {
  const custom = { ...customFromSkin(skinById("mo-yun")), wallpaperOpacity: 44 };
  assert.deepEqual(parseCustomSkin(serializeCustomSkin(custom)), custom);
  assert.equal(parseCustomSkin("{ not json"), null);
  assert.equal(parseCustomSkin(""), null);
});

test("皮肤文件导出后可再次导入", () => {
  const state = {
    skinId: "custom",
    custom: {
      ...customFromSkin(skinById("xing-ye")),
      background: "#0b1020",
      accent: "#22d3ee",
      wallpaper: "custom",
      wallpaperImage: "data:image/png;base64,QUJD",
      wallpaperOpacity: 70,
      wallpaperBlur: 8,
      wallpaperScrim: 72,
    },
  };
  const text = exportSkin(state);
  const parsed = JSON.parse(text);
  assert.equal(parsed.format, "luoshenfu.skin");
  assert.equal(parsed.version, 1);
  assert.equal(parsed.wallpaperImage, "data:image/png;base64,QUJD");
  const restored = importSkin(text);
  assert.equal(restored.skinId, "custom");
  assert.equal(restored.custom.background, "#0b1020");
  assert.equal(restored.custom.accent, "#22d3ee");
  assert.equal(restored.custom.wallpaper, "custom");
  assert.equal(restored.custom.wallpaperImage, "data:image/png;base64,QUJD");
  assert.equal(restored.custom.wallpaperOpacity, 70);
  assert.equal(restored.custom.wallpaperBlur, 8);
  assert.equal(restored.custom.wallpaperScrim, 72);
});

test("导出预置皮肤不会携带空图片", () => {
  const file = JSON.parse(exportSkin({ skinId: "hai-yan", custom: defaultCustomSkin() }));
  assert.equal(file.name, "海盐");
  assert.equal(file.wallpaperImage, "");
  assert.equal(file.format, "luoshenfu.skin");
});

test("导入会拒绝非皮肤文件", () => {
  assert.throws(() => importSkin("{ not json"), /有效的皮肤文件/);
  assert.throws(() => importSkin("这是一张图片的二进制内容"), /有效的皮肤文件/);
  assert.throws(() => importSkin('{"format":"other"}'), /洛神赋皮肤文件/);
});

test("切换内置皮肤不会丢失已保存的自定义皮肤与壁纸", () => {
  const custom = {
    ...customFromSkin(skinById("hai-yan")),
    wallpaper: "custom",
    wallpaperImage: "data:image/png;base64,QUJD",
    wallpaperOpacity: 66,
    material: "flat",
  };
  const start = { skinId: "custom", custom };
  const preset = selectPresetSkin(start, "xing-ye");
  assert.equal(preset.skinId, "xing-ye");
  assert.equal(preset.custom.wallpaperImage, "data:image/png;base64,QUJD");
  assert.equal(preset.custom.wallpaperOpacity, 66);
  const back = selectCustomSkin(preset);
  assert.equal(back.skinId, "custom");
  assert.equal(back.custom.wallpaperImage, "data:image/png;base64,QUJD");
  const patched = patchCustomSkin(preset, { wallpaperBlur: 9 });
  assert.equal(patched.skinId, "custom");
  assert.equal(patched.custom.wallpaperBlur, 9);
  assert.equal(patched.custom.wallpaperImage, "data:image/png;base64,QUJD");
  assert.equal(selectPresetSkin(start, "不存在").skinId, "custom");
});

test("深浅底色判断用于自定义主题对比度", () => {
  assert.ok(isDarkColor("#060914"));
  assert.ok(!isDarkColor("#f3f6fb"));
  assert.ok(!isDarkColor("red"));
});
