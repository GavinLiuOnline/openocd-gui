import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../appContext";

function lineClass(line: string): string {
  const l = line.trimStart();
  if (l.startsWith("Error")) return "err";
  if (l.startsWith("Warn")) return "warn";
  if (l.startsWith("Debug")) return "debug";
  if (l.startsWith("Info")) return "info";
  return "user";
}

export function LogConsole() {
  const { t, logs, actions } = useApp();
  const [collapsed, setCollapsed] = useState(false);
  const [autoscroll, setAutoscroll] = useState(true);
  const [filter, setFilter] = useState("");
  const bodyRef = useRef<HTMLPreElement>(null);

  const shown = useMemo(
    () => (filter ? logs.filter((l) => l.line.toLowerCase().includes(filter.toLowerCase())) : logs),
    [logs, filter],
  );

  useEffect(() => {
    if (autoscroll && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [shown, autoscroll]);

  return (
    <div className={`logdock${collapsed ? " collapsed" : ""}`}>
      <div className="log-head">
        <button className="log-chev" onClick={() => setCollapsed(!collapsed)}>{collapsed ? "▲" : "▼"}</button>
        <span className="title">{t("log.title")}</span>
        <input type="text" placeholder={t("log.filter")} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={autoscroll} onChange={(e) => setAutoscroll(e.target.checked)} />
          {t("log.autoscroll")}
        </label>
        <span className="spacer" />
        <span className="count">{t("log.lines", { n: shown.length })}</span>
        <button className="tb-btn" style={{ padding: "2px 10px", fontSize: 12 }} onClick={actions.clearLogs}>
          {t("log.clear")}
        </button>
      </div>
      {!collapsed && (
        <pre className="logbody" ref={bodyRef}>
          {shown.map((l, i) => (
            <div key={i} className={`logline ${lineClass(l.line)}`}>{l.line}</div>
          ))}
        </pre>
      )}
    </div>
  );
}
