const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(code => code.includes('async function analyzeWithAI'))
  .replace(/\s*loadDataFromStorage\(\);\s*$/, '');
const nutrition = { name: '테스트 식사', cal: 400, carb: 50, pro: 20, fat: 13, sugar: 5, na: 600 };

function setup({ writeFailure = false } = {}) {
  const nodes = new Map(), storage = new Map(), alerts = [], pending = [];
  const context = vm.createContext({
    document: {
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, {
          value: id === 'apiKey' ? 'test-key' : id.startsWith('goal-') ? '2000' : '',
          textContent: '', innerHTML: '', disabled: false, className: '',
          classList: { add() {}, remove() {}, toggle() {} }, getContext() { return {}; },
          replaceChildren() { this.innerHTML = ''; }
        });
        return nodes.get(id);
      },
      addEventListener() {}
    },
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem(key, value) {
        if (writeFailure) throw new DOMException('Full', 'QuotaExceededError');
        storage.set(key, value);
      },
      removeItem: key => storage.delete(key)
    },
    lucide: { createIcons() {} },
    Chart: class { constructor(ctx, config) { this.data = config.data; this.options = config.options; } update() {} },
    AbortController, DOMException, setTimeout() { return 1; }, clearTimeout() {},
    alert: message => alerts.push(message), confirm() { return true; }, location: { reload() {} },
    console: { log() {}, warn() {}, error() {} },
    fetch: async () => new Promise(resolve => pending.push((status = 200) => resolve({
      ok: status === 200, status, headers: { get() { return null; } },
      json: async () => status === 200
        ? { candidates: [{ content: { parts: [{ text: JSON.stringify(nutrition) }] } }] }
        : { error: { message: 'Request failed' } }
    })))
  });
  vm.runInContext(script, context);
  const evaluate = code => vm.runInContext(code, context);
  const node = id => context.document.getElementById(id);
  evaluate("selectedDate = '2026-11-04'");
  node('textInput').value = '첫 번째 음식';
  node('brandInput').value = '첫 매장';
  return { context, evaluate, node, storage, alerts, complete: status => pending.shift()(status) };
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

  const full = setup({ writeFailure: true });
  const fullRun = full.context.analyzeWithAI();
  full.complete();
  await fullRun;
  const storageFailure = {
    persisted: full.storage.size > 0,
    inputRetained: full.node('textInput').value !== '',
    recordsInMemory: full.evaluate('getCurrentFoodList().length'),
    alertClaimsInputRetained: full.alerts[0]?.includes('그대로 유지')
  };

  const compression = setup();
  const pendingCompression = [];
  compression.context.pendingCompression = pendingCompression;
  compression.evaluate('compressImageFile = file => new Promise(resolve => pendingCompression.push(resolve))');
  compression.evaluate("selectedImages = [{ data: 'old', previewUrl: 'old' }]");
  const upload = compression.context.handleImageSelect({ target: { files: [{ type: 'image/jpeg' }], value: 'fake' } });
  compression.context.clearAllSelectedImages();
  pendingCompression.shift()({ data: 'new', previewUrl: 'new' });
  await upload;
  const imagesAfterClearDuringCompression = compression.evaluate('selectedImages.length');

  console.log(JSON.stringify({ passed: checks, method: 'Actual application script in a Node VM with mocked DOM, storage and API; no live API calls.', diagnostics: { storageFailure, imagesAfterClearDuringCompression } }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
