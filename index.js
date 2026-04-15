// Entry point: initializes the financial analysis MCP server and registers all tools for Voltera CFO use.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { parseFile, parseCsvFile, detectAmountColumn, detectDateColumn, detectDescriptionColumn, mergeFiles } from './csv-parser.js';
import { SYSTEM_PROMPT } from './system-prompt.js';

const server = new McpServer({
  name: 'voltera-financial-analyst',
  version: '2.0.0',
});

// ── HELPERS ───────────────────────────────────────────────────────────────────

function toNumber(val) {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') return parseFloat(val.replace(/[€$,\s]/g, '').replace(',', '.')) || 0;
  return 0;
}

function getWeekKey(date) {
  const d = new Date(date);
  const start = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - start) / 86400000 + start.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function getMonthKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ── Tool 1: parse_csv ──────────────────────────────────────────────────────────
server.tool(
  'parse_csv',
  'Parse a CSV file with financial data. Returns column mapping, preview, and basic stats.',
  { file_path: z.string().describe('Absolute path to the CSV file') },
  async ({ file_path }) => {
    const { rows, fields } = parseFile(file_path);
    const amountCol = detectAmountColumn(fields);
    const dateCol = detectDateColumn(fields);
    const descCol = detectDescriptionColumn(fields);

    let totalAmount = 0;
    if (amountCol) rows.forEach(r => totalAmount += toNumber(r[amountCol]));

    return {
      content: [{
        type: 'text', text: JSON.stringify({
          row_count: rows.length,
          columns: fields,
          detected_columns: { amount: amountCol, date: dateCol, description: descCol },
          total_amount: Math.round(totalAmount * 100) / 100,
          preview: rows.slice(0, 5),
        }, null, 2)
      }],
    };
  }
);

// ── Tool 2: build_pnl ─────────────────────────────────────────────────────────
server.tool(
  'build_pnl',
  'Build a P&L (profit & loss) statement from CSV transaction data. Separates revenue from costs and calculates gross margin, EBITDA, and net result. Adds Voltera benchmark comparison.',
  {
    file_path: z.string().describe('Absolute path to the CSV file'),
    revenue_keywords: z.array(z.string()).optional().default(['omzet', 'inkomst', 'verkoop', 'factuur', 'revenue', 'income', 'sales', 'credit']).describe('Keywords to identify revenue rows'),
    cost_keywords: z.array(z.string()).optional().default(['inkoop', 'kosten', 'salaris', 'loon', 'huur', 'abonnement', 'leverancier', 'debet', 'expense', 'cost', 'salary']).describe('Keywords to identify cost rows'),
    amount_column: z.string().optional().describe('Column for amounts (auto-detected if omitted)'),
    description_column: z.string().optional().describe('Column for descriptions (auto-detected if omitted)'),
    date_column: z.string().optional().describe('Column for dates (auto-detected if omitted)'),
    period: z.enum(['total', 'monthly']).default('total').describe('Show totals or breakdown per month'),
  },
  async ({ file_path, revenue_keywords, cost_keywords, amount_column, description_column, date_column, period }) => {
    const { rows, fields } = parseFile(file_path);
    const amtCol = amount_column ?? detectAmountColumn(fields);
    const descCol = description_column ?? detectDescriptionColumn(fields);
    const dtCol = date_column ?? detectDateColumn(fields);

    if (!amtCol) throw new Error(`Geen bedragkolom gevonden. Kolommen: ${fields.join(', ')}`);

    const classify = (row) => {
      const desc = String(row[descCol] ?? '').toLowerCase();
      const isRevenue = revenue_keywords.some(k => desc.includes(k.toLowerCase()));
      const isCost = cost_keywords.some(k => desc.includes(k.toLowerCase()));
      if (isRevenue) return 'revenue';
      if (isCost) return 'cost';
      // Fallback: positive = revenue, negative = cost
      const amt = toNumber(row[amtCol]);
      return amt >= 0 ? 'revenue' : 'cost';
    };

    if (period === 'total') {
      let totalRevenue = 0, totalCosts = 0;
      const costBreakdown = {};
      for (const row of rows) {
        const amt = Math.abs(toNumber(row[amtCol]));
        const type = classify(row);
        if (type === 'revenue') {
          totalRevenue += amt;
        } else {
          totalCosts += amt;
          const label = descCol ? String(row[descCol] ?? 'Overig').slice(0, 40) : 'Overig';
          costBreakdown[label] = (costBreakdown[label] || 0) + amt;
        }
      }

      const grossProfit = totalRevenue - totalCosts;
      const grossMargin = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;

      // Top cost categories
      const topCosts = Object.entries(costBreakdown)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([label, amt]) => ({ label, amount: Math.round(amt), pct_of_costs: totalCosts > 0 ? +((amt / totalCosts) * 100).toFixed(1) : 0 }));

      const pnl = {
        omzet: Math.round(totalRevenue),
        totale_kosten: Math.round(totalCosts),
        bruto_winst: Math.round(grossProfit),
        bruto_marge_pct: +grossMargin.toFixed(1),
        benchmark_bruto_marge: '25–40% (verduurzamingsbedrijf)',
        marge_beoordeling: grossMargin >= 25 ? '✓ Binnen benchmark' : grossMargin >= 15 ? '⚠ Onder benchmark' : '✗ Kritisch laag',
        top_kosten: topCosts,
        actie_aanbeveling: grossMargin < 25
          ? 'Bruto marge ligt onder benchmark. Prioriteit: analyseer top-kostenposten op besparingspotentieel.'
          : 'Marge is gezond. Focus op omzetgroei en beheersing van schaalkosten.',
      };

      return { content: [{ type: 'text', text: JSON.stringify(pnl, null, 2) }] };
    }

    // Monthly breakdown
    if (!dtCol) throw new Error('Datumkolom benodigd voor maandelijkse P&L.');
    const months = {};
    for (const row of rows) {
      const d = new Date(row[dtCol]);
      if (isNaN(d)) continue;
      const key = getMonthKey(d);
      if (!months[key]) months[key] = { revenue: 0, costs: 0 };
      const amt = Math.abs(toNumber(row[amtCol]));
      const type = classify(row);
      months[key][type === 'revenue' ? 'revenue' : 'costs'] += amt;
    }

    const monthly = Object.entries(months).sort().map(([month, v]) => ({
      month,
      omzet: Math.round(v.revenue),
      kosten: Math.round(v.costs),
      bruto_winst: Math.round(v.revenue - v.costs),
      marge_pct: v.revenue > 0 ? +((((v.revenue - v.costs) / v.revenue) * 100)).toFixed(1) : 0,
    }));

    return { content: [{ type: 'text', text: JSON.stringify({ monthly_pnl: monthly }, null, 2) }] };
  }
);

