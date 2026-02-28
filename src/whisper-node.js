/**
 * Local Whisper Transcription — Pure Node.js
 * Uses @huggingface/transformers with ONNX Runtime (no Python required)
 *
 * Audio pipeline: WebM → sox → WAV → Float32Array@16kHz → Whisper ONNX → text
 * Model auto-downloads on first use, cached locally for subsequent runs.
 */

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync, execFileSync } = require('child_process');

class WhisperNode extends EventEmitter {
  constructor() {
    super();
    this.pipeline = null;
    this.modelId = null;
    this.isLoading = false;
    this.isReady = false;
  }

  /**
   * Map model size names to HuggingFace model IDs
   */
  static getModelId(size = 'base') {
    const models = {
      'tiny': 'onnx-community/whisper-tiny',
      'tiny.en': 'onnx-community/whisper-tiny.en',
      'base': 'onnx-community/whisper-base',
      'base.en': 'onnx-community/whisper-base.en',
      'small': 'onnx-community/whisper-small',
      'small.en': 'onnx-community/whisper-small.en',
      'medium': 'onnx-community/whisper-medium',
      'medium.en': 'onnx-community/whisper-medium.en',
      'large-v3': 'onnx-community/whisper-large-v3-turbo',
    };
    return models[size] || models['base'];
  }

  /**
   * Load the Whisper model. Downloads on first use (~150MB for base).
   * @param {string} modelSize - tiny, base, small, medium, large-v3
   * @param {function} onProgress - Progress callback: (progress) => void
   */
  async load(modelSize = 'base', onProgress = null) {
    if (this.isLoading) return;

    const modelId = WhisperNode.getModelId(modelSize);

    // Already loaded this model
    if (this.isReady && this.modelId === modelId) {
      console.log(`[WhisperNode] Model ${modelSize} already loaded`);
      return;
    }

    this.isLoading = true;
    this.isReady = false;
    this.emit('status', { state: 'loading', model: modelSize });

    try {
      console.log(`[WhisperNode] Loading model: ${modelId}...`);

      const { pipeline, env } = await import('@huggingface/transformers');

      // Set cache directory to user's app data (persistent across updates)
      const cacheDir = path.join(os.homedir(), '.cache', 'claudes-voice-input', 'models');
      env.cacheDir = cacheDir;

      // Ensure cache dir exists
      fs.mkdirSync(cacheDir, { recursive: true });

      console.log(`[WhisperNode] Cache dir: ${cacheDir}`);

      // Create the ASR pipeline with progress tracking (debounced to avoid spam)
      let lastLoggedPct = -1;
      let lastLoggedFile = '';
      const progressCallback = (progress) => {
        if (progress.status === 'progress' && progress.progress != null) {
          const pct = Math.round(progress.progress);
          const file = progress.file || '';

          // Only emit/log on meaningful changes (every 10% or new file)
          if (file !== lastLoggedFile || pct >= lastLoggedPct + 10 || pct === 100) {
            if (onProgress) onProgress({ percent: pct, file });
            this.emit('progress', { percent: pct, file });
            lastLoggedPct = pct;
            lastLoggedFile = file;
          }
        }
        if (progress.status === 'done') {
          console.log(`[WhisperNode] Downloaded: ${progress.file || 'model component'}`);
          lastLoggedPct = -1;
          lastLoggedFile = '';
        }
      };

      this.pipeline = await pipeline('automatic-speech-recognition', modelId, {
        dtype: {
          encoder_model: 'fp32',
          decoder_model_merged: 'q4',
        },
        progress_callback: progressCallback,
      });

      this.modelId = modelId;
      this.isReady = true;
      this.isLoading = false;

      console.log(`[WhisperNode] Model ${modelSize} ready`);
      this.emit('status', { state: 'ready', model: modelSize });
    } catch (err) {
      this.isLoading = false;
      this.isReady = false;
      console.error(`[WhisperNode] Failed to load model:`, err.message);
      this.emit('status', { state: 'error', error: err.message });
      throw err;
    }
  }

