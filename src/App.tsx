import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppContext, DEFAULT_SETTINGS, type AppCtx, type ConnState, type Settings } from "./appContext";
import { getAdapter, type Adapter, type LogLine, type TargetInfo } from "./ipc";
import { I18nProvider, useI18n } from "./i18n";
import { SettingsPanel } from "./components/SettingsPanel";
import { InfoPanel } from "./components/InfoPanel";
import { MemoryPanel } from "./components/MemoryPanel";
import { FlashPanel } from "./components/FlashPanel";
import { LogConsole } from "./components/LogConsole";

const MAX_LOGS = 8000;

function ChipLogo() {
  return (
    <svg width="26" height="26" viewBox="0 0 512 512" aria-hidden>
      <rect x="8" y="8" width="496" height="496" rx="112" fill="#0d9488" />
      <rect x="136" y="136" width="240" height="240" rx="28" fill="#134e4a" />
      <circle cx="256" cy="256" r="42" fill="#99f6e4" />
      {[0.25, 0.4167, 0.5833, 0.75].map((f) => (
        <g key={f} fill="#134e4a">
          <rect x="40" y={f * 512 - 10} width="92" height="20" rx="7" />
          <rect x="380" y={f * 512 - 10} width="92" height="20" rx="7" />
          <rect x={f * 512 - 10} y="40" width="20" height="92" rx="7" />
          <rect x={f * 512 - 10} y="380" width="20" height="92" rx="7" />
        </g>
      ))}
    </svg>
  );
}

