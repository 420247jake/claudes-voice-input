/**
 * Wake Word Detection Module
 * Uses custom ONNX-based openWakeWord engine — no API keys required
 * Trained "hey_claude" model, 100% local processing
 *
 * Pipeline: Audio → Melspectrogram → Embedding → Wake Word Score
 * Models: melspectrogram.onnx, embedding_model.onnx, hey_claude.onnx, silero_vad.onnx
 */

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');

class WakeWordDetector extends EventEmitter {
  constructor(options = {}) {
    super();

    this.keyword = options.keyword || 'hey_claude';
    this.sensitivity = options.sensitivity || 0.5;
    this.vadThreshold = options.vadThreshold || 0.3;

    // Models directory — resolve to unpacked path when running from ASAR
    const defaultModelsPath = path.join(__dirname, '..', 'models');
    this.modelsPath = options.modelsPath || defaultModelsPath.replace('app.asar', 'app.asar.unpacked');

    // ONNX sessions
    this.melSession = null;
    this.embeddingSession = null;
    this.wakeWordSession = null;
    this.vadSession = null;

    // Pipeline buffers
    this.melBuffer = [];
    this.embeddingBuffer = [];
    this.vadState = { h: null, c: null };

    // Constants from openWakeWord
    this.SAMPLE_RATE = 16000;
    this.FRAME_SIZE = 1280; // 80ms at 16kHz
    this.MEL_BINS = 32;
    this.MEL_FRAMES_REQUIRED = 76;
    this.EMBEDDINGS_REQUIRED = 16;
    this.EMBEDDING_SIZE = null;

    // State
    this.isLoaded = false;
    this.isListening = false;
    this.isPaused = false;
    this.soxProcess = null;
    this.audioStream = null;
    this.frameCount = 0;

    // ort loaded lazily
    this.ort = null;
  }

  /**
   * Initialize — load ONNX models
   */
  async init() {
    try {
      this.ort = require('onnxruntime-node');

      // hey_claude.onnx — custom trained via openWakeWord (15k samples, 75k steps, layer_size=64)
      let wakeWordModelPath = path.join(this.modelsPath, 'hey_claude.onnx');
      let wakeWordModelName = 'hey_claude';

      const modelFiles = {
        mel: path.join(this.modelsPath, 'melspectrogram.onnx'),
        embedding: path.join(this.modelsPath, 'embedding_model.onnx'),
        wakeWord: wakeWordModelPath,
        vad: path.join(this.modelsPath, 'silero_vad.onnx')
      };

      // Verify all models exist
      for (const [name, modelPath] of Object.entries(modelFiles)) {
        if (!fs.existsSync(modelPath)) {
          throw new Error(`Wake word model not found: ${name} at ${modelPath}`);
        }
      }

      console.log('[WakeWord] Loading ONNX models...');

      this.melSession = await this.ort.InferenceSession.create(modelFiles.mel);
      this.embeddingSession = await this.ort.InferenceSession.create(modelFiles.embedding);
      this.wakeWordSession = await this.ort.InferenceSession.create(modelFiles.wakeWord);
      this.vadSession = await this.ort.InferenceSession.create(modelFiles.vad);

      // Store dynamic tensor names (differ between hey_claude and hey_jarvis models)
      this.wwInputName = this.wakeWordSession.inputNames[0];
      this.wwOutputName = this.wakeWordSession.outputNames[0];
      console.log(`[WakeWord] Wake word model: ${wakeWordModelName} (input: ${this.wwInputName}, output: ${this.wwOutputName})`);

      // Initialize VAD state (Silero LSTM)
      const zeros = new Float32Array(2 * 64).fill(0);
      this.vadState = {
        h: new this.ort.Tensor('float32', zeros, [2, 1, 64]),
        c: new this.ort.Tensor('float32', zeros, [2, 1, 64])
      };

      this.isLoaded = true;
      console.log('[WakeWord] All models loaded — wake word detection ready');

      return true;
    } catch (err) {
      console.error('[WakeWord] Init error:', err.message);
      this.emit('error', err);
      return false;
    }
  }

