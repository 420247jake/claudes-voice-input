/**
 * Claude's Voice Input - Main Process
 * Full-featured voice input with Whisper API
 */

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, systemPreferences, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

// Suppress EPIPE errors on stdout/stderr (happens when console.log writes to a broken pipe,
// e.g. during app shutdown or when wake word sox process dies mid-frame)
process.stdout?.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
process.stderr?.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
const { GlobalKeyboardListener } = require('node-global-key-listener');

// Keep references
let mainWindow = null;
let tray = null;
let isRecording = false;
let keyListener = null;
let recordingStartTime = null;

// Wake word detector
let wakeWordDetector = null;

// Local Whisper — Node.js ONNX engine (no Python required)
const WhisperNode = require('./whisper-node');
let whisperNode = null;

// Config store with all settings
const store = new Store({
  defaults: {
    // API Settings
    apiKeys: [], // Array of {id, name, key, isDefault}
    activeApiKeyId: null,
    
    // Hotkey
    hotkey: 'F9',
    
    // Recording Mode: 'push-to-talk', 'tap-to-talk', 'wake-word'
    recordingMode: 'push-to-talk',
    
    // Recording
    selectedMicId: null,
    language: 'en', // Whisper language code
    
    // Behavior
    autoSend: true,
    autoPaste: true, // true = paste, false = copy only
    audioFeedback: true,
    alwaysOnTop: false,
    startMinimized: false,
    
    // Voice Activity Detection
    vadEnabled: true,
    vadSensitivity: 25, // 5-80, lower = more sensitive
    vadSilenceMs: 3500, // Stop after this much silence (3.5s tolerates thinking pauses)

    // Wake Word Settings
    wakeWordEnabled: true,
    wakeWordSensitivity: 0.5,

    // Local Whisper
    useLocalWhisper: false,
    localWhisperModel: 'small',

    // Custom vocabulary hint for Whisper (improves proper noun accuracy)
    whisperPrompt: 'Claude, ClaudeOS, Whisper, Claude Code, Hey Claude',
    
    // Stats
    totalTranscriptions: 0,
    totalAudioSeconds: 0,
    totalCostEstimate: 0,
    
    // History
    transcriptionHistory: [], // Last 20 transcriptions
    
    // Onboarding
    onboardingComplete: false,

    // Privacy
    clearHistoryOnExit: false,

    // Debug
    debug: false
  }
});

// Migrate old config if exists
try {
  const oldConfigPath = path.join(__dirname, '../config.json');
  if (fs.existsSync(oldConfigPath)) {
    const oldConfig = JSON.parse(fs.readFileSync(oldConfigPath, 'utf8'));
    if (oldConfig.whisperApiKey && store.get('apiKeys').length === 0) {
      store.set('apiKeys', [{
        id: 'migrated-1',
        name: 'Default Key',
        key: oldConfig.whisperApiKey,
        isDefault: true
      }]);
      store.set('activeApiKeyId', 'migrated-1');
    }
    if (oldConfig.hotkey && oldConfig.hotkey.key) {
      store.set('hotkey', oldConfig.hotkey.key);
    }
  }
} catch (e) {}

// Config migration: bump vadSilenceMs to 3500 (previous defaults 1500/2500 were too aggressive)
if (store.get('vadSilenceMs') <= 2500) {
  console.log(`[Config] Migrating vadSilenceMs: ${store.get('vadSilenceMs')} → 3500`);
  store.set('vadSilenceMs', 3500);
}

// Ensure wake word sensitivity is sane (slider may have been set too high)
if (store.get('wakeWordSensitivity') > 0.7) {
  store.set('wakeWordSensitivity', 0.5);
}

