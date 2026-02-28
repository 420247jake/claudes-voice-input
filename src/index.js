/**
 * Voice Input for Claude Desktop
 * 
 * Push-to-talk voice input - copies to clipboard, you paste with Ctrl+V
 */

const { GlobalKeyboardListener } = require('node-global-key-listener');
const config = require('../config.json');
const Recorder = require('./recorder');
const { transcribe } = require('./transcribe');
const { typeIntoClaude } = require('./typer');
const { exec } = require('child_process');

// State
let isRecording = false;
let recorder = null;

// Sound functions
function playStartSound() {
    exec('powershell -Command "[console]::beep(800, 150)"');
}

function playStopSound() {
    exec('powershell -Command "[console]::beep(400, 150)"');
}

function playSuccessSound() {
    exec('powershell -Command "[console]::beep(600, 100); Start-Sleep -Milliseconds 50; [console]::beep(900, 100)"');
}

function playErrorSound() {
    exec('powershell -Command "[console]::beep(200, 300)"');
}

// Display startup info
console.log('╔═══════════════════════════════════════╗');
console.log('║    Voice Input for Claude Desktop     ║');
console.log('║                                       ║');
console.log('║  F9 = record → Ctrl+V = paste         ║');
console.log('╚═══════════════════════════════════════╝');
console.log('');

// Build hotkey display string
const hotkeyParts = [];
if (config.hotkey.ctrl) hotkeyParts.push('Ctrl');
if (config.hotkey.shift) hotkeyParts.push('Shift');
if (config.hotkey.alt) hotkeyParts.push('Alt');
hotkeyParts.push(config.hotkey.key);
const hotkeyStr = hotkeyParts.join('+');

console.log(`Hotkey: ${hotkeyStr} (hold to record)`);
console.log(`Audio feedback: ${config.audioFeedback ? 'Yes' : 'No'}`);
console.log('');
console.log('Press Ctrl+C to exit');
console.log('');

// Check for API key
if (!config.whisperApiKey) {
    console.log('⚠️  WARNING: No Whisper API key set in config.json');
    console.log('');
}

// Initialize keyboard listener
const keyboard = new GlobalKeyboardListener();

// Track modifier states
let ctrlDown = false;
let shiftDown = false;
let altDown = false;

// Check if hotkey combo is pressed
function isHotkeyPressed(key) {
    const keyMatch = key.toUpperCase() === config.hotkey.key.toUpperCase();
    const ctrlMatch = config.hotkey.ctrl ? ctrlDown : !ctrlDown;
    const shiftMatch = config.hotkey.shift ? shiftDown : !shiftDown;
    const altMatch = config.hotkey.alt ? altDown : !altDown;
    
    return keyMatch && ctrlMatch && shiftMatch && altMatch;
}

// Handle key events
keyboard.addListener(async (e, down) => {
    // Track modifier states
    if (e.name === 'LEFT CTRL' || e.name === 'RIGHT CTRL') {
        ctrlDown = e.state === 'DOWN';
    }
    if (e.name === 'LEFT SHIFT' || e.name === 'RIGHT SHIFT') {
        shiftDown = e.state === 'DOWN';
    }
    if (e.name === 'LEFT ALT' || e.name === 'RIGHT ALT') {
        altDown = e.state === 'DOWN';
    }
    
    // Check for hotkey
    if (isHotkeyPressed(e.name)) {
        if (e.state === 'DOWN' && !isRecording) {
            // Start recording
            isRecording = true;
            
            if (config.audioFeedback) playStartSound();
            console.log('🎤 Recording...');
            
            recorder = new Recorder();
            recorder.start();
            
        } else if (e.state === 'UP' && isRecording) {
            // Stop recording and process
            isRecording = false;
            
            if (config.audioFeedback) playStopSound();
            console.log('⏹️  Stopped. Transcribing...');
            
            try {
                const audioPath = await recorder.stop();
                
                if (!config.whisperApiKey) {
                    console.log('❌ No API key - cannot transcribe');
                    if (config.audioFeedback) playErrorSound();
                    return;
                }
                
                const text = await transcribe(audioPath, config.whisperApiKey);
                
                if (text && text.trim()) {
                    console.log(`📝 "${text}"`);
                    await typeIntoClaude(text, config.claudeWindowTitle, config.autoSend);
                    if (config.audioFeedback) playSuccessSound();
                } else {
                    console.log('⚠️  No speech detected');
                    if (config.audioFeedback) playErrorSound();
                }
            } catch (err) {
                console.error('❌ Error:', err.message);
                if (config.audioFeedback) playErrorSound();
            }
            
            console.log('');
        }
    }
});

// Handle exit
process.on('SIGINT', () => {
    console.log('\nExiting...');
    if (recorder) recorder.stop();
    process.exit(0);
});
