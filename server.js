const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

// 模擬馬會瀏覽器請求標頭
const hkjcHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    'Origin': 'https://racing.hkjc.com',
    'Referer': 'https://racing.hkjc.com/'
};

// 記憶體快取 (減少向馬會發送請求頻率)
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

// 2. 核心排位數據 API
app.get('/api/odds', async (req, res) => {
    const dateStr = req.query.date || '2026-10-25';
    const venueCode = req.query.venue || 'ST';

    console.log(`[API /api/odds] Fetching meeting for Date: ${dateStr}, Venue: ${venueCode}`);

    const graphqlQuery = `query racing($date:String$venueCode:String){raceMeetings(date:$date venueCode:$venueCode){status currentNumberOfRace totalInvestment races{no status runners{id no standbyNo status name_ch name_en horse{id code}color barrierDrawNumber handicapWeight currentWeight currentRating internationalRating gearInfo racingColorFileName allowance trainerPreference last6run saddleClothNo trumpCard priority finalPosition deadHeat winOdds jockey{code name_en name_ch}trainer{code name_en name_ch}}}}}`;
    const graphqlVariables = JSON.stringify({ date: dateStr, venueCode: venueCode });
    const graphqlUrl = `https://info.cld.hkjc.com/graphql/base-get/?query=${encodeURIComponent(graphqlQuery)}&operationName=racing&variables=${encodeURIComponent(graphqlVariables)}`;

    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const response = await axios.get(graphqlUrl, { headers: hkjcHeaders, timeout: 10000 });
            const rawData = response.data;
            const raceMeetings = rawData?.data?.raceMeetings || rawData?.raceMeetings || [];

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

            return res.json({
                status: "success",
                message: `成功取得馬會官方排位數據 (${dateStr})`,
                meetingDate: dateStr,
                venue: venueCode,
                totalRaces: formattedRaces.length,
                races: formattedRaces
            });

        } catch (err) {
            console.warn(`[Odds Attempt ${attempt} Failed]: ${err.message}`);
            if (attempt === 2) {
                return res.status(502).json({
                    status: "error",
                    message: "無法取得馬會伺服器數據 (Bad Gateway)。",
                    errorDetails: err.message
                });
            }
        }
    }
});

// 3. 專用實時賠率 API (非香港本地賽事自動延長快取，防止 502)
app.get('/api/pool-odds', async (req, res) => {
    const dateStr = req.query.date;
    const venueCode = req.query.venue;
    const raceNo = parseInt(req.query.raceNo, 10) || 1;

    if (!dateStr || !venueCode) {
        return res.status(400).json({ status: 'error', message: 'Missing date or venue.' });
    }

    const cacheKey = `${dateStr}_${venueCode}_${raceNo}`;
    const now = Date.now();

    // 判斷是否為香港本地賽事 (沙田 ST 或 跑馬地 HV)
    const isLocalMeeting = (venueCode === 'ST' || venueCode === 'HV');
    // 非本地賽事（如 S1, S2 等海外賽事）馬匹多、流量大，快取設為 15 秒保護伺服器
    const currentTTL = isLocalMeeting ? 8000 : 15000;

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
            const response = await axios.get(graphqlUrl, {
                headers: hkjcHeaders,
                timeout: 12000
            });

            if (response.data && !response.data.errors) {
                oddsCache[cacheKey] = {
                    timestamp: now,
                    data: response.data
                };
                return res.json(response.data);
            }
        } catch (err) {
            console.warn(`[Pool-Odds Attempt ${attempt} Failed for ${venueCode} R${raceNo}]: ${err.message}`);
            
            // 萬一連線失敗，優先回傳舊快取數據，防止拋出 502 影響前端
            if (oddsCache[cacheKey]) {
                console.log(`[FALLBACK] Serving stale cache for ${cacheKey} due to network timeout.`);
                return res.json(oddsCache[cacheKey].data);
            }

            if (attempt === 2) {
                return res.status(502).json({
                    status: 'error',
                    message: '連線馬會伺服器逾時或失敗 (Bad Gateway)',
                    errorDetails: err.message
                });
            }
        }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`HKJC Proxy Server running on port ${PORT}`);
});
