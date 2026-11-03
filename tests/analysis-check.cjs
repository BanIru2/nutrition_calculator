const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const root = path.resolve(__dirname, '..');
const baselineCommit = '1faf48c';
const current = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const baseline = execFileSync('git', ['show', `${baselineCommit}:index.html`], { cwd: root, encoding: 'utf8' });
const nutrition = { name: '테스트 식사', cal: 400, carb: 50, pro: 20, fat: 13, sugar: 5, na: 600 };

function response({ status = 200, text = JSON.stringify(nutrition), error, retryAfter = null, malformed = false } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => name === 'Retry-After' ? retryAfter : null },
    async json() {
      if (malformed) throw new SyntaxError('Invalid JSON');
      return error ? { error } : { candidates: [{ content: { parts: [{ text }] } }] };
    }
  };
}

function harness(source, responses = [{}], options = {}) {
  const timers = new Map();
  const controllers = [];
  const state = {
    now: 0, requests: 0, serializedCalls: 0, serializedBytes: 0, serializationMs: 0,
    records: [], alerts: [], statuses: [], timerCount: 0, capturedBodies: [], samples: []
  };
  let timerId = 0;
  function schedule(fn, delay) {
    const id = ++timerId;
    timers.set(id, { at: state.now + delay, fn });
    state.timerCount++;
    return id;
  }
  class TrackedController extends AbortController {
    constructor() {
      super();
      this.listeners = new Map();
      controllers.push(this);
      const add = this.signal.addEventListener.bind(this.signal);
      const remove = this.signal.removeEventListener.bind(this.signal);
      this.signal.addEventListener = (type, listener, config) => {
        if (type !== 'abort') return add(type, listener, config);
        const wrapped = event => {
          if (config?.once) this.listeners.delete(listener);
          listener(event);
        };
        this.listeners.set(listener, wrapped);
        add(type, wrapped, config);
      };
      this.signal.removeEventListener = (type, listener) => {
        remove(type, this.listeners.get(listener) || listener);
        this.listeners.delete(listener);
      };
    }
  }
  const elements = {
    apiKey: { value: 'test-key' }, textInput: { value: '테스트 식사' },
    brandInput: { value: '테스트 브랜드' }, imageInput: { value: '' }
  };
  function sample() {
    if (options.memory) {
      global.gc();
      state.samples.push(process.memoryUsage().heapUsed);
    }
  }
  const context = vm.createContext({
    document: { getElementById: id => elements[id] },
    analysisAbortController: null, isAnalyzing: false, selectedDate: '2026-11-04',
    analysisSpeedMode: options.speed || 'fast', selectedImages: options.images || [],
    AbortController: TrackedController, DOMException,
    Math: Object.assign(Object.create(Math), { random: () => options.random || 0 }),
    JSON: {
      parse: JSON.parse,
      stringify(value) {
        const started = performance.now();
        const serialized = JSON.stringify(value);
        state.serializationMs += performance.now() - started;
        state.serializedCalls++;
        state.serializedBytes += Buffer.byteLength(serialized, 'utf8');
        return serialized;
      }
    },
    setTimeout: schedule, clearTimeout: id => timers.delete(id),
    setAnalyzingUI(value) { context.isAnalyzing = value; },
    updateAnalysisStatus(value) { state.statuses.push(value); },
    clearAllSelectedImages() {}, updateUI() {}, getCurrentFoodList: () => state.records,
    alert: message => state.alerts.push(message), console: { log() {}, warn() {} },
    fetch: async (url, request) => {
      state.requests++;
      if (options.captureBodies) state.capturedBodies.push(JSON.parse(request.body));
      sample();
      const spec = responses[Math.min(state.requests - 1, responses.length - 1)];
      const signal = request.signal;
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          if (spec.ignoreAbort) return;
          timers.delete(networkTimer);
          signal.removeEventListener('abort', onAbort);
          reject(new DOMException('Aborted', 'AbortError'));
        };
        const networkTimer = schedule(() => {
          signal.removeEventListener('abort', onAbort);
          if (spec.networkError) reject(new TypeError('Failed to fetch'));
          else resolve(response(spec));
        }, spec.latencyMs ?? 100);
        signal.addEventListener('abort', onAbort);
      });
    }
  });
  const analyze = source.match(/async function analyzeWithAI\(useSearch = false\) \{[\s\S]*?\n        \}/)[0];
  const cancel = source.match(/function cancelCurrentAnalysis\(\) \{[\s\S]*?\n        \}/)[0];
  vm.runInContext(`${analyze}\n${cancel}`, context);
  async function flush() { await new Promise(setImmediate); }
  async function settle(promise) {
    let complete = false;
    let failure;
    promise.then(() => { complete = true; }, error => { failure = error; complete = true; });
    for (let i = 0; i < 100; i++) {
      await flush();
      if (complete) {
        if (failure) throw failure;
        sample();
        return;
      }
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      assert.ok(next, 'Request stalled without a timer');
      state.now = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
    }
    throw new Error('Request did not settle');
  }
  return {
    state, context, elements, controllers, timers, settle, flush,
    run: () => context.analyzeWithAI(options.search || false),
    cancel: () => context.cancelCurrentAnalysis(),
    listenerCount: () => controllers.reduce((sum, item) => sum + item.listeners.size, 0)
  };
}