  /**
   * Find sox executable (bundled in app or on PATH)
   */
  _findSox() {
    const baseSoxDir = path.join(__dirname, '..', 'sox');
    const soxDirs = [
      baseSoxDir.replace('app.asar', 'app.asar.unpacked'),
      baseSoxDir,
    ];

    for (const dir of soxDirs) {
      const soxPath = path.join(dir, 'sox.exe');
      if (fs.existsSync(soxPath)) return soxPath;
    }

    // Check system PATH
    try {
      const result = execSync('where sox', { stdio: 'pipe', encoding: 'utf8' });
      return result.trim().split('\n')[0].trim();
    } catch {
      return null;
    }
  }

  /**
   * Convert WebM audio buffer to Float32Array at 16kHz mono using sox.
   * sox handles WebM/Opus decoding natively.
   */
  _convertAudioWithSox(audioBuffer, ext = 'webm') {
    const soxPath = this._findSox();
    if (!soxPath) {
      throw new Error('sox.exe not found — needed for audio format conversion');
    }

    const tempIn = path.join(os.tmpdir(), `whisper-in-${Date.now()}.${ext}`);
    const tempOut = path.join(os.tmpdir(), `whisper-out-${Date.now()}.wav`);

    try {
      fs.writeFileSync(tempIn, audioBuffer);

      // Convert to 16kHz mono 16-bit PCM WAV
      execFileSync(soxPath, [
        tempIn,
        '--rate', '16000',
        '--channels', '1',
        '--bits', '16',
        tempOut
      ], { timeout: 30000, windowsHide: true });

      // Read the WAV and extract samples
      const WaveFile = require('wavefile').WaveFile;
      const wavBuffer = fs.readFileSync(tempOut);
      const wav = new WaveFile(wavBuffer);
      wav.toBitDepth('32f');

      let samples = wav.getSamples();
      if (Array.isArray(samples)) {
        samples = samples[0]; // mono — take first channel
      }

      return new Float32Array(samples);
    } finally {
      try { fs.unlinkSync(tempIn); } catch {}
      try { fs.unlinkSync(tempOut); } catch {}
    }
  }

