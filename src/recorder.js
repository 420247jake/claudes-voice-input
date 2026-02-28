/**
 * Audio Recorder Module (Windows Native via naudiodon)
 * 
 * Records audio from microphone using native Windows APIs
 */

const portAudio = require('naudiodon');
const fs = require('fs');
const path = require('path');

class Recorder {
    constructor() {
        this.audioPath = path.join(__dirname, '..', 'temp_audio.wav');
        this.chunks = [];
        this.audioIO = null;
        this.sampleRate = 16000;
        this.channels = 1;
        this.bitDepth = 16;
    }
    
    start() {
        this.chunks = [];
        
        this.audioIO = new portAudio.AudioIO({
            inOptions: {
                channelCount: this.channels,
                sampleFormat: portAudio.SampleFormat16Bit,
                sampleRate: this.sampleRate,
                deviceId: -1, // Default device
                closeOnError: false
            }
        });
        
        this.audioIO.on('data', (chunk) => {
            this.chunks.push(chunk);
        });
        
        this.audioIO.on('error', (err) => {
            console.error('Audio error:', err.message);
        });
        
        this.audioIO.start();
    }
    
    async stop() {
        return new Promise((resolve, reject) => {
            if (!this.audioIO) {
                reject(new Error('Not recording'));
                return;
            }
            
            this.audioIO.quit();
            
            // Combine chunks
            const rawData = Buffer.concat(this.chunks);
            
            // Create WAV file
            const wavHeader = this.createWavHeader(rawData.length);
            const wavFile = Buffer.concat([wavHeader, rawData]);
            
            // Write to file
            fs.writeFileSync(this.audioPath, wavFile);
            
            this.audioIO = null;
            this.chunks = [];
            
            resolve(this.audioPath);
        });
    }
    
    createWavHeader(dataLength) {
        const header = Buffer.alloc(44);
        const byteRate = this.sampleRate * this.channels * this.bitDepth / 8;
        const blockAlign = this.channels * this.bitDepth / 8;
        
        // RIFF header
        header.write('RIFF', 0);
        header.writeUInt32LE(36 + dataLength, 4);
        header.write('WAVE', 8);
        
        // fmt chunk
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16); // Subchunk size
        header.writeUInt16LE(1, 20); // PCM format
        header.writeUInt16LE(this.channels, 22);
        header.writeUInt32LE(this.sampleRate, 24);
        header.writeUInt32LE(byteRate, 28);
        header.writeUInt16LE(blockAlign, 32);
        header.writeUInt16LE(this.bitDepth, 34);
        
        // data chunk
        header.write('data', 36);
        header.writeUInt32LE(dataLength, 40);
        
        return header;
    }
}

module.exports = Recorder;
