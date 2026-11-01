import { useApp } from "../appContext";
import { fmtHex, fmtSize } from "../i18n";

function StatePill({ state }: { state: string }) {
  const cls = state === "running" ? "running" : state === "halted" ? "halted" : "other";
  return <span className={`pill ${cls}`}>{state}</span>;
}

export function InfoPanel() {
  const { t, conn, targetInfo, settings, actions } = useApp();

  if (conn !== "connected" || !targetInfo) {
    return <div className="empty-note">{t("info.notConnected")}</div>;
  }

  const current = targetInfo.targets.find((x) => x.current) ?? targetInfo.targets[0];
  const ifaceName = settings.interfaceCfg.split(/[\\/]/).pop() || "—";

  return (
    <div>
      <div className="cards">
        <div className="card">
          <div className="k">{t("info.version")}</div>
          <div className="v mono">{targetInfo.version || "—"}</div>
        </div>
        <div className="card">
          <div className="k">{t("info.target")}</div>
          <div className="v">
            {current?.name ?? t("info.noTarget")}{" "}
            {current && <StatePill state={current.state} />}
          </div>
        </div>
        <div className="card">
          <div className="k">{t("info.adapter")}</div>
          <div className="v">{ifaceName}</div>
        </div>
        <div className="card">
          <div className="k">{t("info.ports")}</div>
          <div className="v mono">
            {settings.telnetPort} / {settings.gdbPort} / {settings.tclPort}
          </div>
        </div>
      </div>

      <table className="data">
        <thead>
          <tr>
            <th>#</th>
            <th>{t("info.name")}</th>
            <th>Type</th>
            <th>{t("info.state")}</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {targetInfo.targets.map((tg) => (
            <tr key={tg.index}>
              <td>{tg.index}</td>
              <td className="mono">{tg.name}{tg.current ? " *" : ""}</td>
              <td className="mono">{tg.type}</td>
              <td><StatePill state={tg.state} /></td>
              <td className="mono">{tg.description}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "16px 0 8px" }}>
        <div className="section-title" style={{ margin: 0 }}>{t("info.flashBanks")}</div>
        <button className="tb-btn" style={{ padding: "3px 10px", fontSize: 12 }} onClick={() => actions.refreshInfo()}>
          {t("info.refresh")}
        </button>
      </div>

      <table className="data">
        <thead>
          <tr>
            <th>#</th>
            <th>{t("info.name")}</th>
            <th>{t("info.base")}</th>
            <th>{t("info.size")}</th>
          </tr>
        </thead>
        <tbody>
          {targetInfo.flash_banks.length === 0 && (
            <tr><td colSpan={4} style={{ color: "var(--muted)" }}>{t("info.noBanks")}</td></tr>
          )}
          {targetInfo.flash_banks.map((b) => (
            <tr key={b.index}>
              <td>{b.index}</td>
              <td className="mono">{b.name}</td>
              <td className="mono">{fmtHex(b.base)}</td>
              <td className="mono">{fmtHex(b.size)} ({fmtSize(b.size)})</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
