export type AppMode = "demo" | "production";

export const APP_MODE = (import.meta.env.VITE_APP_MODE ?? "demo") as AppMode;
export const FOXIFY_APPROVED = import.meta.env.VITE_FOXIFY_APPROVED === "true";
export const FOXIFY_ENABLED = APP_MODE === "production" && FOXIFY_APPROVED;
const REQUESTED_DATA_MODE = import.meta.env.VITE_DATA_MODE ?? (APP_MODE === "production" ? "foxify" : "demo");
export const DATA_MODE = FOXIFY_ENABLED ? REQUESTED_DATA_MODE : "demo";
const RAW_API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:4100";
const normalizeApiBase = (value: string) => {
  try {
    const url = new URL(value);
    const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (isLocalhost && (!url.port || url.port === "410")) {
      url.port = "4100";
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return "http://localhost:4100";
  }
};
export const API_BASE = normalizeApiBase(RAW_API_BASE);
export const FOXIFY_POSITION_ENDPOINT = import.meta.env.VITE_FOXIFY_POSITION_ENDPOINT ?? "";
export const FOXIFY_PORTFOLIO_ENDPOINT = import.meta.env.VITE_FOXIFY_PORTFOLIO_ENDPOINT ?? "";
