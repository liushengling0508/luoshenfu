// 粒子点云：贾维斯的"身体"。
//
// 形态是"星云"而不是"球"。两者的关键差别在分布：
//   球壳   → 粒子集中在一个薄壳上，边界清晰，怎么看都是个球
//   星云   → 粒子分布在整个体积里，密度向中心递增，边界自然消融
// 再加上分形噪声扰动，云里才会出现丝状明暗，而不是一层均匀的雾。
//
// 另外有两道"旋转光带"：它们不跟着星云走，而是以各自的速度环绕，
// 所以看起来是"绕着云转的环"，而不是云的一部分。

export type PointCloud = {
  positions: Float32Array;
  seeds: Float32Array;
  sizes: Float32Array;
  /** 0 = 星云粒子，1 = 光带粒子。着色器靠它决定是否施加独立旋转。 */
  kinds: Float32Array;
  count: number;
};

// 黄金角：把点均匀铺在球面上，避免用经纬度采样时两极堆积。
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// 固定种子的伪随机：每次启动形态完全一致，避免"今天和昨天长得不一样"。
function createRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// ---- 3D 值噪声：星云的"丝状"完全靠它 ----
// 没有它，粒子只会是均匀的一团；有了它，才会出现密处成丝、疏处透光的结构。

function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function fade(t: number) { return t * t * (3 - 2 * t); }

function valueNoise(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const u = fade(x - xi);
  const v = fade(y - yi);
  const w = fade(z - zi);

  const c000 = hash3(xi, yi, zi);
  const c100 = hash3(xi + 1, yi, zi);
  const c010 = hash3(xi, yi + 1, zi);
  const c110 = hash3(xi + 1, yi + 1, zi);
  const c001 = hash3(xi, yi, zi + 1);
  const c101 = hash3(xi + 1, yi, zi + 1);
  const c011 = hash3(xi, yi + 1, zi + 1);
  const c111 = hash3(xi + 1, yi + 1, zi + 1);

  const x00 = c000 + (c100 - c000) * u;
  const x10 = c010 + (c110 - c010) * u;
  const x01 = c001 + (c101 - c001) * u;
  const x11 = c011 + (c111 - c011) * u;
  const y0 = x00 + (x10 - x00) * v;
  const y1 = x01 + (x11 - x01) * v;
  return y0 + (y1 - y0) * w;
}

/** 多个频率叠加才有"云"的层次；单频只会得到规律花纹，一看就是程序生成的。 */
function fractalNoise(x: number, y: number, z: number, octaves = 4): number {
  let value = 0;
  let total = 0;
  let amplitude = 0.5;
  let frequency = 1;
  for (let octave = 0; octave < octaves; octave += 1) {
    value += amplitude * valueNoise(x * frequency, y * frequency, z * frequency);
    total += amplitude;
    // 用 2.07 而不是 2：整数倍频会让各层重叠，出现规则纹路。
    frequency *= 2.07;
    amplitude *= 0.5;
  }
  return value / total;
}

export const NEBULA_MAX_RADIUS = 1.5;
// 核心是"光源"；气体只贡献光晕；光带是环绕的装饰。
const CORE_SHARE = 0.006;
const GAS_SHARE = 0.085;
const BELT_SHARE = 0.075;

/** 光带参数。inner/outer 给出环带的径向宽度——宽度是"环"和"一条线"的分界。 */
const belts = [
  { inner: 0.8, outer: 0.99, tilt: 0.38, thickness: 0.05, phase: 0 },
  { inner: 1.16, outer: 1.44, tilt: -0.27, thickness: 0.075, phase: 2.1 },
];

/**
 * 星云点云。
 * 核心是一小团炽热的"光源"，主体是体积分布并带分形噪声的云，
 * 亮度随半径衰减——所以它没有边界，只有浓淡。另有两道环绕的光带。
 */
