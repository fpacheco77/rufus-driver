/**
 * Rufus Driver — Bright Data Scraping Browser microservice
 *
 * Exposes one POST endpoint:
 *
 *   POST /rufus
 *   Authorization: Bearer <SHARED_SECRET>           (optional but recommended)
 *   Content-Type: application/json
 *   {
 *     "asin": "B0CCJXTV24",
 *     "amazonCookies": "session-id=...; ubid-main=...; at-main=...",
 *     "questions": ["What is this product for?", ...]
 *   }
 *
 *   → { "qa": [ { "q": "...", "r": "..." }, ... ] }
 *
 * Connects to Bright Data Scraping Browser over wss:// (CDP) using playwright-core,
 * loads the Amazon PDP, opens the Rufus side panel, types each question, and
 * scrapes the streamed response text.
 */

const express = require('express');
const { chromium } = require('playwright-core');

const BD_WSS = process.env.BRIGHT_DATA_WSS;       // e.g. wss://brd-customer-...:PASS@brd.superproxy.io:9222
const SHARED_SECRET = process.env.SHARED_SECRET;  // shared bearer token (recommended)
const PORT = parseInt(process.env.PORT || '3000', 10);

if (!BD_WSS) {
  console.error('FATAL: BRIGHT_DATA_WSS env var is required');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '2mb' }));

/* ---------- helpers ---------- */

/**
 * Parse a "name1=value1; name2=value2" cookie string into Playwright cookie objects.
 */
function parseCookieString(cookieStr) {
  if (!cookieStr || typeof cookieStr !== 'string') return [];
  return cookieStr
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
    .map(pair => {
      const eq = pair.indexOf('=');
      if (eq < 0) return null;
      const name = pair.substring(0, eq).trim();
      const value = pair.substring(eq + 1).trim();
      if (!name) return null;
      return {
        name,
        value,
        domain: '.amazon.com',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'Lax',
      };
    })
    .filter(Boolean);
}

/**
 * Heuristically clean a Rufus response: strip the question echo, completion marker,
 * suggestion-pill chips, and feedback-widget tail.
 */
function cleanRufusAnswer(rawNewContent, question) {
  let answer = rawNewContent || '';

  // 1. Strip leading "Customer question\n<question>\n" echo
  const qIdx = answer.indexOf(question);
  if (qIdx >= 0) answer = answer.substring(qIdx + question.length);
  // also strip a leading "Customer question" header if it preceded the question echo
  answer = answer.replace(/^[\s\n]*Customer question[\s\n]+/i, '');

  // 2. Cut at known UI tail markers
  const cutoffs = [
    'Rufus has completed generating a response',
    'Your feedback has been submitted',
    'Select All That Apply',
    'This is inaccurate',
    'Scheduled actions',
    'Automate shopping',
  ];
  for (const m of cutoffs) {
    const idx = answer.indexOf(m);
    if (idx >= 0) answer = answer.substring(0, idx);
  }

  // 3. Trim trailing suggestion pills: short lines after the main response
  // (Rufus appends 3-4 short follow-up suggestions at the end. We keep the body.)
  const lines = answer.split('\n').map(l => l.trim());
  // Walk backwards: remove trailing single-line items that look like pill suggestions.
  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    if (last === '' || last.length < 80 && /^[A-Z]/.test(last) && !/[.!?]$/.test(last)) {
      lines.pop();
    } else {
      break;
    }
  }

  return lines.join('\n').trim();
}

/* ---------- main route ---------- */

