import { useEffect, useState } from "react";
import { useApp } from "../appContext";
import type { ScriptLists } from "../ipc";

const CUSTOM = "__custom__";

export function SettingsPanel() {
  const { t, settings, patchSettings, api, actions } = useApp();
  const [lists, setLists] = useState<ScriptLists | null>(null);
  const [listVersion, setListVersion] = useState(0);
  const [customIface, setCustomIface] = useState(false);
  const [customTarget, setCustomTarget] = useState(false);

  const refresh = () => setListVersion((n) => n + 1);

  // `api` resolves asynchronously after mount, so the list must be (re)loaded once it exists.
  useEffect(() => {
    if (!api) return;
    let disposed = false;
    api
      .listScripts(settings.binary)
      .then((l) => !disposed && setLists(l))
      .catch(() => !disposed && setLists(null));
    return () => {
      disposed = true;
    };
  }, [api, listVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const ifaceOptions = lists?.interfaces ?? [];
  const targetOptions = lists?.targets ?? [];
  const notInList = (options: { path: string }[], value: string) => value !== "" && !options.some((o) => o.path === value);
  const ifaceCustom = customIface || notInList(ifaceOptions, settings.interfaceCfg);
  const targetCustom = customTarget || notInList(targetOptions, settings.targetCfg);

  const cfgSelect = (
    which: "interfaceCfg" | "targetCfg",
    options: { name: string; path: string }[],
    isCustom: boolean,
    setCustom: (v: boolean) => void,
  ) => {
    const value = settings[which];
    return (
      <select
        value={isCustom ? CUSTOM : value}
        onChange={(e) => {
          const v = e.target.value;
          setCustom(v === CUSTOM);
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

  const customField = (which: "interfaceCfg" | "targetCfg", placeholder: string) => {
    const value = settings[which];
    const warn =
      value === ""
        ? t("settings.customEmpty")
        : !value.includes("/") && !value.includes("\\")
          ? t("settings.customPathHint")
          : null;
    return (
      <>
        <input
          type="text"
          style={{ marginTop: 6 }}
          value={value}
          onChange={(e) => patchSettings({ [which]: e.target.value } as never)}
          placeholder={placeholder}
        />
        {warn && (
          <div className="hint" style={{ color: "var(--warn)" }}>
            {warn}
          </div>
        )}
      </>
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
        {cfgSelect("interfaceCfg", ifaceOptions, ifaceCustom, setCustomIface)}
        {ifaceCustom && customField("interfaceCfg", "interface/stlink.cfg")}
        {settings.interfaceCfg === "" && (
          <div className="hint" style={{ color: "var(--warn)" }}>
            {t("settings.interfaceRequired")}
          </div>
        )}
      </div>

      <div className="field">
        <label>{t("settings.target")}</label>
        {cfgSelect("targetCfg", targetOptions, targetCustom, setCustomTarget)}
        {targetCustom && customField("targetCfg", "target/stm32f1x.cfg")}
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
