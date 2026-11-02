import { createContext, useContext, useState, type ReactNode } from "react";

export type Lang = "zh" | "en";

const zh: Record<string, string> = {
  "app.title": "OpenOCD GUI",
  "app.subtitle": "OpenOCD 跨平台图形前端",
  "theme.toggle": "切换主题",

  "toolbar.connect": "连接",
  "toolbar.disconnect": "断开",
  "toolbar.connecting": "连接中…",
  "toolbar.halt": "暂停",
  "toolbar.resume": "运行",
  "toolbar.resetRun": "复位运行",
  "toolbar.resetHalt": "复位暂停",

  "tabs.info": "目标信息",
  "tabs.memory": "内存查看",
  "tabs.flash": "Flash 操作",

  "settings.title": "连接设置",
  "settings.binary": "OpenOCD 路径",
  "settings.scriptsDir": "脚本目录",
  "settings.scriptsDetected": "检测到 {n} 个脚本目录",
  "settings.scriptsNone": "未自动检测到脚本目录,可手动指定",
  "settings.interface": "接口配置 (probe)",
  "settings.target": "目标配置 (target)",
  "settings.custom": "手动输入…",
  "settings.customEmpty": "手动输入的路径不能为空",
  "settings.customPathHint": "需带 interface/ 或 target/ 前缀,或使用绝对路径(OpenOCD 不递归搜索脚本)",
  "settings.interfaceRequired": "未选择接口配置,OpenOCD 会报 \"Debug Adapter has to be specified\"",
  "settings.speed": "适配器速率 (kHz)",
  "settings.speedHint": "0 = 使用默认值",
  "settings.ports": "端口",
  "settings.customCmds": "自定义命令 (-c)",
  "settings.customCmdsHint": "每行一条,连接时应用",
  "settings.hint": "修改后需重新连接生效",
  "settings.refreshList": "刷新列表",

  "info.version": "OpenOCD 版本",
  "info.target": "目标",
  "info.state": "内核状态",
  "info.adapter": "接口",
  "info.ports": "端口",
  "info.flashBanks": "Flash 存储区",
  "info.noBanks": "(无)",
  "info.sizeUnknown": "未知 (探测失败)",
  "info.sizeZeroHint": "OpenOCD 没能读出 Flash 容量：通常是芯片 ID 未被识别（克隆片/型号与 target 配置不符）或 SWD 链路不稳定。点「重新探测容量」可让 OpenOCD 重新 probe 该 bank，或直接读芯片的 FLASH_SIZE 选项字节。",
  "info.inferred": "FLASH_SIZE 推断",
  "info.probeSizes": "重新探测容量",
  "info.name": "名称",
  "info.base": "基地址",
  "info.size": "大小",
  "info.refresh": "刷新",
  "info.notConnected": "未连接",
  "info.noTarget": "(未知)",

  "memory.address": "地址",
  "memory.length": "长度",
  "memory.read": "读取",
  "memory.auto": "自动刷新",
  "memory.hint": "输入十六进制地址,如 0x08000000",
  "memory.empty": "输入地址后点击「读取」",

  "flash.file": "固件文件",
  "flash.browse": "浏览…",
  "flash.offset": "偏移 (hex)",
  "flash.offsetHint": "bin 文件通常需要,hex/elf 可为 0",
  "flash.eraseBefore": "烧录前全片擦除",
  "flash.verifyAfter": "烧录后校验",
  "flash.resetAfter": "完成后复位运行",
  "flash.program": "烧录",
  "flash.verifyBtn": "校验",
  "flash.eraseAll": "全片擦除",
  "flash.eraseConfirm": "确定要擦除整片 Flash?此操作不可恢复!",
  "flash.result": "执行结果",
  "flash.noFile": "请先选择固件文件",
  "flash.dumpTitle": "读取内存导出 bin",
  "flash.dumpAddr": "起始地址",
  "flash.dumpSize": "长度",
  "flash.dumpSizeHint": "默认取 Flash 容量；容量探测失败时手动填写（如 0x8000）。读 RAM/外设区同理。",
  "flash.dumpFile": "输出文件",
  "flash.dumpSave": "另存…",
  "flash.dumpBtn": "读取并保存",
  "flash.dumpNoPath": "请先选择输出文件路径",
  "flash.dumpNoSize": "长度未填写：容量未知时请手动输入，例如 0x8000",
  "flash.dumpHaltNote": "读取前会先暂停目标，完成后可点「运行」恢复。",
  "flash.bankInfo": "存储区 #{i}：{base}，{size}",

  "log.title": "日志",
  "log.clear": "清空",
  "log.autoscroll": "自动滚动",
  "log.filter": "过滤…",
  "log.lines": "{n} 行",

  "status.disconnected": "未连接",
  "status.connecting": "连接中…",
  "status.connected": "已连接",
  "status.mock": "演示模式",

  "common.error": "错误",
  "common.close": "关闭",
  "common.bytes": "字节",
};

