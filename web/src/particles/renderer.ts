// 贾维斯的粒子渲染器。
//
// 目标是"星云"，不是"球"。立体感来自三件事：
//   1. 透视投影——近大远小。正交投影会把云压成一张纸。
//   2. 大气透视——背面的粒子被雾吞掉，前面明亮，纵深由此产生。
//   3. 体积分布——点云本身没有壳（见 geometry.ts），渲染层再叠一层柔性衰减，
//      让相邻粒子融成连续的云，而不是一颗颗孤立的点。
// 科技感来自 Bloom：粒子先渲染到离屏纹理，两轮高斯模糊后叠加回画面。

import type { PointCloud } from "./geometry";
import { avatarStateCode, type AvatarState } from "./state";

const sceneVertexShader = `#version 300 es
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_seed;
layout(location = 2) in float a_size;
layout(location = 3) in float a_kind;

uniform float u_time;
uniform float u_dpr;
uniform float u_pointScale;
uniform float u_extent;
uniform float u_state;
uniform float u_energy;
uniform float u_radius;
uniform float u_pulse;
uniform float u_light;
uniform vec3 u_accent;

out float v_bright;
out vec3 v_color;

mat3 rotateY(float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
}

mat3 rotateX(float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c);
}

void main() {
  float t = u_time;
  float scale = 1.0;
  float drift = 0.005;
  float flowSpeed = 0.42;

  // 状态只改两组参数：整体尺度与流动速度。粒子自己不做判断。
  if (u_state < 0.5) {
    // 呼吸必须整体同步；带逐粒子随机相位会让相邻粒子反向缩放，看上去是"发抖"。
    scale = 1.0 + sin(t * 0.85) * 0.016;
  } else if (u_state < 1.5) {
    scale = 0.9 + u_energy * 0.16 + sin(t * 3.1) * 0.012;
    drift = 0.008 + u_energy * 0.022;
    flowSpeed = 0.9;
  } else if (u_state < 2.5) {
    scale = 1.05 + sin(t * 2.4) * 0.02;
    drift = 0.018;
    flowSpeed = 1.5;
  } else if (u_state < 3.5) {
    scale = 1.0 + u_energy * 0.3;
    drift = 0.012 + u_energy * 0.02;
    flowSpeed = 1.1;
  } else {
    scale = 1.0 + sin(t * 5.0) * 0.03 + u_energy * 0.12;
    drift = 0.022;
    flowSpeed = 1.9;
  }

  vec3 p = a_position * scale * u_radius;

  // 漂移相位由粒子位置决定，邻近粒子朝相近方向移动，整团云像流体一样起伏。
  vec3 flow = vec3(
    sin(t * flowSpeed + a_position.y * 2.6),
    sin(t * flowSpeed * 0.88 + a_position.z * 2.6),
    sin(t * flowSpeed * 1.13 + a_position.x * 2.6)
  );
  p += flow * drift;

  // 光带以独立于星云的速度环绕。若与星云同速同向，看上去只是云的一部分在动，
  // 而不是"有一道光带绕着转"——a_kind 就是用来把它们分开的。
  // 光带：a_kind 为 1/2 区分两条带。
  //   独立转速——与星云同速同向的话，看上去只是云的一部分在动；
  //   进动——倾斜角缓慢摇摆；固定角度的匀速自转非常呆板。
  float beltMask = step(0.5, a_kind);
  float beltPhase = a_kind - 1.0;
  float spinSpeed = mix(0.85, -0.62, beltPhase);
  float tiltSwing = sin(t * 0.5 + beltPhase * 2.1) * 0.3;
  vec3 rotated = rotateX(0.32 + beltMask * tiltSwing) * rotateY(t * 0.11 + 0.6 + beltMask * t * spinSpeed) * p;

  // 弱透视：近大远小。xy 与点尺寸同时缩放，两者一起才形成体积感。
  float perspective = 1.0 + rotated.z * 0.34;

  // 大气透视：背面的粒子压暗，前面的全亮，纵深因此可见。
  float depth = clamp(rotated.z * 0.5 + 0.5, 0.0, 1.0);
  float fog = mix(0.14 + 0.86 * pow(depth, 1.4), 0.5 + 0.5 * depth, u_light);

  float radius = length(a_position);

  // 能量脉冲：从核心向外扩散的波，让云看起来是"活的"。
  float pulse = pow(0.5 + 0.5 * sin(radius * 3.4 - t * 1.5), 3.0);

  // 颜色层次：白热核心 → 青蓝主体 → 紫蓝外缘。
  // 色相跨度越大越像星云；只在一个色相里打转就会变成一团灰雾。
  // 颜色层次：白热核心 → 青蓝 → 品蓝 → 深紫。
  // 跨色相才有"绚丽"；单一色相无论多亮都会显得寡淡，这是颜色层面最关键的一条。
  float coreMix = 1.0 - smoothstep(0.0, 0.4, radius);
  float midMix = smoothstep(0.1, 0.62, radius);
  float outerMix = smoothstep(0.5, 1.5, radius);
  vec3 base = mix(u_accent, vec3(0.34, 0.88, 1.0), 0.6);
  // 核心带一点冷白，中段走"电光青"，外缘压到深紫——科幻感来自这个冷调跨度。
  vec3 brightColor = mix(vec3(0.92, 0.98, 1.0), base, coreMix);
  brightColor = mix(brightColor, vec3(0.42, 0.72, 1.0), midMix * 0.5);
  brightColor = mix(brightColor, vec3(0.36, 0.2, 0.98), outerMix * 0.9);
  // 浅色底上"发光"是看不见的，必须反过来用深色墨点。
  vec3 inkColor = mix(mix(u_accent * 0.9, u_accent * 0.35, coreMix), u_accent * 0.62, outerMix * 0.7);
  vec3 color = mix(brightColor, inkColor, u_light);

  // 光带比星云更亮更冷，从紫色云里跳出来形成清晰的环。
  if (a_kind > 0.5) color = mix(color, vec3(0.78, 0.93, 1.0), 0.5);

  // 扫描带：一条沿 Y 轴缓慢上下移动的亮带，全息投影的经典动效。
  float sweepDelta = a_position.y * u_radius - (fract(t * 0.07) * 2.6 - 1.3);
  float sweep = exp(-sweepDelta * sweepDelta * 46.0);

  // a_seed.z 是生成时写入的亮度权重（含噪声与半径衰减）。
  v_bright = fog * a_seed.z * (1.0 + pulse * u_pulse * 0.5 + sweep * 1.1);

  // 沿环流动的亮度波：光带因此像在"传输能量"，而不是一圈静止的亮点。
  if (a_kind > 0.5) {
    float beltAngle = atan(p.z, p.x);
    float wave = 0.5 + 0.5 * sin(beltAngle * 2.0 - t * 2.2 + beltPhase * 1.7);
    v_bright *= 0.55 + wave * 0.9;
    // 两条带以拍频一起明灭，像双星互相牵引。各转各的、毫无关系，
    // 正是看起来"散"的根源——联动让它们成为一个系统。
    float beat = 0.5 + 0.5 * cos(t * 1.15);
    v_bright *= 0.68 + beat * 0.72;
  }
  if (u_state > 1.5 && u_state < 2.5) v_bright *= 0.8 + u_energy * 0.55;
  if (u_state > 2.5) v_bright *= 0.85 + u_energy * 0.75;

  // 随机星光闪烁。
  //
  // 两个旋钮要分清：
  //   频率（下面 sin 的系数）——决定同一颗粒子隔多久闪一次；
  //   参与比例（twinkleGate）——决定"同时有多少颗在闪"。
  // 只把频率调低是没用的：相位本来就错开，整体看上去照样一直在闪。
  // 想让星光"少而离散"，必须筛掉大部分粒子，只留一小部分参与。
  float twinkle = 0.0;
  if (a_kind < 0.5) {
    // 约 15% 的粒子参与闪烁（|seed.x| 在 [0,1] 上均匀，超过 0.85 即 15%）。
    float twinkleGate = step(0.85, abs(a_seed.x));
    float twinkleSeed = a_seed.x * 37.0 + a_seed.y * 71.0;
    // 指数越高闪得越短促；频率系数 0.55 对应约 11 秒一轮，比之前的 5.5 秒慢一倍。
    twinkle = pow(0.5 + 0.5 * sin(t * 0.55 + twinkleSeed), 48.0) * twinkleGate;
    // 强度必须克制：闪得太亮会被 Bloom 放大成整片光雾，把颗粒感盖掉。
    v_bright *= 1.0 + twinkle * 2.6;
    // 闪光瞬间偏白。只提亮的话深紫粒子会变成"亮紫色"，那是发光不是闪烁；
    // 星光之所以像星光，靠的就是那一瞬的冷白。
    color = mix(color, vec3(1.0, 0.98, 0.95), twinkle * 0.9);
  }

  v_color = color;

  gl_Position = vec4(rotated.xy * perspective / u_extent, 0.0, 1.0);
  // 尺寸保持不变。之前乘了 (1 + twinkle * 0.5)，粒子会胀成一个更大的圆盘，
  // 看起来像"离子膨胀"——星光只是亮一下，不该变形状。
  gl_PointSize = a_size * u_dpr * u_pointScale * perspective;
}
`;