  /**
   * Start listening for wake word via microphone
   */
  async start() {
    if (this.isListening) return;

    if (!this.isLoaded) {
      const ok = await this.init();
      if (!ok) return;
    }

    // Clear stale pipeline buffers from previous session — critical for restart
    // Without this, the model sees old audio data and can't detect the wake word
    this.melBuffer = [];
    this.embeddingBuffer = [];
    this.frameCount = 0;

    // Reset VAD LSTM state (stale hidden state confuses voice detection)
    if (this.ort) {
      const zeros = new Float32Array(2 * 64).fill(0);
      this.vadState = {
        h: new this.ort.Tensor('float32', zeros, [2, 1, 64]),
        c: new this.ort.Tensor('float32', zeros, [2, 1, 64])
      };
    }

    try {
      // Ensure sox is in PATH
      const baseSoxDir = path.join(__dirname, '..', 'sox');
      const soxDirs = [
        baseSoxDir.replace('app.asar', 'app.asar.unpacked'),           // packaged app (unpacked)
        baseSoxDir,                                                     // dev mode
        path.join(__dirname, '..', '..', 'node-wakeword', 'sox-14.4.2') // dev: sibling folder
      ];
      let soxFound = false;
      for (const soxDir of soxDirs) {
        if (fs.existsSync(path.join(soxDir, 'sox.exe'))) {
          if (!process.env.PATH.includes(soxDir)) {
            process.env.PATH = soxDir + ';' + process.env.PATH;
            console.log('[WakeWord] Added sox to PATH:', soxDir);
          }
          soxFound = true;
          break;
        }
      }
      if (!soxFound) {
        // Check if sox is already on system PATH
        const { execSync } = require('child_process');
        try {
          execSync('where sox', { stdio: 'pipe' });
          soxFound = true;
          console.log('[WakeWord] sox found on system PATH');
        } catch {
          console.error('[WakeWord] sox.exe not found! Wake word detection requires sox for audio capture.');
          this.isListening = false;
          this.emit('error', new Error('sox.exe not found. Install SoX or place it in the sox/ folder.'));
          return;
        }
      }

      const { spawn } = require('child_process');

      this.isListening = true;
      this.isPaused = false;
      this.emit('listening', true);

      console.log('[WakeWord] Starting microphone listener...');

      // Spawn sox directly with Windows waveaudio driver (--default-device doesn't work on Windows)
      const soxArgs = [
        '-t', 'waveaudio', 'default',  // Windows audio input
        '--no-show-progress',
        '--rate', String(this.SAMPLE_RATE),
        '--channels', '1',
        '--encoding', 'signed-integer',
        '--bits', '16',
        '--type', 'raw',
        '-'                              // pipe to stdout
      ];

      this.soxProcess = spawn('sox', soxArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
      this.audioStream = this.soxProcess.stdout;

      this.soxProcess.stderr.on('data', (chunk) => {
        console.log('[WakeWord] sox stderr:', chunk.toString().trim());
      });

      this.soxProcess.on('error', (err) => {
        console.error('[WakeWord] sox process error:', err.message);
        this.isListening = false;
        this.emit('error', new Error(`sox failed to start: ${err.message}`));
      });

      this.soxProcess.on('close', (code) => {
        if (code && code !== 0 && this.isListening) {
          console.error(`[WakeWord] sox exited with code ${code}`);
          this.isListening = false;
          this.emit('error', new Error(`sox exited with code ${code}`));
        }
      });

      let frameBuffer = Buffer.alloc(0);
      const frameByteSize = this.FRAME_SIZE * 2; // 16-bit PCM = 2 bytes/sample

      let dataChunkCount = 0;
      this.audioStream.on('data', async (chunk) => {
        if (!this.isListening || this.isPaused) return;

        dataChunkCount++;
        if (dataChunkCount === 1) {
          console.log(`[WakeWord] First audio chunk received: ${chunk.length} bytes`);
        }

        frameBuffer = Buffer.concat([frameBuffer, chunk]);

        while (frameBuffer.length >= frameByteSize) {
          const frame = frameBuffer.slice(0, frameByteSize);
          frameBuffer = frameBuffer.slice(frameByteSize);

          // Convert 16-bit PCM to float32
          const samples = new Float32Array(this.FRAME_SIZE);
          for (let i = 0; i < this.FRAME_SIZE; i++) {
            samples[i] = frame.readInt16LE(i * 2) / 32768.0;
          }

          try {
            await this.processFrame(samples);
          } catch (err) {
            if (this.frameCount <= 5) {
              console.error('[WakeWord] Frame error:', err.message || err);
            }
          }
        }
      });

      this.audioStream.on('error', (err) => {
        console.error('[WakeWord] Audio stream error:', err.message);
        this.emit('error', err);
      });

      console.log('[WakeWord] Now listening for "Hey Claude"...');

    } catch (err) {
      console.error('[WakeWord] Start error:', err.message);
      this.isListening = false;
      this.emit('error', err);
    }
  }

  /**
   * Process a single audio frame through the full pipeline
   */
  async processFrame(samples) {
    if (!this.isListening) return;
    this.frameCount++;

    // Periodic debug: confirm audio is flowing and show scores
    if (this.frameCount === 1) {
      const maxVal = Math.max(...samples.slice(0, 100));
      console.log(`[WakeWord] First frame received, max sample value: ${maxVal.toFixed(4)}`);
    }

    // Stage 1: Audio → Melspectrogram
    if (!this.melSession) return;
    const inputTensor = new this.ort.Tensor('float32', samples, [1, samples.length]);
    const melResults = await this.melSession.run({ input: inputTensor });
    if (!this.isListening) return; // stopped during inference
    const melOutput = new Float32Array(melResults.output.data);
    const dims = melResults.output.dims; // [1, 1, 5, 32]
    const numFrames = dims[2];
    const melBins = dims[3];

    for (let f = 0; f < numFrames; f++) {
      const frame = new Float32Array(melBins);
      for (let b = 0; b < melBins; b++) {
        frame[b] = (melOutput[f * melBins + b] / 10.0) + 2.0;
      }
      this.melBuffer.push(frame);
    }

    // Stage 2: Mel → Embeddings (need 76 mel frames)
    while (this.melBuffer.length >= this.MEL_FRAMES_REQUIRED) {
      const melWindow = this.melBuffer.slice(0, this.MEL_FRAMES_REQUIRED);
      const flatMel = new Float32Array(this.MEL_FRAMES_REQUIRED * this.MEL_BINS);

      for (let i = 0; i < this.MEL_FRAMES_REQUIRED; i++) {
        for (let j = 0; j < this.MEL_BINS; j++) {
          flatMel[i * this.MEL_BINS + j] = melWindow[i][j];
        }
      }

      if (!this.embeddingSession) return;
      const embInput = new this.ort.Tensor('float32', flatMel, [1, this.MEL_FRAMES_REQUIRED, this.MEL_BINS, 1]);
      const embResults = await this.embeddingSession.run({ 'input_1': embInput });
      if (!this.isListening) return;
      const embData = new Float32Array(embResults['conv2d_19'].data);

      if (!this.EMBEDDING_SIZE) this.EMBEDDING_SIZE = embData.length;

      this.embeddingBuffer.push(Array.from(embData));
      this.melBuffer.splice(0, 8); // Slide by 8

      // Stage 3: Check wake word (need 16 embeddings)
      if (this.embeddingBuffer.length >= this.EMBEDDINGS_REQUIRED) {
        const recent = this.embeddingBuffer.slice(-this.EMBEDDINGS_REQUIRED);
        const embSize = this.EMBEDDING_SIZE;
        const flat = new Float32Array(this.EMBEDDINGS_REQUIRED * embSize);

        for (let i = 0; i < this.EMBEDDINGS_REQUIRED; i++) {
          for (let j = 0; j < embSize; j++) {
            flat[i * embSize + j] = recent[i][j] || 0;
          }
        }

        if (!this.wakeWordSession) return;
        const wwInput = new this.ort.Tensor('float32', flat, [1, this.EMBEDDINGS_REQUIRED, embSize]);
        const wwResults = await this.wakeWordSession.run({ [this.wwInputName]: wwInput });
        if (!this.isListening) return;
        let score = wwResults[this.wwOutputName].data[0];

        // Model output is already post-sigmoid (0-1 range, ~0.5 = baseline)

        // VAD check
        if (!this.vadSession) return;
        const vadInput = new this.ort.Tensor('float32', samples, [1, samples.length]);
        const srTensor = new this.ort.Tensor('int64', BigInt64Array.from([BigInt(this.SAMPLE_RATE)]), []);
        const vadResults = await this.vadSession.run({
          input: vadInput,
          sr: srTensor,
          h: this.vadState.h,
          c: this.vadState.c
        });
        if (!this.isListening) return;
        this.vadState.h = vadResults.hn;
        this.vadState.c = vadResults.cn;
        const vadScore = vadResults.output.data[0];

        // Debug: log scores periodically
        if (this.frameCount % 50 === 0) {
          console.log(`[WakeWord] Frame ${this.frameCount}: WW=${score.toFixed(4)} VAD=${vadScore.toFixed(4)} threshold=${this.sensitivity}`);
        }
        // Log whenever score is elevated (potential detection)
        if (score > 0.1) {
          console.log(`[WakeWord] ⚡ Elevated score: WW=${score.toFixed(4)} VAD=${vadScore.toFixed(4)}`);
        }

        // Detection! High-confidence WW scores (>0.8) bypass VAD check since
        // the pipeline delay means VAD is checking audio after the wake word ended
        const vadOk = score >= 0.8 || vadScore >= this.vadThreshold;
        if (score >= this.sensitivity && vadOk) {
          console.log(`[WakeWord] Detected "Hey Claude"! (score: ${score.toFixed(3)}, vad: ${vadScore.toFixed(3)})`);
          this.emit('detected', { keyword: 'hey claude', score, vadScore });

          // Reset buffers to prevent repeat triggers
          this.embeddingBuffer = [];
          this.melBuffer = [];
        }

        // Keep buffer bounded — trim to EMBEDDINGS_REQUIRED + small headroom
        while (this.embeddingBuffer.length > this.EMBEDDINGS_REQUIRED + 4) {
          this.embeddingBuffer.shift();
        }
      }
    }
  }

  /**
   * Stop listening
   */
  stop() {
    if (!this.isListening) return;

    this.isListening = false;
    this.emit('listening', false);

    if (this.audioStream) {
      this.audioStream.removeAllListeners('data');
      this.audioStream.destroy();
      this.audioStream = null;
    }
    if (this.soxProcess) {
      try { this.soxProcess.kill(); } catch {}
      this.soxProcess = null;
    }

    console.log('[WakeWord] Stopped listening');
  }

  /**
   * Pause listening (e.g., while recording speech)
   */
  pause() {
    this.isPaused = true;
  }

  /**
   * Resume listening after pause
   */
  resume() {
    this.isPaused = false;
  }

  /**
   * Release all resources
   */
  release() {
    this.stop();
    this.melSession = null;
    this.embeddingSession = null;
    this.wakeWordSession = null;
    this.vadSession = null;
    this.melBuffer = [];
    this.embeddingBuffer = [];
    this.isLoaded = false;
    console.log('[WakeWord] Released');
  }
}

module.exports = WakeWordDetector;