// Whisper supported languages
const WHISPER_LANGUAGES = {
  'en': 'English', 'zh': 'Chinese', 'de': 'German', 'es': 'Spanish', 'ru': 'Russian',
  'ko': 'Korean', 'fr': 'French', 'ja': 'Japanese', 'pt': 'Portuguese', 'tr': 'Turkish',
  'pl': 'Polish', 'ca': 'Catalan', 'nl': 'Dutch', 'ar': 'Arabic', 'sv': 'Swedish',
  'it': 'Italian', 'id': 'Indonesian', 'hi': 'Hindi', 'fi': 'Finnish', 'vi': 'Vietnamese',
  'he': 'Hebrew', 'uk': 'Ukrainian', 'el': 'Greek', 'ms': 'Malay', 'cs': 'Czech',
  'ro': 'Romanian', 'da': 'Danish', 'hu': 'Hungarian', 'ta': 'Tamil', 'no': 'Norwegian',
  'th': 'Thai', 'ur': 'Urdu', 'hr': 'Croatian', 'bg': 'Bulgarian', 'lt': 'Lithuanian',
  'la': 'Latin', 'mi': 'Maori', 'ml': 'Malayalam', 'cy': 'Welsh', 'sk': 'Slovak',
  'te': 'Telugu', 'fa': 'Persian', 'lv': 'Latvian', 'bn': 'Bengali', 'sr': 'Serbian',
  'az': 'Azerbaijani', 'sl': 'Slovenian', 'kn': 'Kannada', 'et': 'Estonian', 'mk': 'Macedonian',
  'br': 'Breton', 'eu': 'Basque', 'is': 'Icelandic', 'hy': 'Armenian', 'ne': 'Nepali',
  'mn': 'Mongolian', 'bs': 'Bosnian', 'kk': 'Kazakh', 'sq': 'Albanian', 'sw': 'Swahili',
  'gl': 'Galician', 'mr': 'Marathi', 'pa': 'Punjabi', 'si': 'Sinhala', 'km': 'Khmer',
  'sn': 'Shona', 'yo': 'Yoruba', 'so': 'Somali', 'af': 'Afrikaans', 'oc': 'Occitan',
  'ka': 'Georgian', 'be': 'Belarusian', 'tg': 'Tajik', 'sd': 'Sindhi', 'gu': 'Gujarati',
  'am': 'Amharic', 'yi': 'Yiddish', 'lo': 'Lao', 'uz': 'Uzbek', 'fo': 'Faroese',
  'ht': 'Haitian Creole', 'ps': 'Pashto', 'tk': 'Turkmen', 'nn': 'Nynorsk', 'mt': 'Maltese'
};

// Get active API key
function getActiveApiKey() {
  const activeId = store.get('activeApiKeyId');
  const keys = store.get('apiKeys');
  if (activeId) {
    const key = keys.find(k => k.id === activeId);
    if (key) return key.key;
  }
  // Fall back to first key or default
  if (keys.length > 0) {
    const defaultKey = keys.find(k => k.isDefault) || keys[0];
    return defaultKey.key;
  }
  return null;
}

// Tray icons
function getTrayIcon(recording = false) {
  const iconName = recording ? 'icon-recording-tray.png' : 'icon-tray.png';
  const iconPath = path.join(__dirname, '../assets', iconName);
  return nativeImage.createFromPath(iconPath);
}

// Create window
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 700,
    minWidth: 380,
    minHeight: 600,
    resizable: true,
    frame: false,
    transparent: false,
    backgroundColor: '#1a1816',
    alwaysOnTop: store.get('alwaysOnTop'),
    skipTaskbar: false,
    icon: path.join(__dirname, '../assets/icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'ui/index.html'));
  
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  if (store.get('startMinimized')) {
    mainWindow.hide();
  }
}

// Create tray with full menu
function createTray() {
  tray = new Tray(getTrayIcon(false));
  updateTrayMenu();
  
  tray.setToolTip("Claude's Voice Input");
  
  tray.on('click', () => {
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });
}

function updateTrayMenu() {
  const hotkey = store.get('hotkey');
  const contextMenu = Menu.buildFromTemplate([
    { label: "Claude's Voice Input", enabled: false },
    { type: 'separator' },
    { label: `Hold ${hotkey} to Record`, enabled: false },
    { type: 'separator' },
    { label: 'Show Window', click: () => mainWindow.show() },
    { label: 'Hide Window', click: () => mainWindow.hide() },
    { type: 'separator' },
    { 
      label: 'Always on Top', 
      type: 'checkbox', 
      checked: store.get('alwaysOnTop'),
      click: (item) => {
        store.set('alwaysOnTop', item.checked);
        mainWindow.setAlwaysOnTop(item.checked);
      }
    },
    { type: 'separator' },
    { label: 'Settings...', click: () => { mainWindow.show(); mainWindow.webContents.send('show-settings'); }},
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); }}
  ]);
  
  tray.setContextMenu(contextMenu);
}

