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

// 2. 核心排位數據 API (已強化提取 postTime, raceClass, raceCourse, raceTrack)
const express = require('express');
const axios = require('axios');
const router = express.Router();

// 馬會 GraphQL 端點（請根據你實際使用的 Endpoint 調整）
const HKJC_GRAPHQL_URL = 'https://api.hkjc.com/v1/graphql'; // 範例網址，請換成你原本使用的

router.get('/odds', async (req, res) => {
    try {
        const { date, venueCode } = req.query;

        // 1. 建立 GraphQL 查詢字串與變數
        const graphqlQuery = {
            query: `
                query GetRaceMeetings($date: String!, $venueCode: String) {
                    raceMeetings(date: $date, venueCode: $venueCode) {
                        venueCode
                        meetingDate
                        races {
                            raceNo
                            status
                            runners {
                                no
                                name
                                jockey
                                trainer
                                draw
                                status
                                standbyNo
                            }
                            poolInvs {
                                poolId
                                totalInvestment
                                lastUpdateTime
                            }
                        }
                    }
                }
            `,
            variables: {
                date: date || new Date().toISOString().split('T')[0].replace(/-/g, ''), // 預設為當天日期格式 YYYYMMDD
                venueCode: venueCode || null
            }
        };

        // 2. 請求馬會 GraphQL 伺服器
        const response = await axios.post(HKJC_GRAPHQL_URL, graphqlQuery, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            },
            timeout: 8000 // 設 8 秒逾時
        });

        const data = response.data;

        if (data.errors) {
            return res.status(400).json({ success: false, errors: data.errors });
        }

        const rawMeetings = data.data?.raceMeetings || [];

        // 3. 資料清洗與防禦性處理
        const cleanedMeetings = rawMeetings.map(meeting => {
            return {
                venueCode: meeting.venueCode,
                meetingDate: meeting.meetingDate,
                races: (meeting.races || []).map(race => {
                    
                    // 過濾或處理出馬表 (runners)
                    const processedRunners = (race.runners || []).map(runner => {
                        return {
                            no: runner.no || '',
                            name: runner.name || 'Unknown',
                            jockey: runner.jockey || '---',
                            trainer: runner.trainer || '---',
                            draw: runner.draw || null,
                            status: runner.status || 'Declared', // 預設為出賽
                            standbyNo: runner.standbyNo || null,
                            // 標記是否為正式出賽馬（排除 Standby 後備馬未補上的空號）
                            isDeclared: runner.status !== 'Standby' && !!runner.no
                        };
                    });

                    // 處理彩池投資額 (poolInvs)
                    const processedPools = (race.poolInvs || []).map(pool => {
                        return {
                            poolId: pool.poolId || '',
                            totalInvestment: pool.totalInvestment || 0,
                            // 若 lastUpdateTime 為空，給予預設值或當前時間防錯
                            lastUpdateTime: pool.lastUpdateTime || new Date().toISOString()
                        };
                    });

                    return {
                        raceNo: race.raceNo,
                        status: race.status,
                        runners: processedRunners,
                        poolInvs: processedPools
                    };
                })
            };
        });

        // 4. 返回乾淨的結構化資料給前端/手機端
        return res.json({
            success: true,
            timestamp: new Date().toISOString(),
            data: cleanedMeetings
        });

    } catch (error) {
        console.error('Error fetching HKJC GraphQL odds:', error.message);
        return res.status(500).json({
            success: false,
            error: 'Failed to fetch odds data',
            details: error.message
        });
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
