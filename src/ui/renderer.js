/**
 * Claude's Voice Input - Renderer Process
 * Full-featured voice input with all settings
 * Uses PowerShell + Win32 API for pasting into Claude Desktop
 */

const { ipcRenderer, clipboard } = require('electron');

// State
let config = {};
let isRecording = false;
let debugMode = false;
let languages = {};
let recordingTimer = null;
let recordingSeconds = 0;

// Audio
let audioContext = null;
let mediaStream = null;
let mediaRecorder = null;
let audioChunks = [];
let analyser = null;
let pcmChunks = [];       // Raw Float32 PCM for local Whisper (no WebM decode needed)
let scriptProcessor = null;
let isTranscribing = false; // Guard against rapid-fire transcription calls

// VAD
let vadActive = false;
let silenceTimeout = null;
let lastSoundTime = 0;
let speechDetected = false;
let vadCheckInterval = null;
let vadLogCounter = 0;          // Frame counter for periodic VAD debug logging
let wakeWordTriggered = false;  // Track if current recording was triggered by wake word
let maxRecordingTimeout = null; // Safety timeout for recordings
let vadGracePeriod = false;     // Skip VAD checks during grace period after wake word

// Adaptive noise floor calibration
let noiseCalibrationSamples = [];  // Audio levels collected during grace period
let calibratedNoiseFloor = null;   // Ambient level (10th percentile, set after calibration)
let noiseFloorCalibrated = false;  // Whether calibration is complete
let speechStartTime = 0;          // When speech first started (for min speech duration)

// ==================== INITIALIZATION ====================

async function init() {
  config = await ipcRenderer.invoke('get-config');
  languages = await ipcRenderer.invoke('get-languages');
  debugMode = config.debug || false;

  setupEventListeners();
  setupIPCListeners();
  setupOnboarding();
  await loadMicrophones();
  loadLanguages();
  updateUI();
  updateStats();
  loadHistory();

  log('Claude\'s Voice Input initialized');
  log(`Hotkey: ${config.hotkey || 'F9'}`);

  // Show onboarding on first launch
  if (!config.onboardingComplete) {
    showOnboarding();
  }
}

function log(msg) {
  console.log(`[VoiceInput] ${msg}`);
}

// ==================== EVENT LISTENERS ====================

function setupEventListeners() {
  // Window controls
  document.getElementById('btnMinimize').onclick = () => ipcRenderer.send('minimize');
  document.getElementById('btnClose').onclick = () => ipcRenderer.send('close');
  
  // Tab navigation
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.onclick = () => switchTab(btn.dataset.tab);
  });
  
  // Toggles
  setupToggle('toggleAutoSend', 'autoSend');
  setupToggle('toggleAutoPaste', 'autoPaste');
  setupToggle('toggleAudioFeedback', 'audioFeedback');
  setupToggle('toggleAlwaysOnTop', 'alwaysOnTop');
  setupToggle('toggleStartMinimized', 'startMinimized');
  setupToggle('toggleVAD', 'vadEnabled');
  setupToggle('toggleWakeWord', 'wakeWordEnabled', onWakeWordToggle);
  setupToggle('toggleLocalWhisper', 'useLocalWhisper', (enabled) => {
    const el = document.getElementById('whisperServerStatus');
    if (el) {
      el.textContent = enabled ? 'Loading model...' : '● Disabled';
      el.style.color = enabled ? '#fbbf24' : '#9ca3af';
      el.style.background = enabled ? 'rgba(251, 191, 36, 0.1)' : 'rgba(156, 163, 175, 0.1)';
    }
    updateUI();
  });
  setupToggle('toggleClearOnExit', 'clearHistoryOnExit');
  setupToggle('toggleDebug', 'debug');
  
  // Recording mode select
  document.getElementById('recordingModeSelect').onchange = async (e) => {
    await ipcRenderer.invoke('set-config', 'recordingMode', e.target.value);
    config.recordingMode = e.target.value;
    updateRecordingModeUI();
  };
  
  // API Keys
  document.getElementById('btnAddKey').onclick = addApiKey;
  
  // Hotkey capture
  const hotkeyCapture = document.getElementById('hotkeyCapture');
  hotkeyCapture.onclick = () => startHotkeyCapture();
  
  // Microphone select
  document.getElementById('micSelect').onchange = async (e) => {
    await ipcRenderer.invoke('set-config', 'selectedMicId', e.target.value);
    config.selectedMicId = e.target.value;
  };
  
  // Language select
  document.getElementById('languageSelect').onchange = async (e) => {
    await ipcRenderer.invoke('set-config', 'language', e.target.value);
    config.language = e.target.value;
  };
  
  // VAD settings
  document.getElementById('vadSensitivity').onchange = async (e) => {
    await ipcRenderer.invoke('set-config', 'vadSensitivity', parseInt(e.target.value));
    config.vadSensitivity = parseInt(e.target.value);
  };
  
  document.getElementById('vadSilence').onchange = async (e) => {
    await ipcRenderer.invoke('set-config', 'vadSilenceMs', parseInt(e.target.value));
    config.vadSilenceMs = parseInt(e.target.value);
  };
  
  // Local Whisper model
  document.getElementById('localWhisperModel').onchange = async (e) => {
    await ipcRenderer.invoke('set-config', 'localWhisperModel', e.target.value);
    config.localWhisperModel = e.target.value;
    // Model reloads — status updates arrive via IPC events
    if (config.useLocalWhisper) {
      const el = document.getElementById('whisperServerStatus');
      if (el) {
        el.textContent = 'Loading new model...';
        el.style.color = '#fbbf24';
        el.style.background = 'rgba(251, 191, 36, 0.1)';
      }
    }
  };
  
  // Wake Word Settings
  document.getElementById('wakeWordSensitivity').onchange = async (e) => {
    const val = parseInt(e.target.value) / 100; // Convert 0-100 to 0-1
    await ipcRenderer.invoke('set-config', 'wakeWordSensitivity', val);
    config.wakeWordSensitivity = val;
  };

  document.getElementById('btnTestWakeWord').onclick = testWakeWord;
  
  // Clear history
  document.getElementById('btnClearHistory').onclick = clearHistory;
}

function setupToggle(elementId, configKey, callback) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.onclick = async () => {
    config[configKey] = !config[configKey];
    await ipcRenderer.invoke('set-config', configKey, config[configKey]);
    updateToggle(el, config[configKey]);
    log(`${configKey}: ${config[configKey]}`);
    if (callback) callback(config[configKey]);
  };
}

function updateToggle(el, value) {
  if (value) el.classList.add('active');
  else el.classList.remove('active');
}

// ==================== IPC LISTENERS ====================

