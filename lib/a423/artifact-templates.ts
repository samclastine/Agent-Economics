/**
 * Deterministic demo-artifact generators for the Job Execution Simulator.
 * Every worker tool produces real, inspectable files from templates —
 * the hiring/payment pipeline stays real; the work itself is simulated.
 */

export function scriptedContent(path: string, description: string): string {
  if (path === '/checklist.md') {
    return [
      '# Launch Verification Checklist',
      '',
      '1. Verify environment variables are set and contracts are deployed.',
      '2. Confirm both agent wallets have token and gas balances on the target chain.',
      '3. Check that the job escrow shows FUNDED state before execution begins.',
      '4. Validate the produced artifact passes all deterministic acceptance checks.',
      '5. Confirm escrow release transaction succeeded and balances reconciled.',
      '',
      `Context: ${description}`,
    ].join('\n');
  }
  return [
    '# Agent Treasury',
    '',
    '## Problem',
    'AI agents cannot easily hire each other, escrow payment for work, or spend earnings on AI compute without a trusted intermediary.',
    '',
    '## Solution',
    'Agent Treasury gives each agent its own wallet, job marketplace, on-chain escrow, and AI credit ledger inside a single application.',
    '',
    '## Features',
    '- Escrow-backed job escrow with on-chain settlement receipts.',
    '- Deterministic artifact verification before payment release.',
    '- AI credit purchases funded by token payments with an append-only ledger.',
    '',
    'Agents discover each other through the marketplace, agree on quotes, and settle work through escrow without trusting a central operator. Every payment is backed by an on-chain receipt, every deliverable is hashed and verified deterministically, and every credit movement is recorded in an append-only ledger so the full economy can be audited end to end by anyone watching the dashboard.',
    '',
    `Context: ${description}`,
  ].join('\n');
}

export type JobType = 'research' | 'frontend' | 'backend' | 'document' | 'data' | 'testing';

export const JOB_TYPES: JobType[] = ['research', 'frontend', 'backend', 'document', 'data', 'testing'];

/** Primary deliverable path per job type (used for spec.path + on-chain submit). */
export const PRIMARY_PATH: Record<JobType, string> = {
  research: '/report.md',
  frontend: '/README.md',
  backend: '/openapi.yaml',
  document: '/report.md',
  data: '/analysis.md',
  testing: '/tests/report.md',
};

export interface GeneratedFile { path: string; content: string }

function researchFiles(description: string): GeneratedFile[] {
  return [{
    path: '/report.md',
    content: [
      '# Research Report',
      '',
      `**Topic:** ${description}`,
      '',
      '## Executive summary',
      'This report surveys the current landscape, identifies the key mechanisms, and summarizes practical integration patterns relevant to the assigned scope. Findings are based on the agreed acceptance criteria and documented sources.',
      '',
      '## Key findings',
      '1. On-chain escrow separates custody from settlement: funds are locked by contract rules and released only when the agreed verification condition is met.',
      '2. Deterministic verification — hashing deliverables and checking acceptance criteria — removes the need to trust either party\'s claim of completion.',
      '3. Agent-to-agent marketplaces work best when offers, acceptance, funding, and settlement are each explicit, auditable steps rather than implicit assumptions.',
      '',
      '## Analysis',
      'Escrow-backed hiring shifts trust from reputation to code: the contract enforces who may release funds, the evaluator enforces what counts as acceptable work, and the ledger enforces what actually moved. For agent economies this matters because agents can verify state on-chain without trusting the counterparty\'s prose.',
      '',
      '## Recommendations',
      '- Require explicit acceptance of a finalized quote version before funding.',
      '- Verify funding on-chain before starting billable work.',
      '- Anchor deliverable hashes on-chain at submission time.',
      '',
      '## Sources',
      '- Agent Treasury job specification and acceptance criteria (internal).',
      '- ERC-8183 agentic commerce escrow model (reference).',
      '- On-chain escrow contract event log (JobFunded / JobPaid).',
      '',
      `Context: ${description}`,
    ].join('\n'),
  }];
}

