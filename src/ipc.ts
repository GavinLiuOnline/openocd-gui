// IPC layer: types shared with the Rust backend, a real Tauri adapter and a
// browser mock adapter (used when running under `pnpm dev` without Tauri).

export interface StartConfig {
  binary: string;
  config_files: string[];
  custom_cmds: string[];
  telnet_port: number;
  gdb_port: number;
  tcl_port: number;
  scripts_dir: string | null;
  extra_args: string[];
}

export interface TargetState {
  index: number;
  name: string;
  type: string;
  state: string;
  current: boolean;
  description: string;
}

export interface FlashBank {
  index: number;
  name: string;
  base: number;
  size: number;
}

export interface TargetInfo {
  version: string;
  targets: TargetState[];
  flash_banks: FlashBank[];
}

export interface CfgEntry {
  name: string;
  path: string;
  dir: string;
}

export interface ScriptLists {
  interfaces: CfgEntry[];
  targets: CfgEntry[];
  dirs: string[];
}

export interface LogLine {
  stream: string;
  line: string;
}

export interface MemoryBlock {
  addr: number;
  words: number[];
}

export interface Adapter {
  readonly isMock: boolean;
  listScripts(binary: string): Promise<ScriptLists>;
  start(cfg: StartConfig): Promise<TargetInfo>;
  stop(): Promise<void>;
  info(): Promise<TargetInfo>;
  readMemory(addr: number, count: number): Promise<MemoryBlock>;
  program(path: string, offset: number, erase: boolean, verify: boolean, reset: boolean): Promise<string>;
  verify(path: string, offset: number): Promise<string>;
  eraseAll(): Promise<string>;
  reset(mode: string): Promise<void>;
  halt(): Promise<void>;
  resume(): Promise<void>;
  raw(cmd: string): Promise<string>;
  pickFile(filters?: { name: string; extensions: string[] }[]): Promise<string | null>;
  onLog(cb: (l: LogLine) => void): () => void;
  onExit(cb: (code: number | null) => void): () => void;
}

/* ---------------------------------- real ---------------------------------- */

function tauriAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function createTauriAdapter(): Promise<Adapter> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const unlisteners: Array<() => void> = [];

  return {
    isMock: false,
    listScripts: (binary) => invoke("list_scripts", { binary: binary || null }),
    start: (cfg) => invoke("session_start", { cfg }),
    stop: () => invoke("session_stop"),
    info: () => invoke("get_target_info"),
    readMemory: (addr, count) => invoke("read_memory", { addr, count }),
    program: (path, offset, erase, verify, reset) =>
      invoke("flash_program", { path, offset, erase, verify, reset }),
    verify: (path, offset) => invoke("flash_verify", { path, offset }),
    eraseAll: () => invoke("flash_erase_all"),
    reset: (mode) => invoke("reset_target", { mode }),
    halt: () => invoke("halt_target"),
    resume: () => invoke("resume_target"),
    raw: (cmd) => invoke("raw_command", { cmd }),
    pickFile: async (filters) => {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const result = await open({
        multiple: false,
        directory: false,
        filters: filters ?? [
          { name: "Firmware", extensions: ["hex", "bin", "elf", "axf", "s19", "mot"] },
          { name: "All", extensions: ["*"] },
        ],
      });
      return typeof result === "string" ? result : null;
    },
    onLog: (cb) => {
      listen<LogLine>("ocd-log", (e) => cb(e.payload)).then((un) => unlisteners.push(un));
      return () => {};
    },
    onExit: (cb) => {
      listen<number | null>("ocd-exit", (e) => cb(e.payload)).then((un) => unlisteners.push(un));
      return () => {};
    },
  };
}