// Setup hotkey listener
function setupHotkey() {
  if (keyListener) {
    keyListener.kill();
  }
  
  keyListener = new GlobalKeyboardListener();
  const hotkey = store.get('hotkey').toUpperCase();
  
  keyListener.addListener((e, down) => {
    if (e.name && e.name.toUpperCase() === hotkey) {
      const mode = store.get('recordingMode') || 'push-to-talk';

      if (mode === 'push-to-talk' || mode === 'wake-word') {
        // Hold to record, release to stop
        // Wake-word mode also supports hotkey as a manual push-to-talk trigger
        if (e.state === 'DOWN' && !isRecording) {
          startRecording();
        } else if (e.state === 'UP' && isRecording) {
          stopRecording();
        }
      } else if (mode === 'tap-to-talk') {
        // Tap to start, VAD auto-stops (or tap again to stop manually)
        if (e.state === 'DOWN') {
          if (!isRecording) {
            startRecording();
          } else {
            stopRecording();
          }
        }
      }
    }
  });
}

// Recording functions
function startRecording() {
  isRecording = true;
  recordingStartTime = Date.now();

  if (mainWindow) {
    mainWindow.webContents.send('recording-started', { wakeWord: false });
  }
  if (tray) {
    tray.setImage(getTrayIcon(true));
  }

  if (store.get('audioFeedback') && mainWindow) {
    mainWindow.webContents.send('play-sound', 'start');
  }
}

function wakeWordStartRecording() {
  isRecording = true;
  recordingStartTime = Date.now();

  if (mainWindow) {
    mainWindow.webContents.send('recording-started', { wakeWord: true });
  }
  if (tray) {
    tray.setImage(getTrayIcon(true));
  }

  if (store.get('audioFeedback') && mainWindow) {
    mainWindow.webContents.send('play-sound', 'start');
  }
}

function stopRecording() {
  if (!isRecording) return; // Guard against rapid-fire stops

  const duration = recordingStartTime ? (Date.now() - recordingStartTime) / 1000 : 0;
  isRecording = false;
  recordingStartTime = null;

  console.log(`[VoiceInput] Stop recording (${duration.toFixed(1)}s)`);

  if (mainWindow) {
    mainWindow.webContents.send('recording-stopped', { duration });
  }
  if (tray) {
    tray.setImage(getTrayIcon(false));
  }

  if (store.get('audioFeedback') && mainWindow) {
    mainWindow.webContents.send('play-sound', 'stop');
  }

  if (mainWindow) {
    mainWindow.webContents.send('transcribe');
  }
}

// ==================== LOCAL WHISPER ENGINE (Node.js ONNX) ====================

async function loadWhisperModel() {
  const model = store.get('localWhisperModel') || 'base';

  if (!whisperNode) {
    whisperNode = new WhisperNode();

    // Forward progress/status events to renderer
    whisperNode.on('progress', (data) => {
      if (mainWindow) {
        mainWindow.webContents.send('whisper-model-progress', data);
      }
    });

    whisperNode.on('status', (data) => {
      if (mainWindow) {
        const running = data.state === 'ready';
        mainWindow.webContents.send('whisper-server-status', {
          running,
          model: data.model || model,
          error: data.error || null,
          state: data.state // 'loading', 'ready', 'error'
        });
      }
    });
  }

  console.log(`[VoiceInput] Loading local Whisper model (${model})...`);

  try {
    await whisperNode.load(model, (progress) => {
      console.log(`[VoiceInput] Whisper: ${progress.file} ${progress.percent}%`);
    });
    console.log(`[VoiceInput] Whisper model ${model} ready`);
  } catch (err) {
    console.error(`[VoiceInput] Whisper model load failed:`, err.message);
  }
}