function setupIPCListeners() {
  ipcRenderer.on('recording-started', async (_, data) => {
    const isWakeWord = data?.wakeWord === true;
    log('Recording started' + (isWakeWord ? ' (wake word triggered)' : ''));
    isRecording = true;
    wakeWordTriggered = isWakeWord;
    recordingSeconds = 0;

    // Reset VAD state
    speechDetected = false;
    lastSoundTime = 0;
    speechStartTime = 0;
    vadLogCounter = 0;
    vadGracePeriod = isWakeWord;  // Grace period for wake word recordings
    noiseCalibrationSamples = [];
    calibratedNoiseFloor = null;
    noiseFloorCalibrated = false;
    if (silenceTimeout) {
      clearTimeout(silenceTimeout);
      silenceTimeout = null;
    }
    if (isWakeWord) {
      // After wake word, give 3s grace for user to start speaking before VAD kicks in
      log('VAD: 3s grace period (wake word trigger)');
      setTimeout(() => {
        if (isRecording && !speechDetected) {
          // User hasn't spoken yet after 3s — start watching for speech then silence
          speechDetected = true;
          lastSoundTime = Date.now();
          speechStartTime = Date.now(); // Must set so min-speech-duration check works
          log('VAD: Grace period ended, enabling auto-stop');
        }
        vadGracePeriod = false;
      }, 3000);
    }

    // Safety: max recording timeout (5 min) — last-resort cap, VAD handles normal stopping
    if (maxRecordingTimeout) clearTimeout(maxRecordingTimeout);
    maxRecordingTimeout = setTimeout(() => {
      if (isRecording) {
        log('Max recording timeout (300s) — auto-stopping');
        ipcRenderer.send('vad-stop');
      }
      maxRecordingTimeout = null;
    }, 300000);

    startRecordingTimer();
    document.getElementById('micIcon').classList.add('recording');
    document.getElementById('statusText').textContent = config.vadEnabled ? 'Listening...' : 'Recording...';
    document.getElementById('audioLevelContainer').style.display = 'block';
    document.getElementById('recordingTimer').classList.add('active');

    await startRecording();
  });

  ipcRenderer.on('recording-stopped', async (_, data) => {
    log(`Recording stopped (${data?.duration?.toFixed(1)}s)`);
    isRecording = false;
    wakeWordTriggered = false;
    vadGracePeriod = false;
    if (maxRecordingTimeout) { clearTimeout(maxRecordingTimeout); maxRecordingTimeout = null; }
    stopRecordingTimer();
    document.getElementById('micIcon').classList.remove('recording');
    document.getElementById('statusText').textContent = 'Processing...';
    document.getElementById('audioLevelContainer').style.display = 'none';
    document.getElementById('audioLevel').style.width = '0%';
    document.getElementById('recordingTimer').classList.remove('active');

    await stopRecording();
    // Note: transcription is triggered by the separate 'transcribe' event from main
  });

  ipcRenderer.on('transcribe', async () => {
    // Small delay to ensure recording-stopped handler has finished (mediaRecorder.onstop)
    await new Promise(r => setTimeout(r, 100));
    log('Starting transcription...');
    await processTranscription();
  });

  ipcRenderer.on('play-sound', (_, type) => {
    if (config.audioFeedback) playSound(type);
  });

  ipcRenderer.on('show-settings', () => {
    switchTab('settings');
  });
  
  // Wake word events
  ipcRenderer.on('wake-word-detected', (_, data) => {
    log(`Wake word detected: ${data.keyword}`);
    showToast(`"${data.keyword}" detected!`, 'success');
  });
  
  ipcRenderer.on('wake-word-listening', (_, isListening) => {
    const statusText = document.getElementById('wakeWordStatusText');
    if (statusText) {
      statusText.textContent = isListening ? 'Listening...' : 'Stopped';
    }
  });
  
  ipcRenderer.on('wake-word-error', (_, error) => {
    log(`Wake word error: ${error}`);
    showToast(`Wake word error: ${error}`, 'error');
    const statusText = document.getElementById('wakeWordStatusText');
    if (statusText) {
      statusText.textContent = `Error: ${error}`;
    }
  });

  // Whisper model download progress (show model size for context)
  ipcRenderer.on('whisper-model-progress', (_, data) => {
    const el = document.getElementById('whisperServerStatus');
    if (el) {
      const model = config.localWhisperModel || 'small';
      const size = WHISPER_MODEL_SIZES[model] || '';
      el.textContent = `Downloading ${size ? '(' + size + ') ' : ''}${data.percent}%`;
      el.style.color = '#fbbf24';
      el.style.background = 'rgba(251, 191, 36, 0.1)';
    }
  });

  // Whisper model status updates (loading/ready/error)
  ipcRenderer.on('whisper-server-status', (_, data) => {
    const el = document.getElementById('whisperServerStatus');
    if (!el) return;
    if (data.running || data.state === 'ready') {
      el.textContent = `● Ready (${data.model || 'base'})`;
      el.style.color = '#4ade80';
      el.style.background = 'rgba(74, 222, 128, 0.1)';
    } else if (data.state === 'loading') {
      el.textContent = 'Loading model...';
      el.style.color = '#fbbf24';
      el.style.background = 'rgba(251, 191, 36, 0.1)';
    } else if (data.error) {
      el.textContent = `Error: ${data.error}`;
      el.style.color = '#f87171';
      el.style.background = 'rgba(248, 113, 113, 0.1)';
    } else {
      el.textContent = '● Not loaded';
      el.style.color = '#9ca3af';
      el.style.background = 'rgba(156, 163, 175, 0.1)';
    }
  });
}

// ==================== TAB NAVIGATION ====================

function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  document.querySelectorAll('.tab-page').forEach(page => {
    page.classList.toggle('active', page.id === `tab-${tabId}`);
  });
  
  if (tabId === 'history') loadHistory();
  if (tabId === 'settings') loadApiKeys();
}

// ==================== UI UPDATES ====================

