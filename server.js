import { Hono } from 'hono';
import { cors } from 'hono/cors';
import axios from 'axios';
// 引入根目錄的 meetings.json (Cloudflare Worker 支援 JSON module 導入)
import meetingsConfig from './meetings.json';

const app = new Hono();

// 啟用 CORS
app.use('*', cors());

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
    return c.json({
        status: 'online',
        serverTime: new Date().toISOString(),
        message: 'HKJC Official GraphQL Multi-Meeting Odds Server (Cloudflare Worker) is running.'
    });
});

// 1. 賽事選單 API (動態讀取 meetings.json)
app.get('/api/meetings', (c) => {
    try {
        const meetings = meetingsConfig.meetings || [];
        return c.json({
            status: 'success',
            meetings: meetings
        });
    } catch (err) {
        console.error('Error reading meetings data:', err.message);
        return c.json({
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

    const graphqlQuery = `query racing($date:String$venueCode:String){raceMeetings(date:$date venueCode:$venueCode){status currentNumberOfRace totalInvestment races{no status runners{id no standbyNo status name_ch name_en horse{id code}color barrierDrawNumber handicapWeight currentWeight currentRating internationalRating gearInfo racingColorFileName allowance trainerPreference last6run saddleClothNo trumpCard priority finalPosition deadHeat winOdds jockey{code name_en name_ch}trainer{code name_en name_ch}}}}}`;
    const graphqlVariables = JSON.stringify({ date: dateStr, venueCode: venueCode });
    const graphqlUrl = `https://info.cld.hkjc.com/graphql/base-get/?query=${encodeURIComponent(graphqlQuery)}&operationName=racing&variables=${encodeURIComponent(graphqlVariables)}`;

    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const response = await axios.get(graphqlUrl, { headers: hkjcHeaders, timeout: 8000 });
            const rawData = response.data;
            const raceMeetings = rawData?.data?.raceMeetings || rawData?.raceMeetings || [];

            if (!raceMeetings || raceMeetings.length === 0) {
                return c.json({
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

            return c.json({
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
                return c.json({
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
        return c.json({ status: 'error', message: 'Missing date or venue.' }, 400);
    }

    const cacheKey = `${dateStr}_${venueCode}_${raceNo}`;
    const now = Date.now();

    const isLocalMeeting = (venueCode === 'ST' || venueCode === 'HV');
    const currentTTL = isLocalMeeting ? 6000 : 12000;

    if (oddsCache[cacheKey] && (now - oddsCache[cacheKey].timestamp < currentTTL)) {
        return c.json(oddsCache[cacheKey].data);
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
                return c.json(response.data);
            }
        } catch (err) {
            console.warn(`[Pool-Odds Attempt ${attempt} Failed for ${venueCode} R${raceNo}]: ${err.message}`);

            if (oddsCache[cacheKey]) {
                return c.json(oddsCache[cacheKey].data);
            }

            if (attempt === 1) {
                await new Promise(r => setTimeout(r, 600));
            } else {
                return c.json({
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
        return c.json({ status: 'error', message: 'Missing date or venue.' }, 400);
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

    return c.json({
        status: 'success',
        date: dateStr,
        venue: venueCode,
        racesOdds: results
    });
});

// 5. 取得當期活躍賽事總覽 API (只返回 activeMeetings 資料)
app.get('/api/active-meetings', async (c) => {
    const dateStr = c.req.query('date') || '2026-11-04';
    const venueCode = c.req.query('venue') || 'HV';

    // 馬會官方完整的 raceMeetings Query (包含 raceFragment 及 racingBlockFragment)
    const graphqlQuery = `fragment raceFragment on Race{id no status raceName_en raceName_ch postTime country_en country_ch distance wageringFieldSize go_en go_ch ratingType raceTrack{description_en description_ch}raceCourse{description_en description_ch displayCode}claCode raceClass_en raceClass_ch ownerName_en ownerName_ch judgeSigns{value_en}} fragment racingBlockFragment on RaceMeeting{jpEsts:pmPools(oddsTypes:[WIN PLA TCE TRI FE QTT DT TT SixUP]filters:["jackpot" "estimatedDividend"]){leg{number races}oddsType jackpot estimatedDividend mergedPoolId}poolInvs:pmPools(oddsTypes:[WIN PLA QIN QPL CWA CWB CWC IWN FCT TCE TRI FE QTT DBL TBL DT TT SixUPy]){id leg{races}}penetrometerReadings(filters:["first"]){reading readingTime}hammerReadings(filters:["first"]){reading readingTime}changeHistories(filters:["top3"]){type time raceNo runnerNo horseName_ch horseName_en jockeyName_ch jockeyName_en scratchHorseName_ch scratchHorseName_en handicapWeight scrResvIndicator}}query raceMeetings($date:String$venueCode:String){timeOffset{rc}activeMeetings:raceMeetings{id venueCode date status races{no postTime status wageringFieldSize}poolInvs:pmPools(oddsTypes:[WIN PLA QIN QPL CWA CWB CWC IWN FCT TCE TRI FE QTT DBL TBL DT TT SixUP]){status}}raceMeetings(date:$date venueCode:$venueCode){status venueCode date totalNumberOfRace currentNumberOfRace dateOfWeek meetingType totalInvestment country{code namech nameen seq}races{...raceFragment runners{id no standbyNo status name_ch name_en horse{id code}color barrierDrawNumber handicapWeight currentWeight currentRating internationalRating gearInfo racingColorFileName allowance trainerPreference last6run saddleClothNo trumpCard priority finalPosition deadHeat winOdds jockey{code name_en name_ch}trainer{code name_en name_ch}}}obSt:pmPools(oddsTypes:[WIN PLA]){leg{races}oddsType comingleStatus}poolInvs:pmPools(oddsTypes:[WIN PLA QIN QPL CWA CWB CWC IWN FCT TCE TRI FE QTT DBL TBL DT TT SixUPy]){id leg{number races}status sellStatus oddsType investment mergedPoolId lastUpdateTime}...racingBlockFragment pmPools(oddsTypes:[]){bid}jkcInstNo:foPools(oddsTypes:[JKC]filters:["top"]){instNo}tncInstNo:foPools(oddsTypes:[TNC]filters:["top"]){instNo}}}`;

    const variablesObj = {
        date: dateStr,
        venueCode: venueCode
    };

    const graphqlUrl = `https://info.cld.hkjc.com/graphql/base-get/?query=${encodeURIComponent(graphqlQuery)}&operationName=raceMeetings&variables=${encodeURIComponent(JSON.stringify(variablesObj))}`;

    try {
        const response = await axios.get(graphqlUrl, { headers: hkjcHeaders, timeout: 8000 });
        const rawData = response.data;

        // 提取並精準返回 activeMeetings
        const activeMeetings = rawData?.data?.activeMeetings || rawData?.activeMeetings || [];

        return c.json({
            status: 'success',
            date: dateStr,
            venue: venueCode,
            activeMeetings: activeMeetings
        });

    } catch (err) {
        console.warn(`[Active-Meetings Fetch Failed]: ${err.message}`);
        return c.json({
            status: 'error',
            message: '無法取得馬會 ActiveMeetings 數據。',
            errorDetails: err.message
        }, 502);
    }
});

export default app;
