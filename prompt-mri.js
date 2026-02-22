/**
 * prompt-mri.js  v0.2.1
 * ─────────────────────────────────────────────────────────────────
 * Phase 1 implementation.
 *
 * STATE FLOW:
 *   IDLE → SCANNING → CONFIRMING → [CLARIFYING → SCANNING → CONFIRMING]*
 *                                → FINALIZING → DONE
 *
 * Keys loaded from keys.js → window.__PROMPT_MRI_KEYS__
 * No backend. No frameworks. Vanilla JS only.
 * ─────────────────────────────────────────────────────────────────
 */

'use strict';

// ─── Key loading ─────────────────────────────────────────────────
// Keys come from keys.js (sibling file), not hardcoded here.

const KEYS = window.__PROMPT_MRI_KEYS__;

if (!KEYS || !KEYS.gemini || KEYS.gemini === 'YOUR_GEMINI_KEY_HERE') {
  // Show fatal error — can't proceed without keys
  document.addEventListener('DOMContentLoaded', () => {
    showError(
      'Open keys.js and add your Gemini API key, then reload.'
    );
    const btn = document.getElementById('analyze-btn');
    if (btn) btn.disabled = true;
  });
}

// ─── Config ──────────────────────────────────────────────────────

const MODELS = [
  'gemini-3-flash-preview',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-1.5-pro'
];

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// ─── State machine ───────────────────────────────────────────────
// Single source of truth. Never read DOM to determine state.

const STATE = {
  IDLE: 'IDLE',
  SCANNING: 'SCANNING',
  CONFIRMING: 'CONFIRMING',
  CLARIFYING: 'CLARIFYING',
  FINALIZING: 'FINALIZING',
  DONE: 'DONE',
};

let appState = {
  phase: STATE.IDLE,
  originalPrompt: '',          // user's first prompt, never mutated
  clarifications: [],          // array of strings, appended on each NO
  lastAnalysis: null,        // last parsed JSON analysis
};

// ─── System Prompt (MRI Analyzer) ────────────────────────────────
// Strict JSON schema. No prose. No markdown.
// Score is 0–100. Confidence on ambiguities/bias/hallucination is 0–100.

const SYSTEM_PROMPT_ANALYZER = `You are Prompt MRI — a diagnostic engine for AI prompts.

Analyze the given prompt and return ONLY valid JSON matching the schema below.
No prose. No markdown fences. No preamble. No explanation outside the JSON.

Scoring rules for "score" (0–100):
- Start at 100
- Deduct 10 per missing critical input
- Deduct 8 per high-confidence ambiguity
- Deduct 6 per implicit assumption
- Deduct 5 per undefined audience or output format
- Deduct 4 per bias signal
- Deduct 3 per hallucination risk zone
- Minimum score is 0

"one_liner": One sentence. What is this prompt actually asking for, in plain language.

"model_plan.steps": How the AI would attempt to fulfill this prompt, step by step.

For ambiguities, bias_signals, hallucination_risk_zones: "confidence" is 0–100 integer.

Return empty arrays when no findings exist. Do NOT fabricate findings.

Schema:
{
  "score": number,
  "one_liner": string,
  "prompt_intent": {
    "primary_goal": string,
    "secondary_goals": string[],
    "task_archetype": string
  },
  "model_plan": {
    "steps": string[],
    "expected_output_format": string
  },
  "prompt_mri": {
    "explicit_constraints": string[],
    "implicit_constraints": string[],
    "assumptions": string[],
    "missing_information": string[],
    "ambiguities": [
      { "item": string, "why_it_matters": string, "confidence": number }
    ],
    "bias_signals": [
      { "item": string, "why_it_matters": string, "confidence": number }
    ],
    "hallucination_risk_zones": [
      { "area": string, "why_model_might_invent": string, "mitigation": string, "confidence": number }
    ]
  },
  "improvements": {
    "top_3_changes": string[],
    "clarifying_questions": string[]
  }
}`;

// ─── System Prompt (Finalizer) ────────────────────────────────────
// Used in Step 5 for both optimize and collaborate modes.

