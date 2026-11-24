/**
 * Banco de pruebas de modelos para el asistente: compara servidores/modelos (vLLM con Qwen, Ollama con gemma4…) con los
 * prompts, herramientas y esquemas **reales** del servicio. No reimplementa nada: usa el `Agent` y el `ProjectAssistant` de
 * `src/` con repositorios en memoria y una API del CRM de mentira (ver `cases.ts`). Lo único real es el modelo.
 *
 * Uso (desde backend/assistant-service):
 *
 *   npm run bench:llm -- \
 *     --target qwen=http://192.168.100.X:8000/v1,crm-assistant,vllm \
 *     --target gemma=http://192.168.100.127:11434/v1,gemma4:12b,ollama \
 *     --repeat 3
 *
 *   --target nombre=URL,modelo,servidor[,razonamiento]
 *                     servidor: vllm | ollama (OPENAI_COMPAT_SERVER). razonamiento del chat: none | low | medium | high
 *                     (OPENAI_COMPAT_CHAT_REASONING); sin él, el modelo decide. El mismo modelo con y sin razonamiento
 *                     son dos targets.
 *                                         También por entorno: BENCH_TARGETS="nombre=URL,modelo,servidor;otro=…".
 *   --repeat N        Vueltas por caso (por defecto 3). Un modelo local no es determinista del todo ni con temperature 0.
 *   --only a,b        Solo esos casos (ids de cases.ts).
 *   --timeout ms      Tope por llamada al modelo (por defecto 180000).
 *   --api-key clave   Si el servidor la pide (vLLM con --api-key).
 *   --no-unload       No vaciar la GPU antes de cada modelo de Ollama. Por defecto se vacía: descarga TODO lo que ese Ollama
 *                     tenga cargado, también lo que esté usando otra cosa en esa máquina.
 *
 * Ollama: usa un modelo con `num_ctx` acotado (Modelfile con `PARAMETER num_ctx 8192`). Algunos traen 262.144 de contexto
 * por defecto y no caben en 12 GB: el informe marca cuánto quedó en CPU.
 *
 * Corre todo en serie a propósito: así la latencia es la de una persona sola, sin colas. La concurrencia es otra medida.
 * Deja el informe en bench/results/ (Markdown para leer, JSON con todo), fuera de git.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Agent, TurnResult } from '../src/application/agent';
import { ProjectAssistant } from '../src/application/project-ai';
import { LlmMessage, LlmPort, LlmTurn, StructuredLlmPort } from '../src/application/ports';
import { ChatReasoning, OpenAiCompatibleLlm, OpenAiCompatibleServer } from '../src/infrastructure/openai/compatible-llm';
import { createInMemoryRepositories } from '../src/__tests__/helpers';
import { BenchCase, CASES, Check, FixtureCrm, TODAY } from './cases';

interface Target {
  name: string;
  baseURL: string;
  model: string;
  server: OpenAiCompatibleServer;
  /** Como OPENAI_COMPAT_CHAT_REASONING. Sin poner, el modelo decide. */
  chatReasoning?: ChatReasoning;
}

interface LlmCall {
  kind: 'chat' | 'json';
  ms: number;
  inputTokens: number;
  outputTokens: number;
  failed: boolean;
}

interface Run {
  target: string;
  caseId: string;
  round: number;
  ms: number;
  checks: Check[];
  calls: LlmCall[];
  output: string;
  error: string | null;
}

/** El adaptador real, cronometrado. Lo que se mide es exactamente lo que el servicio haría en producción. */
class TimedLlm implements LlmPort, StructuredLlmPort {
  readonly calls: LlmCall[] = [];
  constructor(private readonly inner: OpenAiCompatibleLlm) {}

  async complete(params: {
    system: string;
    messages: LlmMessage[];
    tools: Array<{ name: string; description: string; input_schema: unknown }>;
  }): Promise<LlmTurn> {
    return this.time('chat', () => this.inner.complete(params), (r) => r.usage);
  }

  async generate(params: { system: string; prompt: string; schema: Record<string, unknown> }) {
    return this.time('json', () => this.inner.generate(params), (r) => r.usage);
  }

