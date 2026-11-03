const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(code => code.includes('async function analyzeWithAI'))
  .replace(/\s*loadDataFromStorage\(\);\s*$/, '');
const nutrition = { name: '테스트 식사', cal: 400, carb: 50, pro: 20, fat: 13, sugar: 5, na: 600 };

function setup({ writeFailure = false, readFailure = false, responseName = nutrition.name } = {}) {
  const nodes = new Map(), storage = new Map(), alerts = [], pending = [], requests = [], listeners = new Map();
  let blockWrites = writeFailure;
  let writes = 0;
  const context = vm.createContext({
    document: {
      getElementById(id) {
        if (!nodes.has(id)) {
          const classes = new Set(['saveWarning', 'loadingBtnGroup'].includes(id) ? ['hidden'] : []);
          nodes.set(id, {
          value: id === 'apiKey' ? 'test-key' : id.startsWith('goal-') ? '2000' : '',
          textContent: '', innerHTML: '', disabled: false, className: '',
          classList: {
            add(...names) { names.forEach(name => classes.add(name)); },
            remove(...names) { names.forEach(name => classes.delete(name)); },
            toggle(name, force) { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); },
            contains: name => classes.has(name)
          }, getContext() { return {}; },
          replaceChildren() { this.innerHTML = ''; }
          });
        }
        return nodes.get(id);
      },
      addEventListener() {}
    },
    window: { addEventListener: (name, handler) => listeners.set(name, handler) },
    localStorage: {
      getItem(key) { if (readFailure) throw new DOMException('Blocked', 'SecurityError'); return storage.get(key) || null; },
      setItem(key, value) {
        writes++;
        if (blockWrites) throw new DOMException('Full', 'QuotaExceededError');
        storage.set(key, value);
      },
      removeItem: key => storage.delete(key)
    },
    lucide: { createIcons() {} },
    Chart: class { constructor(ctx, config) { this.data = config.data; this.options = config.options; } update() {} },
    AbortController, DOMException, setTimeout() { return 1; }, clearTimeout() {},
    alert: message => alerts.push(message), confirm() { return true; }, location: { reload() {} },
    console: { log() {}, warn() {}, error() {} },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return new Promise(resolve => pending.push((status = 200) => resolve({
      ok: status === 200, status, headers: { get() { return null; } },
      json: async () => status === 200
        ? { candidates: [{ content: { parts: [{ text: JSON.stringify({ ...nutrition, name: responseName }) }] } }] }
        : { error: { message: 'Request failed' } }
      })));
    }
  });
  vm.runInContext(script, context);
  const evaluate = code => vm.runInContext(code, context);
  const node = id => context.document.getElementById(id);
  evaluate("selectedDate = '2026-11-04'");
  node('textInput').value = '첫 번째 음식';
  node('brandInput').value = '첫 매장';
  return { context, evaluate, node, storage, alerts, requests, listeners, complete: status => pending.shift()(status), allowWrites: () => { blockWrites = false; }, writes: () => writes };
}

