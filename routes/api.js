const express = require('express');
const axios = require('axios');
const router = express.Router();
const store = require('../data/store');
const nlp = require('../utils/nlp');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Mocked response logic when no API key is provided
function mockVerification(headline, category) {
    const isFake = headline.toLowerCase().includes('shocking') || headline.toLowerCase().includes('miracle');
    return {
        id: Date.now().toString(),
        headline,
        content: "Content snippet...",
        category: category || 'General',
        score: isFake ? 25 : 85,
        verdict: isFake ? 'Fake' : 'Genuine',
        color: isFake ? 'red' : 'green',
        credibleMatches: isFake ? 1 : 4,
        suspiciousMatches: isFake ? 5 : 0,
        sources: [
            { name: "BBC News", url: "bbc.com", reliability: 95 },
            { name: "The Guardian", url: "theguardian.com", reliability: 92 }
        ],
        timestamp: new Date().toISOString()
    };
}

// POST /api/verify
router.post('/verify', async (req, res) => {
    try {
        const { headline, content, category } = req.body;

        if (!headline || !content) {
            return res.status(400).json({ error: 'Headline and content are required' });
        }

        // Phase 4 Optimization: Cache Layer to prevent hitting NewsAPI & Microservice twice unnecessarily
        let record = store.findRecentHistory(headline);
        if (record) {
            console.log("Serving from Cache:", headline);
            return res.json(record);
        }

        const activeApis = process.env.WORLDNEWS_API_KEY || process.env.NEWSDATA_API_KEY || process.env.NEWS_API_KEY;

        if (!activeApis || activeApis === 'mocked_mode_enabled') {
            record = mockVerification(headline, category);
        } else {
            // Advanced Semantic ML Pipeline

            // 1. Broad Multi-API Extraction
            // News aggregators fail on exact-sentence searches, so we extract strict keyword topics
            const tokens = nlp.tokenize(headline);
            const queryKeywords = tokens.slice(0, 4).join(' ');
            const q = encodeURIComponent(queryKeywords || headline.substring(0, 30));

            const fetchPromises = [];

            if (process.env.WORLDNEWS_API_KEY) {
                fetchPromises.push(axios.get(`https://api.worldnewsapi.com/search-news?text=${q}&language=en&number=10&api-key=${process.env.WORLDNEWS_API_KEY}`)
                    .then(res => (res.data.news || []).map(n => ({
                        title: n.title, description: n.text, content: n.text, url: n.url, publishedAt: n.publish_date, source: { name: n.author || "WorldNews" }
                    }))));
            }

            if (process.env.NEWSDATA_API_KEY) {
                // NewsData.io restricts query length, so we ensure the parameter is concise.
                fetchPromises.push(axios.get(`https://newsdata.io/api/1/news?apikey=${process.env.NEWSDATA_API_KEY}&q=${q}&language=en`)
                    .then(res => (res.data.results || []).map(r => ({
                        title: r.title, description: r.description, content: r.content, url: r.link, publishedAt: r.pubDate, source: { name: r.source_id || "NewsData" }
                    }))));
            }

            // Wikipedia API for Static Encyclopaedia Knowledge Mapping
            fetchPromises.push(axios.get(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${q}&utf8=&format=json`, {
                headers: { 'User-Agent': 'TruthLensBot/1.0 (contact@truthlens.test)' }
            }).then(res => {
                const searchResults = res.data.query?.search || [];
                return searchResults.slice(0, 3).map(r => {
                    const cleanSnippet = r.snippet.replace(/<\/?[^>]+(>|$)/g, "");
                    return {
                        title: r.title,
                        description: cleanSnippet,
                        content: cleanSnippet,
                        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title)}`,
                        publishedAt: new Date().toISOString(),
                        source: { name: "Wikipedia" }
                    };
                });
            }).catch(() => [])
            );

            let articles = [];
            if (fetchPromises.length > 0) {
                try {
                    const results = await Promise.allSettled(fetchPromises);
                    results.forEach(res => {
                        if (res.status === 'fulfilled') articles = articles.concat(res.value);
                    });
                } catch (e) { console.error("MultiAPI Fetch Error", e.message); }
            }

            // Fallback to NewsAPI if others failed or were empty.
            if (articles.length === 0 && process.env.NEWS_API_KEY) {
                try {
                    const newsRes = await axios.get(`https://newsapi.org/v2/everything?q=${q}&sortBy=relevancy&pageSize=10&apiKey=${process.env.NEWS_API_KEY}&language=en`);
                    articles = newsRes.data.articles || [];
                } catch (e) { }
            }

            // 2. Data Cleaning
            const userContext = headline + " " + (content || "");

            const TRUST_MAP = {
                'bbc.co.uk': 0.95,
                'bbc.com': 0.95,
                'reuters.com': 0.98,
                'cnn.com': 0.82,
                'theguardian.com': 0.92,
                'nytimes.com': 0.94,
                'ndtv.com': 0.85,
                'apnews.com': 0.98,
                'timesofindia.indiatimes.com': 0.85,
                'thehindu.com': 0.90,
                'indianexpress.com': 0.89,
                'wsj.com': 0.92,
                'washingtonpost.com': 0.93,
                'bloomberg.com': 0.92,
                'npr.org': 0.95,
                'aljazeera.com': 0.88,
                'abcnews.go.com': 0.90,
                'cbsnews.com': 0.90,
                'nbcnews.com': 0.90,
                'foxnews.com': 0.80,
                'forbes.com': 0.80,
                'wikipedia.org': 0.90,
                'en.wikipedia.org': 0.90
            };

            // Filter out empty articles and prepare contexts
            const cleanedArticles = [];
            const articleContexts = [];

            for (const a of articles) {
                const text = `${a.title || ""} ${a.description || ""} ${a.content || ""}`.trim();
                let domain = "News Source";
                try { domain = new URL(a.url).hostname.replace(/^www\./, ''); } catch (e) { }

                // Only cleanly include sources that have verifiable textual length and belong to the TRUST_MAP whitelist
                if (text.length > 50 && TRUST_MAP[domain]) {
                    cleanedArticles.push(a);
                    articleContexts.push(text);
                }
            }

            let finalScore = 0;
            let validSources = [];
            let credibleMatches = 0;
            let suspiciousMatches = 0;

            const N = articleContexts.length;

            if (N > 0) {
                // 3. Call Python ML Microservice
                let similarities = [];
                try {
                    const mlRes = await axios.post('http://127.0.0.1:8000/analyze', {
                        main_text: userContext,
                        articles: articleContexts
                    });
                    similarities = mlRes.data.similarities || [];
                } catch (err) {
                    console.error("ML Service Error:", err.message);
                    // Fallback if ML service is down
                    similarities = new Array(N).fill(0.1);
                }

                // 4. Credibility Scoring Engine
                // (TRUST_MAP has been moved to the Data Cleaning phase)

                let totalWeight = 0;
                let totalScore = 0;

                similarities.forEach((sim, i) => {
                    const article = cleanedArticles[i];

                    let domain = "News Source";
                    try { domain = new URL(article.url).hostname.replace(/^www\./, ''); } catch (e) { }

                    // Assign tiny weights to random unknown sites so they can't force a high verification score
                    const sourceWeight = TRUST_MAP[domain] || 0.15;

                    const publishedAt = new Date(article.publishedAt);
                    let daysOld = 0;
                    if (!isNaN(publishedAt)) {
                        daysOld = Math.max(0, (new Date() - publishedAt) / (1000 * 60 * 60 * 24));
                    }
                    // Relaxed decay so general knowledge (older underlying sources) isn't penalized
                    const recencyWeight = 1 / (1 + daysOld * 0.005);

                    // Normalize similarity (0.15 semantic match floor)
                    const normalizedSim = Math.min(1.0, Math.max(0, (sim - 0.15) / 0.25));

                    // Effective weight of this specific article based on source trust & recency
                    const effectiveWeight = sourceWeight * recencyWeight;

                    // Score contribution
                    const score_i = normalizedSim * effectiveWeight;

                    if (sim >= 0.15) {
                        credibleMatches++;
                        totalScore += score_i;
                        totalWeight += effectiveWeight;

                        validSources.push({
                            name: article.source.name || domain,
                            url: domain,
                            reliability: Math.floor(sourceWeight * 100),
                            simScore: sim,
                            contribution: score_i,
                            contextSnippet: `${article.title || ""}. ${article.description || ""}`.trim()
                        });
                    } else {
                        suspiciousMatches++;
                    }
                });

                // Confidence Cap: A claim must be corroborated by multiple reputable sources to hit 100%.
                // E.g. A totalWeight of 1.0 (about 1-2 top tier articles or many random ones) un-caps the score.
                if (totalWeight > 0) {
                    const rawScore = (totalScore / totalWeight) * 100;
                    const confidenceCap = Math.min(1.0, totalWeight / 1.0);
                    finalScore = rawScore * confidenceCap;
                    finalScore = Math.min(100, finalScore);
                } else {
                    finalScore = 15; // Unverified / None matched broadly
                }

                // Sort sources by contribution logic
                validSources.sort((a, b) => b.contribution - a.contribution);
            }

            let verdict = 'Uncertain';
            let color = 'orange';

            if (N === 0) {
                // No articles found anywhere
                finalScore = 15;
                verdict = 'Fake';
                color = 'red';
            } else if (finalScore >= 75) {
                verdict = 'Verified Fact';
                color = 'green';
            } else if (finalScore >= 50) {
                verdict = 'Uncertain';
                color = 'orange';
            } else {
                verdict = 'Fake';
                color = 'red';
            }

            // 5. Phase 5 Upgrade: Gemini Logical Fact-Checking
            if (process.env.GOOGLE_API_KEY && N > 0 && validSources.length > 0) {
                try {
                    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
                    // Use standard gemini model to maintain fast latency
                    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", generationConfig: { responseMimeType: "application/json" } });

                    const extractedContext = validSources.slice(0, 5).map(s => s.contextSnippet).join("\n\n");

                    const geminiPrompt = `You are a strict, objective fact-checking AI.
User's Claim: "${userContext}"

Context from highly reputable verified sources (BBC, Reuters, Wikipedia, etc.):
${extractedContext}

Based STRICTLY and ONLY on the evidence provided above, evaluate the user's claim. Does the evidence support it or contradict it? 
Respond ONLY with a valid JSON object in this exact format:
{
    "verdict": "Verified Fact" | "Fake" | "Uncertain",
    "rawScore": 0-100 (a number where 100 is completely verified, 0 is definitively fake or contradictory, and 50 is unverified/uncertain)
}`;

                    console.log("Extracted Context for Gemini:", extractedContext);

                    const aiResult = await model.generateContent(geminiPrompt);
                    const aiResText = aiResult.response.text();

                    try {
                        const parsedAI = JSON.parse(aiResText);
                        finalScore = parsedAI.rawScore;
                        verdict = parsedAI.verdict;

                        if (verdict === 'Verified Fact') color = 'green';
                        else if (verdict === 'Uncertain') color = 'orange';
                        else color = 'red';

                        console.log("Gemini Fact Check:", parsedAI);
                    } catch (jsonErr) {
                        console.error("Gemini JSON Parse Error:", jsonErr.message);
                    }
                } catch (geminiErr) {
                    console.error("Gemini Model Error:", geminiErr.message);
                }
            }

            record = {
                id: Date.now().toString(),
                headline,
                category: category || 'General',
                score: Math.min(100, Math.round(finalScore)),
                verdict: verdict,
                color: color,
                credibleMatches: credibleMatches,
                suspiciousMatches: suspiciousMatches,
                sources: validSources.slice(0, 5), // Keep top 5 sources for the frontend graph
                timestamp: new Date().toISOString()
            };
        }

        store.addHistoryRecord(record);
        res.json(record);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to verify news' });
    }
});

