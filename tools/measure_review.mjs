import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const defaultSamplesDir = path.join(projectRoot, 'samples', 'impact');
const defaultOutDir = path.join(projectRoot, 'tools', 'out', 'impact');

const STOPWORDS = new Set([
  'the', 'a', 'an', 'on', 'in', 'at', 'by', 'for', 'to', 'of', 'our', 'is', 'was', 'it', 'and', 'or',
]);

function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  return text.toLowerCase().match(/[a-z0-9]+/g) || [];
}

export function loadAllCases(samplesDir = defaultSamplesDir) {
  if (!fs.existsSync(samplesDir)) return [];
  const files = fs.readdirSync(samplesDir).filter((file) => file.endsWith('.json'));
  const cases = files.map((file) => {
    const raw = fs.readFileSync(path.join(samplesDir, file), 'utf8');
    const data = JSON.parse(raw);
    data._file = file;
    return data;
  });
  return cases.sort((a, b) => (a.id || '').localeCompare(b.id || '', undefined, { numeric: true }));
}

export function loadCase(caseId, samplesDir = defaultSamplesDir) {
  const cases = loadAllCases(samplesDir);
  const normalized = String(caseId).trim().toLowerCase();
  const match = cases.find(
    (item) =>
      item.id.toLowerCase() === normalized ||
      (item._file && item._file.toLowerCase() === normalized) ||
      (item._file && item._file.replace(/\.json$/i, '').toLowerCase() === normalized),
  );
  if (!match) {
    throw new Error(`Case not found: ${caseId}`);
  }
  return match;
}

export function formatRawRecords(fixture) {
  const lines = [];
  lines.push(`Case: ${fixture.id} ${fixture.title}`);
  const r = fixture.records || {};
  if (r.dispute) {
    const d = r.dispute;
    lines.push(`Dispute ID: ${d.dispute_id || d.id || 'none'}`);
    lines.push(`Dispute Reason: ${d.reason || 'none'}`);
    const amountVal = d.dispute_amount?.value || d.amount || '0';
    const currencyVal = d.dispute_amount?.currency_code || d.currency || 'USD';
    lines.push(`Dispute Amount: ${amountVal} ${currencyVal}`);
    lines.push(`Dispute Status: ${d.status || 'none'}`);
    lines.push(`Dispute Created: ${d.create_time || 'none'}`);
    if (d.evidences && d.evidences[0]?.notes) {
      lines.push(`Buyer Note: ${d.evidences[0].notes}`);
    }
  }
  if (r.capture) {
    const c = r.capture;
    lines.push(`Payment Capture ID: ${c.id || 'none'}`);
    lines.push(`Payment Status: ${c.status || 'none'}`);
    const capAmount = c.amount?.value || c.amount || '0';
    const capCurrency = c.amount?.currency_code || c.currency || 'USD';
    lines.push(`Payment Amount: ${capAmount} ${capCurrency}`);
    lines.push(`Payment Date: ${c.create_time || 'none'}`);
  }
  if (r.order) {
    const o = r.order;
    lines.push(`Order ID: ${o.id || 'none'}`);
    lines.push(`Order Status: ${o.status || 'none'}`);
    const pu = o.purchase_units?.[0];
    if (pu?.description) {
      lines.push(`Order Item: ${pu.description}`);
    }
    const addr = pu?.shipping?.address;
    if (addr) {
      lines.push(`Order Destination: ${addr.admin_area_2 || ''}, ${addr.admin_area_1 || ''}, ${addr.country_code || ''}`);
    }
  }
  if (r.tracker) {
    const t = r.tracker;
    lines.push(`Tracker ID: ${t.id || 'none'}`);
    if (t.carrier) lines.push(`Carrier: ${t.carrier}`);
    if (t.tracking_number) lines.push(`Tracking Number: ${t.tracking_number}`);
    lines.push(`Tracking Status: ${t.status || 'none'}`);
    if (t.delivered_at) lines.push(`Delivered At: ${t.delivered_at}`);
  } else {
    lines.push(`Tracking: No tracking record`);
  }
  const text = lines.join('\n');
  return text;
}

function normalizeList(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.map((item) => String(item).trim()).filter(Boolean);
  if (typeof val === 'string') return val.split(/;\s*|\n/).map((item) => item.trim()).filter(Boolean);
  return [String(val).trim()].filter(Boolean);
}

function matchesPhrase(target, candidates) {
  const targetLower = target.toLowerCase().trim();
  const targetTokens = tokenize(target);
  if (!targetTokens.length) return false;
  const keyTokens = targetTokens.filter((token) => !STOPWORDS.has(token));
  const activeTargetTokens = keyTokens.length > 0 ? keyTokens : targetTokens;

  for (const item of candidates) {
    const itemLower = item.toLowerCase().trim();
    if (itemLower.includes(targetLower) || targetLower.includes(itemLower)) {
      return true;
    }
    const itemTokens = new Set(tokenize(item));
    if (activeTargetTokens.every((token) => itemTokens.has(token))) {
      return true;
    }
    const candKeyTokens = tokenize(item).filter((token) => !STOPWORDS.has(token));
    if (candKeyTokens.length > 0 && candKeyTokens.every((token) => targetTokens.includes(token))) {
      return true;
    }
  }

  const combinedTokens = new Set(candidates.flatMap(tokenize));
  if (activeTargetTokens.every((token) => combinedTokens.has(token))) {
    return true;
  }
  return false;
}