const sceneFragmentShader = `#version 300 es
precision highp float;

in float v_bright;
in vec3 v_color;

uniform float u_opacity;
uniform float u_gain;
uniform float u_light;

out vec4 fragColor;

void main() {
  vec2 offset = gl_PointCoord - 0.5;
  float distance2 = length(offset) * 2.0;
  if (distance2 > 1.0) discard;

  float falloff = 1.0 - distance2;
  // 星云要"融"不要"粒"：核心留一点实感，边缘大幅柔化，
  // 相邻粒子才会连成连续的云，而不是一颗颗孤立的点。
  float soft = falloff * falloff;
  float alpha = (soft * 0.5 + soft * soft * 0.85) * v_bright * u_opacity * u_gain;
  if (alpha <= 0.002) discard;

  vec3 tint = mix(vec3(1.0), v_color * 0.3, u_light);
  vec3 color = mix(v_color, tint, pow(falloff, 4.0) * 0.5);
  fragColor = vec4(color * alpha, alpha);
}
`;

// 全屏三角形：用 gl_VertexID 直接生成，不需要任何顶点缓冲。
const quadVertexShader = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 position = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = position;
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}
`;

const blurFragmentShader = `#version 300 es
precision highp float;

in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_step;
out vec4 fragColor;

void main() {
  vec4 sum = texture(u_texture, v_uv) * 0.2270270;
  sum += (texture(u_texture, v_uv + u_step) + texture(u_texture, v_uv - u_step)) * 0.1945946;
  sum += (texture(u_texture, v_uv + u_step * 2.0) + texture(u_texture, v_uv - u_step * 2.0)) * 0.1216216;
  sum += (texture(u_texture, v_uv + u_step * 3.0) + texture(u_texture, v_uv - u_step * 3.0)) * 0.0540541;
  sum += (texture(u_texture, v_uv + u_step * 4.0) + texture(u_texture, v_uv - u_step * 4.0)) * 0.0162162;
  fragColor = sum;
}
`;

const compositeFragmentShader = `#version 300 es
precision highp float;