export function nebulaCloud(count = 100_000): PointCloud {
  const random = createRandom(0x9e3779b9);
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const kinds = new Float32Array(count);

  for (let index = 0; index < count; index += 1) {
    // 均匀球面方向：Fibonacci 螺旋 + 少量抖动。光带会覆盖它。
    const latitude = 1 - (index / Math.max(1, count - 1)) * 2;
    const ring = Math.sqrt(Math.max(0, 1 - latitude * latitude));
    const theta = index * GOLDEN_ANGLE;
    let directionX = Math.cos(theta) * ring + (random() - 0.5) * 0.06;
    let directionY = latitude + (random() - 0.5) * 0.06;
    let directionZ = Math.sin(theta) * ring + (random() - 0.5) * 0.06;
    const length = Math.hypot(directionX, directionY, directionZ) || 1;
    directionX /= length;
    directionY /= length;
    directionZ /= length;

    let radius: number;
    let size: number;
    let brightness: number;

    // 结构分配用独立随机数：绝不能用 index 比例，那会和 Fibonacci 的纬度相关，
    // 让某一层全挤到球的北极（踩过一次，屏幕上是个三角形亮块）。
    const roll = random();
    if (roll < CORE_SHARE) {
      // 核心是"光源"，但不能大到糊成一块白斑——那会把整团云的层次压平。
      radius = Math.pow(random(), 0.7) * 0.2;
      size = 1.8 + random() * 3.2;
      // 核心亮度压低：光晕要靠外围的气体弥散，核心一旦过亮就会糊成一块白。
      // 注意这里用 0.45 而不是 0.6——改动点云里的 random() 调用次数会改变
      // 后续所有粒子的随机序列（确定性随机），分布变了就得重新平衡。
      brightness = 0.45;
    } else if (roll < CORE_SHARE + GAS_SHARE) {
      // 发光气体：又大又暗的柔光点。单看几乎看不出形状，但它们互相叠加，
      // 就形成包裹整团云的光晕——"绚丽"主要来自这一层，光靠尘埃做不出来。
      const base = Math.pow(random(), 0.85) * NEBULA_MAX_RADIUS * 1.15;
      const noise = fractalNoise(directionX * 2.1, directionY * 2.1, directionZ * 2.1, 3);
      radius = base * (0.65 + noise * 0.8);
      size = 8 + random() * 14;
      const falloff = Math.max(0, 1 - radius / (NEBULA_MAX_RADIUS * 1.2));
      brightness = (0.055 + noise * 0.1) * (0.25 + 0.75 * Math.pow(falloff, 0.6));
    } else if (roll < CORE_SHARE + GAS_SHARE + BELT_SHARE) {
      // 光带＝离散的环带，不是一条圆周线。粒子铺在一个径向区间里，
      // 并沿径向做出疏密与缝隙——土星环好看就在于"有宽度、有缝、有疏密"，
      // 粒子全落在同一半径上只会看起来像画了根线。
      const beltIndex = random() < 0.55 ? 0 : 1;
      const belt = belts[beltIndex];
      // 40% 当"头部"，其余是拖尾。尾部沿运动的反方向落后一到三段，
      // 越靠后越暗越小，连起来就是流星划过的那种尾迹。
      const isHead = random() < 0.4;
      const baseAngle = random() * Math.PI * 2;
      // 两条带的转向相反，尾巴也要跟着反向，否则尾部会跑到"前面"去。
      const direction = beltIndex === 0 ? 1 : -1;
      const trailStep = isHead ? 0 : 1 + Math.floor(random() * 3);
      const angle = baseAngle - direction * trailStep * 0.16;
      const trail = isHead ? 1 : Math.pow(1 - trailStep / 4, 1.6);
      // 径向位置：偏中间略密，两端渐稀。
      const radial = Math.pow(random(), 0.75);
      const beltRadius = belt.inner + radial * (belt.outer - belt.inner);
      // 缝隙：用亮度压暗而不是直接剔除，否则会留下生硬的空洞。
      // 范围收在 0.5–1 之间——压得太狠环带会碎掉，看不出"环"。
      const gap = 0.5 + 0.5 * Math.abs(Math.sin(radial * Math.PI * 2.6 + belt.phase));

      const localX = Math.cos(angle) * beltRadius;
      const localZ = Math.sin(angle) * beltRadius;
      // 环越靠外越薄，边缘才不会像一块厚板。
      const localY = (random() - 0.5) * belt.thickness * (1 - radial * 0.45);
      const cosine = Math.cos(belt.tilt);
      const sine = Math.sin(belt.tilt);
      directionX = localX;
      directionY = localY * cosine - localZ * sine;
      directionZ = localY * sine + localZ * cosine;
      radius = 1;
      // 沿环的亮度节点：这是"旋转"能被看见的唯一依据。
      const node = 0.3 + 0.7 * Math.abs(Math.sin(baseAngle * 2.5 + belt.phase));
      size = (1.2 + random() * 2.8) * (0.45 + trail * 0.55);
      // 必须明显亮过星云（星云峰值约 0.92），否则环带会被云淹没——
      // 这是"看得出是个环"的前提。尾部按 trail 衰减成渐隐的尾迹。
      brightness = (0.55 + node * 0.85) * gap * (0.2 + trail * 0.8);
      // 1 和 2 用来区分两条光带，着色器据此给它们不同的转速与进动相位。
      kinds[index] = beltIndex + 1;
    } else {
      // 指数 1.25 而不是 1.75：分布太平缓会让外围只剩零星散点，云就断了。
      const base = Math.pow(random(), 1.25) * NEBULA_MAX_RADIUS;
      const noise = fractalNoise(directionX * 2.4, directionY * 2.4, directionZ * 2.4, 4);
      radius = base * (0.55 + noise * 1.05);
      // 下限不能低于 1px（会被丢弃或闪烁），但也不能给得太保守——
      // 星云看起来"没有颗粒"往往就是尺寸太小。
      size = 1.5 + random() * 3.4 * (0.4 + noise);
      // 外围保留余辉；衰减到 0 会让星云只剩中心一个亮斑。
      const falloff = Math.max(0, 1 - radius / NEBULA_MAX_RADIUS);
      brightness = (0.12 + noise * 0.8) * (0.14 + 0.86 * Math.pow(falloff, 0.7));
    }

    positions[index * 3] = directionX * radius;
    positions[index * 3 + 1] = directionY * radius;
    positions[index * 3 + 2] = directionZ * radius;
    // seed.xy 是流动相位；seed.z 直接作为亮度权重。
    seeds[index * 3] = random() * 2 - 1;
    seeds[index * 3 + 1] = random() * 2 - 1;
    seeds[index * 3 + 2] = brightness;
    sizes[index] = size;
  }

  // 打乱顺序：渲染器靠"只画前 N 颗"来调密度，顺序随机才能保证任意 N 都是均匀子集。
  shuffle(positions, seeds, sizes, kinds, count);

  return { positions, seeds, sizes, kinds, count };
}

/** 原地洗牌四组数组，保持同一颗粒子的下标始终对齐。 */
function shuffle(positions: Float32Array, seeds: Float32Array, sizes: Float32Array, kinds: Float32Array, count: number) {
  const random = createRandom(0x85ebca6b);
  for (let index = count - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    if (target === index) continue;
    for (let axis = 0; axis < 3; axis += 1) {
      const a = index * 3 + axis;
      const b = target * 3 + axis;
      const position = positions[a];
      positions[a] = positions[b];
      positions[b] = position;
      const seed = seeds[a];
      seeds[a] = seeds[b];
      seeds[b] = seed;
    }
    const size = sizes[index];
    sizes[index] = sizes[target];
    sizes[target] = size;
    const kind = kinds[index];
    kinds[index] = kinds[target];
    kinds[target] = kind;
  }
}