function buildFinalizerPrompt(mode) {
  if (mode === 'optimize') {
    return `You are a prompt engineer. Rewrite the given prompt for maximum clarity, precision, and alignment.
Fix ambiguities. Make implicit constraints explicit. Define the audience and output format if missing.
Return ONLY a JSON object: { "final_prompt": string }
No explanation. No markdown. Just the JSON.`;
  }
  return `You are a prompt engineer. Combine the original prompt and all clarifications into one clean, complete final prompt.
The clarifications are authoritative — they override any conflicting intent in the original.
Return ONLY a JSON object: { "final_prompt": string }
No explanation. No markdown. Just the JSON.`;
}

// ─── DOM helpers ─────────────────────────────────────────────────

const $ = id => document.getElementById(id);

function el(tag, cls, ...children) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  for (const child of children) {
    if (child == null) continue;
    if (typeof child === 'string') node.append(document.createTextNode(child));
    else node.appendChild(child);
  }
  return node;
}

// ─── Char counter ─────────────────────────────────────────────────

document.getElementById('prompt-input').addEventListener('input', () => {
  const n = $('prompt-input').value.length;
  $('char-count').textContent = `${n.toLocaleString()} chars`;
});

// ─── API: Gemini ───────────────────────────────────────────────

async function callGemini(systemPrompt, userMessage, retries = 2, delay = 1000) {
  // Try each model in order
  for (const model of MODELS) {
    const url = `${BASE_URL}/${model}:generateContent?key=${KEYS.gemini}`;

    // For each model, try specified number of retries
    for (let i = 0; i < retries; i++) {
      try {
        console.log(`Attempting Gemini with model: ${model} (Try ${i + 1})`);
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [{ text: `${systemPrompt}\n\n${userMessage}` }]
            }],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 3000,
            },
          }),
        });

        if (res.status === 429 || res.status === 503) {
          // Rate limited or busy
          if (i < retries - 1) {
            console.warn(`Gemini busy/limited (HTTP ${res.status}). Retrying ${model} in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          } else {
            // Out of retries for THIS model, fall back to NEXT model
            console.warn(`Model ${model} failed after retries. Moving to next fallback.`);
            break;
          }
        }

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          const msg = err?.error?.message || `HTTP ${res.status}`;
          // If it's a fatal error (like model not found), fall back immediately
          console.error(`Model ${model} error: ${msg}. Trying next fallback.`);
          break;
        }

        const data = await res.json();
        const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        return parseJSON(raw);

      } catch (err) {
        console.warn(`Connection error on ${model}: ${err.message}.`);
        if (i < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        break; // Next model
      }
    }
  }

  throw new Error('All Gemini models failed or reached rate limits. Please try again in 10-15 seconds.');
}

// ─── JSON parser (strips fences) ─────────────────────────────────

function parseJSON(raw) {
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    throw new Error('Model returned unparseable output. Try again.');
  }
}

// ─── Build analysis message ───────────────────────────────────────
// Combines original prompt + any clarifications into one message.

function buildAnalysisMessage() {
  let msg = `Analyze this prompt:\n\n${appState.originalPrompt}`;
  if (appState.clarifications.length > 0) {
    msg += '\n\n--- USER CLARIFICATIONS (treat as authoritative) ---\n';
    appState.clarifications.forEach((c, i) => {
      msg += `\nClarification ${i + 1}: ${c}`;
    });
  }
  return msg;
}

// ─── STEP 1 → 2: Run initial scan ────────────────────────────────

async function runAnalysis() {
  const promptText = $('prompt-input').value.trim();
  if (!promptText) { showError('Paste a prompt to analyze.'); return; }
  if (promptText.length < 6) { showError('Prompt too short to diagnose.'); return; }

  appState.originalPrompt = promptText;
  appState.clarifications = [];
  appState.lastAnalysis = null;

  await executeScan();
}

// ─── STEP 4 → 2 (re-scan): Run scan with clarification ───────────

async function runReScan() {
  const clarText = $('clarify-input').value.trim();
  if (!clarText) { showError('Write a clarification before re-scanning.'); return; }

  appState.clarifications.push(clarText);
  $('clarify-input').value = '';

  await executeScan();
}

// ─── Core scan (shared by initial + re-scan) ─────────────────────

async function executeScan() {
  setLoading(true, 'scanning prompt structure');
  clearError();
  hideAll();

  try {
    const message = buildAnalysisMessage();
    const analysis = await callGemini(SYSTEM_PROMPT_ANALYZER, message);

    appState.lastAnalysis = analysis;
    appState.phase = STATE.CONFIRMING;

    renderResults(analysis);
    renderConfirmStep(analysis);

  } catch (err) {
    showError(err.message);
    appState.phase = STATE.IDLE;
    showSection('step-input');
  } finally {
    setLoading(false);
  }
}

// ─── STEP 3: YES handler ──────────────────────────────────────────

function onConfirmYes() {
  appState.phase = STATE.FINALIZING;
  hideSection('step-confirm');
  showSection('step-final');
}

// ─── STEP 3: NO handler ──────────────────────────────────────────

function onConfirmNo() {
  appState.phase = STATE.CLARIFYING;
  hideSection('step-confirm');
  showSection('step-clarify');
}

// ─── STEP 5: Finalize ─────────────────────────────────────────────

async function runFinalize(mode) {
  // Disable both buttons while working
  document.querySelectorAll('.final-opt-btn').forEach(b => b.disabled = true);
  setLoading(true, mode === 'optimize' ? 'optimizing prompt' : 'generating collaborated prompt');
  clearError();

  try {
    const systemPrompt = buildFinalizerPrompt(mode);

    let userMessage = `Original prompt:\n${appState.originalPrompt}`;
    if (appState.clarifications.length > 0) {
      userMessage += '\n\nUser clarifications (authoritative):\n';
      appState.clarifications.forEach((c, i) => {
        userMessage += `${i + 1}. ${c}\n`;
      });
    }

    const result = await callGemini(systemPrompt, userMessage);

    appState.phase = STATE.DONE;
    renderFinalPrompt(result.final_prompt ?? '(No output generated)');

  } catch (err) {
    showError(err.message);
    document.querySelectorAll('.final-opt-btn').forEach(b => b.disabled = false);
  } finally {
    setLoading(false);
  }
}

// ─── Section visibility helpers ──────────────────────────────────

function showSection(id) { $(id).style.display = 'block'; }
function hideSection(id) { $(id).style.display = 'none'; }

function hideAll() {
  ['results', 'step-confirm', 'step-clarify', 'step-final', 'final-output'].forEach(hideSection);
}

// ─── Loading / error state ────────────────────────────────────────

function setLoading(on, label = 'scanning') {
  $('loading').style.display = on ? 'block' : 'none';
  $('analyze-btn').disabled = on;
  if ($('re-scan-btn')) $('re-scan-btn').disabled = on;
  if (label) $('load-label').textContent = label;
}

function clearError() {
  $('error-msg').style.display = 'none';
  $('error-msg').textContent = '';
}

function showError(msg) {
  $('error-msg').textContent = `⚠  ${msg}`;
  $('error-msg').style.display = 'block';
}

// ─── RENDER: Results (Step 2) ─────────────────────────────────────

const HEALTH_COLORS = {
  poor: '#ff3131',
  weak: '#ff7a00',
  fair: '#f5c542',
  good: '#7bff57',
  strong: '#c8ff00',
};

function scoreToHealth(score) {
  if (score >= 80) return 'strong';
  if (score >= 65) return 'good';
  if (score >= 45) return 'fair';
  if (score >= 25) return 'weak';
  return 'poor';
}

function scoreToColor(score) {
  return HEALTH_COLORS[scoreToHealth(score)] ?? '#555';
}

function renderResults(a) {
  const root = $('results');
  root.innerHTML = '';

  const score = typeof a.score === 'number' ? Math.max(0, Math.min(100, a.score)) : 50;
  const health = scoreToHealth(score);
  const color = scoreToColor(score);
  const mri = a.prompt_mri ?? {};

  root.append(
    el('div', 'results-label', 'DIAGNOSIS REPORT'),
    renderScoreBanner(score, color, health, a),
    renderMetaGrid(a),
    el('div', 'results-label', 'MODEL PLAN'),
    renderModelPlan(a.model_plan ?? {}),
    el('div', 'results-label', 'FINDINGS'),
    renderFindingsGrid(mri),
    el('div', 'results-label', 'RECOMMENDATIONS'),
    renderImprovements(a.improvements ?? {}),
    renderDisclaimer(),
  );

  showSection('results');
}

// ── Score banner with circular donut ──

function renderScoreBanner(score, color, health, a) {
  const wrap = el('div', 'health-wrap');
  wrap.style.borderColor = color + '44';

  // Circular donut score
  const donutCol = el('div', 'score-donut-col');
  const donutLabel = el('div', 'score-donut-label', 'MRI Score');
  donutCol.append(donutLabel, buildDonut(score, color));

  // Health word
  const scoreCol = el('div', 'health-score-col');
  const tiny = el('div', 'h-tiny', 'Prompt Health');
  const word = el('div', 'h-word', health.toUpperCase());
  word.style.color = color;
  scoreCol.append(tiny, word);

  // Detail / one-liner
  const detailCol = el('div', 'health-detail-col');
  const oneLiner = el('div', 'h-rationale', a.one_liner ?? '');
  detailCol.append(oneLiner);

  wrap.append(donutCol, scoreCol, detailCol);
  return wrap;
}

/**
 * Build an animated SVG donut meter.
 * r=40, circumference = 2π×40 ≈ 251.3
 * dashoffset = circumference × (1 - score/100)
 */
function buildDonut(score, color) {
  const size = 100;
  const r = 38;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;   // ≈ 238.76
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const offset = circ * (1 - pct);

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('width', '90');
  svg.setAttribute('height', '90');
  svg.classList.add('donut-svg');

  // Track circle
  const track = document.createElementNS(ns, 'circle');
  track.setAttribute('cx', cx);
  track.setAttribute('cy', cy);
  track.setAttribute('r', r);
  track.setAttribute('stroke-width', '7');
  track.classList.add('donut-track');

  // Fill circle — rotated so it starts at 12 o'clock
  const fill = document.createElementNS(ns, 'circle');
  fill.setAttribute('cx', cx);
  fill.setAttribute('cy', cy);
  fill.setAttribute('r', r);
  fill.setAttribute('stroke-width', '7');
  fill.setAttribute('stroke', color);
  fill.setAttribute('stroke-dasharray', circ);
  fill.setAttribute('stroke-dashoffset', circ);  // start at 0, animate to target
  fill.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);
  fill.classList.add('donut-fill');

  // Number label
  const text = document.createElementNS(ns, 'text');
  text.setAttribute('x', cx);
  text.setAttribute('y', cy);
  text.classList.add('donut-number');
  text.textContent = score;

  svg.append(track, fill, text);

  // Animate after paint
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      fill.style.transition = 'stroke-dashoffset 0.9s cubic-bezier(0.4,0,0.2,1), stroke 0.4s';
      fill.setAttribute('stroke-dashoffset', offset);
    });
  });

  return svg;
}

// ── Meta grid (intent) ──

function renderMetaGrid(a) {
  const intent = a.prompt_intent ?? {};
  const grid = el('div', 'meta-2col');

  const goalCard = el('div', 'mcard');
  goalCard.append(
    el('div', 'mcard-label', 'Primary Goal'),
    el('div', 'mcard-value', intent.primary_goal ?? '—'),
  );

  const arcCard = el('div', 'mcard');
  arcCard.append(
    el('div', 'mcard-label', 'Task Archetype'),
    el('div', 'mcard-value arch', intent.task_archetype ?? '—'),
  );

  grid.append(goalCard, arcCard);

  // Secondary goals — only if present
  const secondary = intent.secondary_goals ?? [];
  if (secondary.length > 0) {
    const secCard = el('div', 'mcard');
    secCard.style.gridColumn = '1 / -1';
    secCard.append(
      el('div', 'mcard-label', 'Secondary Goals'),
      el('div', 'mcard-value', secondary.join(' · ')),
    );
    grid.appendChild(secCard);
  }

  return grid;
}

// ── Model plan ──

function renderModelPlan(plan) {
  const block = el('div', 'sblock');
  block.style.borderTopColor = '#333';

  const head = el('div', 'sblock-head');
  const title = el('div', 'sblock-title');
  title.style.color = '#aaa';
  title.textContent = 'How the AI would attempt this task';
  head.appendChild(title);
  block.appendChild(head);

  const steps = plan.steps ?? [];
  if (steps.length === 0) {
    block.appendChild(el('div', 'fempty', 'no model plan generated'));
  } else {
    steps.forEach((step, i) => {
      const item = el('div', 'sitem');
      const num = el('span', 'spri low', String(i + 1));
      const text = el('div', 'stext', step);
      text.style.marginBottom = '0';
      const content = el('div', 'scontent');
      content.appendChild(text);
      item.append(num, content);
      block.appendChild(item);
    });
  }

  if (plan.expected_output_format) {
    const fmt = el('div', 'sitem');
    const tag = el('span', 'spri low', 'fmt');
    const text = el('div', 'scontent');
    const t = el('div', 'srationale', `Expected output: ${plan.expected_output_format}`);
    text.appendChild(t);
    fmt.append(tag, text);
    block.appendChild(fmt);
  }

  return block;
}

// ── Findings grid ──

function renderFindingsGrid(mri) {
  const grid = el('div', 'findings-2col');

  // Simple string-array findings
  const simpleSections = [
    { key: 'explicit_constraints', label: 'Explicit Constraints', color: '#3ddc84' },
    { key: 'implicit_constraints', label: 'Implicit Constraints', color: '#f5c542' },
    { key: 'assumptions', label: 'Assumptions', color: '#ff9900' },
    { key: 'missing_information', label: 'Missing Information', color: '#7c6aff' },
  ];

  for (const { key, label, color } of simpleSections) {
    const items = mri[key] ?? [];
    grid.appendChild(renderSimpleCard(label, color, items));
  }

  // Complex findings with confidence
  grid.appendChild(renderConfidenceCard('Ambiguities', '#ff9900', mri.ambiguities ?? []));
  grid.appendChild(renderConfidenceCard('Bias Signals', '#ff3131', mri.bias_signals ?? []));

  // Hallucination risks — full width
  const hallCard = renderHallucinationCard(mri.hallucination_risk_zones ?? []);
  hallCard.style.gridColumn = '1 / -1';
  grid.appendChild(hallCard);

  return grid;
}

function renderSimpleCard(label, color, items) {
  const card = el('div', 'fcard');
  const head = el('div', 'fcard-head');
  const title = el('div', 'fcard-title');
  const stripe = el('span', 'fcard-stripe');
  stripe.style.background = color;
  title.append(stripe, document.createTextNode(label));
  const count = el('span', 'fcount', String(items.length));
  head.append(title, count);
  card.appendChild(head);

  if (items.length === 0) {
    card.appendChild(el('div', 'fempty', 'no findings'));
  } else {
    items.forEach(text => {
      const item = el('div', 'fitem');
      item.appendChild(el('div', 'ftext', text));
      card.appendChild(item);
    });
  }
  return card;
}

function renderConfidenceCard(label, color, items) {
  const card = el('div', 'fcard');
  const head = el('div', 'fcard-head');
  const title = el('div', 'fcard-title');
  const stripe = el('span', 'fcard-stripe');
  stripe.style.background = color;
  title.append(stripe, document.createTextNode(label));
  const count = el('span', 'fcount', String(items.length));
  head.append(title, count);
  card.appendChild(head);

  if (items.length === 0) {
    card.appendChild(el('div', 'fempty', 'no findings'));
  } else {
    items.forEach(f => {
      const item = el('div', 'fitem');
      const wrap = el('div', 'ftext');
      const main = el('div', '', f.item ?? '');
      main.style.marginBottom = '3px';
      const why = el('div', 'srationale', f.why_it_matters ?? '');
      wrap.append(main, why);

      // Confidence is 0-100 integer
      const conf = f.confidence ?? 0;
      const tier = conf >= 70 ? 'conf-hi' : conf >= 40 ? 'conf-mid' : 'conf-lo';
      const tag = el('span', `ctag ${tier}`, `${conf}%`);

      item.append(wrap, tag);
      card.appendChild(item);
    });
  }
  return card;
}

function renderHallucinationCard(zones) {
  const card = el('div', 'fcard');

  const head = el('div', 'fcard-head');
  const title = el('div', 'fcard-title');
  const stripe = el('span', 'fcard-stripe');
  stripe.style.background = '#ff3131';
  title.append(stripe, document.createTextNode('Hallucination Risk Zones'));
  const count = el('span', 'fcount', String(zones.length));
  head.append(title, count);
  card.appendChild(head);

  if (zones.length === 0) {
    card.appendChild(el('div', 'fempty', 'no hallucination risks detected'));
  } else {
    zones.forEach(z => {
      const item = el('div', 'sitem');
      const conf = z.confidence ?? 0;
      const tier = conf >= 70 ? 'conf-hi' : conf >= 40 ? 'conf-mid' : 'conf-lo';
      const tag = el('span', `spri low ctag ${tier}`, `${conf}%`);
      tag.style.marginTop = '0';

      const content = el('div', 'scontent');
      const area = el('div', 'stext', z.area ?? '');
      const why = el('div', 'srationale', z.why_model_might_invent ?? '');
      const mit = el('div', 'srationale');
      mit.style.color = '#3ddc84';
      mit.style.marginTop = '2px';
      mit.textContent = `↳ ${z.mitigation ?? ''}`;
      content.append(area, why, mit);
      item.append(tag, content);
      card.appendChild(item);
    });
  }

  return card;
}

// ── Improvements ──

function renderImprovements(improvements) {
  const block = el('div', 'sblock');

  const head = el('div', 'sblock-head');
  const title = el('div', 'sblock-title', 'Top Changes');
  head.appendChild(title);
  block.appendChild(head);

  const changes = improvements.top_3_changes ?? [];
  if (changes.length === 0) {
    block.appendChild(el('div', 'fempty', 'no improvements suggested'));
  } else {
    changes.forEach((c, i) => {
      const item = el('div', 'sitem');
      const pri = el('span', 'spri high', String(i + 1));
      const content = el('div', 'scontent');
      content.appendChild(el('div', 'stext', c));
      item.append(pri, content);
      block.appendChild(item);
    });
  }

  const questions = improvements.clarifying_questions ?? [];
  if (questions.length > 0) {
    const qhead = el('div', 'sblock-head');
    qhead.style.borderTop = '1px solid #1a1a1a';
    const qtitle = el('div', 'sblock-title');
    qtitle.style.color = '#aaa';
    qtitle.textContent = 'Clarifying Questions';
    qhead.appendChild(qtitle);
    block.appendChild(qhead);

    questions.forEach(q => {
      const item = el('div', 'sitem');
      const tag = el('span', 'spri low', '?');
      const content = el('div', 'scontent');
      content.appendChild(el('div', 'srationale', q));
      item.append(tag, content);
      block.appendChild(item);
    });
  }

  return block;
}

function renderDisclaimer() {
  const d = el('div', 'disclaimer');
  d.innerHTML = '<b>findings are hypotheses, not verdicts.</b> confidence values are model-reported. bias and hallucination detection are probabilistic. treat all findings as prompts for human review.';
  return d;
}

// ─── RENDER: Step 3 (confirm) ─────────────────────────────────────

function renderConfirmStep(a) {
  // Build a 1-2 line natural language summary of what the model thinks it's doing
  const intent = a.prompt_intent ?? {};
  const plan = a.model_plan ?? {};

  let summary = intent.primary_goal ?? a.one_liner ?? 'Unable to determine intent.';
  if (plan.expected_output_format) {
    summary += ` The model would return a ${plan.expected_output_format.toLowerCase()}.`;
  }

  $('understanding-text').textContent = summary;
  showSection('step-confirm');
}

// ─── RENDER: Step 5 final prompt ─────────────────────────────────

function renderFinalPrompt(text) {
  $('final-prompt-text').textContent = text;
  showSection('final-output');
  $('final-output').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function switchMode(mode) {
  const p1Main = document.getElementById('phase1-main');
  const p2Main = document.getElementById('phase2');
  const btnP1 = document.getElementById('toggle-p1');
  const btnP2 = document.getElementById('toggle-p2');

  if (mode === 'p1') {
    p1Main.style.display = 'block';
    p2Main.style.display = 'none';
    btnP1.className = 'toggle-btn active-p1';
    btnP2.className = 'toggle-btn';
  } else {
    p1Main.style.display = 'none';
    p2Main.style.display = 'block';
    btnP1.className = 'toggle-btn';
    btnP2.className = 'toggle-btn active-p2';
  }
}

// ═══════════════════════════════════════════════════════════════════
// PHASE 2 — HALLUCINATION RISK ANALYZER
// ═══════════════════════════════════════════════════════════════════

const P2_SYSTEM_PROMPT = `You are a structural hallucination risk detector for AI-generated text.

CRITICAL SCOPE LIMITATION:
You do NOT verify facts. You do NOT check whether claims are true or false.
You ONLY detect structural and linguistic patterns statistically associated with AI confabulation.

WHAT YOU DETECT:
- Unsupported specificity: precise numbers, dates, statistics with no attribution
- Fabricated specificity: overly precise details that feel invented
- Fake citation patterns: references that look like citations but are structurally suspicious
- Overconfidence markers: definitive claims with no hedging where hedging would be expected
- Logical inconsistencies: statements that contradict each other

SCORING RULES for risk_score (0-100). Start at 0. Add:
+12 per specific statistic with no source
+10 per named expert or study with no citation
+8 per definitive claim in a domain known for AI confabulation
+7 per fake-looking citation
+6 per logical inconsistency
+5 per overconfidence marker
-5 per clear uncertainty marker
-4 per acknowledged limitation
-3 per conditional language

RULES:
- Return empty arrays when no signals found. Do NOT fabricate.
- confidence per finding is 0-100 integer.
- text must be a short verbatim excerpt under 20 words.
- Return ONLY valid JSON. No prose. No markdown fences.

Schema:
{
  "risk_score": number,
  "risk_summary": string,
  "hallucination_signals": {
    "unsupported_claims": [{ "text": string, "reason": string, "confidence": number }],
    "fabricated_specificity": [{ "text": string, "reason": string, "confidence": number }],
    "fake_citation_patterns": [{ "text": string, "reason": string, "confidence": number }],
    "overconfidence_markers": [{ "text": string, "reason": string, "confidence": number }],
    "logical_inconsistencies": [{ "text": string, "reason": string, "confidence": number }]
  },
  "verification_suggestions": string[]
}`;

const p2State = { running: false };
const p2$ = id => document.getElementById(id);

function p2SetLoading(on, label = 'analyzing response structure') {
  p2$('p2-loading').style.display = on ? 'block' : 'none';
  p2$('p2-analyze-btn').disabled = on;
  p2$('p2-load-label').textContent = label;
  p2State.running = on;
}

function p2ClearError() {
  p2$('p2-error-msg').style.display = 'none';
  p2$('p2-error-msg').textContent = '';
}

function p2ShowError(msg) {
  p2$('p2-error-msg').textContent = `⚠  ${msg}`;
  p2$('p2-error-msg').style.display = 'block';
}

function p2ClearResults() {
  p2$('p2-results').style.display = 'none';
  p2$('p2-results').innerHTML = '';
}

async function p2RunAnalysis() {
  const responseText = p2$('response-input').value.trim();
  if (!responseText) { p2ShowError('Paste an AI response to analyze.'); return; }
  if (responseText.length < 20) { p2ShowError('Response too short to analyze meaningfully.'); return; }
  if (p2State.running) { return; }

  p2SetLoading(true);
  p2ClearError();
  p2ClearResults();

  try {
    const analysis = await callGemini(P2_SYSTEM_PROMPT, `Analyze this AI-generated response for hallucination risk:\n\n${responseText}`);
    p2RenderResults(analysis);
  } catch (err) {
    p2ShowError(err.message);
  } finally {
    p2SetLoading(false);
  }
}

function riskColor(score) {
  if (score >= 75) return '#ff3131';
  if (score >= 55) return '#ff7a00';
  if (score >= 35) return '#f5c542';
  if (score >= 15) return '#7bff57';
  return '#c8ff00';
}

function riskLabel(score) {
  if (score >= 75) return 'CRITICAL';
  if (score >= 55) return 'HIGH';
  if (score >= 35) return 'MODERATE';
  if (score >= 15) return 'LOW';
  return 'MINIMAL';
}

function p2RenderResults(a) {
  const root = p2$('p2-results');
  root.innerHTML = '';
  const score = Math.max(0, Math.min(100, a.risk_score ?? 0));
  const color = riskColor(score);
  const label = riskLabel(score);
  const sigs = a.hallucination_signals ?? {};

  root.append(
    el('div', 'results-label', 'HALLUCINATION RISK REPORT'),
    p2RenderRiskBanner(score, color, label, a.risk_summary ?? ''),
    el('div', 'results-label', 'SIGNALS DETECTED'),
    p2RenderSignalsGrid(sigs),
    el('div', 'results-label', 'VERIFICATION SUGGESTIONS'),
    p2RenderVerificationSuggestions(a.verification_suggestions ?? []),
    p2RenderFooterDisclaimer(),
  );

  p2$('p2-results').style.display = 'block';
  root.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function p2RenderRiskBanner(score, color, label, summary) {
  const wrap = el('div', 'risk-banner');
  wrap.style.borderColor = color + '44';

  const donutCol = el('div', 'score-donut-col');
  donutCol.append(el('div', 'score-donut-label', 'Risk Score'), buildDonut(score, color));

  const riskCol = el('div', 'health-score-col');
  const tiny = el('div', 'h-tiny', 'Risk Level');
  const word = el('div', 'h-word', label);
  word.style.color = color;
  riskCol.append(tiny, word);

  const detailCol = el('div', 'health-detail-col');
  detailCol.append(el('div', 'h-rationale', summary));

  wrap.append(donutCol, riskCol, detailCol);
  return wrap;
}

function p2RenderSignalsGrid(sigs) {
  const grid = el('div', 'findings-2col');
  const categories = [
    { key: 'unsupported_claims', label: 'Unsupported Claims', color: '#ff3131' },
    { key: 'fabricated_specificity', label: 'Fabricated Specificity', color: '#ff7a00' },
    { key: 'fake_citation_patterns', label: 'Fake Citation Patterns', color: '#f5c542' },
    { key: 'overconfidence_markers', label: 'Overconfidence Markers', color: '#7c6aff' },
    { key: 'logical_inconsistencies', label: 'Logical Inconsistencies', color: '#00bbff' },
  ];
  for (const { key, label, color } of categories) {
    grid.appendChild(p2RenderSignalCard(label, color, sigs[key] ?? []));
  }
  return grid;
}

function p2RenderSignalCard(label, color, items) {
  const card = el('div', 'fcard');
  const head = el('div', 'fcard-head');
  const title = el('div', 'fcard-title');
  const stripe = el('span', 'fcard-stripe');
  stripe.style.background = color;
  title.append(stripe, document.createTextNode(label));
  head.append(title, el('span', 'fcount', String(items.length)));
  card.appendChild(head);

  if (items.length === 0) {
    card.appendChild(el('div', 'fempty', 'no signals detected'));
  } else {
    items.forEach(s => {
      const item = el('div', 'fitem');
      const wrap = el('div', 'ftext');
      const excerpt = el('div', '');
      excerpt.style.cssText = 'font-family:IBM Plex Mono,monospace;font-size:11px;color:#888;margin-bottom:4px;font-style:italic;';
      excerpt.textContent = `"${s.text ?? ''}"`;
      wrap.append(excerpt, el('div', 'srationale', s.reason ?? ''));
      const conf = s.confidence ?? 0;
      const tier = conf >= 70 ? 'conf-hi' : conf >= 40 ? 'conf-mid' : 'conf-lo';
      item.append(wrap, el('span', `ctag ${tier}`, `${conf}%`));
      card.appendChild(item);
    });
  }
  return card;
}

function p2RenderVerificationSuggestions(suggestions) {
  const block = el('div', 'vsug-block');
  const head = el('div', 'vsug-head');
  head.append(el('div', 'vsug-title', 'How to Verify'), el('span', 'fcount', String(suggestions.length)));
  block.appendChild(head);

  if (suggestions.length === 0) {
    block.appendChild(el('div', 'fempty', 'no verification suggestions'));
  } else {
    suggestions.forEach((s, i) => {
      const item = el('div', 'sitem');
      const content = el('div', 'scontent');
      content.appendChild(el('div', 'srationale', s));
      item.append(el('span', 'spri low', String(i + 1)), content);
      block.appendChild(item);
    });
  }
  return block;
}

function p2RenderFooterDisclaimer() {
  const d = el('div', 'disclaimer');
  d.innerHTML = '<b>structural analysis only — not fact-checking.</b> a low risk score does not mean the response is accurate. a high risk score does not mean it is wrong. always verify important claims with primary sources.';
  return d;
}

// Wire Phase 2 listeners — script is at bottom of <body>, DOM is already parsed
document.getElementById('p2-analyze-btn').addEventListener('click', () => p2RunAnalysis());
document.getElementById('response-input').addEventListener('input', () => {
  const n = document.getElementById('response-input').value.length;
  document.getElementById('p2-char-count').textContent = `${n.toLocaleString()} chars`;
});
