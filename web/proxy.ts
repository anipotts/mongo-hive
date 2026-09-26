import { NextResponse, type NextRequest } from "next/server";

// `?as=kap` switches who you are viewing as and remembers it (a demo identity, not auth).
// the cookie is set on the request too, so the very same render already sees the new viewer.
export function proxy(req: NextRequest) {
  const as = req.nextUrl.searchParams.get("as");
  if (!as || !/^[a-z][a-z0-9_-]{0,31}$/.test(as)) return NextResponse.next();
  req.cookies.set("hive_as", as);
  const res = NextResponse.next({ request: { headers: req.headers } });
  res.cookies.set("hive_as", as, { path: "/", sameSite: "lax" });
  return res;
}

export const config = { matcher: ["/((?!_next|favicon.ico|api).*)"] };