export function score(arg1, arg2) {
  let key;
  let submission;
  if (arg1 && (arg1.mustFind || arg1.traps || arg1.answer)) {
    key = arg1.answer || arg1;
    submission = arg2 || {};
  } else if (arg2 && (arg2.mustFind || arg2.traps || arg2.answer)) {
    key = arg2.answer || arg2;
    submission = arg1 || {};
  } else {
    key = arg1 || {};
    submission = arg2 || {};
  }

  const expectedVerdict = (key.verdict || '').trim().toUpperCase();
  const actualVerdict = (submission.verdict || '').trim().toUpperCase();
  const verdictRight = expectedVerdict.length > 0 && expectedVerdict === actualVerdict;

  const mustFindList = Array.isArray(key.mustFind) ? key.mustFind : [];
  const trapsList = Array.isArray(key.traps) ? key.traps : [];

  const candidateFacts = normalizeList(submission.facts);
  const candidateClaims = normalizeList(submission.claims);
  const allSubmitted = [...candidateFacts, ...candidateClaims];

  const mustFindFound = [];
  const missingFacts = [];

  for (const fact of mustFindList) {
    if (matchesPhrase(fact, allSubmitted)) {
      mustFindFound.push(fact);
    } else {
      missingFacts.push(fact);
    }
  }

  const trapsHit = [];
  for (const trap of trapsList) {
    if (matchesPhrase(trap, allSubmitted)) {
      trapsHit.push(trap);
    }
  }

  return {
    verdictRight,
    right: verdictRight,
    verdictExpected: expectedVerdict,
    verdictActual: actualVerdict,
    mustFindTotal: mustFindList.length,
    mustFindFound,
    missingFacts,
    missedMustFind: missingFacts,
    trapsHit,
    wrongClaims: trapsHit,
    hitTraps: trapsHit,
  };
}

export function startTask(caseId, tester, options = {}) {
  const samplesDir = options.samplesDir || defaultSamplesDir;
  const outDir = options.outDir || defaultOutDir;
  const fixture = loadCase(caseId, samplesDir);

  const startRecord = {
    tester: String(tester),
    caseId: fixture.id,
    startedAt: options.now || Date.now(),
    startTime: new Date(options.now || Date.now()).toISOString(),
  };

  fs.mkdirSync(outDir, { recursive: true });
  const startFile = path.join(outDir, `${tester}-${caseId}.start.json`);
  fs.writeFileSync(startFile, JSON.stringify(startRecord, null, 2) + '\n', 'utf8');

  if (caseId !== fixture.id) {
    const altFile = path.join(outDir, `${tester}-${fixture.id}.start.json`);
    fs.writeFileSync(altFile, JSON.stringify(startRecord, null, 2) + '\n', 'utf8');
  }

  const recordsText = formatRawRecords(fixture);
  if (options.print !== false) {
    console.log(recordsText);
    console.log(`Task started for tester ${tester}`);
  }

  return { startRecord, fixture, startFile, recordsText };
}

export function finishTask(caseId, tester, input = {}, options = {}) {
  const samplesDir = options.samplesDir || defaultSamplesDir;
  const outDir = options.outDir || defaultOutDir;
  const fixture = loadCase(caseId, samplesDir);

  const startPath1 = path.join(outDir, `${tester}-${caseId}.start.json`);
  const startPath2 = path.join(outDir, `${tester}-${fixture.id}.start.json`);
  let startData;
  if (fs.existsSync(startPath1)) {
    startData = JSON.parse(fs.readFileSync(startPath1, 'utf8'));
  } else if (fs.existsSync(startPath2)) {
    startData = JSON.parse(fs.readFileSync(startPath2, 'utf8'));
  } else {
    throw new Error(`Start file not found for tester ${tester} on case ${caseId}`);
  }

  const now = options.now || Date.now();
  const startTimeMs = startData.startedAt || Date.parse(startData.startTime) || now;
  const elapsedMs = Math.max(0, now - startTimeMs);
  const elapsedSeconds = Math.round(elapsedMs / 1000);

  const scores = score(fixture.answer, input);
  const approveChoice = input.approve !== undefined ? String(input.approve) : 'no';

  const resultRecord = {
    tester: String(tester),
    case: fixture.id,
    caseId: fixture.id,
    elapsedSeconds,
    scores,
    verdictRight: scores.verdictRight,
    missingFacts: scores.missingFacts,
    wrongClaims: scores.wrongClaims,
    approve: approveChoice,
    approveChoice,
    recordedAt: new Date(now).toISOString(),
  };

  fs.mkdirSync(outDir, { recursive: true });
  const resultsFile = path.join(outDir, 'results.jsonl');
  fs.appendFileSync(resultsFile, JSON.stringify(resultRecord) + '\n', 'utf8');

  if (options.print !== false) {
    console.log(`Task finished for tester ${tester} on case ${fixture.id}`);
    console.log(`Elapsed seconds: ${elapsedSeconds}`);
    console.log(`Verdict correct: ${scores.verdictRight ? 'yes' : 'no'}`);
    const missText = scores.missingFacts.length > 0 ? scores.missingFacts.join(', ') : 'none';
    console.log(`Missing facts: ${missText}`);
    const trapText = scores.trapsHit.length > 0 ? scores.trapsHit.join(', ') : 'none';
    console.log(`Traps hit: ${trapText}`);
    console.log(`Approve choice: ${approveChoice}`);
  }

  return resultRecord;
}

