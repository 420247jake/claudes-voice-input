/**
 * Typer Module - Uses AutoHotkey for reliable window automation
 */

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

async function typeIntoClaude(text, windowTitle = 'Claude', autoSend = true) {
    return new Promise((resolve, reject) => {
        // Write text to temp file
        const tempFile = path.join(__dirname, '..', 'to_paste.txt');
        fs.writeFileSync(tempFile, text.trim(), 'utf8');
        
        const ahkScript = path.join(__dirname, '..', 'paste_to_claude.ahk');
        const ahkExe = path.join(process.env.LOCALAPPDATA, 'Programs', 'AutoHotkey', 'v2', 'AutoHotkey64.exe');
        
        // Run AutoHotkey script
        exec(`"${ahkExe}" "${ahkScript}" "${tempFile}"`, (err, stdout, stderr) => {
            // Cleanup
            setTimeout(() => {
                try { fs.unlinkSync(tempFile); } catch(e) {}
            }, 1000);
            
            if (err) {
                console.log('AHK error:', err.message);
                reject(err);
            } else {
                console.log('✅ Sent to Claude via AutoHotkey');
                resolve();
            }
        });
    });
}

module.exports = { typeIntoClaude };