// ── Tool 3: calculate_runway ──────────────────────────────────────────────────
server.tool(
  'calculate_runway',
  'Calculate company runway (how many months of cash left) based on current cash balance and burn rate. Includes scenario analysis.',
  {
    cash_balance: z.number().describe('Current cash balance in euros'),
    monthly_burn_rate: z.number().optional().describe('Average monthly net cash outflow (positive number). Auto-calculated from CSV if omitted.'),
    monthly_revenue: z.number().optional().describe('Expected monthly revenue. Used for net burn calculation.'),
    file_path: z.string().optional().describe('CSV file to auto-calculate burn rate from historical data'),
    amount_column: z.string().optional().describe('Amount column name (auto-detected)'),
    date_column: z.string().optional().describe('Date column name (auto-detected)'),
    growth_rate_pct: z.number().optional().default(0).describe('Expected monthly revenue growth % for optimistic scenario'),
  },
  async ({ cash_balance, monthly_burn_rate, monthly_revenue, file_path, amount_column, date_column, growth_rate_pct }) => {
    let burn = monthly_burn_rate;

    if (!burn && file_path) {
      const { rows, fields } = parseFile(file_path);
      const amtCol = amount_column ?? detectAmountColumn(fields);
      const dtCol = date_column ?? detectDateColumn(fields);
      if (!amtCol || !dtCol) throw new Error('Kan burn rate niet berekenen zonder bedrag- en datumkolom.');

      const monthly = {};
      for (const row of rows) {
        const d = new Date(row[dtCol]);
        if (isNaN(d)) continue;
        const key = getMonthKey(d);
        monthly[key] = (monthly[key] || 0) + toNumber(row[amtCol]);
      }
      const netFlows = Object.values(monthly);
      burn = netFlows.length > 0 ? -netFlows.reduce((a, b) => a + b, 0) / netFlows.length : null;
    }

    if (!burn) throw new Error('Geef monthly_burn_rate op of een file_path om automatisch te berekenen.');

    const netBurn = monthly_revenue ? burn - monthly_revenue : burn;

    const runwayMonths = netBurn > 0 ? cash_balance / netBurn : Infinity;

    // Scenarios
    const scenarios = {
      base: {
        label: 'Huidig (geen groei)',
        maandelijks_netto_burn: Math.round(netBurn),
        runway_maanden: netBurn > 0 ? +runwayMonths.toFixed(1) : 'oneindig',
        runway_datum: netBurn > 0 ? new Date(Date.now() + runwayMonths * 30 * 86400000).toISOString().slice(0, 7) : 'n.v.t.',
      },
    };

    if (growth_rate_pct > 0 && monthly_revenue) {
      // Optimistic: revenue grows monthly
      let cash = cash_balance;
      let rev = monthly_revenue;
      let months = 0;
      while (cash > 0 && months < 60) {
        cash -= (burn - rev);
        rev *= (1 + growth_rate_pct / 100);
        months++;
      }
      scenarios.optimistisch = {
        label: `Omzetgroei +${growth_rate_pct}%/mnd`,
        runway_maanden: cash > 0 ? '>60' : months,
        runway_datum: cash > 0 ? '>5 jaar' : new Date(Date.now() + months * 30 * 86400000).toISOString().slice(0, 7),
      };
    }

    // Pessimistic: 20% more burn
    const pessimBurn = netBurn * 1.2;
    const pessimMonths = pessimBurn > 0 ? cash_balance / pessimBurn : Infinity;
    scenarios.pessimistisch = {
      label: '20% hogere kosten',
      maandelijks_netto_burn: Math.round(pessimBurn),
      runway_maanden: pessimBurn > 0 ? +pessimMonths.toFixed(1) : 'oneindig',
      runway_datum: pessimBurn > 0 ? new Date(Date.now() + pessimMonths * 30 * 86400000).toISOString().slice(0, 7) : 'n.v.t.',
    };

    const beoordeling =
      runwayMonths >= 12 ? '✓ Gezond (>12 maanden)'
      : runwayMonths >= 6 ? '⚠ Let op (6–12 maanden)'
      : runwayMonths >= 3 ? '✗ Kritisch (3–6 maanden)'
      : '🚨 Acuut gevaar (<3 maanden)';

    return {
      content: [{
        type: 'text', text: JSON.stringify({
          kas_saldo: cash_balance,
          maandelijkse_burn: Math.round(burn),
          netto_burn: Math.round(netBurn),
          runway_beoordeling: beoordeling,
          scenarios,
          acties: runwayMonths < 6
            ? ['Directe focus op cashflow-verbetering', 'Versneld debiteurenbeheer', 'Overweeg kredietlijn of bridge financing']
            : ['Runway is acceptabel — focus op groei', 'Monitor maandelijks netto burn', 'Bouw cashbuffer naar 9+ maanden'],
        }, null, 2)
      }],
    };
  }
);

