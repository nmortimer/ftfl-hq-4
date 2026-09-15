import { useEffect, useMemo, useState } from 'react';
import { realContracts } from './data/realContracts';
import { teams, teamBySlug } from './data/teams';
import {
  fetchContracts,
  fetchFleaflickerActivity,
  fetchFleaflickerStandings,
  FleaflickerActivityItem,
  FleaflickerTeamRecord,
  saveContracts,
  syncFromFleaflicker,
  SyncSummary,
} from './lib/api';
import {
  Contract,
  SALARY_CAP,
  contractsForTeam,
  cutPenalty,
  endYear,
  irCount,
  isIR,
  isTaxi,
  projectedResignCost,
  rosterCount,
  salaryInYear,
  startYear,
  taxiCount,
  teamCapSpace,
  teamCapUsed,
  yearsRemaining,
} from './lib/contracts';

const YEARS = [2025, 2026, 2027, 2028, 2029];
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];

function money(n: number | null): string {
  if (n == null) return '—';
  return `$${n}`;
}

export default function App() {
  const [year, setYear] = useState(2026);
  const [mode, setMode] = useState<'summary' | 'team' | 'activity'>('summary');
  const [teamSlug, setTeamSlug] = useState(teams[0].slug);
  const team = teamBySlug(teamSlug);

  // Contracts: render instantly from the bundled seed data, then swap in
  // live data from the backend if it's available. If there's no deployed
  // API or KV isn't configured yet, this silently stays on the seed data.
  const [contracts, setContracts] = useState<Contract[]>(realContracts);
  useEffect(() => {
    fetchContracts().then((live) => {
      if (live) setContracts(live);
    });
  }, []);

  // Commissioner tools are open for now — no login. See README for how to
  // re-lock this behind a password later.
  const isCommissioner = true;

  const themeVars =
    mode === 'team'
      ? { ['--bg' as any]: team.bg, ['--accent' as any]: team.accent, ['--accent2' as any]: team.accent2, ['--on-accent' as any]: team.onAccent }
      : { ['--bg' as any]: '#14161a', ['--accent' as any]: '#7f8a9e', ['--accent2' as any]: '#7f8a9e', ['--on-accent' as any]: '#0b0c10' };

  return (
    <div className="page" style={themeVars}>
      <nav className="team-rail">
        <button
          className={`team-chip summary-chip ${mode === 'summary' ? 'active' : ''}`}
          style={{ ['--chip' as any]: '#7f8a9e' }}
          onClick={() => setMode('summary')}
          title="League summary"
        >
          <span aria-hidden="true">⊞</span>
        </button>
        {teams.map((t) => (
          <button
            key={t.slug}
            className={`team-chip ${mode === 'team' && t.slug === teamSlug ? 'active' : ''}`}
            style={{ ['--chip' as any]: t.accent }}
            onClick={() => {
              setTeamSlug(t.slug);
              setMode('team');
            }}
            title={t.name}
          >
            <img src={t.logo} alt="" />
          </button>
        ))}
        <div className="year-picker rail-year">
          <label htmlFor="year">Viewing</label>
          <select id="year" value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {YEARS.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
        <button className="commissioner-btn" onClick={() => setMode('activity')}>
          📋 FA Review
        </button>
      </nav>

      {mode === 'summary' ? (
        <LeagueSummary
          year={year}
          contracts={contracts}
          onSelectTeam={(slug) => {
            setTeamSlug(slug);
            setMode('team');
          }}
        />
      ) : mode === 'activity' ? (
        <ActivityReview contracts={contracts} setContracts={setContracts} year={year} />
      ) : (
        <TeamPage
          teamSlug={teamSlug}
          year={year}
          contracts={contracts}
          setContracts={setContracts}
          isCommissioner={isCommissioner}
        />
      )}
    </div>
  );
}

function LeagueSummary({
  year,
  contracts,
  onSelectTeam,
}: {
  year: number;
  contracts: Contract[];
  onSelectTeam: (slug: string) => void;
}) {
  const [records, setRecords] = useState<FleaflickerTeamRecord[] | null>(null);
  const [fleaflickerError, setFleaflickerError] = useState(false);

  useEffect(() => {
    setRecords(null);
    setFleaflickerError(false);
    fetchFleaflickerStandings(year).then((data) => {
      if (data) setRecords(data);
      else setFleaflickerError(true);
    });
  }, [year]);

  const rows = useMemo(
    () =>
      teams.map((t) => {
        const teamContracts = contractsForTeam(contracts, t.slug);
        const record = records?.find((r) => r.name.trim().toLowerCase() === t.name.trim().toLowerCase());
        return {
          team: t,
          capUsed: teamCapUsed(teamContracts, year),
          capSpace: teamCapSpace(teamContracts, year),
          roster: rosterCount(teamContracts, year),
          taxi: taxiCount(teamContracts, year),
          ir: irCount(teamContracts, year),
          record,
        };
      }),
    [contracts, year, records]
  );

  return (
    <>
      <header className="page-header summary-header">
        <div>
          <h1>League summary — {year}</h1>
          <p className="sub">Click a team to open its full page.</p>
        </div>
      </header>

      <table>
        <thead>
          <tr>
            <th>Team</th>
            <th>Record</th>
            <th>PF</th>
            <th>Roster</th>
            <th>Taxi</th>
            <th>IR</th>
            <th>Cap used</th>
            <th>Cap space</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ team, capUsed, capSpace, roster, taxi, ir, record }) => (
            <tr key={team.slug} className="clickable-row" onClick={() => onSelectTeam(team.slug)}>
              <td>
                <div className="team-cell">
                  <span className="swatch" style={{ background: team.accent }} />
                  <img className="team-cell-logo" src={team.logo} alt="" />
                  {team.name}
                </div>
              </td>
              <td className="num">{record ? `${record.wins}-${record.losses}${record.ties ? `-${record.ties}` : ''}` : '—'}</td>
              <td className="num">{record ? record.pointsFor.toFixed(1) : '—'}</td>
              <td className="num">{roster}</td>
              <td className="num">{taxi}</td>
              <td className="num">{ir}</td>
              <td className="num">{money(capUsed)}</td>
              <td className={`num ${capSpace < 0 ? 'over' : ''}`}>{money(capSpace)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {fleaflickerError && (
        <p className="footnote">
          Live records aren't connected yet — set FLEAFLICKER_LEAGUE_ID on the server to pull real
          scores/standings here.
        </p>
      )}
      <p className="footnote">Taxi squad and IR contracts don't count against the $200 cap.</p>
    </>
  );
}

function ActivityReview({
  contracts,
  setContracts,
  year,
}: {
  contracts: Contract[];
  setContracts: (c: Contract[]) => void;
  year: number;
}) {
  const [activity, setActivity] = useState<FleaflickerActivityItem[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncSummary, setSyncSummary] = useState<SyncSummary | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { team: string; position: string; cost: number; length: number }>>({});

  useEffect(() => {
    fetchFleaflickerActivity().then((data) => {
      if (data) setActivity(data);
      else setLoadError(true);
    });
  }, []);

  const findContract = (playerName: string) =>
    contracts.find((c) => c.playerName.trim().toLowerCase() === playerName.trim().toLowerCase() && salaryInYear(c, year) != null);

  const faItems = (activity ?? []).filter((a) => a.kind === 'transaction' && a.playerName && !findContract(a.playerName));
  const otherItems = (activity ?? []).filter((a) => !faItems.includes(a) && a.kind !== 'drop');

  function draftFor(item: FleaflickerActivityItem) {
    const matchedTeam = teams.find((t) => t.name.trim().toLowerCase() === (item.teamName ?? '').trim().toLowerCase());
    return (
      drafts[item.playerName!] ?? {
        team: matchedTeam?.slug ?? teams[0].slug,
        position: 'WR',
        cost: 1,
        length: 3,
      }
    );
  }

  function updateDraft(playerName: string, patch: Partial<{ team: string; position: string; cost: number; length: number }>) {
    setDrafts({ ...drafts, [playerName]: { ...draftFor({ playerName } as any), ...patch } });
  }

  function addFromDraft(item: FleaflickerActivityItem) {
    const d = draftFor(item);
    const newContract: Contract = {
      id: `fa-${Date.now()}`,
      kind: 'formula',
      playerName: item.playerName!,
      position: d.position,
      team: d.team,
      baseSalary: d.cost,
      startYear: year,
      lengthYears: d.length,
    };
    setContracts([...contracts, newContract]);
  }

  async function handleSave() {
    setSaving(true);
    setSaveMsg(null);
    const result = await saveContracts(contracts);
    setSaving(false);
    setSaveMsg(result.ok ? 'Saved.' : `Not saved: ${result.error}`);
  }

  async function handleSync() {
    setSyncing(true);
    setSyncError(null);
    setSyncSummary(null);
    const result = await syncFromFleaflicker(year);
    setSyncing(false);
    if (result.ok && result.summary) {
      setSyncSummary(result.summary);
      const live = await fetchContracts();
      if (live) setContracts(live);
    } else {
      setSyncError(result.error ?? 'Sync failed');
    }
  }

  const totalSyncChanges = syncSummary
    ? syncSummary.cuts.length + syncSummary.trades.length + syncSummary.taxiChanges.length + syncSummary.irChanges.length
    : 0;

  return (
    <>
      <header className="page-header summary-header">
        <div>
          <h1>Free agent review</h1>
          <p className="sub">
            Trades, cuts, and taxi/IR are synced automatically from Fleaflicker's current rosters. Only new free
            agent pickups need you to enter a cost below.
          </p>
        </div>
      </header>

      <div className="commissioner-bar">
        <button className="btn-primary" onClick={handleSync} disabled={syncing}>
          {syncing ? 'Syncing…' : '🔄 Sync trades / cuts / taxi / IR'}
        </button>
        {syncError && <span className="login-error">{syncError}</span>}
      </div>

      {syncSummary && (
        <section className="roster-section">
          <h2 className="section-title">Sync results</h2>
          {totalSyncChanges === 0 ? (
            <p className="muted">No changes — everything already matches Fleaflicker's rosters.</p>
          ) : (
            <>
              {syncSummary.cuts.map((name) => (
                <p className="sync-line" key={`cut-${name}`}>
                  Cut: <strong>{name}</strong> (no longer on any Fleaflicker roster)
                </p>
              ))}
              {syncSummary.trades.map((t) => (
                <p className="sync-line" key={`trade-${t.name}`}>
                  Traded: <strong>{t.name}</strong> — {teamBySlug(t.from).name} → {teamBySlug(t.to).name}
                </p>
              ))}
              {syncSummary.taxiChanges.map((line) => (
                <p className="sync-line" key={`taxi-${line}`}>
                  {line}
                </p>
              ))}
              {syncSummary.irChanges.map((line) => (
                <p className="sync-line" key={`ir-${line}`}>
                  {line}
                </p>
              ))}
            </>
          )}
        </section>
      )}

      {loadError && (
        <p className="footnote">
          Couldn't reach Fleaflicker's transaction log — check FLEAFLICKER_LEAGUE_ID is set and try again.
        </p>
      )}

      {activity && faItems.length === 0 && !loadError && (
        <p className="muted">No pending free agent pickups without a contract on file — you're caught up.</p>
      )}

      {faItems.map((item) => {
        const d = draftFor(item);
        return (
          <section className="roster-section add-contract-form" key={item.playerName}>
            <h2 className="section-title">{item.playerName}</h2>
            <p className="section-note">{item.description}</p>
            <div className="add-form-row">
              <select value={d.team} onChange={(e) => updateDraft(item.playerName!, { team: e.target.value })}>
                {teams.map((t) => (
                  <option key={t.slug} value={t.slug}>
                    {t.name}
                  </option>
                ))}
              </select>
              <select value={d.position} onChange={(e) => updateDraft(item.playerName!, { position: e.target.value })}>
                {POSITIONS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={1}
                value={d.cost}
                onChange={(e) => updateDraft(item.playerName!, { cost: Number(e.target.value) })}
                title="FA cost ($) — not tracked in Fleaflicker, enter manually"
              />
              <input
                type="number"
                min={1}
                max={6}
                value={d.length}
                onChange={(e) => updateDraft(item.playerName!, { length: Number(e.target.value) })}
                title="Contract length (years)"
              />
              <button className="btn-primary" onClick={() => addFromDraft(item)}>
                Add contract
              </button>
            </div>
          </section>
        );
      })}

      {faItems.length > 0 && (
        <div className="commissioner-bar">
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save to server'}
          </button>
          {saveMsg && <span className="save-msg">{saveMsg}</span>}
        </div>
      )}

      {otherItems.length > 0 && (
        <section className="roster-section">
          <h2 className="section-title">Other recent activity</h2>
          <p className="section-note">Informational only — not confirmed as actionable transactions.</p>
          {otherItems.slice(0, 15).map((item, i) => (
            <details key={i} className="activity-raw">
              <summary>{item.description}</summary>
              <pre>{JSON.stringify(item.raw, null, 2)}</pre>
            </details>
          ))}
        </section>
      )}
    </>
  );
}

function TeamPage({
  teamSlug,
  year,
  contracts,
  setContracts,
  isCommissioner,
}: {
  teamSlug: string;
  year: number;
  contracts: Contract[];
  setContracts: (c: Contract[]) => void;
  isCommissioner: boolean;
}) {
  const team = teamBySlug(teamSlug);
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const teamContracts = useMemo(() => contractsForTeam(contracts, teamSlug), [contracts, teamSlug]);

  const withComputed = useMemo(
    () =>
      teamContracts.map((c: Contract) => ({
        contract: c,
        salary: salaryInYear(c, year),
        yearsLeft: yearsRemaining(c, year),
        penalty: cutPenalty(c, year),
      })),
    [teamContracts, year]
  );

  const active = withComputed.filter((r) => r.salary != null && !isTaxi(r.contract, year) && !isIR(r.contract, year));
  const taxi = withComputed.filter((r) => r.salary != null && isTaxi(r.contract, year));
  const ir = withComputed.filter((r) => r.salary != null && isIR(r.contract, year));

  const capUsed = teamCapUsed(teamContracts, year);
  const capSpace = teamCapSpace(teamContracts, year);

  function updateContract(id: string, patch: Partial<Contract>) {
    setContracts(contracts.map((c) => (c.id === id ? ({ ...c, ...patch } as Contract) : c)));
  }

  function cutContract(id: string) {
    if (!confirm('Cut this player? This removes the contract entirely.')) return;
    setContracts(contracts.filter((c) => c.id !== id));
  }

  function tradeContract(id: string, newTeamSlug: string) {
    if (!newTeamSlug || newTeamSlug === teamSlug) return;
    updateContract(id, { team: newTeamSlug });
  }

  function toggleTaxiThisYear(contract: Contract) {
    const years = contract.taxiYears ?? [];
    const next = isTaxi(contract, year) ? years.filter((y) => y !== year) : [...years, year];
    updateContract(contract.id, { taxiYears: next });
  }

  function toggleIRThisYear(contract: Contract) {
    const years = contract.irYears ?? [];
    const next = isIR(contract, year) ? years.filter((y) => y !== year) : [...years, year];
    updateContract(contract.id, { irYears: next });
  }

  function addContract(form: { name: string; position: string; baseSalary: number; lengthYears: number }) {
    const newContract: Contract = {
      id: `new-${Date.now()}`,
      kind: 'formula',
      playerName: form.name,
      position: form.position,
      team: teamSlug,
      baseSalary: form.baseSalary,
      startYear: year,
      lengthYears: form.lengthYears,
    };
    setContracts([...contracts, newContract]);
  }

  async function handleSave() {
    setSaving(true);
    setSaveMsg(null);
    const result = await saveContracts(contracts);
    setSaving(false);
    setSaveMsg(result.ok ? 'Saved.' : `Not saved: ${result.error}`);
  }

  const rowTable = (rows: typeof active, opts?: { badge?: 'taxi' | 'ir' }) => (
    <table>
      <thead>
        <tr>
          <th>Player</th>
          <th>Pos</th>
          <th>Contract</th>
          <th>Salary in {year}</th>
          <th>Years left</th>
          <th>Cut penalty if cut now</th>
          {editMode && <th>Edit</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map(({ contract, salary, yearsLeft, penalty }) => {
          const signed = startYear(contract);
          const resignYear = endYear(contract) + 1;
          const resignCost = projectedResignCost(contract);
          return (
            <tr key={contract.id}>
              <td>
                {contract.playerName}
                {opts?.badge === 'taxi' && <span className="badge taxi">Taxi</span>}
                {opts?.badge === 'ir' && <span className="badge ir">IR</span>}
              </td>
              <td>
                {editMode ? (
                  <input
                    className="edit-input edit-input-pos"
                    value={contract.position}
                    onChange={(e) => updateContract(contract.id, { position: e.target.value })}
                  />
                ) : (
                  contract.position || '—'
                )}
              </td>
              <td>
                <div className="contract-cell">
                  <span className="contract-signed">Signed {signed}</span>
                  <span className="contract-resign">
                    Resign: {money(resignCost)} ({resignYear})
                  </span>
                </div>
              </td>
              <td className="num">{money(salary)}</td>
              <td className="num">{yearsLeft}</td>
              <td className="num">{money(penalty)}</td>
              {editMode && (
                <td className="edit-actions">
                  <button className="btn-tiny" onClick={() => toggleTaxiThisYear(contract)}>
                    {isTaxi(contract, year) ? 'Un-taxi' : 'Taxi'}
                  </button>
                  <button className="btn-tiny" onClick={() => toggleIRThisYear(contract)}>
                    {isIR(contract, year) ? 'Un-IR' : 'IR'}
                  </button>
                  <button className="btn-tiny btn-danger" onClick={() => cutContract(contract.id)}>
                    Cut
                  </button>
                  <select
                    className="edit-input trade-select"
                    value=""
                    onChange={(e) => tradeContract(contract.id, e.target.value)}
                  >
                    <option value="" disabled>
                      Trade to…
                    </option>
                    {teams
                      .filter((t) => t.slug !== teamSlug)
                      .map((t) => (
                        <option key={t.slug} value={t.slug}>
                          {t.name}
                        </option>
                      ))}
                  </select>
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  return (
    <>
      <header className="page-header">
        <div className="team-identity">
          <img className="team-logo" src={team.logo} alt={`${team.name} logo`} />
          <h1>{team.name}</h1>
        </div>
        {team.stadium ? (
          <div className="hero-slot hero-slot-photo">
            <img className="hero-stadium-img" src={team.stadium.image} alt={team.stadium.name} />
            <div className="hero-stadium-caption">
              <span className="hero-stadium-name">{team.stadium.name}</span>
              <span className="hero-stadium-capacity">Capacity: {team.stadium.capacity.toLocaleString()}</span>
            </div>
          </div>
        ) : (
          <div className="hero-slot">
            <span>Stadium + jersey art — coming soon</span>
          </div>
        )}
        <div className="color-legend">
          <span className="legend-title">Team colors</span>
          <div className="swatch-row">
            <div className="swatch-item">
              <span className="swatch-block" style={{ background: team.accent }} />
              <span className="swatch-name">Primary</span>
              <span className="swatch-hex">{team.accent}</span>
            </div>
            <div className="swatch-item">
              <span className="swatch-block" style={{ background: team.accent2 }} />
              <span className="swatch-name">Secondary</span>
              <span className="swatch-hex">{team.accent2}</span>
            </div>
            <div className="swatch-item">
              <span className="swatch-block" style={{ background: team.bg }} />
              <span className="swatch-name">Base</span>
              <span className="swatch-hex">{team.bg}</span>
            </div>
          </div>
        </div>
      </header>

      {isCommissioner && (
        <div className="commissioner-bar">
          <button className="btn-secondary" onClick={() => setEditMode((e) => !e)}>
            {editMode ? 'Done editing' : 'Edit roster'}
          </button>
          {editMode && (
            <>
              <button className="btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save to server'}
              </button>
              {saveMsg && <span className="save-msg">{saveMsg}</span>}
            </>
          )}
        </div>
      )}

      <div className="cap-summary">
        <div className="cap-block">
          <span className="cap-label">Cap used</span>
          <span className="cap-value">{money(capUsed)}</span>
        </div>
        <div className="cap-bar">
          <div
            className={`cap-fill ${capSpace < 0 ? 'over' : ''}`}
            style={{ width: `${Math.min(100, (capUsed / SALARY_CAP) * 100)}%` }}
          />
        </div>
        <div className="cap-block">
          <span className="cap-label">Cap space</span>
          <span className={`cap-value ${capSpace < 0 ? 'over' : ''}`}>{money(capSpace)}</span>
        </div>
      </div>

      {POSITIONS.map((pos) => {
        const rows = active.filter((r) => r.contract.position === pos);
        if (rows.length === 0) return null;
        return (
          <section className="roster-section" key={pos}>
            <h2 className="section-title">{pos}</h2>
            {rowTable(rows)}
          </section>
        );
      })}

      {taxi.length > 0 && (
        <section className="roster-section">
          <h2 className="section-title">Taxi squad</h2>
          <p className="section-note">Does not count against the cap.</p>
          {rowTable(taxi, { badge: 'taxi' })}
        </section>
      )}

      {ir.length > 0 && (
        <section className="roster-section">
          <h2 className="section-title">Injured reserve</h2>
          <p className="section-note">Does not count against the cap.</p>
          {rowTable(ir, { badge: 'ir' })}
        </section>
      )}

      {editMode && <AddContractForm onAdd={addContract} />}

      <p className="footnote">
        "Resign" projects the final contracted rate forward using the confirmed escalation increment for as
        many years as the player has been at that rate. This is a consistent anchor, not a market-value
        forecast. Cut penalty: 50% of the player's current salary, applied across every remaining contract
        year, rounded up once at the end.
      </p>
    </>
  );
}

function AddContractForm({
  onAdd,
}: {
  onAdd: (form: { name: string; position: string; baseSalary: number; lengthYears: number }) => void;
}) {
  const [name, setName] = useState('');
  const [position, setPosition] = useState('QB');
  const [baseSalary, setBaseSalary] = useState(1);
  const [lengthYears, setLengthYears] = useState(3);

  return (
    <section className="roster-section add-contract-form">
      <h2 className="section-title">Add contract</h2>
      <div className="add-form-row">
        <input placeholder="Player name" value={name} onChange={(e) => setName(e.target.value)} />
        <select value={position} onChange={(e) => setPosition(e.target.value)}>
          {POSITIONS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <input
          type="number"
          min={1}
          placeholder="Base salary"
          value={baseSalary}
          onChange={(e) => setBaseSalary(Number(e.target.value))}
        />
        <input
          type="number"
          min={1}
          max={6}
          placeholder="Years"
          value={lengthYears}
          onChange={(e) => setLengthYears(Number(e.target.value))}
        />
        <button
          className="btn-primary"
          onClick={() => {
            if (!name.trim()) return;
            onAdd({ name: name.trim(), position, baseSalary, lengthYears });
            setName('');
            setBaseSalary(1);
            setLengthYears(3);
          }}
        >
          Add
        </button>
      </div>
    </section>
  );
}
