// 贾维斯粒子窗口入口：独立于主看板，只负责渲染全息粒子。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ParticleAvatar } from "./particles/ParticleAvatar";

createRoot(document.getElementById("root")!).render(<StrictMode><ParticleAvatar /></StrictMode>);
