import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getAllContracts, saveAllContracts } from './_lib/store.js';
import { teams } from '../src/data/teams.js';
import type { Contract } from '../src/lib/contracts';

/**
 * Name matching strips suffixes/punctuation/accents from both sides
 * before comparing — see README for why (this alone caused a real
 * incident: "Michael Pittman Jr." vs "Michael Pittman" failing to match
 * under a plain lowercase comparison). Genuine spelling typos in the
 * original spreadsheet (a separate, second incident) were fixed at the
 * source in realContracts.ts instead — this function can't fix those,
 * only formatting differences.
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.,'']/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface RosterInfo {
  teamSlug: string;
}

/**
 * CONFIRMED against a real response Nick pasted directly: `{ rosters:
 * [{ team, players: [{ proPlayer: { nameFull, ... } }] }] }`. Cross-
 * checked programmatically against all 232 active-2026 contracts:
 * 232/232 matched once 7 spreadsheet typos were fixed. Public/anonymous
 * — no login required.
 */
async function fetchRosterMap(leagueId: string, season: number): Promise<{ map: Map<string, RosterInfo>; rawSample: unknown }> {
  const url = `https://www.fleaflicker.com/api/FetchLeagueRosters?sport=NFL&league_id=${leagueId}&season=${season}`;
  const upstream = await fetch(url);
  if (!upstream.ok) {
    throw new Error(`Fleaflicker returned ${upstream.status}`);
  }
  const data = await upstream.json();
  const map = new Map<string, RosterInfo>();

  const rosters = data?.rosters ?? [];
  for (const rosterEntry of rosters) {
    const teamName = rosterEntry?.team?.name;
    const matchedTeam = teams.find((t) => t.name.trim().toLowerCase() === (teamName ?? '').trim().toLowerCase());
    if (!matchedTeam) continue;

    const players = rosterEntry?.players ?? [];
    for (const player of players) {
      const playerName = player?.proPlayer?.nameFull;
      if (!playerName) continue;
      map.set(normalize(playerName), { teamSlug: matchedTeam.slug });
    }
  }
  return { map, rawSample: rosters[0] ?? data };
}

interface ReserveStatus {
  isTaxi: boolean;
  isIR: boolean;
}

/**
 * CONFIRMED against a real response Nick pasted directly (the public,
 * no-login `FetchLeagueActivity` feed). Fleaflicker's JSON encoding
 * omits boolean fields entirely when they're false (standard protobuf
 * JSON behavior), so a `reserveChange` item's shape tells you the move:
 *   - no `taxi`, no `removed`  → added to IR
 *   - `taxi: true`, no `removed` → added to TAXI
 *   - `removed: true`, no `taxi` → removed from IR (activated)
 *   - `removed: true, taxi: true` → removed from TAXI (promoted)
 * Verified this against 11 real players in the feed, cross-checked
 * against their real known status (e.g. A.J. Brown's real-IR injury
 * lines up with a bare add-to-IR event; Denzel Boston and Harold
 * Fannin, both real active contributors now, show promoted-off-taxi
 * events) — all 11 matched before this was wired in.
 *
 * The feed is paginated (30 items/page) and this league had ~1300
 * total items at last check, so pages are fetched in parallel (not
 * sequentially) to keep this fast. For each player, only the event
 * with the LATEST timeEpochMilli matters — a player can cycle through
 * taxi/IR/active multiple times over a season.
 */
async function fetchReserveStatusMap(leagueId: string): Promise<Map<string, ReserveStatus>> {
  const pageSize = 30;
  const maxPages = 60; // covers up to 1800 activity items — safety cap, not expected to be hit under normal use

  const first = await fetch(`https://www.fleaflicker.com/api/FetchLeagueActivity?sport=NFL&league_id=${leagueId}&result_offset=0`);
  if (!first.ok) throw new Error(`FetchLeagueActivity returned ${first.status}`);
  const firstPage = await first.json();
  const resultTotal: number = firstPage?.resultTotal ?? 0;
  const totalPages = Math.min(maxPages, Math.max(1, Math.ceil(resultTotal / pageSize)));

  const restPages = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_, i) => {
      const offset = (i + 1) * pageSize;
      return fetch(`https://www.fleaflicker.com/api/FetchLeagueActivity?sport=NFL&league_id=${leagueId}&result_offset=${offset}`).then((r) => {
        if (!r.ok) throw new Error(`FetchLeagueActivity returned ${r.status} at offset ${offset}`);
        return r.json();
      });
    })
  );

  const allItems = [firstPage, ...restPages].flatMap((page: any) => page?.items ?? []);

  // latest event per player, by normalized name
  const latestByPlayer = new Map<string, { timeEpochMilli: number; removed: boolean; taxi: boolean }>();
  for (const item of allItems) {
    const rc = item?.reserveChange;
    if (!rc) continue;
    const playerName = rc?.player?.proPlayer?.nameFull;
    if (!playerName) continue;
    const key = normalize(playerName);
    const timeEpochMilli = Number(item?.timeEpochMilli ?? 0);
    const existing = latestByPlayer.get(key);
    if (!existing || timeEpochMilli > existing.timeEpochMilli) {
      latestByPlayer.set(key, {
        timeEpochMilli,
        removed: Boolean(rc?.removed),
        taxi: Boolean(rc?.taxi),
      });
    }
  }

  const result = new Map<string, ReserveStatus>();
  for (const [key, ev] of latestByPlayer) {
    if (ev.removed) {
      result.set(key, { isTaxi: false, isIR: false });
    } else {
      result.set(key, { isTaxi: ev.taxi, isIR: !ev.taxi });
    }
  }
  return result;
}