function updateUI() {
  // Hotkey badge & recording hint (dynamic based on mode)
  const hotkey = config.hotkey || 'F9';
  const mode = config.recordingMode || 'push-to-talk';
  document.getElementById('hotkeyBadge').textContent = hotkey;
  document.getElementById('hotkeyCapture').textContent = hotkey;
  const hintEl = document.querySelector('.hotkey-hint');
  if (hintEl) {
    if (mode === 'wake-word') {
      hintEl.innerHTML = `Say <span class="hotkey-badge">"Hey Claude"</span> or hold <span class="hotkey-badge">${hotkey}</span>`;
    } else if (mode === 'tap-to-talk') {
      hintEl.innerHTML = `Tap <span class="hotkey-badge">${hotkey}</span> to record (auto-stops)`;
    } else {
      hintEl.innerHTML = `Hold <span class="hotkey-badge" id="hotkeyBadge">${hotkey}</span> to record`;
    }
  }
  
  // Toggles
  updateToggle(document.getElementById('toggleAutoSend'), config.autoSend);
  updateToggle(document.getElementById('toggleAutoPaste'), config.autoPaste !== false);
  updateToggle(document.getElementById('toggleAudioFeedback'), config.audioFeedback);
  updateToggle(document.getElementById('toggleAlwaysOnTop'), config.alwaysOnTop);
  updateToggle(document.getElementById('toggleStartMinimized'), config.startMinimized);
  updateToggle(document.getElementById('toggleVAD'), config.vadEnabled);
  updateToggle(document.getElementById('toggleLocalWhisper'), config.useLocalWhisper);
  updateToggle(document.getElementById('toggleClearOnExit'), config.clearHistoryOnExit);
  updateToggle(document.getElementById('toggleDebug'), config.debug);
  
  // VAD settings
  document.getElementById('vadSensitivity').value = config.vadSensitivity || 25;
  document.getElementById('vadSilence').value = config.vadSilenceMs || 3500;
  
  // Recording mode
  document.getElementById('recordingModeSelect').value = config.recordingMode || 'push-to-talk';
  
  // Wake word settings
  updateToggle(document.getElementById('toggleWakeWord'), config.wakeWordEnabled);
  document.getElementById('wakeWordSensitivity').value = (config.wakeWordSensitivity || 0.5) * 100;

  // Auto-start wake word if it was enabled
  if (config.wakeWordEnabled) {
    console.log('[UI] Auto-starting wake word detection...');
    onWakeWordToggle(true);
  }

  // Update recording mode UI hint
  updateRecordingModeUI();
  
  // Local Whisper
  document.getElementById('localWhisperModel').value = config.localWhisperModel || 'small';
  checkWhisperServerStatus();

  // Status
  const hasKey = config.apiKeys && config.apiKeys.length > 0;
  const statusDot = document.getElementById('statusDot');
  const connectionStatus = document.getElementById('connectionStatus');
  
  if (hasKey || config.useLocalWhisper) {
    statusDot.classList.remove('offline');
    const modeLabel = mode === 'wake-word' ? 'Wake Word Active' : (config.useLocalWhisper ? 'Local Whisper' : 'API Ready');
    connectionStatus.textContent = modeLabel;
  } else {
    statusDot.classList.add('offline');
    connectionStatus.textContent = 'No API Key';
  }
  
  // Language select
  const langSelect = document.getElementById('languageSelect');
  langSelect.value = config.language || 'en';
  
  // Mic select
  const micSelect = document.getElementById('micSelect');
  if (config.selectedMicId) {
    micSelect.value = config.selectedMicId;
  }
  
  loadApiKeys();
}

async function checkWhisperServerStatus() {
  const el = document.getElementById('whisperServerStatus');
  if (!el) return;

  try {
    const result = await ipcRenderer.invoke('check-local-whisper');
    if (result && result.status === 'ok') {
      el.textContent = `● Ready (${result.model})`;
      el.style.color = '#4ade80';
      el.style.background = 'rgba(74, 222, 128, 0.1)';
    } else if (result && result.status === 'loading') {
      el.textContent = 'Loading model...';
      el.style.color = '#fbbf24';
      el.style.background = 'rgba(251, 191, 36, 0.1)';
    } else {
      el.textContent = '● Not loaded';
      el.style.color = '#9ca3af';
      el.style.background = 'rgba(156, 163, 175, 0.1)';
    }
  } catch {
    el.textContent = '● Error';
    el.style.color = '#f87171';
    el.style.background = 'rgba(248, 113, 113, 0.1)';
  }
}

async function updateStats() {
  const stats = await ipcRenderer.invoke('get-stats');

  document.getElementById('statCount').textContent = stats.totalTranscriptions || 0;

  const totalSeconds = stats.totalAudioSeconds || 0;
  const mins = Math.floor(totalSeconds / 60);
  const secs = Math.floor(totalSeconds % 60);
  document.getElementById('statTime').textContent = `${mins}:${secs.toString().padStart(2, '0')}`;

  // Show cost for API users, "Free" badge for local Whisper users
  const costEl = document.getElementById('statCost');
  const costLabel = document.getElementById('statCostLabel');
  if (config.useLocalWhisper) {
    costEl.textContent = 'Local';
    costEl.style.fontSize = '14px';
    costLabel.textContent = 'Engine';
  } else {
    costEl.textContent = `$${(stats.totalCostEstimate || 0).toFixed(3)}`;
    costEl.style.fontSize = '';
    costLabel.textContent = 'Est. Cost';
  }
}

// ==================== RECORDING ====================

async function startRecording() {
  audioChunks = [];
  
  try {
    const constraints = {
      audio: {
        channelCount: 1,
        sampleRate: 16000
      }
    };
    
    // Use selected mic if set
    if (config.selectedMicId) {
      constraints.audio.deviceId = { exact: config.selectedMicId };
    }
    
    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    
    // Setup audio context for visualization
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(mediaStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    // Capture raw PCM for local Whisper (avoids WebM decode issues)
    pcmChunks = [];
    if (config.useLocalWhisper) {
      scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
      scriptProcessor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        pcmChunks.push(new Float32Array(input));
      };
      source.connect(scriptProcessor);
      scriptProcessor.connect(audioContext.destination);
    }

    visualizeAudio();

    // Setup MediaRecorder (always, for API Whisper fallback)
    mediaRecorder = new MediaRecorder(mediaStream, {
      mimeType: 'audio/webm;codecs=opus'
    });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.start(100);
    log('Recording started');
    
  } catch (err) {
    log(`Mic error: ${err.message}`);
    document.getElementById('statusText').textContent = 'Mic access denied';

    // If mic failed and this was wake-word triggered, restart wake word listening
    if (wakeWordTriggered && config.wakeWordEnabled) {
      log('[WakeWord] Mic failed, restarting wake word detection...');
      isRecording = false;
      wakeWordTriggered = false;
      if (maxRecordingTimeout) { clearTimeout(maxRecordingTimeout); maxRecordingTimeout = null; }
      setTimeout(async () => {
        try {
          await ipcRenderer.invoke('wake-word-resume');
        } catch (e) {
          log('[WakeWord] Restart after mic failure failed:', e.message);
        }
      }, 1000);
    }
  }
}

