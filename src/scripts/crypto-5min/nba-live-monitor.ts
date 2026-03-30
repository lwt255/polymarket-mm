/**
 * NBA Live Game Monitor
 *
 * Auto-detects active NBA games on Polymarket and monitors:
 *   - Score changes (via ESPN free API)
 *   - Moneyline book repricing lag after score events
 *   - Spread/O/U book dynamics
 *   - Book depth, spread width, and mid-price movement
 *
 * Key question: How fast does the MM reprice after a basket?
 * If there's a lag, we can snipe stale prices.
 *
 * Runs as a daemon — auto-detects games, monitors during play,
 * saves results for post-game analysis.
 *
 * Run: npx tsx src/scripts/crypto-5min/nba-live-monitor.ts
 */

import { writeFileSync, existsSync, readFileSync } from 'fs';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard';
const OUTPUT_FILE = 'nba-live-monitor-results.json';

// Team abbreviation mapping: ESPN -> Polymarket slug
const ESPN_TO_POLY: Record<string, string> = {
    'ATL': 'atl', 'BOS': 'bos', 'BKN': 'bkn', 'CHA': 'cha', 'CHI': 'chi',
    'CLE': 'cle', 'DAL': 'dal', 'DEN': 'den', 'DET': 'det', 'GS': 'gsw',
    'HOU': 'hou', 'IND': 'ind', 'LAC': 'lac', 'LAL': 'lal', 'MEM': 'mem',
    'MIA': 'mia', 'MIL': 'mil', 'MIN': 'min', 'NO': 'nop', 'NY': 'nyk',
    'OKC': 'okc', 'ORL': 'orl', 'PHI': 'phi', 'PHX': 'phx', 'POR': 'por',
    'SAC': 'sac', 'SA': 'sas', 'TOR': 'tor', 'UTAH': 'uta', 'WAS': 'was',
};

interface BookSnapshot {
    bestBid: number;
    bestAsk: number;
    mid: number;
    spread: number;
    bidDepth: number;
    askDepth: number;
    nBids: number;
    nAsks: number;
}

interface ScoreState {
    awayScore: number;
    homeScore: number;
    period: number;
    clock: string;
    status: string;
}

interface Tick {
    timestamp: number;
    score: ScoreState;
    moneyline: BookSnapshot | null;
    spreadMain: BookSnapshot | null;
    ouMain: BookSnapshot | null;
    scoreChanged: boolean;
    scoreDelta: { away: number; home: number } | null;
}

interface GameResult {
    slug: string;
    title: string;
    awayTeam: string;
    homeTeam: string;
    startTime: number;
    endTime: number;
    ticks: Tick[];
    repricingLags: {
        tickIndex: number;
        scoreEvent: string;
        preMid: number;
        postMids: { delayMs: number; mid: number }[];
        repricedAfterMs: number | null; // ms until mid moved by >1c
    }[];
}

async function fetchJSON(url: string): Promise<any> {
    try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        return resp.json();
    } catch { return null; }
}

async function getBook(tokenId: string): Promise<BookSnapshot | null> {
    const raw = await fetchJSON(`${CLOB}/book?token_id=${tokenId}`);
    if (!raw) return null;
    const bids = (raw.bids || []).sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));
    const asks = (raw.asks || []).sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price));
    const bestBid = parseFloat(bids[0]?.price || '0');
    const bestAsk = parseFloat(asks[0]?.price || '1');
    const bidDepth = bids.reduce((s: number, b: any) => s + parseFloat(b.size), 0);
    const askDepth = asks.reduce((s: number, a: any) => s + parseFloat(a.size), 0);
    return {
        bestBid, bestAsk,
        mid: (bestBid + bestAsk) / 2,
        spread: bestAsk - bestBid,
        bidDepth, askDepth,
        nBids: bids.length, nAsks: asks.length,
    };
}

async function getESPNScoreboard(): Promise<any[]> {
    const data = await fetchJSON(ESPN);
    if (!data?.events) return [];
    return data.events;
}