function AppInner() {
  const { t, lang, setLang } = useI18n();
  const [theme, setTheme] = useState<"light" | "dark">(() => (localStorage.getItem("ocd.theme") as "light" | "dark") || "light");
  const [conn, setConn] = useState<ConnState>("disconnected");
  const [busy, setBusy] = useState<string | null>(null);
  const [targetInfo, setTargetInfo] = useState<TargetInfo | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [tab, setTab] = useState<"info" | "memory" | "flash">("info");
  const [settings, setSettings] = useState<Settings>(() => {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("ocd.settings") || "{}") };
    } catch {
      return DEFAULT_SETTINGS;
    }
  });
  const [toast, setToast] = useState<string | null>(null);
  const [isMock, setIsMock] = useState(false);
  const apiRef = useRef<Adapter | null>(null);
  const [apiReady, setApiReady] = useState(0);

  // init adapter + subscriptions
  useEffect(() => {
    let disposed = false;
    void getAdapter().then((a) => {
      if (disposed) return;
      apiRef.current = a;
      setIsMock(a.isMock);
      a.onLog((l) => setLogs((prev) => [...prev.slice(-MAX_LOGS), l]));
      a.onExit(() => {
        setConn("disconnected");
        setBusy(null);
      });
      setApiReady((n) => n + 1);
    });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("ocd.theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("ocd.settings", JSON.stringify(settings));
  }, [settings]);

  const pushLog = useCallback((line: string) => {
    setLogs((prev) => [...prev.slice(-MAX_LOGS), { stream: "app", line }]);
  }, []);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 6000);
  }, []);

  const patchSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...patch }));
  }, []);

  const buildCfg = useCallback((): Parameters<Adapter["start"]>[0] => {
    const files = [settings.interfaceCfg, settings.targetCfg].filter(Boolean);
    const cmds = [...settings.customCmds.split("\n").map((s) => s.trim()).filter(Boolean)];
    if (settings.speed > 0) cmds.push(`adapter speed ${settings.speed}`);
    return {
      binary: settings.binary || "openocd",
      config_files: files,
      custom_cmds: cmds,
      telnet_port: settings.telnetPort,
      gdb_port: settings.gdbPort,
      tcl_port: settings.tclPort,
      scripts_dir: settings.scriptsDir || null,
      extra_args: [],
    };
  }, [settings]);

  const connect = useCallback(async () => {
    const api = apiRef.current;
    if (!api || conn !== "disconnected") return;
    setConn("connecting");
    setLogs([]);
    try {
      const info = await api.start(buildCfg());
      setTargetInfo(info);
      setConn("connected");
    } catch (e) {
      setConn("disconnected");
      showToast(String(e));
    }
  }, [conn, buildCfg, showToast]);

  const disconnect = useCallback(async () => {
    const api = apiRef.current;
    if (!api) return;
    try {
      await api.stop();
    } catch { /* ignore */ }
    setConn("disconnected");
    setBusy(null);
  }, []);

  const runOp = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
      // refresh target info after ops (state may have changed)
      const api = apiRef.current;
      if (api) {
        try {
          setTargetInfo(await api.info());
        } catch { /* ignore */ }
      }
    } catch (e) {
      showToast(`${label}: ${e}`);
    } finally {
      setBusy(null);
    }
  }, [showToast]);

  const refreshInfo = useCallback(async () => {
    const api = apiRef.current;
    if (!api) return;
    try {
      setTargetInfo(await api.info());
    } catch (e) {
      showToast(String(e));
    }
  }, [showToast]);

  const actions = useMemo(
    () => ({
      connect,
      disconnect,
      refreshInfo,
      reset: (mode: string) => runOp(t("toolbar.resetRun"), () => apiRef.current!.reset(mode)),
      halt: () => runOp(t("toolbar.halt"), () => apiRef.current!.halt()),
      resume: () => runOp(t("toolbar.resume"), () => apiRef.current!.resume()),
      runOp,
      clearLogs: () => setLogs([]),
      pushLog,
    }),
    [connect, disconnect, refreshInfo, runOp, t, pushLog],
  );

  const ctx: AppCtx = {
    lang,
    setLang,
    t,
    theme,
    toggleTheme: () => setTheme(theme === "light" ? "dark" : "light"),
    conn,
    busy,
    targetInfo,
    logs,
    settings,
    patchSettings,
    api: apiRef.current,
    isMock,
    toast,
    actions,
  };
  void apiReady; // re-render when adapter becomes available

  const connected = conn === "connected";
  const disabled = !connected || busy !== null;

  return (
    <AppContext.Provider value={ctx}>
      <div className="app">
        <header className="header">
          <div className="logo">
            <ChipLogo />
            <div>
              <h1>{t("app.title")}</h1>
              <div className="subtitle">{t("app.subtitle")}</div>
            </div>
          </div>
          <div className="spacer" />
          {isMock && <span className="badge-mock">{t("status.mock")}</span>}
          <button className="langbtn" onClick={() => setLang(lang === "zh" ? "en" : "zh")}>
            {lang === "zh" ? "EN" : "中文"}
          </button>
          <button className="iconbtn" onClick={ctx.toggleTheme} title={t("theme.toggle")}>
            {theme === "light" ? "🌙" : "☀️"}
          </button>
        </header>

        <div className="toolbar">
          {!connected && (
            <button className="tb-btn primary" disabled={conn === "connecting" || busy !== null} onClick={() => void connect()}>
              {conn === "connecting" && <span className="tb-spin" />}
              {conn === "connecting" ? t("toolbar.connecting") : `▶ ${t("toolbar.connect")}`}
            </button>
          )}
          {connected && (
            <button className="tb-btn" disabled={busy !== null} onClick={() => void disconnect()}>
              ■ {t("toolbar.disconnect")}
            </button>
          )}
          <div className="tb-sep" />
          <button className="tb-btn" disabled={disabled} onClick={actions.halt}>⏸ {t("toolbar.halt")}</button>
          <button className="tb-btn" disabled={disabled} onClick={() => actions.reset("halt")}>⏹ {t("toolbar.resetHalt")}</button>
          <button className="tb-btn" disabled={disabled} onClick={() => actions.reset("run")}>⏵ {t("toolbar.resetRun")}</button>
          <button className="tb-btn" disabled={disabled} onClick={actions.resume}>▶ {t("toolbar.resume")}</button>
          <div className="tb-sep" />
          <button className="tb-btn" disabled={disabled} onClick={() => setTab("flash")}>⚡ {t("tabs.flash")}</button>
          {busy && <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, color: "var(--accent-strong)", fontWeight: 600 }}><span className="tb-spin dark" />{busy}…</div>}
        </div>
        {busy && <div className="busybar" />}

        <div className="main">
          <aside className="sidebar">
            <SettingsPanel />
          </aside>
          <div className="content">
            <div className="tabbar">
              {(["info", "memory", "flash"] as const).map((k) => (
                <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
                  {t(`tabs.${k}`)}
                </button>
              ))}
            </div>
            <div className="tabbody">
              {tab === "info" && <InfoPanel />}
              {tab === "memory" && <MemoryPanel />}
              {tab === "flash" && <FlashPanel />}
            </div>
          </div>
        </div>

        <LogConsole />

        <footer className="statusbar">
          <span className={`dot ${conn === "connected" ? "ok" : conn === "connecting" ? "busy" : ""}`} />
          <span>{conn === "connected" ? t("status.connected") : conn === "connecting" ? t("status.connecting") : t("status.disconnected")}</span>
          {busy && <span>| {busy}…</span>}
          {targetInfo && <span className="mono">{targetInfo.version}</span>}
          <span className="grow" />
          <span className="mono">telnet {settings.telnetPort} · gdb {settings.gdbPort}</span>
        </footer>

        {toast && <div className="toast">{toast}</div>}
      </div>
    </AppContext.Provider>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <AppInner />
    </I18nProvider>
  );
}