// ── Tool 4: rolling_forecast_13w ──────────────────────────────────────────────
server.tool(
  'rolling_forecast_13w',
  'Generate a 13-week rolling cashflow forecast based on historical weekly patterns from a CSV file.',
  {
    file_path: z.string().describe('CSV file with historical transaction data'),
    cash_balance: z.number().describe('Current cash balance in euros (starting point)'),
    amount_column: z.string().optional().describe('Amount column (auto-detected)'),
    date_column: z.string().optional().describe('Date column (auto-detected)'),
    expected_inflows: z.array(z.object({
      week: z.string().describe('Week label e.g. "2026-W16"'),
      amount: z.number(),
      description: z.string().optional(),
    })).optional().default([]).describe('Known future inflows (invoices, subsidies, etc.)'),
    expected_outflows: z.array(z.object({
      week: z.string().describe('Week label e.g. "2026-W16"'),
      amount: z.number(),
      description: z.string().optional(),
    })).optional().default([]).describe('Known future outflows (payroll, rent, suppliers)'),
  },
  async ({ file_path, cash_balance, amount_column, date_column, expected_inflows, expected_outflows }) => {
    const { rows, fields } = parseFile(file_path);
    const amtCol = amount_column ?? detectAmountColumn(fields);
    const dtCol = date_column ?? detectDateColumn(fields);
    if (!amtCol || !dtCol) throw new Error('Bedrag- en datumkolom benodigd voor forecast.');

    // Build weekly historical average
    const weeklyTotals = {};
    for (const row of rows) {
      const d = new Date(row[dtCol]);
      if (isNaN(d)) continue;
      const key = getWeekKey(d);
      weeklyTotals[key] = (weeklyTotals[key] || 0) + toNumber(row[amtCol]);
    }

    const historicalValues = Object.values(weeklyTotals);
    const avgWeeklyNet = historicalValues.length > 0
      ? historicalValues.reduce((a, b) => a + b, 0) / historicalValues.length
      : 0;

    // Generate next 13 weeks from today
    const today = new Date();
    const forecast = [];
    let runningBalance = cash_balance;

    for (let i = 1; i <= 13; i++) {
      const weekStart = new Date(today.getTime() + i * 7 * 86400000);
      const weekKey = getWeekKey(weekStart);

      const scheduledIn = expected_inflows
        .filter(e => e.week === weekKey)
        .reduce((s, e) => s + e.amount, 0);
      const scheduledOut = expected_outflows
        .filter(e => e.week === weekKey)
        .reduce((s, e) => s + e.amount, 0);

      const projected_net = avgWeeklyNet + scheduledIn - scheduledOut;
      runningBalance += projected_net;

      forecast.push({
        week: weekKey,
        week_start: weekStart.toISOString().slice(0, 10),
        historisch_gemiddeld: Math.round(avgWeeklyNet),
        geplande_inkomsten: Math.round(scheduledIn),
        geplande_uitgaven: Math.round(scheduledOut),
        netto_cashflow: Math.round(projected_net),
        verwacht_saldo: Math.round(runningBalance),
        signaal: runningBalance < 0 ? '🚨 NEGATIEF SALDO' : runningBalance < 50000 ? '⚠ Laag saldo' : '✓',
      });
    }

    const lowestWeek = forecast.reduce((min, w) => w.verwacht_saldo < min.verwacht_saldo ? w : min, forecast[0]);
    const kritischeWeken = forecast.filter(w => w.verwacht_saldo < 50000);

    return {
      content: [{
        type: 'text', text: JSON.stringify({
          huidig_saldo: cash_balance,
          gemiddeld_wekelijks_netto: Math.round(avgWeeklyNet),
          laagste_punt: { week: lowestWeek.week, saldo: lowestWeek.verwacht_saldo },
          kritische_weken: kritischeWeken.map(w => w.week),
          forecast,
        }, null, 2)
      }],
    };
  }
);