const en: Record<string, string> = {
  "app.title": "OpenOCD GUI",
  "app.subtitle": "Cross-platform front-end for OpenOCD",
  "theme.toggle": "Toggle theme",

  "toolbar.connect": "Connect",
  "toolbar.disconnect": "Disconnect",
  "toolbar.connecting": "Connecting…",
  "toolbar.halt": "Halt",
  "toolbar.resume": "Run",
  "toolbar.resetRun": "Reset Run",
  "toolbar.resetHalt": "Reset Halt",

  "tabs.info": "Target Info",
  "tabs.memory": "Memory",
  "tabs.flash": "Flash",

  "settings.title": "Connection Settings",
  "settings.binary": "OpenOCD binary",
  "settings.scriptsDir": "Scripts directory",
  "settings.scriptsDetected": "{n} script directorie(s) detected",
  "settings.scriptsNone": "No scripts dir detected, you can set it manually",
  "settings.interface": "Interface config (probe)",
  "settings.target": "Target config",
  "settings.custom": "Custom…",
  "settings.customEmpty": "Custom path cannot be empty",
  "settings.customPathHint": "Use an interface/ or target/ prefix, or an absolute path (OpenOCD does not search recursively)",
  "settings.interfaceRequired": "No interface config: OpenOCD fails with \"Debug Adapter has to be specified\"",
  "settings.speed": "Adapter speed (kHz)",
  "settings.speedHint": "0 = leave default",
  "settings.ports": "Ports",
  "settings.customCmds": "Custom commands (-c)",
  "settings.customCmdsHint": "One per line, applied on connect",
  "settings.hint": "Reconnect to apply changes",
  "settings.refreshList": "Refresh list",

  "info.version": "OpenOCD version",
  "info.target": "Target",
  "info.state": "Core state",
  "info.adapter": "Interface",
  "info.ports": "Ports",
  "info.flashBanks": "Flash banks",
  "info.noBanks": "(none)",
  "info.sizeUnknown": "unknown (probe failed)",
  "info.sizeZeroHint": "OpenOCD could not read the flash size: usually an unrecognised chip ID (clone, or a target config that does not match the part) or an unstable SWD link. Use \"Re-probe flash size\" to make OpenOCD probe the bank again and fall back to the chip's FLASH_SIZE option byte.",
  "info.inferred": "from FLASH_SIZE",
  "info.probeSizes": "Re-probe flash size",
  "info.name": "Name",
  "info.base": "Base",
  "info.size": "Size",
  "info.refresh": "Refresh",
  "info.notConnected": "Not connected",
  "info.noTarget": "(unknown)",

  "memory.address": "Address",
  "memory.length": "Length",
  "memory.read": "Read",
  "memory.auto": "Auto refresh",
  "memory.hint": "Hex address, e.g. 0x08000000",
  "memory.empty": "Enter an address and click Read",

  "flash.file": "Firmware file",
  "flash.browse": "Browse…",
  "flash.offset": "Offset (hex)",
  "flash.offsetHint": "usually needed for .bin; 0 for .hex/.elf",
  "flash.eraseBefore": "Erase before programming",
  "flash.verifyAfter": "Verify after programming",
  "flash.resetAfter": "Reset run when done",
  "flash.program": "Program",
  "flash.verifyBtn": "Verify",
  "flash.eraseAll": "Erase chip",
  "flash.eraseConfirm": "Erase the entire flash? This cannot be undone!",
  "flash.result": "Result",
  "flash.noFile": "Choose a firmware file first",
  "flash.dumpTitle": "Read out to bin file",
  "flash.dumpAddr": "Start address",
  "flash.dumpSize": "Length",
  "flash.dumpSizeHint": "Defaults to the flash size; when the probe failed type it yourself (e.g. 0x8000). Same for RAM/peripheral ranges.",
  "flash.dumpFile": "Output file",
  "flash.dumpSave": "Save as…",
  "flash.dumpBtn": "Read & save",
  "flash.dumpNoPath": "Choose the output file path first",
  "flash.dumpNoSize": "No length given: type one when the size is unknown, e.g. 0x8000",
  "flash.dumpHaltNote": "The target is halted before reading; click Run afterwards to resume.",
  "flash.bankInfo": "Bank #{i}: {base}, {size}",

  "log.title": "Log",
  "log.clear": "Clear",
  "log.autoscroll": "Auto scroll",
  "log.filter": "Filter…",
  "log.lines": "{n} lines",

  "status.disconnected": "Disconnected",
  "status.connecting": "Connecting…",
  "status.connected": "Connected",
  "status.mock": "Mock mode",

  "common.error": "Error",
  "common.close": "Close",
  "common.bytes": "bytes",
};

const dicts: Record<Lang, Record<string, string>> = { zh, en };

export function translate(lang: Lang, key: string, params?: Record<string, string | number>): string {
  let s = dicts[lang][key] ?? dicts.en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}

interface I18nCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const Ctx = createContext<I18nCtx>(null!);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(() => (localStorage.getItem("ocd.lang") as Lang) || "zh");
  const t = (key: string, params?: Record<string, string | number>) => translate(lang, key, params);
  const change = (l: Lang) => {
    localStorage.setItem("ocd.lang", l);
    setLang(l);
  };
  return <Ctx.Provider value={{ lang, setLang: change, t }}>{children}</Ctx.Provider>;
}

export function useI18n() {
  return useContext(Ctx);
}

/** Format a byte size in human readable form. */
export function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n % (1024 * 1024) === 0 ? 0 : 1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(n % 1024 === 0 ? 0 : 1)} KB`;
  return `${n} B`;
}

export function fmtHex(n: number, width = 8): string {
  return "0x" + n.toString(16).toUpperCase().padStart(width, "0");
}
