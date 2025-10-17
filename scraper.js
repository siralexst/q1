import playwright from "playwright";
import fetch from "node-fetch";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ALLOWED_LEAGUES = (process.env.ALLOWED_LEAGUES || "").split(",").map(s => s.trim());
const USER_AGENT = process.env.USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

// ⚙️ Data de ieri (AIScore organizează zilnic)
const date = new Date();
date.setDate(date.getDate() - 1);
const formatted = date.toISOString().split("T")[0].replace(/-/g, "");
const targetUrl = `https://www.aiscore.com/${formatted}`;

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function upsertMatch(payload) {
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
  if (!res.ok) {
    console.error("❌ Insert error:", await res.text());
  }
}

// ⚙️ Liste negre pentru excludere automată
const ignorePatterns = [
  /\b(women|ladies|female)\b/i,
  /\bU\d{1,2}\b/i,
  /\bUnder ?\d{1,2}\b/i,
  /\bYouth\b/i,
  /\bAcademy\b/i,
  /\bReserve\b/i
];

(async () => {
  console.log(`📅 Scraping matches from: ${targetUrl}`);

  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: USER_AGENT });
  const page = await context.newPage();

  await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);

  const leagues = await page.$$eval(".league-item", leagueNodes => {
    return leagueNodes.map(l => {
      const league = l.querySelector(".league-name")?.innerText?.trim() || null;
      const matches = [...l.querySelectorAll(".match-item")].map(m => {
        const status = m.querySelector(".status")?.innerText?.trim() || "";
        const home = m.querySelector(".team-home .name")?.innerText?.trim() || "";
        const away = m.querySelector(".team-away .name")?.innerText?.trim() || "";
        const score = m.querySelector(".score")?.innerText?.trim() || "";
        const half = m.querySelector(".half-score")?.innerText?.trim() || "";
        return { status, home, away, score, half };
      });
      return { league, matches };
    });
  });

  let totalInserted = 0;

  for (const l of leagues) {
    if (!l.league) continue;

    // 1️⃣ Filtrare ligă (doar cele permise)
    if (ALLOWED_LEAGUES.length && !ALLOWED_LEAGUES.some(x => l.league.toLowerCase().includes(x.toLowerCase()))) {
      continue;
    }

    // 2️⃣ Ignorăm ligi feminine / de juniori
    if (ignorePatterns.some(p => p.test(l.league))) {
      console.log(`⏩ Ignored youth/female league: ${l.league}`);
      continue;
    }

    for (const m of l.matches) {
      // doar Finished / FT
      if (!m.status || !m.status.toLowerCase().includes("ft")) continue;

      // ignorăm echipele feminine / Uxx
      if (ignorePatterns.some(p => p.test(`${m.home} ${m.away}`))) continue;
      if (!m.score?.includes("-")) continue;

      const [goals_home, goals_away] = m.score.split("-").map(x => parseInt(x.trim()) || 0);
      let halftime_home = 0, halftime_away = 0;

      if (m.half?.includes("-")) {
        const halfParts = m.half.replace(/[()HT]/g, "").split("-");
        halftime_home = parseInt(halfParts[0]?.trim()) || 0;
        halftime_away = parseInt(halfParts[1]?.trim()) || 0;
      }

      const payload = {
        league: l.league,
        home_team: m.home,
        away_team: m.away,
        goals_home,
        goals_away,
        halftime_home,
        halftime_away,
        match_date: new Date().toISOString().split("T")[0]
      };

      await upsertMatch(payload);
      console.log(`✅ ${l.league}: ${m.home} ${goals_home}-${goals_away} ${m.away}`);
      totalInserted++;
      await sleep(200);
    }
  }

  await browser.close();
  console.log(`🏁 Inserate ${totalInserted} meciuri în Supabase.`);
})();