in vec2 v_uv;
uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform float u_bloomStrength;
out vec4 fragColor;

void main() {
  // 场景与辉光都是预乘 alpha，直接相加即可保持透明窗口的正确合成。
  fragColor = texture(u_scene, v_uv) + texture(u_bloom, v_uv) * u_bloomStrength;
}
`;

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("无法创建着色器");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`着色器编译失败：${log}`);
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string) {
  const program = gl.createProgram();
  if (!program) throw new Error("无法创建着色器程序");
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`着色器链接失败：${log}`);
  }
  return program;
}

/** 把 "#2878d0" 这样的强调色解析成 0-1 的 RGB，失败时退回冷色调。 */
export function accentToRgb(accent: string): [number, number, number] {
  const match = /^#?([\da-f]{6})$/i.exec(accent.trim());
  if (!match) return [0.36, 0.72, 0.95];
  const value = Number.parseInt(match[1], 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

export type ParticleRendererOptions = {
  canvas: HTMLCanvasElement;
  cloud: PointCloud;
  accent: string;
  /** 每帧读取一次音频能量（0-1）；不接麦克风时返回 0。 */
  getEnergy?: () => number;
};

type RenderTargets = {
  sceneFramebuffer: WebGLFramebuffer;
  sceneTexture: WebGLTexture;
  blurFramebufferA: WebGLFramebuffer;
  blurTextureA: WebGLTexture;
  blurFramebufferB: WebGLFramebuffer;
  blurTextureB: WebGLTexture;
  bloomWidth: number;
  bloomHeight: number;
};

export class ParticleRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly sceneProgram: WebGLProgram;
  private readonly blurProgram: WebGLProgram;
  private readonly compositeProgram: WebGLProgram;
  private readonly buffers: WebGLBuffer[];
  private readonly sceneUniforms: Record<string, WebGLUniformLocation | null>;
  private readonly blurUniforms: Record<string, WebGLUniformLocation | null>;
  private readonly compositeUniforms: Record<string, WebGLUniformLocation | null>;
  private readonly particleVao: WebGLVertexArrayObject;
  private readonly vao: WebGLVertexArrayObject;
  private readonly getEnergy: () => number;
  private readonly canvas: HTMLCanvasElement;
  private targets: RenderTargets | null = null;
  private frame = 0;
  private startedAt = performance.now();
  private lastFrameAt = this.startedAt;
  private state: AvatarState = "idle";
  private pointCount: number;
  private drawCount: number;
  private pointScaleFactor = 1.25;
  private gain = 1;
  private radius = 1;
  private accentRgb: [number, number, number] = [0.36, 0.72, 0.95];
  private lightMode = false;
  private targetOpacity = 1;
  private opacity = 0;
  private width = 0;
  private height = 0;
  private disposed = false;

  // 场景尺度：透视会放大最外侧的粒子（星云半径 1.5），所以留出足够余量。
  private readonly extent = 2.5;
  private readonly pulse = 1;
  // 星云靠辉光成型，"绚丽"很大程度来自这一项，所以比之前的球体高得多。
  private readonly bloomStrength = 1.6;

  constructor(options: ParticleRendererOptions) {
    const gl = options.canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false });
    if (!gl) throw new Error("当前环境不支持 WebGL2");
    this.gl = gl;
    this.canvas = options.canvas;
    this.getEnergy = options.getEnergy || (() => 0);
    this.pointCount = options.cloud.count;
    this.drawCount = options.cloud.count;

    this.sceneProgram = link(gl, sceneVertexShader, sceneFragmentShader);
    this.blurProgram = link(gl, quadVertexShader, blurFragmentShader);
    this.compositeProgram = link(gl, quadVertexShader, compositeFragmentShader);

    const positionBuffer = gl.createBuffer();
    const seedBuffer = gl.createBuffer();
    const sizeBuffer = gl.createBuffer();
    const kindBuffer = gl.createBuffer();
    if (!positionBuffer || !seedBuffer || !sizeBuffer || !kindBuffer) throw new Error("无法创建顶点缓冲");
    this.buffers = [positionBuffer, seedBuffer, sizeBuffer, kindBuffer];

    const particleVao = gl.createVertexArray();
    if (!particleVao) throw new Error("无法创建顶点数组对象");
    this.particleVao = particleVao;
    gl.bindVertexArray(particleVao);
    this.upload("a_position", positionBuffer, options.cloud.positions);
    this.upload("a_seed", seedBuffer, options.cloud.seeds);
    this.upload("a_size", sizeBuffer, options.cloud.sizes);
    this.upload("a_kind", kindBuffer, options.cloud.kinds);
    gl.bindVertexArray(null);

    const emptyVao = gl.createVertexArray();
    if (!emptyVao) throw new Error("无法创建顶点数组对象");
    this.vao = emptyVao;

    this.sceneUniforms = this.collect(this.sceneProgram,
      ["u_time", "u_dpr", "u_pointScale", "u_extent", "u_state", "u_energy", "u_radius", "u_pulse", "u_light", "u_accent", "u_opacity", "u_gain"]);
    this.blurUniforms = this.collect(this.blurProgram, ["u_texture", "u_step"]);
    this.compositeUniforms = this.collect(this.compositeProgram, ["u_scene", "u_bloom", "u_bloomStrength"]);

    this.setAccent(options.accent);
    gl.disable(gl.DEPTH_TEST);
    this.syncSize();
  }

  /** 取 uniform 位置。名字写错时立刻报错，而不是静默失效导致画面"看起来没生效"。 */
  private collect(program: WebGLProgram, names: string[]) {
    const gl = this.gl;
    const entries = names.map((name) => [name, gl.getUniformLocation(program, name)] as const);
    const missing = entries.filter(([, location]) => location === null).map(([name]) => name);
    if (missing.length) throw new Error(`着色器缺少 uniform：${missing.join("、")}`);
    return Object.fromEntries(entries) as Record<string, WebGLUniformLocation | null>;
  }

  private upload(attribute: string, buffer: WebGLBuffer, data: Float32Array) {
    const gl = this.gl;
    const location = gl.getAttribLocation(this.sceneProgram, attribute);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(location);
    const components = attribute === "a_size" || attribute === "a_kind" ? 1 : 3;
    gl.vertexAttribPointer(location, components, gl.FLOAT, false, 0, 0);
  }

  setState(state: AvatarState) { this.state = state; }

  setAccent(accent: string) { this.accentRgb = accentToRgb(accent); }

  /** 浅色背景下必须换成深色墨点 + 普通 alpha 混合：加法发光在浅底上等于看不见。 */
  setLightMode(value: boolean) { this.lightMode = value; }

  /** 淡入用；窗口打开时从 0 过渡到 1，避免粒子"啪"地出现。 */
  setTargetOpacity(value: number) { this.targetOpacity = Math.max(0, Math.min(1, value)); }

  /** 只画前 N 颗。点云已打乱，所以任意 N 都是均匀子集，调密度不需要重建缓冲。 */
  setDrawCount(count: number) {
    this.drawCount = Math.max(1, Math.min(this.pointCount, Math.round(count)));
  }

  /** 粒子大小系数，1 为基准。 */
  setPointScale(factor: number) { this.pointScaleFactor = Math.max(0.1, factor); }

  /** 整体亮度增益，1 为基准。 */
  setGain(gain: number) { this.gain = Math.max(0, gain); }

  /** 星云半径倍率，1 为基准。 */
  setRadius(radius: number) { this.radius = Math.max(0.1, radius); }

  setCloud(cloud: PointCloud) {
    this.pointCount = cloud.count;
    this.drawCount = cloud.count;
    const gl = this.gl;
    gl.bindVertexArray(this.particleVao);
    const data = [cloud.positions, cloud.seeds, cloud.sizes, cloud.kinds];
    for (let index = 0; index < this.buffers.length; index += 1) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[index]);
      gl.bufferData(gl.ARRAY_BUFFER, data[index], gl.STATIC_DRAW);
    }
    gl.bindVertexArray(null);
  }

  start() {
    if (this.frame) return;
    this.startedAt = performance.now();
    this.lastFrameAt = this.startedAt;
    const loop = () => {
      if (this.disposed) return;
      this.draw();
      this.frame = requestAnimationFrame(loop);
    };
    this.frame = requestAnimationFrame(loop);
  }

  stop() {
    if (!this.frame) return;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  /** 跟随窗口与显示器缩放调整绘制缓冲；尺寸变化时重建 Bloom 的离屏目标。 */
  private syncSize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (width === this.width && height === this.height) return dpr;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.rebuildTargets();
    return dpr;
  }

  resize() { this.syncSize(); }

  private createTexture(width: number, height: number) {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error("无法创建纹理");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  private createFramebuffer(texture: WebGLTexture) {
    const gl = this.gl;
    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) throw new Error("无法创建帧缓冲");
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("离屏帧缓冲不完整");
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return framebuffer;
  }

  private rebuildTargets() {
    this.releaseTargets();
    const sceneTexture = this.createTexture(this.width, this.height);
    const bloomWidth = Math.max(1, Math.floor(this.width / 2));
    const bloomHeight = Math.max(1, Math.floor(this.height / 2));
    const blurTextureA = this.createTexture(bloomWidth, bloomHeight);
    const blurTextureB = this.createTexture(bloomWidth, bloomHeight);
    this.targets = {
      sceneTexture,
      sceneFramebuffer: this.createFramebuffer(sceneTexture),
      blurTextureA,
      blurFramebufferA: this.createFramebuffer(blurTextureA),
      blurTextureB,
      blurFramebufferB: this.createFramebuffer(blurTextureB),
      bloomWidth,
      bloomHeight,
    };
  }

  private releaseTargets() {
    const gl = this.gl;
    const targets = this.targets;
    if (!targets) return;
    for (const texture of [targets.sceneTexture, targets.blurTextureA, targets.blurTextureB]) gl.deleteTexture(texture);
    for (const framebuffer of [targets.sceneFramebuffer, targets.blurFramebufferA, targets.blurFramebufferB]) gl.deleteFramebuffer(framebuffer);
    this.targets = null;
  }

  private draw() {
    const gl = this.gl;
    const now = performance.now();
    const delta = Math.min(0.1, (now - this.lastFrameAt) / 1000);
    this.lastFrameAt = now;
    const dpr = this.syncSize();
    const targets = this.targets;
    if (!targets) return;

    this.opacity += (this.targetOpacity - this.opacity) * Math.min(1, delta * 8);

    // Pass 1：粒子 → 离屏场景（加法混合，重叠处自然变亮）。
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.sceneFramebuffer);
    gl.viewport(0, 0, this.width, this.height);
    gl.enable(gl.BLEND);
    // 深色底用加法混合让重叠处发光；浅色底改用普通 alpha 混合，否则粒子会被背景吃掉。
    if (this.lightMode) gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    else gl.blendFunc(gl.ONE, gl.ONE);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawParticles(now, dpr);

    // Pass 2/3：两轮高斯模糊，第二轮步长翻倍把辉光铺得更宽。半分辨率足够。
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, targets.bloomWidth, targets.bloomHeight);
    this.blur(targets.sceneTexture, targets.blurFramebufferA, 1 / targets.bloomWidth, 0);
    this.blur(targets.blurTextureA, targets.blurFramebufferB, 0, 1 / targets.bloomHeight);
    this.blur(targets.blurTextureB, targets.blurFramebufferA, 2 / targets.bloomWidth, 0);
    this.blur(targets.blurTextureA, targets.blurFramebufferB, 0, 2 / targets.bloomHeight);
    // 第三轮用四倍步长，把辉光铺到更远处，才有"被光晕包裹"的感觉。
    // 只加强度不加半径，结果只是近处过曝，而不是变朦胧。
    this.blur(targets.blurTextureB, targets.blurFramebufferA, 4 / targets.bloomWidth, 0);
    this.blur(targets.blurTextureA, targets.blurFramebufferB, 0, 4 / targets.bloomHeight);

    // Pass 4：场景 + 辉光合成到屏幕。每个像素都会被覆盖，所以关闭混合直接写入。
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.compositeProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, targets.sceneTexture);
    gl.uniform1i(this.compositeUniforms.u_scene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, targets.blurTextureB);
    gl.uniform1i(this.compositeUniforms.u_bloom, 1);
    // 浅色底上辉光只会让画面更糊，所以大幅压低。
    gl.uniform1f(this.compositeUniforms.u_bloomStrength, this.lightMode ? 0.3 : this.bloomStrength);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  private drawParticles(now: number, dpr: number) {
    const gl = this.gl;
    gl.bindVertexArray(this.particleVao);
    gl.useProgram(this.sceneProgram);
    gl.uniform1f(this.sceneUniforms.u_time, (now - this.startedAt) / 1000);
    gl.uniform1f(this.sceneUniforms.u_dpr, dpr);
    // 用 CSS 像素而不是设备像素：canvas.width 已经含 dpr，若再乘一次 dpr，
    // 点在 Retina 上会按 dpr² 放大（dpr=2 时是 4 倍而不是 2 倍）。
    const cssSize = Math.min(this.canvas.clientWidth, this.canvas.clientHeight) || 420;
    gl.uniform1f(this.sceneUniforms.u_pointScale, (cssSize / 420) * this.pointScaleFactor);
    gl.uniform1f(this.sceneUniforms.u_extent, this.extent);
    gl.uniform1f(this.sceneUniforms.u_state, avatarStateCode[this.state]);
    gl.uniform1f(this.sceneUniforms.u_energy, Math.max(0, Math.min(1, this.getEnergy())));
    gl.uniform1f(this.sceneUniforms.u_opacity, this.opacity);
    gl.uniform1f(this.sceneUniforms.u_gain, this.gain);
    gl.uniform1f(this.sceneUniforms.u_radius, this.radius);
    gl.uniform1f(this.sceneUniforms.u_pulse, this.pulse);
    gl.uniform1f(this.sceneUniforms.u_light, this.lightMode ? 1 : 0);
    gl.uniform3fv(this.sceneUniforms.u_accent, this.accentRgb);
    gl.drawArrays(gl.POINTS, 0, this.drawCount);
    gl.bindVertexArray(null);
  }

  private blur(source: WebGLTexture, target: WebGLFramebuffer, stepX: number, stepY: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.useProgram(this.blurProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.uniform1i(this.blurUniforms.u_texture, 0);
    gl.uniform2f(this.blurUniforms.u_step, stepX, stepY);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  dispose() {
    this.disposed = true;
    this.stop();
    this.releaseTargets();
    for (const buffer of this.buffers) this.gl.deleteBuffer(buffer);
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteVertexArray(this.particleVao);
    this.gl.deleteProgram(this.sceneProgram);
    this.gl.deleteProgram(this.blurProgram);
    this.gl.deleteProgram(this.compositeProgram);
  }
}