// GET /api/history
router.get('/history', (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const filter = req.query.filter || 'all';

        let history = store.readHistory();

        if (filter !== 'all') {
            history = history.filter(item => {
                if (filter.toLowerCase() === 'genuine') return item.verdict.toLowerCase() === 'genuine' || item.verdict.toLowerCase() === 'verified fact';
                return item.verdict.toLowerCase() === filter.toLowerCase();
            });
        }

        const totalItems = history.length;
        const totalPages = Math.ceil(totalItems / limit);

        const offset = (page - 1) * limit;
        const paginatedData = history.slice(offset, offset + limit);

        res.json({
            data: paginatedData,
            page,
            limit,
            totalItems,
            totalPages
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch history' });
    }
});

// DELETE /api/history/:id
router.delete('/history/:id', (req, res) => {
    try {
        store.deleteHistoryRecord(req.params.id);
        res.json({ success: true, message: 'Record deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete record' });
    }
});

// DELETE /api/history
router.delete('/history', (req, res) => {
    try {
        store.clearAllHistory();
        res.json({ success: true, message: 'All records deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to clear history' });
    }
});

// GET /api/analytics
router.get('/analytics', (req, res) => {
    try {
        const history = store.readHistory();

        const total = history.length;
        const genuine = history.filter(r => r.verdict.toLowerCase() === 'genuine').length;
        const fake = history.filter(r => r.verdict.toLowerCase() === 'fake').length;
        const uncertain = history.filter(r => r.verdict.toLowerCase() === 'uncertain').length;

        let totalScore = 0;
        history.forEach(r => totalScore += r.score);
        const avgScore = total > 0 ? Math.round(totalScore / total) : 0;

        // Generate last 7 days mockup data for the chart
        const last7 = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            last7.push({
                date: d.toISOString().split('T')[0],
                genuine: Math.floor(Math.random() * 5),
                fake: Math.floor(Math.random() * 3)
            });
        }

        const categoryCounts = {};
        history.forEach(r => {
            categoryCounts[r.category] = (categoryCounts[r.category] || 0) + 1;
        });

        const categoryStats = Object.keys(categoryCounts).map(k => ({
            category: k,
            total: categoryCounts[k]
        }));

        res.json({
            total,
            genuine,
            fake,
            uncertain,
            avgScore,
            last7,
            categoryStats
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});

module.exports = router;