async function execute(source, responses, options) {
  const test = harness(source, responses, options);
  await test.settle(test.run());
  return test;
}

async function checks() {
  let checked = 0;
  for (const [, script] of current.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    if (script.trim()) new vm.Script(script);
  }
  for (const status of [400, 401, 402, 403, 404, 501]) {
    const test = await execute(current, [{ status, error: { message: `HTTP ${status}` } }]);
    assert.equal(test.state.requests, 1);
    assert.equal(test.state.records.length, 0);
    assert.equal(test.elements.textInput.value, '테스트 식사');
    checked++;
  }
  for (const status of [408, 429, 500, 502, 503, 504]) {
    const test = await execute(current, [{ status, error: { message: 'temporary' } }, {}]);
    assert.equal(test.state.requests, 2);
    assert.equal(test.state.records.length, 1);
    assert.equal(test.listenerCount(), 0);
    checked++;
  }
  const limited = await execute(current, [{ status: 429, error: { message: 'Check quota and billing details' } }]);
  assert.equal(limited.state.requests, 3, 'Ambiguous quota messages must not be classified as a permanent billing failure');
  checked++;
  const daily = await execute(current, [{ status: 429, error: { message: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProject' }] }] } }]);
  assert.equal(daily.state.requests, 1);
  checked++;
  for (const retryAfter of ['5', new Date(Date.now() + 60000).toUTCString()]) {
    const test = await execute(current, [{ status: 429, retryAfter, error: { message: 'rate limit' } }, {}]);
    if (retryAfter === '5') {
      assert.equal(test.state.now, 5200);
      assert.equal(test.state.requests, 2);
    } else assert.equal(test.state.requests, 1);
    checked++;
  }
  for (const delay of ['6s', '60s']) {
    const test = await execute(current, [{ status: 429, error: { message: 'rate limit', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay }] } }, {}]);
    assert.equal(test.state.requests, delay === '6s' ? 2 : 1);
    if (delay === '6s') assert.equal(test.state.now, 6200);
    checked++;
  }
  const network = await execute(current, [{ networkError: true }, {}]);
  assert.equal(network.state.requests, 2);
  assert.equal(network.state.records.length, 1);
  checked++;
  for (const responses of [
    [{ status: 503, error: { message: 'overloaded' } }],
    [{ networkError: true }, { status: 503, error: { message: 'overloaded' } }, {}]
  ]) {
    const test = await execute(current, responses);
    assert.equal(test.state.requests, 3, 'Network and HTTP errors must share the same retry budget');
    assert.equal(test.listenerCount(), 0);
    assert.ok(test.state.statuses.at(-1).includes('재시도'), 'The initial status timer must not overwrite retry notices');
    checked++;
  }
  for (const status of [200, 403, 503]) {
    const test = await execute(current, [{ status, malformed: true }, {}]);
    assert.equal(test.state.requests, status === 503 ? 2 : 1);
    checked++;
  }
  const invalid = [
    '분석할 수 없습니다.', '{"name":"음식","cal":10}',
    JSON.stringify({ ...nutrition, sugar: null }), JSON.stringify({ ...nutrition, sugar: '5' }),
    JSON.stringify({ ...nutrition, sugar: -1 }), JSON.stringify({ ...nutrition, name: ' ' }),
    JSON.stringify({ ...nutrition, name: 123 }), JSON.stringify(nutrition).replace('"cal":400', '"cal":1e999'),
    'null', '[]', '{"name":"음식","cal":4'
  ];
  for (const text of invalid) {
    const test = await execute(current, [{ text }]);
    assert.equal(test.state.records.length, 0, `Invalid response saved: ${text}`);
    assert.equal(test.state.requests, 1);
    assert.equal(test.elements.textInput.value, '테스트 식사');
    checked++;
  }
  const zero = await execute(current, [{ text: JSON.stringify({ name: '물', cal: 0, carb: 0, pro: 0, fat: 0, sugar: 0, na: 0 }) }]);
  assert.equal(zero.state.records.length, 1);
  checked++;
  const fenced = await execute(current, [{ text: '```json\n' + JSON.stringify(nutrition) + '\n```' }]);
  assert.equal(fenced.state.records.length, 1);
  checked++;
  for (const search of [false, true]) for (const speed of ['fast', 'deep']) {
    const options = { search, speed, captureBodies: true };
    const old = await execute(baseline, [{}], options);
    const test = await execute(current, [{}], options);
    assert.deepEqual(test.state.capturedBodies, old.state.capturedBodies);
    checked++;
  }
  const duplicate = harness(current);
  const first = duplicate.run();
  await duplicate.run();
  await duplicate.settle(first);
  assert.equal(duplicate.state.requests, 1);
  checked++;
  for (const ignoreAbort of [false, true]) {
    const test = harness(current, [{ ignoreAbort, latencyMs: 1000 }, { latencyMs: 2000 }]);
    const first = test.run();
    test.cancel();
    const second = test.run();
    await test.settle(first);
    assert.equal(test.context.analysisAbortController, test.controllers[1]);
    assert.equal(test.context.isAnalyzing, true);
    assert.equal(test.state.records.length, 0);
    test.cancel();
    await test.settle(second);
    assert.equal(test.controllers[1].signal.aborted, true);
    assert.equal(test.state.records.length, 0);
    assert.equal(test.listenerCount(), 0);
    checked++;
  }
  const waitCancel = harness(current, [{ status: 503, error: { message: 'overloaded' } }]);
  const waiting = waitCancel.run();
  await waitCancel.flush();
  const transport = [...waitCancel.timers].find(([, timer]) => timer.at === 100);
  waitCancel.state.now = transport[1].at;
  waitCancel.timers.delete(transport[0]);
  transport[1].fn();
  await waitCancel.flush();
  waitCancel.cancel();
  await waitCancel.settle(waiting);
  assert.equal(waitCancel.state.requests, 1);
  assert.equal(waitCancel.timers.size, 0);
  assert.equal(waitCancel.listenerCount(), 0);
  checked++;
  const jitter = await execute(current, [{ status: 503, error: { message: 'overloaded' } }, { status: 503, error: { message: 'overloaded' } }, {}], { random: 0.5 });
  assert.equal(jitter.state.now, 5050);
  checked++;
  return checked;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function main() {
  const largeImages = Array.from({ length: 3 }, () => ({ mimeType: 'image/jpeg', data: Buffer.alloc(256 * 1024, 0xab).toString('base64') }));
  if (process.argv[2] === '--memory') {
    assert.equal(typeof global.gc, 'function');
    const source = process.argv[3] === 'baseline' ? baseline : current;
    const measurements = [];
    for (let i = 0; i < 5; i++) {
      global.gc();
      const initial = process.memoryUsage().heapUsed;
      const test = await execute(source, [{ status: 503, error: { message: 'overloaded' } }, { status: 503, error: { message: 'overloaded' } }, {}], { images: largeImages, memory: true });
      measurements.push(Math.max(...test.state.samples) - initial);
    }
    console.log(JSON.stringify({ sampledRetainedHeapMedianBytes: median(measurements) }));
    return;
  }
  const passed = await checks();
  const scenarios = {
    success: [{}],
    invalidRequest400: [{ status: 400, error: { message: 'bad request' } }],
    permission403: [{ status: 403, error: { message: 'permission denied' } }],
    dailyQuota429: [{ status: 429, error: { message: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'RequestsPerDay' }] }] } }],
    overload503ThenSuccess: [{ status: 503, error: { message: 'overloaded' } }, { status: 503, error: { message: 'overloaded' } }, {}],
    invalidModelOutput: [{ text: '분석할 수 없습니다.' }]
  };
  const comparison = {};
  for (const [name, responses] of Object.entries(scenarios)) {
    comparison[name] = {};
    for (const [version, source] of [['baseline', baseline], ['current', current]]) {
      const test = await execute(source, responses, { images: largeImages });
      comparison[name][version] = {
        requests: test.state.requests, simulatedElapsedMs: test.state.now,
        serializations: test.state.serializedCalls, serializedUtf8BytesTotal: test.state.serializedBytes,
        savedRecords: test.state.records.length, remainingAbortListeners: test.listenerCount()
      };
    }
  }
  const timings = { baseline: [], current: [] };
  for (let iteration = 0; iteration < 30; iteration++) {
    const order = iteration % 2 ? [['current', current], ['baseline', baseline]] : [['baseline', baseline], ['current', current]];
    for (const [version, source] of order) {
      const test = await execute(source, scenarios.overload503ThenSuccess, { images: largeImages });
      if (iteration >= 5) timings[version].push(test.state.serializationMs);
    }
  }
  const memory = {};
  for (const version of ['baseline', 'current']) {
    const result = spawnSync(process.execPath, ['--expose-gc', __filename, '--memory', version], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    memory[version] = JSON.parse(result.stdout);
  }
  console.log(JSON.stringify({
    baselineCommit, currentSourceSha256: createHash('sha256').update(current).digest('hex'),
    checkedCases: passed, nodeVersion: process.version, platform: process.platform,
    method: 'Actual analyzeWithAI code in Node VM; mocked API transport 100 ms/request; virtual retry timers; jitter fixed at 0 for comparison. No real API calls.',
    payload: { syntheticImages: 3, decodedBytesEach: 256 * 1024, base64CharactersTotal: largeImages.reduce((sum, image) => sum + image.data.length, 0) },
    comparison,
    productionJitterMsPerRetry: { minimum: 0, maximumExclusive: 250 },
    serializationCpuMedianMs: { samplesPerVersion: 25, baseline: median(timings.baseline), current: median(timings.current) },
    memory,
    memoryLimit: 'Fresh Node process per version, five runs, forced GC at fetch boundaries and completion. Sampled retained JS heap only; excludes browser/native fetch/image memory and is not a peak-memory measurement.'
  }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