// ── Tool 5: identify_waste ────────────────────────────────────────────────────
server.tool(
  'identify_waste',
  'Scan transaction data for cost reduction opportunities: duplicate subscriptions, recurring low-value costs, anomalies, and underutilized spend.',
  {
    file_path: z.string().describe('CSV file with transactions'),
    amount_column: z.string().optional(),
    description_column: z.string().optional(),
    date_column: z.string().optional(),
    min_monthly_threshold: z.number().optional().default(200).describe('Minimum monthly spend to flag a vendor (default €200)'),
  },
  async ({ file_path, amount_column, description_column, date_column, min_monthly_threshold }) => {
    const { rows, fields } = parseFile(file_path);
    const amtCol = amount_column ?? detectAmountColumn(fields);
    const descCol = description_column ?? detectDescriptionColumn(fields);
    const dtCol = date_column ?? detectDateColumn(fields);
    if (!amtCol) throw new Error(`Geen bedragkolom gevonden. Kolommen: ${fields.join(', ')}`);

    // Aggregate by vendor/description
    const catColDetected = fields.find(f => f.includes('categor') || f.includes('soort') || f.includes('type'));
    const vendors = {};
    for (const row of rows) {
      const amt = Math.abs(toNumber(row[amtCol]));
      if (amt <= 0) continue;
      // Prefer category column for grouping — avoids splitting recurring costs across description variants
      const label = catColDetected
        ? String(row[catColDetected] ?? 'Onbekend').trim()
        : descCol ? String(row[descCol] ?? 'Onbekend').trim().slice(0, 50) : 'Onbekend';
      const month = dtCol ? getMonthKey(new Date(row[dtCol])) : 'unknown';
      if (!vendors[label]) vendors[label] = { total: 0, count: 0, months: new Set(), amounts: [] };
      vendors[label].total += amt;
      vendors[label].count += 1;
      vendors[label].months.add(month);
      vendors[label].amounts.push(amt);
    }

    const totalMonths = dtCol
      ? new Set(rows.map(r => getMonthKey(new Date(r[dtCol])))).size || 1
      : 1;

    const results = Object.entries(vendors).map(([label, v]) => {
      const avgMonthly = v.total / totalMonths;
      const isRecurring = v.months.size >= 2;
      const amounts = v.amounts;
      const avgAmt = amounts.reduce((a, b) => a + b, 0) / amounts.length;
      const maxAmt = Math.max(...amounts);
      const isAnomaly = maxAmt > avgAmt * 3 && amounts.length > 2;

      return {
        vendor: label,
        totaal: Math.round(v.total),
        gem_per_maand: Math.round(avgMonthly),
        transacties: v.count,
        maanden_actief: v.months.size,
        is_terugkerend: isRecurring,
        anomalie: isAnomaly,
        flags: [
          isRecurring && avgMonthly >= min_monthly_threshold ? '🔁 Terugkerende kost — onderhandelbaar' : null,
          isAnomaly ? `⚠ Uitschieters: max €${Math.round(maxAmt)} vs gem €${Math.round(avgAmt)}` : null,
          v.count === 1 ? '❓ Eenmalige kost — context controleren' : null,
        ].filter(Boolean),
      };
    })
    .filter(v => v.gem_per_maand >= min_monthly_threshold || v.anomalie)
    .sort((a, b) => b.totaal - a.totaal);

    const topWaste = results.filter(v => v.flags.length > 0).slice(0, 10);
    const totalFlagged = topWaste.reduce((s, v) => s + v.gem_per_maand, 0);

    return {
      content: [{
        type: 'text', text: JSON.stringify({
          analyse_periode_maanden: totalMonths,
          gevonden_vendors: results.length,
          geschat_besparingspotentieel_per_maand: Math.round(totalFlagged * 0.15) + ' – ' + Math.round(totalFlagged * 0.30) + ' (10–20% besparing op geflagde posten)',
          prioriteit_lijst: topWaste,
          alle_vendors: results.slice(0, 20),
        }, null, 2)
      }],
    };
  }
);

// ── Tool 6: negotiation_targets ───────────────────────────────────────────────
server.tool(
  'negotiation_targets',
  'Identify top suppliers by spend and generate negotiation recommendations with estimated savings targets.',
  {
    file_path: z.string().describe('CSV file with transactions'),
    amount_column: z.string().optional(),
    description_column: z.string().optional(),
    date_column: z.string().optional(),
    top_n: z.number().optional().default(10).describe('Number of top vendors to return'),
  },
  async ({ file_path, amount_column, description_column, date_column, top_n }) => {
    const { rows, fields } = parseFile(file_path);
    const amtCol = amount_column ?? detectAmountColumn(fields);
    const descCol = description_column ?? detectDescriptionColumn(fields);
    const dtCol = date_column ?? detectDateColumn(fields);
    if (!amtCol) throw new Error(`Geen bedragkolom. Kolommen: ${fields.join(', ')}`);

    const vendors = {};
    for (const row of rows) {
      const amt = Math.abs(toNumber(row[amtCol]));
      if (amt <= 0) continue;
      const label = descCol ? String(row[descCol] ?? 'Onbekend').trim().slice(0, 60) : 'Onbekend';
      if (!vendors[label]) vendors[label] = { total: 0, count: 0, months: new Set() };
      vendors[label].total += amt;
      vendors[label].count += 1;
      if (dtCol) vendors[label].months.add(getMonthKey(new Date(row[dtCol])));
    }

    const totalSpend = Object.values(vendors).reduce((s, v) => s + v.total, 0);
    const totalMonths = dtCol ? new Set(rows.map(r => getMonthKey(new Date(r[dtCol])))).size || 1 : 1;

    const ranked = Object.entries(vendors)
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, top_n)
      .map(([label, v], i) => {
        const pct = (v.total / totalSpend) * 100;
        const isRecurring = v.months.size >= 3;
        const monthlyAvg = v.total / totalMonths;

        // Estimate savings potential based on relationship type
        const savingsPct = isRecurring ? (i < 3 ? 0.15 : 0.10) : 0.05;
        const savingsEst = v.total * savingsPct;

        return {
          rang: i + 1,
          leverancier: label,
          totaal_spend: Math.round(v.total),
          pct_van_totaal: +pct.toFixed(1),
          gem_per_maand: Math.round(monthlyAvg),
          transacties: v.count,
          relatie_type: isRecurring ? 'Vaste leverancier' : 'Incidenteel',
          geschatte_besparing: Math.round(savingsEst),
          besparing_pct: `${(savingsPct * 100).toFixed(0)}%`,
          onderhandel_tip: isRecurring && i < 3
          ? 'Jaarscontract met volumekorting — vraag 10–20% korting bij commitment'
            : isRecurring
            ? 'Vergelijk offerte bij alternatieve leverancier — gebruik als drukmiddel'
            : 'Check of inkoop geconcentreerd kan worden bij bestaande vaste leverancier',
        };
      });

    const totalSavings = ranked.reduce((s, v) => s + v.geschatte_besparing, 0);

    return {
      content: [{
        type: 'text', text: JSON.stringify({
          totale_spend_geanalyseerd: Math.round(totalSpend),
          top_leveranciers: ranked,
          totaal_geschatte_besparing: Math.round(totalSavings),
          aanpak: 'Start met rang 1–3. Plan onderhandelingsgesprek voor contract renewal of tender bij alternatieven.',
        }, null, 2)
      }],
    };
  }
);

