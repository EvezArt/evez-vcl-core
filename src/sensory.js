// EVEZ VCL Sensory Engine
// Polls YouTube Live Chat, extracts interaction patterns,
// feeds them into the VCL brain state, accumulates all data in Supabase.
// Brain state persists across restarts — the VCL learns and evolves over time.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://vziaqxquzohqskesuxgz.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const YOUTUBE_TOKEN = process.env.YOUTUBE_TOKEN;
const GROQ_KEY = process.env.GROQ_API_KEY;

const sb = SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

export class SensoryEngine {
  constructor(config) {
    this.config = config;
    this.vcl_id = config.id;
    this.params = { ...config.physics };
    this.brainState = { ...config.physics };
    this.pageToken = null;
    this.viewerCount = 0;
    this.sessionStart = Date.now();
    this.allTimeMsgs = 0;
    this.peakViewers = 0;
    this._chatPoll = null;
    this._persistTimer = null;
  }

  async init() {
    if (sb) {
      const { data } = await sb.from('vcl_brain_state').select('*').eq('vcl_id', this.vcl_id).single();
      if (data?.params && Object.keys(data.params).length) {
        this.brainState = { ...this.brainState, ...data.params };
        this.params = { ...this.params, ...data.params };
        this.allTimeMsgs = data.total_messages || 0;
        this.peakViewers = data.peak_viewers || 0;
        console.log(`[${this.vcl_id}] Brain state loaded: ${JSON.stringify(this.params).slice(0, 100)}...`);
      } else {
        // Seed brain state
        await sb.from('vcl_brain_state').upsert({
          vcl_id: this.vcl_id,
          params: { ...this.params },
          total_messages: 0,
          peak_viewers: 0,
          last_active: new Date().toISOString(),
          session_start: new Date(this.sessionStart).toISOString(),
        }, { onConflict: 'vcl_id' }).catch(() => {});
        console.log(`[${this.vcl_id}] Brain state seeded`);
      }
    }
    console.log(`[${this.vcl_id}] Sensory engine ready`);
    return { ...this.params };
  }

  start() {
    this._chatPoll = setInterval(() => this._poll().catch(console.error), 9000);
    this._persistTimer = setInterval(() => this._persist().catch(console.error), 60000);
    console.log(`[${this.vcl_id}] Sensory polling active (9s interval)`);
  }

  stop() {
    if (this._chatPoll) clearInterval(this._chatPoll);
    if (this._persistTimer) clearInterval(this._persistTimer);
  }

  getParams() { return { ...this.params }; }

  // ── clamp params to safe ranges ──────────────────────────────────────────────
  _clamp() {
    const p = this.params;
    if ('nodeCount' in p) p.nodeCount = Math.max(50, Math.min(600, p.nodeCount));
    if ('fire_cascade_prob' in p) p.fire_cascade_prob = Math.max(0.002, Math.min(0.15, p.fire_cascade_prob));
    if ('repulsion' in p) p.repulsion = Math.max(200, Math.min(8000, p.repulsion));
    if ('maxSpeed' in p) p.maxSpeed = Math.max(1, Math.min(20, p.maxSpeed));
    if ('waveAmplitude' in p) p.waveAmplitude = Math.max(5, Math.min(200, p.waveAmplitude));
    if ('turbulence' in p) p.turbulence = Math.max(0.01, Math.min(2, p.turbulence));
    if ('synapticFireRate' in p) p.synapticFireRate = Math.max(0.005, Math.min(0.4, p.synapticFireRate));
    if ('layers' in p) p.layers = Math.max(2, Math.min(14, p.layers));
    if ('quantumUncertainty' in p) p.quantumUncertainty = Math.max(0.05, Math.min(3, p.quantumUncertainty));
    if ('creationRate' in p) p.creationRate = Math.max(0.001, Math.min(0.05, p.creationRate));
    if ('sieveDepth' in p) p.sieveDepth = Math.max(50, Math.min(2000, p.sieveDepth));
    if ('crystallization' in p) p.crystallization = Math.max(0.02, Math.min(1, p.crystallization));
  }