  private async time<T>(kind: LlmCall['kind'], fn: () => Promise<T>, usage: (r: T) => LlmTurn['usage']): Promise<T> {
    const start = performance.now();
    try {
      const result = await fn();
      const u = usage(result);
      this.calls.push({ kind, ms: performance.now() - start, inputTokens: u.inputTokens, outputTokens: u.outputTokens, failed: false });
      return result;
    } catch (error) {
      this.calls.push({ kind, ms: performance.now() - start, inputTokens: 0, outputTokens: 0, failed: true });
      throw error;
    }
  }
}

// ── Argumentos ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function parseTarget(spec: string): Target {
  const eq = spec.indexOf('=');
  const [baseURL, model, server = 'ollama', reasoning] = spec.slice(eq + 1).split(',').map((s) => s.trim());
  const niveles = ['none', 'low', 'medium', 'high'];
  if (eq < 1 || !baseURL || !model || (server !== 'vllm' && server !== 'ollama') || (reasoning && !niveles.includes(reasoning))) {
    throw new Error(`--target mal escrito: «${spec}». Forma: nombre=URL,modelo,vllm|ollama[,none|low|medium|high]`);
  }
  const t: Target = { name: spec.slice(0, eq).trim(), baseURL, model, server };
  if (reasoning) t.chatReasoning = reasoning as ChatReasoning;
  return t;
}

function parseArgs(argv: string[]) {
  const targets: Target[] = [];
  let repeat = 3;
  let only: string[] | null = null;
  let timeoutMs = 180_000;
  let apiKey: string | undefined = process.env.OPENAI_COMPAT_API_KEY || undefined;
  let unload = true;

  for (let i = 0; i < argv.length; i++) {
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Falta el valor de ${argv[i - 1]}`);
      return v;
    };
    switch (argv[i]) {
      case '--target': targets.push(parseTarget(value())); break;
      case '--repeat': repeat = Math.max(1, Number(value())); break;
      case '--only': only = value().split(',').map((s) => s.trim()); break;
      case '--timeout': timeoutMs = Number(value()); break;
      case '--api-key': apiKey = value(); break;
      case '--no-unload': unload = false; break;
      default: throw new Error(`Opción desconocida: ${argv[i]}`);
    }
  }
  for (const spec of (process.env.BENCH_TARGETS ?? '').split(';').filter((s) => s.trim())) targets.push(parseTarget(spec));
  if (targets.length === 0) throw new Error('Falta al menos un --target (o BENCH_TARGETS). Ver la cabecera de bench/llm-bench.ts.');

  const cases = only ? CASES.filter((c) => only!.includes(c.id)) : CASES;
  const unknown = (only ?? []).filter((id) => !CASES.some((c) => c.id === id));
  if (unknown.length) throw new Error(`Casos desconocidos: ${unknown.join(', ')}. Hay: ${CASES.map((c) => c.id).join(', ')}`);
  return { targets, repeat, cases, timeoutMs, apiKey, unload };
}

// ── Ejecución ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const ORG = 'org-bench';
const turnCtx = {
  organizationId: ORG,
  userId: 'user-bench',
  bearerToken: 'jwt-de-prueba',
  locale: 'es',
  organization: { organizationName: 'Comercial Quito Cía. Ltda.', countryCode: 'EC', userName: 'Ana', locale: 'es', today: TODAY },
};

async function runCase(target: Target, c: BenchCase, round: number, timeoutMs: number, apiKey: string | undefined): Promise<Run> {
  const llm = new TimedLlm(
    new OpenAiCompatibleLlm({
      baseURL: target.baseURL,
      apiKey,
      model: target.model,
      maxTokens: 4000,
      timeoutMs,
      server: target.server,
      chatReasoning: target.chatReasoning,
    }),
  );
  const crm = new FixtureCrm(c.routes);
  const repos = createInMemoryRepositories();
  const start = performance.now();
  let checks: Check[];
  let output = '';
  let error: string | null = null;

  try {
    if (c.kind === 'agent') {
      const agent = new Agent(repos, llm, crm, { maxIterations: 8, monthlyTokenLimit: 0 });
      const result: TurnResult = await agent.startOrContinue({ conversationId: null, text: c.message, ctx: turnCtx });
      output = [result.reply, ...result.pendingActions.map((a) => `[propone ${a.toolName}] ${JSON.stringify(a.input)}`)].join('\n');
      checks = [
        { name: 'cierra el turno (sin agotar vueltas)', ok: !result.truncated },
        // Tablas y gráficos solo si la persona los pide (prompt, 2026-11-24): en una respuesta normal no deben aparecer.
        // Ids internos fuera de los enlaces: no le dicen nada a la persona (prueba en producción, 2026-11-24).
        { name: 'sin ids internos a la vista', ok: !/(?<![/\w-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(result.reply) },
        ...(/tabla/i.test(c.message) ? [] : [{ name: 'sin tabla no pedida', ok: !/^\s*\|.*\|\s*$/m.test(result.reply) }]),
        ...(/gr[aá]f[ií]c/i.test(c.message) ? [] : [{ name: 'sin gráfico no pedido', ok: !/```\s*(grafico|gráfico|chart)/i.test(result.reply) }]),
        ...c.check(result, crm),
      ];
    } else {
      const projects = new ProjectAssistant(repos, llm, crm, { monthlyTokenLimit: 0 });
      const ctx = { organizationId: ORG, userId: 'user-bench', bearerToken: 'jwt-de-prueba', locale: 'es' };
      const data =
        c.action === 'summarize'
          ? await projects.summarizeTask(c.targetId, ctx)
          : c.action === 'status'
            ? await projects.draftStatus(c.targetId, ctx)
            : await projects.suggestSubtasks(c.targetId, ctx);
      output = JSON.stringify(data, null, 2);
      // Si llegó aquí, el JSON pasó el esquema zod del servicio: el mismo filtro que en producción.
      checks = [{ name: 'JSON válido según el esquema', ok: true }, ...c.check(data, crm)];
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    checks = [{ name: c.kind === 'project' ? 'JSON válido según el esquema' : 'responde sin error', ok: false, detail: error }];
  }

  return { target: target.name, caseId: c.id, round, ms: performance.now() - start, checks, calls: llm.calls, output, error };
}

