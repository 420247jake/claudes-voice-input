/**
 * Transcription Module
 * 
 * Uses OpenAI Whisper API for speech-to-text
 */

const fs = require('fs');
const OpenAI = require('openai');

async function transcribe(audioPath, apiKey) {
    const openai = new OpenAI({ apiKey });
    
    const audioFile = fs.createReadStream(audioPath);
    
    const response = await openai.audio.transcriptions.create({
        file: audioFile,
        model: 'whisper-1',
        response_format: 'text'
    });
    
    // Clean up temp file
    try {
        fs.unlinkSync(audioPath);
    } catch (e) {}
    
    return response;
}

module.exports = { transcribe };