function getScoreState(espnGame: any): ScoreState {
    const comp = espnGame.competitions[0];
    const teams = comp.competitors;
    const away = teams.find((t: any) => t.homeAway === 'away');
    const home = teams.find((t: any) => t.homeAway === 'home');
    return {
        awayScore: parseInt(away?.score || '0'),
        homeScore: parseInt(home?.score || '0'),
        period: comp.status?.period || 0,
        clock: comp.status?.displayClock || '',
        status: comp.status?.type?.description || '',
    };
}

async function findPolymarketEvent(awayAbbr: string, homeAbbr: string): Promise<any> {
    const polyAway = ESPN_TO_POLY[awayAbbr] || awayAbbr.toLowerCase();
    const polyHome = ESPN_TO_POLY[homeAbbr] || homeAbbr.toLowerCase();
    // Try today and yesterday (games that started before midnight UTC show as yesterday's date)
    const now = new Date();
    const dates = [
        now.toISOString().split('T')[0],
        new Date(now.getTime() - 86400000).toISOString().split('T')[0],
    ];

    for (const date of dates) {
        const slug = `nba-${polyAway}-${polyHome}-${date}`;
        const data = await fetchJSON(`${GAMMA}/events?slug=${slug}`);
        if (data?.length > 0) { console.log(`  Found: ${slug}`); return { event: data[0], slug }; }
        // Try reversed
        const slug2 = `nba-${polyHome}-${polyAway}-${date}`;
        const data2 = await fetchJSON(`${GAMMA}/events?slug=${slug2}`);
        if (data2?.length > 0) { console.log(`  Found: ${slug2}`); return { event: data2[0], slug: slug2 }; }
    }
    console.log(`  No slug found for ${awayAbbr} @ ${homeAbbr}`);
    return null;
}

function findMarketTokens(event: any): { moneyline?: string; spread?: string; ou?: string; spreadQ?: string; ouQ?: string } {
    const markets = event.markets || [];
    const result: any = {};

    for (const m of markets) {
        const q = m.question || '';
        const tokens = JSON.parse(m.clobTokenIds || '[]');
        if (!tokens.length) continue;

        // Moneyline (full game, not 1H)
        if (!result.moneyline && !q.includes('O/U') && !q.includes('Spread') &&
            !q.includes('1H') && !q.includes('Points') && !q.includes('Rebounds') &&
            !q.includes('Assists')) {
            result.moneyline = tokens[0];
        }
        // Main spread (closest to 50/50, not 1H)
        if (q.includes('Spread') && !q.includes('1H')) {
            const prices = JSON.parse(m.outcomePrices || '[]').map(Number);
            const closeness = Math.abs((prices[0] || 0.5) - 0.5);
            if (!result.spread || closeness < result._spreadCloseness) {
                result.spread = tokens[0];
                result.spreadQ = q;
                result._spreadCloseness = closeness;
            }
        }
        // Main O/U (closest to 50/50, not 1H, not player props)
        if (q.includes('O/U') && !q.includes('1H') && !q.includes('Points') &&
            !q.includes('Rebounds') && !q.includes('Assists')) {
            const prices = JSON.parse(m.outcomePrices || '[]').map(Number);
            const closeness = Math.abs((prices[0] || 0.5) - 0.5);
            if (!result.ou || closeness < result._ouCloseness) {
                result.ou = tokens[0];
                result.ouQ = q;
                result._ouCloseness = closeness;
            }
        }
    }

    return result;
}

