import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/Sidebar";
import { viewer, visibleHives } from "@/lib/hive";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Hive",
  description: "my agent learned it, so yours already knows it",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const list = await visibleHives(await viewer());
  const side = list.map(({ info, tools }) => ({ name: info._id, visibility: info.visibility, tools, members: [...new Set([info.owner, ...info.members])] }));
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      {/* extensions (e.g. colorzilla) inject attributes into body before hydration */}
      <body suppressHydrationWarning>
        <div className="app">
          <Sidebar hives={side} />
          <div className="content">{children}</div>
        </div>
      </body>
    </html>
  );
}
