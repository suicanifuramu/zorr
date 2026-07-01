// test_discord.js — Discord通知の動作確認スクリプト
const https = require('https');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const token = process.env.DISCORD_BOT_TOKEN;
const channelId = process.argv[2]; // コマンドライン引数から取得

if (!token) { console.error('ERROR: DISCORD_BOT_TOKEN not set in .env'); process.exit(1); }
if (!channelId) { console.error('Usage: node test_discord.js <channelId>'); process.exit(1); }

const content = `Test notification from Zorr bot — $(new Date().toISOString())`;

const body = JSON.stringify({ content });
const req = https.request({
    hostname: 'discord.com',
    port: 443,
    path: `/api/v10/channels/${channelId}/messages`,
    method: 'POST',
    headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
    }
}, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
        if (res.statusCode === 200) {
            console.log('✓ Success! Message sent.');
            console.log('Message ID:', JSON.parse(data).id);
        } else {
            console.error(`✗ Failed (${res.statusCode}):`, data);
        }
    });
});
req.on('error', e => console.error('✗ Request error:', e.message));
req.end(body);