// ── Tool 7: cashflow_analysis ─────────────────────────────────────────────────
server.tool(
  'cashflow_analysis',
  'Analyze cash inflows vs outflows from CSV data. Shows net cashflow per period, peak/trough months, and flags potential cash gaps.',
  {
    file_path: z.string().describe('CSV file with transactions'),
    amount_column: z.string().optional(),
    date_column: z.string().optional(),
    description_column: z.string().optional(),
    period: z.enum(['weekly', 'monthly']).default('monthly'),
  },
  async ({ file_path, amount_column, date_column, description_column, period }) => {
    const { rows, fields } = parseFile(file_path);
    const amtCol = amount_column ?? detectAmountColumn(fields);
    const dtCol = date_column ?? detectDateColumn(fields);
    if (!amtCol || !dtCol) throw new Error('Bedrag- en datumkolom benodigd.');

    const buckets = {};
    for (const row of rows) {
      const d = new Date(row[dtCol]);
      if (isNaN(d)) continue;
      const key = period === 'weekly' ? getWeekKey(d) : getMonthKey(d);
      if (!buckets[key]) buckets[key] = { inflow: 0, outflow: 0 };
      const amt = toNumber(row[amtCol]);
      if (amt > 0) buckets[key].inflow += amt;
      else buckets[key].outflow += Math.abs(amt);
    }

    const periods = Object.entries(buckets).sort().map(([key, v]) => ({
      periode: key,
      inflow: Math.round(v.inflow),
      outflow: Math.round(v.outflow),
      netto: Math.round(v.inflow - v.outflow),
      cashflow_ratio: v.outflow > 0 ? +(v.inflow / v.outflow).toFixed(2) : null,
      signaal: v.inflow < v.outflow ? '⚠ Negatieve cashflow' : '✓',
    }));

    const negativeMonths = periods.filter(p => p.netto < 0);
    const avgNet = periods.reduce((s, p) => s + p.netto, 0) / periods.length;
    const bestPeriod = periods.reduce((m, p) => p.netto > m.netto ? p : m, periods[0]);
    const worstPeriod = periods.reduce((m, p) => p.netto < m.netto ? p : m, periods[0]);

    return {
      content: [{
        type: 'text', text: JSON.stringify({
          periode_type: period,
          gemiddeld_netto_per_periode: Math.round(avgNet),
          beste_periode: { periode: bestPeriod.periode, netto: bestPeriod.netto },
          slechtste_periode: { periode: worstPeriod.periode, netto: worstPeriod.netto },
          negatieve_periodes: negativeMonths.length,
          negatieve_periodes_detail: negativeMonths,
          cashflow_overzicht: periods,
          opmerking: negativeMonths.length > 0
            ? `Let op: ${negativeMonths.length} periode(s) met negatieve cashflow. Controleer of dit structureel is of seizoensgebonden.`
            : 'Cashflow is in alle periodes positief.',
        }, null, 2)
      }],
    };
  }
);

// ── Tool 8: calculate_kpis ────────────────────────────────────────────────────
server.tool(
  'calculate_kpis',
  'Calculate investment KPIs: IRR, NPV, payback period, DSCR. Compares to Voltera sector benchmarks.',
  {
    cashflows: z.array(z.number()).describe('Cashflows: index 0 = initial investment (negative), rest = annual returns'),
    discount_rate: z.number().optional().default(0.08).describe('Discount rate for NPV (default 8%)'),
    annual_debt_service: z.number().optional().describe('Annual debt service for DSCR'),
    annual_net_income: z.number().optional().describe('Annual net operating income for DSCR'),
  },
  async ({ cashflows, discount_rate, annual_debt_service, annual_net_income }) => {
    const npv = cashflows.reduce((acc, cf, i) => acc + cf / Math.pow(1 + discount_rate, i), 0);

    let irr = null;
    let guess = 0.1;
    for (let iter = 0; iter < 200; iter++) {
      const f = cashflows.reduce((acc, cf, i) => acc + cf / Math.pow(1 + guess, i), 0);
      const df = cashflows.reduce((acc, cf, i) => acc - (i * cf) / Math.pow(1 + guess, i + 1), 0);
      if (Math.abs(df) < 1e-10) break;
      const next = guess - f / df;
      if (Math.abs(next - guess) < 1e-8) { irr = next; break; }
      guess = next;
    }

    const initial = Math.abs(cashflows[0]);
    let cumulative = 0, payback = null;
    for (let i = 1; i < cashflows.length; i++) {
      cumulative += cashflows[i];
      if (cumulative >= initial) {
        payback = i - 1 + (initial - (cumulative - cashflows[i])) / cashflows[i];
        break;
      }
    }

    const dscr = annual_debt_service && annual_net_income ? annual_net_income / annual_debt_service : null;
    const irrPct = irr !== null ? irr * 100 : null;

    return {
      content: [{
        type: 'text', text: JSON.stringify({
          npv: Math.round(npv),
          irr: irrPct !== null ? `${irrPct.toFixed(2)}%` : 'niet berekenbaar',
          terugverdientijd: payback !== null ? `${payback.toFixed(1)} jaar` : 'niet binnen looptijd',
          dscr: dscr !== null ? dscr.toFixed(2) : 'onvoldoende data',
          beoordeling: {
            npv: npv > 0 ? '✓ Positief — investering creëert waarde' : '✗ Negatief — investering vernietigt waarde',
            irr: irrPct !== null ? (irrPct >= 9 ? '✓ Boven benchmark (zonneparken 6–9%)' : irrPct >= 6 ? '~ Binnen benchmark' : '✗ Onder benchmark') : 'n.v.t.',
            dscr: dscr !== null ? (dscr >= 1.25 ? '✓ Boven minimum (1.25x)' : '✗ Onder minimum — financier zal dit weigeren') : 'n.v.t.',
          },
          sector_benchmarks: { irr_zon: '6–9%', irr_wind: '7–11%', dscr_min: '1.25x', terugverdientijd_zakelijk: '5–8 jaar' },
        }, null, 2)
      }],
    };
  }
);