async function unloadWhisperModel() {
  if (whisperNode) {
    console.log('[VoiceInput] Unloading Whisper model...');
    await whisperNode.release();
    whisperNode = null;
  }
}

// ==================== IPC HANDLERS ====================

// Config
ipcMain.handle('get-config', () => store.store);
ipcMain.handle('set-config', (_, key, value) => {
  store.set(key, value);
  
  // Handle special cases
  if (key === 'hotkey') {
    setupHotkey();
    updateTrayMenu();
  }
  if (key === 'alwaysOnTop') {
    mainWindow.setAlwaysOnTop(value);
  }
  if (key === 'useLocalWhisper') {
    if (value) {
      loadWhisperModel();
    } else {
      unloadWhisperModel();
    }
  }
  if (key === 'localWhisperModel' && store.get('useLocalWhisper')) {
    // Reload with new model
    unloadWhisperModel().then(() => loadWhisperModel());
  }

  return true;
});
ipcMain.handle('get-recording-state', () => isRecording);
ipcMain.handle('get-languages', () => WHISPER_LANGUAGES);

// API Key management
ipcMain.handle('get-api-keys', () => store.get('apiKeys'));
ipcMain.handle('add-api-key', (_, keyData) => {
  const keys = store.get('apiKeys');
  const newKey = {
    id: `key-${Date.now()}`,
    name: keyData.name || 'API Key',
    key: keyData.key,
    isDefault: keys.length === 0
  };
  keys.push(newKey);
  store.set('apiKeys', keys);
  if (newKey.isDefault) {
    store.set('activeApiKeyId', newKey.id);
  }
  return newKey;
});
ipcMain.handle('remove-api-key', (_, keyId) => {
  let keys = store.get('apiKeys');
  keys = keys.filter(k => k.id !== keyId);
  store.set('apiKeys', keys);
  
  if (store.get('activeApiKeyId') === keyId) {
    store.set('activeApiKeyId', keys.length > 0 ? keys[0].id : null);
  }
  return true;
});
ipcMain.handle('set-active-api-key', (_, keyId) => {
  store.set('activeApiKeyId', keyId);
  return true;
});