  async _poll() {
    if (!YOUTUBE_TOKEN) return;

    // 1. Get viewer count from broadcast
    try {
      const r = await fetch(`https://www.googleapis.com/youtube/v3/liveBroadcasts?part=liveStreamingDetails&id=${this.config.broadcastId}`,
        { headers: { Authorization: `Bearer ${YOUTUBE_TOKEN}` } });
      if (r.ok) {
        const d = await r.json();
        const count = parseInt(d.items?.[0]?.liveStreamingDetails?.concurrentViewers || '0');
        this.viewerCount = count;
        this.peakViewers = Math.max(this.peakViewers, count);
        this.config.sensory?.viewerEffect?.(count, this.params);
        this._clamp();
      }
    } catch(e) {}

    // 2. Get live chat messages
    if (!this.config.liveChatId) return;
    try {
      const url = new URL('https://www.googleapis.com/youtube/v3/liveChat/messages');
      url.searchParams.set('liveChatId', this.config.liveChatId);
      url.searchParams.set('part', 'snippet,authorDetails');
      url.searchParams.set('maxResults', '200');
      if (this.pageToken) url.searchParams.set('pageToken', this.pageToken);

      const r = await fetch(url, { headers: { Authorization: `Bearer ${YOUTUBE_TOKEN}` } });
      if (!r.ok) return;
      const d = await r.json();
      this.pageToken = d.nextPageToken;
      const msgs = d.items || [];
      if (!msgs.length) return;

      this.allTimeMsgs += msgs.length;
      const texts = [];

      for (const m of msgs) {
        const text = (m.snippet?.displayMessage || '').toLowerCase();
        const author = m.authorDetails?.displayName || 'anon';
        texts.push(text);
        await this._applyKeywords(text, author, m.snippet?.publishedAt);
      }

      // Sentiment analysis via Groq
      if (GROQ_KEY && texts.length) await this._sentiment(texts.join(' '));

    } catch(e) { console.error(`[${this.vcl_id}] poll error:`, e.message); }
  }

  async _applyKeywords(text, author, ts) {
    const kws = this.config.sensory?.keywords || {};
    let mutated = false;
    const before = JSON.stringify(this.params);

    for (const [kw, deltas] of Object.entries(kws)) {
      if (!text.includes(kw)) continue;
      for (const [key, delta] of Object.entries(deltas)) {
        if (typeof this.params[key] === 'number' && typeof delta === 'number') {
          this.params[key] += delta;
          this.brainState[key] = this.params[key];
          mutated = true;
        }
      }
    }

    this._clamp();

    if (mutated && sb) {
      await sb.from('vcl_sensory_log').insert({
        vcl_id: this.vcl_id,
        event_type: 'chat_mutation',
        author,
        message: text.slice(0, 400),
        params_snapshot: { ...this.params },
        viewer_count: this.viewerCount,
        timestamp: ts || new Date().toISOString(),
      }).catch(() => {});
      console.log(`[${this.vcl_id}] Mutation by ${author}: "${text.slice(0,60)}"`);
    }
  }

  async _sentiment(text) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          messages: [{ role: 'user', content: `Sentiment score 0.0-1.0 (0=neg,0.5=neutral,1=pos). Just a number.\n\n${text.slice(0, 400)}` }],
          max_tokens: 8, temperature: 0,
        })
      });
      const d = await r.json();
      const score = parseFloat(d.choices?.[0]?.message?.content?.trim() || '0.5');
      if (!isNaN(score) && score >= 0 && score <= 1) {
        this.config.sensory?.sentimentEffect?.(score, this.params);
        this._clamp();
      }
    } catch(e) {}
  }

  async _persist() {
    if (!sb) return;
    await sb.from('vcl_brain_state').upsert({
      vcl_id: this.vcl_id,
      params: { ...this.brainState },
      total_messages: this.allTimeMsgs,
      peak_viewers: this.peakViewers,
      last_active: new Date().toISOString(),
      session_start: new Date(this.sessionStart).toISOString(),
    }, { onConflict: 'vcl_id' }).catch(e => console.error('[persist]', e.message));
    console.log(`[${this.vcl_id}] Brain persisted | viewers=${this.viewerCount} msgs=${this.allTimeMsgs}`);
  }
}
