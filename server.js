import { Hono } from 'hono';
import { cors } from 'hono/cors';
import axios from 'axios';
import * as cheerio from 'cheerio';

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

// 2. 核心排位數據 API (已新增 finalPosition 賽果名次)
app.get('/api/odds', async (c) => {
    const dateStr = c.req.query('date') || '2026-11-04';
    const venueCode = c.req.query('venue') || 'HV';

    const graphqlQuery = `query racing($date:String$venueCode:String){raceMeetings(date:$date venueCode:$venueCode){status currentNumberOfRace totalInvestment races{no status runners{id no standbyNo status name_ch name_en horse{id code}color barrierDrawNumber handicapWeight currentWeight currentRating internationalRating gearInfo racingColorFileName allowance trainerPreference last6run saddleClothNo trumpCard priority finalPosition deadHeat winOdds jockey{code name_en name_ch}trainer{code name_en name_ch}}}}}`;
    const graphqlVariables = JSON.stringify({ date: dateStr, venueCode: venueCode });
    const graphqlUrl = `https://info.cld.hkjc.com/graphql/base-get/?query=${encodeURIComponent(graphqlQuery)}&operationName=racing&variables=${encodeURIComponent(graphqlVariables)}`;

    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const response = await axios.get(graphqlUrl, { headers: hkjcHeaders, timeout: 8000 });
            const rawData = response.data;
            const raceMeetings = rawData?.data?.raceMeetings || rawData?.raceMeetings || [];

            if (!raceMeetings || raceMeetings.length === 0) {
                return jsonResponse(c, {
                    status: "no_data",
                    message: `馬會於 ${dateStr} (${venueCode}) 未有賽事資料或排位表。`,
                    races: []
                }, 404);
            }

            const meeting = raceMeetings[0];
            const racesList = meeting.races || [];

            const formattedRaces = racesList.map(race => {
                const runners = (race.runners || []).map(r => ({
                    horseNo: r.no ?? r.saddleClothNo ?? "-",
                    horseName: r.name_ch || r.name_en || "-",
                    horseNameEn: r.name_en || "",
                    draw: r.barrierDrawNumber ?? "-",
                    weight: r.handicapWeight ?? "-",
                    rating: r.currentRating ?? "-",
                    last6run: r.last6run ?? "-",
                    gearInfo: r.gearInfo ?? "",
                    jockey: r.jockey?.name_ch || r.jockey?.name_en || "-",
                    trainer: r.trainer?.name_ch || r.trainer?.name_en || "-",
                    status: r.status || "NORMAL",
                    finalPosition: r.finalPosition ?? "-", // 💡 官方名次 (未開跑或已被刮掉為 "-")
                    deadHeat: r.deadHeat ?? false,          // 💡 是否平頭
                    winOdds: "-",
                    plaOdds: "-"
                }));

                return {
                    raceNo: race.no,
                    status: race.status || "SCHEDULED",
                    totalRunners: runners.length,
                    runners: runners
                };
            });

            return jsonResponse(c, {
                status: "success",
                message: `成功取得馬會官方排位及名次數據 (${dateStr})`,
                meetingDate: dateStr,
                venue: venueCode,
                totalRaces: formattedRaces.length,
                races: formattedRaces
            });

        } catch (err) {
            console.warn(`[Odds Attempt ${attempt} Failed]: ${err.message}`);
            if (attempt === 2) {
                return jsonResponse(c, {
                    status: "error",
                    message: "無法取得馬會伺服器數據。",
                    errorDetails: err.message
                }, 502);
            }
            await new Promise(r => setTimeout(r, 500));
        }
    }
});
                