// Paste to Claude Desktop using PowerShell + Win32 API (most reliable)
ipcMain.handle('paste-to-claude', async (_, text, autoSend) => {
  const { exec } = require('child_process');
  const os = require('os');
  
  // Copy text to clipboard
  clipboard.writeText(text.trim());
  
  // Build PowerShell script
  let psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class Win32 {
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    public static IntPtr FindClaudeWindow() {
        IntPtr found = IntPtr.Zero;
        EnumWindows((hWnd, lParam) => {
            if (IsWindowVisible(hWnd)) {
                var sb = new StringBuilder(256);
                GetWindowText(hWnd, sb, 256);
                string t = sb.ToString();
                // Match "Claude" or "Claude - ..." but not "Claude's Voice Input"
                if (t == "Claude" || (t.StartsWith("Claude") && !t.Contains("Voice"))) {
                    found = hWnd;
                    return false;
                }
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
"@

`;

  // Add the main logic (avoiding template literal issues with $)
  psScript += '$hwnd = [Win32]::FindClaudeWindow()\n';
  psScript += 'if ($hwnd -ne [IntPtr]::Zero) {\n';
  psScript += '    if ([Win32]::IsIconic($hwnd)) { [Win32]::ShowWindow($hwnd, 9) | Out-Null }\n';
  psScript += '    Start-Sleep -Milliseconds 50\n';
  psScript += '    [Win32]::SetForegroundWindow($hwnd) | Out-Null\n';
  psScript += '    Start-Sleep -Milliseconds 200\n';
  psScript += '    Add-Type -AssemblyName System.Windows.Forms\n';
  psScript += '    [System.Windows.Forms.SendKeys]::SendWait("^v")\n';
  
  if (autoSend) {
    psScript += '    Start-Sleep -Milliseconds 150\n';
    psScript += '    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")\n';
  }
  
  psScript += '    exit 0\n';
  psScript += '} else {\n';
  psScript += '    Write-Host "Claude window not found"\n';
  psScript += '    exit 1\n';
  psScript += '}\n';

  const psPath = path.join(os.tmpdir(), 'claude-paste.ps1');
  fs.writeFileSync(psPath, psScript, 'utf8');
  
  return new Promise((resolve, reject) => {
    exec(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${psPath}"`,
      { timeout: 10000 },
      (err, stdout, stderr) => {
        try { fs.unlinkSync(psPath); } catch(e) {}
        
        if (err) {
          console.log('[VoiceInput] PowerShell error:', err.message, stdout, stderr);
          reject(new Error('Claude Desktop window not found'));
        } else {
          console.log('[VoiceInput] Text pasted to Claude Desktop successfully');
          resolve(true);
        }
      }
    );
  });
});

// Microphone enumeration
ipcMain.handle('get-microphones', async () => {
  // This needs to be done in renderer, but we store the selection here
  return store.get('selectedMicId');
});
ipcMain.handle('set-microphone', (_, micId) => {
  store.set('selectedMicId', micId);
  return true;
});

// History management
ipcMain.handle('get-history', () => store.get('transcriptionHistory'));
ipcMain.handle('add-to-history', (_, entry) => {
  const history = store.get('transcriptionHistory');
  history.unshift({
    id: `hist-${Date.now()}`,
    text: entry.text,
    timestamp: new Date().toISOString(),
    duration: entry.duration || 0,
    cost: entry.cost || 0
  });
  // Keep only last 20
  if (history.length > 20) history.pop();
  store.set('transcriptionHistory', history);
  return history;
});
ipcMain.handle('clear-history', () => {
  store.set('transcriptionHistory', []);
  return true;
});

// Stats
ipcMain.handle('get-stats', () => ({
  totalTranscriptions: store.get('totalTranscriptions'),
  totalAudioSeconds: store.get('totalAudioSeconds'),
  totalCostEstimate: store.get('totalCostEstimate')
}));
ipcMain.handle('update-stats', (_, { seconds, cost }) => {
  store.set('totalTranscriptions', store.get('totalTranscriptions') + 1);
  store.set('totalAudioSeconds', store.get('totalAudioSeconds') + (seconds || 0));
  store.set('totalCostEstimate', store.get('totalCostEstimate') + (cost || 0));
  return true;
});

// Whisper transcription
ipcMain.handle('transcribe-audio', async (_, audioBuffer, options = {}) => {
  const apiKey = getActiveApiKey();
  if (!apiKey) {
    throw new Error('No API key configured');
  }
  
  const OpenAI = require('openai');
  const os = require('os');
  
  const tempPath = path.join(os.tmpdir(), `voice-input-${Date.now()}.webm`);
  fs.writeFileSync(tempPath, Buffer.from(audioBuffer));
  
  try {
    const openai = new OpenAI({ apiKey });
    
    const language = options.language || store.get('language') || 'en';
    
    const response = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: 'whisper-1',
      language: language,
      response_format: 'text'
    });
    
    try { fs.unlinkSync(tempPath); } catch (e) {}
    
    return response;
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch (e) {}
    throw err;
  }
});

// Local Whisper transcription via Node.js ONNX engine (no Python needed)
ipcMain.handle('transcribe-local', async (_, audioInput) => {
  const language = store.get('language') || 'en';
  const whisperPrompt = store.get('whisperPrompt') || '';

  // Auto-load model if not ready
  if (!whisperNode || !whisperNode.isReady) {
    console.log('[VoiceInput] Whisper model not loaded, loading now...');
    await loadWhisperModel();
  }

  if (!whisperNode || !whisperNode.isReady) {
    throw new Error('Failed to load local Whisper model');
  }

  // audioInput is either:
  //   - Array of floats (raw PCM from renderer ScriptProcessor)
  //   - ArrayBuffer (WebM from MediaRecorder — fallback)
  const result = await whisperNode.transcribe(audioInput, { language, prompt: whisperPrompt });
  return result.text;
});