// ── GPU (solo Ollama) ──────────────────────────────────────────────────────────────────────────────────────────────────
// Dos modelos en la misma GPU se pisan: si el anterior sigue cargado, el siguiente cae en parte a la CPU y mide la mitad de
// rápido. Pasó el 2026-11-24: un qwen3.5:9b con 262.144 de contexto ocupaba 16 GB y corría 45 % en CPU sin que nada avisara.
// Por eso, antes de cada modelo se vacía la GPU y, tras calentarlo, se apunta dónde quedó. vLLM no aplica: es un servidor
// por modelo y reserva su VRAM al arrancar.

interface Placement {
  gpuPct: number;
  sizeGb: number;
  context: number | null;
}

const ollamaRoot = (baseURL: string) => baseURL.replace(/\/+$/, '').replace(/\/v1$/, '');

async function ollamaPs(target: Target): Promise<Array<{ name: string; size: number; size_vram: number; context_length?: number }>> {
  const r = await fetch(`${ollamaRoot(target.baseURL)}/api/ps`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`/api/ps respondió ${r.status}`);
  return ((await r.json()) as { models?: [] }).models ?? [];
}

/** Descarga todo lo que Ollama tenga en memoria y espera a que /api/ps quede vacío (máx. 60 s). */
async function unloadAll(target: Target): Promise<string | null> {
  try {
    for (const m of await ollamaPs(target)) {
      await fetch(`${ollamaRoot(target.baseURL)}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: m.name, keep_alive: 0 }),
        signal: AbortSignal.timeout(30_000),
      });
    }
    const until = Date.now() + 60_000;
    while (Date.now() < until) {
      const left = await ollamaPs(target);
      if (left.length === 0) return null;
      await new Promise((ok) => setTimeout(ok, 1000));
    }
    return `siguen cargados: ${(await ollamaPs(target)).map((m) => m.name).join(', ')}`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function placement(target: Target): Promise<Placement | null> {
  try {
    const want = target.model.includes(':') ? target.model : `${target.model}:latest`;
    const m = (await ollamaPs(target)).find((x) => x.name === want || x.name === target.model);
    if (!m || !m.size) return null;
    return { gpuPct: Math.round((100 * m.size_vram) / m.size), sizeGb: m.size / 1e9, context: m.context_length ?? null };
  } catch {
    return null;
  }
}

/** Una llamada tonta antes de medir: con Ollama la primera carga del modelo tarda minutos y no es lo que se compara. */
async function warmUp(target: Target, timeoutMs: number, apiKey: string | undefined): Promise<string | null> {
  const llm = new OpenAiCompatibleLlm({ baseURL: target.baseURL, apiKey, model: target.model, maxTokens: 50, timeoutMs, server: target.server });
  try {
    await llm.generate({
      system: 'Responde solo con el JSON pedido.',
      prompt: 'Di hola.',
      schema: { type: 'object', additionalProperties: false, required: ['saludo'], properties: { saludo: { type: 'string' } } },
    });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// ── Informe ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const seg = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const pct = (a: number, b: number) => (b === 0 ? '—' : `${Math.round((100 * a) / b)} %`);
const passed = (r: Run) => r.checks.every((c) => c.ok);

function summarize(targets: Target[], cases: BenchCase[], runs: Run[]) {
  return targets.map((t) => {
    const mine = runs.filter((r) => r.target === t.name);
    const checks = mine.flatMap((r) => r.checks);
    const calls = mine.flatMap((r) => r.calls).filter((c) => !c.failed);
    const out = calls.reduce((n, c) => n + c.outputTokens, 0);
    const callMs = calls.reduce((n, c) => n + c.ms, 0);
    return {
      target: t,
      casesOk: mine.filter(passed).length,
      runs: mine.length,
      checksOk: checks.filter((c) => c.ok).length,
      checks: checks.length,
      errors: mine.filter((r) => r.error).length,
      medianCaseMs: median(mine.map((r) => r.ms)),
      medianCallMs: median(calls.map((c) => c.ms)),
      // Incluye el procesado del prompt: es la velocidad que nota la persona, no la de generación pura.
      tokPerSec: callMs > 0 ? (out / callMs) * 1000 : 0,
      llmCallsPerCase: mine.length ? mine.reduce((n, r) => n + r.calls.length, 0) / mine.length : 0,
      perCase: cases.map((c) => {
        const rs = mine.filter((r) => r.caseId === c.id);
        return { id: c.id, ok: rs.filter(passed).length, n: rs.length, ms: median(rs.map((r) => r.ms)) };
      }),
    };
  });
}

function markdown(
  targets: Target[],
  cases: BenchCase[],
  runs: Run[],
  repeat: number,
  warm: Record<string, string | null>,
  places: Record<string, Placement | null>,
): string {
  const s = summarize(targets, cases, runs);
  const out: string[] = [];
  out.push(`# Banco de pruebas del asistente — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, '');
  out.push(`${cases.length} casos × ${repeat} vueltas por modelo, en serie. Prompts, herramientas y esquemas reales de assistant-service.`, '');
  out.push('| Modelo | Servidor | En GPU | Casos perfectos | Comprobaciones | Errores | Mediana por caso | Mediana por llamada | tok/s (con prompt) | Llamadas/caso |');
  out.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const x of s) {
    const p = places[x.target.name];
    const gpu = p ? `${p.gpuPct} % de ${p.sizeGb.toFixed(1)} GB (ctx ${p.context ?? '?'})` : '—';
    out.push(
      `| ${x.target.name} (\`${x.target.model}\`) | ${x.target.server}, razonamiento chat: ${x.target.chatReasoning ?? 'el modelo decide'} | ${gpu} | ${x.casesOk}/${x.runs} (${pct(x.casesOk, x.runs)}) | ${x.checksOk}/${x.checks} (${pct(x.checksOk, x.checks)}) | ${x.errors} | ${seg(x.medianCaseMs)} | ${seg(x.medianCallMs)} | ${x.tokPerSec.toFixed(1)} | ${x.llmCallsPerCase.toFixed(1)} |`,
    );
  }
  const enCpu = Object.entries(places).filter(([, p]) => p && p.gpuPct < 100);
  if (enCpu.length) out.push('', ...enCpu.map(([n, p]) => `> ⚠️ **${n}** quedó ${100 - p!.gpuPct} % en CPU: sus tiempos no representan a la GPU.`));
  const frios = Object.entries(warm).filter(([, e]) => e);
  if (frios.length) out.push('', ...frios.map(([n, e]) => `> ⚠️ El calentamiento de **${n}** falló: ${e}`));

  out.push('', '## Por caso', '', `| Caso | ${targets.map((t) => t.name).join(' | ')} |`, `|---|${targets.map(() => '---').join('|')}|`);
  for (const c of cases) {
    const cells = s.map((x) => {
      const p = x.perCase.find((q) => q.id === c.id)!;
      return `${p.ok}/${p.n} · ${seg(p.ms)}`;
    });
    out.push(`| \`${c.id}\` — ${c.description} | ${cells.join(' | ')} |`);
  }

  out.push('', '## Fallos', '');
  const fallos = runs.filter((r) => !passed(r));
  if (fallos.length === 0) out.push('Ninguno.');
  for (const r of fallos) {
    const malas = r.checks.filter((c) => !c.ok).map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ''}`);
    out.push(`- **${r.target}** · \`${r.caseId}\` · vuelta ${r.round}: ${malas.join('; ')}`);
  }

  out.push('', '## Respuestas (primera vuelta)', '', 'Para juzgar a mano lo que las reglas no miden: tono, claridad, español.', '');
  for (const c of cases) {
    out.push(`### \`${c.id}\``, '', c.kind === 'agent' ? `> ${c.message}` : `> ${c.action} sobre ${c.targetId}`, '');
    for (const t of targets) {
      const r = runs.find((x) => x.target === t.name && x.caseId === c.id && x.round === 1);
      out.push(`**${t.name}**`, '', '```', (r?.error ? `ERROR: ${r.error}` : r?.output || '(vacío)').trim(), '```', '');
    }
  }
  return out.join('\n');
}