function visualizeAudio() {
  if (!isRecording || !analyser) return;

  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(dataArray);

  // Full-band level for the visual audio bar (shows all sound)
  const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
  const displayLevel = Math.min(100, (average / 128) * 100);
  document.getElementById('audioLevel').style.width = displayLevel + '%';

  // Speech-band level for VAD (300-3000 Hz only)
  // Ambient noise (fans, HVAC, PC) is mostly below 300 Hz — filtering it out
  // gives a much cleaner speech vs. silence signal
  const sampleRate = audioContext ? audioContext.sampleRate : 48000;
  const binWidth = sampleRate / (analyser.fftSize || 256);
  const lowBin = Math.max(1, Math.ceil(300 / binWidth));
  const highBin = Math.min(dataArray.length - 1, Math.floor(3000 / binWidth));
  let speechSum = 0;
  for (let i = lowBin; i <= highBin; i++) {
    speechSum += dataArray[i];
  }
  const speechBins = highBin - lowBin + 1;
  const level = Math.min(100, ((speechSum / speechBins) / 128) * 100);

  // Noise floor calibration using speech-band level
  if (!noiseFloorCalibrated) {
    noiseCalibrationSamples.push(level);
    if (noiseCalibrationSamples.length >= 90) {
      const cleanSamples = noiseCalibrationSamples.slice(30);
      const sorted = [...cleanSamples].sort((a, b) => a - b);
      calibratedNoiseFloor = sorted[Math.floor(sorted.length * 0.1)];
      noiseFloorCalibrated = true;
      log(`VAD: Noise floor calibrated: ${calibratedNoiseFloor.toFixed(1)} (speech-band, 10th pctl, bins ${lowBin}-${highBin})`);
    }
  }

  // VAD logic - auto-stop after silence
  // Force VAD on in wake word mode (recording can't stop otherwise)
  const vadEffective = config.vadEnabled || wakeWordTriggered;
  if (vadEffective && isRecording && !vadGracePeriod) {
    const configThreshold = config.vadSensitivity || 25;
    const silenceMs = config.vadSilenceMs || 3500;

    // Adaptive threshold: noise floor + margin (speech-band noise is typically very low)
    let threshold = configThreshold;
    if (noiseFloorCalibrated && calibratedNoiseFloor !== null) {
      const adaptiveThreshold = calibratedNoiseFloor + 12;
      threshold = Math.max(configThreshold, adaptiveThreshold);
    }

    // Debug: log VAD state every ~2 seconds
    if (++vadLogCounter % 60 === 0) {
      const qt = lastSoundTime > 0 ? Date.now() - lastSoundTime : -1;
      log(`VAD: speech-lvl=${level.toFixed(1)} display-lvl=${displayLevel.toFixed(1)} threshold=${threshold.toFixed(1)}${noiseFloorCalibrated ? ` floor=${calibratedNoiseFloor.toFixed(1)}` : ''} speech=${speechDetected} quietMs=${qt}`);
    }

    if (level > threshold) {
      // Speech detected
      if (!speechDetected) {
        speechStartTime = Date.now();
        log(`VAD: Speech started (speech-lvl=${level.toFixed(1)}, display-lvl=${displayLevel.toFixed(1)})`);
      }
      speechDetected = true;
      lastSoundTime = Date.now();

      if (silenceTimeout) {
        clearTimeout(silenceTimeout);
        silenceTimeout = null;
      }
    } else if (speechDetected && lastSoundTime > 0 && !silenceTimeout) {
      // We had speech, now it's quiet
      const quietTime = Date.now() - lastSoundTime;
      // If speechStartTime wasn't set (shouldn't happen now), default to allowing stop
      const speechDuration = speechStartTime > 0 ? (Date.now() - speechStartTime) / 1000 : 999;

      // Require at least 2s of speech before allowing auto-stop
      if (quietTime >= silenceMs && speechDuration >= 2) {
        log(`VAD: Silence for ${quietTime}ms after ${speechDuration.toFixed(1)}s speech (lvl=${level.toFixed(1)}, thr=${threshold.toFixed(1)}), auto-stopping...`);
        ipcRenderer.send('vad-stop');
      }
    }
  }

  if (isRecording) requestAnimationFrame(visualizeAudio);
}

async function stopRecording() {
  // Disconnect PCM capture
  if (scriptProcessor) {
    scriptProcessor.disconnect();
    scriptProcessor = null;
  }

  return new Promise((resolve) => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.onstop = () => {
        log(`Stopped. Chunks: ${audioChunks.length}${pcmChunks.length ? ` PCM: ${pcmChunks.length}` : ''}`);
        resolve();
      };
      mediaRecorder.stop();
    } else {
      resolve();
    }

    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop());
    }
  });
}

// ==================== TRANSCRIPTION ====================

async function processTranscription() {
  const statusText = document.getElementById('statusText');
  const transcriptionText = document.getElementById('transcriptionText');

  // Guard against rapid-fire calls (e.g. multiple stop events in quick succession)
  if (isTranscribing) {
    log('Already transcribing, skipping duplicate call');
    return;
  }

  if (audioChunks.length === 0 && pcmChunks.length === 0) {
    log('No audio captured');
    statusText.textContent = 'No audio captured';
    setTimeout(() => { statusText.textContent = 'Ready'; }, 2000);
    return;
  }

  const durationSec = recordingSeconds;

  // Skip very short recordings (< 0.3s) — likely accidental triggers
  if (durationSec < 0.3 && pcmChunks.length < 5) {
    log(`Recording too short (${durationSec}s, ${pcmChunks.length} chunks), skipping`);
    statusText.textContent = 'Too short';
    audioChunks = [];
    pcmChunks = [];
    setTimeout(() => { statusText.textContent = 'Ready'; }, 1500);
    return;
  }

  isTranscribing = true;
  let text = null;

  try {
    statusText.textContent = 'Transcribing...';

    if (config.useLocalWhisper && pcmChunks.length > 0) {
      // Send raw Float32 PCM samples for local Whisper (no format conversion needed)
      const totalLength = pcmChunks.reduce((sum, c) => sum + c.length, 0);
      const pcmData = new Float32Array(totalLength);
      let offset = 0;
      for (const chunk of pcmChunks) {
        pcmData.set(chunk, offset);
        offset += chunk.length;
      }

      // Check audio amplitude to verify we actually captured sound
      let maxAmp = 0;
      for (let i = 0; i < pcmData.length; i++) {
        const abs = Math.abs(pcmData[i]);
        if (abs > maxAmp) maxAmp = abs;
      }
      const srcRate = audioContext ? audioContext.sampleRate : 16000;
      log(`PCM captured: ${pcmData.length} samples at ${srcRate}Hz, maxAmplitude=${maxAmp.toFixed(6)}, duration=${(pcmData.length / srcRate).toFixed(1)}s`);

      if (maxAmp < 0.001) {
        log('WARNING: Audio appears to be silent (maxAmp < 0.001)');
      }

      // Resample to 16kHz if audioContext was running at a different rate
      let samples = pcmData;
      if (audioContext && audioContext.sampleRate !== 16000) {
        const ratio = 16000 / audioContext.sampleRate;
        const newLength = Math.round(pcmData.length * ratio);
        samples = new Float32Array(newLength);
        for (let i = 0; i < newLength; i++) {
          const srcIdx = i / ratio;
          const idx = Math.floor(srcIdx);
          const frac = srcIdx - idx;
          samples[i] = idx + 1 < pcmData.length
            ? pcmData[idx] * (1 - frac) + pcmData[idx + 1] * frac
            : pcmData[idx] || 0;
        }
        log(`Resampled: ${pcmData.length} → ${samples.length} samples (${srcRate}Hz → 16000Hz)`);
      }

      log(`Sending ${samples.length} PCM samples (${(samples.length / 16000).toFixed(1)}s) to local Whisper`);
      // Send as plain array — IPC structured clone handles this fine
      text = await ipcRenderer.invoke('transcribe-local', Array.from(samples));
    } else {
      // Use WebM for API Whisper
      const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
      const arrayBuffer = await audioBlob.arrayBuffer();

      if (config.useLocalWhisper) {
        text = await ipcRenderer.invoke('transcribe-local', arrayBuffer);
      } else {
        text = await ipcRenderer.invoke('transcribe-audio', arrayBuffer, {
          language: config.language
        });
      }
    }
    
    log(`Result: "${text}"`);
  } catch (err) {
    log(`Transcription error: ${err.message}`);
    statusText.textContent = 'Transcription failed';
    showToast(err.message, 'error');
    isTranscribing = false;
    audioChunks = [];
    pcmChunks = [];
    setTimeout(() => { statusText.textContent = 'Ready'; }, 3000);
    return;
  }
  
  // Filter out Whisper's "[BLANK_AUDIO]" marker — means no speech was detected
  if (text) {
    text = text.replace(/\[BLANK_AUDIO\]/g, '').trim();
  }

  if (text && text.trim()) {
    transcriptionText.textContent = text;
    transcriptionText.classList.add('has-text');
    
    // Calculate cost (Whisper API is $0.006 per minute, local is free)
    const cost = config.useLocalWhisper ? 0 : (durationSec / 60) * 0.006;
    
    // Update stats
    await ipcRenderer.invoke('update-stats', { seconds: durationSec, cost });
    await updateStats();
    
    // Add to history
    await ipcRenderer.invoke('add-to-history', {
      text: text.trim(),
      duration: durationSec,
      cost: cost
    });
    
    // Send or copy
    if (config.autoPaste !== false) {
      statusText.textContent = 'Sending to Claude...';
      try {
        await typeIntoClaude(text);
        statusText.textContent = 'Sent!';
        playSound('success');
      } catch (err) {
        log(`Send error: ${err.message}`);
        clipboard.writeText(text.trim());
        statusText.textContent = 'Copied to clipboard';
        showToast('Copied to clipboard (paste manually)', 'success');
      }
    } else {
      clipboard.writeText(text.trim());
      statusText.textContent = 'Copied to clipboard';
      playSound('success');
    }
    
    setTimeout(() => { statusText.textContent = 'Ready'; }, 2000);
  } else {
    transcriptionText.textContent = 'No speech detected';
    statusText.textContent = 'No speech detected';
    playSound('error');
    setTimeout(() => { statusText.textContent = 'Ready'; }, 2000);
  }

  // Clean up
  isTranscribing = false;
  audioChunks = [];
  pcmChunks = [];

  // Restart wake word listening after transcription completes
  if (config.wakeWordEnabled) {
    // Wait for getUserMedia mic to fully release (Windows audio drivers are slow)
    await new Promise(r => setTimeout(r, 1000));
    log('[WakeWord] Restarting wake word detection...');

    // Retry up to 3 times with increasing delays (mic might still be held)
    let resumed = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const result = await ipcRenderer.invoke('wake-word-resume');
        if (result.success) {
          log(`[WakeWord] Wake word detection restarted (attempt ${attempt})`);
          resumed = true;
          break;
        }
      } catch (e) {
        log(`[WakeWord] Resume attempt ${attempt} failed: ${e.message}`);
      }
      // Wait longer between retries
      await new Promise(r => setTimeout(r, 500 * attempt));
    }

    if (!resumed) {
      log('[WakeWord] All resume attempts failed, full reinitialize...');
      await onWakeWordToggle(true);
    }
  }
}

