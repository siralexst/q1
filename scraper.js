import playwright from "playwright";
import fetch from "node-fetch";
import path from "path";

// 🔑 Variabile din GitHub Secrets
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ALLOWED_LEAGUES = (process.env.ALLOWED_LEAGUES || "").split(",").map(s => s.trim());
const USER_AGENT =
  process.env.USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

const targetUrl = "https://www.aiscore.com/";

const ignorePatterns = [
  /\b(women|ladies|female)\b/i,
  /\bU\d{1,2}\b/i,
  /\bUnder ?\d{1,2}\b/i,
  /\bYouth\b/i,
  /\bAcademy\b/i,
  /\bReserve\b/i
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function upsertMatch(payload) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/matches`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates"
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) console.error("❌ Insert error:", await res.text());
  } catch (err) {
    console.error("⚠️ Supabase request failed:", err.message);
  }
}

(async () => {
  console.log(`📅 Scraping from homepage: ${targetUrl}`);

  const browser = await playwright.chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1366, height: 768 }
  });

  const page = await context.newPage();

  try {
    console.log("🌐 Opening AiScore homepage...");
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Așteaptă bara de taburi
    await page.waitForSelector("button, .tab-item, .nav-tabs", { timeout: 20000 });
    console.log("✅ Navigation bar loaded.");

    // Click pe tabul Finished
    const finishedTab =
      (await page.$("text=Finished")) ||
      (await page.$("button:has-text('Finished')")) ||
      (await page.$("li:has-text('Finished')"));

    if (finishedTab) {
      await finishedTab.click();
      console.log("✅ Clicked 'Finished' tab.");
    } else {
      console.log("❌ Couldn't find Finished tab, aborting.");
      await browser.close();
      return;
    }

    // Așteaptă ca meciurile să fie complet randate
    console.log("🕐 Waiting for matches to render completely...");
    await page.waitForFunction(() => {
      const matches = document.querySelectorAll(".comp-list a.match-container");
      return matches.length > 10;
    }, { timeout: 30000 });
    console.log("✅ Matches fully rendered on screen.");

    // Scroll progresiv
    for (let i = 0; i < 12; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await page.waitForTimeout(1200);
    }

    // Screenshot complet — garantat în workspace
    const debugPath = path.resolve(process.cwd(), "aiscore_debug.png");
    await page.screenshot({ path: debugPath, fullPage: true });
    console.log("📸 Screenshot saved at:", debugPath);

    // Extrage toate meciurile
    const matches = await page.$$eval(".comp-list a.match-container", (nodes) =>
      nodes.map((m) => {
        const status = m.querySelector(".status")?.innerText?.trim() || "";
        const home = m.querySelector(".team.home .name")?.innerText?.trim() || "";
        const away = m.querySelector(".team.away .name")?.innerText?.trim() || "";
        const goals_home =
          parseInt(m.querySelector(".score-home")?.innerText?.trim()) || 0;
        const goals_away =
          parseInt(m.querySelector(".score-away")?.innerText?.trim()) || 0;
        const half_text = m.querySelector(".half-over")?.innerText?.trim() || "";
        const league =
          m.querySelector("meta[itemprop='location']")?.content?.trim() ||
          "Unknown League";

        let halftime_home = 0,
          halftime_away = 0;
        if (half_text.includes("-")) {
          const parts = half_text.replace(/[A-Za-z]/g, "").trim().split("-");
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
          halftime_away
        };
      })
    );

    console.log(`ℹ️ Found ${matches.length} total matches`);

    let totalInserted = 0;

    for (const m of matches) {
      if (!m.status.toLowerCase().includes("ft")) continue;
      if (ignorePatterns.some((p) => p.test(`${m.league} ${m.home} ${m.away}`))) continue;
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
        match_date: new Date().toISOString().split("T")[0]
      };

      await upsertMatch(payload);
      console.log(`✅ ${m.league}: ${m.home} ${m.goals_home}-${m.goals_away} ${m.away}`);
      totalInserted++;
      await sleep(150);
    }

    console.log(`🏁 Total meciuri inserate: ${totalInserted}`);

    await page.waitForTimeout(2000);
  } catch (err) {
    console.error("💥 Scraper failed:", err.message);
    const failPath = path.resolve(process.cwd(), "aiscore_debug_failed.png");
    await page.screenshot({ path: failPath, fullPage: true });
    console.log("📸 Failure screenshot saved at:", failPath);
  }

  await browser.close();
  console.log("🧹 Browser closed.");
})();
