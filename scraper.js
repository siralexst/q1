import playwright from "playwright";
import fetch from "node-fetch";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// ✅ schimbă aici liga dorită
const TARGET_URL = "https://www.betexplorer.com/football/france/ligue-1-2024-2025/results/";

async function upsertMatch(match) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/matches`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates"
      },
      body: JSON.stringify(match)
    });
    if (!res.ok) {
      console.error("❌ Supabase insert error:", await res.text());
    }
  } catch (e) {
    console.error("⚠️ Upsert failed:", e.message);
  }
}

(async () => {
  console.log(`🏁 Scraping BetExplorer results from: ${TARGET_URL}`);

  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage();

  // 📄 deschide pagina de rezultate (ignoră certificate SSL)
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60000, ignoreHTTPSErrors: true });

  console.log("⏳ Waiting for matches list...");
  await page.waitForFunction(() => {
    const rows = document.querySelectorAll("a.in-match");
    return rows.length > 10;
  }, { timeout: 60000 });
  console.log("✅ Matches list loaded.");

  // 🔗 extrage toate linkurile spre meciuri
  const links = await page.$$eval("a.in-match", els =>
    els.map(e => ({
      url: e.href,
      title: e.innerText.trim()
    }))
  );

  console.log(`🔗 Found ${links.length} match links`);

  const matches = [];

  for (const [i, link] of links.entries()) {
    console.log(`➡️ [${i + 1}/${links.length}] Opening ${link.url}`);

    try {
      const matchPage = await browser.newPage();
      await matchPage.goto(link.url, { waitUntil: "domcontentloaded", timeout: 45000, ignoreHTTPSErrors: true });

      // așteaptă header-ul meciului
      await matchPage.waitForSelector("h1", { timeout: 15000 });

      const matchData = await matchPage.evaluate(() => {
        const title = document.querySelector("h1")?.innerText.trim() || "";
        const date = document.querySelector(".wrap-section-content .date")?.innerText.trim() || "";
        const scoreFinal = document.querySelector(".result strong")?.innerText.trim() || "";

        // Scorul la pauză apare de obicei în textul: (HT: 1-0)
        const halfText = document.querySelector(".result")?.innerText.match(/\(.*?\)/)?.[0] || "";
        const ht = halfText.replace(/[^\d\-–]/g, "").trim();
        const [htHome, htAway] = ht.includes("-") ? ht.split(/[-–]/).map(n => parseInt(n.trim()) || 0) : [null, null];

        const [home, away] = title.split(" - ").map(t => t.trim());
        const [goalsHome, goalsAway] = scoreFinal.split(/[-–]/).map(n => parseInt(n.trim()) || 0);

        return {
          home,
          away,
          date,
          goalsHome,
          goalsAway,
          halftimeHome: htHome,
          halftimeAway: htAway
        };
      });

      if (matchData.home && matchData.away && !isNaN(matchData.goalsHome)) {
        matchData.league = "Ligue 1";
        matches.push(matchData);
        await upsertMatch(matchData);
        console.log(`⚽ ${matchData.date}: ${matchData.home} ${matchData.goalsHome}-${matchData.goalsAway} ${matchData.away} (HT ${matchData.halftimeHome}-${matchData.halftimeAway})`);
      } else {
        console.warn(`⚠️ Skipped invalid data for ${link.url}`);
      }

      await matchPage.close();
    } catch (err) {
      console.error(`💥 Failed to scrape ${link.url}:`, err.message);
    }

    // delay mic între pagini (evită rate limit)
    await new Promise(res => setTimeout(res, 1000));
  }

  console.log(`🎯 Total matches scraped: ${matches.length}`);
  await browser.close();
  console.log("🧹 Browser closed. All done!");
})();