// ── Tool 9: get_voltera_context ───────────────────────────────────────────────
server.tool(
  'get_voltera_context',
  'Returns the full Voltera CFO context: company profile, sector benchmarks, and financial frameworks.',
  {},
  async () => ({ content: [{ type: 'text', text: SYSTEM_PROMPT }] })
);

// ── Tool 10: blocking_factors ─────────────────────────────────────────────────
server.tool(
  'blocking_factors',
  'Identify the top factors blocking Voltera\'s profitability and growth. Analyzes margin compression, cashflow gaps, cost concentration, revenue concentration, and overhead creep.',
  {
    file_path: z.string().describe('CSV file with transaction data'),
    amount_column: z.string().optional(),
    date_column: z.string().optional(),
    description_column: z.string().optional(),
    category_column: z.string().optional(),
    revenue_keywords: z.array(z.string()).optional().default(['omzet', 'inkomst', 'verkoop', 'factuur', 'revenue', 'credit']),
    cost_keywords: z.array(z.string()).optional().default(['inkoop', 'kosten', 'salaris', 'loon', 'huur', 'abonnement', 'debet', 'expense']),
  },
  async ({ file_path, amount_column, date_column, description_column, category_column, revenue_keywords, cost_keywords }) => {
    const { rows, fields } = parseFile(file_path);
    const amtCol = amount_column ?? detectAmountColumn(fields);
    const descCol = description_column ?? detectDescriptionColumn(fields);
    const dtCol = date_column ?? detectDateColumn(fields);
    if (!amtCol) throw new Error(`Geen bedragkolom gevonden. Kolommen: ${fields.join(', ')}`);

    const classify = (row) => {
      const desc = String(row[descCol] ?? '').toLowerCase();
      if (revenue_keywords.some(k => desc.includes(k.toLowerCase()))) return 'revenue';
      if (cost_keywords.some(k => desc.includes(k.toLowerCase()))) return 'cost';
      return toNumber(row[amtCol]) >= 0 ? 'revenue' : 'cost';
    };

    // Per month: revenue, costs, clients
    const months = {};
    const clients = {};
    const costCategories = {};

    for (const row of rows) {
      const amt = Math.abs(toNumber(row[amtCol]));
      const type = classify(row);
      const desc = String(row[descCol] ?? '');
      const month = dtCol ? getMonthKey(new Date(row[dtCol])) : 'unknown';

      if (!months[month]) months[month] = { revenue: 0, costs: 0 };
      months[month][type === 'revenue' ? 'revenue' : 'costs'] += amt;

      if (type === 'revenue') {
        // Extract client name (first meaningful word group)
        const clientKey = desc.slice(0, 40).trim();
        clients[clientKey] = (clients[clientKey] || 0) + amt;
      } else {
        const catCol = category_column ?? fields.find(f => f.includes('categor') || f.includes('soort'));
        const cat = catCol ? String(row[catCol] ?? 'Overig') : desc.slice(0, 30);
        costCategories[cat] = (costCategories[cat] || 0) + amt;
      }
    }

    const periodList = Object.entries(months).sort();
    const blockers = [];

    // 1. Margin compression
    const margins = periodList.map(([m, v]) => ({
      month: m,
      margin: v.revenue > 0 ? ((v.revenue - v.costs) / v.revenue) * 100 : -100,
    }));
    const avgMargin = margins.reduce((s, m) => s + m.margin, 0) / (margins.length || 1);
    const decliningMargins = margins.filter((m, i) => i > 0 && m.margin < margins[i - 1].margin - 3);
    if (avgMargin < 25) {
      blockers.push({
        prioriteit: 1,
        blokkade: 'Bruto marge onder benchmark',
        detail: `Gemiddelde marge ${avgMargin.toFixed(1)}% vs benchmark 25–40%`,
        impact: 'Hoog — ontneemt groeicapaciteit en buffer voor tegenvallers',
        actie: 'Analyseer welke projecttypes de laagste marge hebben en verhoog tarieven of schrap ze',
      });
    }
    if (decliningMargins.length >= 2) {
      blockers.push({
        prioriteit: 2,
        blokkade: 'Dalende marge-trend',
        detail: `Marge daalde in ${decliningMargins.length} maanden aanzienlijk`,
        impact: 'Middel — wijst op kostenstijging of prijsdruk',
        actie: 'Vergelijk offerteprijzen Q1 vs Q4 en controleer materiaalkostenindex',
      });
    }

    // 2. Revenue concentration
    const totalRevenue = Object.values(clients).reduce((s, v) => s + v, 0);
    const topClient = Object.entries(clients).sort((a, b) => b[1] - a[1])[0];
    if (topClient) {
      const topPct = (topClient[1] / totalRevenue) * 100;
      if (topPct > 30) {
        blockers.push({
          prioriteit: 2,
          blokkade: 'Klantconcentratierisico',
          detail: `"${topClient[0]}" = ${topPct.toFixed(0)}% van omzet`,
          impact: 'Hoog — verlies van deze klant bedreigt direct de continuïteit',
          actie: 'Diversificeer actief: target minstens 2 nieuwe klanten van vergelijkbare grootte dit kwartaal',
        });
      }
    }

    // 3. Overhead creep (fixed costs as % of revenue)
    const fixedCostKeywords = ['huur', 'lease', 'abonnement', 'verzekering', 'salarisrun'];
    let totalFixed = 0;
    for (const [cat, amt] of Object.entries(costCategories)) {
      if (fixedCostKeywords.some(k => cat.toLowerCase().includes(k))) totalFixed += amt;
    }
    const fixedPct = totalRevenue > 0 ? (totalFixed / totalRevenue) * 100 : 0;
    if (fixedPct > 35) {
      blockers.push({
        prioriteit: 3,
        blokkade: 'Hoge vaste kostenbase (overhead creep)',
        detail: `Vaste kosten = ${fixedPct.toFixed(0)}% van omzet`,
        impact: 'Middel — verlaagt flexibiliteit bij omzetdaling',
        actie: 'Review alle contracten >€ 500/mnd: aflopend? Opzegbaar? Alternatieven goedkoper?',
      });
    }

    // 4. Cashflow gap detection
    const negativeMonths = periodList.filter(([, v]) => v.revenue < v.costs);
    if (negativeMonths.length > 0) {
      blockers.push({
        prioriteit: 1,
        blokkade: 'Cashflow-gaten',
        detail: `${negativeMonths.length} maand(en) met meer uitgaven dan inkomsten: ${negativeMonths.map(([m]) => m).join(', ')}`,
        impact: 'Kritisch — direct liquiditeitsrisico',
        actie: 'Versneld debiteurenbeheer: bel alle openstaande facturen >30 dagen persoonlijk na',
      });
    }

    // 5. Subscription / SaaS creep
    const subSpend = Object.entries(costCategories)
      .filter(([cat]) => cat.toLowerCase().includes('abonnement') || cat.toLowerCase().includes('online') || cat.toLowerCase().includes('premium'))
      .reduce((s, [, v]) => s + v, 0);
    const subMonthly = subSpend / (periodList.length || 1);
    if (subMonthly > 1000) {
      blockers.push({
        prioriteit: 4,
        blokkade: 'Abonnements-creep (SaaS/tools)',
        detail: `~€${Math.round(subMonthly)}/mnd aan abonnementen`,
        impact: 'Laag-Middel — stil groeiende post zonder duidelijke ROI-meting',
        actie: 'Maak inventaris van alle tools, beoordeel gebruik per tool, cancel ongebruikte',
      });
    }

    blockers.sort((a, b) => a.prioriteit - b.prioriteit);

    return {
      content: [{
        type: 'text', text: JSON.stringify({
          aantal_blokkades_gevonden: blockers.length,
          blokkades: blockers,
          samenvatting: blockers.length === 0
            ? '✓ Geen kritieke blokkades gedetecteerd op basis van beschikbare data.'
            : `${blockers.filter(b => b.prioriteit === 1).length} kritieke blokkade(s) gevonden. Direct actie vereist.`,
          gemiddelde_bruto_marge: `${avgMargin.toFixed(1)}%`,
        }, null, 2)
      }],
    };
  }
);