// 3. 專用實時賠率 API (使用已驗證 100% 成功的 Query)
app.get('/api/pool-odds', async (c) => {
    const dateStr = c.req.query('date');
    const venueCode = c.req.query('venue');
    const raceNo = parseInt(c.req.query('raceNo') || c.req.query('raceno') || '1', 10);

    if (!dateStr || !venueCode) {
        return jsonResponse(c, { status: 'error', message: 'Missing date or venue.' }, 400);
    }

    const cacheKey = `${dateStr}_${venueCode}_${raceNo}`;
    const now = Date.now();

    const isLocalMeeting = (venueCode === 'ST' || venueCode === 'HV');
    const currentTTL = isLocalMeeting ? 6000 : 12000;

    if (oddsCache[cacheKey] && (now - oddsCache[cacheKey].timestamp < currentTTL)) {
        return jsonResponse(c, oddsCache[cacheKey].data);
    }

    // 💡 換上你剛才測試成功的完美 Query
    const graphqlQuery = `query sp4e_racing_pmPool($date:String$venueCode:String$oddsTypes:[OddsType]$raceNo:Int){raceMeetings(date:$date venueCode:$venueCode){pmPools(oddsTypes:$oddsTypes raceNo:$raceNo){id status sellStatus oddsType lastUpdateTime oddsLastUpdateTime guarantee minTicketCost name_en name_ch leg{number races}cWinSelections{composite name_ch name_en starters}oddsNodes{combString oddsValue hotFavourite oddsDropValue bankerOdds{combString oddsValue}}}}}`;

    const graphqlVariables = JSON.stringify({
        date: dateStr,
        venueCode: venueCode,
        raceNo: raceNo,
        oddsTypes: ["WIN", "PLA"]
    });

    const graphqlUrl = `https://info.cld.hkjc.com/graphql/base-get/?query=${encodeURIComponent(graphqlQuery)}&operationName=sp4e_racing_pmPool&variables=${encodeURIComponent(graphqlVariables)}`;

    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const response = await axios.get(graphqlUrl, { headers: hkjcHeaders, timeout: 8000 });

            if (response.data && !response.data.errors) {
                oddsCache[cacheKey] = {
                    timestamp: now,
                    data: response.data
                };
                return jsonResponse(c, response.data);
            }
        } catch (err) {
            console.warn(`[Pool-Odds Attempt ${attempt} Failed for ${venueCode} R${raceNo}]: ${err.message}`);

            if (oddsCache[cacheKey]) {
                return jsonResponse(c, oddsCache[cacheKey].data);
            }

            if (attempt === 1) {
                await new Promise(r => setTimeout(r, 600));
            } else {
                return jsonResponse(c, {
                    status: 'error',
                    message: '馬會伺服器暫時繁忙 (503 Service Unavailable)',
                    errorDetails: err.message
                }, 503);
            }
        }
    }
});