// Type into Claude Desktop via main process (PowerShell + Win32 API)
async function typeIntoClaude(text) {
  // Call main process which uses PowerShell to find and paste into Claude
  await ipcRenderer.invoke('paste-to-claude', text, config.autoSend);
  log('Text pasted to Claude Desktop');
}

// ==================== RECORDING TIMER ====================

function startRecordingTimer() {
  recordingSeconds = 0;
  updateTimerDisplay();
  recordingTimer = setInterval(() => {
    recordingSeconds++;
    updateTimerDisplay();
  }, 1000);
}

function stopRecordingTimer() {
  if (recordingTimer) {
    clearInterval(recordingTimer);
    recordingTimer = null;
  }
}

function updateTimerDisplay() {
  const mins = Math.floor(recordingSeconds / 60);
  const secs = recordingSeconds % 60;
  document.getElementById('recordingTimer').textContent = 
    `${mins}:${secs.toString().padStart(2, '0')}`;
}

// ==================== MICROPHONES ====================

async function loadMicrophones() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === 'audioinput');
    
    const select = document.getElementById('micSelect');
    select.innerHTML = '<option value="">Default</option>';
    
    mics.forEach(mic => {
      const option = document.createElement('option');
      option.value = mic.deviceId;
      option.textContent = mic.label || `Microphone ${mic.deviceId.slice(0, 8)}`;
      if (mic.deviceId === config.selectedMicId) {
        option.selected = true;
      }
      select.appendChild(option);
    });
  } catch (err) {
    log(`Mic enumeration error: ${err.message}`);
  }
}

// ==================== LANGUAGES ====================

function loadLanguages() {
  const select = document.getElementById('languageSelect');
  select.innerHTML = '';
  
  Object.entries(languages).forEach(([code, name]) => {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = name;
    if (code === (config.language || 'en')) {
      option.selected = true;
    }
    select.appendChild(option);
  });
}

// ==================== API KEYS ====================

function loadApiKeys() {
  const list = document.getElementById('apiKeysList');
  const keys = config.apiKeys || [];
  
  if (keys.length === 0) {
    list.innerHTML = '<div class="empty-state"><i class="fas fa-key"></i><p>No API keys added</p></div>';
    return;
  }
  
  list.innerHTML = keys.map(key => `
    <div class="api-key-item">
      <input type="radio" class="api-key-radio" name="activeKey" value="${key.id}" 
        ${key.id === config.activeApiKeyId ? 'checked' : ''} 
        onchange="setActiveKey('${key.id}')">
      <div class="api-key-info">
        <div class="api-key-name">${key.name}</div>
        <div class="api-key-preview">${key.key.slice(0, 8)}...${key.key.slice(-4)}</div>
      </div>
      <button class="api-key-delete" onclick="deleteApiKey('${key.id}')">
        <i class="fas fa-trash"></i>
      </button>
    </div>
  `).join('');
}

async function addApiKey() {
  const name = document.getElementById('newKeyName').value.trim() || 'API Key';
  const key = document.getElementById('newKeyValue').value.trim();
  
  if (!key) {
    showToast('Please enter an API key', 'error');
    return;
  }
  
  if (!key.startsWith('sk-')) {
    showToast('Invalid API key format', 'error');
    return;
  }
  
  const newKey = await ipcRenderer.invoke('add-api-key', { name, key });
  config.apiKeys = await ipcRenderer.invoke('get-api-keys');
  if (!config.activeApiKeyId) {
    config.activeApiKeyId = newKey.id;
  }
  
  document.getElementById('newKeyName').value = '';
  document.getElementById('newKeyValue').value = '';
  
  loadApiKeys();
  updateUI();
  showToast('API key added', 'success');
}

