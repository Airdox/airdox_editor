import assert from 'node:assert/strict';
import { getModelCatalog, validateCatalog, selectModelForProfile, modelStemOrder, stemNamesForModel } from '../src/stems/modelRegistry';

async function run() {
  const catalog = getModelCatalog();
  // 1. Catalog has 5 models
  assert.ok(catalog.models.length >= 5, `Expected >=5 models, got ${catalog.models.length}`);

  // 2. Content hash present
  assert.ok(catalog.contentHash, 'contentHash present');
  assert.ok(catalog.contentHash.length >= 16, 'contentHash length');

  // 3. Validate catalog
  const validation = validateCatalog(catalog);
  assert.equal(validation.valid, true, `Catalog validation failed: ${validation.errors.join('; ')}`);

  // 4. Required fields
  for (const m of catalog.models) {
    assert.ok(m.id, `Model ${m.id} has id`);
    assert.ok(m.displayName, `Model ${m.id} has displayName`);
    assert.ok(Array.isArray(m.stemOrder) && m.stemOrder.length > 0, `Model ${m.id} stemOrder`);
    assert.ok(Array.isArray(m.outputStems), `Model ${m.id} outputStems`);
    assert.ok(typeof m.trainedModel === 'boolean', `Model ${m.id} trainedModel`);
    assert.ok(m.backend, `Model ${m.id} backend`);
    assert.ok(m.qualityProfile, `Model ${m.id} qualityProfile`);
    assert.ok(m.checkpoint, `Model ${m.id} checkpoint`);
  }

  // 5. stemOrder vs outputStems sets match
  for (const m of catalog.models) {
    const so = new Set(m.stemOrder);
    const os = new Set(m.outputStems);
    assert.deepEqual([...so].sort(), [...os].sort(), `Model ${m.id} stemOrder vs outputStems mismatch`);
  }

  // 6. Display names non-empty
  for (const m of catalog.models) {
    assert.ok(m.displayName.length >= 3, `Model ${m.id} displayName length`);
  }

  // 7. Hash formats
  for (const m of catalog.models) {
    assert.ok(/^[a-f0-9]{32,}/i.test(m.checkpoint.sha256), `Model ${m.id} sha256 format`);
  }

  // 8. Quality profile serves/numOverlap/ensemblePasses
  for (const m of catalog.models) {
    assert.ok(['PREVIEW', 'HIGH_QUALITY', 'MAXIMUM_QUALITY'].includes(m.qualityProfile.serves), `Model ${m.id} serves`);
    if (m.qualityProfile.numOverlap !== undefined) assert.ok(m.qualityProfile.numOverlap >= 1, `Model ${m.id} numOverlap`);
    if (m.qualityProfile.ensemblePasses !== undefined) assert.ok(m.qualityProfile.ensemblePasses >= 1, `Model ${m.id} ensemblePasses`);
  }

  // 9. Content hash
  assert.ok(validation.contentHash, 'validation returns contentHash');

  // 10. Selection prefers bs_roformer for HQ
  const hq = selectModelForProfile('HIGH_QUALITY');
  assert.ok(hq, 'HQ model selected');
  assert.ok(hq.id.includes('bsroformer') || hq.backend.includes('roformer'), `HQ should prefer bs_roformer, got ${hq.id}`);

  // 11. Stem order authoritative from catalog
  const demucsOrder = stemNamesForModel('htdemucs-ft-4stem');
  assert.deepEqual(demucsOrder, ['drums', 'bass', 'other', 'vocals'], 'Demucs order from catalog');

  const bsOrder = modelStemOrder('bsroformer-musdb18hq-4stem-zfturbo');
  assert.deepEqual(bsOrder, ['vocals', 'bass', 'drums', 'other'], 'BS order from catalog');

  console.log('stem-separation-registry: all tests passed (8 groups)');
}

run().catch(e => { console.error(e); process.exit(1); });