async function main() {
  let checks = 0;
  const fields = html.match(/<fieldset\b[^>]*id="analysisInputs"[^>]*>([\s\S]*?)<\/fieldset>/)[1];
  for (const id of ['textInput', 'brandInput', 'imageInput', 'imagePreviewContainer']) assert.ok(fields.includes(`id="${id}"`));
  assert.ok(!fields.includes('cancelCurrentAnalysis()'));
  checks++;

  const date = setup();
  const dateRun = date.context.analyzeWithAI();
  assert.equal(date.node('analysisInputs').disabled, true);
  date.context.onDatePick('2026-11-03');
  date.complete();
  await dateRun;
  const records = JSON.parse(date.evaluate('JSON.stringify(dailyRecords)'));
  assert.equal(records['2026-11-04'].length, 1);
  assert.equal(records['2026-11-03'].length, 0);
  assert.equal(date.evaluate('getCurrentFoodList().length'), 0);
  assert.equal(date.node('analysisInputs').disabled, false);
  checks++;

  const image = setup();
  image.evaluate("selectedImages = [{ mimeType: 'image/jpeg', data: 'abc', previewUrl: 'data:image/jpeg;base64,abc' }]");
  image.context.renderImagePreviews();
  assert.ok(image.node('imagePreviewList').innerHTML.includes('base64,abc'));
  image.context.clearAllSelectedImages();
  assert.equal(image.evaluate('selectedImages.length'), 0);
  assert.equal(image.node('imagePreviewList').innerHTML, '');
  checks++;

  image.evaluate("selectedImages = [{ mimeType: 'image/jpeg', data: 'abc', previewUrl: 'data:image/jpeg;base64,abc' }]");
  image.context.renderImagePreviews();
  image.context.removeSelectedImage(0);
  assert.equal(image.node('imagePreviewList').innerHTML, '');
  checks++;

  const success = setup();
  success.evaluate("selectedImages = [{ mimeType: 'image/jpeg', data: 'abc', previewUrl: 'data:image/jpeg;base64,abc' }]");
  success.context.renderImagePreviews();
  const successRun = success.context.analyzeWithAI();
  success.complete();
  await successRun;
  assert.equal(success.node('imagePreviewList').innerHTML, '');
  assert.equal(success.node('textInput').value, '');
  assert.equal(success.node('analysisInputs').disabled, false);
  checks++;

  const failure = setup();
  failure.evaluate("selectedImages = [{ mimeType: 'image/jpeg', data: 'abc', previewUrl: 'data:image/jpeg;base64,abc' }]");
  const failureRun = failure.context.analyzeWithAI();
  failure.complete(404);
  await failureRun;
  assert.equal(failure.node('textInput').value, '첫 번째 음식');
  assert.equal(failure.evaluate('selectedImages.length'), 1);
  assert.equal(failure.node('analysisInputs').disabled, false);
  checks++;

  const cancel = setup();
  cancel.evaluate("selectedImages = [{ mimeType: 'image/jpeg', data: 'abc', previewUrl: 'data:image/jpeg;base64,abc' }]");
  const cancelRun = cancel.context.analyzeWithAI();
  cancel.context.cancelCurrentAnalysis();
  assert.equal(cancel.node('analysisInputs').disabled, false);
  cancel.complete();
  await cancelRun;
  assert.equal(cancel.node('textInput').value, '첫 번째 음식');
  assert.equal(cancel.evaluate('selectedImages.length'), 1);
  checks++;

  const restart = setup();
  const oldRun = restart.context.analyzeWithAI();
  restart.context.cancelCurrentAnalysis();
  const newRun = restart.context.analyzeWithAI();
  restart.complete();
  await oldRun;
  assert.equal(restart.node('analysisInputs').disabled, true);
  restart.complete();
  await newRun;
  assert.equal(restart.node('analysisInputs').disabled, false);
  checks++;

  const unsafeName = `"><img src=x onerror="alert(1)"> & '샐러드'`;
  const escapedName = '&quot;&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;샐러드&#39;';
  const names = setup({ responseName: unsafeName });
  const namesRun = names.context.analyzeWithAI();
  names.complete();
  await namesRun;
  assert.ok(names.node('foodList').innerHTML.includes(escapedName));
  assert.ok(!names.node('foodList').innerHTML.includes('<img'));
  assert.equal(names.evaluate('getCurrentFoodList()[0].name'), unsafeName);
  const stored = JSON.parse([...names.storage.values()][0]);
  assert.equal(stored.dailyRecords['2026-11-04'][0].name, unsafeName);
  checks++;

  const itemId = names.evaluate('getCurrentFoodList()[0].id');
  names.context.startEditItem(itemId);
  assert.ok(names.node('foodList').innerHTML.includes(`value="${escapedName}"`));
  assert.ok(!names.node('foodList').innerHTML.includes('<img'));
  checks++;

  names.context.saveItemAsPreset(itemId);
  assert.ok(names.node('presetsList').innerHTML.includes(escapedName));
  assert.ok(!names.node('presetsList').innerHTML.includes('<img'));
  names.context.togglePresetManageMode();
  assert.ok(names.node('presetsList').innerHTML.includes(escapedName));
  assert.ok(!names.node('presetsList').innerHTML.includes('<img'));
  checks++;

  const manual = setup();
  manual.node('m-name').value = unsafeName;
  manual.node('m-cal').value = '100';
  manual.context.addManualItem(true);
  assert.ok(manual.node('foodList').innerHTML.includes(escapedName));
  assert.ok(manual.node('presetsList').innerHTML.includes(escapedName));
  checks++;

  const literal = setup();
  literal.node('m-name').value = '&lt;b&gt;샐러드&lt;/b&gt;';
  literal.context.addManualItem();
  assert.ok(literal.node('foodList').innerHTML.includes('&amp;lt;b&amp;gt;샐러드&amp;lt;/b&amp;gt;'));
  assert.equal(literal.evaluate('getCurrentFoodList()[0].name'), '&lt;b&gt;샐러드&lt;/b&gt;');
  checks++;

  const full = setup({ writeFailure: true });
  full.evaluate("selectedImages = [{ mimeType: 'image/jpeg', data: 'abc', previewUrl: 'data:image/jpeg;base64,abc' }]");
  const fullRun = full.context.analyzeWithAI();
  full.complete();
  await fullRun;
  assert.equal(full.storage.size, 0);
  assert.equal(full.node('textInput').value, '첫 번째 음식');
  assert.equal(full.evaluate('selectedImages.length'), 1);
  assert.equal(full.evaluate('getCurrentFoodList().length'), 1);
  assert.equal(full.evaluate('pendingAnalysisSave'), true);
  assert.equal(full.node('analysisInputs').disabled, true);
  assert.equal(full.node('saveStatus').textContent, '저장되지 않음');
  assert.equal(full.node('saveWarning').classList.contains('hidden'), false);
  assert.equal(full.alerts.length, 0, 'A persistence error must not be reported as an AI failure');
  checks++;

  await full.context.analyzeWithAI();
  assert.equal(full.requests.length, 1);
  assert.equal(full.evaluate('getCurrentFoodList().length'), 1);
  checks++;

  let prevented = false;
  full.listeners.get('beforeunload')({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  full.allowWrites();
  full.context.retrySaveData();
  assert.equal(full.requests.length, 1);
  assert.equal(full.evaluate('getCurrentFoodList().length'), 1);
  assert.equal(full.evaluate('pendingAnalysisSave'), false);
  assert.equal(full.evaluate('hasUnsavedChanges'), false);
  assert.equal(full.node('textInput').value, '');
  assert.equal(full.evaluate('selectedImages.length'), 0);
  assert.equal(full.node('analysisInputs').disabled, false);
  assert.equal(full.node('saveWarning').classList.contains('hidden'), true);
  const recovered = JSON.parse([...full.storage.values()][0]);
  assert.equal(recovered.dailyRecords['2026-11-04'].length, 1);
  checks++;

  prevented = false;
  full.listeners.get('beforeunload')({ preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  checks++;

  const reset = setup();
  reset.node('m-name').value = '저장된 음식';
  reset.context.addManualItem();
  reset.evaluate("selectedImages = [{ data: 'abc', previewUrl: 'abc' }]");
  reset.context.clearAnalysisInputs();
  assert.equal(reset.node('textInput').value, '');
  assert.equal(reset.node('brandInput').value, '');
  assert.equal(reset.node('apiKey').value, 'test-key');
  assert.equal(reset.evaluate('selectedImages.length'), 0);
  assert.equal(reset.evaluate('getCurrentFoodList().length'), 1);
  checks++;

  const clearPending = setup({ writeFailure: true });
  const clearPendingRun = clearPending.context.analyzeWithAI();
  clearPending.complete();
  await clearPendingRun;
  clearPending.context.clearAnalysisInputs();
  assert.equal(clearPending.evaluate('getCurrentFoodList().length'), 1);
  assert.equal(clearPending.evaluate('hasUnsavedChanges'), true);
  assert.equal(clearPending.evaluate('pendingAnalysisSave'), false);
  assert.equal(clearPending.node('analysisInputs').disabled, false);
  clearPending.allowWrites();
  clearPending.context.retrySaveData();
  assert.equal(clearPending.requests.length, 1);
  checks++;

  const compression = setup();
  const pendingCompression = [];
  compression.context.pendingCompression = pendingCompression;
  compression.evaluate('compressImageFile = file => new Promise(resolve => pendingCompression.push(resolve))');
  compression.evaluate("selectedImages = [{ data: 'old', previewUrl: 'old' }]");
  const upload = compression.context.handleImageSelect({ target: { files: [{ type: 'image/jpeg' }], value: 'fake' } });
  compression.context.clearAllSelectedImages();
  pendingCompression.shift()({ data: 'new', previewUrl: 'new' });
  await upload;
  assert.equal(compression.evaluate('selectedImages.length'), 0);
  assert.equal(compression.evaluate('pendingImageSelections'), 0);
  assert.equal(compression.node('analyzeBtnNormal').disabled, false);
  checks++;

  const overlap = setup();
  const jobs = new Map();
  overlap.context.compressionJobs = jobs;
  overlap.evaluate('compressImageFile = file => new Promise(resolve => compressionJobs.set(file.id, resolve))');
  const oldUpload = overlap.context.handleImageSelect({ target: { files: [{ type: 'image/jpeg', id: 'old' }], value: 'old' } });
  overlap.context.clearAllSelectedImages();
  const newUpload = overlap.context.handleImageSelect({ target: { files: [{ type: 'image/jpeg', id: 'new' }], value: 'new' } });
  jobs.get('old')({ data: 'old', previewUrl: 'old' });
  await oldUpload;
  assert.equal(overlap.evaluate('pendingImageSelections'), 1);
  assert.equal(overlap.node('analyzeBtnNormal').disabled, true);
  await overlap.context.analyzeWithAI();
  assert.equal(overlap.requests.length, 0);
  jobs.get('new')({ data: 'new', previewUrl: 'new' });
  await newUpload;
  assert.equal(overlap.evaluate('selectedImages.length'), 1);
  assert.equal(overlap.evaluate('selectedImages[0].data'), 'new');
  assert.equal(overlap.evaluate('pendingImageSelections'), 0);
  checks++;

  const batches = setup();
  const batchJobs = new Map();
  batches.context.batchJobs = batchJobs;
  batches.evaluate('compressImageFile = file => new Promise(resolve => batchJobs.set(file.id, resolve))');
  const firstBatch = batches.context.handleImageSelect({ target: { files: [{ type: 'image/jpeg', id: 'a' }], value: 'a' } });
  const secondBatch = batches.context.handleImageSelect({ target: { files: [{ type: 'image/jpeg', id: 'b' }], value: 'b' } });
  batchJobs.get('a')({ data: 'a', previewUrl: 'a' });
  await firstBatch;
  assert.equal(batches.evaluate('pendingImageSelections'), 1);
  assert.equal(batches.node('analyzeBtnNormal').disabled, true);
  batchJobs.get('b')({ data: 'b', previewUrl: 'b' });
  await secondBatch;
  assert.equal(batches.evaluate('selectedImages.length'), 2);
  assert.equal(batches.node('analyzeBtnNormal').disabled, false);
  checks++;

  const blocked = setup({ readFailure: true, writeFailure: true });
  assert.doesNotThrow(() => blocked.context.loadDataFromStorage());
  assert.equal(blocked.writes(), 0, 'A failed read must not overwrite unknown existing records');
  checks++;

  const apiRequest = success.requests[0];
  assert.equal(new URL(apiRequest.url).search, '');
  assert.equal(apiRequest.options.headers['x-goog-api-key'], 'test-key');
  assert.ok(!apiRequest.options.body.includes('test-key'));
  const savedKey = JSON.parse([...success.storage.values()][0]).apiKey;
  assert.equal(savedKey, 'test-key', 'User requested automatic key storage');
  const restored = setup();
  for (const [key, value] of success.storage) restored.storage.set(key, value);
  restored.node('apiKey').value = '';
  restored.context.loadDataFromStorage();
  assert.equal(restored.node('apiKey').value, 'test-key');
  checks++;

  for (const tag of html.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*>/g)) {
    const integrity = tag[0].match(/integrity="([^"]+)"/)[1];
    assert.ok(!tag[1].includes('@latest'));
    if (tag[1].startsWith('https://')) assert.ok(tag[0].includes('crossorigin="anonymous"'));
    else {
      const bytes = fs.readFileSync(path.join(__dirname, '..', tag[1]));
      assert.equal('sha384-' + createHash('sha384').update(bytes).digest('base64'), integrity);
    }
  }
  checks++;

  console.log(JSON.stringify({ passed: checks, method: 'Actual application script in a Node VM with mocked DOM, storage and API; no live API calls.' }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
