const express = require('express');
const cors = require('cors');
const axios = require('axios');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

// 1. 啟用 Keep-Alive Agent 減少 TCP 握手次數，防範 503 限流
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

const axiosInstance = axios.create({
    httpAgent,
    httpsAgent,
    timeout: 10000
});

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

app.get('/', (req, res) => {
    res.json({
        status: 'online',
        serverTime: new Date().toISOString(),
        message: 'HKJC Official GraphQL Multi-Meeting Odds Server is running.'
    });
});

// 1. 賽事選單 API (讀取 meetings.json)
app.get('/api/meetings', (req, res) => {
    try {
        const filePath = path.join(__dirname, 'meetings.json');
        if (fs.existsSync(filePath)) {
            const rawData = fs.readFileSync(filePath, 'utf8');
            const config = JSON.parse(rawData);
            return res.json({ status: 'success', meetings: config.meetings || [] });
        } else {
            return res.json({
                status: 'success',
                meetings: [
                    { date: "2026-10-24", venue: "S1", name: "2026-10-24 S1 賽事" },
                    { date: "2026-10-25", venue: "ST", name: "2026-10-25 沙田 (ST)" },
                    { date: "2026-10-25", venue: "S2", name: "2026-10-25 S2 賽事" }
                ]
            });
        }
    } catch (err) {
        console.error('Error reading meetings.json:', err.message);
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

// 2. 核心排位數據 API (改用標準 POST 請求，徹底避開 URL 400 攔截)
app.get('/api/odds', async (req, res) => {
    const dateStr = req.query.date || '2026-11-01';
    const venueCode = req.query.venue || 'HV';

    // 官方完整的 Fragment 與查詢結構
    const graphqlQuery = `
        fragment raceFragment on Race {
            id no status raceName_en raceName_ch postTime country_en country_ch distance wageringFieldSize go_en go_ch ratingType 
            raceTrack { description_en description_ch } 
            raceCourse { description_en description_ch displayCode } 
            claCode raceClass_en raceClass_ch 
            judgeSigns { value_en }
        }
        query raceMeetings($date: String, $venueCode: String) {
            raceMeetings(date: $date, venueCode: $venueCode) {
                status currentNumberOfRace totalInvestment 
                races {
                    ...raceFragment
                    runners {
                        id no standbyNo status name_ch name_en 
                        horse { id code } 
                        color barrierDrawNumber handicapWeight currentWeight currentRating internationalRating gearInfo racingColorFileName allowance trainerPreference last6run saddleClothNo trumpCard priority finalPosition deadHeat winOdds 
                        jockey { code name_en name_ch } 
                        trainer { code name_en name_ch }
                    }
                }
            }
        }
    `;

    // 改為 POST 要求的標準 payload 結構
    const postPayload = {
        query: graphqlQuery,
        operationName: "raceMeetings",
        variables: {
            date: dateStr,
            venueCode: venueCode
        }
    };

    // 馬會 GraphQL POST 端點 (注意：通常 base-get 係 GET，如果用 POST 要用主 endpoint 或者是原本那個 URL 轉 POST)
    // 實測好多時將 base-get 改為 base 或者是直接 POST 去原本個 URL
    const graphqlUrl = `https://info.cld.hkjc.com/graphql/base-get/`;

    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            // 轉用 axios.post，把查詢內容放入 JSON body
            const response = await axiosInstance.post(graphqlUrl, postPayload, { 
                headers: {
                    ...hkjcHeaders,
                    'Content-Type': 'application/json'
                } 
            });

            const rawData = response.data;

            if (rawData.errors) {
                console.error('[GraphQL Error from HKJC]:', JSON.stringify(rawData.errors, null, 2));
                return res.status(400).json({ status: "error", message: "馬會返回 GraphQL 錯誤", details: rawData.errors });
            }

            const raceMeetings = rawData?.data?.raceMeetings || [];

            if (!raceMeetings || raceMeetings.length === 0) {
                return res.status(404).json({
                    status: "no_data",
                    message: `馬會於 ${dateStr} (${venueCode}) 未有賽事資料或排位表。`,
                    races: []
                });
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
                    winOdds: r.winOdds || "-",
                    plaOdds: "-"
                }));

                return {
                    raceNo: race.no,
                    status: race.status || "SCHEDULED",
                    postTime: race.postTime || "",
                    raceClass: race.raceClass_ch || "",
                    raceCourse: race.raceCourse?.description_ch || "",
                    raceTrack: race.raceTrack?.description_ch || "",
                    distance: race.distance || "",
                    raceName: race.raceName_ch || "",
                    totalRunners: runners.length,
                    runners: runners
                };
            });

            return res.json({
                status: "success",
                message: `成功取得馬會官方排位與賽事詳細數據 (${dateStr})`,
                meetingDate: dateStr,
                venue: venueCode,
                totalRaces: formattedRaces.length,
                races: formattedRaces
            });

        } catch (err) {
            console.warn(`[Odds Attempt ${attempt} Failed]: ${err.message}`);
            if (err.response) {
                console.error(`[Axios POST Error Data]:`, err.response.data);
            }
            if (attempt === 2) {
                return res.status(502).json({
                    status: "error",
                    message: "無法取得馬會伺服器數據。",
                    errorDetails: err.response?.data || err.message
                });
            }
            await new Promise(r => setTimeout(r, 500));
        }
    }
});
// 3. 專用實時賠率 API (強效防 503 防護機制)
app.get('/api/pool-odds', async (req, res) => {
    const dateStr = req.query.date;
    const venueCode = req.query.venue;
    const raceNo = parseInt(req.query.raceNo || req.query.raceno, 10) || 1;

    if (!dateStr || !venueCode) {
        return res.status(400).json({ status: 'error', message: 'Missing date or venue.' });
    }

    const cacheKey = `${dateStr}_${venueCode}_${raceNo}`;
    const now = Date.now();

    const isLocalMeeting = (venueCode === 'ST' || venueCode === 'HV');
    const currentTTL = isLocalMeeting ? 6000 : 12000;

    if (oddsCache[cacheKey] && (now - oddsCache[cacheKey].timestamp < currentTTL)) {
        return res.json(oddsCache[cacheKey].data);
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
            const response = await axiosInstance.get(graphqlUrl, { headers: hkjcHeaders });

            if (response.data && !response.data.errors) {
                oddsCache[cacheKey] = {
                    timestamp: now,
                    data: response.data
                };
                return res.json(response.data);
            }
        } catch (err) {
            console.warn(`[Pool-Odds Attempt ${attempt} Failed for ${venueCode} R${raceNo}]: ${err.message}`);

            if (oddsCache[cacheKey]) {
                console.log(`[503 PREVENTED] Serving fallback cache for ${cacheKey}`);
                return res.json(oddsCache[cacheKey].data);
            }

            if (attempt === 1) {
                await new Promise(r => setTimeout(r, 600));
            } else {
                return res.status(503).json({
                    status: 'error',
                    message: '馬會伺服器暫時繁忙 (503 Service Unavailable)',
                    errorDetails: err.message
                });
            }
        }
    }
});

// 4. 多場次實時賠率 API
app.get('/api/mutliPool-odds', async (req, res) => {
    const dateStr = req.query.date;
    const venueCode = req.query.venue;
    const raceNoParam = req.query.raceNo || req.query.raceno || '1';

    if (!dateStr || !venueCode) {
        return res.status(400).json({ status: 'error', message: 'Missing date or venue.' });
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
                const response = await axiosInstance.get(graphqlUrl, { headers: hkjcHeaders });
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

    return res.json({
        status: 'success',
        date: dateStr,
        venue: venueCode,
        racesOdds: results
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`HKJC Proxy Server with Keep-Alive running on port ${PORT}`);
});