// ── Tool 11: price_increase_advisor ──────────────────────────────────────────
server.tool(
  'price_increase_advisor',
  'Analyze whether Voltera should increase prices and by how much. Uses current margin, cost trends, and market positioning.',
  {
    current_avg_project_value: z.number().describe('Gemiddelde projectwaarde in euros'),
    current_gross_margin_pct: z.number().describe('Huidige bruto marge in procenten (bijv. 28 voor 28%)'),
    target_gross_margin_pct: z.number().optional().default(35).describe('Gewenste bruto marge (default 35%)'),
    annual_cost_increase_pct: z.number().optional().default(4).describe('Verwachte jaarlijkse kostenstijging % (inflatie, lonen)'),
    competitor_context: z.string().optional().describe('Optionele context over concurrentie of marktpositie'),
    file_path: z.string().optional().describe('CSV-bestand om kostenstijging automatisch te berekenen'),
    amount_column: z.string().optional(),
    date_column: z.string().optional(),
  },
  async ({ current_avg_project_value, current_gross_margin_pct, target_gross_margin_pct, annual_cost_increase_pct, competitor_context, file_path, amount_column, date_column }) => {
    let detectedCostTrend = null;

    if (file_path) {
      try {
        const { rows, fields } = parseFile(file_path);
        const amtCol = amount_column ?? detectAmountColumn(fields);
        const dtCol = date_column ?? detectDateColumn(fields);
        if (amtCol && dtCol) {
          const monthly = {};
          for (const row of rows) {
            const d = new Date(row[dtCol]);
            if (isNaN(d)) continue;
            const amt = toNumber(row[amtCol]);
            if (amt < 0) {
              const key = getMonthKey(d);
              monthly[key] = (monthly[key] || 0) + Math.abs(amt);
            }
          }
          const vals = Object.values(monthly);
          if (vals.length >= 2) {
            const first = vals.slice(0, Math.ceil(vals.length / 2)).reduce((a, b) => a + b, 0) / Math.ceil(vals.length / 2);
            const last = vals.slice(-Math.ceil(vals.length / 2)).reduce((a, b) => a + b, 0) / Math.ceil(vals.length / 2);
            detectedCostTrend = +((last - first) / first * 100).toFixed(1);
          }
        }
      } catch {}
    }

    const effectiveCostIncrease = detectedCostTrend !== null ? detectedCostTrend : annual_cost_increase_pct;

    // Current situation
    const currentCostPct = 100 - current_gross_margin_pct;
    const currentCosts = current_avg_project_value * (currentCostPct / 100);

    // After cost increase
    const futureCosts = currentCosts * (1 + effectiveCostIncrease / 100);
    const revenueToMaintainMargin = futureCosts / (currentCostPct / 100);
    const maintainPriceIncrease = ((revenueToMaintainMargin - current_avg_project_value) / current_avg_project_value) * 100;

    // To reach target margin
    const revenueForTargetMargin = futureCosts / ((100 - target_gross_margin_pct) / 100);
    const targetPriceIncrease = ((revenueForTargetMargin - current_avg_project_value) / current_avg_project_value) * 100;

    // Scenarios
    const scenarios = [
      {
        scenario: 'Minimaal (marge behouden)',
        prijsverhoging_pct: +maintainPriceIncrease.toFixed(1),
        nieuwe_projectwaarde: Math.round(revenueToMaintainMargin),
        nieuwe_marge_pct: +current_gross_margin_pct.toFixed(1),
        advies: 'Minimaal noodzakelijk om kostenstijging op te vangen',
      },
      {
        scenario: `Doelstelling (${target_gross_margin_pct}% marge)`,
        prijsverhoging_pct: +targetPriceIncrease.toFixed(1),
        nieuwe_projectwaarde: Math.round(revenueForTargetMargin),
        nieuwe_marge_pct: target_gross_margin_pct,
        advies: 'Aanbevolen — brengt marge binnen benchmark 25–40%',
      },
      {
        scenario: 'Ambitieus (+10% boven doel)',
        prijsverhoging_pct: +(targetPriceIncrease * 1.4).toFixed(1),
        nieuwe_projectwaarde: Math.round(revenueForTargetMargin * 1.04),
        nieuwe_marge_pct: +(target_gross_margin_pct + 3).toFixed(1),
        advies: 'Alleen haalbaar met sterke marktpositie of toegevoegde waarde',
      },
    ];

    const implementation = [
      current_gross_margin_pct < 25
        ? '🚨 Directe actie: marge is kritisch laag, prijsverhoging niet uitstellen'
        : current_gross_margin_pct < 30
        ? '⚠ Verhoog tarieven bij eerstvolgende offerterondes'
        : '✓ Marge acceptabel — verhoog geleidelijk bij renewals',
      'Pas prijsverhoging toe op nieuwe offertes, niet op lopende contracten',
      'Communiceer als "investering in kwaliteit en capaciteit" niet als pure kostendoorberekening',
      'Verhoog in stapjes: te grote sprong ineens verhoogt churn-risico',
      'Koppel verhoging aan moment van contractverlenging O&M-klanten',
    ];

    return {
      content: [{
        type: 'text', text: JSON.stringify({
          huidige_situatie: {
            gem_projectwaarde: current_avg_project_value,
            bruto_marge: `${current_gross_margin_pct}%`,
            benchmark: current_gross_margin_pct >= 25 ? '✓ Binnen benchmark (25–40%)' : '✗ Onder benchmark',
          },
          kostenstijging_gebruikt: `${effectiveCostIncrease}%${detectedCostTrend !== null ? ' (uit CSV berekend)' : ' (opgegeven)'}`,
          competitor_context: competitor_context ?? 'Niet opgegeven',
          scenarios,
          implementatie_advies: implementation,
          aanbeveling: targetPriceIncrease <= 0
          ? `Marge van ${current_gross_margin_pct}% ligt al boven doelstelling van ${target_gross_margin_pct}%. Geen prijsverhoging nodig voor marge. Focus op groei en margebehoud bij schaling.`
          : `Verhoog tarieven met minimaal ${maintainPriceIncrease.toFixed(0)}% om kostenstijging op te vangen. Streef naar ${targetPriceIncrease.toFixed(0)}% om doelmarge van ${target_gross_margin_pct}% te bereiken.`,
        }, null, 2)
      }],
    };
  }
);