window.setActiveKey = async function(keyId) {
  await ipcRenderer.invoke('set-active-api-key', keyId);
  config.activeApiKeyId = keyId;
  updateUI();
};

window.deleteApiKey = async function(keyId) {
  if (!confirm('Delete this API key?')) return;
  
  await ipcRenderer.invoke('remove-api-key', keyId);
  config.apiKeys = await ipcRenderer.invoke('get-api-keys');
  
  loadApiKeys();
  updateUI();
  showToast('API key removed', 'success');
};

// ==================== HISTORY ====================

async function loadHistory() {
  const history = await ipcRenderer.invoke('get-history');
  const list = document.getElementById('historyList');
  
  if (!history || history.length === 0) {
    list.innerHTML = '<div class="empty-state"><i class="fas fa-history"></i><p>No transcriptions yet</p></div>';
    return;
  }
  
  list.innerHTML = history.map(item => {
    const date = new Date(item.timestamp);
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateStr = date.toLocaleDateString();
    
    return `
      <div class="history-item">
        <div class="history-item-header">
          <span class="history-item-time">${dateStr} ${timeStr}</span>
          <span class="history-item-meta">${item.duration?.toFixed(1) || 0}s • $${(item.cost || 0).toFixed(4)}</span>
        </div>
        <div class="history-item-text">${item.text}</div>
        <div class="history-item-actions">
          <button class="history-copy-btn" onclick="copyHistoryItem('${encodeURIComponent(item.text)}')">
            <i class="fas fa-copy"></i> Copy
          </button>
          <button class="history-copy-btn" onclick="reuseHistoryItem('${encodeURIComponent(item.text)}')">
            <i class="fas fa-redo"></i> Use Again
          </button>
        </div>
      </div>
    `;
  }).join('');
}

window.copyHistoryItem = function(text) {
  clipboard.writeText(decodeURIComponent(text));
  showToast('Copied to clipboard', 'success');
};

window.reuseHistoryItem = async function(text) {
  const decoded = decodeURIComponent(text);
  try {
    await typeIntoClaude(decoded);
    showToast('Sent to Claude', 'success');
  } catch (err) {
    clipboard.writeText(decoded);
    showToast('Copied to clipboard', 'success');
  }
};

async function clearHistory() {
  if (!confirm('Clear all transcription history?')) return;
  
  await ipcRenderer.invoke('clear-history');
  loadHistory();
  showToast('History cleared', 'success');
}

// ==================== HOTKEY CAPTURE ====================

let isCapturingHotkey = false;

function startHotkeyCapture() {
  const el = document.getElementById('hotkeyCapture');
  el.classList.add('listening');
  el.textContent = 'Press a key...';
  isCapturingHotkey = true;
  
  document.addEventListener('keydown', captureHotkey, { once: true });
}

async function captureHotkey(e) {
  e.preventDefault();
  
  const el = document.getElementById('hotkeyCapture');
  el.classList.remove('listening');
  isCapturingHotkey = false;
  
  let key = e.key.toUpperCase();
  if (key === ' ') key = 'SPACE';
  if (key === 'ESCAPE') {
    el.textContent = config.hotkey || 'F9';
    return;
  }
  
  config.hotkey = key;
  await ipcRenderer.invoke('set-config', 'hotkey', key);
  
  el.textContent = key;
  document.getElementById('hotkeyBadge').textContent = key;
  
  showToast(`Hotkey set to ${key}`, 'success');
}

// ==================== SOUNDS ====================

function playSound(type) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const oscillator = ctx.createOscillator();
  const gainNode = ctx.createGain();
  
  oscillator.connect(gainNode);
  gainNode.connect(ctx.destination);
  gainNode.gain.value = 0.1;
  
  switch (type) {
    case 'start': oscillator.frequency.value = 800; break;
    case 'stop': oscillator.frequency.value = 400; break;
    case 'success': oscillator.frequency.value = 600; break;
    case 'error': oscillator.frequency.value = 300; break;
  }
  
  oscillator.start();
  oscillator.stop(ctx.currentTime + 0.15);
}

// ==================== TOAST ====================