/* ---------------------------------- mock ---------------------------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MOCK_INFO: TargetInfo = {
  version: "Open On-Chip Debugger 0.12.0 (mock)",
  targets: [
    { index: 0, name: "main", type: "cortex_m", state: "halted", current: true, description: "mock.stm32f1x.cpu" },
  ],
  flash_banks: [{ index: 0, name: "stm32f1x.flash", base: 0x08000000, size: 0x10000 }],
};

function createMockAdapter(): Adapter {
  let connected = false;
  const logCbs = new Set<(l: LogLine) => void>();
  const emit = (line: string, stream = "stderr") => {
    logCbs.forEach((cb) => cb({ stream, line }));
  };
  const errIfDisconnected = () => {
    if (!connected) throw new Error("not connected");
  };

  return {
    isMock: true,
    async listScripts() {
      await sleep(150);
      const mk = (names: string[]) => names.map((n) => ({ name: n, path: `/usr/share/openocd/scripts/${n}`, dir: "/usr/share/openocd/scripts" }));
      return {
        interfaces: mk(["stlink.cfg", "stlink-dap.cfg", "cmsis-dap.cfg", "jlink.cfg", "ftdi.cfg", "usb_blaster.cfg"]),
        targets: mk(["stm32f1x.cfg", "stm32f4x.cfg", "stm32h7x.cfg", "stm32l0.cfg", "nrf51.cfg", "nrf52.cfg", "rp2040.cfg", "atsamv.cfg", "kl25.cfg"]),
        dirs: ["/usr/share/openocd/scripts"],
      };
    },
    async start() {
      emit("Info : openocd-gui mock adapter");
      emit("Info : Listening on port 4444 for telnet connections");
      await sleep(600);
      emit("Info : clock speed 4000 kHz");
      await sleep(400);
      emit("Info : STLINK V2J29 (API v2) VID:PID 0483:3748");
      emit("Info : Target voltage: 3.28 V");
      emit("Info : stm32f1x.cpu: hardware has 6 breakpoints, 4 watchpoints");
      emit("Info : accepting 'telnet' connection on tcp/4444");
      connected = true;
      await sleep(300);
      return MOCK_INFO;
    },
    async stop() {
      errIfDisconnected();
      emit("shutdown command invoked");
      await sleep(200);
      connected = false;
    },
    async info() {
      errIfDisconnected();
      await sleep(120);
      return MOCK_INFO;
    },
    async readMemory(addr, count) {
      errIfDisconnected();
      await sleep(80 + count * 0.2);
      const words: number[] = [];
      for (let i = 0; i < count; i++) {
        const a = addr + i * 4;
        if (a === 0x08000000) words.push(0x20005000);
        else if (a === 0x08000004) words.push(0x080001a9);
        else if (a >= 0x20000000 && a < 0x20005000) words.push(0x6d6f636c);
        else if (a >= 0x08000000 && a < 0x08010000) words.push(0xbf00b5f0 ^ ((a * 2654435761) >>> 0 & 0xff00ff));
        else if (a >= 0x40000000 && a < 0x50000000) words.push(0x0000abcd);
        else words.push(0xffffffff);
      }
      return { addr, words };
    },
    async program(path, offset, erase, verify, reset) {
      errIfDisconnected();
      emit(`Info : halting target`);
      await sleep(200);
      if (erase) {
        emit("Info : erasing flash...");
        await sleep(800);
        emit("Info : flash erased");
      }
      emit(`Debug: flash write_image "${path}" offset 0x${offset.toString(16)}`);
      await sleep(1500);
      emit("Info : wrote 65536 bytes from file in 1.42s");
      if (verify) {
        await sleep(900);
        emit("Info : verified 65536 bytes in 0.71s");
      }
      if (reset) {
        emit("Info : reset run");
      }
      return "wrote 65536 bytes" + (verify ? ", verified" : "");
    },
    async verify(path, offset) {
      errIfDisconnected();
      emit(`Debug: verify_image "${path}" offset 0x${offset.toString(16)}`);
      await sleep(900);
      emit("Info : verified 65536 bytes in 0.71s");
      return "verified 65536 bytes";
    },
    async eraseAll() {
      errIfDisconnected();
      emit("Info : halting target");
      emit("Info : erasing sectors 0..127");
      await sleep(1200);
      emit("Info : erase check finished");
      return "erase done";
    },
    async reset(mode) {
      errIfDisconnected();
      emit(`Info : reset ${mode}`);
      await sleep(250);
      if (mode === "halt") MOCK_INFO.targets[0].state = "halted";
      if (mode === "run") MOCK_INFO.targets[0].state = "running";
    },
    async halt() {
      errIfDisconnected();
      emit("Info : halt");
      await sleep(200);
      MOCK_INFO.targets[0].state = "halted";
    },
    async resume() {
      errIfDisconnected();
      emit("Info : resume");
      await sleep(150);
      MOCK_INFO.targets[0].state = "running";
    },
    async raw(cmd) {
      errIfDisconnected();
      emit(cmd, "stdout");
      await sleep(150);
      if (cmd === "version") return MOCK_INFO.version;
      return `(mock) ok`;
    },
    async pickFile() {
      await sleep(150);
      return "/home/user/project/build/firmware.hex";
    },
    onLog(cb) {
      logCbs.add(cb);
      return () => logCbs.delete(cb);
    },
    onExit(cb) {
      void cb;
      return () => {};
    },
  };
}

let cached: Adapter | null = null;

export async function getAdapter(): Promise<Adapter> {
  if (!cached) cached = tauriAvailable() ? await createTauriAdapter() : createMockAdapter();
  return cached;
}
