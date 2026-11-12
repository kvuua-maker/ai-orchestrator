import { describe, it, expect, afterAll } from "vitest";
import { ProcessSandbox, buildDockerArgs, scrubEnv } from "./index.js";

const sbx = new ProcessSandbox();
afterAll(async () => { await sbx.dispose(); });

describe("ProcessSandbox", () => {
  it("виконує команду і повертає stdout", async () => {
    const r = await sbx.run("node", ["-e", "console.log('hello-from-sandbox')"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("hello-from-sandbox");
    expect(r.driver).toBe("process");
  });

  it("передає exit code", async () => {
    const r = await sbx.run("node", ["-e", "process.exit(3)"]);
    expect(r.code).toBe(3);
  });

  it("вбиває завислу команду по таймауту", async () => {
    const r = await sbx.run("node", ["-e", "setTimeout(()=>{},60000)"], { timeoutMs: 700 });
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(5000);
  });

  it("обрізає занадто довгий вивід", async () => {
    const r = await sbx.run("node", ["-e", "console.log('x'.repeat(5000))"], { maxOutputBytes: 100 });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(100);
  });

  it("не бачить секретів середовища", async () => {
    process.env.AIO_SECRET_PROBE = "leaked";
    const r = await sbx.run("node", ["-e", "console.log(process.env.AIO_SECRET_PROBE ?? 'absent')"]);
    expect(r.stdout.trim()).toBe("absent");
    delete process.env.AIO_SECRET_PROBE;
  });

  it("працює в ізольованій робочій директорії і бачить передані файли", async () => {
    const r = await sbx.run("node", ["-e", "const fs=require('fs');console.log(fs.readFileSync('in.txt','utf8'))"], { files: { "in.txt": "fixture-ok" } });
    expect(r.stdout.trim()).toBe("fixture-ok");
  });
});

describe("Docker/gVisor конфігурація", () => {
  it("аргументи містять усі обов'язкові обмеження", () => {
    const args = buildDockerArgs("img", "node", ["-e", "1"], "/work/x").join(" ");
    for (const f of ["--runtime=runsc", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=128", "--user=10001:10001"]) {
      expect(args).toContain(f);
    }
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("docker.sock");
  });
});

describe("scrubEnv", () => {
  it("лишає тільки allowlist + HOME/TMPDIR", () => {
    const env = scrubEnv({ PATH: "/usr/bin", SECRET: "x", AWS_KEY: "y", LANG: "uk_UA.UTF-8" }, "/w");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.LANG).toBe("uk_UA.UTF-8");
    expect(env.SECRET).toBeUndefined();
    expect(env.AWS_KEY).toBeUndefined();
    expect(env.HOME).toBe("/w");
  });
});