app.post('/rufus', async (req, res) => {
  // Auth
  if (SHARED_SECRET) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${SHARED_SECRET}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  const { asin, amazonCookies, questions } = req.body || {};
  if (!asin || !/^[A-Z0-9]{10}$/i.test(asin)) {
    return res.status(400).json({ error: 'asin must be a 10-char ASIN' });
  }
  if (!Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'questions[] is required' });
  }

  let browser;
  const startedAt = Date.now();
  try {
    console.log(`[${asin}] connecting to Bright Data...`);
    browser = await chromium.connectOverCDP(BD_WSS, { timeout: 60_000 });
    const context = browser.contexts()[0] || (await browser.newContext());

    if (amazonCookies) {
      const cookies = parseCookieString(amazonCookies);
      console.log(`[${asin}] applying ${cookies.length} cookies`);
      await context.addCookies(cookies);
    }

    const page = await context.newPage();
    page.setDefaultTimeout(60_000);

    console.log(`[${asin}] navigating to PDP`);
    await page.goto(`https://www.amazon.com/dp/${asin}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // Wait for either the Rufus textarea (panel auto-open) or the launcher button
    const textareaSel = '#rufus-text-area';
    const launcherSel = '#nav-rufus-disco';

    const opened = await Promise.race([
      page.waitForSelector(textareaSel, { timeout: 15_000 }).then(() => 'textarea').catch(() => null),
      page.waitForSelector(launcherSel, { timeout: 15_000 }).then(() => 'launcher').catch(() => null),
    ]);

    if (opened === 'launcher') {
      console.log(`[${asin}] clicking Rufus launcher`);
      await page.click(launcherSel).catch(() => {});
      await page.waitForSelector(textareaSel, { timeout: 20_000 });
    } else if (!opened) {
      throw new Error('Rufus panel not found — Amazon may have changed the DOM or session is not authenticated');
    }

    const qa = [];
    for (const question of questions) {
      const trimmedQ = String(question).trim();
      console.log(`[${asin}] asking: ${trimmedQ.substring(0, 80)}`);

      // Snapshot panel length BEFORE submitting so we can isolate this answer's text
      const before = await page.evaluate(() =>
        document.getElementById('nav-flyout-rufus')?.innerText?.length || 0
      );

      // Fill + submit
      await page.fill(textareaSel, trimmedQ);
      await page.click('#rufus-submit-button');

      // Poll until Rufus shows "Rufus has completed generating a response" beyond `before`
      // AND innerText length is stable for two consecutive polls.
      const POLL_MS = 1500;
      const TIMEOUT_MS = 90_000;
      const t0 = Date.now();
      let lastLen = before;
      let stable = 0;

      while (Date.now() - t0 < TIMEOUT_MS) {
        await page.waitForTimeout(POLL_MS);
        const { len, completionAfter } = await page.evaluate((cutoff) => {
          const el = document.getElementById('nav-flyout-rufus');
          const t = el?.innerText || '';
          const idx = t.indexOf('Rufus has completed generating a response', cutoff);
          return { len: t.length, completionAfter: idx >= 0 };
        }, before);

        if (completionAfter && len === lastLen) {
          stable++;
          if (stable >= 2) break;
        } else {
          stable = 0;
        }
        lastLen = len;
      }

      // Capture the new content slice
      const fullText = await page.evaluate(() =>
        document.getElementById('nav-flyout-rufus')?.innerText || ''
      );
      const newContent = fullText.substring(before);
      const answer = cleanRufusAnswer(newContent, trimmedQ);

      qa.push({ q: trimmedQ, r: answer });
      console.log(`[${asin}] answer: ${answer.length} chars`);

      // Brief pause between questions to let UI settle
      await page.waitForTimeout(800);
    }

    await page.close().catch(() => {});

    const elapsedMs = Date.now() - startedAt;
    console.log(`[${asin}] done in ${elapsedMs}ms`);
    return res.json({ qa, elapsedMs });
  } catch (err) {
    console.error(`[${asin}] error:`, err);
    return res.status(500).json({ error: String(err && err.message || err), stack: err && err.stack });
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
  }
});

app.get('/health', (req, res) => {
  res.json({ ok: true, hasWss: !!BD_WSS, hasSecret: !!SHARED_SECRET });
});

app.get('/', (req, res) => {
  res.type('text').send('Rufus Driver. POST /rufus with { asin, amazonCookies, questions[] }.');
});

app.listen(PORT, () => {
  console.log(`Rufus Driver listening on :${PORT}`);
  console.log(`  Auth: ${SHARED_SECRET ? 'Bearer token required' : 'OPEN (set SHARED_SECRET to lock)'}`);
});
