// EVEZ VCL Core — main entry point
// VCL_ID=fire|ocean|neural|void|prime node src/main.js

import { VCL_REGISTRY } from './vcl-configs.js';
import { SensoryEngine } from './sensory.js';
import { createRenderer, W, H } from './renderer.js';
import { Streamer, FPS } from './stream.js';

const VCL_ID = process.env.VCL_ID || 'fire';
const cfg = VCL_REGISTRY[VCL_ID];

if (!cfg) {
  console.error(`Unknown VCL_ID: "${VCL_ID}". Options: ${Object.keys(VCL_REGISTRY).join(', ')}`);
  process.exit(1);
}

console.log(`\n┌─────────────────────────────────────────────┐`);
console.log(`│  EVEZ VCL Core v1.0  ●  ${cfg.name.padEnd(20)}│`);
console.log(`│  ${W}x${H} @ ${FPS}fps  |  Sensory accumulation active  │`);
console.log(`└─────────────────────────────────────────────┘\n`);

const sensory = new SensoryEngine(cfg);
const renderer = createRenderer(cfg);
const streamer = new Streamer(cfg.streamKey);

const MS_PER_FRAME = 1000 / FPS;
let params = { ...cfg.physics };
let lastFrame = Date.now();
let frameCount = 0;
const startTime = Date.now();

async function main() {
  params = await sensory.init();
  sensory.start();
  streamer.start();

  function loop() {
    const now = Date.now();
    if (now - lastFrame >= MS_PER_FRAME - 2) {
      lastFrame = now;
      params = sensory.getParams();
      renderer.renderFrame(params);
      streamer.write(renderer.getBuffer());
      frameCount++;
      if (frameCount % 600 === 0) {
        const up = Math.floor((Date.now() - startTime) / 1000);
        console.log(`[main] f=${frameCount} up=${up}s viewers=${sensory.viewerCount} msgs=${sensory.allTimeMsgs}`);
      }
    }
    setImmediate(loop);
  }

  loop();

  process.on('SIGTERM', () => { sensory.stop(); streamer.stop(); process.exit(0); });
  process.on('SIGINT',  () => { sensory.stop(); streamer.stop(); process.exit(0); });
}

main().catch(console.error);