// Check local Whisper engine status
ipcMain.handle('check-local-whisper', async () => {
  if (whisperNode && whisperNode.isReady) {
    return { status: 'ok', model: store.get('localWhisperModel') || 'base' };
  }
  if (whisperNode && whisperNode.isLoading) {
    return { status: 'loading', model: store.get('localWhisperModel') || 'base' };
  }
  return { status: 'offline' };
});

// Window controls
ipcMain.on('minimize', () => mainWindow.hide());
ipcMain.on('close', () => { app.isQuitting = true; app.quit(); });

// VAD auto-stop signal from renderer
ipcMain.on('vad-stop', () => {
  if (isRecording) {
    console.log('[VoiceInput] VAD triggered stop');
    stopRecording();
  }
});

// ==================== WAKE WORD HANDLERS ====================

// Initialize or stop wake word detection
ipcMain.handle('wake-word-init', async (_, options) => {
  try {
    // Only load WakeWordDetector if needed
    const WakeWordDetector = require('./wakeword');

    // Stop existing detector if any
    if (wakeWordDetector) {
      wakeWordDetector.release();
    }

    wakeWordDetector = new WakeWordDetector({
      sensitivity: options.sensitivity || store.get('wakeWordSensitivity') || 0.5
    });
    
    // Handle wake word detection
    wakeWordDetector.on('detected', (data) => {
      console.log('[VoiceInput] Wake word detected:', data.keyword);
      if (mainWindow) {
        mainWindow.webContents.send('wake-word-detected', data);
      }
      // Stop wake word mic (frees sox so getUserMedia can have exclusive mic access)
      wakeWordDetector.stop();
      // Start recording (flag that this is wake-word triggered)
      wakeWordStartRecording();
    });
    
    wakeWordDetector.on('error', (err) => {
      console.error('[VoiceInput] Wake word error:', err.message);
      if (mainWindow) {
        mainWindow.webContents.send('wake-word-error', err.message);
      }
    });
    
    wakeWordDetector.on('listening', (isListening) => {
      if (mainWindow) {
        mainWindow.webContents.send('wake-word-listening', isListening);
      }
    });
    
    const initialized = await wakeWordDetector.init();
    return { success: initialized };
  } catch (err) {
    console.error('[VoiceInput] Wake word init error:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('wake-word-start', async () => {
  if (!wakeWordDetector) {
    return { success: false, error: 'Wake word detector not initialized' };
  }
  try {
    await wakeWordDetector.start();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('wake-word-stop', () => {
  if (wakeWordDetector) {
    wakeWordDetector.stop();
  }
  return { success: true };
});

ipcMain.handle('wake-word-resume', async () => {
  if (!wakeWordDetector) {
    console.log('[VoiceInput] Wake word resume failed: detector not initialized');
    return { success: false, error: 'Not initialized' };
  }
  try {
    // Full restart (re-spawns sox mic process) since we stop() on detection
    await wakeWordDetector.start();
    console.log('[VoiceInput] Wake word resumed, isListening:', wakeWordDetector.isListening);
    return { success: wakeWordDetector.isListening };
  } catch (err) {
    console.error('[VoiceInput] Wake word resume error:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('wake-word-release', () => {
  if (wakeWordDetector) {
    wakeWordDetector.release();
    wakeWordDetector = null;
  }
  return { success: true };
});

ipcMain.on('resize-window', (_, width, height) => {
  mainWindow.setSize(width, height);
});
ipcMain.on('set-always-on-top', (_, value) => {
  store.set('alwaysOnTop', value);
  mainWindow.setAlwaysOnTop(value);
});

// ==================== APP EVENTS ====================

app.whenReady().then(() => {
  createWindow();
  createTray();
  setupHotkey();

  // Auto-load local Whisper model if enabled
  if (store.get('useLocalWhisper')) {
    loadWhisperModel();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  // Privacy: clear history on exit if enabled
  if (store.get('clearHistoryOnExit')) {
    store.set('transcriptionHistory', []);
    console.log('[VoiceInput] History cleared on exit (privacy setting)');
  }

  if (keyListener) {
    keyListener.kill();
  }
  if (wakeWordDetector) {
    wakeWordDetector.release();
  }
  if (whisperNode) {
    whisperNode.release();
    whisperNode = null;
  }
});