// 4. 多場次實時賠率 API (同步使用正確的 Query)
app.get('/api/mutliPool-odds', async (c) => {
    const dateStr = c.req.query('date');
    const venueCode = c.req.query('venue');
    const raceNoParam = c.req.query('raceNo') || c.req.query('raceno') || '1';

    if (!dateStr || !venueCode) {
        return jsonResponse(c, { status: 'error', message: 'Missing date or venue.' }, 400);
    }

    let raceNos = [];
    if (raceNoParam.includes('-')) {
        const [start, end] = raceNoParam.split('-').map(n => parseInt(n, 10));
        for (let i = start; i <= end; i++) raceNos.push(i);
    } else if (raceNoParam.includes(',')) {
        raceNos = raceNoParam.split(',').map(n => parseInt(n.trim(), 10)).filter(n => !isNaN(n));
    } else {
        const single = parseInt(raceNoParam, 10);
        raceNos = isNaN(single) ? [1] : [single];
    }

    const now = Date.now();
    const isLocalMeeting = (venueCode === 'ST' || venueCode === 'HV');
    const currentTTL = isLocalMeeting ? 6000 : 12000;

    const results = await Promise.all(raceNos.map(async (raceNo) => {
        const cacheKey = `${dateStr}_${venueCode}_${raceNo}`;

        if (oddsCache[cacheKey] && (now - oddsCache[cacheKey].timestamp < currentTTL)) {
            return { raceNo, status: 'success', data: oddsCache[cacheKey].data };
        }

        const graphqlQuery = `query sp4e_racing_pmPool($date:String$venueCode:String$oddsTypes:[OddsType]$raceNo:Int){raceMeetings(date:$date venueCode:$venueCode){pmPools(oddsTypes:$oddsTypes raceNo:$raceNo){id status sellStatus oddsType lastUpdateTime oddsLastUpdateTime guarantee minTicketCost name_en name_ch leg{number races}cWinSelections{composite name_ch name_en starters}oddsNodes{combString oddsValue hotFavourite oddsDropValue bankerOdds{combString oddsValue}}}}}`;

        const graphqlVariables = JSON.stringify({
            date: dateStr,
            venueCode: venueCode,
            raceNo: raceNo,
            oddsTypes: ["WIN", "PLA"]
        });

        const graphqlUrl = `https://info.cld.hkjc.com/graphql/base-get/?query=${encodeURIComponent(graphqlQuery)}&operationName=sp4e_racing_pmPool&variables=${encodeURIComponent(graphqlVariables)}`;

        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const response = await axios.get(graphqlUrl, { headers: hkjcHeaders, timeout: 8000 });
                if (response.data && !response.data.errors) {
                    oddsCache[cacheKey] = {
                        timestamp: now,
                        data: response.data
                    };
                    return { raceNo, status: 'success', data: response.data };
                }
            } catch (err) {
                if (attempt === 2) {
                    if (oddsCache[cacheKey]) {
                        return { raceNo, status: 'success_fallback', data: oddsCache[cacheKey].data };
                    }
                    return { raceNo, status: 'error', message: err.message };
                }
                await new Promise(r => setTimeout(r, 400));
            }
        }
        return { raceNo, status: 'error', message: 'Failed to fetch odds' };
    }));

    return jsonResponse(c, {
        status: 'success',
        date: dateStr,
        venue: venueCode,
        racesOdds: results
    });
});

// 5. 爬取官方網頁本地賽事資訊 API (專注處理 ST / HV)
app.get('/api/scrape-race', async (c) => {
    const dateStr = c.req.query('date') || '2026-11-08'; // 格式: YYYY-MM-DD
    const venue = (c.req.query('venue') || 'ST').toUpperCase();
    const raceNo = c.req.query('raceNo') || '1';

    // 檢查是否為本地賽事
    if (venue !== 'ST' && venue !== 'HV') {
        return jsonResponse(c, {
            status: 'error',
            message: '此 Endpoint 現僅支援本地賽事 (ST 或 HV)。'
        }, 400);
    }

    const dateSlash = dateStr.replace(/-/g, '/');
    const targetUrl = `https://racing.hkjc.com/zh-hk/local/information/racecard?racedate=${dateSlash}&Racecourse=${venue}&RaceNo=${raceNo}`;

    try {
        const response = await axios.get(targetUrl, { 
            headers: {
                ...hkjcHeaders,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
            }, 
            timeout: 8000 
        });

        const html = response.data;
        const $ = cheerio.load(html);

        const containerText = $('div.f_fs13').text();
        const raceName = $('div.f_fs13 span.font_wb').text().trim();
        const timeMatch = containerText.match(/(\d{2}:\d{2})/);
        const distanceMatch = containerText.match(/(\d+)\s*米/);
        const classMatch = containerText.match(/(第[一二三四五]班|新馬賽|分級賽)/);

        const raceInfo = {
            type: 'local',
            venue: venue,
            raceNo: raceNo,
            raceName: raceName || '-',
            postTime: timeMatch ? timeMatch[1] : '-',
            distance: distanceMatch ? distanceMatch[1] + '米' : '-',
            raceClass: classMatch ? classMatch[1] : '-',
            rawText: containerText.trim()
        };

        return jsonResponse(c, {
            status: 'success',
            targetUrl: targetUrl,
            data: raceInfo
        });

    } catch (err) {
        console.warn(`[Scrape Error]: ${err.message}`);
        return jsonResponse(c, { 
            status: 'error', 
            message: `無法抓取網頁資料: ${err.message}`,
            url: targetUrl 
        }, 502);
    }
});

export default app;
