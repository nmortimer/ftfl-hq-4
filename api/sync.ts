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
  isTaxi: boolean;
  isIR: boolean;
}

/**
 * CONFIRMED against a real response — Nick fetched
 * FetchRoster?sport=NFL&league_id=245051&team_id=1417685 directly and
 * pasted the full result. Real shape: `{ groups: [{ group: "START" |
 * "INJURED" | "TAXI" | undefined-for-bench, slots: [{ leaguePlayer: {
 * proPlayer: { nameFull, ... } } }] }] }`. Verified directly against
 * known players: Zach Charbonnet sits in the group with
 * group:"INJURED", Cam Ward and Oscar Delp both sit in the group with
 * group:"TAXI" — exactly matching what the contract data already said.
 * This is the SINGLE-team endpoint (needs team_id), which is why it's
 * called once per team below — team_id itself tells us team ownership,
 * so this same call also replaces the old bulk FetchLeagueRosters logic
 * for trades/cuts, not just taxi/IR.
 *
 * If any one team's fetch fails, the whole sync aborts rather than
 * silently treating that team's players as "not found" (which would
 * read as mass cuts for just that team — exactly the kind of failure
 * this file has hit twice before).
 */
async function fetchRosterMap(leagueId: string, season: number): Promise<{ map: Map<string, RosterInfo>; rawSample: unknown }> {
  const results = await Promise.all(
    teams.map(async (team) => {
      const url = `https://www.fleaflicker.com/api/FetchRoster?sport=NFL&league_id=${leagueId}&team_id=${team.fleaflickerId}&season=${season}`;
      const upstream = await fetch(url);
      if (!upstream.ok) {
        throw new Error(`FetchRoster failed for ${team.name} (HTTP ${upstream.status})`);
      }
      const data = await upstream.json();
      return { team, data };
    })
  );

  const map = new Map<string, RosterInfo>();
  for (const { team, data } of results) {
    const groups = data?.groups ?? [];
    for (const g of groups) {
      const groupLabel = g?.group; // 'START' | 'INJURED' | 'TAXI' | undefined (bench)
      const isTaxi = groupLabel === 'TAXI';
      const isIR = groupLabel === 'INJURED';
      const slots = g?.slots ?? [];
      for (const slot of slots) {
        const playerName = slot?.leaguePlayer?.proPlayer?.nameFull;
        if (!playerName) continue; // empty bench slot, nothing to record
        map.set(normalize(playerName), { teamSlug: team.slug, isTaxi, isIR });
      }
    }
  }
  return { map, rawSample: results[0]?.data };
}

function isActiveThisYear(c: Contract, year: number): boolean {
  if (c.kind === 'imported') return c.yearSalaries[year] != null;
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
  try {
    const result = await fetchRosterMap(leagueId, year);
    rosterMap = result.map;
    rawSample = result.rawSample;
  } catch (err: any) {
    return res.status(502).json({ error: `Failed to reach Fleaflicker: ${err?.message}` });
  }

  // SAFETY GUARD: an empty or near-empty roster map means the response
  // shape didn't match what this code expects — refuse to touch any data
  // rather than mass-cut everyone on a parsing failure.
  if (rosterMap.size < 20) {
    return res.status(502).json({
      error: `Fleaflicker's roster data only produced ${rosterMap.size} recognizable player(s) across the whole league — that's almost certainly a parsing mismatch, not real data, so nothing was changed. Raw sample from one team's response: ${JSON.stringify(rawSample).slice(0, 2500)}`,
    });
  }

  const contracts = await getAllContracts();
  const summary = {
    trades: [] as { name: string; from: string; to: string }[],
    taxiChanges: [] as string[],
    irChanges: [] as string[],
    proposedCuts: [] as { id: string; playerName: string; team: string }[],
  };

  // Trades and taxi/IR are now auto-applied and saved — the per-team
  // endpoint's fields are confirmed against real data, not guessed.
  // Cuts remain PROPOSALS ONLY: "not found on any roster" has caused two
  // different real failures before (a name-matching bug, and what
  // looked like incomplete roster data), so a cut is never applied
  // automatically no matter how solid the rest of this looks — the
  // commissioner confirms each one explicitly on the FA Review page.
  const updated: Contract[] = [];
  for (const c of contracts) {
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

    const taxiYears = new Set(c.taxiYears ?? []);
    const wasTaxi = taxiYears.has(year);
    if (found.isTaxi && !wasTaxi) {
      taxiYears.add(year);
      summary.taxiChanges.push(`${c.playerName} → taxi`);
    } else if (!found.isTaxi && wasTaxi) {
      taxiYears.delete(year);
      summary.taxiChanges.push(`${c.playerName} → off taxi`);
    }
    next.taxiYears = Array.from(taxiYears);

    const irYears = new Set(c.irYears ?? []);
    const wasIR = irYears.has(year);
    if (found.isIR && !wasIR) {
      irYears.add(year);
      summary.irChanges.push(`${c.playerName} → IR`);
    } else if (!found.isIR && wasIR) {
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
