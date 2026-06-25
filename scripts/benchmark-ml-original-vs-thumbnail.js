const fs = require('node:fs/promises');
const { performance } = require('node:perf_hooks');

const ML_URL = process.env.IMMICH_MACHINE_LEARNING_URL || 'http://immich-ml:3003';
const MODEL_NAME = process.env.CLIP_MODEL_NAME || 'ViT-SO400M-16-SigLIP2-384__webli';

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

async function encode(path) {
  const entries = {
    clip: {
      visual: {
        modelName: MODEL_NAME,
      },
    },
  };

  const start = performance.now();
  const buffer = await fs.readFile(path);
  const afterRead = performance.now();

  const form = new FormData();
  form.append('entries', JSON.stringify(entries));
  form.append('image', new Blob([new Uint8Array(buffer)]));

  const response = await fetch(`${ML_URL}/predict`, { method: 'POST', body: form });
  const text = await response.text();
  const end = performance.now();

  if (!response.ok) {
    throw new Error(`ML failed for ${path}: ${response.status} ${text.slice(0, 300)}`);
  }

  return {
    bytes: buffer.length,
    readMs: afterRead - start,
    totalMs: end - start,
  };
}

function avg(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function main() {
  const samples = JSON.parse(await readStdin());
  const rows = [];

  // Warm the model once so first-load time does not dominate original vs thumbnail.
  if (samples[0]) {
    await encode(samples[0].thumbnailPath);
  }

  for (const sample of samples) {
    const thumb = await encode(sample.thumbnailPath);
    const original = await encode(sample.originalPath);
    rows.push({
      id: sample.id,
      originalKB: original.bytes / 1024,
      thumbKB: thumb.bytes / 1024,
      originalMs: original.totalMs,
      thumbMs: thumb.totalMs,
      originalReadMs: original.readMs,
      thumbReadMs: thumb.readMs,
      ratio: original.totalMs / thumb.totalMs,
    });
  }

  const summary = {
    count: rows.length,
    originalAvgMs: avg(rows.map((row) => row.originalMs)),
    thumbAvgMs: avg(rows.map((row) => row.thumbMs)),
    originalAvgKB: avg(rows.map((row) => row.originalKB)),
    thumbAvgKB: avg(rows.map((row) => row.thumbKB)),
    originalAvgReadMs: avg(rows.map((row) => row.originalReadMs)),
    thumbAvgReadMs: avg(rows.map((row) => row.thumbReadMs)),
    avgRatioOriginalOverThumb: avg(rows.map((row) => row.ratio)),
  };

  console.log(JSON.stringify({ summary, rows }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