async function monitorGame(espnGame: any): Promise<GameResult | null> {
    const comp = espnGame.competitions[0];
    const teams = comp.competitors;
    const away = teams.find((t: any) => t.homeAway === 'away');
    const home = teams.find((t: any) => t.homeAway === 'home');
    const awayAbbr = away.team.abbreviation;
    const homeAbbr = home.team.abbreviation;
    const awayName = away.team.displayName;
    const homeName = home.team.displayName;

    console.log(`\n=== Monitoring: ${awayName} @ ${homeName} ===`);

    // Find Polymarket event
    const poly = await findPolymarketEvent(awayAbbr, homeAbbr);
    if (!poly) {
        console.log('  No Polymarket event found. Skipping.');
        return null;
    }

    const tokens = findMarketTokens(poly.event);
    if (!tokens.moneyline) {
        console.log('  No moneyline token found. Skipping.');
        return null;
    }

    console.log(`  Polymarket slug: ${poly.slug}`);
    console.log(`  Moneyline token: ${tokens.moneyline.slice(0, 30)}...`);
    if (tokens.spreadQ) console.log(`  Spread: ${tokens.spreadQ}`);
    if (tokens.ouQ) console.log(`  O/U: ${tokens.ouQ}`);

    const ticks: Tick[] = [];
    const repricingLags: GameResult['repricingLags'] = [];
    let prevScore: ScoreState | null = null;
    let lastScoreChangeTick = -1;

    // Poll loop: 2s during game, check ESPN every poll
    while (true) {
        const now = Date.now();

        // Get score
        const scoreboard = await getESPNScoreboard();
        const currentGame = scoreboard.find((e: any) => {
            const c = e.competitions[0];
            const a = c.competitors.find((t: any) => t.homeAway === 'away');
            return a?.team?.abbreviation === awayAbbr;
        });

        if (!currentGame) {
            console.log('  Game not found on ESPN. Waiting...');
            await new Promise(r => setTimeout(r, 10000));
            continue;
        }

        const score = getScoreState(currentGame);

        // Check if game ended
        if (score.status === 'Final' || score.status === 'End of Game') {
            console.log(`  FINAL: ${awayName} ${score.awayScore} - ${homeName} ${score.homeScore}`);
            break;
        }

        // Check if game hasn't started
        if (score.status === 'Scheduled' || score.period === 0) {
            console.log(`  Waiting for tipoff... (${score.status})`);
            await new Promise(r => setTimeout(r, 30000));
            continue;
        }

        // Get books
        const [moneyline, spreadMain, ouMain] = await Promise.all([
            tokens.moneyline ? getBook(tokens.moneyline) : null,
            tokens.spread ? getBook(tokens.spread) : null,
            tokens.ou ? getBook(tokens.ou) : null,
        ]);

        // Detect score change
        let scoreChanged = false;
        let scoreDelta: { away: number; home: number } | null = null;
        if (prevScore) {
            const dAway = score.awayScore - prevScore.awayScore;
            const dHome = score.homeScore - prevScore.homeScore;
            if (dAway !== 0 || dHome !== 0) {
                scoreChanged = true;
                scoreDelta = { away: dAway, home: dHome };
            }
        }

        const tick: Tick = {
            timestamp: now,
            score,
            moneyline,
            spreadMain,
            ouMain,
            scoreChanged,
            scoreDelta,
        };
        ticks.push(tick);

        // Log
        const ml = moneyline ? `ML: ${(moneyline.bestBid * 100).toFixed(0)}/${(moneyline.bestAsk * 100).toFixed(0)}c spr=${(moneyline.spread * 100).toFixed(0)}c depth=$${(moneyline.bidDepth / 1000).toFixed(0)}K` : 'ML: N/A';
        const scoreStr = `${score.awayScore}-${score.homeScore} Q${score.period} ${score.clock}`;

        if (scoreChanged) {
            const who = scoreDelta!.away > 0 ? awayAbbr : homeAbbr;
            const pts = scoreDelta!.away > 0 ? scoreDelta!.away : scoreDelta!.home;
            console.log(`  >>> SCORE: ${scoreStr} (+${pts} ${who}) | ${ml}`);

            // Start repricing tracking
            lastScoreChangeTick = ticks.length - 1;
            const preMid = ticks.length >= 2 ? (ticks[ticks.length - 2].moneyline?.mid || 0) : 0;
            repricingLags.push({
                tickIndex: lastScoreChangeTick,
                scoreEvent: `+${pts} ${who}`,
                preMid,
                postMids: [{ delayMs: 0, mid: moneyline?.mid || 0 }],
                repricedAfterMs: null,
            });
        } else if (ticks.length % 5 === 0) {
            // Log every 10s (5 ticks * 2s)
            console.log(`  ${scoreStr} | ${ml}`);
        }

        // Track repricing for recent score changes
        for (const lag of repricingLags) {
            if (lag.repricedAfterMs !== null) continue;
            const elapsed = now - ticks[lag.tickIndex].timestamp;
            if (elapsed > 30000) {
                // Give up after 30s
                lag.repricedAfterMs = -1; // means never repriced significantly
                continue;
            }
            const currentMid = moneyline?.mid || 0;
            lag.postMids.push({ delayMs: elapsed, mid: currentMid });
            // Check if mid moved by >1c from pre-score mid
            if (Math.abs(currentMid - lag.preMid) > 0.01) {
                lag.repricedAfterMs = elapsed;
                const dir = currentMid > lag.preMid ? 'UP' : 'DOWN';
                console.log(`    Repriced ${dir} by ${((currentMid - lag.preMid) * 100).toFixed(1)}c after ${elapsed}ms`);
            }
        }

        prevScore = { ...score };
        await new Promise(r => setTimeout(r, 2000));
    }

    return {
        slug: poly.slug,
        title: `${awayName} @ ${homeName}`,
        awayTeam: awayAbbr,
        homeTeam: homeAbbr,
        startTime: ticks[0]?.timestamp || Date.now(),
        endTime: Date.now(),
        ticks,
        repricingLags,
    };
}

