import { useState } from "react";
import { useApp } from "../appContext";

export function FlashPanel() {
  const { t, conn, busy, api, actions } = useApp();
  const [path, setPath] = useState("");
  const [offset, setOffset] = useState("0");
  const [erase, setErase] = useState(false);
  const [verify, setVerify] = useState(true);
  const [reset, setReset] = useState(true);
  const [result, setResult] = useState<{ text: string; cls: "" | "ok" | "err" }>({ text: "", cls: "" });

  const enabled = conn === "connected" && !busy;
  const parseOffset = () => {
    try {
      return Number(BigInt(offset.trim() || "0"));
    } catch {
      return NaN;
    }
  };

  const browse = async () => {
    const f = await api?.pickFile();
    if (f) setPath(f);
  };

  const program = () => {
    if (!path) {
      setResult({ text: t("flash.noFile"), cls: "err" });
      return;
    }
    const off = parseOffset();
    if (Number.isNaN(off)) {
      setResult({ text: `bad offset: ${offset}`, cls: "err" });
      return;
    }
    void actions.runOp(t("flash.program"), async () => {
      const r = await api!.program(path, off, erase, verify, reset);
      setResult({ text: r, cls: "ok" });
    });
  };

  const doVerify = () => {
    if (!path) {
      setResult({ text: t("flash.noFile"), cls: "err" });
      return;
    }
    void actions.runOp(t("flash.verifyBtn"), async () => {
      const r = await api!.verify(path, parseOffset() || 0);
      setResult({ text: r, cls: "ok" });
    });
  };

  const doErase = () => {
    if (!window.confirm(t("flash.eraseConfirm"))) return;
    void actions.runOp(t("flash.eraseAll"), async () => {
      const r = await api!.eraseAll();
      setResult({ text: r, cls: "ok" });
    });
  };

  return (
    <div className="flash-box">
      <div className="field">
        <label>{t("flash.file")}</label>
        <div className="flash-file-row">
          <input type="text" value={path} onChange={(e) => setPath(e.target.value)} placeholder="firmware.hex / firmware.bin / firmware.elf" />
          <button className="tb-btn" onClick={() => void browse()}>{t("flash.browse")}</button>
        </div>
      </div>

      <div className="field" style={{ maxWidth: 220 }}>
        <label>{t("flash.offset")}</label>
        <input type="text" value={offset} onChange={(e) => setOffset(e.target.value)} placeholder="0x0" />
        <div className="hint">{t("flash.offsetHint")}</div>
      </div>

      <div className="checks">
        <label>
          <input type="checkbox" checked={erase} onChange={(e) => setErase(e.target.checked)} />
          {t("flash.eraseBefore")}
        </label>
        <label>
          <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} />
          {t("flash.verifyAfter")}
        </label>
        <label>
          <input type="checkbox" checked={reset} onChange={(e) => setReset(e.target.checked)} />
          {t("flash.resetAfter")}
        </label>
      </div>

      <div className="flash-actions">
        <button className="tb-btn primary" disabled={!enabled} onClick={program}>{t("flash.program")}</button>
        <button className="tb-btn" disabled={!enabled} onClick={doVerify}>{t("flash.verifyBtn")}</button>
        <button className="tb-btn danger" disabled={!enabled} onClick={doErase}>{t("flash.eraseAll")}</button>
      </div>

      {(result.text || busy) && (
        <div>
          <div className="section-title">{t("flash.result")}</div>
          <div className={`flash-result ${result.cls}`}>{busy ?? result.text}</div>
        </div>
      )}
    </div>
  );
}
