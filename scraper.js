import playwright from "playwright";
import fetch from "node-fetch";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

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
    if (!res.ok) console.error("❌ Supabase insert error:", await res.text());
  } catch (e) {
    console.error("⚠️ Upsert failed:", e.message);
  }
}

(async () => {
  console.log(`🏁 Scraping BetExplorer results from: ${TARGET_URL}`);
  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("table.table-main tbody tr", { timeout: 20000 });

  const matches = await page.$$eval("table.table-main tbody tr", (rows) =>
    rows
      .map((r) => {
        const teams = r.querySelector("a.in-match")?.innerText.trim() || "";
        const score = r.querySelector("td.h-text-center")?.innerText.trim() || "";
        const date = r.querySelector("td.h-text-right")?.innerText.trim() || "";
        if (!teams || !score.includes("-")) return null;

        const [home, away] = teams.split(" - ").map((t) => t.trim());
        const [goalsHome, goalsAway] = score
          .split("-")
          .map((n) => parseInt(n.trim()) || 0);

        return { league: "Ligue 1", home, away, goalsHome, goalsAway, date };
      })
      .filter(Boolean)
  );

  console.log(`✅ Found ${matches.length} matches`);

  let inserted = 0;
  for (const m of matches) {
    await upsertMatch(m);
    console.log(`⚽ ${m.date}: ${m.home} ${m.goalsHome}-${m.goalsAway} ${m.away}`);
    inserted++;
  }

  console.log(`🎯 Total inserted: ${inserted}`);
  await browser.close();
})();
