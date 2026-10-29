// 贾维斯的形态状态：粒子本身不思考，只根据一个状态变量表演。
// 后续接入语音与任务执行时，改的只是这里的状态值。

export type AvatarState = "idle" | "listening" | "thinking" | "speaking" | "working";

export const avatarStates: AvatarState[] = ["idle", "listening", "thinking", "speaking", "working"];

// 传给着色器的状态编号，顺序必须与 avatarStates 一致。
export const avatarStateCode: Record<AvatarState, number> = {
  idle: 0,
  listening: 1,
  thinking: 2,
  speaking: 3,
  working: 4,
};

export const avatarStateLabel: Record<AvatarState, string> = {
  idle: "待机",
  listening: "聆听",
  thinking: "思考",
  speaking: "说话",
  working: "执行",
};

export function isAvatarState(value: unknown): value is AvatarState {
  return typeof value === "string" && (avatarStates as string[]).includes(value);
}
