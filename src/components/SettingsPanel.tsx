import { useEffect, useState } from "react";
import { useApp } from "../appContext";
import type { ScriptLists } from "../ipc";

const CUSTOM = "__custom__";

export function SettingsPanel() {
  const { t, settings, patchSettings, api, actions } = useApp();
  const [lists, setLists] = useState<ScriptLists | null>(null);

  const refresh = () => {
    api?.listScripts(settings.binary).then(setLists).catch(() => setLists(null));
  };

  useEffect(refresh, []); // eslint-disable-line react-hooks/exhaustive-deps

  const ifaceOptions = lists?.interfaces ?? [];
  const targetOptions = lists?.targets ?? [];
  const ifaceCustom = settings.interfaceCfg !== "" && !ifaceOptions.some((o) => o.path === settings.interfaceCfg);
  const targetCustom = settings.targetCfg !== "" && !targetOptions.some((o) => o.path === settings.targetCfg);

  const cfgSelect = (
    which: "interfaceCfg" | "targetCfg",
    options: { name: string; path: string }[],
    isCustom: boolean,
  ) => {
    const value = settings[which];
    return (
      <select
        value={isCustom ? CUSTOM : value}
        onChange={(e) => {
          const v = e.target.value;
          patchSettings({ [which]: v === CUSTOM ? "" : v } as never);
        }}
      >
        <option value="">—</option>
        {options.map((o) => (
          <option key={o.path} value={o.path}>
            {o.name}
          </option>
        ))}
        <option value={CUSTOM}>{t("settings.custom")}</option>
      </select>
    );
  };

  return (
    <div className="form-grid">
      <div className="section-title">{t("settings.title")}</div>

      <div className="field">
        <label>{t("settings.binary")}</label>
        <input
          type="text"
          value={settings.binary}
          onChange={(e) => patchSettings({ binary: e.target.value })}
          onBlur={refresh}
        />
      </div>

      <div className="field">
        <label>{t("settings.scriptsDir")}</label>
        <input
          type="text"
          value={settings.scriptsDir}
          onChange={(e) => patchSettings({ scriptsDir: e.target.value })}
          onBlur={refresh}
          placeholder="/usr/share/openocd/scripts"
        />
        <div className="hint">
          {lists && lists.dirs.length > 0
            ? t("settings.scriptsDetected", { n: lists.dirs.length })
            : t("settings.scriptsNone")}
        </div>
      </div>

      <div className="field">
        <label>{t("settings.interface")}</label>
        {cfgSelect("interfaceCfg", ifaceOptions, ifaceCustom)}
        {ifaceCustom && (
          <input
            type="text"
            style={{ marginTop: 6 }}
            value={settings.interfaceCfg}
            onChange={(e) => patchSettings({ interfaceCfg: e.target.value })}
            placeholder="stlink.cfg"
          />
        )}
      </div>

      <div className="field">
        <label>{t("settings.target")}</label>
        {cfgSelect("targetCfg", targetOptions, targetCustom)}
        {targetCustom && (
          <input
            type="text"
            style={{ marginTop: 6 }}
            value={settings.targetCfg}
            onChange={(e) => patchSettings({ targetCfg: e.target.value })}
            placeholder="stm32f1x.cfg"
          />
        )}
      </div>

      <div className="field">
        <label>{t("settings.speed")}</label>
        <input
          type="number"
          min={0}
          value={settings.speed}
          onChange={(e) => patchSettings({ speed: Number(e.target.value) || 0 })}
        />
        <div className="hint">{t("settings.speedHint")}</div>
      </div>

      <div className="section-title">{t("settings.ports")}</div>
      <div className="portrow">
        <div className="field">
          <label>Telnet</label>
          <input type="number" value={settings.telnetPort} onChange={(e) => patchSettings({ telnetPort: Number(e.target.value) || 4444 })} />
        </div>
        <div className="field">
          <label>GDB</label>
          <input type="number" value={settings.gdbPort} onChange={(e) => patchSettings({ gdbPort: Number(e.target.value) || 3333 })} />
        </div>
        <div className="field">
          <label>TCL</label>
          <input type="number" value={settings.tclPort} onChange={(e) => patchSettings({ tclPort: Number(e.target.value) || 6666 })} />
        </div>
      </div>

      <div className="field">
        <label>{t("settings.customCmds")}</label>
        <textarea
          value={settings.customCmds}
          onChange={(e) => patchSettings({ customCmds: e.target.value })}
          placeholder={"adapter serial 0483\nreset_config none"}
        />
        <div className="hint">{t("settings.customCmdsHint")}</div>
      </div>

      <div className="hint" style={{ color: "var(--warn)" }}>
        {t("settings.hint")}
      </div>
      <button className="tb-btn" style={{ alignSelf: "flex-start" }} onClick={() => { refresh(); actions.pushLog("[settings] script list refreshed"); }}>
        {t("settings.refreshList")}
      </button>
    </div>
  );
}