function showToast(message, type = 'success') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<i class="fas fa-${type === 'success' ? 'check-circle' : 'exclamation-circle'}"></i> ${message}`;
  document.body.appendChild(toast);
  
  setTimeout(() => toast.remove(), 3000);
}

// ==================== WAKE WORD ====================

async function onWakeWordToggle(enabled) {
  if (enabled) {
    // Initialize and start wake word detection (local ONNX — no API key needed)
    const result = await ipcRenderer.invoke('wake-word-init', {
      sensitivity: config.wakeWordSensitivity
    });

    if (result.success) {
      await ipcRenderer.invoke('wake-word-start');
      showToast('"Hey Claude" wake word started', 'success');
    } else {
      showToast(`Failed: ${result.error}`, 'error');
      // Revert toggle
      config.wakeWordEnabled = false;
      await ipcRenderer.invoke('set-config', 'wakeWordEnabled', false);
      updateToggle(document.getElementById('toggleWakeWord'), false);
    }
  } else {
    // Stop wake word detection
    await ipcRenderer.invoke('wake-word-stop');
    showToast('Wake word detection stopped', 'success');
  }
}

async function testWakeWord() {
  const statusText = document.getElementById('wakeWordStatusText');
  statusText.textContent = 'Loading models...';

  const result = await ipcRenderer.invoke('wake-word-init', {
    sensitivity: config.wakeWordSensitivity
  });

  if (result.success) {
    statusText.textContent = 'Listening — say "Hey Claude"...';
    await ipcRenderer.invoke('wake-word-start');
    showToast('Listening for "Hey Claude"...', 'success');

    // Auto-stop after 15 seconds
    setTimeout(async () => {
      await ipcRenderer.invoke('wake-word-stop');
      statusText.textContent = 'Test complete';
    }, 15000);
  } else {
    statusText.textContent = `Error: ${result.error}`;
    showToast(`Failed: ${result.error}`, 'error');
  }
}

function updateRecordingModeUI() {
  const mode = config.recordingMode || 'push-to-talk';
  const hotkey = config.hotkey || 'F9';
  const hintEl = document.querySelector('.hotkey-hint');
  if (!hintEl) return;

  if (mode === 'wake-word') {
    hintEl.innerHTML = `Say <span class="hotkey-badge">"Hey Claude"</span> or hold <span class="hotkey-badge">${hotkey}</span>`;
  } else if (mode === 'tap-to-talk') {
    hintEl.innerHTML = `Tap <span class="hotkey-badge">${hotkey}</span> to record (auto-stops)`;
  } else {
    hintEl.innerHTML = `Hold <span class="hotkey-badge">${hotkey}</span> to record`;
  }

  // Update footer status
  const connectionStatus = document.getElementById('connectionStatus');
  if (connectionStatus) {
    const hasKey = config.apiKeys && config.apiKeys.length > 0;
    if (hasKey || config.useLocalWhisper) {
      connectionStatus.textContent = mode === 'wake-word' ? 'Wake Word Active' : (config.useLocalWhisper ? 'Local Whisper' : 'API Ready');
    }
  }
}

// ==================== ONBOARDING WIZARD ====================

const WHISPER_MODEL_SIZES = {
  'tiny': '~75 MB',
  'base': '~150 MB',
  'small': '~500 MB',
  'medium': '~1.5 GB',
  'large-v3': '~3 GB'
};

const onboardingSteps = [
  {
    id: 'welcome',
    icon: 'fa-microphone',
    title: 'Welcome to Claude\'s Voice Input',
    subtitle: 'Let\'s get you set up in under a minute',
    render: () => `
      <div class="ob-step-desc">
        This app lets you <strong>talk to Claude Desktop using your voice</strong>.
        Just speak naturally and your words are transcribed and pasted directly into Claude's chat window.
      </div>
      <ul class="ob-feature-list">
        <li><i class="fas fa-check-circle"></i> <div><strong>Hands-free voice input</strong> — speak instead of type, with auto-paste into Claude Desktop</div></li>
        <li><i class="fas fa-check-circle"></i> <div><strong>"Hey Claude" wake word</strong> — built-in, works offline, no setup needed</div></li>
        <li><i class="fas fa-check-circle"></i> <div><strong>Local or API transcription</strong> — run Whisper on your PC for free, or use OpenAI's API for speed</div></li>
        <li><i class="fas fa-check-circle"></i> <div><strong>Smart auto-stop</strong> — voice activity detection knows when you're done speaking</div></li>
        <li><i class="fas fa-check-circle"></i> <div><strong>Works in the background</strong> — sits in your system tray, always ready</div></li>
      </ul>
    `
  },
  {
    id: 'engine',
    icon: 'fa-cogs',
    title: 'Choose Your Speech Engine',
    subtitle: 'How should your voice be transcribed?',
    render: (state) => `
      <div class="ob-step-desc">
        You have two options for turning your speech into text. Pick whichever works best for you — <strong>you can change this later</strong> in Settings.
      </div>
      <div class="ob-choice-grid">
        <div class="ob-choice ${state.engine === 'local' ? 'selected' : ''}" onclick="window._obSelectEngine('local')">
          <div class="ob-choice-title">
            <i class="fas fa-desktop"></i> Local Whisper (ONNX)
            <span class="ob-badge">Recommended</span>
          </div>
          <div class="ob-choice-desc">
            Runs entirely on your PC — <strong>no API key needed, completely free and private</strong>.
            Uses OpenAI's Whisper model via ONNX Runtime. Downloads a model on first use
            (${WHISPER_MODEL_SIZES['small']} for the recommended "small" model).
            Works offline after the initial download.
          </div>
        </div>
        <div class="ob-choice ${state.engine === 'api' ? 'selected' : ''}" onclick="window._obSelectEngine('api')">
          <div class="ob-choice-title">
            <i class="fas fa-cloud"></i> OpenAI Whisper API
          </div>
          <div class="ob-choice-desc">
            Sends audio to OpenAI's servers for transcription.
            <strong>Requires an OpenAI API key</strong> ($0.006/min, very cheap).
            Faster on older hardware, but needs internet.
            Your audio is sent to OpenAI's servers.
          </div>
        </div>
      </div>
      ${state.engine === 'api' ? `
        <div class="ob-input-group">
          <label>OpenAI API Key</label>
          <input type="password" id="obApiKey" placeholder="sk-..." value="${state.apiKey || ''}"
            oninput="window._obState.apiKey = this.value">
        </div>
        <div class="ob-info-box">
          <i class="fas fa-info-circle"></i>
          Get your API key at <strong>platform.openai.com/api-keys</strong>.
          Your key stays on this device and is never shared.
        </div>
      ` : `
        <div class="ob-info-box">
          <i class="fas fa-info-circle"></i>
          The "small" model (${WHISPER_MODEL_SIZES['small']}) offers the best balance of speed and accuracy.
          It will download automatically when you first use voice input.
        </div>
      `}
    `
  },
  {
    id: 'recording',
    icon: 'fa-microphone-alt',
    title: 'How to Record',
    subtitle: 'Choose how you want to trigger voice input',
    render: (state) => `
      <div class="ob-step-desc">
        Pick your preferred way to start speaking. The <strong>wake word</strong> option is great for hands-free use, while hotkey modes give you more control.
      </div>
      <div class="ob-choice-grid">
        <div class="ob-choice ${state.recordingMode === 'wake-word' ? 'selected' : ''}" onclick="window._obSelectMode('wake-word')">
          <div class="ob-choice-title">
            <i class="fas fa-comment-dots"></i> Wake Word — "Hey Claude"
            <span class="ob-badge">Hands-free</span>
          </div>
          <div class="ob-choice-desc">
            Just say <strong>"Hey Claude"</strong> and start talking. The app listens in the background
            using a local AI model — no internet needed for detection.
            Auto-stops when you finish speaking. You can also use the hotkey as a backup.
          </div>
        </div>
        <div class="ob-choice ${state.recordingMode === 'push-to-talk' ? 'selected' : ''}" onclick="window._obSelectMode('push-to-talk')">
          <div class="ob-choice-title">
            <i class="fas fa-hand-pointer"></i> Push-to-Talk
          </div>
          <div class="ob-choice-desc">
            <strong>Hold down a key</strong> (default: F9) while speaking, release when done.
            Simple and reliable — gives you full control over when recording starts and stops.
          </div>
        </div>
        <div class="ob-choice ${state.recordingMode === 'tap-to-talk' ? 'selected' : ''}" onclick="window._obSelectMode('tap-to-talk')">
          <div class="ob-choice-title">
            <i class="fas fa-fingerprint"></i> Tap-to-Talk
          </div>
          <div class="ob-choice-desc">
            <strong>Tap the hotkey once</strong> to start recording. Voice Activity Detection (VAD)
            automatically stops when you go silent. Tap again to stop manually if needed.
          </div>
        </div>
      </div>
    `
  },
  {
    id: 'behavior',
    icon: 'fa-magic',
    title: 'Auto-Paste Behavior',
    subtitle: 'What happens after transcription?',
    render: (state) => `
      <div class="ob-step-desc">
        After your speech is transcribed, the app can <strong>automatically paste it into Claude Desktop</strong> — or just copy it to your clipboard. Here's how it works:
      </div>
      <div class="ob-choice-grid">
        <div class="ob-choice ${state.autoPaste ? 'selected' : ''}" onclick="window._obSetPaste(true)">
          <div class="ob-choice-title">
            <i class="fas fa-paste"></i> Auto-Paste into Claude
            <span class="ob-badge">Recommended</span>
          </div>
          <div class="ob-choice-desc">
            Finds the Claude Desktop window, brings it to the front, and pastes your text automatically.
            ${state.autoSend ? '<strong>Auto-Send is ON</strong> — will also press Enter to send the message.' : 'You\'ll still need to press Enter to send.'}
          </div>
        </div>
        <div class="ob-choice ${!state.autoPaste ? 'selected' : ''}" onclick="window._obSetPaste(false)">
          <div class="ob-choice-title">
            <i class="fas fa-clipboard"></i> Copy to Clipboard Only
          </div>
          <div class="ob-choice-desc">
            Copies the transcribed text to your clipboard. You paste it yourself wherever you want —
            works with any app, not just Claude.
          </div>
        </div>
      </div>
      <div class="ob-info-box">
        <i class="fas fa-lightbulb"></i>
        <strong>Tip:</strong> You can toggle "Auto Send" in Settings to also press Enter after pasting,
        so your voice message sends immediately without any clicks.
      </div>
    `
  },
  {
    id: 'ready',
    icon: 'fa-rocket',
    title: 'You\'re All Set!',
    subtitle: 'Everything is configured and ready to go',
    render: (state) => {
      const engineText = state.engine === 'local'
        ? 'Local Whisper (free, private, offline)'
        : 'OpenAI API (fast, cloud-based)';
      const modeText = {
        'wake-word': 'Say "Hey Claude" (hands-free)',
        'push-to-talk': `Hold ${config.hotkey || 'F9'} to record`,
        'tap-to-talk': `Tap ${config.hotkey || 'F9'} to record (auto-stops)`
      }[state.recordingMode];
      const pasteText = state.autoPaste ? 'Auto-paste into Claude Desktop' : 'Copy to clipboard';

      return `
        <div class="ob-step-desc">
          Here's a summary of your setup. You can change any of these in the <strong>Settings</strong> tab anytime.
        </div>
        <ul class="ob-feature-list">
          <li><i class="fas fa-check-circle"></i> <div><strong>Speech Engine:</strong> ${engineText}</div></li>
          <li><i class="fas fa-check-circle"></i> <div><strong>Recording Mode:</strong> ${modeText}</div></li>
          <li><i class="fas fa-check-circle"></i> <div><strong>Output:</strong> ${pasteText}</div></li>
        </ul>
        <div class="ob-info-box">
          <i class="fas fa-info-circle"></i>
          <strong>Quick tips:</strong><br>
          &bull; The app lives in your <strong>system tray</strong> — click the icon to show/hide<br>
          &bull; Check <strong>Settings</strong> for VAD sensitivity, language, model size, and more<br>
          &bull; Your <strong>transcription history</strong> is saved locally (viewable in the History tab)
        </div>
      `;
    }
  }
];

let obCurrentStep = 0;

// Onboarding state — user's choices during the wizard
window._obState = {
  engine: 'local',      // 'local' or 'api'
  apiKey: '',
  recordingMode: 'wake-word',
  autoPaste: true,
  autoSend: false
};

window._obSelectEngine = function(engine) {
  window._obState.engine = engine;
  renderOnboardingStep();
};

window._obSelectMode = function(mode) {
  window._obState.recordingMode = mode;
  renderOnboardingStep();
};

window._obSetPaste = function(val) {
  window._obState.autoPaste = val;
  renderOnboardingStep();
};

function showOnboarding() {
  obCurrentStep = 0;
  document.getElementById('onboardingOverlay').classList.remove('hidden');
  renderOnboardingStep();
}

function hideOnboarding() {
  document.getElementById('onboardingOverlay').classList.add('hidden');
}

function renderOnboardingStep() {
  const step = onboardingSteps[obCurrentStep];
  const total = onboardingSteps.length;

  // Header
  document.getElementById('obIcon').innerHTML = `<i class="fas ${step.icon}"></i>`;
  document.getElementById('obTitle').textContent = step.title;
  document.getElementById('obSubtitle').textContent = step.subtitle;

  // Body
  document.getElementById('obBody').innerHTML = step.render(window._obState);

  // Dots
  const dotsHtml = onboardingSteps.map((_, i) => {
    const cls = i < obCurrentStep ? 'ob-dot done' : (i === obCurrentStep ? 'ob-dot active' : 'ob-dot');
    return `<div class="${cls}"></div>`;
  }).join('');
  document.getElementById('obDots').innerHTML = dotsHtml;

  // Buttons
  const backBtn = document.getElementById('obBack');
  const skipBtn = document.getElementById('obSkip');
  const nextBtn = document.getElementById('obNext');

  backBtn.style.display = obCurrentStep > 0 ? 'inline-block' : 'none';

  if (obCurrentStep === total - 1) {
    nextBtn.textContent = 'Start Using Voice Input';
    skipBtn.style.display = 'none';
  } else if (obCurrentStep === 0) {
    nextBtn.textContent = 'Get Started';
    skipBtn.style.display = 'inline-block';
  } else {
    nextBtn.textContent = 'Next';
    skipBtn.style.display = 'inline-block';
  }
}

async function applyOnboardingChoices() {
  const state = window._obState;

  // Engine
  if (state.engine === 'local') {
    await ipcRenderer.invoke('set-config', 'useLocalWhisper', true);
    config.useLocalWhisper = true;
  } else {
    await ipcRenderer.invoke('set-config', 'useLocalWhisper', false);
    config.useLocalWhisper = false;
    // Save API key if provided
    if (state.apiKey && state.apiKey.startsWith('sk-')) {
      const newKey = await ipcRenderer.invoke('add-api-key', { name: 'Default Key', key: state.apiKey });
      config.apiKeys = await ipcRenderer.invoke('get-api-keys');
      config.activeApiKeyId = newKey.id;
    }
  }

  // Recording mode
  await ipcRenderer.invoke('set-config', 'recordingMode', state.recordingMode);
  config.recordingMode = state.recordingMode;

  // Wake word — auto-enable if they chose wake word mode
  if (state.recordingMode === 'wake-word') {
    await ipcRenderer.invoke('set-config', 'wakeWordEnabled', true);
    config.wakeWordEnabled = true;
  }

  // Paste behavior
  await ipcRenderer.invoke('set-config', 'autoPaste', state.autoPaste);
  config.autoPaste = state.autoPaste;
  await ipcRenderer.invoke('set-config', 'autoSend', state.autoSend);
  config.autoSend = state.autoSend;

  // Mark complete
  await ipcRenderer.invoke('set-config', 'onboardingComplete', true);
  config.onboardingComplete = true;

  log('Onboarding complete — settings applied');
}

function setupOnboarding() {
  document.getElementById('obNext').onclick = async () => {
    if (obCurrentStep < onboardingSteps.length - 1) {
      obCurrentStep++;
      renderOnboardingStep();
    } else {
      // Final step — apply and close
      await applyOnboardingChoices();
      hideOnboarding();
      updateUI();
    }
  };

  document.getElementById('obBack').onclick = () => {
    if (obCurrentStep > 0) {
      obCurrentStep--;
      renderOnboardingStep();
    }
  };

  document.getElementById('obSkip').onclick = async () => {
    await ipcRenderer.invoke('set-config', 'onboardingComplete', true);
    config.onboardingComplete = true;
    hideOnboarding();
  };
}

// ==================== INIT ====================

document.addEventListener('DOMContentLoaded', init);