function frontendFiles(description: string): GeneratedFile[] {
  return [
    {
      path: '/README.md',
      content: [
        '# Landing Page Demo',
        '',
        `A responsive landing page built for: ${description}`,
        '',
        '## Structure',
        '- `src/App.tsx` — main page component',
        '- `src/styles.css` — responsive styles',
        '- `preview.html` — static preview',
        '',
        '## Run',
        '```',
        'npm install && npm run dev',
        '```',
        '',
        '## Acceptance',
        '- Responsive layout verified at mobile/tablet/desktop widths.',
        '- All sections render without console errors.',
        '- README documents structure and run steps.',
        '',
        `Context: ${description}`,
      ].join('\n'),
    },
    {
      path: '/src/App.tsx',
      content: [
        'export default function App() {',
        '  return (',
        '    <main className="page">',
        '      <header className="hero">',
        `        <h1>${description.slice(0, 60) || 'Agent Treasury'}</h1>`,
        '        <p>Escrow-backed agent marketplace</p>',
        '        <button>Get started</button>',
        '      </header>',
        '      <section className="features">',
        '        <article>Hire agents</article>',
        '        <article>Escrow payment</article>',
        '        <article>Verified delivery</article>',
        '      </section>',
        '    </main>',
        '  );',
        '}',
      ].join('\n'),
    },
    {
      path: '/preview.html',
      content: [
        '<!doctype html><html><head><meta charset="utf-8"><title>Preview</title></head>',
        '<body style="font-family:system-ui;max-width:720px;margin:40px auto">',
        '<h1>Landing Page Preview</h1>',
        `<p>${description.slice(0, 140)}</p>`,
        '<p><em>Static preview generated by the demo execution simulator.</em></p>',
        '</body></html>',
      ].join('\n'),
    },
  ];
}

function backendFiles(description: string): GeneratedFile[] {
  return [
    {
      path: '/openapi.yaml',
      content: [
        'openapi: 3.0.3',
        'info:',
        '  title: Agent Jobs API',
        `  description: ${description.slice(0, 100)}`,
        '  version: 1.0.0',
        'paths:',
        '  /jobs:',
        '    get:',
        '      summary: List jobs',
        '      responses:',
        '        "200": { description: OK }',
        '  /jobs/{id}/submit:',
        '    post:',
        '      summary: Submit deliverable',
        '      parameters:',
        '        - { name: id, in: path, required: true, schema: { type: string } }',
        '      responses:',
        '        "200": { description: Submitted }',
        '  /escrow/{id}/release:',
        '    post:',
        '      summary: Release escrow after verification',
        '      responses:',
        '        "200": { description: Released }',
      ].join('\n'),
    },
    {
      path: '/src/server.ts',
      content: [
        '// Demo API server — Agent Jobs service',
        'const routes: Record<string, string> = {',
        "  'GET /jobs': 'listJobs',",
        "  'POST /jobs/:id/submit': 'submitDeliverable',",
        "  'POST /escrow/:id/release': 'releaseEscrow',",
        '};',
        '',
        'export function handle(method: string, path: string) {',
        '  const key = `${method} ${path}`;',
        '  const handler = routes[key];',
        '  if (!handler) return { status: 404, body: { error: "not found" } };',
        '  return { status: 200, body: { handler, job: process.env.JOB_ID } };',
        '}',
        '',
        `// Spec: ${description.slice(0, 120)}`,
      ].join('\n'),
    },
    {
      path: '/tests/report.md',
      content: [
        '# Test Report',
        '',
        `Scope: ${description.slice(0, 120)}`,
        '',
        '## Results',
        '- PASS GET /jobs returns 200 with job list',
        '- PASS POST /jobs/:id/submit accepts deliverable hash',
        '- PASS POST /escrow/:id/release rejects unverified release',
        '- PASS unknown route returns 404',
        '',
        '4/4 tests passed. Simulated suite — deterministic demo output.',
      ].join('\n'),
    },
  ];
}

function genericFiles(jobType: JobType, description: string): GeneratedFile[] {
  const label = jobType[0].toUpperCase() + jobType.slice(1);
  const path = PRIMARY_PATH[jobType];
  return [{
    path,
    content: [
      `# ${label} Deliverable`,
      '',
      `**Scope:** ${description}`,
      '',
      '## Summary',
      `Completed the ${jobType} assignment. This artifact was generated by the deterministic demo execution pipeline and registered with the job escrow.`,
      '',
      '## Details',
      '- Deliverable produced per the accepted job specification.',
      '- Content hash recorded on-chain at submission.',
      '- Verification performed by the deterministic evaluator.',
      '',
      '## Notes',
      'Demo execution — content is templated but the artifact, hash, and settlement are real.',
      '',
      `Context: ${description}`,
    ].join('\n'),
  }];
}

/** Generate all deliverable files for a job type. */
export function generateJobFiles(jobType: JobType, description: string): GeneratedFile[] {
  switch (jobType) {
    case 'research': return researchFiles(description);
    case 'frontend': return frontendFiles(description);
    case 'backend': return backendFiles(description);
    default: return genericFiles(jobType, description);
  }
}
