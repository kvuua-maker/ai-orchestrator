import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SandboxLimits {
  timeoutMs: number;
  maxOutputBytes: number;
  cpuSeconds: number;
  memoryMb: number;
}

export interface SandboxResult {
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  driver: string;
}

export interface Sandbox {
  readonly driver: "process" | "docker";
  run(command: string, args: string[], opts?: Partial<SandboxLimits> & { stdin?: string; files?: Record<string, string> }): Promise<SandboxResult>;
  dispose(): Promise<void>;
}

const DEFAULTS: SandboxLimits = { timeoutMs: 30_000, maxOutputBytes: 256 * 1024, cpuSeconds: 30, memoryMb: 512 };

/** Дозволені змінні середовища — усе інше вирізається (§5.3.3). */
export const ENV_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "TZ", "NODE_ENV"] as const;

export function scrubEnv(source: NodeJS.ProcessEnv, workdir: string): Record<string, string> {
  const out: Record<string, string> = { HOME: workdir, TMPDIR: workdir };
  for (const key of ENV_ALLOWLIST) if (source[key]) out[key] = source[key]!;
  return out;
}

/**
 * Аргументи захищеного контейнера (§5.3.2).
 * Винесено окремо, щоб тестувати флаги без Docker.
 */
export function buildDockerArgs(image: string, command: string, args: string[], workdir: string): string[] {
  return [
    "run", "--rm",
    "--runtime=runsc",              // gVisor
    "--network=none",
    "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
    "--memory=512m", "--memory-swap=512m",
    "--cpus=1", "--pids-limit=128",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user=10001:10001",
    "--ulimit", "nofile=512:512",
    "-v", `${workdir}:/work:rw`,
    "-w", "/work",
    image, command, ...args,
  ];
}

/** Dev-драйвер: той самий контракт, але без ізоляції ядра. Для CI і локальної роботи. */
export class ProcessSandbox implements Sandbox {
  readonly driver = "process" as const;
  private dir?: string;

  async run(command: string, args: string[], opts: Partial<SandboxLimits> & { stdin?: string; files?: Record<string, string> } = {}): Promise<SandboxResult> {
    const cfg = { ...DEFAULTS, ...opts };
    if (!this.dir) this.dir = await mkdtemp(join(tmpdir(), "aio-sbx-"));
    for (const [name, content] of Object.entries(opts.files ?? {})) {
      await writeFile(join(this.dir, name), content, "utf8");
    }
    const started = Date.now();
    return new Promise<SandboxResult>((resolve) => {
      const child = spawn(command, args, {
        cwd: this.dir, env: scrubEnv(process.env, this.dir!),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "", stderr = "", truncated = false, timedOut = false;
      const push = (chunk: Buffer, to: "out" | "err") => {
        const s = chunk.toString();
        if ((to === "out" ? stdout : stderr).length + s.length > cfg.maxOutputBytes) { truncated = true; return; }
        if (to === "out") stdout += s; else stderr += s;
      };
      child.stdout.on("data", (c) => push(c, "out"));
      child.stderr.on("data", (c) => push(c, "err"));
      if (opts.stdin) child.stdin.write(opts.stdin);
      child.stdin.end();
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, cfg.timeoutMs);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, durationMs: Date.now() - started, timedOut, truncated, driver: "process" });
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr: String(e.message), durationMs: Date.now() - started, timedOut, truncated, driver: "process" });
      });
    });
  }

  async dispose(): Promise<void> { if (this.dir) { await rm(this.dir, { recursive: true, force: true }); this.dir = undefined; } }
}

/** Docker+gVisor: реальна ізоляція. Потребує docker і runtime=runsc на хості (§5.3). */
export class DockerSandbox implements Sandbox {
  readonly driver = "docker" as const;
  constructor(private readonly image = process.env.SANDBOX_IMAGE ?? "aio/sandbox-base:latest") {}

  async run(command: string, args: string[], opts: Partial<SandboxLimits> = {}): Promise<SandboxResult> {
    const cfg = { ...DEFAULTS, ...opts };
    const workdir = await mkdtemp(join(tmpdir(), "aio-docker-"));
    const dockerArgs = buildDockerArgs(this.image, command, args, workdir);
    const started = Date.now();
    return new Promise<SandboxResult>((resolve) => {
      const child = spawn("docker", dockerArgs, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", (c) => { if (stdout.length < cfg.maxOutputBytes) stdout += c.toString(); });
      child.stderr.on("data", (c) => { if (stderr.length < cfg.maxOutputBytes) stderr += c.toString(); });
      const timer = setTimeout(() => child.kill("SIGKILL"), cfg.timeoutMs);
      child.on("close", async (code) => {
        clearTimeout(timer);
        await rm(workdir, { recursive: true, force: true });
        resolve({ code, stdout, stderr, durationMs: Date.now() - started, timedOut: false, truncated: false, driver: "docker" });
      });
      child.on("error", (e) => resolve({ code: null, stdout, stderr: String(e.message), durationMs: Date.now() - started, timedOut: false, truncated: false, driver: "docker" }));
    });
  }

  async dispose(): Promise<void> {}
}

export function createSandbox(): Sandbox {
  const drv = process.env.SANDBOX_DRIVER ?? "process";
  return drv === "docker" || drv === "gvisor" ? new DockerSandbox() : new ProcessSandbox();
}
