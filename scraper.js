import playwright from "playwright";
import fetch from "node-fetch";
import fs from "fs";

// 🔑 Variabile din GitHub Secrets
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ALLOWED_LEAGUES = (process.env.ALLOWED_LEAGUES || "")
  .split(",")
  .map((s) => s.trim());
const USER_AGENT =
  process.env.USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

// 📅 Data de ieri (AIScore organizează pe zile)
const date = new Date();
date.setDate(date.getDate() - 1);
const formatted = date.toISOString().split("T")[0].replace(/-/g, "");
const targetUrl = `https://www.aiscore.com/${formatted}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 🔄 Inserare în Supabase
async function upsertMatch(payload) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/matches`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok)
      console.error("❌ Insert error:", await res.text());
  } catch (err) {
    console.error("⚠️ Supabase request failed:", err.message);
  }
}

// 🚫 Excludem ligile și echipele feminine / tineret
const ignorePatterns = [
  /\b(women|ladies|female)\b/i,
  /\bU\d{1,2}\b/i,
  /\bUnder ?\d{1,2}\b/i,
  /\bYouth\b/i,
  /\bAcademy\b/i,
  /\bReserve\b/i,
];

(async () => {
  console.log(`📅 Scraping matches from: ${targetUrl}`);

  const browser = await playwright.chromium.launch({
    headless: true, // ✅ trebuie true pe GitHub Actions
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1366, height: 768 },
  });

  const page = await context.newPage();

  try {
    await page.goto(targetUrl, { waitUntil: "networkidle" });
    console.log("🌐 Page opened, waiting for JavaScript...");

    // Derulare + așteptare suplimentară pentru încărcarea completă
    await page.evaluate(async () => {
      window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 1000));
      window.scrollTo(0, document.body.scrollHeight);
    });

    await page.waitForTimeout(12000);

    // Captură de ecran pentru debugging
    await page.screenshot({ path: "aiscore_debug.png", fullPage: true });
    console.log("📸 Screenshot saved (aiscore_debug.png)");

    // Extragem toate meciurile
    const matches = await page.$$eval("a.match-container", (matchNodes) => {
      return matchNodes.map((m) => {
        const status =
          m.querySelector(".status")?.innerText?.trim() || "";
        const home =
          m.querySelector(".team.home .name")?.innerText?.trim() || "";
        const away =
          m.querySelector(".team.away .name")?.innerText?.trim() || "";
        const goals_home =
          parseInt(m.querySelector(".score-home")?.innerText?.trim()) || 0;
        const goals_away =
          parseInt(m.querySelector(".score-away")?.innerText?.trim()) || 0;
        const half_text =
          m.querySelector(".half-over")?.innerText?.trim() || "";
        const league =
          m
            .querySelector("meta[itemprop='location']")
            ?.getAttribute("content")
            ?.trim() ||
          m
            .querySelector("meta[itemprop='Organization']")
            ?.getAttribute("content")
            ?.trim() ||
          "Unknown League";

        let halftime_home = 0,
          halftime_away = 0;
        if (half_text.includes("-")) {
          const parts = half_text
            .replace(/[A-Za-z]/g, "")
            .trim()
            .split("-");
          halftime_home = parseInt(parts[0]) || 0;
          halftime_away = parseInt(parts[1]) || 0;
        }

        return {
          status,
          league,
          home,
          away,
          goals_home,
          goals_away,
          halftime_home,
          halftime_away,
        };
      });
    });

    console.log(`ℹ️ Found ${matches.length} total matches`);

    let totalInserted = 0;

    for (const m of matches) {
      // doar Finished (FT)
      if (!m.status || !m.status.toLowerCase().includes("ft")) continue;

      // excludem Women/Uxx
      if (ignorePatterns.some((p) =>
        p.test(`${m.league} ${m.home} ${m.away}`)
      ))
        continue;

      // filtrare ligă (opțional)
      if (
        ALLOWED_LEAGUES.length &&
        !ALLOWED_LEAGUES.some((x) =>
          m.league.toLowerCase().includes(x.toLowerCase())
        )
      )
        continue;

      const payload = {
        league: m.league,
        home_team: m.home,
        away_team: m.away,
        goals_home: m.goals_home,
        goals_away: m.goals_away,
        halftime_home: m.halftime_home,
        halftime_away: m.halftime_away,
        match_date: new Date().toISOString().split("T")[0],
      };

      await upsertMatch(payload);
      console.log(
        `✅ ${m.league}: ${m.home} ${m.goals_home}-${m.goals_away} ${m.away}`
      );
      totalInserted++;
      await sleep(200);
    }

    console.log(`🏁 Total meciuri inserate: ${totalInserted}`);
  } catch (err) {
    console.error("💥 Scraper failed:", err.message);
  }

  await browser.close();
  console.log("🧹 Browser closed.");
})();
