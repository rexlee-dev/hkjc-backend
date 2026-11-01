const express = require('express');
const cors = require('cors');
const axios = require('axios');
const http = require('http');
const https = require('https');

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
    'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en-US;q=0.7',
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

// 1. 動態賽事選單 API (取代原本需手動讀取的 meetings.json)
app.get('/api/meetings', async (req, res) => {
    const targetDate = req.query.date || new Date().toISOString().split('T')[0];

    // 使用官方完整查詢以獲取 activeMeetings
    const graphqlQuery = `fragment raceFragment on Race{id no status raceName_en raceName_ch postTime country_en country_ch distance wageringFieldSize go_en go_ch ratingType raceTrack{description_en description_ch}raceCourse{description_en description_ch displayCode}claCode raceClass_en raceClass_ch judgeSigns{value_en}} query raceMeetings($date:String,$venueCode:String){activeMeetings:raceMeetings{id venueCode date status races{no postTime status wageringFieldSize}} raceMeetings(date:$date,venueCode:\"HV\"){id status venueCode date totalNumberOfRace currentNumberOfRace dateOfWeek meetingType country{code namech nameen seq}races{...raceFragment runners{id no standbyNo status name_ch name_en horse{id code}color barrierDrawNumber handicapWeight currentWeight currentRating internationalRating gearInfo racingColorFileName allowance trainerPreference last6run saddleClothNo trumpCard priority finalPosition deadHeat winOdds jockey{code name_en name_ch}trainer{code name_en name_ch}}}}}`;
    
    const graphqlVariables = JSON.stringify({ date: targetDate.replace(/-/g, '') });
    const graphqlUrl = `https://info.cld.hkjc.com/graphql/base-get/?query=${encodeURIComponent(graphqlQuery)}&operationName=raceMeetings&variables=${encodeURIComponent(graphqlVariables)}`;

    try {
        const response = await axiosInstance.get(graphqlUrl, { headers: hkjcHeaders });
        const rawData = response.data;
        const activeMeetings = rawData?.data?.activeMeetings || [];

        // 動態整理出所有狀態為 DEFINED 或有效的場地賽事清單
        const meetingsList = activeMeetings.map(m => ({
            date: m.date,
            venue: m.venueCode,
            status: m.status,
            name: `${m.date} ${m.venueCode} 賽事 (${m.status})`
        }));

        return res.json({
            status: 'success',
            targetDate: targetDate,
            meetings: meetingsList.length > 0 ? meetingsList : [
                { date: targetDate, venue: "HV", status: "DEFINED", name: `${targetDate} HV 賽事` }
            ]
        });
    } catch (err) {
        console.error('Error fetching dynamic meetings:', err.message);
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

// 2. 升級版核心排位與賽事詳情 API (一併返回賽事與跑道細節，不含彩池投資)
app.get('/api/odds', async (req, res) => {
    const dateStr = req.query.date || '2026-11-01';
    const venueCode = req.query.venue || 'HV';

    // 包含完整賽事元數據、跑道細節與出馬表的查詢字串
    const graphqlQuery = `fragment raceFragment on Race{id no status raceName_en raceName_ch postTime country_en country_ch distance wageringFieldSize go_en go_ch ratingType raceTrack{description_en description_ch}raceCourse{description_en description_ch displayCode}claCode raceClass_en raceClass_ch judgeSigns{value_en}} query raceMeetings($date:String,$venueCode:String){raceMeetings(date:$date,venueCode:$venueCode){id status venueCode date totalNumberOfRace currentNumberOfRace dateOfWeek meetingType country{code namech nameen seq}races{...raceFragment runners{id no standbyNo status name_ch name_en horse{id code}color barrierDrawNumber handicapWeight currentWeight currentRating internationalRating gearInfo racingColorFileName allowance trainerPreference last6run saddleClothNo trumpCard priority finalPosition deadHeat winOdds jockey{code name_en name_ch}trainer{code name_en name_ch}}}}}`;
    
    const graphqlVariables = JSON.stringify({ date: dateStr, venueCode: venueCode });
    const graphqlUrl = `https://info.cld.hkjc.com/graphql/base-get/?query=${encodeURIComponent(graphqlQuery)}&operationName=raceMeetings&variables=${encodeURIComponent(graphqlVariables)}`;

    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const response = await axiosInstance.get(graphqlUrl, { headers: hkjcHeaders });
            const rawData = response.data;
            const raceMeetings = rawData?.data?.raceMeetings || rawData?.raceMeetings || [];

            if (!raceMeetings || raceMeetings.length === 0) {
                return res.status(404).json({
                    status: "no_data",
                    message: `馬會於 ${dateStr} (${venueCode}) 未有賽事資料或排位表。[cite: 2]`,
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
                message: `成功取得馬會官方賽事詳情與排位數據 (${dateStr})[cite: 2]`,
                meetingId: meeting.id,
                meetingDate: dateStr,
                venue: venueCode,
                meetingStatus: meeting.status,
                totalNumberOfRace: meeting.totalNumberOfRace,
                totalRaces: formattedRaces.length,
                races: formattedRaces
            });

        } catch (err) {
            console.warn(`[Odds Attempt ${attempt} Failed]: ${err.message}`);
            if (attempt === 2) {
                return res.status(502).json({
                    status: "error",
                    message: "無法取得馬會伺服器數據。",
                    errorDetails: err.message
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

    const graphqlQuery = `query sp4e_racing_pmPool($date:String$venueCode:String$oddsTypes:[OddsType]$raceNo:Int){raceMeetings(date:$date venueCode:$venueCode){pmPools(oddsTypes:$oddsTypes raceNo:$raceNo){id status sellStatus oddsType lastUpdateTime oddsLastUpdateTime guarantee minTicketCost name_en name_ch leg{number races}cWinSelections{composite name_en name_ch starters}oddsNodes{combString oddsValue hotFavourite oddsDropValue bankerOdds{combString oddsValue}}}}}`;

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

        const graphqlQuery = `query sp4e_racing_pmPool($date:String$venueCode:String$oddsTypes:[OddsType]$raceNo:Int){raceMeetings(date:$date venueCode:$venueCode){pmPools(oddsTypes:$oddsTypes raceNo:$raceNo){id status sellStatus oddsType lastUpdateTime oddsLastUpdateTime guarantee minTicketCost name_en name_ch leg{number races}cWinSelections{composite name_en name_ch starters}oddsNodes{combString oddsValue hotFavourite oddsDropValue bankerOdds{combString oddsValue}}}}}`;

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
