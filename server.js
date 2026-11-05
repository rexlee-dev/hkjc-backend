import { Hono } from 'hono';
import { cors } from 'hono/cors';
import axios from 'axios';
// 引入根目錄的 meetings.json (Cloudflare Worker 支援 JSON module 導入)
import meetingsConfig from './meetings.json';

const app = new Hono();

// 啟用 CORS
app.use('*', cors());

// 💡 顯式指定 UTF-8 編碼，徹底解決手機 Safari 直接打開網址時的中文亂碼問題
const jsonResponse = (c, data, status = 200) => {
    return c.newResponse(JSON.stringify(data), status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
    });
};

// 模擬馬會瀏覽器請求標頭
const hkjcHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    'Origin': 'https://racing.hkjc.com',
    'Referer': 'https://racing.hkjc.com/'
};

// 記憶體快取
const oddsCache = {};

// 0. 伺服器健康檢查
app.get('/', (c) => {
    return jsonResponse(c, {
        status: 'online',
        serverTime: new Date().toISOString(),
        message: 'HKJC Official GraphQL Multi-Meeting Odds Server (Cloudflare Worker) is running.'
    });
});

// 1. 賽事選單 API (動態讀取 meetings.json)
app.get('/api/meetings', (c) => {
    try {
        const meetings = meetingsConfig.meetings || [];
        return jsonResponse(c, {
            status: 'success',
            meetings: meetings
        });
    } catch (err) {
        console.error('Error reading meetings data:', err.message);
        return jsonResponse(c, {
            status: 'success',
            meetings: [
                { date: "2026-11-04", venue: "HV", name: "2026-11-04 跑馬地 (HV)" },
                { date: "2026-11-08", venue: "ST", name: "2026-11-08 沙田 (ST)" }
            ]
        });
    }
});

// 2. 核心排位數據 API
app.get('/api/odds', async (c) => {
    const dateStr = c.req.query('date') || '2026-11-04';
    const venueCode = c.req.query('venue') || 'HV';

    const graphqlQuery = `query racing($date:String$venueCode:String){raceMeetings(date:$date venueCode:$venueCode){status currentNumberOfRace totalInvestment races{no
