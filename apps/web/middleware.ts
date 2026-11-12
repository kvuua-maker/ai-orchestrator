import { NextResponse, type NextRequest } from "next/server";

const USER = process.env.AUTH_USER ?? "";
const PASS = process.env.AUTH_PASS ?? "";

/** HTTP Basic Auth: закриває UI і проксійований API від сторонніх (§7.5). */
export function middleware(req: NextRequest) {
  if (!USER || !PASS) return NextResponse.next();   // не налаштовано — не ламаємо локальну роботу

  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    const u = decoded.slice(0, idx);
    const p = decoded.slice(idx + 1);
    if (u === USER && p === PASS) return NextResponse.next();
  }
  return new NextResponse("Потрібна авторизація", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="AI Orchestrator", charset="UTF-8"' },
  });
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
