import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb, seed, type Db } from "../src/db/index.js";

let db: Db;
beforeAll(async () => { db = await createDb(); await seed(db); });
afterAll(async () => { await db.close(); });

describe("FORCE RLS (рівень БД, не застосунку)", () => {
  it("тенант A не бачить рядків тенанта B навіть прямим SQL", async () => {
    const rid = `run_rls${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}`;
    const idB = await db.tx("tnt_other001", async (q) => {
      const { rows } = await q<any>(
        `INSERT INTO runs (id, tenant_id, user_id, status, prompt, budget)
         VALUES ($1,'tnt_other001','usr_demo0001','queued','secret','{"maxUsd":1}'::jsonb)
         RETURNING id`, [rid]);
      return rows[0].id;
    });
    expect(idB).toBe(rid);

    const asA = await db.tx("tnt_demo0001", async (q) => {
      const direct = await q<any>("SELECT * FROM runs WHERE id = $1", [rid]);
      const count = await q<any>("SELECT count(*)::int AS n FROM runs");
      return { direct: direct.rows.length, total: count.rows[0].n };
    });

    expect(asA.direct).toBe(0);           // прямий SELECT по id не бачить чужий рядок
    expect(asA.total).toBeGreaterThanOrEqual(0);
  });

  it("без app.tenant_id не видно нічого", async () => {
    const { rows } = await db.query<any>("SELECT count(*)::int AS n FROM runs");
    expect(rows[0].n).toBe(0);
  });

  it("вставка з чужим tenant_id відхиляється політикою", async () => {
    await expect(
      db.tx("tnt_demo0001", (q) =>
        q(`INSERT INTO runs (id, tenant_id, user_id, status, prompt, budget)
           VALUES ($1,'tnt_other001','usr_demo0001','queued','x','{"maxUsd":1}'::jsonb)`),
      ),
    ).rejects.toThrow();
  });
});