function computeMedian(numbers) {
  if (!numbers.length) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function summary(options = {}) {
  const outDir = options.outDir || defaultOutDir;
  const samplesDir = options.samplesDir || defaultSamplesDir;
  const allCases = loadAllCases(samplesDir);

  const resultsFile = path.join(outDir, 'results.jsonl');
  const entries = [];
  if (fs.existsSync(resultsFile)) {
    const raw = fs.readFileSync(resultsFile, 'utf8');
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // ignore malformed lines
      }
    }
  }

  const summaryData = allCases.map((c) => {
    const caseEntries = entries.filter((e) => e.case === c.id || e.caseId === c.id);
    const runs = caseEntries.length;
    const elapsedList = caseEntries.map((e) => (typeof e.elapsedSeconds === 'number' ? e.elapsedSeconds : 0));
    const medianSeconds = computeMedian(elapsedList);
    const verdictsRight = caseEntries.filter((e) => e.scores?.verdictRight ?? e.verdictRight).length;
    const missingFacts = caseEntries.reduce(
      (acc, e) => acc + (e.scores?.missingFacts?.length ?? e.missingFacts?.length ?? 0),
      0,
    );
    const wrongClaims = caseEntries.reduce(
      (acc, e) => acc + (e.scores?.trapsHit?.length ?? e.scores?.wrongClaims?.length ?? e.wrongClaims?.length ?? 0),
      0,
    );
    const approvals = caseEntries.filter((e) => {
      const choice = String(e.approve ?? e.approveChoice).toLowerCase();
      return choice === 'yes' || choice === 'true';
    }).length;

    return {
      id: c.id,
      title: c.title,
      runs,
      medianSeconds,
      verdictsRight,
      missingFacts,
      wrongClaims,
      approvals,
    };
  });

  const header =
    'Case'.padEnd(16) +
    'Runs'.padStart(6) +
    'Median Seconds'.padStart(16) +
    'Verdicts Right'.padStart(16) +
    'Missing Facts'.padStart(15) +
    'Wrong Claims'.padStart(14) +
    'Approvals'.padStart(11);

  const rows = summaryData.map((row) =>
    row.id.padEnd(16) +
    String(row.runs).padStart(6) +
    String(row.medianSeconds).padStart(16) +
    String(row.verdictsRight).padStart(16) +
    String(row.missingFacts).padStart(15) +
    String(row.wrongClaims).padStart(14) +
    String(row.approvals).padStart(11),
  );

  const tableText = [header, ...rows].join('\n');
  if (options.print !== false) {
    console.log(tableText);
  }

  return { summaryData, tableText };
}

export function listCases(samplesDir = defaultSamplesDir) {
  const cases = loadAllCases(samplesDir);
  const lines = cases.map((c) => `${c.id}: ${c.title}`);
  const text = lines.join('\n');
  console.log(text);
  return cases;
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const keyVal = arg.slice(2);
      const eqIdx = keyVal.indexOf('=');
      if (eqIdx !== -1) {
        flags[keyVal.slice(0, eqIdx)] = keyVal.slice(eqIdx + 1);
      } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[keyVal] = args[i + 1];
        i++;
      } else {
        flags[keyVal] = 'true';
      }
    }
  }
  return flags;
}

async function runCli() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || command === 'list') {
    listCases();
    return;
  }
  if (command === 'start') {
    const caseId = args[1];
    const tester = args[2];
    if (!caseId || !tester) {
      console.error('Usage: node tools/measure_review.mjs start <caseId> <tester>');
      process.exit(1);
    }
    startTask(caseId, tester);
    return;
  }
  if (command === 'finish') {
    const caseId = args[1];
    const tester = args[2];
    if (!caseId || !tester) {
      console.error(
        'Usage: node tools/measure_review.mjs finish <caseId> <tester> --verdict FIGHT --facts "a;b" --claims "x;y" --approve yes|no',
      );
      process.exit(1);
    }
    const flags = parseFlags(args.slice(3));
    finishTask(caseId, tester, {
      verdict: flags.verdict,
      facts: flags.facts,
      claims: flags.claims,
      approve: flags.approve,
    });
    return;
  }
  if (command === 'summary') {
    summary();
    return;
  }
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

const isDirectRun = Boolean(
  process.argv[1] &&
    (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
      process.argv[1].endsWith('measure_review.mjs')),
);

if (isDirectRun) {
  runCli().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
