import { createContext, useContext } from "react";
import type { Adapter, LogLine, TargetInfo } from "./ipc";
import type { Lang } from "./i18n";

export type ConnState = "disconnected" | "connecting" | "connected";

export interface Settings {
  binary: string;
  scriptsDir: string;
  interfaceCfg: string;
  targetCfg: string;
  speed: number;
  telnetPort: number;
  gdbPort: number;
  tclPort: number;
  customCmds: string;
}

export const DEFAULT_SETTINGS: Settings = {
  binary: "openocd",
  scriptsDir: "",
  interfaceCfg: "",
  targetCfg: "",
  speed: 4000,
  telnetPort: 4444,
  gdbPort: 3333,
  tclPort: 6666,
  customCmds: "",
};

export interface AppCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  theme: "light" | "dark";
  toggleTheme: () => void;
  conn: ConnState;
  busy: string | null;
  targetInfo: TargetInfo | null;
  logs: LogLine[];
  settings: Settings;
  patchSettings: (patch: Partial<Settings>) => void;
  api: Adapter | null;
  isMock: boolean;
  toast: string | null;
  actions: {
    connect: () => Promise<void>;
    disconnect: () => Promise<void>;
    refreshInfo: () => Promise<void>;
    probeSizes: () => Promise<void>;
    reset: (mode: string) => Promise<void>;
    halt: () => Promise<void>;
    resume: () => Promise<void>;
    runOp: (label: string, fn: () => Promise<unknown>) => Promise<void>;
    clearLogs: () => void;
    pushLog: (line: string) => void;
  };
}

export const AppContext = createContext<AppCtx>(null!);

export function useApp(): AppCtx {
  return useContext(AppContext);
}