  /**
   * Transcribe audio.
   * Accepts either:
   *   - Array/Float32Array of raw PCM samples at 16kHz (from renderer ScriptProcessor)
   *   - Buffer of encoded audio (WebM/WAV) — converted via sox
   *
   * @param {Array|Float32Array|Buffer} audioInput - Audio data
   * @param {object} options - { language: 'en' }
   * @returns {Promise<{text: string, duration: number, processing_time: number}>}
   */
  async transcribe(audioInput, options = {}) {
    if (!this.isReady || !this.pipeline) {
      throw new Error('Whisper model not loaded. Call load() first.');
    }

    const start = Date.now();
    const language = options.language || 'en';
    let samples;

    // Detect input type
    if (Array.isArray(audioInput) || audioInput instanceof Float32Array) {
      // Raw PCM Float32 samples — use directly
      samples = audioInput instanceof Float32Array ? audioInput : new Float32Array(audioInput);
      console.log(`[WhisperNode] Transcribing ${samples.length} PCM samples (${(samples.length / 16000).toFixed(1)}s)...`);
    } else {
      // Encoded audio (WebM/WAV buffer) — convert via sox
      console.log(`[WhisperNode] Transcribing ${audioInput.length} bytes (converting with sox)...`);
      samples = this._convertAudioWithSox(Buffer.from(audioInput));
      const conversionTime = Date.now() - start;
      console.log(`[WhisperNode] Audio converted: ${samples.length} samples (${conversionTime}ms)`);
    }

    // Run Whisper inference with anti-hallucination settings
    const prompt = options.prompt || '';
    const generateKwargs = {
      language,
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
      max_new_tokens: 128,           // Cap output length (prevents infinite loops)
      no_repeat_ngram_size: 3,       // Block repeating 3-grams ("sound of the sound of the...")
      repetition_penalty: 1.2,       // Penalize repeated tokens
    };

    const result = await this.pipeline(samples, generateKwargs);

    const processingTime = (Date.now() - start) / 1000;
    const duration = samples.length / 16000;
    let text = (result.text || '').trim();

    // Post-process: detect and strip hallucinated repetitive output
    text = this._filterHallucinations(text);

    // Fix common proper noun misrecognitions
    text = this._fixVocabulary(text);

    console.log(`[WhisperNode] Done in ${processingTime.toFixed(2)}s: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);

    return {
      text,
      language,
      duration: Math.round(duration * 100) / 100,
      processing_time: Math.round(processingTime * 1000) / 1000,
    };
  }

  /**
   * Fix common Whisper misrecognitions of proper nouns and domain vocabulary.
   * Whisper base/small models consistently get these wrong.
   */
  _fixVocabulary(text) {
    if (!text) return text;

    const replacements = [
      // "Claude" proper noun — Whisper hears "cloud", "clod", "claud", "cod"
      [/\bCloud('s|s)?\b/g, (m, s) => `Claude${s || ''}`],     // Cloud/Cloud's → Claude/Claude's
      [/\bcloud('s|s)?\s+(code|desktop|voice|input|OS)\b/gi, (m, s, w) => `Claude${s || ''} ${w}`],
      [/\bClaud\b/g, 'Claude'],
      [/\bCloud\s*OS\b/gi, 'ClaudeOS'],
      [/\bClaude\s*OS\b/g, 'ClaudeOS'],         // normalize spacing

      // Tech terms Whisper mangles
      [/\bwisper\b/gi, 'Whisper'],
      [/\bwispher\b/gi, 'Whisper'],
      [/\bwhispher\b/gi, 'Whisper'],
      [/\bONNX\b/gi, 'ONNX'],                   // case normalization
    ];

    for (const [pattern, replacement] of replacements) {
      text = text.replace(pattern, replacement);
    }

    return text;
  }

  /**
   * Detect and filter Whisper hallucinations (repetitive nonsense).
   * Common patterns: "the sound of the sound of...", "[Music]", "Thank you for watching"
   */
  _filterHallucinations(text) {
    if (!text) return text;

    // Remove common Whisper hallucination phrases
    const hallucinations = [
      /\[Music\]/gi,
      /\[Applause\]/gi,
      /Thank you for watching[.!]?/gi,
      /Thanks for watching[.!]?/gi,
      /Please subscribe[.!]?/gi,
      /Like and subscribe[.!]?/gi,
      /See you in the next (video|one)[.!]?/gi,
    ];
    for (const pattern of hallucinations) {
      text = text.replace(pattern, '').trim();
    }

    // Detect repetitive loops: split into words and check for repeating sequences
    const words = text.split(/\s+/);
    if (words.length > 15) {
      // Check if any 3-6 word phrase repeats more than 3 times
      for (let phraseLen = 3; phraseLen <= 6; phraseLen++) {
        const phraseCounts = {};
        for (let i = 0; i <= words.length - phraseLen; i++) {
          const phrase = words.slice(i, i + phraseLen).join(' ').toLowerCase();
          phraseCounts[phrase] = (phraseCounts[phrase] || 0) + 1;
        }
        for (const [phrase, count] of Object.entries(phraseCounts)) {
          if (count >= 3) {
            console.log(`[WhisperNode] Hallucination detected: "${phrase}" repeated ${count}x — discarding`);
            return ''; // Discard entirely — it's hallucinated
          }
        }
      }
    }

    return text;
  }

  /**
   * Release model from memory
   */
  async release() {
    if (this.pipeline) {
      // transformers.js pipeline doesn't have an explicit dispose,
      // but setting to null allows GC
      this.pipeline = null;
      this.modelId = null;
      this.isReady = false;
      console.log('[WhisperNode] Released');
    }
  }
}

module.exports = WhisperNode;