// ── Principal ──────────────────────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const { targets, repeat, cases, timeoutMs, apiKey, unload } = parseArgs(process.argv.slice(2));
  const runs: Run[] = [];
  const warm: Record<string, string | null> = {};
  const places: Record<string, Placement | null> = {};

  for (const t of targets) {
    console.log(`\n▶ ${t.name} — ${t.model} en ${t.baseURL} (${t.server})`);
    if (t.server === 'ollama' && unload) {
      const fallo = await unloadAll(t);
      console.log(fallo ? `  ⚠ no se pudo vaciar la GPU: ${fallo}` : '  GPU vaciada');
    }
    warm[t.name] = await warmUp(t, timeoutMs, apiKey);
    if (warm[t.name]) console.log(`  ⚠ calentamiento fallido: ${warm[t.name]}`);
    if (t.server === 'ollama') {
      const p = await placement(t);
      places[t.name] = p;
      if (p) {
        console.log(`  cargado: ${p.sizeGb.toFixed(1)} GB, ${p.gpuPct} % en GPU, contexto ${p.context ?? '?'}`);
        if (p.gpuPct < 100) console.log('  ⚠ parte del modelo está en la CPU: los tiempos no representan a la GPU. Baja el contexto (num_ctx).');
      }
    }
    for (let round = 1; round <= repeat; round++) {
      for (const c of cases) {
        const r = await runCase(t, c, round, timeoutMs, apiKey);
        runs.push(r);
        const ok = r.checks.filter((x) => x.ok).length;
        console.log(`  ${passed(r) ? '✓' : '✗'} [${round}/${repeat}] ${c.id.padEnd(20)} ${ok}/${r.checks.length}  ${seg(r.ms).padStart(7)}${r.error ? `  ${r.error}` : ''}`);
      }
    }
  }

  console.log('');
  for (const x of summarize(targets, cases, runs)) {
    console.log(
      `${x.target.name.padEnd(14)} casos ${x.casesOk}/${x.runs} (${pct(x.casesOk, x.runs)})  comprobaciones ${pct(x.checksOk, x.checks)}  ` +
        `mediana ${seg(x.medianCaseMs)}/caso  ${x.tokPerSec.toFixed(1)} tok/s  errores ${x.errors}`,
    );
  }

  const dir = join(__dirname, 'results');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const md = join(dir, `bench-${stamp}.md`);
  writeFileSync(md, markdown(targets, cases, runs, repeat, warm, places));
  writeFileSync(join(dir, `bench-${stamp}.json`), JSON.stringify({ targets, repeat, places, runs }, null, 2));
  console.log(`\nInforme: ${md}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