function printAnalysis(results: GameResult[]) {
    console.log('\n' + '='.repeat(70));
    console.log('NBA LIVE MONITOR — REPRICING ANALYSIS');
    console.log('='.repeat(70));

    for (const game of results) {
        console.log(`\n--- ${game.title} ---`);
        console.log(`Ticks: ${game.ticks.length} | Score events: ${game.repricingLags.length}`);

        const scored = game.ticks.filter(t => t.scoreChanged);
        console.log(`Score changes detected: ${scored.length}`);

        // Repricing stats
        const repriced = game.repricingLags.filter(l => l.repricedAfterMs !== null && l.repricedAfterMs > 0);
        const neverRepriced = game.repricingLags.filter(l => l.repricedAfterMs === -1);
        const instant = game.repricingLags.filter(l => l.repricedAfterMs !== null && l.repricedAfterMs <= 2000);

        console.log(`Repriced (>1c move): ${repriced.length}/${game.repricingLags.length}`);
        console.log(`Never repriced (within 30s): ${neverRepriced.length}`);
        console.log(`Instant (<2s): ${instant.length}`);

        if (repriced.length > 0) {
            const avgLag = repriced.reduce((s, l) => s + l.repricedAfterMs!, 0) / repriced.length;
            const maxLag = Math.max(...repriced.map(l => l.repricedAfterMs!));
            const minLag = Math.min(...repriced.map(l => l.repricedAfterMs!));
            console.log(`Avg repricing lag: ${avgLag.toFixed(0)}ms`);
            console.log(`Min/Max: ${minLag}ms / ${maxLag}ms`);
        }

        // Spread stats during game
        const mlTicks = game.ticks.filter(t => t.moneyline);
        if (mlTicks.length > 0) {
            const avgSpread = mlTicks.reduce((s, t) => s + t.moneyline!.spread, 0) / mlTicks.length;
            const avgDepth = mlTicks.reduce((s, t) => s + t.moneyline!.bidDepth, 0) / mlTicks.length;
            console.log(`Avg ML spread: ${(avgSpread * 100).toFixed(1)}c`);
            console.log(`Avg ML bid depth: $${(avgDepth / 1000).toFixed(0)}K`);
        }
    }
}

