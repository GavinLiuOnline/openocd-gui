import { useEffect, useRef, useState } from "react";
import { useApp } from "../appContext";
import { fmtHex } from "../i18n";
import type { MemoryBlock } from "../ipc";

const LENGTHS = [
  { label: "256 B", words: 64 },
  { label: "1 KB", words: 256 },
  { label: "4 KB", words: 1024 },
];

function wordsToBytes(words: number[]): Uint8Array {
  const out = new Uint8Array(words.length * 4);
  words.forEach((w, i) => {
    out[i * 4] = w & 0xff;
    out[i * 4 + 1] = (w >>> 8) & 0xff;
    out[i * 4 + 2] = (w >>> 16) & 0xff;
    out[i * 4 + 3] = (w >>> 24) & 0xff;
  });
  return out;
}

function asciiByte(b: number): string {
  return b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
}

export function MemoryPanel() {
  const { t, conn, busy, api } = useApp();
  const [addrInput, setAddrInput] = useState("0x08000000");
  const [lenIdx, setLenIdx] = useState(1);
  const [auto, setAuto] = useState(false);
  const [data, setData] = useState<MemoryBlock | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoRef = useRef(false);
  autoRef.current = auto;

  const words = LENGTHS[lenIdx].words;

  const read = async (addr?: number) => {
    if (!api) return;
    let base: number;
    try {
      base = Number(BigInt(addrInput.trim() || "0") & ~15n);
      if (addr !== undefined) base = addr & ~15;
    } catch {
      setError(`bad address: ${addrInput}`);
      return;
    }
    try {
      const block = await api.readMemory(base, words);
      setData(block);
      setError(null);
    } catch (e) {
      setError(String(e));
      if (!autoRef.current) setData(null);
    }
  };

  // auto refresh
  useEffect(() => {
    if (!auto || conn !== "connected") return;
    const iv = setInterval(() => void read(), 1000);
    return () => clearInterval(iv);
  }, [auto, conn, addrInput, words]); // eslint-disable-line react-hooks/exhaustive-deps

  const canRead = conn === "connected" && !busy;
  const bytes = data ? wordsToBytes(data.words) : null;
  const rows: { addr: number; slice: Uint8Array }[] = [];
  if (bytes) {
    for (let i = 0; i < bytes.length; i += 16) {
      rows.push({ addr: data!.addr + i, slice: bytes.subarray(i, i + 16) });
    }
  }

  return (
    <div>
      <div className="mem-controls">
        <label className="check" style={{ color: "var(--muted)" }}>{t("memory.address")}</label>
        <input
          type="text"
          value={addrInput}
          onChange={(e) => setAddrInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && canRead && void read()}
          placeholder={t("memory.hint")}
          disabled={!canRead}
        />
        <label className="check" style={{ color: "var(--muted)" }}>{t("memory.length")}</label>
        <select value={lenIdx} onChange={(e) => setLenIdx(Number(e.target.value))}>
          {LENGTHS.map((l, i) => (
            <option key={l.label} value={i}>{l.label}</option>
          ))}
        </select>
        <button className="tb-btn" disabled={!canRead} onClick={() => void read()}>
          {t("memory.read")}
        </button>
        <button className="tb-btn" disabled={!canRead || !data} onClick={() => void read((data?.addr ?? 0) - words * 4)}>
          ◀
        </button>
        <button className="tb-btn" disabled={!canRead || !data} onClick={() => void read((data?.addr ?? 0) + words * 4)}>
          ▶
        </button>
        <label className="check">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          {t("memory.auto")}
        </label>
      </div>

      {error && <div className="flash-result err">{error}</div>}
      {!data && !error && <div className="empty-note">{t("memory.empty")}</div>}

      {data && (
        <div className="mem-table">
          {rows.map((r) => (
            <div className="mem-row" key={r.addr}>
              <span className="mem-addr">{fmtHex(r.addr)}</span>
              <span className="mem-bytes">
                {Array.from(r.slice).map((b, i) => (
                  <span key={i} className={i === 8 ? "gap" : undefined}>
                    {b.toString(16).padStart(2, "0")}
                  </span>
                ))}
              </span>
              <span className="mem-ascii">
                {Array.from(r.slice).map(asciiByte).join("")}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
