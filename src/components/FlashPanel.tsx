import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../appContext";
import { fmtHex, fmtSize } from "../i18n";

export function FlashPanel() {
  const { t, conn, busy, api, actions, logs, targetInfo } = useApp();
  const [path, setPath] = useState("");
  const [offset, setOffset] = useState("0");
  const [erase, setErase] = useState(false);
  const [verify, setVerify] = useState(true);
  const [reset, setReset] = useState(true);
  const [result, setResult] = useState<{ text: string; cls: "" | "ok" | "err" }>({ text: "", cls: "" });
  const [elapsed, setElapsed] = useState(0);
  const [dumpAddr, setDumpAddr] = useState("");
  const [dumpSize, setDumpSize] = useState("");
  const [dumpPath, setDumpPath] = useState("");

  const bank = targetInfo?.flash_banks.find((b) => b.size > 0) ?? targetInfo?.flash_banks[0] ?? null;
  const bankBase = bank?.base ?? 0;
  const bankSize = bank?.size ?? 0;

  // Prefill the read-out range from the flash bank. The length keeps tracking the
  // bank unless the user typed their own, so a later re-probe does not leave a
  // stale size behind. An *unknown* size must not blank a length that was
  // recovered earlier (info refreshes drop the inferred size).
  const autoSize = useRef("");
  useEffect(() => {
    if (!bankBase) return;
    setDumpAddr((v) => v || fmtHex(bankBase));
    if (!bankSize) return;
    const next = fmtHex(bankSize);
    setDumpSize((v) => (v === "" || v === autoSize.current ? next : v));
    autoSize.current = next;
  }, [bankBase, bankSize]);

  useEffect(() => {
    if (!busy) return;
    const t0 = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed((Date.now() - t0) / 1000), 200);
    return () => clearInterval(id);
  }, [busy]);

  // OpenOCD reports flash progress as it goes; show the newest line so a long
  // operation is visibly alive rather than a frozen label.
  const lastLog = useMemo(() => {
    for (let i = logs.length - 1; i >= 0; i--) {
      if (logs[i].stream !== "app") return logs[i].line;
    }
    return "";
  }, [logs]);

  const enabled = conn === "connected" && !busy;
  const parseNum = (s: string) => {
    try {
      return Number(BigInt(s.trim() || "0"));
    } catch {
      return NaN;
    }
  };
  const parseOffset = () => parseNum(offset);

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

  const browseSave = async () => {
    const f = await api?.saveFile("flash_dump.bin");
    if (f) setDumpPath(f);
  };

  const doDump = () => {
    if (!dumpPath) {
      setResult({ text: t("flash.dumpNoPath"), cls: "err" });
      return;
    }
    const addr = parseNum(dumpAddr);
    const size = parseNum(dumpSize);
    if (!Number.isFinite(addr) || addr < 0) {
      setResult({ text: `bad address: ${dumpAddr}`, cls: "err" });
      return;
    }
    if (!Number.isFinite(size) || size <= 0) {
      setResult({ text: dumpSize.trim() ? `bad size: ${dumpSize}` : t("flash.dumpNoSize"), cls: "err" });
      return;
    }
    void actions.runOp(t("flash.dumpBtn"), async () => {
      const r = await api!.dumpMemory(dumpPath, addr, size);
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

      <div className="section-title" style={{ marginTop: 18 }}>{t("flash.dumpTitle")}</div>

      <div className="field">
        <label>{t("flash.dumpFile")}</label>
        <div className="flash-file-row">
          <input
            type="text"
            value={dumpPath}
            onChange={(e) => setDumpPath(e.target.value)}
            placeholder="flash_dump.bin"
            disabled={!enabled}
          />
          <button className="tb-btn" disabled={!enabled} onClick={() => void browseSave()}>{t("flash.dumpSave")}</button>
        </div>
      </div>

      <div className="mem-controls">
        <label className="check" style={{ color: "var(--muted)" }}>{t("flash.dumpAddr")}</label>
        <input
          type="text"
          value={dumpAddr}
          onChange={(e) => setDumpAddr(e.target.value)}
          placeholder="0x08000000"
          disabled={!enabled}
        />
        <label className="check" style={{ color: "var(--muted)" }}>{t("flash.dumpSize")}</label>
        <input
          type="text"
          value={dumpSize}
          onChange={(e) => setDumpSize(e.target.value)}
          placeholder="0x8000"
          disabled={!enabled}
        />
        <button className="tb-btn primary" disabled={!enabled} onClick={doDump}>{t("flash.dumpBtn")}</button>
      </div>

      {bank && (
        <div className="hint">
          {t("flash.bankInfo", {
            i: bank.index,
            base: fmtHex(bank.base),
            size: bankSize ? `${fmtSize(bankSize)}${bank.inferred ? ` · ${t("info.inferred")}` : ""}` : t("info.sizeUnknown"),
          })}
        </div>
      )}
      <div className="hint">{t("flash.dumpHaltNote")}</div>
      {bankSize === 0 && <div className="hint" style={{ color: "var(--warn)" }}>{t("flash.dumpSizeHint")}</div>}

      {(result.text || busy) && (
        <div>
          <div className="section-title">{t("flash.result")}</div>
          <div className={`flash-result ${result.cls}`}>
            {busy ? `${busy}… ${elapsed.toFixed(1)} s` : result.text}
            {busy && lastLog && (
              <div className="mono" style={{ marginTop: 4, fontSize: 12, opacity: 0.75 }}>
                {lastLog}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