async function main() {
    console.log('=== NBA Live Game Monitor ===');
    console.log(`Output: ${OUTPUT_FILE}`);
    console.log('Checking for active games...\n');

    let allResults: GameResult[] = [];
    if (existsSync(OUTPUT_FILE)) {
        try {
            allResults = JSON.parse(readFileSync(OUTPUT_FILE, 'utf-8'));
            console.log(`Loaded ${allResults.length} previous game results\n`);
        } catch {}
    }

    // Track which games are being monitored in parallel
    const activeMonitors = new Map<string, Promise<GameResult | null>>();
    const monitoredKeys = new Set<string>();

    // Main daemon loop
    while (true) {
        const scoreboard = await getESPNScoreboard();
        if (!scoreboard.length) {
            console.log('No games on ESPN scoreboard. Checking again in 5 min...');
            await new Promise(r => setTimeout(r, 300000));
            continue;
        }

        // Find games that are in progress or about to start (within 30 min)
        const activeGames = scoreboard.filter((e: any) => {
            const status = e.competitions[0].status.type.description;
            return status === 'In Progress' || status === 'Halftime';
        });

        const upcomingGames = scoreboard.filter((e: any) => {
            const status = e.competitions[0].status.type.description;
            if (status !== 'Scheduled') return false;
            const gameTime = new Date(e.competitions[0].date).getTime();
            return gameTime - Date.now() < 1800000; // within 30 min
        });

        const finishedGames = scoreboard.filter((e: any) => {
            const status = e.competitions[0].status.type.description;
            return status === 'Final' || status === 'End of Game';
        });

        console.log(`Games: ${activeGames.length} active, ${upcomingGames.length} upcoming (<30m), ${finishedGames.length} finished, ${activeMonitors.size} monitoring`);

        // Launch monitors for all active/upcoming games in parallel
        const gamesToMonitor = [...activeGames, ...upcomingGames];

        for (const game of gamesToMonitor) {
            const comp = game.competitions[0];
            const away = comp.competitors.find((t: any) => t.homeAway === 'away');
            const home = comp.competitors.find((t: any) => t.homeAway === 'home');
            const gameKey = `${away.team.abbreviation}-${home.team.abbreviation}`;

            // Skip if already monitored or currently monitoring
            if (monitoredKeys.has(gameKey)) continue;
            const alreadyDone = allResults.some(r =>
                r.awayTeam === away.team.abbreviation &&
                r.homeTeam === home.team.abbreviation &&
                new Date(r.startTime).toDateString() === new Date().toDateString()
            );
            if (alreadyDone) { monitoredKeys.add(gameKey); continue; }

            // Launch monitor in parallel (stagger by 3s to avoid rate limits)
            monitoredKeys.add(gameKey);
            const staggerMs = activeMonitors.size * 3000;
            console.log(`  Launching parallel monitor for ${gameKey} (stagger: ${staggerMs}ms)`);
            const promise = new Promise<void>(r => setTimeout(r, staggerMs)).then(() => monitorGame(game)).then(result => {
                if (result) {
                    allResults.push(result);
                    writeFileSync(OUTPUT_FILE, JSON.stringify(allResults, null, 2));
                    console.log(`\nSaved ${result.title}. Total games: ${allResults.length}`);
                }
                activeMonitors.delete(gameKey);
                return result;
            }).catch(e => {
                console.error(`Monitor error for ${gameKey}:`, e.message);
                activeMonitors.delete(gameKey);
                return null;
            });
            activeMonitors.set(gameKey, promise);
        }

        // Check if all games are done
        if (gamesToMonitor.length === 0 && activeMonitors.size === 0) {
            if (finishedGames.length === scoreboard.length) {
                console.log('All games finished for today.');
                if (allResults.length > 0) printAnalysis(allResults);
                break;
            }
        }

        // Wait before checking for new games
        await new Promise(r => setTimeout(r, 30000));
    }

    // Wait for any remaining monitors
    if (activeMonitors.size > 0) {
        console.log(`Waiting for ${activeMonitors.size} monitors to finish...`);
        await Promise.all(activeMonitors.values());
    }

    console.log('\n=== Monitor Complete ===');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
