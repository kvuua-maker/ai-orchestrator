import { describe, it, expect } from "vitest";
import { classifyFailure, detectHardLimit, LoopGuard, retryDelayMs } from "./autonomy.js";

const err = (code: string, message: string, retryable = false) => ({ code, message, retryable });

describe("hard limits", () => {
  it("банк → hard_limit з альтернативою", () => {
    const v = detectHardLimit("зроби переказ коштів на IBAN")!;
    expect(v.kind).toBe("hard_limit");
    expect(v.alternative).toContain("платіжне доручення");
  });
  it("КЕП, біометрія, SMS — межі", () => {
    expect(detectHardLimit("підпиши КЕП")!.reason).toBe("qualified_signature");
    expect(detectHardLimit("увійди через Face ID")!.reason).toBe("biometric_auth");
    expect(detectHardLimit("надішли sms на номер")!.reason).toBe("sms_to_unknown_number");
  });
  it("звичайна задача — не межа", () => {
    expect(detectHardLimit("збери ціни з сайту")).toBeNull();
  });
});

describe("classifyFailure", () => {
  it("CAPTCHA → needs_human із питанням", () => {
    const v = classifyFailure({ tool: "http.fetch", error: err("UPSTREAM_ERROR", "cloudflare challenge detected"), attempts: 1 });
    expect(v.kind).toBe("needs_human");
    expect(v.question).toMatch(/CAPTCHA/);
    expect(v.options?.length).toBe(3);
  });
  it("логін/OTP → needs_human", () => {
    expect(classifyFailure({ tool: "t", error: err("AUTH", "login required"), attempts: 1 }).reason).toBe("login_required");
    expect(classifyFailure({ tool: "t", error: err("AUTH", "enter OTP"), attempts: 1 }).reason).toBe("otp_required");
  });
  it("transient і спроби ще є → retryable", () => {
    expect(classifyFailure({ tool: "t", error: err("TIMEOUT", "slow", true), attempts: 1, maxAttempts: 3 }).kind).toBe("retryable");
  });
  it("спроби вичерпано → dead_end", () => {
    const v = classifyFailure({ tool: "t", error: err("TIMEOUT", "slow", true), attempts: 3, maxAttempts: 3 });
    expect(v.kind).toBe("dead_end");
    expect(v.reason).toBe("attempts_exhausted");
  });
  it("POLICY_DENIED → dead_end одразу", () => {
    expect(classifyFailure({ tool: "t", error: err("POLICY_DENIED", "no"), attempts: 1 }).kind).toBe("dead_end");
  });
  it("hard limit перекриває все", () => {
    const v = classifyFailure({ tool: "t", error: err("TIMEOUT", "x", true), attempts: 1, goalText: "зроби переказ у банку" });
    expect(v.kind).toBe("hard_limit");
  });
});

describe("LoopGuard", () => {
  it("блокує після N однакових спроб", () => {
    const g = new LoopGuard(2);
    expect(g.observe("fetch:https://a")).toBe(false);
    expect(g.observe("fetch:https://a")).toBe(false);
    expect(g.observe("fetch:https://a")).toBe(true);
  });
  it("різні дії не блокують одна одну", () => {
    const g = new LoopGuard(2);
    g.observe("a"); g.observe("b"); g.observe("b");
    expect(g.observe("a")).toBe(false);
  });
});

describe("retryDelayMs", () => {
  it("експоненційний ріст зі стелею", () => {
    expect(retryDelayMs(1)).toBe(250);
    expect(retryDelayMs(3)).toBe(1000);
    expect(retryDelayMs(20)).toBe(8000);
  });
});