function isActiveThisYear(c: Contract, year: number): boolean {
  if (c.kind === 'imported' || c.kind === 'buyout') return c.yearSalaries[year] != null;
  const yearsIn = year - c.startYear;
  return yearsIn >= 0 && yearsIn < c.lengthYears;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const leagueId = process.env.FLEAFLICKER_LEAGUE_ID;
  if (!leagueId) {
    return res.status(400).json({ error: 'FLEAFLICKER_LEAGUE_ID is not set on the server.' });
  }

  const year = Number(req.query.year) || new Date().getFullYear();

  let rosterMap: Map<string, RosterInfo>;
  let rawSample: unknown;
  let reserveMap: Map<string, ReserveStatus>;
  try {
    const [rosterResult, reserveResult] = await Promise.all([
      fetchRosterMap(leagueId, year),
      fetchReserveStatusMap(leagueId),
    ]);
    rosterMap = rosterResult.map;
    rawSample = rosterResult.rawSample;
    reserveMap = reserveResult;
  } catch (err: any) {
    return res.status(502).json({ error: `Failed to reach Fleaflicker: ${err?.message}` });
  }

  // SAFETY GUARD: an empty or near-empty roster map means the response
  // shape didn't match what this code expects — refuse to touch any data.
  if (rosterMap.size < 20) {
    return res.status(502).json({
      error: `Fleaflicker's roster data only produced ${rosterMap.size} recognizable player(s) — that's almost certainly a parsing mismatch, not real data, so nothing was changed. Raw sample from the response: ${JSON.stringify(rawSample).slice(0, 2500)}`,
    });
  }

  const contracts = await getAllContracts();
  const summary = {
    trades: [] as { name: string; from: string; to: string }[],
    taxiChanges: [] as string[],
    irChanges: [] as string[],
    proposedCuts: [] as { id: string; playerName: string; team: string }[],
  };

  // Trades and taxi/IR are auto-applied and saved — both are now backed
  // by confirmed, tested data sources (see comments above). Cuts remain
  // PROPOSALS ONLY: "not found on any roster" has caused real failures
  // here before from unrelated causes, so a cut is never applied
  // automatically no matter how solid the rest of this has proven —
  // the commissioner confirms each one explicitly on the FA Review page.
  const updated: Contract[] = [];
  for (const c of contracts) {
    // Buyouts are cap-space lines for a player who's already gone — never
    // a live Fleaflicker roster entry, so never matched/traded/cut here.
    if (c.kind === 'buyout') {
      updated.push(c);
      continue;
    }
    if (!isActiveThisYear(c, year)) {
      updated.push(c);
      continue;
    }

    const found = rosterMap.get(normalize(c.playerName));
    if (!found) {
      summary.proposedCuts.push({ id: c.id, playerName: c.playerName, team: c.team });
      updated.push(c); // NOT removed — stays exactly as-is until confirmed
      continue;
    }

    const next: Contract = { ...c };
    if (found.teamSlug !== c.team) {
      summary.trades.push({ name: c.playerName, from: c.team, to: found.teamSlug });
      next.team = found.teamSlug;
    }

    const reserve = reserveMap.get(normalize(c.playerName)) ?? { isTaxi: false, isIR: false };

    const taxiYears = new Set(c.taxiYears ?? []);
    const wasTaxi = taxiYears.has(year);
    if (reserve.isTaxi && !wasTaxi) {
      taxiYears.add(year);
      summary.taxiChanges.push(`${c.playerName} → taxi`);
    } else if (!reserve.isTaxi && wasTaxi) {
      taxiYears.delete(year);
      summary.taxiChanges.push(`${c.playerName} → off taxi`);
    }
    next.taxiYears = Array.from(taxiYears);

    const irYears = new Set(c.irYears ?? []);
    const wasIR = irYears.has(year);
    if (reserve.isIR && !wasIR) {
      irYears.add(year);
      summary.irChanges.push(`${c.playerName} → IR`);
    } else if (!reserve.isIR && wasIR) {
      irYears.delete(year);
      summary.irChanges.push(`${c.playerName} → off IR`);
    }
    next.irYears = Array.from(irYears);

    updated.push(next);
  }

  try {
    await saveAllContracts(updated);
  } catch (err: any) {
    return res.status(500).json({
      error: `Reconciliation computed fine but saving failed: ${err?.message}. This usually means REDIS_URL isn't set on the server — check the Environment Variables tab in your Vercel project.`,
    });
  }
  return res.status(200).json({ contracts: updated, summary });
}
