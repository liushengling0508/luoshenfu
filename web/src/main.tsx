import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App, { AppErrorBoundary } from "./App";
import "./styles.css";
import "./tech.css";

createRoot(document.getElementById("root")!).render(<StrictMode><AppErrorBoundary><App /></AppErrorBoundary></StrictMode>);
