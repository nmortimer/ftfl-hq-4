import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getAllContracts, saveAllContracts } from './_lib/store.js';
import { teams } from '../src/data/teams.js';
import type { Contract } from '../src/lib/contracts';

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

interface RosterInfo {
  teamSlug: string;
  isTaxi: boolean;
  isIR: boolean;
}

/**
 * IMPORTANT — confidence level on this endpoint's shape:
 * FetchRoster (single team) was confirmed against Fleaflicker's official
 * docs: { groups: [{ group: string, slots: [{ position, leaguePlayer:
 * { proPlayer: { nameFull, ... } } }] }] }, with group values BENCH /
 * START / INJURED / TAXI (confirmed as a real enum elsewhere in the same
 * docs). FetchLeagueRosters (ALL teams, no team_id needed — used here to
 * avoid 10 separate calls) is assumed to wrap that same per-team shape
 * inside a `rosters: [{ team, groups }]` array, since it reuses
 * Fleaflicker's own "LeagueRoster" type — but that specific nesting was
 * never seen in a real response. If sync silently does nothing (0
 * cuts/trades/taxi changes every time, even when you know something
 * happened), this is the first place to check — hit
 * /api/fleaflicker?endpoint=FetchLeagueRosters directly and send me what
 * comes back.
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

    const groups = rosterEntry?.groups ?? [];
    for (const g of groups) {
      const groupLabel = g?.group;
      const slots = g?.slots ?? [];
      for (const slot of slots) {
        const playerName = slot?.leaguePlayer?.proPlayer?.nameFull;
        if (!playerName) continue;
        map.set(normalize(playerName), {
          teamSlug: matchedTeam.slug,
          isTaxi: groupLabel === 'TAXI',
          isIR: groupLabel === 'INJURED',
        });
      }
    }
  }
  return { map, rawSample: rosters[0] ?? data };
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
  // shape didn't match what this code expects — NOT that your whole
  // league quit. Refuse to touch any data rather than mass-cut everyone
  // on a parsing failure. (This is exactly what went wrong before this
  // guard existed.)
  if (rosterMap.size < 5) {
    return res.status(502).json({
      error: `Fleaflicker's roster data only produced ${rosterMap.size} recognizable player(s) — that's almost certainly a parsing mismatch, not real data, so nothing was changed. Raw sample from the response: ${JSON.stringify(rawSample).slice(0, 800)}`,
    });
  }

  const contracts = await getAllContracts();
  const summary = {
    cuts: [] as string[],
    trades: [] as { name: string; from: string; to: string }[],
    taxiChanges: [] as string[],
    irChanges: [] as string[],
  };

  const updated: Contract[] = [];
  for (const c of contracts) {
    if (!isActiveThisYear(c, year)) {
      updated.push(c);
      continue;
    }

    const found = rosterMap.get(normalize(c.playerName));
    if (!found) {
      // Not on ANY team's roster in Fleaflicker anymore — treat as cut.
      summary.cuts.push(c.playerName);
      continue; // omitted from `updated` = removed
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

  // SAFETY GUARD #2: even with a healthy-sized roster map, refuse to save
  // a result that cuts an implausible fraction of the active roster in
  // one go — a real week never looks like this, a bad player-name match
  // (accents, suffixes, "Jr."/"II", etc.) sometimes does.
  const activeCount = contracts.filter((c) => isActiveThisYear(c, year)).length;
  if (activeCount > 0 && summary.cuts.length / activeCount > 0.25) {
    return res.status(502).json({
      error: `This sync would cut ${summary.cuts.length} of ${activeCount} active players (over 25%) — that's far more than a normal week, so nothing was saved. This usually means player names aren't matching Fleaflicker's roster data correctly (e.g. "Jr."/suffixes, accents). Players it would have cut: ${summary.cuts.slice(0, 15).join(', ')}${summary.cuts.length > 15 ? '…' : ''}`,
    });
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
