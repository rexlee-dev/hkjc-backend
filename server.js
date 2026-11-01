const express = require('express');
const cors = require('cors');
const axios = require('axios');
const http = require('http');
const https = require('https');

const app = express();
app.use(cors());

// 1. 啟用 Keep-Alive Agent 減少 TCP 握手次數
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
    'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8',
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

// 1. 動態賽事選單 API (修復 400 錯誤：確保日期格式為 YYYYMMDD)
// 1. 動態賽事選單 API (使用標準 operationName 避開 400 錯誤)
app.get('/api/meetings', async (req, res) => {
    // 嚴格對應馬會認可的 operationName 與查詢架構
    const graphqlQuery = `query raceMeetings {
        activeMeetings: raceMeetings {
            id
            venueCode
            date
            status
            races {
                no
                postTime
                status
                wageringFieldSize
            }
        }
    }`;
    
    const graphqlUrl = `https://info.cld.hkjc.com/graphql/base-get/?query=${encodeURIComponent(graphqlQuery)}&operationName=raceMeetings`;

    try {
        const response = await axiosInstance.get(graphqlUrl, { headers: hkjcHeaders });
        const rawData = response.data;

        if (rawData.errors) {
            console.error('GraphQL Errors in /api/meetings:', rawData.errors);
            throw new Error(rawData.errors[0]?.message || 'GraphQL query errors');
        }

        const activeMeetings = rawData?.data?.activeMeetings || [];

        // 自動過濾出 status 為 DEFINED 的場次，完全取代手動 meetings.json
        const definedMeetings = activeMeetings
            .filter(m => m.status === 'DEFINED')
            .map(m => ({
                id: m.id,
                date: m.date,
                venue: m.venueCode,
                status: m.status,
                name: `${m.date} ${m.venueCode} 賽事 (${m.status})`
            }));

        return res.json({
            status: 'success',
            count: definedMeetings.length,
            meetings: definedMeetings
        });
    } catch (err) {
        console.error('Error fetching dynamic meetings:', err.response?.data || err.message);
        return res.status(500).json({ 
            status: 'error', 
            message: err.message, 
            details: err.response?.data || null 
        });
    }
});

// 2. 升級版核心排位與賽事詳情 API (修復 400 錯誤：簡化並修正 variables 參數傳遞)
app.get('/api/odds', async (req, res) => {
    const dateStr = (req.query.date || '2026-11-01').replace(/-/g, ''); // 必須為 YYYYMMDD 格式
    const venueCode = req.query.venue || 'HV';

    // 簡化且穩定的 GraphQL 查詢結構
    const graphqlQuery = `query raceMeetings($date: String, $venueCode: String) {
        raceMeetings(date: $date, venueCode: $venueCode) {
            id
            status
            venueCode
            date
            totalNumberOfRace
            currentNumberOfRace
            races {
                no
                status
                raceName_en
                raceName_ch
                postTime
                distance
                raceClass_en
                raceClass_ch
                go_en
                go_ch
                raceTrack { description_en description_ch }
                raceCourse { description_en description_ch displayCode }
                runners {
                    no
                    saddleClothNo
                    standbyNo
                    status
                    name_ch
                    name_en
                    barrierDrawNumber
                    handicapWeight
                    currentRating
                    gearInfo
                    last6run
                    jockey { code name_en name_ch }
                    trainer { code name_en name_ch }
                }
            }
        }
    }`;
    
    const graphqlVariables = JSON.stringify({ date: dateStr, venueCode: venueCode });
    const graphqlUrl = `https://info.cld.hkjc.com/graphql/base-get/?query=${encodeURIComponent(graphqlQuery)}&operationName=raceMeetings&variables=${encodeURIComponent(graphqlVariables)}`;

    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const response = await axiosInstance.get(graphqlUrl, { headers: hkjcHeaders });
            const rawData = response.data;

            if (rawData.errors) {
                console.error('GraphQL Errors:', rawData.errors);
                throw new Error(rawData.errors[0]?.message || 'GraphQL query returned errors');
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

            // 結構化洗練賽事與排位資料
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
                    standbyNo: r.standbyNo || null,
                    winOdds: "-",
                    plaOdds: "-"
                }));

                return {
                    raceNo: race.no,
                    status: race.status || "SCHEDULED",
                    raceName: race.raceName_ch || "",
                    raceNameEn: race.raceName_en || "",
                    postTime: race.postTime || "",
                    distance: race.distance || "",
                    raceClass: race.raceClass_ch || "",
                    raceClassEn: race.raceClass_en || "",
                    raceCourse: race.raceCourse?.description_ch || "",
                    raceCourseCode: race.raceCourse?.displayCode || "",
                    raceTrack: race.raceTrack?.description_ch || "",
                    going: race.go_ch || "",
                    totalRunners: runners.length,
                    runners: runners
                };
            });

            return res.json({
                status: "success",
                message: `成功取得馬會官方賽事詳情與排位數據 (${dateStr})`,
                meetingId: meeting.id,
                meetingDate: dateStr,
                venue: venueCode,
                meetingStatus: meeting.status,
                totalNumberOfRace: meeting.totalNumberOfRace,
                totalRaces: formattedRaces.length,
                races: formattedRaces
            });

        } catch (err) {
            console.warn(`[Odds Attempt ${attempt} Failed]:`, err.response?.data || err.message);
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

// 3. 專用實時賠率 API
app.get('/api/pool-odds', async (req, res) => {
    const dateStr = req.query.date;
    const venueCode = req.query.venue;
    const raceNo = parseInt(req.query.raceNo, 10) || 1;

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

    const graphqlQuery = `query sp4e_racing_pmPool($date: String, $venueCode: String, $oddsTypes: [OddsType], $raceNo: Int) {
        raceMeetings(date: $date, venueCode: $venueCode) {
            pmPools(oddsTypes: $oddsTypes, raceNo: $raceNo) {
                id status sellStatus oddsType lastUpdateTime oddsLastUpdateTime guarantee minTicketCost name_en name_ch
                cWinSelections { composite name_en name_ch starters }
                oddsNodes { combString oddsValue hotFavourite oddsDropValue bankerOdds { combString oddsValue } }
            }
        }
    }`;

    const graphqlVariables = JSON.stringify({
        date: dateStr,
        venueCode: venueCode,
        raceNo: raceNo,
        oddsTypes: ["WIN", "PLA"]
    });

    const graphqlUrl = `https://info.cld.hkjc.com/graphql/base-get/?query=${encodeURIComponent(graphqlQuery)}&operationName=sp4e_racing_pmPool&variables=${encodeURIComponent(graphqlVariables)}`;

    try {
        const response = await axiosInstance.get(graphqlUrl, { headers: hkjcHeaders });
        if (response.data && !response.data.errors) {
            oddsCache[cacheKey] = { timestamp: now, data: response.data };
            return res.json(response.data);
        }
        throw new Error(response.data.errors?.[0]?.message || 'Pool odds query failed');
    } catch (err) {
        if (oddsCache[cacheKey]) {
            return res.json(oddsCache[cacheKey].data);
        }
        return res.status(503).json({ status: 'error', message: '馬會伺服器暫時繁忙', errorDetails: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`HKJC Proxy Server running on port ${PORT}`);
});