// ── Tool 12: merge_files ─────────────────────────────────────────────────────
server.tool(
  'merge_files',
  'Merge multiple CSV or Excel files into one dataset. Use when the CEO has separate files per bank account, cost center, or period. Returns a temporary merged CSV path usable by all other tools.',
  {
    file_paths: z.array(z.string()).min(2).describe('Array of absolute file paths (.csv or .xlsx) to merge'),
  },
  async ({ file_paths }) => {
    const { rows, fields } = mergeFiles(file_paths);
    const amtCol  = detectAmountColumn(fields);
    const dateCol = detectDateColumn(fields);
    const descCol = detectDescriptionColumn(fields);

    // Write merged result to temp CSV
    const os = await import('os');
    const path = await import('path');
    const fs = await import('fs');
    const Papa = (await import('papaparse')).default;
    const tmpPath = path.join(os.tmpdir(), `voltera-merged-${Date.now()}.csv`);
    const csvContent = Papa.unparse(rows);
    fs.writeFileSync(tmpPath, csvContent, 'utf-8');

    let totalAmount = 0;
    if (amtCol) rows.forEach(r => totalAmount += (typeof r[amtCol] === 'number' ? r[amtCol] : parseFloat(String(r[amtCol]).replace(',', '.')) || 0));

    return {
      content: [{
        type: 'text', text: JSON.stringify({
          merged_file_path: tmpPath,
          bronbestanden: file_paths.length,
          totaal_rijen: rows.length,
          kolommen: fields,
          gedetecteerde_kolommen: { bedrag: amtCol, datum: dateCol, omschrijving: descCol },
          totaal_bedrag: Math.round(totalAmount),
          preview: rows.slice(0, 3),
          instructie: `Gebruik '${tmpPath}' als file_path in alle volgende tools (build_pnl, cashflow_analysis, etc.)`,
        }, null, 2)
      }],
    };
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);

